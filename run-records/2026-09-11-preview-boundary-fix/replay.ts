import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TraceStore } from "../../src/trace/store.js";
import { createCompilerProposalToolset } from "../../src/compiler/proposal-tools.js";
import { withNwhToolRecovery } from "../../src/agent/tool-recovery.js";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createEvidenceFixture } from "../../test/helpers/evidence.js";
import { compilerBatchOutcomeFromMessages, isRecoverableCompilerBatchInterruption } from "../../src/compiler/batch-outcome.js";
const traces = new TraceStore(process.cwd());
const events = await traces.peekEvents("run-mtwnuvd7-3fe73c27-3d42-4134-b994-40ba392cf0cd");
const calls = events.filter(e => e.type === "tool.call.started" && e.data.toolName === "preview_initial_world");
const inputs = await Promise.all(calls.map(call => traces.peekBlob(call.blobRef!)));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-real-preview-replay-"));
const originalHome = process.env.NWH_HOME;
process.env.NWH_HOME = path.join(root, "state-home");
try {
  const fixture = await createEvidenceFixture(root, "Fixture for argument validation; no original novel state is changed.\n");
  const set = createCompilerProposalToolset(root);
  await set.beginBatch([fixture.segmentId], `opening-batch-${fixture.source.id}`, fixture.source.id);
  const tool = withNwhToolRecovery(set.tools.find(t => t.name === "preview_initial_world")!);
  const result = [];
  for (const [index, call] of calls.entries()) {
    const input = inputs[index];
    try {
      const prepared = tool.prepareArguments!(input);
      const args = validateToolArguments(tool, { type: "toolCall", id: "replay", name: tool.name, arguments: prepared as never });
      await tool.execute("replay", args as never, undefined, undefined, {} as never);
      throw new Error("Expected the unchanged historical input to fail before evidence retrieval");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = compilerBatchOutcomeFromMessages([{ role: "toolResult", toolCallId: "replay", toolName: tool.name, isError: true, content: [{ type: "text", text: message }] }, { role: "assistant", stopReason: "stop", content: [] }]);
      result.push({ originalInputHash: call.blobRef!.sha256, message, hostReviewReason: outcome.hostReviewReason ?? null, automaticRecoveryAllowed: isRecoverableCompilerBatchInterruption(outcome) });
    }
  }
  if (result.length !== 2 || !result[0]!.message.includes("later-discourse-preexisting") || !result[1]!.hostReviewReason) throw new Error("Replay failed its regression assertions");
  await fs.writeFile(new URL("replay-result.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result.map(r => ({ inputHash: r.originalInputHash, explicitEnums: r.message.includes("later-discourse-preexisting"), hostReview: Boolean(r.hostReviewReason), diagnostic: r.message.split("<nwh-tool-recovery>")[0] })), null, 2));
} finally { if (originalHome === undefined) delete process.env.NWH_HOME; else process.env.NWH_HOME = originalHome; await fs.rm(root, { recursive: true, force: true }); }

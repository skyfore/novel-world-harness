import fs from "node:fs/promises";
import { prepareAllCommand } from "../../src/commands/prepare-all.js";
import { InitialWorldStore } from "../../src/world/initial.js";
import { inspectCompilerStatus } from "../../src/compiler/status.js";
import { withWorkspaceOperationLock } from "../../src/util/workspace-lock.js";
const root = process.cwd(), sourceId = "a28585b1cf867f3e3a16";
await withWorkspaceOperationLock(root, "compiler", async () => {
  const initial = await new InitialWorldStore(root).get();
  if (!initial?.evidence.some(ref => ref.span.sourceId === sourceId)) throw new Error("Expected the accepted opening world for this source; inspect state before continuing.");
  const before = await inspectCompilerStatus(root, sourceId);
  if (!before.sources[0]?.batchReviewComplete) throw new Error("Expected completed source batches; inspect checkpoints before continuing.");
  await fs.writeFile(new URL("status-before.json", import.meta.url), JSON.stringify(before, null, 2) + "\n");
  console.log("Continuing preparation from the accepted opening world with the default compiler for graph adjudication, semantic reconciliation and role review.");
  try {
    const result = await prepareAllCommand({ root, sourceId, model: "openai-codex/gpt-5.6-terra", yes: true,
      candidateOnly: true, createBranch: false, restoreCache: false, acquireLock: false });
    console.log(JSON.stringify({ sourceId, stage: result.stage }, null, 2));
    await fs.writeFile(new URL("result.json", import.meta.url), JSON.stringify({ status: "completed", stage: result.stage, endedAt: new Date().toISOString() }, null, 2));
  } catch (error) {
    await fs.writeFile(new URL("result.json", import.meta.url), JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error), endedAt: new Date().toISOString() }, null, 2));
    throw error;
  } finally {
    await fs.writeFile(new URL("status-after.json", import.meta.url), JSON.stringify(await inspectCompilerStatus(root, sourceId), null, 2) + "\n");
  }
});

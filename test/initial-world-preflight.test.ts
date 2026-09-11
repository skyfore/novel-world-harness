import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initialWorldInputIssues } from "../src/compiler/initial-world-preflight.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { CompilerProposalObligations } from "../src/compiler/proposal-obligations.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
function payload() {
  return { version: 1, delta: { version: 1, operations: [] }, readerContext: {
    version: 1, focalActorId: "hero",
    facts: ["focal-identity", "time-place", "causal-premise", "actor-stance", "immediate-pressure"].map((kind, i) => ({
      id: `fact-${i}`, kind, summary: "Hero waits.", temporalClass: "at-checkpoint", basis: "source-narrator-established", entityIds: ["hero"],
      ...(kind === "actor-stance" ? { holderEntityId: "hero", stance: "negative" } : {}),
    })), entityGlosses: [], immediateSituation: { summary: "Hero waits.", causalFactIds: ["fact-2"], pressureFactIds: ["fact-4"], unresolvedFactIds: ["fact-4"], outcomePolicy: "withhold-post-checkpoint-outcomes" },
  } };
}
it("accepts omitted default arrays and aggregates the incident's independent shape failures", () => {
  const good = payload();
  expect(initialWorldInputIssues({ payload: good })).toEqual([]);
  const bad = payload();
  delete bad.readerContext.facts[3]!.holderEntityId;
  delete bad.readerContext.facts[3]!.stance;
  bad.readerContext.facts[2]!.kind = "completed-prior-beat";
  const issues = initialWorldInputIssues({ payload: bad, evidence_selectors: [{ relation: "explicit" }] }).join("\n");
  expect(issues).toContain("holderEntityId");
  expect(issues).toContain("stance");
  expect(issues).toContain("causal-premise");
  expect(issues).toContain("evidence_selectors");
});
it("exposes defaults and conditional requirements in the model input schema", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-opening-schema-")); roots.push(root);
  const toolset = createCompilerProposalToolset(root);
  const tool = toolset.tools.find(t => t.name === "propose_initial_world")!;
  const input = { proposal_id: "opening", payload: payload(), evidence_segment_ids: ["segment"] };
  expect(() => validateToolArguments(tool, { id: "call", name: tool.name, arguments: input })).not.toThrow();
  delete input.payload.readerContext.facts[3]!.stance;
  expect(() => validateToolArguments(tool, { id: "call", name: tool.name, arguments: input })).toThrow();
});
it("previews without staging or settling obligations and rejects unchanged retry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-opening-preview-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero waits.\n");
  const batchId = `opening-batch-${fixture.source.id}`;
  const toolset = createCompilerProposalToolset(root);
  await toolset.beginBatch([fixture.segmentId], batchId, fixture.source.id);
  const tool = toolset.tools.find(t => t.name === "preview_initial_world")!;
  const run = (input: unknown) => tool.execute("preview", input as never, undefined, undefined, {} as ExtensionContext);
  const bad = { proposal_id: "opening", payload: {}, evidence_segment_ids: [fixture.segmentId] };
  await expect(run(bad)).rejects.toThrow("preview validation failed");
  const good = { ...bad, payload: { version: 1, delta: { version: 1, operations: [] } } };
  await expect(run(good)).resolves.toMatchObject({ details: { readOnly: true, proposalStaged: false } });
  expect(new CompilerProposalObligations(root, fixture.source.id, batchId).unresolved()).toEqual([]);
  await expect(new CompilerProposalService(root).store.list("pending")).resolves.toEqual([]);
  await expect(run(good)).rejects.toThrow("requires host review");
});

it("publishes the submission contract on preview and stops recovery on its second failed check", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-opening-preview-stop-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero waits.\n");
  const set = createCompilerProposalToolset(root);
  await set.beginBatch([fixture.segmentId], `opening-batch-${fixture.source.id}`, fixture.source.id);
  const preview = set.tools.find(t => t.name === "preview_initial_world")!;
  const submit = set.tools.find(t => t.name === "propose_initial_world")!;
  expect(preview.parameters).toEqual(submit.parameters);
  const input = { proposal_id: "opening", payload: {}, evidence_segment_ids: [fixture.segmentId] };
  await expect(preview.execute("first", input as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("preview validation failed");
  const { withNwhToolRecovery } = await import("../src/agent/tool-recovery.js");
  await expect(withNwhToolRecovery(preview).execute("corrected", { ...input, payload: { version: 1 } } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow(/host-repair-required[\s\S]*"retryable": false/);
});

// Mirror the Pi boundary: wrapper preparation, authoritative validation (which
// clones arguments), then execute. Direct execute tests cannot cover this path.
async function invokePreview(tool: ReturnType<typeof createCompilerProposalToolset>["tools"][number], raw: unknown) {
  const { withNwhToolRecovery } = await import("../src/agent/tool-recovery.js");
  const wrapped = withNwhToolRecovery(tool);
  const prepared = wrapped.prepareArguments!(raw);
  const args = validateToolArguments(wrapped, { type: "toolCall", id: "call", name: wrapped.name, arguments: prepared as never });
  return wrapped.execute("call", args as never, undefined, undefined, {} as ExtensionContext);
}

it("replays invalid then deleted temporalClass through the Pi boundary and prohibits automatic recovery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-preview-boundary-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero waits.\n");
  const batchId = `opening-batch-${fixture.source.id}`;
  const set = createCompilerProposalToolset(root);
  await set.beginBatch([fixture.segmentId], batchId, fixture.source.id);
  const preview = set.tools.find(t => t.name === "preview_initial_world")!;
  const first = { proposal_id: "opening", payload: payload(), evidence_segment_ids: [fixture.segmentId] };
  first.payload.readerContext.facts.forEach(f => { f.temporalClass = "checkpoint-present"; });
  Object.assign(first.payload, { projectionSeed: { version: 1, unexpected: true } });
  const error1 = await invokePreview(preview, first).catch(e => e as Error);
  expect(error1.message).toContain("at-checkpoint");
  expect(error1.message).toContain("before-checkpoint");
  expect(error1.message).toContain("later-discourse-preexisting");
  expect(error1.message).toContain("unexpected");
  const second = structuredClone(first);
  second.payload.readerContext.facts.forEach(f => { delete (f as Partial<typeof f>).temporalClass; });
  const error2 = await invokePreview(preview, second).catch(e => e as Error);
  expect(error2.message).toContain("temporalClass");
  expect(error2.message).toContain('"retryable": false');
  const { compilerBatchOutcomeFromMessages, isRecoverableCompilerBatchInterruption, compilerBatchFailure } = await import("../src/compiler/batch-outcome.js");
  const report = compilerBatchOutcomeFromMessages([
    { role: "toolResult", toolCallId: "call", toolName: preview.name, isError: true, content: [{ type: "text", text: error2.message }] },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Blocked" }] },
  ]);
  expect(report.hostReviewReason).toBeTruthy();
  expect(isRecoverableCompilerBatchInterruption(report)).toBe(false);
  expect(compilerBatchFailure(report)).toContain("host review");
  await expect(invokePreview(preview, { ...first, payload: { version: 1, delta: { version: 1, operations: [] } } })).rejects.toThrow("requires host review");
  expect(new CompilerProposalObligations(root, fixture.source.id, batchId).unresolved()).toEqual([]);
  await expect(new CompilerProposalService(root).store.list("pending")).resolves.toEqual([]);
});

it("counts a prepared-and-executed corrected preview once, and combines errors across both phases", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-preview-count-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero waits.\n");
  const set = createCompilerProposalToolset(root);
  await set.beginBatch([fixture.segmentId], `opening-batch-${fixture.source.id}`, fixture.source.id);
  const preview = set.tools.find(t => t.name === "preview_initial_world")!;
  const base = { proposal_id: "opening", evidence_segment_ids: [fixture.segmentId] };
  await expect(invokePreview(preview, { ...base, payload: {} })).rejects.toThrow("payload.delta");
  await expect(invokePreview(preview, { ...base, payload: { version: 1, delta: { version: 1, operations: [] } } })).resolves.toMatchObject({ details: { proposalStaged: false } });
  await expect(invokePreview(preview, { ...base, payload: {} })).rejects.toThrow("requires host review");

  await set.beginBatch([fixture.segmentId], `opening-batch-${fixture.source.id}-mixed`, fixture.source.id);
  await expect(invokePreview(preview, { ...base, payload: {} })).rejects.toThrow("payload.delta");
  await expect(invokePreview(preview, { ...base, payload: payload() })).rejects.toThrow("requires host review"); // Field evidence is missing, after schema succeeds.
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { prepareCompilerBatches, runCompilerBatches, CompilerBatchStore } from "../src/compiler/batches.js";
import { CompilerFinishReceipts } from "../src/compiler/finish-receipts.js";
import { recoverCompilerFinish } from "../src/compiler/finish-recovery.js";
import { SourceAnnotationStore } from "../src/compiler/annotations.js";
import { SourceAccountingStore } from "../src/compiler/source-accounting.js";
import { createPiCompilerSession } from "../src/compiler/pi-compiler.js";
import { compileSourceCommand } from "../src/commands/compile-source.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";
import { withNwhToolRecovery } from "../src/agent/tool-recovery.js";
import { worldStorageRoot } from "../src/world/paths.js";
import { inspectCompilerStatus } from "../src/compiler/status.js";
import { prepareNextSourceLoopTurn } from "../src/compiler/source-loop.js";
import { withWorkspaceOperationLock } from "../src/util/workspace-lock.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture(stage = "executable") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-finish-recovery-")); roots.push(root);
  const { source } = await createEvidenceFixture(root, "Hero waits at the gate.\nRain falls on the empty road.\n");
  const batch = (await prepareCompilerBatches(root, source)).find((item) => item.semanticStage === stage)!;
  const toolset = createCompilerProposalToolset(root);
  await toolset.beginBatch(batch.segmentIds, batch.id, source.id);
  const call = (name: string, input: unknown) => withNwhToolRecovery(toolset.tools.find((tool) => tool.name === name)!).execute(name, input as never, undefined, undefined, {} as never);
  if (stage === "observation") await call("propose_entity_mention", { proposal_id: "mention-proposal", annotation_id: "mention", selector: { segment_id: batch.segmentIds[0], exact: "Hero" }, surface: "Hero", form: "proper", kind_candidates: ["character"], confidence: 1 });
  if (stage === "executable") {
    const page = await call("find_source_accounting_units", { status: "unresolved", offset: 0 });
    const token = JSON.parse((page.content[0] as { text: string }).text).pageToken;
    await call("account_source_units", { proposal_id: "accounting", page_token: token, page_default: { status: "background-only", reason: "Reviewed nonmaterial descriptive context" } });
  }
  const input = { outcome: "complete" as const, reviewed_segments: batch.segmentIds.map((segment_id) => ({ segment_id, disposition: "proposed" as const, summary: "Reviewed all source units" })), summary: "Completed source review" };
  const receipts = new CompilerFinishReceipts(root, source.id, batch.id);
  return { root, source, batch, toolset, call, input, receipts };
}

it.each(["annotation", "acceptance", "review", "completion"])("recovers a crash after %s without a model session or duplicate acceptance", async (point) => {
  const f = await fixture(point === "annotation" ? "observation" : "executable");
  if (point === "annotation") {
    const original = SourceAnnotationStore.prototype.commitProposals;
    vi.spyOn(SourceAnnotationStore.prototype, "commitProposals").mockImplementationOnce(async function (...args) { await original.apply(this, args); throw new Error("injected crash after annotation acceptance"); });
  } else if (point === "acceptance") {
    const original = SourceAccountingStore.prototype.acceptProposals;
    vi.spyOn(SourceAccountingStore.prototype, "acceptProposals").mockImplementationOnce(async function (...args) { await original.apply(this, args); throw new Error("injected crash after accounting acceptance"); });
  } else if (point === "review") {
    const original = SourceAccountingStore.prototype.recordBatchReview;
    vi.spyOn(SourceAccountingStore.prototype, "recordBatchReview").mockImplementationOnce(async function (...args) { await original.apply(this, args); throw new Error("injected crash after review write"); });
  } else vi.spyOn(CompilerFinishReceipts.prototype, "complete").mockRejectedValueOnce(new Error("injected crash before completion"));
  await expect(f.call("finish_compiler_batch", f.input)).rejects.toThrow('"retryable": false');
  expect((await f.receipts.read())?.state).toBe("prepared");
  expect((await inspectCompilerStatus(f.root, f.source.id)).sources[0]!.finish.receipts).toContainEqual(expect.objectContaining({ batchId: f.batch.id, state: "prepared", recoveryRequired: true }));
  await expect(f.receipts.assertCompleted()).rejects.toThrow("checkpoint requires");
  await expect(createPiCompilerSession({ root: f.root, sourceId: f.source.id, compilerBatchId: f.batch.id, segmentIds: f.batch.segmentIds })).rejects.toThrow("resume the durable finish");
  await expect(f.call("withdraw_compiler_proposal", { proposal_id: "accounting", reason: "Attempt to change frozen input" })).rejects.toThrow("freezes this batch");
  expect((await new CompilerBatchStore(f.root).read(f.source.id)).completedBatchIds).toEqual([]);
  // Production command reaches host replay before creating its model runner.
  await compileSourceCommand({ root: f.root, sourceId: f.source.id, batchIds: [f.batch.id], maxBatches: 1,
    configPath: path.join(f.root, "missing.yaml"), allowMissingConfig: true, onProgress() {}, onModelText() {} });
  expect((await new CompilerBatchStore(f.root).read(f.source.id)).completedBatchIds).toEqual([f.batch.id]);
  expect((await f.receipts.read())?.state).toBe("completed");
  const accounting = new SourceAccountingStore(f.root), annotations = new SourceAnnotationStore(f.root);
  expect(await accounting.listProposals(f.source.id, "accepted")).toHaveLength(point === "annotation" ? 0 : 1);
  expect(await annotations.listProposals(f.source.id, "accepted")).toHaveLength(point === "annotation" ? 1 : 0);
  const before = await accounting.read(f.source.id), receipt = await f.receipts.read();
  await expect(recoverCompilerFinish(f.root, f.source.id, f.batch.id)).resolves.toBe(true);
  expect(await accounting.read(f.source.id)).toEqual(before); // including review timestamps/order
  expect(await f.receipts.read()).toEqual(receipt);
});

it("does not checkpoint a model completion claim without a durable receipt", async () => {
  const f = await fixture();
  await expect(runCompilerBatches({ workspaceRoot: f.root, source: f.source, batchIds: [f.batch.id], maxBatches: 1, requireFinishReceipt: true, runner: async () => {} })).rejects.toThrow("checkpoint requires");
  expect((await new CompilerBatchStore(f.root).read(f.source.id)).completedBatchIds).toEqual([]);
});

it("recovers a completed finish after checkpoint failure, preserving its original identity", async () => {
  const f = await fixture();
  vi.spyOn(CompilerBatchStore.prototype, "markComplete").mockRejectedValueOnce(new Error("injected checkpoint failure"));
  const runner = vi.fn(async () => { await f.call("finish_compiler_batch", f.input); });
  const options = { workspaceRoot: f.root, source: f.source, batchIds: [f.batch.id], maxBatches: 1, requireFinishReceipt: true, runner };
  await expect(runCompilerBatches(options)).rejects.toThrow("injected checkpoint failure");
  const receipt = await f.receipts.read();
  expect(receipt?.state).toBe("completed");
  expect((await new CompilerBatchStore(f.root).read(f.source.id)).completedBatchIds).toEqual([]);
  await expect(runCompilerBatches(options)).resolves.toMatchObject({ completed: 1, remaining: 0 });
  expect(runner).toHaveBeenCalledTimes(1);
  expect(await f.receipts.read()).toEqual(receipt);
});

it("rejects changed finish arguments and withdrawn dependencies while retaining the prepared intent", async () => {
  const f = await fixture();
  vi.spyOn(SourceAccountingStore.prototype, "acceptProposals").mockRejectedValueOnce(new Error("injected interruption"));
  await expect(f.call("finish_compiler_batch", f.input)).rejects.toThrow("injected interruption");
  const original = await f.receipts.read();
  const host = createCompilerProposalToolset(f.root, {}, { recoverPreparedFinish: true });
  await host.beginBatch(f.batch.segmentIds, f.batch.id, f.source.id);
  await expect(host.tools.find((tool) => tool.name === "finish_compiler_batch")!.execute("changed-finish", { ...f.input, summary: "Different finish" }, undefined, undefined, {} as never)).rejects.toThrow("original finish input");
  await new SourceAccountingStore(f.root).withdrawProposal(f.source.id, "accounting");
  await expect(recoverCompilerFinish(f.root, f.source.id, f.batch.id)).rejects.toThrow("host review");
  expect(await f.receipts.read()).toEqual(original);
  expect((await new CompilerBatchStore(f.root).read(f.source.id)).completedBatchIds).toEqual([]);
});

it("rehydrates a title already accepted before another finish side effect failed", async () => {
  const f = await fixture("observation");
  await f.call("propose_novel_title", { proposal_id: "title", title: "Hero", evidence_segment_id: f.batch.segmentIds[0] });
  vi.spyOn(SourceAnnotationStore.prototype, "commitProposals").mockRejectedValueOnce(new Error("injected interruption after title"));
  await expect(f.call("finish_compiler_batch", f.input)).rejects.toThrow("after title");
  const source = await WorkspaceStore.openReadOnly(f.root).getSource(f.source.id);
  expect(source?.pendingTitleProposal).toBeUndefined(); expect(source?.title).toBe("Hero");
  await expect(recoverCompilerFinish(f.root, f.source.id, f.batch.id)).resolves.toBe(true);
  expect(await WorkspaceStore.openReadOnly(f.root).getSource(f.source.id)).toEqual(source);
});

it("archives only the explicitly replaced batch, preserving its receipt and audit reason", async () => {
  const f = await fixture();
  await f.call("finish_compiler_batch", f.input);
  const original = await f.receipts.read();
  await CompilerFinishReceipts.archiveSource(f.root, f.source.id, "Explicit scoped reparse", ["unrelated-batch"]);
  expect(await f.receipts.read()).toEqual(original);
  await CompilerFinishReceipts.archiveSource(f.root, f.source.id, "Explicit scoped reparse", [f.batch.id]);
  expect(await f.receipts.read()).toBeUndefined();
  const history = path.join(worldStorageRoot(f.root), "compiler", "finish-receipts", f.source.id, "history");
  const [directory] = await fs.readdir(history), [file] = await fs.readdir(path.join(history, directory!));
  expect(JSON.parse(await fs.readFile(path.join(history, directory!, file!), "utf8"))).toMatchObject({ receipt: original, reason: "Explicit scoped reparse" });
  expect(await CompilerFinishReceipts.list(f.root, f.source.id)).toEqual([]);
});

it("recovers an interrupted TUI source finish before offering the next model turn", async () => {
  const f = await fixture("observation");
  vi.spyOn(CompilerFinishReceipts.prototype, "complete").mockRejectedValueOnce(new Error("injected TUI interruption"));
  await expect(f.call("finish_compiler_batch", f.input)).rejects.toThrow("injected TUI interruption");
  const next = await withWorkspaceOperationLock(f.root, "compiler", () => prepareNextSourceLoopTurn(f.root, f.source.id));
  expect(next?.status).toBe("ready");
  if (next?.status !== "ready") throw new Error("Expected next source turn");
  expect(next.batch.id).not.toBe(f.batch.id);
  expect(next.batch.semanticStage).toBe("semantic");
  expect(next.completedBatches).toBe(1);
  expect((await f.receipts.read())?.state).toBe("completed");
});

async function convergedWorldFinish() {
  const { CanonicalModelStore, ProposalStore } = await import("../src/world/canonical-model.js");
  const { CompilerCommitService } = await import("../src/compiler/validator.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-converged-finish-")); roots.push(root);
  const f = await createEvidenceFixture(root, "The door opened. Then the bell rang.\n");
  const canon = new CanonicalModelStore(root);
  for (const [id, orderHint] of [["door", 1], ["bell", 2]] as const) await canon.putEvent({ id, title: id, participants: [],
    storyTime: { kind: "ordinal", label: id, orderHint }, preconditions: [], observedOutcome: { version: 1, operations: [] },
    evidence: f.evidence("The door opened. Then the bell rang."), causalParents: [], confidence: 1 });
  const batchId = `reconcile-${f.source.id}-test-1`;
  const set = createCompilerProposalToolset(root);
  await set.beginBatch([f.segmentId], batchId, f.source.id);
  const call = (name: string, args: unknown) => set.tools.find(t => t.name === name)!.execute(name, args as never, undefined, undefined, {} as never);
  await call("propose_event_relation", { proposal_id: "relation-proposal", payload: { id: "door-before-bell", fromEventId: "door", toEventId: "bell", type: "before", operationality: "non-operational", status: "explicit", confidence: 1 }, evidence_segment_ids: [f.segmentId] });
  await call("finish_compiler_batch", { outcome: "complete", reviewed_segments: [{ segment_id: f.segmentId, disposition: "proposed", summary: "Reviewed sequence" }], summary: "Recorded sequence" });
  const receipt = await new CompilerFinishReceipts(root, f.source.id, batchId).read();
  expect(receipt?.state).toBe("completed");
  expect((await new CompilerCommitService(root).accept("event-relation", "relation-proposal")).accepted).toBe(true);
  expect(await new ProposalStore(root).list("pending")).toEqual([]);
  return { ...f, root, batchId, receipt, canon, proposals: new ProposalStore(root) };
}

it("resumes finish → convergence → command restart without a model session or duplicate acceptance", async () => {
  const { compileCommand } = await import("../src/commands/compile.js");
  const f = await convergedWorldFinish();
  const before = await f.canon.listEventRelations();
  await compileCommand({ root: f.root, sourceId: f.source.id, compilerBatchId: f.batchId,
    configPath: path.join(f.root, "missing.yaml"), allowMissingConfig: true, acquireLock: false,
    model: "nonexistent-provider/nonexistent-model", prompt: "Continue the already finished batch", onProgress() {} });
  await expect(recoverCompilerFinish(f.root, f.source.id, f.batchId)).resolves.toBe(true);
  expect(await f.canon.listEventRelations()).toEqual(before);
  expect(await f.proposals.list("accepted")).toHaveLength(1);
  expect(await new CompilerFinishReceipts(f.root, f.source.id, f.batchId).read()).toEqual(f.receipt);
});

it("blocks a completed receipt when its accepted canonical output has changed", async () => {
  const f = await convergedWorldFinish();
  const relation = await f.canon.getEventRelation("door-before-bell");
  await f.canon.putEventRelation({ ...relation, confidence: 0.5 });
  await expect(recoverCompilerFinish(f.root, f.source.id, f.batchId)).rejects.toThrow("host review");
  expect(await new CompilerFinishReceipts(f.root, f.source.id, f.batchId).read()).toEqual(f.receipt);
});

it("does not skip a completed world finish after an accepted dependency is removed", async () => {
  const f = await convergedWorldFinish();
  await f.proposals.transition("relation-proposal", "accepted", "rejected");
  await expect(recoverCompilerFinish(f.root, f.source.id, f.batchId)).rejects.toThrow("host review");
  expect(await new CompilerFinishReceipts(f.root, f.source.id, f.batchId).read()).toEqual(f.receipt);
});

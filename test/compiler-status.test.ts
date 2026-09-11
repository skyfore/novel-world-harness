import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectCompilerStatus } from "../src/compiler/status.js";
import { prepareCompilerBatches, CompilerBatchStore } from "../src/compiler/batches.js";
import { CompilerProposalObligations } from "../src/compiler/proposal-obligations.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { TraceStore } from "../src/trace/store.js";
import { workspaceStateDir } from "../src/agent/runtime-paths.js";
import { contentHash } from "../src/world/canonical.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function snapshot(root: string) {
  const files = await fs.readdir(root, { withFileTypes: true, recursive: true });
  return Promise.all(files.filter((item) => item.isFile()).map(async (item) => {
    const file = path.join(item.parentPath, item.name);
    return [file, contentHash((await fs.readFile(file)).toString("base64"))];
  }));
}

it.each([33, 34])("reports effective checkpoint sets for pipeline %s without inventing sequential progress or mutating the run", async (pipelineVersion) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-status-progress-")); roots.push(root);
  const { source } = await createEvidenceFixture(root, "Chapter 1\nHero waits.\n\nChapter 2\nHero leaves.\n");
  const plan = await prepareCompilerBatches(root, source);
  const executable = plan.filter((batch) => batch.semanticStage === "executable");
  const observed = plan.filter((batch) => batch.semanticStage === "observation" || batch.semanticStage === "semantic");
  const oldId = `batch-${source.id}-99999-observation-obsolete`;
  const store = new CompilerBatchStore(root);
  await store.replaceCompleted(source.id, [...observed.map((batch) => batch.id), executable[1]!.id, oldId]);
  const checkpointFile = path.join(store.root, `${source.id}.json`);
  const checkpoint = JSON.parse(await fs.readFile(checkpointFile, "utf8")); checkpoint.pipelineVersion = pipelineVersion;
  await fs.writeFile(checkpointFile, JSON.stringify(checkpoint));
  const journal = new CompilerProposalObligations(root, source.id, executable[0]!.id);
  journal.record("account_source_units", { proposal_id: "p07", page: 1 }, "failed", "coverage changed");
  journal.record("account_source_units", { proposal_id: "p07", decisions: [] }, "failed", "empty correction");
  const writer = new TraceStore(root);
  const run = await writer.createRun({ kind: "prepare", sourceId: source.id });
  const before = await snapshot(workspaceStateDir(root));
  const result = (await inspectCompilerStatus(root, source.id)).sources[0]!;
  expect(result.plan.batches.map((batch) => batch.id)).toEqual(plan.map((batch) => batch.id));
  expect(result.completedBatches).toBe(pipelineVersion === 33 ? observed.length : observed.length + 1);
  expect(result.ignoredCheckpointIds).toContain(oldId);
  expect(result.nextUncheckpointedBatch).toBe(executable[0]!.id);
  expect(result.stages.executable).toMatchObject({ total: 2, completed: pipelineVersion === 33 ? 0 : 1 });
  expect(result.obligations).toMatchObject([{ batchId: executable[0]!.id, proposalId: "p07", requiresHostReview: true }]);
  expect(result.latestRun).toMatchObject({ id: run.id, status: "running" });
  expect(result.candidates).toEqual({ inspection: "verified", archived: false, revisions: [] });
  expect(result.batchReviewComplete).toBe(false);
  expect(result.checkpointReadStable).toBe(true);
  expect(await snapshot(workspaceStateDir(root))).toEqual(before);
});

it("reports unknown progress for a source-mismatched segment layout and leaves the broken manifest intact", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-status-stale-")); roots.push(root);
  const { source } = await createEvidenceFixture(root, "Chapter 1\nHero waits.\n");
  const store = new SegmentStore(root);
  const manifest = (await store.readManifest(source.id))!;
  manifest.segments[0]!.title = "Untrusted replacement heading";
  await store.write(manifest);
  const result = (await inspectCompilerStatus(root, source.id)).sources[0]!;
  expect(result.plan.available).toBe(false);
  expect(result.totalBatches).toBeNull();
  expect(result.batchReviewComplete).toBe(false);
  expect((await store.readManifest(source.id))!.segments[0]!.title).toBe("Untrusted replacement heading");
});

it("reports blocked opening obligations after all source batches complete without changing state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-status-opening-")); roots.push(root);
  const { source } = await createEvidenceFixture(root, "Chapter 1\nHero waits.\n");
  const plan = await prepareCompilerBatches(root, source);
  await new CompilerBatchStore(root).replaceCompleted(source.id, plan.map(batch => batch.id));
  const batchId = `opening-${plan[0]!.id}`;
  const journal = new CompilerProposalObligations(root, source.id, batchId);
  journal.record("propose_initial_world", { proposal_id: "opening", payload: {} }, "failed", "shape error");
  journal.record("propose_initial_world", { proposal_id: "opening", payload: { version: 1 } }, "failed", "semantic error");
  const before = await snapshot(workspaceStateDir(root));
  const result = (await inspectCompilerStatus(root, source.id)).sources[0]!;
  expect(result.batchReviewComplete).toBe(true);
  expect(result.completedBatches).toBe(plan.length);
  expect(result.hasUnresolvedObligations).toBe(true);
  expect(result.supplementalBatches).toEqual([{ id: batchId, phase: "opening", unresolvedObligations: 1, requiresHostReview: true }]);
  expect(result.obligations).toMatchObject([{ batchId, planOrdinal: null, stage: "opening", requiresHostReview: true }]);
  expect(await snapshot(workspaceStateDir(root))).toEqual(before);
});

it("retains a failed preview diagnostic when there are no proposal obligations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-status-preview-")); roots.push(root);
  const { source } = await createEvidenceFixture(root, "Hero waits.\n");
  const traces = new TraceStore(root);
  const run = await traces.createRun({ kind: "prepare", sourceId: source.id, operationId: "opening-test" });
  const blobRef = await traces.putBlob({ content: [{ type: "text", text: "Initial-world preview validation failed: temporalClass requires at-checkpoint.\n\nReceived arguments:\nprivate payload" }] });
  await traces.appendEvent(run.id, { type: "tool.call.failed", spanId: run.rootSpanId, data: { toolName: "preview_initial_world", isError: true }, blobRef });
  await traces.finishRun(run.id, "failed");
  const before = await snapshot(workspaceStateDir(root));
  const result = (await inspectCompilerStatus(root, source.id)).sources[0]!;
  expect(result.obligations).toEqual([]);
  expect(result.latestRun).toMatchObject({ status: "failed", lastToolFailure: { tool: "preview_initial_world", diagnostic: "Initial-world preview validation failed: temporalClass requires at-checkpoint." } });
  expect(await snapshot(workspaceStateDir(root))).toEqual(before);
});

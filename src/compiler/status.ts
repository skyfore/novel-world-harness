import { contentHash } from "../world/canonical.js";
import { isDeepStrictEqual } from "node:util";
import { ProposalStore } from "../world/canonical-model.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { SourceMaterialStore } from "../storage/source-material-store.js";
import { TraceStore } from "../trace/store.js";
import { WorkspaceOperationLock } from "../util/workspace-lock.js";
import { CompilerBatchStore } from "./batch-progress.js";
import { compilerScopePlan, type CompilerPlanStage } from "./batch-plan.js";
import { ChapterSplitPlanStore } from "./chapter-split.js";
import { BoundaryCalibrationStore } from "./boundary-calibration.js";
import { SegmentStore, SEGMENTER_VERSION, segmentSource } from "./segments.js";
import { currentCompilerFingerprint, PreparedNovelCache } from "./prepared-cache.js";
import { CompilerProposalObligations } from "./proposal-obligations.js";

/** This path uses only peeks: no model sessions, locks, migration, assessment writes or checkpoint repair. */
export async function inspectCompilerStatus(root: string, sourceId?: string) {
  const workspace = WorkspaceStore.openReadOnly(root);
  const registered = await workspace.listSources();
  const sources = registered.filter((source) => !sourceId || source.id === sourceId);
  if (sourceId && !sources.length) throw new Error(`Unknown source ${sourceId}; inspect registered sources first.`);
  const lock = await WorkspaceOperationLock.inspect(root);
  return { version: 1, capturedAt: new Date().toISOString(), workspace: workspace.root, stateDirectory: workspace.stateDir,
    compilerFingerprint: currentCompilerFingerprint(),
    compilerLock: lock.owner ? { present: true, pid: lock.owner.pid, startedAt: lock.owner.startedAt, processLiveness: "not-checked" }
      : { present: false, processLiveness: "not-checked" },
    sources: await Promise.all(sources.map((source) => inspectSource(root, source))),
    interpretation: "Batch checkpoints are review progress. Candidate archival, recorded closure, full-novel readiness and executable capability are separate results. This snapshot runs no new evaluation." };
}

async function inspectSource(root: string, source: SourceDocument) {
  const batches = new CompilerBatchStore(root);
  const [persisted, progress, manifest, chapterPlan, boundaries, runs] = await Promise.all([
    batches.readPersisted(source.id), batches.read(source.id), new SegmentStore(root).readManifest(source.id),
    new ChapterSplitPlanStore(root).read(source.id), new BoundaryCalibrationStore(root).list(source.id),
    new TraceStore(root).peekRuns({ sourceId: source.id, kind: "prepare", limit: 1 }),
  ]);
  const diagnostics: string[] = [];
  let sourceIntegrity: "verified" | "missing" | "invalid" = "missing";
  let sourceBytes: Buffer | null = null;
  try { sourceBytes = await new SourceMaterialStore().read(source); sourceIntegrity = sourceBytes ? "verified" : "missing"; }
  catch (error) { sourceIntegrity = "invalid"; diagnostics.push(String(error)); }
  let planAvailable = sourceIntegrity === "verified" && manifest?.sourceSha256 === source.contentSha256 && manifest.segmenterVersion === SEGMENTER_VERSION;
  if (planAvailable && sourceBytes) planAvailable = isDeepStrictEqual(manifest, await segmentSource(root, source, { chapterSplitPlan: chapterPlan, sourceBytes }));
  if (!planAvailable) diagnostics.push("Current plan is unavailable: source archive or segment manifest is missing/incompatible; no state was repaired.");
  const plan = planAvailable ? compilerScopePlan(source, manifest!.segments, Boolean(chapterPlan), boundaries) : [];
  const planned = new Set(plan.map((batch) => batch.id));
  const completedBatchIds = [...new Set(progress.completedBatchIds.filter((id) => planned.has(id)))].sort();
  const completed = new Set(completedBatchIds);
  const stages = Object.fromEntries((["structure", "observation", "semantic", "executable", "boundary"] as CompilerPlanStage[]).map((stage) => {
    const required = plan.filter((batch) => batch.stage === stage);
    const count = required.filter((batch) => completed.has(batch.id)).length;
    return [stage, { total: planAvailable ? required.length : null, completed: count, remaining: planAvailable ? required.length - count : null }];
  }));
  const obligations = plan.flatMap((batch) => {
    const journal = new CompilerProposalObligations(root, source.id, batch.id);
    const host = new Set(journal.requiringHostReview().map((item) => `${item.tool}:${item.proposalId}`));
    return journal.unresolved().map((item) => ({ batchId: batch.id, planOrdinal: batch.ordinal + 1, stage: batch.stage,
      tool: item.tool, proposalId: item.proposalId, status: item.status, updatedAt: item.updatedAt, diagnostic: item.diagnostic,
      requiresHostReview: host.has(`${item.tool}:${item.proposalId}`), checkpointed: completed.has(batch.id) }));
  });
  const proposals = new ProposalStore(root);
  const inventory = await Promise.all((["pending", "accepted", "rejected"] as const).map(async (status) => [status, (await proposals.list(status, source.id)).length] as const));
  const latestRun = runs[0];
  const events = latestRun ? await new TraceStore(root).peekEvents(latestRun.id) : [];
  const model = events.findLast((event) => event.type === "llm.request.started")?.data;
  let revisions: Awaited<ReturnType<PreparedNovelCache["peekArchivedRevisions"]>> = [];
  let candidateInspection: "verified" | "unknown" = "verified";
  try { revisions = await new PreparedNovelCache(root).peekArchivedRevisions(source); }
  catch (error) { candidateInspection = "unknown"; diagnostics.push(`Candidate inspection: ${String(error)}`); }
  const finalProgress = await batches.readPersisted(source.id);
  return {
    sourceId: source.id, sourcePath: source.sourcePath, sourceSha256: source.contentSha256, bytes: source.bytes, sourceIntegrity,
    persistedPipelineVersion: persisted?.pipelineVersion ?? null, effectivePipelineVersion: progress.pipelineVersion,
    checkpointUpdatedAt: persisted?.updatedAt ?? null,
    checkpointReadStable: contentHash(persisted) === contentHash(finalProgress),
    plan: { available: planAvailable, basis: "source-verified-segment-plan", batches: plan.map((batch) => ({ ...batch, ordinal: batch.ordinal + 1 })) },
    stages, completedBatchIds, ignoredCheckpointIds: (persisted?.completedBatchIds ?? []).filter((id) => !completed.has(id)),
    totalBatches: planAvailable ? plan.length : null, completedBatches: completed.size,
    remainingBatches: planAvailable ? plan.length - completed.size : null,
    batchReviewComplete: planAvailable && plan.length > 0 && completed.size === plan.length && obligations.length === 0,
    nextUncheckpointedBatch: plan.find((batch) => !completed.has(batch.id))?.id ?? null,
    obligations, worldProposalInventory: Object.fromEntries(inventory),
    latestRun: latestRun ? { id: latestRun.id, startedAt: latestRun.startedAt, endedAt: latestRun.endedAt ?? null, status: latestRun.status,
      counts: latestRun.counts, usage: latestRun.usage, model: model ? { provider: model.providerId, id: model.modelId, thinking: model.thinkingLevel } : null,
      error: latestRun.error ?? null } : null,
    candidates: { inspection: candidateInspection, archived: revisions.length > 0, revisions }, diagnostics,
  };
}

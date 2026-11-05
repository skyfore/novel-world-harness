import { RoleReviewWorkStore } from "./role-review-work.js";
import { sourceAuditAuthorities, sourceAuditRepairState } from "./role-source-audit-repair.js";
import { sourceAuditBlocked } from "./role-source-audit-model.js";
import { contentHash } from "../world/canonical.js";
import { isDeepStrictEqual } from "node:util";
import { ProposalStore, CanonicalModelStore } from "../world/canonical-model.js";
import { ActorModelStore } from "../world/actors.js";
import { inspectSemanticCoverage } from "./semantic-coverage.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { SourceMaterialStore } from "../storage/source-material-store.js";
import { TraceStore } from "../trace/store.js";
import { WorkspaceOperationLock, inspectProcessLiveness } from "../util/workspace-lock.js";
import { CompilerBatchStore } from "./batch-progress.js";
import { compilerScopePlan, type CompilerPlanStage } from "./batch-plan.js";
import { ChapterSplitPlanStore } from "./chapter-split.js";
import { BoundaryCalibrationStore } from "./boundary-calibration.js";
import { SegmentStore, SEGMENTER_VERSION, segmentSource } from "./segments.js";
import { currentCompilerFingerprint, PreparedNovelCache } from "./prepared-cache.js";
import { CompilerProposalObligations } from "./proposal-obligations.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { inspectIdentityReviewStatuses } from "./identity-repair-handoff.js";

/** This path uses only peeks: no model sessions, locks, migration, assessment writes or checkpoint repair. */
export async function inspectCompilerStatus(root: string, sourceId?: string) {
  const workspace = WorkspaceStore.openReadOnly(root);
  const registered = await workspace.listSources();
  const sources = registered.filter((source) => !sourceId || source.id === sourceId);
  if (sourceId && !sources.length) throw new Error(`Unknown source ${sourceId}; run nwh status --json, copy sources[].sourceId into --source and correct once. Do not guess or retry unchanged.`);
  const lock = await WorkspaceOperationLock.inspect(root);
  return { version: 1, capturedAt: new Date().toISOString(), workspace: workspace.root, stateDirectory: workspace.stateDir,
    compilerFingerprint: currentCompilerFingerprint(),
    compilerLock: lock.owner ? { present: true, pid: lock.owner.pid, startedAt: lock.owner.startedAt, processLiveness: await inspectProcessLiveness(lock.owner) }
      : { present: false, processLiveness: "unknown" },
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
  const supplementalBatchIds = CompilerProposalObligations.listBatchIds(root, source.id).filter(id => !planned.has(id));
  const scopes = [...plan.map(batch => ({ id: batch.id, planOrdinal: batch.ordinal + 1 as number | null, stage: batch.stage as string })),
    ...supplementalBatchIds.map(id => ({ id, planOrdinal: null, stage: id.startsWith("opening-") ? "opening" : "supplemental" }))];
  const obligations = scopes.flatMap((batch) => {
    const journal = new CompilerProposalObligations(root, source.id, batch.id);
    const host = new Set(journal.requiringHostReview().map((item) => `${item.tool}:${item.proposalId}`));
    return journal.unresolved().map((item) => ({ batchId: batch.id, planOrdinal: batch.planOrdinal, stage: batch.stage,
      tool: item.tool, proposalId: item.proposalId, status: item.status, updatedAt: item.updatedAt, diagnostic: item.diagnostic,
      requiresHostReview: host.has(`${item.tool}:${item.proposalId}`), checkpointed: completed.has(batch.id) }));
  });
  const proposals = new ProposalStore(root);
  const inventory = await Promise.all((["pending", "accepted", "rejected"] as const).map(async (status) => [status, (await proposals.list(status, source.id)).length] as const));
  let roleReviewWork: Array<{ batchId: string; planHash: string; current: boolean; sourceWorks: number; reviewedSources: number; auditedSources: number; stagedCandidates: number; blockedAudits: number; openQuestions: number; verifiedClaims: number; pendingClaimVerifications: number; unauditedClaims: number; claimFindings: Array<{candidateId: string; workId: string; verdict: string; claimRevision: string; receiptHash: string}>; auditContractRevisions: Array<{candidateId: string; revisionId: string; predecessorReceiptHash: string; inheritedAttempts: number; inheritedSessions: number; inheritedCalls: number; auditVerdict: string | null}>; sourceAuditRepairs: Array<{page: number; revisionId: string; predecessorWorkId: string; proposed: boolean; blockedProposal: boolean; verificationVerdict: string | null}>; judgmentRevisions: Array<{candidateId: string; revisionId: string; proposed: boolean; auditVerdict: string | null}>; verificationVersion: number; staleSourceAudits: number; staleClaimAudits: number }> = [];
  let roleReviewInspection: "recorded" | "unknown" = "recorded";
  try {
    const revisions = await new RequirementLedger(root, source.id).roleReviewRevisions();
    const retired = new Set(revisions.flatMap(r => r.workMigration ? [r.workMigration.priorPlan.batchId] : []));
    roleReviewWork = (await RoleReviewWorkStore.plans(root, source.id)).map(plan => {
      const store = new RoleReviewWorkStore(root, plan);
      const freshness = store.reviewFreshness();
      const audits = new Map(freshness.sourceAudits.filter(a => a.current).map(a => [a.page, a.audit]));
      const supported = new Set(freshness.claimAudits.filter(a => a.current && a.audit.verdict === "supported").map(a => a.candidateId));
      const currentClaims = freshness.claimAudits.filter(a => a.current);
      return { batchId: plan.batchId, planHash: store.planHash, current: !retired.has(plan.batchId), sourceWorks: plan.spans.length,
        reviewedSources: plan.spans.filter((_, index) => store.read("source", index)).length,
        verificationVersion: 2,
        verifiedClaims: supported.size,
        sourceAuditRepairs: sourceAuditAuthorities(store).map(a => {
          const state = sourceAuditRepairState(store, a);
          return { page: a.page, revisionId: a.revisionId, predecessorWorkId: a.predecessorWorkId,
            proposed: Boolean(state.proposal), blockedProposal: Boolean(state.proposal && sourceAuditBlocked(state.proposal)), verificationVerdict: state.verification?.verdict ?? null };
        }),
        pendingClaimVerifications: store.stagedEntries().filter(e => !supported.has(e.candidateId)).length,
        unauditedClaims: store.stagedEntries().filter(e => !currentClaims.some(a => a.candidateId === e.candidateId)).length,
        claimFindings: currentClaims.filter(a => a.audit.verdict !== "supported").map(a => ({ candidateId: a.candidateId, workId: a.workId, verdict: a.audit.verdict, claimRevision: a.audit.claimRevision, receiptHash: a.receiptHash })),
        auditContractRevisions: store.auditContractAuthorities().map(a => ({candidateId: a.entry.candidateId, revisionId: a.revisionId, predecessorReceiptHash: a.predecessorReceiptHash, inheritedAttempts: a.allowance.attempts, inheritedSessions: a.allowance.contextSessions ?? 0, inheritedCalls: a.allowance.budget!.state.usage.modelCalls, auditVerdict: store.claimAudit(a.entry.candidateId)?.verdict ?? null})),
        judgmentRevisions: store.judgmentAuthorities().map(a => ({ candidateId: a.predecessor.candidateId, revisionId: a.revisionId,
          proposed: store.judgmentRevisions().some(r => r.authority.revisionId === a.revisionId),
          auditVerdict: store.judgmentRevisions().some(r => r.authority.revisionId === a.revisionId) ? store.claimAudit(a.predecessor.candidateId)?.verdict ?? null : null })),
        staleSourceAudits: freshness.sourceAudits.filter(a => !a.current).length,
        staleClaimAudits: freshness.claimAudits.filter(a => !a.current).length,
        openQuestions: plan.spans.flatMap((_, page) => store.questions(page).filter(q => !audits.get(page)?.questionDispositions?.some(d => d.questionId === q.questionId && d.status === "resolved"))).length,
        auditedSources: [...audits.values()].filter(a => a.unresolved.length === 0 && a.questionDispositions?.every(q => q.status === "resolved") && a.discoveryDispositions?.every(d => d.disposition !== "blocked")).length,
        blockedAudits: [...audits.values()].filter(a => a.unresolved.length || a.questionDispositions?.some(q => q.status === "blocked") || a.discoveryDispositions?.some(d => d.disposition === "blocked")).length,
        stagedCandidates: store.stagedEntries().length };
    });
  } catch (error) { roleReviewInspection = "unknown"; diagnostics.push(`Role review work inspection failed: ${String(error)}`); }
  const latestRun = runs[0];
  const events = latestRun ? await new TraceStore(root).peekEvents(latestRun.id) : [];
  const failedTool = events.findLast(event => event.type === "tool.call.failed");
  let lastToolFailure: { tool: string; observedAt: string; diagnostic: string } | null = null;
  if (failedTool) {
    let diagnostic = "Tool call failed; no readable diagnostic blob is available.";
    try {
      const blob = failedTool.blobRef ? await new TraceStore(root).peekBlob(failedTool.blobRef) : null;
      if (blob && typeof blob === "object" && "content" in blob && Array.isArray(blob.content)) {
        const text = blob.content.filter(item => item?.type === "text" && typeof item.text === "string").map(item => item.text).join("\n");
        if (text) diagnostic = text.split("Received arguments:")[0]!.split("<nwh-tool-recovery>")[0]!.trim().slice(0, 4000);
      }
    } catch (error) { diagnostics.push(`Tool failure inspection: ${String(error)}`); }
    lastToolFailure = { tool: String(failedTool.data?.toolName ?? "unknown"), observedAt: failedTool.observedAt, diagnostic };
  }
  const model = events.findLast((event) => event.type === "llm.request.started")?.data;
  let revisions: Awaited<ReturnType<PreparedNovelCache["peekArchivedRevisions"]>> = [];
  let candidateInspection: "verified" | "unknown" = "verified";
  try { revisions = await new PreparedNovelCache(root).peekArchivedRevisions(source); }
  catch (error) { candidateInspection = "unknown"; diagnostics.push(`Candidate inspection: ${String(error)}`); }
  const finalProgress = await batches.readPersisted(source.id);
  let finishReceipts: Array<{ batchId: string; state: string; preparedAt: string; completedAt: string | null; fingerprint: string; checkpointed: boolean; recoveryRequired: boolean }> = [];
  let finishInspection: "verified" | "unknown" = "verified";
  try {
    finishReceipts = (await CompilerFinishReceipts.list(root, source.id)).map((receipt) => ({
      batchId: receipt.identity.batchId, state: receipt.state, preparedAt: receipt.preparedAt, completedAt: receipt.completedAt ?? null,
        fingerprint: receipt.fingerprint, checkpointed: completed.has(receipt.identity.batchId),
        recoveryRequired: receipt.state !== "completed" || (planned.has(receipt.identity.batchId) && !completed.has(receipt.identity.batchId)),
    }));
  } catch (error) { finishInspection = "unknown"; diagnostics.push(`Finish receipt inspection: ${String(error)}`); }
  let identityReviews: Awaited<ReturnType<typeof inspectIdentityReviewStatuses>> = [];
  let identityReviewInspection: "recorded" | "unknown" = "recorded";
  try {
    const history = await new RequirementLedger(root, source.id).history();
    identityReviews = await inspectIdentityReviewStatuses(root, source.id, history);
  }
  catch (error) { identityReviewInspection = "unknown"; diagnostics.push(`Identity review inspection: ${String(error)}`); }
  let semanticCoverage: ReturnType<typeof inspectSemanticCoverage> | null = null;
  try {
    const [events, goals, sets] = await Promise.all([new CanonicalModelStore(root).listEvents(), new ActorModelStore(root).listGoals(), new RequirementLedger(root, source.id).definitions()]);
    semanticCoverage = inspectSemanticCoverage(source.id, { events: new Map(events.map(e => [e.id, e])), goals: new Map(goals.map(g => [g.id, g])) },
      sets.filter(s => s.spec.sourceSha256 === source.contentSha256).map(s => s.spec));
  } catch (error) { diagnostics.push(`Semantic coverage inspection: ${String(error)}`); }
  const latestActivity = identityReviews.flatMap(t => t.consumerRevalidation.attempts.flatMap(a => a.stages.map(s => s.execution?.activity)))
    .find(a => a?.traceRunId === latestRun?.id);
  return {
    semanticCoverage,
    progress: { batchExecution: { completed: completed.size, total: planAvailable ? plan.length : null },
      sourceClosure: roleReviewWork.filter(w => w.current).map(w => ({ planHash: w.planHash, audited: w.auditedSources, total: w.sourceWorks, openQuestions: w.openQuestions })),
      consumerClosure: identityReviews.map(t => ({ taskId: t.taskId, inventoryHash: t.inventoryHash, total: t.totalConsumers,
        reviewed: t.consumerRevalidation.recordedReviewedConsumers, cleared: t.consumerRevalidation.recordedClearedConsumers })),
      semanticReview: semanticCoverage ? { events: semanticCoverage.events.length, goals: semanticCoverage.goals.length, missing: semanticCoverage.missingReviewRefs.length,
        activationEntailsCompletion: semanticCoverage.goals.filter(g => g.activationEntailsCompletion).length } : null,
      delivery: { archived: revisions.length, active: revisions.filter(r => r.active).map(r => r.bundleHash), currentCertification: "not-reverified" },
      interpretation: "Compare source/plan/inventory hashes before computing net changes. Batch execution, verified requirement closure and delivery are separate; calls, code changes and artifacts do not measure semantic completion." },
    identityReviews: { inspection: identityReviewInspection, tasks: identityReviews },
    roleReviewWork, roleReviewInspection, sourceId: source.id, sourcePath: source.sourcePath, sourceSha256: source.contentSha256, bytes: source.bytes, sourceIntegrity,
    persistedPipelineVersion: persisted?.pipelineVersion ?? null, effectivePipelineVersion: progress.pipelineVersion,
    checkpointUpdatedAt: persisted?.updatedAt ?? null,
    checkpointReadStable: contentHash(persisted) === contentHash(finalProgress),
    plan: { available: planAvailable, basis: "source-verified-segment-plan", batches: plan.map((batch) => ({ ...batch, ordinal: batch.ordinal + 1 })) },
    stages, completedBatchIds, ignoredCheckpointIds: (persisted?.completedBatchIds ?? []).filter((id) => !completed.has(id)),
    totalBatches: planAvailable ? plan.length : null, completedBatches: completed.size,
    remainingBatches: planAvailable ? plan.length - completed.size : null,
    batchReviewComplete: planAvailable && plan.length > 0 && completed.size === plan.length && !obligations.some(item => planned.has(item.batchId)),
    hasUnresolvedObligations: obligations.length > 0,
    supplementalBatches: supplementalBatchIds.map(id => ({ id, phase: id.startsWith("opening-") ? "opening" : "supplemental",
      unresolvedObligations: obligations.filter(item => item.batchId === id).length,
      requiresHostReview: obligations.some(item => item.batchId === id && item.requiresHostReview) })),
    nextUncheckpointedBatch: plan.find((batch) => !completed.has(batch.id))?.id ?? null,
    obligations, finish: { inspection: finishInspection, receipts: finishReceipts, interpretation: "Receipt checksums only; host recovery revalidates dependencies and the original finish before checkpointing." }, worldProposalInventory: Object.fromEntries(inventory),
    latestRun: latestRun ? { id: latestRun.id, operationId: latestRun.operationId ?? null, startedAt: latestRun.startedAt, endedAt: latestRun.endedAt ?? null,
      status: latestRun.status === "running" && latestActivity && latestActivity.state !== "RUNNING" ? latestActivity.state : latestRun.status, recordedStatus: latestRun.status,
      lastActivityAt: events.at(-1)?.observedAt ?? latestRun.startedAt,
      processLiveness: latestRun.status === "running" ? latestActivity?.processLiveness ?? await inspectProcessLiveness(events.findLast(e => e.type === "stage.started" && e.data?.owner)?.data?.owner as Parameters<typeof inspectProcessLiveness>[0]) : "not-applicable",
      counts: latestRun.counts, usage: latestRun.usage, model: model ? { provider: model.providerId, id: model.modelId, thinking: model.thinkingLevel } : null,
      error: latestRun.error ?? null, lastToolFailure } : null,
    candidates: { inspection: candidateInspection, archived: revisions.length > 0, revisions }, diagnostics,
  };
}

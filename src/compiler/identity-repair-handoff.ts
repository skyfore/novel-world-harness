import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { affectedClosureNodes, closureGraphSchema } from "./closure.js";
import { RequirementLedger, type LedgerRecord } from "./requirement-ledger.js";
import { identityReviewStatus } from "./identity-review-status.js";
import { identityRequirementDirectory, validateIdentityOutput, type IdentityRecord } from "./identity-requirements.js";
import type { PreparedIdentityRequirements } from "./identity-requirement-service.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { upstreamRepairKindSchema, upstreamRepairRevisionFields } from "./upstream-repair-plan.js";
import { UpstreamRepairLedger } from "./upstream-repair-ledger.js";
import { CanonicalModelStore } from "../world/canonical-model.js";
import type { ConsumerRevalidationRecord } from "./identity-consumer-revalidation-model.js";
import { inspectConsumerRevalidationAttempts } from "./identity-consumer-attempt-status.js";

const optionsSchema = z.object({ taskId: z.string().regex(/^[a-f0-9]{64}$/).optional(), ref: z.string().min(1).optional(),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(48).default(24) }).strict();
export type IdentityRepairInspectionOptions = z.input<typeof optionsSchema>;
const key = (ref: { kind: string; id: string }) => `${ref.kind}/${ref.id}`;

export function identityReviewStatuses(history: LedgerRecord[]) {
  const tasks = new Map<string, IdentityRecord[]>();
  for (const entry of history) if (entry.payload.kind === "identity-requirements") {
    const record = entry.payload.record;
    const records = tasks.get(record.intent.taskId) ?? [];
    records.push(record); tasks.set(record.intent.taskId, records);
  }
  return [...tasks.entries()].map(([taskId, records]) => identityReviewStatus(records, history.flatMap(r =>
    r.payload.kind === "identity-consumer-revalidation" && r.payload.record.scope.taskId === taskId ? [r.payload.record] : [])));
}

export async function inspectIdentityReviewStatuses(root: string, sourceId: string, history: LedgerRecord[]) {
  const tasks = identityReviewStatuses(history);
  for (const task of tasks) task.consumerRevalidation.attempts = await inspectConsumerRevalidationAttempts(root, sourceId,
    history.flatMap(r => r.payload.kind === "identity-requirements" && r.payload.record.intent.taskId === task.taskId ? [r.payload.record] : []),
    history.flatMap(r => r.payload.kind === "identity-consumer-revalidation" && r.payload.record.scope.taskId === task.taskId ? [r.payload.record] : []));
  return tasks;
}

function page<T>(items: T[], offset: number, limit: number) {
  if (offset > items.length) throw prerequisiteStop("Identity inspection offset is outside this scope. Repeat the same inspect-identity-repairs source/task/ref with --offset 0 and copy nextOffset once; do not guess cursors or retry unchanged");
  const end = Math.min(items.length, offset + limit);
  return { total: items.length, offset, nextOffset: end < items.length ? end : null, items: items.slice(offset, end) };
}

/** Keeps model-proposed work and its independent review together. No prose
 * classification, write plan, new task, budget or semantic approval is created. */
export function buildIdentityRepairHandoff(p: PreparedIdentityRequirements, records: IdentityRecord[], raw: IdentityRepairInspectionOptions = {}, revalidations: ConsumerRevalidationRecord[] = []) {
  const options = optionsSchema.parse(raw), { intent, inventory } = p;
  if (options.taskId && options.taskId !== intent.taskId) throw prerequisiteStop("Identity handoff task scope changed; inspect tasks[].taskId for the same source, correct once, no guessing");
  validateIdentityOutput(intent, records, inventory, p.semantic);
  if (!records.length || contentHash(records[0]!.intent) !== contentHash(intent)) throw prerequisiteStop("Identity handoff has no exact original intent; preserve the ledger and inspect its original records, no dispatch");
  const graph = closureGraphSchema.parse(p.graph);
  if (contentHash(graph) !== inventory.graphHash) throw prerequisiteStop("Identity consumer graph changed; retain the original graph and ledger, resolve the current baseline before planning, no retry or authority");
  const consumers = new Map(inventory.consumers.map(c => [c.ref, c]));
  const nodes = new Map(graph.nodes.map(n => [key(n), n]));
  for (const consumer of inventory.consumers) {
    if (contentHash(consumer.payload) !== consumer.revisionHash
      || (consumer.reason === "typed-consumer" && nodes.get(consumer.ref)?.revisionHash !== consumer.revisionHash))
      throw prerequisiteStop("Identity consumer payload lost its frozen revision; inspect the original inventory and current artifact, no repinning or repair dispatch");
  }
  const assessments = records.flatMap(record => {
    if (record.output.phase !== "identity-consumers") return [];
    const output = record.output, checkRecord = records.find(r => r.stage === `identity-consumers-check-${output.shard}`);
    const check = checkRecord?.output.phase === "identity-consumers-check" ? checkRecord.output : undefined;
    return output.consumers.map((consumer, index) => ({
      ...consumer, shard: output.shard,
      findingId: contentHash({ taskId: intent.taskId, recordHash: contentHash(record), pointer: `/output/consumers/${index}` }),
      proposalRecordHash: contentHash(record), proposalPointer: `/output/consumers/${index}`,
      checkRecordHash: checkRecord ? contentHash(checkRecord) : null,
      independentReview: check?.consumers.find(c => c.ref === consumer.ref) ?? null,
      repairAcceptance: "not-evaluated" as const,
    }));
  });
  const work = assessments.filter(c => c.disposition !== "unaffected");
  const summary = identityReviewStatus(records, revalidations);
  const shared = { version: 1, policy: "identity-consumer-repair-handoff/v1", sourceId: intent.sourceId, taskId: intent.taskId,
    intentHash: contentHash(intent), inventoryHash: intent.inventoryHash, graphHash: inventory.graphHash,
    summary, closureIssues: graph.issues,
    candidateIds: inventory.candidateIds, sourcePages: inventory.sourcePages, originalQuestionIds: inventory.originalQuestionIds,
    activationConditions: records.flatMap(r => r.output.phase === "identity-consumers"
      ? [{ shard: r.output.shard, recordHash: contentHash(r), conditions: r.output.activationConditions }] : []),
    interpretation: "Retained Pi findings and exact dependency baselines. Supported means the review supports the recorded disposition; it does not complete a repair or revalidation. Unread shards and source-review coverage remain required. No write plan, retry, grant, parent resume or certification is issued.",
    executionAuthority: false, parentResumeAllowed: false, certificationGranted: false };
  if (!options.ref) return { ...shared, ...page(work, options.offset, options.limit),
    availableRefs: inventory.consumers.map(c => c.ref),
    nextAction: "Copy items[].ref into --ref for the same source/task to inspect its exact baseline and typed downstream consumers. Additional repair requires its own supported type, independent requirements, exact plan and acceptance; do not rerun consumed reviews." };

  const selected = consumers.get(options.ref);
  if (!selected) throw prerequisiteStop("Unknown identity consumer ref. Run requirements inspect-identity-repairs with the same --source and --task, copy availableRefs[] (or items[].ref) into --ref, and correct once; never guess or retry unchanged");
  const node = nodes.get(selected.ref);
  const affected = node ? affectedClosureNodes(graph, [node]) : [];
  // A typed subtree must remain inside the original complete consumer inventory.
  if (affected.some(ref => !consumers.has(ref))) throw prerequisiteStop("Identity handoff lost a transitive consumer; inspect the frozen graph and complete inventory, no partial plan or dispatch");
  const downstream = affected.map(ref => {
    const consumer = consumers.get(ref)!, current = nodes.get(ref)!;
    const assessment = assessments.find(c => c.ref === ref);
    // Large nodes can contain thousands of pointer uses. Keep discovery bounded;
    // --ref reads the complete selected node, never a truncated dependency list.
    return { ref, revisionHash: consumer.revisionHash,
      dependencies: { count: current.dependsOn.length, hash: contentHash(current.dependsOn), readRef: ref },
      recordedAssessment: assessment ? { findingId: assessment.findingId, disposition: assessment.disposition,
        independentVerdict: assessment.independentReview?.verdict ?? null } : null,
      shard: intent.consumerShards.find(s => s.refs.includes(ref))!.index };
  });
  const baselineManifest = downstream.map(({ ref, revisionHash }) => ({ ref, revisionHash }));
  const registeredKind = upstreamRepairKindSchema.safeParse(node?.kind === "initial" ? "initial-world" : node?.kind === "event" ? "canonical-event"
    : node?.kind === "participation" ? "event-participation"
      : node?.kind === "annotation" && selected.payload && typeof selected.payload === "object" && "annotationType" in selected.payload
        ? selected.payload.annotationType : node?.kind);
  return { ...shared, selected: { ...selected, dependencies: node?.dependsOn ?? [], recordedAssessment: assessments.find(c => c.ref === selected.ref) ?? null },
    receiptBoundRevalidation: summary.consumerRevalidation.reviews.filter(r => r.ref === selected.ref),
    capability: { existingArtifactRevision: !registeredKind.success ? "unsupported-kind"
      : upstreamRepairRevisionFields(registeredKind.data).length ? "requires-independent-exact-plan" : "unsupported-revision",
      writableFields: registeredKind.success ? upstreamRepairRevisionFields(registeredKind.data) : [],
      originalIdentityScopeAllowsConsumerWrites: false },
    downstream: page(downstream, options.offset, options.limit),
    baselineManifest, baselineManifestHash: contentHash(baselineManifest),
    sourceReviewCoverage: inventory.consumers.filter(c => c.reason !== "typed-consumer").map(c => ({ ref: c.ref,
      revisionHash: c.revisionHash, reason: c.reason, shard: intent.consumerShards.find(s => s.refs.includes(c.ref))!.index })),
    nextAction: "Preserve the selected payload and every historical revision. An additional repair requires a supported typed operation, independent requirements, an exact current plan and acceptance. This dependency closure does not authorize deletion, merging, rebinding or activation." };
}

/** Read-only source-scoped discovery. Detailed inspection reconstructs current
 * inputs; trace/host acceptance remains exclusively in the existing verifier. */
export async function inspectIdentityRepairHandoff(root: string, sourceId: string, raw: IdentityRepairInspectionOptions = {}) {
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) throw prerequisiteStop("Invalid identity inspection scope/page. Discover tasks[].taskId with requirements inspect-identity-repairs --source <exact source ID>; use offset 0 and limit 1..48, copy returned fields and correct once. No guessed IDs or unchanged retry");
  const options = parsed.data;
  const source = await WorkspaceStore.openReadOnly(root).getSource(sourceId);
  if (!source) throw prerequisiteStop("Unknown source. Run nwh status --json, copy sources[].sourceId into --source and correct once; do not guess or retry unchanged");
  const ledger = new RequirementLedger(root, sourceId), history = await ledger.history();
  const tasks = await inspectIdentityReviewStatuses(root, sourceId, history);
  if (!options.taskId) {
    if (options.ref || options.offset) throw prerequisiteStop("A consumer/page requires its exact task. Run requirements inspect-identity-repairs for the same source without --ref/--offset, copy tasks[].taskId into --task and correct once; no guessing");
    return { sourceId, tasks, executionAuthority: false };
  }
  const records = history.flatMap(r => r.payload.kind === "identity-requirements" && r.payload.record.intent.taskId === options.taskId ? [r.payload.record] : []);
  const revalidations = history.flatMap(r => r.payload.kind === "identity-consumer-revalidation" && r.payload.record.scope.taskId === options.taskId ? [r.payload.record] : []);
  const intent = records[0]?.intent;
  if (!intent) throw prerequisiteStop("Unknown identity task. Run requirements inspect-identity-repairs with the same --source, copy tasks[].taskId into --task and correct once; do not guess or retry unchanged");
  const review = history.find(r => r.payload.kind === "role-dependency-review" && r.payload.review.taskId === intent.taskId);
  if (review?.payload.kind !== "role-dependency-review") throw prerequisiteStop("Identity task lost its original dependency review; preserve the ledger, no repair or retry");
  const upstream = await new UpstreamRepairLedger(root, sourceId).inspect();
  const repairs = upstream.plans.filter(p => p.plan.identityRequirements?.taskId === intent.taskId && p.plan.identityRequirements.consumerRepair);
  if (repairs.length) {
    // An accepted revision intentionally changes the live catalog. Inspection
    // must retain the original finding rather than reconstructing and repinning
    // its old intent from the changed world. Live repair state is separate.
    const saved = JSON.parse(await fs.readFile(path.join(identityRequirementDirectory(root, sourceId, intent.taskId), "context.json"), "utf8"));
    const prepared = { ...saved, bytes: Buffer.from(saved.sourceBytesBase64, "base64") } as PreparedIdentityRequirements;
    if (contentHash(prepared.intent) !== contentHash(intent) || contentHash(prepared.catalog) !== intent.catalogHash
      || contentHash(prepared.review) !== contentHash(review.payload.review) || source.contentSha256 !== intent.sourceHash)
      throw prerequisiteStop("Original identity inspection context changed; preserve it and inspect the same task, no repinning or retry");
    const result = buildIdentityRepairHandoff(prepared, records, options, revalidations), canonical = new CanonicalModelStore(root);
    result.summary.consumerRevalidation.attempts = tasks.find(t => t.taskId === intent.taskId)!.consumerRevalidation.attempts;
    const typedRepairs = await Promise.all(repairs.map(async repair => {
      const authority = repair.plan.identityRequirements!, consumer = authority.consumerRepair!;
      const successor = repairs.find(p => p.plan.identityRequirements?.consumerRevalidation?.parentPlanHash === repair.plan.planHash);
      const lastFailure = upstream.records.findLast(r => r.payload.kind === "attempt-failed" && r.payload.planHash === repair.plan.planHash)?.payload;
      const stop = upstream.records.findLast(r => r.payload.kind === "needs-host-review" && r.payload.planHash === repair.plan.planHash);
      if (contentHash(authority.recordHashes) !== contentHash(records.map(contentHash))) throw prerequisiteStop("Typed repair changed its original finding history");
      const entity = await canonical.getEntity(consumer.entityId);
      const finished = repair.state === "converged" || repair.state === "evaluated";
      const { identityUpstreamDirectory } = await import("./identity-requirement-acceptance.js");
      const { inspectIdentityFinishRevisionProgress } = await import("./identity-finish-revision.js");
      const finishRevisionProgress = await inspectIdentityFinishRevisionProgress(identityUpstreamDirectory(root, repair.plan));
      return { planHash: repair.plan.planHash, findingId: consumer.findingId, state: repair.state, receiptFingerprint: repair.finishedReceipt ?? null,
        successorPlanHash: successor?.plan.planHash ?? null,
        lastFailure: lastFailure?.kind === "attempt-failed" ? { attemptRef: lastFailure.attemptRef, diagnostic: lastFailure.diagnostic } : null,
        currentStop: repair.state === "needs-host-review" && stop?.payload.kind === "needs-host-review"
          ? { recordRef: stop.hash, diagnostic: stop.payload.reason, finishIntentHash: repair.finishIntent?.intentHash ?? null,
            recovery: finishRevisionProgress?.blocked ? "inspect-consumed-opening-revision" : repair.finishIntent && !repair.finishedReceipt && !repair.finishRevision && authority.consumerRevalidation
              ? "pre-receipt-opening-revision" : "inspect-original-stop" } : null,
        finishRevision: repair.finishRevision ? { revisionHash: repair.finishRevision.intent.revisionHash,
          completed: repair.finishRevision.completed, originalIntentHash: repair.finishRevision.intent.originalIntentHash,
          independentAcceptance: "requires-revised-graph-verification" } : null,
        finishRevisionProgress,
        currentEntity: { ref: `entity/${entity.id}`, revisionHash: contentHash(entity), payload: entity },
        acceptance: "requires-exact-receipt-verification",
        consumerRevalidation: result.summary.consumerRevalidation.attempts.some(a => a.compilerCorrection && a.semanticJudgmentPending && a.status === "BREAK")
          ? "needs-host-review" : result.summary.consumerRevalidation.blockedRefs.length ? "blocked" : "not-completed",
        consumerRevalidationRecordIds: result.summary.consumerRevalidation.reviews.filter(r => r.receiptFingerprint === repair.finishedReceipt).map(r => r.id),
        requirementEvaluation: repair.evaluation?.result.result ?? null,
        command: { program: "nwh", args: ["--root", path.resolve(root), "requirements",
          ...(successor || repair.state === "needs-host-review" || finishRevisionProgress?.blocked ? ["inspect-identity-repairs", "--task", intent.taskId,
            "--ref", authority.consumerRevalidation || successor ? `initial/${sourceId}` : `entity/${consumer.entityId}`]
            : repair.state === "converged" ? ["evaluate-upstream"] : repair.state === "evaluated"
            ? ["inspect-identity-repairs", "--task", intent.taskId, "--ref", `entity/${consumer.entityId}`]
            : ["execute-identity-repair", "--task", intent.taskId, "--ref", authority.consumerRevalidation ? `initial/${sourceId}` : `entity/${consumer.entityId}`,
              "--authorization-ref", repair.plan.authorizationRef, ...(authority.consumerRevalidation ? ["--revalidation-id", authority.consumerRevalidation.id] : [])]), "--source", sourceId] },
        resumeCondition: successor ? "This completed repair has an exact receipt-bound successor. Preserve its accepted revisions and history; inspect the successor instead of replaying the old plan." : finished
          ? "Typed repair is complete. Preserve its original proposal, receipt, attempts and budget. Local requirement satisfaction does not revalidate downstream consumers or the original critical questions; inspect their retained conditions before any separately authorized continuation. Do not redispatch the completed repair."
          : finishRevisionProgress?.blocked ? finishRevisionProgress.resumeCondition
          : repair.finishIntent && !repair.finishedReceipt && !repair.finishRevision && authority.consumerRevalidation
            ? "Copy currentStop.recordRef into execute-identity-repair --revise-failed-finish with the exact task/ref/revalidation-id and explicit --revision-authorization-ref; inspect first. One bounded Pi singleton draft, unchanged source and writable fields, original remaining independent review allowance. ID misses allow one discovery-based correction; source/scope, receipts, consumed or failed revision stops do not retry. Preserve old proposals, acceptance, failures and budgets."
            : "Only the original verified stage records and checkpoints may resume. Never replay a consumed invocation or use repair convergence as consumer activation." };
    }));
    if (contentHash(await ledger.history()) !== contentHash(history)) throw prerequisiteStop("Identity ledger changed during inspection; inspect its owning task without automatic retry");
    return { ...result, currentInputs: "original-finding-preserved-live-repair-separate", typedRepairs,
      modelAndHostAcceptance: "not-reverified", ledgerHead: history.at(-1)!.hash };
  }
  const { prepareIdentityRequirements } = await import("./identity-requirement-service.js");
  const dependency = review.payload.review;
  const prepared = await prepareIdentityRequirements(root, { scope: dependency.scope, upstreamPlanHash: dependency.upstream.planHash,
    authorizationRef: dependency.authorizationRef }, intent.authorizationRef, intent.priorUsage);
  const result = buildIdentityRepairHandoff(prepared, records, options, revalidations);
  result.summary.consumerRevalidation.attempts = tasks.find(t => t.taskId === intent.taskId)!.consumerRevalidation.attempts;
  if (contentHash(await ledger.history()) !== contentHash(history)) throw prerequisiteStop("Identity ledger changed during inspection; preserve both snapshots, inspect the owning task before planning, no mutation or automatic retry");
  return { ...result, currentInputs: "verified", modelAndHostAcceptance: "not-reverified", ledgerHead: history.at(-1)!.hash };
}

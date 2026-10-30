import { contentHash } from "../world/canonical.js";
import { identityConsumerShardReady, identityDefinitionGaps, identityRequirementsReady, sameIdentitySet,
  validateIdentityHistory, type IdentityRecord } from "./identity-requirements.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { consumerRevalidationId, validateConsumerRevalidationHistory, type ConsumerRevalidationRecord } from "./identity-consumer-revalidation-model.js";
import type { ConsumerRevalidationAttempt } from "./identity-consumer-attempt-status.js";

/** Receipt-bound reviews are additional evidence. They never replace the old
 * shard denominator or turn support for a blocked decision into clearance. */
export function consumerRevalidationStatus(original: IdentityRecord[], records: ConsumerRevalidationRecord[]) {
  const groups = new Map<string, ConsumerRevalidationRecord[]>();
  for (const record of records) {
    const id = consumerRevalidationId(record.scope), group = groups.get(id) ?? [];
    group.push(record); groups.set(id, group);
  }
  const reviews = [...groups.entries()].map(([id, group]) => {
    validateConsumerRevalidationHistory(group, original);
    const first = group[0]!, proposal = first.output, check = group[1]?.output;
    if (proposal.phase !== "consumer-revalidation") throw prerequisiteStop("Consumer revalidation lost its original proposal; inspect the same task without redispatch");
    const independent = check?.phase === "consumer-revalidation-check" ? check : null;
    return { id, ref: first.scope.ref, scopeHash: contentHash(first.scope), upstreamPlanHash: first.scope.upstreamPlanHash,
      receiptFingerprint: first.scope.receiptFingerprint, currentRevisionHash: first.scope.currentRevisionHash,
      proposalRecordHash: contentHash(first), checkRecordHash: group[1] ? contentHash(group[1]) : null,
      disposition: proposal.disposition, independentVerdict: independent?.verdict ?? null,
      status: !independent ? "awaiting-independent-check" as const : independent.verdict === "blocked" ? "blocked" as const : proposal.disposition,
      rationale: proposal.rationale, independentRationale: independent?.rationale ?? null,
      blockedRequirements: proposal.requirements.filter(r => r.verdict === "blocked"),
      retainedQuestionIds: proposal.retainedQuestionIds, initialWorldRepair: proposal.initialWorldRepair,
      entityRepair: proposal.entityRepair ?? null, compilerCorrection: first.scope.compilerCorrection ?? null };
  });
  const latest = [...new Map(reviews.map(r => [r.ref, r])).values()];
  const total = original[0]?.intent.consumerShards.reduce((n, s) => n + s.refs.length, 0) ?? 0;
  return { totalConsumers: total, recordedConsumers: latest.length,
    recordedReviewedConsumers: latest.filter(r => r.independentVerdict !== null).length,
    recordedClearedConsumers: latest.filter(r => ["unaffected", "revalidated"].includes(r.status)).length,
    unrecordedConsumers: total - latest.length,
    blockedRefs: latest.filter(r => r.status === "blocked").map(r => r.ref),
    repairRequiredRefs: latest.filter(r => r.status === "repair-required").map(r => r.ref), reviews,
    attempts: [] as ConsumerRevalidationAttempt[],
    verification: "ledger-snapshot-only" as const, sourceAuditResumeAllowed: false as const,
    interpretation: "Receipt-bound records retain the original denominator. Independent support approves the recorded disposition, including blocked. Current dependency verification, original questions and source-audit continuation remain separate; no execution or resume authority." };
}

/** A projection of retained ledger records, never a replacement acceptance gate.
 * A supported check can support a decision to keep a consumer blocked. */
export function identityReviewStatus(records: IdentityRecord[], revalidations: ConsumerRevalidationRecord[] = []) {
  validateIdentityHistory(records);
  const first = records[0];
  if (!first) throw prerequisiteStop("Identity review has no retained records; inspect requirements inspect-identity-repairs for this source and copy tasks[].taskId once; do not guess or retry unchanged");
  const { intent } = first;
  const allRefs = intent.consumerShards.flatMap(s => s.refs);
  if (intent.consumerShards.some((s, index) => s.index !== index) || new Set(allRefs).size !== allRefs.length)
    throw prerequisiteStop("Identity shard partition repeats or renumbers consumers; inspect the original intent and inventory, no partial progress or retry");
  const firstConsumers = records.find(r => r.output.phase === "identity-consumers")?.output;
  const shards = intent.consumerShards.map(shard => {
    const proposal = records.find(r => r.stage === `identity-consumers-${shard.index}`);
    const check = records.find(r => r.stage === `identity-consumers-check-${shard.index}`);
    const output = proposal?.output.phase === "identity-consumers" ? proposal.output : undefined;
    const reviewed = check?.output.phase === "identity-consumers-check" ? check.output : undefined;
    if (output && (!sameIdentitySet(output.consumers.map(c => c.ref), shard.refs)
      || !sameIdentitySet(output.bindings.map(b => b.requirementId), intent.targets.map(t => t.requirementId))))
      throw prerequisiteStop("Retained identity shard omitted a frozen consumer or binding; inspect its original ledger and proposal, no retry or authority");
    const dispositions = { unaffected: 0, "preserve-blocked": 0, "revalidate-required": 0, "additional-repair-required": 0, unknown: 0 };
    for (const consumer of output?.consumers ?? []) dispositions[consumer.disposition]++;
    return {
      index: shard.index, totalConsumers: shard.refs.length,
      proposalRecordHash: proposal ? contentHash(proposal) : null,
      checkRecordHash: check ? contentHash(check) : null,
      recordedReviewComplete: Boolean(output && reviewed),
      recordedRepairSupport: Boolean(check && identityConsumerShardReady(records, check.stage)),
      dispositions,
      blockedConsumerChecks: reviewed?.consumers.filter(c => c.verdict === "blocked").map(c => c.ref) ?? [],
      payloadConditions: output?.bindings.filter(b => b.missingCondition.trim()).map(b => ({ requirementId: b.requirementId,
        condition: b.missingCondition, conditionHash: contentHash(b.missingCondition) })) ?? [],
      denominator: reviewed ? { verdict: reviewed.denominatorVerdict, rationale: reviewed.denominatorRationale,
        scope: "not-recorded" } : null,
    };
  });
  return {
    taskId: intent.taskId, intentHash: contentHash(intent), sourceId: intent.sourceId,
    inventoryHash: intent.inventoryHash, revisionHash: intent.revisionHash, originalPlanHash: intent.originalPlanHash,
    totalShards: shards.length, recordedReviewedShards: shards.filter(s => s.recordedReviewComplete).length,
    totalConsumers: shards.reduce((n, s) => n + s.totalConsumers, 0),
    recordedReviewedConsumers: shards.filter(s => s.recordedReviewComplete).reduce((n, s) => n + s.totalConsumers, 0),
    unreviewedShards: shards.filter(s => !s.recordedReviewComplete).map(s => s.index),
    recordedGlobalRepairSupport: identityRequirementsReady(records),
    retainedDefinitionConditions: identityDefinitionGaps(first.output),
    // Targets may address only one of the original critical questions. Do not
    // shrink the full denominator to those target bindings.
    targetQuestionIds: [...new Set(intent.targets.flatMap(t => t.questionIds))],
    originalQuestionIds: firstConsumers?.phase === "identity-consumers" ? firstConsumers.originalQuestionIds : null,
    priorUsage: intent.priorUsage, shards, consumerRevalidation: consumerRevalidationStatus(records, revalidations),
    verification: "ledger-snapshot-only" as const,
    executionAuthority: false as const, parentResumeAllowed: false as const, certificationGranted: false as const,
  };
}

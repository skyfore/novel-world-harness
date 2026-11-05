import { contentHash } from "../world/canonical.js";
import { identityConsumersReviewable, identityRequirementsReady } from "./identity-requirements.js";
import { validateConsumerRepairHistory } from "./identity-consumer-repair-model.js";
import type { LedgerRecord } from "./requirement-ledger.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import type { UpstreamRepairPlan } from "./upstream-repair-plan.js";
import { consumerRevalidationId, validateConsumerRevalidationHistory } from "./identity-consumer-revalidation-model.js";

/** Bind an existing plan to its original independently reviewed definition.
 * This neither evaluates current consumers nor grants repair/activation authority. */
export function identityRequirementDefinition(journal: LedgerRecord[], plan: UpstreamRepairPlan) {
  const authority = plan.identityRequirements;
  if (!authority) throw prerequisiteStop("Missing independent identity requirement authority");
  const records = journal.flatMap(r => r.payload.kind === "identity-requirements" && r.payload.record.intent.taskId === authority.taskId ? [r.payload.record] : []);
  const intent = records[0]?.intent, definition = records[0]?.output;
  let reviewed = identityRequirementsReady(records);
  if (authority.consumerRepair) {
    const repair = journal.flatMap(r => r.payload.kind === "identity-consumer-repair" && r.payload.record.intent.findingId === authority.consumerRepair!.findingId ? [r.payload.record] : []);
    validateConsumerRepairHistory(repair, records);
    reviewed = identityConsumersReviewable(records) && repair.length === 2
      && repair[0]!.output.phase === "consumer-repair-plan" && repair[0]!.output.operation.mode === "capability-gap"
      && repair[1]!.output.phase === "consumer-repair-check" && repair[1]!.output.verdict === "supported"
      && contentHash(repair.map(contentHash)) === contentHash(authority.consumerRepair.recordHashes);
  }
  if (authority.consumerRevalidation) {
    const a = authority.consumerRevalidation, reviews = journal.flatMap(r => r.payload.kind === "identity-consumer-revalidation"
      && consumerRevalidationId(r.payload.record.scope) === a.id ? [r.payload.record] : []);
    validateConsumerRevalidationHistory(reviews, records);
    reviewed &&= reviews.length === 2 && contentHash(reviews.map(contentHash)) === contentHash(a.recordHashes)
      && reviews[0]!.output.phase === "consumer-revalidation" && reviews[0]!.output.disposition === "repair-required"
      && reviews[1]!.output.phase === "consumer-revalidation-check" && reviews[1]!.output.verdict === "supported"
      && contentHash(reviews[0]!.scope) === a.scopeHash && reviews[0]!.scope.upstreamPlanHash === a.parentPlanHash;
  }
  if (!reviewed || definition?.phase !== "identity-definition" || !intent
    || intent.sourceId !== plan.sourceScope.sourceId || intent.sourceHash !== plan.sourceScope.sourceSha256
    || contentHash(intent) !== authority.intentHash || contentHash(records.map(contentHash)) !== contentHash(authority.recordHashes)
    || contentHash({ intentHash: contentHash(intent), definition }) !== plan.requirementSetHash
    || contentHash(plan.requirementIds.slice().sort()) !== contentHash(definition.requirements.map(r => r.id).sort()))
    throw prerequisiteStop("Identity requirement lost its original source, independent definition or complete consumer review");
  return definition;
}

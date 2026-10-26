import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { identityRequirementDirectory, sameIdentitySet, type IdentityRecord } from "./identity-requirements.js";
import { modelTextSelectorSchema } from "./text-anchors.js";
import { prerequisiteEvidenceSchema, prerequisiteStop } from "./role-source-prerequisites.js";
import { initialWorldRevisionFields } from "./initial-world-repair.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().trim().min(1).max(6000);
const evidence = z.array(modelTextSelectorSchema).min(1).max(24);
/** Exact compiler discovery spellings for the same entity ID, never aliases. */
export const consumerEntityRepairId = (ref: string) => /^entity[:/](.+)$/.exec(ref)?.[1];
export const consumerEntityScopeError = "Source-local scope changed the original accepted entity; no guessed actor or expanded repair";
export const consumerCompilerCorrectionSchema = z.object({ policy: z.literal("source-local-referent/v1"),
  predecessorId: hash, predecessorScopeHash: hash, predecessorRecordHashes: z.tuple([hash, hash]), contractHash: hash,
}).strict();
/** A changed, committed dependency is the reason to revalidate. This is never
 * another invocation of the old consumer review or a replacement definition. */
export const consumerRevalidationScopeSchema = z.object({
  version: z.literal(1), sourceId: text, sourceHash: hash, taskId: hash, identityIntentHash: hash,
  inventoryHash: hash, definitionHash: hash, requirementIds: z.array(text).min(1),
  ref: text, originalRevisionHash: hash, currentRevisionHash: hash,
  upstreamPlanHash: hash, receiptFingerprint: hash, acceptanceHash: hash,
  parentStateHash: hash, originalBudgetHash: hash, authorizationRef: text,
  priorUsage: z.object({ modelCalls: z.number().int().nonnegative(), totalPayloadBytes: z.number().int().nonnegative() }).strict(),
  priorBudgetFiles: z.array(z.object({ path: text, hash }).strict()).min(1),
  requirementPrefix: z.object({ length: z.number().int().positive(), head: hash }).strict(),
  compilerCorrection: consumerCompilerCorrectionSchema.optional(),
}).strict();
export type ConsumerRevalidationScope = z.infer<typeof consumerRevalidationScopeSchema>;
export const consumerRevalidationId = (scope: Pick<ConsumerRevalidationScope, "taskId" | "ref" | "receiptFingerprint" | "compilerCorrection">) => contentHash({ taskId: scope.taskId, ref: scope.ref, receiptFingerprint: scope.receiptFingerprint,
  ...(scope.compilerCorrection ? { compilerCorrection: { policy: scope.compilerCorrection.policy, predecessorId: scope.compilerCorrection.predecessorId } } : {}) });
export const consumerRevalidationDirectory = (root: string, scope: ConsumerRevalidationScope) =>
  path.join(identityRequirementDirectory(root, scope.sourceId, scope.taskId), "consumer-revalidation", consumerRevalidationId(scope));
const common = { scopeHash: hash, requirementIds: z.array(text).min(1), evidence };
export const consumerRevalidationProposalSchema = z.object({ ...common, phase: z.literal("consumer-revalidation"),
  ref: text, currentRevisionHash: hash, disposition: z.enum(["unaffected", "revalidated", "repair-required", "blocked"]), rationale: text,
  requirements: z.array(z.object({ id: text, verdict: z.enum(["supported", "blocked"]), rationale: text }).strict()).min(1),
  initialWorldRepair: z.object({ pointers: z.array(z.string()).min(1),
    readableRefs: z.array(z.object({ kind: text, id: text, revisionHash: hash }).strict()).min(1).max(256),
    segmentIds: z.array(text).min(1).max(128), requiredAction: text,
  }).strict().nullable(),
  entityRepair: z.object({ ref: text, revisionHash: hash, pointers: z.tuple([z.literal("/identityConsumption")]), mode: z.literal("source-local"),
    readableRefs: z.array(z.object({ kind: text, id: text, revisionHash: hash }).strict()).min(1).max(256),
    segmentIds: z.array(text).min(1).max(128), requiredAction: text,
  }).strict().nullable().optional(),
  retainedQuestionIds: z.array(hash).min(1), parentResumeAllowed: z.literal(false),
}).strict();
export const consumerRevalidationCheckSchema = z.object({ ...common, phase: z.literal("consumer-revalidation-check"),
  proposalHash: hash, verdict: z.enum(["supported", "blocked"]), rationale: text,
}).strict();
export const consumerRevalidationOutputSchema = z.discriminatedUnion("phase", [consumerRevalidationProposalSchema, consumerRevalidationCheckSchema]);
export const consumerRevalidationRecordSchema = z.object({ scope: consumerRevalidationScopeSchema, inputHash: hash,
  output: consumerRevalidationOutputSchema, predecessorRecordHash: hash.nullable(),
  sessionId: text, traceRunId: text, sessionCheckpointHash: hash.optional(), refRecoveryHash: hash.optional(),
  continuationHash: hash.optional(),
  budgetAmendmentHash: hash.optional(),
  evidence: z.array(prerequisiteEvidenceSchema).min(1).max(24),
}).strict().refine(r => Boolean(r.sessionCheckpointHash) !== Boolean(r.refRecoveryHash), "Exactly one actual submission checkpoint or explicit rejected-ref recovery proof is required");
export type ConsumerRevalidationRecord = z.infer<typeof consumerRevalidationRecordSchema>;

export function validateConsumerRevalidationHistory(records: ConsumerRevalidationRecord[], original: IdentityRecord[]) {
  if (!records.length) return;
  const scope = records[0]!.scope, definition = original[0]?.output, intent = original[0]?.intent;
  if (records.length > 2 || definition?.phase !== "identity-definition" || !intent
    || scope.sourceId !== intent.sourceId || scope.sourceHash !== intent.sourceHash || scope.taskId !== intent.taskId
    || scope.identityIntentHash !== contentHash(intent) || scope.definitionHash !== contentHash(definition)
    || scope.inventoryHash !== intent.inventoryHash || scope.parentStateHash !== intent.parentStateHash
    || scope.originalBudgetHash !== intent.originalBudgetHash
    || !sameIdentitySet(scope.requirementIds, definition.requirements.map(r => r.id))
    || !intent.consumerShards.some(s => s.refs.includes(scope.ref))) throw prerequisiteStop("Consumer revalidation changed the original task, definition, inventory or budget; stop without a replacement scope");
  for (const [i, record] of records.entries()) {
    consumerRevalidationRecordSchema.parse(record);
    if (record.budgetAmendmentHash && !record.continuationHash) throw prerequisiteStop("Call amendment is detached from its original continuation; no registration or retry");
    if (record.refRecoveryHash && (!record.continuationHash || !scope.compilerCorrection || record.output.phase !== "consumer-revalidation"))
      throw prerequisiteStop("Rejected-ref recovery belongs only to the original compiler-correction proposal; no independent-check recovery or new segment");
    if (contentHash(record.scope) !== contentHash(scope) || record.output.scopeHash !== contentHash(scope)
      || !sameIdentitySet(record.output.requirementIds, scope.requirementIds)
      || record.output.phase !== (i ? "consumer-revalidation-check" : "consumer-revalidation")
      || record.predecessorRecordHash !== (i ? contentHash(records[i - 1]) : null)
      || [...original, ...records.slice(0, i)].some(r => r.sessionId === record.sessionId || r.traceRunId === record.traceRunId))
      throw prerequisiteStop("Consumer revalidation lost its exact phase, denominator or independent session; no retry");
    const output = record.output;
    if (output.phase === "consumer-revalidation-check") {
      if (output.proposalHash !== contentHash(records[0]!.output)) throw prerequisiteStop("Independent consumer revalidation checked another proposal");
    } else {
      if (output.ref !== scope.ref || output.currentRevisionHash !== scope.currentRevisionHash
        || !sameIdentitySet(output.requirements.map(r => r.id), scope.requirementIds)) throw prerequisiteStop("Consumer revalidation omitted its exact target or original requirements");
      const repair = output.initialWorldRepair;
      if (output.entityRepair && (!scope.compilerCorrection || output.disposition !== "repair-required"
        || !consumerEntityRepairId(output.entityRepair.ref) || scope.ref !== `initial/${scope.sourceId}`
        || !repair || new Set(output.entityRepair.segmentIds).size !== output.entityRepair.segmentIds.length
        || new Set(output.entityRepair.readableRefs.map(r => `${r.kind}:${r.id}`)).size !== output.entityRepair.readableRefs.length))
        throw prerequisiteStop("Source-local entity revision requires the exact compiler correction and original initial-world repair; no expanded identity scope");
      if (repair && (scope.ref !== `initial/${scope.sourceId}` || output.disposition !== "repair-required"
        || new Set(repair.pointers).size !== repair.pointers.length
        || new Set(repair.segmentIds).size !== repair.segmentIds.length
        || new Set(repair.readableRefs.map(r => `${r.kind}:${r.id}`)).size !== repair.readableRefs.length
        || repair.pointers.some(p => !(initialWorldRevisionFields as readonly string[]).includes(p.slice(1)) || !p.startsWith("/"))))
        throw prerequisiteStop("Consumer revalidation proposed an unsupported initial-world write; preserve the capability gap, no guessed operation");
      if (["revalidated", "unaffected"].includes(output.disposition) && output.requirements.some(r => r.verdict !== "supported"))
        throw prerequisiteStop("Blocked original requirements cannot be reported as revalidated");
    }
  }
}

export function validateConsumerCorrectionLineage(scope: ConsumerRevalidationScope, all: ConsumerRevalidationRecord[]) {
  const correction = scope.compilerCorrection;
  if (!correction) return;
  const prior = all.filter(r => consumerRevalidationId(r.scope) === correction.predecessorId);
  const first = prior[0], check = prior[1];
  if (prior.length !== 2 || !first || first.scope.compilerCorrection || first.output.phase !== "consumer-revalidation"
    || first.output.disposition !== "blocked" || check?.output.phase !== "consumer-revalidation-check" || check.output.verdict !== "supported"
    || contentHash(prior.map(contentHash)) !== contentHash(correction.predecessorRecordHashes)
    || contentHash(first.scope) !== correction.predecessorScopeHash
    || ["taskId", "sourceId", "sourceHash", "ref", "receiptFingerprint", "inventoryHash", "definitionHash", "identityIntentHash", "originalBudgetHash", "parentStateHash", "originalRevisionHash", "currentRevisionHash", "upstreamPlanHash", "acceptanceHash"].some(key =>
      first.scope[key as keyof ConsumerRevalidationScope] !== scope[key as keyof ConsumerRevalidationScope]))
    throw prerequisiteStop("Compiler correction lost its exact independently blocked predecessor or original scope; no new stage, requirement or budget reset");
}

import path from "node:path";
import { z } from "zod";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { contentHash } from "../world/canonical.js";
import { modelTextSelectorSchema } from "./text-anchors.js";
import { prerequisiteEvidenceSchema, prerequisiteStop } from "./role-source-prerequisites.js";
import { identityResolutionSchema } from "./entity-resolution.js";
import type { SemanticScopeRecord } from "./role-semantic-scope.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().trim().min(1).max(6000);
const evidence = z.array(modelTextSelectorSchema).min(1).max(24);
export const identityRequirementPhases = ["identity-definition", "identity-definition-check", "identity-consumers", "identity-consumers-check"] as const;
export type IdentityRequirementPhase = typeof identityRequirementPhases[number];
export const IDENTITY_CONSUMER_SHARD_SIZE = 48;
export const IDENTITY_REQUIREMENT_LIMITS = Object.freeze({ maxModelCalls: 24, maxRequestBytes: 512_000, maxTotalPayloadBytes: 12_288_000 });
export const identityRequirementDirectory = (root: string, sourceId: string, taskId: string) => path.join(workspaceStateDir(root), "compile-loops", sourceId, "prerequisites", taskId, "identity-requirements");
export const identityRequirementId = (taskId: string, slot: number) => `ir-${taskId.slice(0, 32)}-${slot}`;
export const identitySemanticHash = (raw: unknown) => { const { derivation: _, ...body } = identityResolutionSchema.parse(raw); return contentHash(body); };
export const identityIntentSchema = z.object({
  version: z.literal(1), policy: z.literal("independent-identity-requirements/v1"), taskId: hash, revisionHash: hash,
  sourceId: text, sourceHash: hash, parentStateHash: hash, originalPlanHash: hash, originalBudgetHash: hash,
  authorizationRef: text, semanticRecordHashes: z.array(hash).length(2), retainedConditionsHash: hash,
  catalogHash: hash, inventoryHash: hash, requiredSourceSegmentIds: z.array(text).min(1),
  consumerShards: z.array(z.object({ index: z.number().int().nonnegative(), refs: z.array(text).min(1).max(48) }).strict()).min(1).max(64),
  targets: z.array(z.object({ slot: z.number().int().positive(), requirementId: text, mentionId: text,
    mentionHash: hash, predecessor: z.object({ id: text, hash }).strict().nullable(), questionIds: z.array(hash).min(1),
  }).strict()).length(3),
  requirementPrefix: z.object({ length: z.number().int().positive(), head: hash }).strict(),
  upstreamPrefix: z.object({ length: z.number().int().positive(), head: hash }).strict(),
  // Actual old usage, including failed calls, pinned before any newly authorized work.
  priorUsage: z.object({ modelCalls: z.number().int().positive(), totalPayloadBytes: z.number().int().nonnegative(), budgetFilesHash: hash }).strict(),
}).strict();
export type IdentityIntent = z.infer<typeof identityIntentSchema>;
const common = { intentHash: hash, retainedConditionsHash: hash };
export const identityDefinitionSchema = z.object({ ...common, phase: z.literal("identity-definition"),
  requirements: z.array(z.object({ id: text, mentionId: text, questionIds: z.array(hash).min(1),
    requirement: text, acceptanceCriteria: z.array(text).min(1).max(12),
    // The new independent requirement may conclude that the frozen repair is unsuitable.
    // These are requirements for uncertainty representation, never an identity assertion.
    disposition: z.enum(["uncertainty-preservation", "evidence-gap", "unsupported-type"]),
    requiredStatus: z.enum(["unresolved", "ambiguous"]).nullable(),
    missingCondition: z.string().max(6000), evidence,
  }).strict()).length(3),
}).strict();
const judgment = z.object({ id: text, verdict: z.enum(["supported", "blocked"]), rationale: text, evidence }).strict();
// A definition can preserve an unresolved original question while defining a
// valid, finite uncertainty representation. Only Pi may classify that boundary
// against the frozen repair payload, and a fresh consumer check must agree.
const definitionGap = z.object({ conditionHash: hash,
  disposition: z.enum(["retained-boundary", "repair-prerequisite", "unknown"]),
  rationale: text, evidence }).strict();
const checkedDefinitionGap = definitionGap.extend({ verdict: z.enum(["supported", "blocked"]) }).strict();
export const identityDefinitionCheckSchema = z.object({ ...common, phase: z.literal("identity-definition-check"), proposalHash: hash,
  judgments: z.array(judgment).length(3) }).strict();
export const identityConsumerSchema = z.object({ ...common, phase: z.literal("identity-consumers"), shard: z.number().int().nonnegative(), definitionHash: hash, inventoryHash: hash,
  bindings: z.array(z.object({ requirementId: text, slot: z.number().int().positive(), payloadHash: hash,
    dependencyRefs: z.array(text).min(1).max(128), verdict: z.enum(["supported", "blocked"]), rationale: text,
    missingCondition: z.string().max(6000), evidence,
    definitionGap: definitionGap.nullable().optional() }).strict()).length(3),
  consumers: z.array(z.object({ ref: text, revisionHash: hash,
    disposition: z.enum(["unaffected", "preserve-blocked", "revalidate-required", "additional-repair-required", "unknown"]),
    rationale: text, requiredAction: text }).strict()).max(4096),
  candidateIds: z.array(text).min(1), sourcePages: z.array(z.number().int().nonnegative()),
  originalQuestionIds: z.array(hash).min(1), activationConditions: z.array(text).min(1).max(32),
  parentResumeAllowed: z.literal(false), renewConsumedGrant: z.literal(false), evidence,
}).strict();
export const identityConsumerCheckSchema = z.object({ ...common, phase: z.literal("identity-consumers-check"), shard: z.number().int().nonnegative(), proposalHash: hash, inventoryHash: hash,
  judgments: z.array(judgment.extend({ definitionGap: checkedDefinitionGap.nullable().optional() }).strict()).length(3),
  consumers: z.array(z.object({ ref: text, verdict: z.enum(["supported", "blocked"]), rationale: text }).strict()).max(4096),
  denominatorVerdict: z.enum(["supported", "blocked"]), denominatorRationale: text,
}).strict();
export const identityOutputSchema = z.discriminatedUnion("phase", [identityDefinitionSchema, identityDefinitionCheckSchema, identityConsumerSchema, identityConsumerCheckSchema]);
export type IdentityOutput = z.infer<typeof identityOutputSchema>;
export const identityRecordSchema = z.object({ intent: identityIntentSchema, stage: text, phase: z.enum(identityRequirementPhases), inputHash: hash,
  output: identityOutputSchema, evidence: z.array(prerequisiteEvidenceSchema).min(1).max(256),
  traceRunId: text, sessionId: text, provider: z.literal("openai-codex"), model: z.literal("gpt-6.1-sol"), subscription: z.literal(true),
  predecessorRecordHash: hash.nullable(),
}).strict();
export type IdentityRecord = z.infer<typeof identityRecordSchema>;
export type IdentityInventory = {
  graphHash: string; roots: string[]; closureIssues: unknown[];
  consumers: { ref: string; revisionHash: string; payload: unknown; reason: "typed-consumer" | "source-review-coverage" | "denominator"; dependencies: unknown[] }[];
  sourcePages: number[]; candidateIds: string[]; originalQuestionIds: string[];
};
export const sameIdentitySet = (a: readonly unknown[], b: readonly unknown[]) => new Set(a).size === a.length && contentHash([...a].sort()) === contentHash([...b].sort());
export function identitySelectors(o: IdentityOutput) {
  return o.phase === "identity-definition" ? o.requirements.flatMap(r => r.evidence)
    : o.phase === "identity-consumers" ? [...o.bindings.flatMap(b => [...b.evidence, ...(b.definitionGap?.evidence ?? [])]), ...o.evidence]
      : o.phase === "identity-consumers-check" ? o.judgments.flatMap(j => [...j.evidence, ...(j.definitionGap?.evidence ?? [])])
        : o.judgments.flatMap(j => j.evidence);
}
/** Exact retained text is supplied for copying, never classified by host heuristics. */
export function identityDefinitionGaps(output: IdentityOutput) {
  return output.phase === "identity-definition" ? output.requirements.filter(r => r.missingCondition.trim()).map(r => ({
    requirementId: r.id, questionIds: r.questionIds, condition: r.missingCondition, conditionHash: contentHash(r.missingCondition),
  })) : [];
}
export function validateIdentityHistory(records: IdentityRecord[]) {
  const stages = records.length ? identityStages(records[0]!.intent) : [];
  if (records.length > stages.length) throw prerequisiteStop("Independent identity phases already consumed");
  const sessions = new Set<string>(), traces = new Set<string>();
  for (const [i, r] of records.entries()) {
    identityRecordSchema.parse(r);
    if (r.phase !== stages[i]?.phase || r.stage !== stages[i]?.stage || ("shard" in r.output && r.output.shard !== stages[i]?.shard) || r.output.phase !== r.phase || contentHash(r.intent) !== contentHash(records[0]!.intent)
      || r.output.intentHash !== contentHash(r.intent) || r.output.retainedConditionsHash !== r.intent.retainedConditionsHash
      || r.predecessorRecordHash !== (i ? contentHash(records[i - 1]) : null) || sessions.has(r.sessionId) || traces.has(r.traceRunId)) throw prerequisiteStop("Identity phases changed intent, conditions, order or independent session");
    sessions.add(r.sessionId); traces.add(r.traceRunId);
    const p = records[i - 1]?.output;
    if ("proposalHash" in r.output && (!p || r.output.proposalHash !== contentHash(p))) throw prerequisiteStop("Independent identity check changed its actual proposal");
    if ("judgments" in r.output && !sameIdentitySet(r.output.judgments.map(j => j.id), r.intent.targets.map(t => t.requirementId))) throw prerequisiteStop("Independent check lost a requirement");
  }
  const p = records[0]?.output;
  if (p?.phase === "identity-definition") {
    if (!sameIdentitySet(p.requirements.map(r => r.id), records[0]!.intent.targets.map(t => t.requirementId))) throw prerequisiteStop("Independent identity definition changed its denominator");
    for (const r of p.requirements) {
      const t = records[0]!.intent.targets.find(t => t.requirementId === r.id)!;
      if (r.mentionId !== t.mentionId || !sameIdentitySet(r.questionIds, t.questionIds)
        || (r.disposition === "uncertainty-preservation" ? !r.requiredStatus : !r.missingCondition.trim())) throw prerequisiteStop("Independent requirement lacks its exact target or explicit gap");
    }
  }
  for (let i = 2; i < records.length; i += 2) {
    const c = records[i]?.output, check = records[i + 1]?.output;
    if (c?.phase === "identity-consumers" && (c.definitionHash !== contentHash(p) || c.inventoryHash !== records[0]!.intent.inventoryHash)) throw prerequisiteStop("Consumer binding changed independent definition or inventory");
    if (c?.phase === "identity-consumers" && check?.phase === "identity-consumers-check" && (check.inventoryHash !== c.inventoryHash
      || !sameIdentitySet(check.consumers.map(c => c.ref), c.consumers.map(c => c.ref)))) throw prerequisiteStop("Independent consumer check omitted an affected consumer");
    if (c?.phase === "identity-consumers" && p?.phase === "identity-definition") {
      for (const b of c.bindings) {
        const gap = identityDefinitionGaps(p).find(g => g.requirementId === b.requirementId);
        if (b.definitionGap && b.definitionGap.conditionHash !== gap?.conditionHash) throw prerequisiteStop("Consumer gap classification changed the exact retained condition");
        if (check?.phase === "identity-consumers-check") {
          const j = check.judgments.find(j => j.id === b.requirementId);
          if (j?.definitionGap && (!b.definitionGap || j.definitionGap.conditionHash !== b.definitionGap.conditionHash
            || j.definitionGap.disposition !== b.definitionGap.disposition)) throw prerequisiteStop("Independent gap check changed the proposed condition or disposition");
        }
      }
    }
  }
}
export function validateIdentityOutput(intent: IdentityIntent, records: IdentityRecord[], inventory: IdentityInventory, semantic: SemanticScopeRecord[]) {
  validateIdentityHistory(records);
  if (intent.consumerShards.some((s, i) => s.index !== i) || !sameIdentitySet(intent.consumerShards.flatMap(s => s.refs), inventory.consumers.map(c => c.ref))) throw prerequisiteStop("Consumer shards do not partition the complete inventory exactly once");
  if (contentHash(inventory) !== intent.inventoryHash || contentHash(semantic.map(contentHash)) !== contentHash(intent.semanticRecordHashes)) throw prerequisiteStop("Identity dependencies changed");
  const old = semantic[0]?.output;
  if (old?.phase !== "semantic-scope-plan") throw prerequisiteStop("Original frozen operation proposal missing");
  for (const record of records) {
    const c = record.output;
    if (c.phase !== "identity-consumers") continue;
    if (!sameIdentitySet(c.bindings.map(b => b.requirementId), intent.targets.map(t => t.requirementId))
      || !sameIdentitySet(c.consumers.map(c => c.ref), (intent.consumerShards[c.shard]?.refs ?? []))
      || !sameIdentitySet(c.candidateIds, inventory.candidateIds) || !sameIdentitySet(c.sourcePages, inventory.sourcePages)
      || !sameIdentitySet(c.originalQuestionIds, inventory.originalQuestionIds)) throw prerequisiteStop("Consumer review omitted an exact dependency, candidate, source page or original question");
    for (const b of c.bindings) {
      const target = intent.targets.find(t => t.requirementId === b.requirementId)!, op = old.operations.find(o => o.slot === b.slot);
      if (!op || b.slot !== target.slot || b.payloadHash !== contentHash(JSON.parse(op.payloadJson))
        || !sameIdentitySet(b.dependencyRefs, op.readableRefs.map(r => `${r.kind}:${r.id}`))) throw prerequisiteStop("Identity binding changed its exact payload or directed typed dependencies");
    }
    for (const c0 of c.consumers) if (inventory.consumers.find(x => x.ref === c0.ref)?.revisionHash !== c0.revisionHash) throw prerequisiteStop("Consumer revision is stale");
  }
}
export function identityStages(intent: IdentityIntent): { stage: string; phase: IdentityRequirementPhase; shard?: number }[] {
  return [{ stage: "identity-definition", phase: "identity-definition" }, { stage: "identity-definition-check", phase: "identity-definition-check" },
    ...intent.consumerShards.flatMap(s => [{ stage: `identity-consumers-${s.index}`, phase: "identity-consumers" as const, shard: s.index },
      { stage: `identity-consumers-check-${s.index}`, phase: "identity-consumers-check" as const, shard: s.index }])];
}
export function identityRequirementsReady(records: IdentityRecord[]) {
  if (!records.length) return false;
  validateIdentityHistory(records);
  return records.length === identityStages(records[0]!.intent).length && identityConsumersReviewable(records)
    && records.filter(r => r.phase === "identity-consumers-check").every(r => identityConsumerShardReady(records, r.stage))
    && records.slice(2).every(r => r.output.phase === "identity-consumers"
      ? r.output.bindings.every(b => b.verdict === "supported" && !b.missingCondition.trim()) && r.output.consumers.every(c => !["unknown", "additional-repair-required"].includes(c.disposition))
      : r.output.phase === "identity-consumers-check" && r.output.judgments.every(j => j.verdict === "supported") && r.output.consumers.every(c => c.verdict === "supported") && r.output.denominatorVerdict === "supported");
}

/** Read-only review eligibility is deliberately weaker than repair authority. */
export function identityConsumersReviewable(records: IdentityRecord[]) {
  validateIdentityHistory(records);
  const d = records[0]?.output, check = records[1]?.output;
  return d?.phase === "identity-definition" && check?.phase === "identity-definition-check"
    && d.requirements.every(r => r.disposition === "uncertainty-preservation" && r.requiredStatus !== null)
    && check.judgments.every(j => j.verdict === "supported");
}

/** Missing/unclassified/negative assessments never acquire implicit approval,
 * including legacy consumer records which have no typed gap assessment. */
export function identityConsumerShardReady(records: IdentityRecord[], checkStage: string) {
  validateIdentityHistory(records);
  const i = records.findIndex(r => r.stage === checkStage), c = records[i - 1]?.output, check = records[i]?.output;
  if (c?.phase !== "identity-consumers" || check?.phase !== "identity-consumers-check" || !identityConsumersReviewable(records)
    || c.bindings.some(b => b.verdict !== "supported" || b.missingCondition.trim())
    || c.consumers.some(c => ["unknown", "additional-repair-required"].includes(c.disposition))
    || check.judgments.some(j => j.verdict !== "supported") || check.consumers.some(c => c.verdict !== "supported") || check.denominatorVerdict !== "supported") return false;
  return identityDefinitionGaps(records[0]!.output).every(g => {
    const b = c.bindings.find(b => b.requirementId === g.requirementId)?.definitionGap;
    const j = check.judgments.find(j => j.id === g.requirementId)?.definitionGap;
    return b?.conditionHash === g.conditionHash && b.disposition === "retained-boundary"
      && j?.conditionHash === g.conditionHash && j.disposition === b.disposition && j.verdict === "supported";
  });
}

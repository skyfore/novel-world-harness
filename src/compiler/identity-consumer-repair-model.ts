import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { entitySchema } from "../world/model.js";
import { identityRequirementDirectory, IDENTITY_REQUIREMENT_LIMITS, type IdentityRecord } from "./identity-requirements.js";
import { prerequisiteEvidenceSchema, prerequisiteStop } from "./role-source-prerequisites.js";
import { modelTextSelectorSchema } from "./text-anchors.js";
import { upstreamRepairRevisionFields } from "./upstream-repair-plan.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().trim().min(1).max(6000);
export const consumerRepairIntentSchema = z.object({
  version: z.literal(1), policy: z.literal("identity-consumer-repair/v1"), sourceId: text, sourceHash: hash,
  taskId: hash, identityIntentHash: hash, findingId: hash, proposalRecordHash: hash, checkRecordHash: hash,
  ref: text, revisionHash: hash, definitionHash: hash, requirementIds: z.array(text).min(1),
  inventoryHash: hash, graphHash: hash, baselineManifestHash: hash, conditionHash: hash,
  requirementPrefix: z.object({ length: z.number().int().positive(), head: hash }).strict(),
  authorizationRef: text, originalBudgetHash: hash,
  priorUsage: z.object({ modelCalls: z.number().int().nonnegative(), totalPayloadBytes: z.number().int().nonnegative(), budgetFilesHash: hash }).strict(),
  retainedFiles: z.array(z.object({ path: text, hash }).strict()).min(1),
}).strict();
export type ConsumerRepairIntent = z.infer<typeof consumerRepairIntentSchema>;
const common = { intentHash: hash, requirementIds: z.array(text).min(1), evidence: z.array(modelTextSelectorSchema).min(1).max(24) };
export const consumerRepairPlanSchema = z.object({ ...common, phase: z.literal("consumer-repair-plan"),
  ref: text, baselineHash: hash,
  operation: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("revision"), kind: z.literal("entity"), pointers: z.array(text).min(1).max(12), payloadJson: z.string().min(2).max(100000), rationale: text }).strict(),
    z.object({ mode: z.literal("capability-gap"), requiredCapability: text, rationale: text }).strict(),
  ]),
  // This describes how to meet the RETAINED consumer action, never new requirements.
  consumerRevalidation: text, retainedBoundaries: text,
}).strict();
export const consumerRepairCheckSchema = z.object({ ...common, phase: z.literal("consumer-repair-check"), proposalHash: hash,
  verdict: z.enum(["supported", "blocked"]), rationale: text,
}).strict();
export const consumerRepairOutputSchema = z.discriminatedUnion("phase", [consumerRepairPlanSchema, consumerRepairCheckSchema]);
export const consumerRepairRecordSchema = z.object({ intent: consumerRepairIntentSchema, inputHash: hash,
  output: consumerRepairOutputSchema, predecessorRecordHash: hash.nullable(),
  sessionCheckpointHash: hash.optional(), traceRunId: text, sessionId: text, provider: z.literal("openai-codex"), model: z.literal("gpt-6.1-sol"), subscription: z.literal(true),
  evidence: z.array(prerequisiteEvidenceSchema).min(1).max(24),
}).strict();
export type ConsumerRepairRecord = z.infer<typeof consumerRepairRecordSchema>;
export const consumerRepairDirectory = (root: string, intent: Pick<ConsumerRepairIntent, "sourceId" | "taskId" | "findingId">) =>
  path.join(identityRequirementDirectory(root, intent.sourceId, intent.taskId), "consumer-repairs", intent.findingId);

/** Original failed budgets remain files, not executable recovery permits. Charge
 * each lineage's actual incremental usage once, including failed calls. */
export function inheritedConsumerRepairUsage(budgets: { path: string; hash: string; value: any }[], records: IdentityRecord[]) {
  const intent = records[0]!.intent, totals = { modelCalls: intent.priorUsage.modelCalls, totalPayloadBytes: intent.priorUsage.totalPayloadBytes };
  const stages = new Map<string, typeof budgets>();
  for (const b of budgets) {
    const v = b.value, u = v.state?.usage;
    if (v.intentHash !== contentHash(intent) || v.originalBudgetHash !== intent.originalBudgetHash
      || contentHash(v.limits) !== contentHash(IDENTITY_REQUIREMENT_LIMITS) || !u
      || [u.modelCalls, u.totalPayloadBytes, u.payloads, u.largestRequestBytes].some(n => !Number.isSafeInteger(n) || n < 0))
      throw prerequisiteStop("Original consumer budget scope is invalid; inspect the same task's retained budget files, no dispatch or reset");
    const group = stages.get(v.stage) ?? []; group.push(b); stages.set(v.stage, group);
  }
  for (const group of stages.values()) {
    let prior: any = null, remaining = [...group];
    while (remaining.length) {
      const next = remaining.filter(b => prior ? contentHash(b.value.inheritedUsage ?? null) === contentHash(prior) : !b.value.inheritedUsage);
      if (next.length !== 1) throw prerequisiteStop("Original consumer budget lineage is missing, forked or ambiguous; preserve it, no new execution");
      const b = next[0]!, usage = b.value.state.usage;
      for (const key of ["modelCalls", "totalPayloadBytes"] as const) {
        const delta = usage[key] - (prior?.[key] ?? 0);
        if (delta < 0) throw prerequisiteStop("Inherited consumer charge decreased; stop without changing the budget");
        totals[key] += delta;
      }
      prior = usage; remaining = remaining.filter(item => item !== b);
    }
  }
  return { ...totals, budgetFilesHash: contentHash(budgets.map(({ path, hash }) => ({ path, hash }))) };
}

export function validateConsumerRepairHistory(records: ConsumerRepairRecord[], identity: IdentityRecord[]) {
  if (!records.length) return;
  if (records.length > 2 || !identity.length) throw prerequisiteStop("Consumer repair planning is single-use under the original task");
  const intent = records[0]!.intent, original = identity[0]!, proposal = identity.find(r => contentHash(r) === intent.proposalRecordHash);
  const check = identity.find(r => contentHash(r) === intent.checkRecordHash);
  const index = proposal?.output.phase === "identity-consumers" ? proposal.output.consumers.findIndex(c => c.ref === intent.ref) : -1;
  const finding = proposal?.output.phase === "identity-consumers" ? proposal.output.consumers[index] : undefined;
  const definition = original.output;
  if (original.intent.taskId !== intent.taskId || original.intent.sourceId !== intent.sourceId || original.intent.sourceHash !== intent.sourceHash
    || contentHash(original.intent) !== intent.identityIntentHash || original.intent.inventoryHash !== intent.inventoryHash
    || original.intent.originalBudgetHash !== intent.originalBudgetHash || contentHash(definition) !== intent.definitionHash
    || definition.phase !== "identity-definition" || contentHash(definition.requirements.map(r => r.id)) !== contentHash(intent.requirementIds)
    || !finding || finding.disposition !== "additional-repair-required" || finding.revisionHash !== intent.revisionHash
    || contentHash(finding.requiredAction) !== intent.conditionHash
    || intent.findingId !== contentHash({ taskId: intent.taskId, recordHash: intent.proposalRecordHash, pointer: `/output/consumers/${index}` })
    || check?.output.phase !== "identity-consumers-check" || check.output.proposalHash !== contentHash(proposal!.output)
    || check.output.consumers.find(c => c.ref === intent.ref)?.verdict !== "supported")
    throw prerequisiteStop("Consumer repair lost the original finding or independently reviewed requirements; no replacement criteria or authority");
  for (const [i, r] of records.entries()) {
    consumerRepairRecordSchema.parse(r);
    if (contentHash(r.intent) !== contentHash(intent) || r.output.intentHash !== contentHash(intent)
      || contentHash(r.output.requirementIds) !== contentHash(intent.requirementIds)
      || r.output.phase !== (i ? "consumer-repair-check" : "consumer-repair-plan")
      || r.predecessorRecordHash !== (i ? contentHash(records[i - 1]) : null)
      || [...identity, ...records.slice(0, i)].some(p => p.sessionId === r.sessionId || p.traceRunId === r.traceRunId))
      throw prerequisiteStop("Consumer repair changed the original scope or reused an independent session; no dispatch");
    if (r.output.phase === "consumer-repair-check" && r.output.proposalHash !== contentHash(records[0]!.output)) throw prerequisiteStop("Consumer repair check changed its exact proposal");
    if (r.output.phase === "consumer-repair-plan") {
      if (r.output.ref !== intent.ref || r.output.baselineHash !== intent.revisionHash) throw prerequisiteStop("Consumer repair changed its selected entity baseline");
      if (r.output.operation.mode === "revision") {
        const op = r.output.operation, payload = entitySchema.parse(JSON.parse(op.payloadJson));
        if (`entity/${payload.id}` !== intent.ref || new Set(op.pointers).size !== op.pointers.length
          || op.pointers.some(p => !upstreamRepairRevisionFields("entity").map(f => `/${f}`).includes(p)))
          throw prerequisiteStop("Consumer repair uses an unsupported entity operation; retain a capability-gap instead of inventing a write");
      }
    }
  }
}

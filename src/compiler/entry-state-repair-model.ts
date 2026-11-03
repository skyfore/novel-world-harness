import path from "node:path";
import { z } from "zod";
import { lowerEntryState, entryStateEditSchema } from "./entry-state.js";
import { entryDeltaBindingContext, entryDeltaBindingEditSchema, lowerEntryDeltaBinding } from "./entry-delta-binding.js";
import { lowerEntryWording, entryWordingEditSchema } from "./entry-wording.js";
import { entryPresenceIntentSchema, validateEntryRepairParent, validateEntryRepairAuthority } from "./entry-presence-repair-model.js";
import { consumerReviewCheckSchema } from "./consumer-review-contract.js";
import { contentHash } from "../world/canonical.js";
import { canonicalEventSchema } from "../world/model.js";
import { modelTextSelectorSchema } from "./text-anchors.js";
import { prerequisiteEvidenceSchema, prerequisiteStop } from "./role-source-prerequisites.js";
import { identityRequirementDirectory } from "./identity-requirements.js";
import { consumerRevalidationId, type ConsumerRevalidationRecord } from "./identity-consumer-revalidation-model.js";

export const ENTRY_STATE_REPAIR = "entry-checkpoint-state/v1" as const;
export const ENTRY_WORDING_REPAIR = "entry-checkpoint-wording/v1" as const;
export const ENTRY_DELTA_BINDING_REPAIR = "entry-delta-binding/v1" as const;
export const entryRepairPolicySchema = z.enum([ENTRY_STATE_REPAIR, ENTRY_WORDING_REPAIR, ENTRY_DELTA_BINDING_REPAIR]);
export type EntryRepairPolicy = z.infer<typeof entryRepairPolicySchema>;
export const entryRepairFolder = (policy: EntryRepairPolicy) => policy === ENTRY_STATE_REPAIR ? "state-repair" : policy === ENTRY_WORDING_REPAIR ? "wording-repair" : "delta-binding-repair";
const hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().trim().min(1).max(6000);
export const entryStateIntentSchema = entryPresenceIntentSchema.extend({ policy: entryRepairPolicySchema,
  baselines: z.array(entryPresenceIntentSchema.shape.baselines.element.extend({ kind: z.enum(["canonical-event", "event-execution"]) })).min(1).max(2) });
export type EntryStateIntent = z.infer<typeof entryStateIntentSchema>;
export const entryStateRepairId = (s: Pick<EntryStateIntent, "policy" | "taskId" | "ref" | "parentReviewId">) => contentHash({ policy: s.policy, taskId: s.taskId, ref: s.ref, parentReviewId: s.parentReviewId });
export const entryStateRepairDirectory = (root: string, s: EntryStateIntent) => path.join(identityRequirementDirectory(root, s.sourceId, s.taskId),
  "consumer-revalidation", s.parentReviewId, entryRepairFolder(s.policy));
export const entryStateCriteria = [...consumerReviewCheckSchema.options, "unchanged-scope", "retained-obligations"] as const;
const commonOutput = { scopeHash: hash, evidence: z.array(modelTextSelectorSchema).min(1).max(8), retainedQuestionIds: z.array(hash).min(1),
  playable: z.literal(false), parentResumeAllowed: z.literal(false) };
export const entryStateProposalSchema = z.object({ ...commonOutput, phase: z.literal("entry-state-proposal"),
  disposition: z.enum(["repaired", "blocked"]), edit: entryStateEditSchema, rationale: text.max(1000) }).strict();
export const entryWordingProposalSchema = entryStateProposalSchema.extend({ edit: entryWordingEditSchema });
export const entryDeltaBindingProposalSchema = entryStateProposalSchema.extend({ edit: entryDeltaBindingEditSchema });
export const entryRepairProposalSchema = entryStateProposalSchema.extend({ edit: z.union([entryStateEditSchema, entryWordingEditSchema, entryDeltaBindingEditSchema]) });
export const entryProposalSchemaFor = (policy: EntryRepairPolicy) => policy === ENTRY_STATE_REPAIR ? entryStateProposalSchema : policy === ENTRY_WORDING_REPAIR ? entryWordingProposalSchema : entryDeltaBindingProposalSchema;
export const entryStateCheckSchema = z.object({ ...commonOutput, phase: z.literal("entry-state-check"), proposalHash: hash,
  verdict: z.enum(["supported", "blocked"]), rationale: text,
  requirements: z.array(z.object({ id: text, verdict: z.enum(["supported", "blocked"]), rationale: text }).strict()).min(1),
  criteria: z.array(z.object({ id: z.enum(entryStateCriteria), verdict: z.enum(["supported", "blocked"]), rationale: text }).strict()).length(entryStateCriteria.length) }).strict();
export const entryStateOutputSchema = z.discriminatedUnion("phase", [entryRepairProposalSchema, entryStateCheckSchema]);
export type EntryStateOutput = z.infer<typeof entryStateOutputSchema>;
const record = { intent: entryStateIntentSchema, predecessorRecordHash: hash.nullable() };
const proof = { inputHash: hash, sessionId: text, traceRunId: text, sessionCheckpointHash: hash, evidence: z.array(prerequisiteEvidenceSchema).min(1).max(80) };
export const entryStateArtifactSchema = z.object({ kind: z.enum(["canonical-event", "event-execution"]), id: text, proposalId: text,
  beforeHash: hash, afterHash: hash, envelopeHash: hash }).strict();
export const entryStateRecordSchema = z.discriminatedUnion("phase", [
  z.object({ ...record, ...proof, phase: z.literal("entry-state-proposal"), output: entryRepairProposalSchema }).strict(),
  z.object({ ...record, ...proof, phase: z.literal("entry-state-check"), output: entryStateCheckSchema }).strict(),
  z.object({ ...record, phase: z.literal("entry-state-commit"), artifacts: z.array(entryStateArtifactSchema).min(1) }).strict(),
  z.object({ ...record, phase: z.literal("entry-state-applied"), artifacts: z.array(entryStateArtifactSchema).min(1),
    executableEntry: z.literal(false), obligationStatus: z.literal("revalidated"), resumeOtherConsumersAllowed: z.literal(true),
    parentResumeAllowed: z.literal(false), certificationGranted: z.literal(false) }).strict(),
]);
export type EntryStateRecord = z.infer<typeof entryStateRecordSchema>;
export const entryStateModelContract = { terminalTool: "submit_entry_state_repair", readTools: ["preview_entry_state_repair"], receipt: "retained" as const };
export const ENTRY_STATE_LIMITS = { maxModelCalls: 12, maxRequestBytes: 512000, maxTotalPayloadBytes: 12288000 } as const;
export const entryStateStop = (message: string) => prerequisiteStop(`${message}. Inspect requirements inspect-identity-repairs for the same source/task and copy summary.consumerRevalidation.reviews[].id and ref once. Preserve the exact entry repair intent, source, drafts, failures and charges; no guessed IDs, changed scope, fresh attempt or unchanged retry. Recover a sealed result without model generation only.`);

export function validateEntryStateIntent(s: EntryStateIntent, parents: ConsumerRevalidationRecord[]) {
  entryStateIntentSchema.parse(s);
  const parent = validateEntryRepairAuthority(s, parents, entryStateStop), contract = parent[0]!.scope.reviewContract!;
  let event;
  if (s.policy === ENTRY_DELTA_BINDING_REPAIR) {
    const binding = entryDeltaBindingContext(s); event = binding.event;
    if (contentHash(binding.binding.entryCheckpoint) !== parent[0]!.scope.currentRevisionHash
      || contentHash(contract.ownerRefs.map(r => [r.ref, r.revisionHash]).sort()) !== contentHash(s.baselines.map(b => [`${b.kind}:${b.id}`, b.revisionHash]).sort()))
      throw entryStateStop("Entry binding lost its exact reviewed overlay or owner revisions");
  } else {
    const b = s.baselines[0];
    if (s.baselines.length !== 1 || b?.kind !== "canonical-event") throw entryStateStop("State or wording repair requires exactly one owning canonical event");
    validateEntryRepairParent({ ...s, baselines: [{ ...b, kind: "canonical-event" }] }, parents, entryStateStop);
    event = canonicalEventSchema.parse(b.payload);
  }
  const target = contract.target;
  if (target.kind !== "character-entry" || target.actorId !== s.actorId || target.beforeEventId !== s.eventId || target.position !== "before-event"
    || contentHash(target.storyTime) !== contentHash(event.storyTime)
    || contentHash([...contract.requiredChecks].sort()) !== contentHash([...consumerReviewCheckSchema.options].sort()))
    throw entryStateStop("Entry state repair lost the original exact temporal cut or complete review contract");
  return parent;
}

export function validateEntryStateHistory(records: EntryStateRecord[], parents: ConsumerRevalidationRecord[]) {
  if (!records.length) return;
  if (records.length > 4) throw entryStateStop("State phases already consumed");
  const s = records[0]!.intent, parent = validateEntryStateIntent(s, parents);
  const phases = ["entry-state-proposal", "entry-state-check", "entry-state-commit", "entry-state-applied"];
  for (const [i, r] of records.entries()) {
    entryStateRecordSchema.parse(r);
    if (r.phase !== phases[i] || contentHash(r.intent) !== contentHash(s) || r.predecessorRecordHash !== (i ? contentHash(records[i - 1]) : null))
      throw entryStateStop("State repair changed its one-time phase or predecessor");
    if ("output" in r) {
      if (r.phase === "entry-state-proposal") entryProposalSchemaFor(s.policy).parse(r.output);
      if (r.output.scopeHash !== contentHash(s) || contentHash(r.output.retainedQuestionIds) !== contentHash(s.retainedQuestionIds)
        || [...parent, ...records.slice(0, i)].some(old => "sessionId" in old && (old.sessionId === r.sessionId || old.traceRunId === r.traceRunId)))
        throw entryStateStop("State review changed its original questions or independent session");
      if (r.phase === "entry-state-check" && (records[0]?.phase !== "entry-state-proposal"
        || r.output.proposalHash !== contentHash(records[0].output)
        || contentHash(r.output.criteria.map(v => v.id).sort()) !== contentHash([...entryStateCriteria].sort())
        || contentHash(r.output.requirements.map(v => v.id).sort()) !== contentHash([...s.requirementIds].sort())
        || r.output.verdict === "supported" && [...r.output.criteria, ...r.output.requirements].some(v => v.verdict !== "supported"))) throw entryStateStop("Independent entry state check omitted a criterion or changed the proposal");
    } else {
      if (records[0]?.phase !== "entry-state-proposal" || records[0].output.disposition !== "repaired"
        || records[1]?.phase !== "entry-state-check" || records[1].output.verdict !== "supported") throw entryStateStop("No independently supported state repair exists");
      if (contentHash(r.artifacts.map(a => [a.kind, a.id, a.beforeHash])) !== contentHash(entryStateWritableBaselines(s).map(b => [b.kind, b.id, b.revisionHash])))
        throw entryStateStop("State commit changed its exact artifact denominator");
      if (i === 3 && (records[2]?.phase !== "entry-state-commit" || contentHash(r.artifacts) !== contentHash(records[2].artifacts)))
        throw entryStateStop("Applied state receipt changed its frozen commit");
    }
  }
}

/** The identity adapter supplies authority; the domain transformation does not
 * depend on identity tasks, review lineage, provider or a particular novel. */
export function lowerEntryStateRepair(intent: EntryStateIntent, proposal: Extract<EntryStateRecord, { phase: "entry-state-proposal" }>) {
  if (proposal.output.disposition !== "repaired") throw entryStateStop("Blocked proposal grants no mutation");
  if (intent.policy === ENTRY_DELTA_BINDING_REPAIR) return lowerEntryDeltaBinding(intent, entryDeltaBindingEditSchema.parse(proposal.output.edit));
  return intent.policy === ENTRY_STATE_REPAIR ? lowerEntryState(intent, entryStateEditSchema.parse(proposal.output.edit))
    : lowerEntryWording(intent, entryWordingEditSchema.parse(proposal.output.edit));
}

export const entryStateWritableBaselines = (s: EntryStateIntent) => s.baselines.filter(b => s.policy !== ENTRY_DELTA_BINDING_REPAIR || b.kind === "event-execution");

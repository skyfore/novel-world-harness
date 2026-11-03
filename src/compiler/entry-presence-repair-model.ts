import path from "node:path";
import { z } from "zod";
import { lowerUnresolvedEntryPresence } from "./entry-presence.js";
import { contentHash } from "../world/canonical.js";
import { canonicalEventSchema, eventParticipationSchema, evidenceAssertionSchema } from "../world/model.js";
import { modelTextSelectorSchema } from "./text-anchors.js";
import { prerequisiteEvidenceSchema, prerequisiteStop } from "./role-source-prerequisites.js";
import { identityRequirementDirectory } from "./identity-requirements.js";
import { consumerRevalidationId, type ConsumerRevalidationRecord } from "./identity-consumer-revalidation-model.js";

export const ENTRY_PRESENCE_REPAIR = "entry-presence-uncertainty/v1" as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().trim().min(1).max(6000);
const usage = z.object({ modelCalls: z.number().int().nonnegative(), totalPayloadBytes: z.number().int().nonnegative() }).strict();
const baseline = z.object({ kind: z.enum(["canonical-event", "event-participation"]), id: text, revisionHash: hash,
  payload: z.unknown(), evidenceAssertions: z.array(evidenceAssertionSchema) }).strict();
export const entryPresenceIntentSchema = z.object({ version: z.literal(1), policy: z.literal(ENTRY_PRESENCE_REPAIR),
  sourceId: text, sourceHash: hash, taskId: hash, identityIntentHash: hash, originalBudgetHash: hash, ref: text, actorId: text, eventId: text,
  parentReviewId: hash, parentRecordHashes: z.tuple([hash, hash]), parentReceiptFingerprint: hash, upstreamPlanHash: hash,
  authorizationRef: text, createdAt: text, implementationHash: hash, contextHash: hash,
  requirementIds: z.array(text).min(1), retainedQuestionIds: z.array(hash).min(1), totalConsumers: z.number().int().positive(),
  requirementPrefix: z.object({ length: z.number().int().positive(), head: hash }).strict(),
  priorUsage: usage, priorBudgetFiles: z.array(z.object({ path: text, hash }).strict()).min(1), baselines: z.array(baseline).min(1),
}).strict();
export type EntryPresenceIntent = z.infer<typeof entryPresenceIntentSchema>;
export const entryPresenceRepairId = (s: Pick<EntryPresenceIntent, "taskId" | "ref" | "parentReviewId">) => contentHash({ policy: ENTRY_PRESENCE_REPAIR, taskId: s.taskId, ref: s.ref, parentReviewId: s.parentReviewId });
export const entryPresenceRepairDirectory = (root: string, s: EntryPresenceIntent) => path.join(identityRequirementDirectory(root, s.sourceId, s.taskId),
  "consumer-revalidation", s.parentReviewId, "presence-repair");
export const entryPresenceCriteria = ["source-fidelity", "uncertainty-preserved", "no-executable-state", "unchanged-scope", "retained-obligations"] as const;
const commonOutput = { scopeHash: hash, evidence: z.array(modelTextSelectorSchema).min(1).max(8), retainedQuestionIds: z.array(hash).min(1),
  playable: z.literal(false), parentResumeAllowed: z.literal(false) };
export const entryPresenceProposalSchema = z.object({ ...commonOutput, phase: z.literal("entry-presence-proposal"),
  disposition: z.enum(["uncertainty-preserved", "blocked"]), title: text.max(200), readerSummary: text.max(3000),
  readerSetup: text.max(1500), actorObservation: text.max(1000), rationale: text.max(1500) }).strict();
export const entryPresenceCheckSchema = z.object({ ...commonOutput, phase: z.literal("entry-presence-check"), proposalHash: hash,
  verdict: z.enum(["supported", "blocked"]), rationale: text,
  criteria: z.array(z.object({ id: z.enum(entryPresenceCriteria), verdict: z.enum(["supported", "blocked"]), rationale: text }).strict()).length(5) }).strict();
export const entryPresenceOutputSchema = z.discriminatedUnion("phase", [entryPresenceProposalSchema, entryPresenceCheckSchema]);
const record = { intent: entryPresenceIntentSchema, predecessorRecordHash: hash.nullable() };
const proof = { inputHash: hash, sessionId: text, traceRunId: text, sessionCheckpointHash: hash, evidence: z.array(prerequisiteEvidenceSchema).min(1).max(8) };
export const entryPresenceArtifactSchema = z.object({ kind: z.enum(["canonical-event", "event-participation"]), id: text, proposalId: text,
  beforeHash: hash, afterHash: hash, envelopeHash: hash }).strict();
export const entryPresenceRecordSchema = z.discriminatedUnion("phase", [
  z.object({ ...record, ...proof, phase: z.literal("entry-presence-proposal"), output: entryPresenceProposalSchema }).strict(),
  z.object({ ...record, ...proof, phase: z.literal("entry-presence-check"), output: entryPresenceCheckSchema }).strict(),
  z.object({ ...record, phase: z.literal("entry-presence-commit"), artifacts: z.array(entryPresenceArtifactSchema).min(1) }).strict(),
  z.object({ ...record, phase: z.literal("entry-presence-applied"), artifacts: z.array(entryPresenceArtifactSchema).min(1),
    executableEntry: z.literal(false), obligationStatus: z.literal("blocked"), resumeOtherConsumersAllowed: z.literal(true),
    parentResumeAllowed: z.literal(false), certificationGranted: z.literal(false) }).strict(),
]);
export type EntryPresenceRecord = z.infer<typeof entryPresenceRecordSchema>;
export const entryPresenceModelContract = { terminalTool: "submit_entry_presence_repair", readTools: ["preview_entry_presence_repair"], receipt: "retained" as const };
export const ENTRY_PRESENCE_LIMITS = { maxModelCalls: 12, maxRequestBytes: 512000, maxTotalPayloadBytes: 12288000 } as const;
export const entryPresenceStop = (message: string) => prerequisiteStop(`${message}. Inspect requirements inspect-identity-repairs for the same source/task and copy consumerRevalidation.reviews[].id and ref once. Preserve the exact presence-repair intent, source, drafts, failures and charges; no guessed IDs, changed scope, fresh attempt or unchanged retry. Recover a sealed result without model generation only.`);

export function validateEntryPresenceIntent(s: EntryPresenceIntent, parents: ConsumerRevalidationRecord[]) {
  entryPresenceIntentSchema.parse(s);
  return validateEntryRepairParent(s, parents, entryPresenceStop);
}

/** Common authority boundary for a versioned, narrowly typed entry repair. */
export function validateEntryRepairParent(s: Omit<EntryPresenceIntent, "policy">, parents: ConsumerRevalidationRecord[], stop: typeof entryPresenceStop) {
  const parent = parents.filter(r => consumerRevalidationId(r.scope) === s.parentReviewId);
  const p = parent[0], c = parent[1];
  if (parent.length !== 2 || p?.output.phase !== "consumer-revalidation" || p.output.disposition !== "blocked"
    || c?.output.phase !== "consumer-revalidation-check" || c.output.verdict !== "supported" || !p.scope.reviewContract
    || p.scope.reviewContract.target.kind !== "character-entry" || s.ref !== `entry/${s.actorId}/${s.eventId}`
    || p.scope.ref !== s.ref || s.sourceId !== p.scope.sourceId || s.sourceHash !== p.scope.sourceHash || s.taskId !== p.scope.taskId
    || s.identityIntentHash !== p.scope.identityIntentHash || s.originalBudgetHash !== p.scope.originalBudgetHash
    || s.parentReceiptFingerprint !== p.scope.receiptFingerprint || s.upstreamPlanHash !== p.scope.upstreamPlanHash
    || contentHash(parent.map(contentHash)) !== contentHash(s.parentRecordHashes)
    || contentHash(s.requirementIds) !== contentHash(p.scope.requirementIds)
    || contentHash(s.retainedQuestionIds) !== contentHash(p.output.retainedQuestionIds)) throw stop("Entry repair lost its exact supported negative review or original criteria");
  const events = s.baselines.filter(b => b.kind === "canonical-event");
  const event = events.length === 1 ? canonicalEventSchema.safeParse(events[0]!.payload) : null;
  if (!event?.success || events[0]!.id !== s.eventId || event.data.id !== s.eventId
    || contentHash(event.data.characterEntryCheckpoints?.find(e => e.actorId === s.actorId)) !== p.scope.currentRevisionHash
    || !p.scope.reviewContract.ownerRefs.some(r => r.ref === `canonical-event:${s.eventId}` && r.revisionHash === events[0]!.revisionHash)
    || p.scope.reviewContract.ownerRefs.some(r => r.ref.startsWith("event-execution:"))
    || s.baselines.some(b => contentHash(b.payload) !== b.revisionHash)
    || new Set(s.baselines.map(b => `${b.kind}:${b.id}`)).size !== s.baselines.length)
    throw stop("Entry baseline changed the exact reviewed event/entry or revision denominator");
  for (const b of s.baselines) if (b.kind === "event-participation") {
    const v = eventParticipationSchema.parse(b.payload);
    if (v.id !== b.id || v.entityId !== s.actorId || v.eventId !== s.eventId) throw stop("Participation escaped the reviewed actor/occurrence");
  }
  return parent;
}

export function validateEntryPresenceHistory(records: EntryPresenceRecord[], parents: ConsumerRevalidationRecord[]) {
  if (!records.length) return;
  if (records.length > 4) throw entryPresenceStop("Presence phases already consumed");
  const s = records[0]!.intent, parent = validateEntryPresenceIntent(s, parents);
  const phases = ["entry-presence-proposal", "entry-presence-check", "entry-presence-commit", "entry-presence-applied"];
  for (const [i, r] of records.entries()) {
    entryPresenceRecordSchema.parse(r);
    if (r.phase !== phases[i] || contentHash(r.intent) !== contentHash(s) || r.predecessorRecordHash !== (i ? contentHash(records[i - 1]) : null))
      throw entryPresenceStop("Presence repair changed its one-time phase or predecessor");
    if ("output" in r) {
      if (r.output.scopeHash !== contentHash(s) || contentHash(r.output.retainedQuestionIds) !== contentHash(s.retainedQuestionIds)
        || [...parent, ...records.slice(0, i)].some(old => "sessionId" in old && (old.sessionId === r.sessionId || old.traceRunId === r.traceRunId)))
        throw entryPresenceStop("Presence review changed its original questions or independent session");
      if (r.phase === "entry-presence-check" && (records[0]?.phase !== "entry-presence-proposal"
        || r.output.proposalHash !== contentHash(records[0].output)
        || contentHash(r.output.criteria.map(v => v.id).sort()) !== contentHash([...entryPresenceCriteria].sort())
        || r.output.verdict === "supported" && r.output.criteria.some(v => v.verdict !== "supported"))) throw entryPresenceStop("Independent presence check omitted a criterion or changed the proposal");
    } else {
      if (records[0]?.phase !== "entry-presence-proposal" || records[0].output.disposition !== "uncertainty-preserved"
        || records[1]?.phase !== "entry-presence-check" || records[1].output.verdict !== "supported") throw entryPresenceStop("No independently supported uncertainty repair exists");
      if (contentHash(r.artifacts.map(a => [a.kind, a.id, a.beforeHash])) !== contentHash(s.baselines.map(b => [b.kind, b.id, b.revisionHash])))
        throw entryPresenceStop("Presence commit changed its exact artifact denominator");
      if (i === 3 && (records[2]?.phase !== "entry-presence-commit" || contentHash(r.artifacts) !== contentHash(records[2].artifacts)))
        throw entryPresenceStop("Applied presence receipt changed its frozen commit");
    }
  }
}

/** The identity adapter supplies authority; the domain transformation does not
 * depend on identity tasks, review lineage, provider or a particular novel. */
export function lowerEntryPresenceRepair(intent: EntryPresenceIntent, proposal: Extract<EntryPresenceRecord, { phase: "entry-presence-proposal" }>) {
  if (proposal.output.disposition !== "uncertainty-preserved") throw entryPresenceStop("Blocked proposal grants no mutation");
  const evidence = proposal.evidence.map(({ anchor: a }) => ({ span: { sourceId: a.sourceId, startByte: a.startByte, endByte: a.endByte,
    startLine: a.startLine, endLine: a.endLine, quoteHash: a.exactHash }, strength: "explicit" as const }));
  return lowerUnresolvedEntryPresence(intent, proposal.output, evidence);
}

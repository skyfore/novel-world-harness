import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { canonicalEventSchema, eventParticipationSchema, idSchema, textAnchorSchema } from "../world/model.js";
import { predicateReferences, stateOperationReferences } from "../world/state-references.js";
import { DEFAULT_STATE_FIELDS } from "../world/state.js";
import { sourceAnnotationSchema } from "./annotations.js";
import { identityResolutionSchema } from "./entity-resolution.js";
import { eventResolutionSchema } from "./event-resolution.js";
import {
  sourcePatternObligationRequirementId,
  sourcePatternObligationRequirementSetHash,
  sourcePatternUpstreamAuthoritySchema,
} from "./proposal-obligations.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1);
export const upstreamRepairKindSchema = z.enum(["entity-mention", "event-mention", "quotation", "discourse-segment", "entity-resolution", "event-resolution", "canonical-event", "event-participation"]);
export type UpstreamRepairKind = z.infer<typeof upstreamRepairKindSchema>;
const fields: Record<UpstreamRepairKind, readonly string[]> = {
  "entity-mention": ["anchor", "surface", "form", "kindCandidates", "sceneId", "confidence", "interpretation"],
  "event-mention": ["triggerAnchor", "trigger", "extentAnchors", "eventTypeCandidates", "participantMentionIds", "sceneId", "discourseSegmentId", "salience", "confidence", "interpretation"],
  quotation: ["anchor", "mode", "speakerMentionId", "addresseeMentionIds", "cueAnchor", "sceneId", "attributionConfidence", "interpretation"],
  "discourse-segment": ["kind", "anchors", "viewpointMentionId", "confidence", "interpretation"],
  "entity-resolution": ["mentionId", "status", "entityId", "intendedEntityId", "candidates", "aliasType", "validStoryTime", "supersedesResolutionId", "rationale"],
  "event-resolution": ["eventMentionIds", "status", "canonicalEventId", "relation", "candidates", "supersedesResolutionIds", "rationale"],
  // Semantic upstream repair currently permits fresh exact slots only. A
  // revision policy needs separate field-level review and is intentionally not
  // implied by the creation capability.
  "canonical-event": [],
  "event-participation": [],
};
const refSchema = z.object({ kind: upstreamRepairKindSchema, id: idSchema }).strict();
export const upstreamRepairReadableRefSchema = z.object({ kind: z.enum([...upstreamRepairKindSchema.options, "entity", "canonical-event", "proposition", "attribution", "claim", "event-participation", "event-relation", "scene-occurrence", "event-frame", "spatial-relation", "action-schema", "event-execution", "action-constraint", "norm-template", "process-template", "world-rule", "character-goal", "character-model", "possibility", "initial-world", "source-segment", "evidence-assertion", "structural-discourse", "semantic-effect", "utterance-expression", "perception-observation", "acquisition"]), id: idSchema }).strict();
const key = (ref: { kind: string; id: string }) => `${ref.kind}:${ref.id}`;
const unique = <T>(values: T[]) => new Set(values).size === values.length;

/** Decode first: escaped slashes and lexical prefixes never confer pointer authority. */
export function repairPointerTokens(pointer: string): string[] {
  if (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer)) throw new Error("Invalid repair JSON Pointer");
  return pointer.slice(1).split("/").map(token => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}
const writeSchema = refSchema.extend({ pointers: z.array(text).min(1).max(32) }).strict().superRefine((write, ctx) => {
  if (!unique(write.pointers)) ctx.addIssue({ code: "custom", message: "Duplicate repair pointers" });
  for (const pointer of write.pointers) {
    try {
      const tokens = repairPointerTokens(pointer);
      // Arrays are authorized as complete named fields. Element/index permissions
      // would require a stable element identity contract and are not registered.
      if (tokens.length !== 1 || !fields[write.kind].includes(tokens[0]!)) throw new Error("Unregistered repair pointer");
    } catch { ctx.addIssue({ code: "custom", message: `Unregistered repair pointer ${pointer}` }); }
  }
});
const identitySchema = z.object({
  version: z.literal(1), planId: idSchema, batchId: idSchema,
  requirementSetHash: hash, requirementIds: z.array(text).min(1).max(128),
  proposalObligation: sourcePatternUpstreamAuthoritySchema.optional(),
  predecessorReceiptRefs: z.array(hash).max(128),
  sourceScope: z.object({ sourceId: idSchema, sourceSha256: hash, segmentIds: z.array(idSchema).min(1).max(128) }).strict(),
  baselineRefs: z.array(upstreamRepairReadableRefSchema.extend({ revisionHash: hash }).strict()).max(256),
  allowedWrites: z.array(writeSchema).max(128),
  // Host allocates one exact logical ID per dependency slot; no model-chosen IDs.
  allowedCreations: z.array(refSchema.extend({ maxCount: z.literal(1), dependencyOf: text }).strict()).max(128),
  resolutionAbsences: z.array(z.object({ kind: z.enum(["entity-resolution", "event-resolution"]), id: idSchema, mentionId: idSchema }).strict()).max(128).optional(),
  resolutionRevisions: z.array(z.object({ kind: z.enum(["entity-resolution", "event-resolution"]), id: idSchema,
    predecessorId: idSchema, mentionIds: z.array(idSchema).min(1).max(128) }).strict()).max(128).optional(),
  semanticEventCreations: z.array(z.object({
    requirementId: text,
    eventMentionId: idSchema,
    eventResolutionId: idSchema,
    canonicalEventId: idSchema,
    triggerAnchor: textAnchorSchema,
    extentAnchors: z.array(textAnchorSchema).min(1).max(32),
    participants: z.array(z.object({
      mentionId: idSchema,
      resolutionId: idSchema,
      entityId: idSchema,
      participationId: idSchema,
    }).strict()).min(1).max(64),
  }).strict()).max(32).optional(),
  readableRefs: z.array(upstreamRepairReadableRefSchema).max(256), citableEvidenceRefs: z.array(idSchema).min(1).max(128),
  dependencyEdges: z.array(z.object({ from: text, to: text, purpose: z.enum(["source-evidence", "identity", "quotation", "requirement"]) }).strict()).max(512),
  postconditionIds: z.array(text).min(1).max(128), authorizationRef: text, retryBudgetRef: idSchema,
}).strict();

/** A frozen host policy input, not by itself a persisted or executable authorization. */
export const upstreamRepairPlanSchema = identitySchema.extend({ planHash: hash }).strict().superRefine((plan, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  const { planHash, ...identity } = plan;
  if (contentHash(identity) !== planHash) fail("Repair plan hash mismatch");
  for (const values of [plan.requirementIds, plan.predecessorReceiptRefs, plan.sourceScope.segmentIds, plan.citableEvidenceRefs, plan.postconditionIds,
    plan.baselineRefs.map(key), plan.allowedWrites.map(key), plan.allowedCreations.map(key), plan.readableRefs.map(key)]) if (!unique(values)) fail("Duplicate repair plan member");
  if (!plan.allowedWrites.length && !plan.allowedCreations.length) fail("Repair plan has no bounded mutation");
  if (plan.proposalObligation) {
    const requirementId = sourcePatternObligationRequirementId(plan.proposalObligation);
    if (plan.sourceScope.sourceId !== plan.proposalObligation.sourceId
      || plan.batchId === plan.proposalObligation.batchId
      || plan.requirementSetHash !== sourcePatternObligationRequirementSetHash(plan.proposalObligation)
      || contentHash(plan.requirementIds) !== contentHash([requirementId])) fail("Proposal-obligation repair authority differs from its exact source, requirement or upstream batch scope");
    if (plan.allowedWrites.length || plan.resolutionAbsences?.length || plan.resolutionRevisions?.length
      || !plan.semanticEventCreations?.length) fail("Proposal-obligation repair may only create reviewed missing-event dependencies");
    if (plan.proposalObligation.originalSupportingEventIds.some(id => !plan.baselineRefs.some(ref => ref.kind === "canonical-event" && ref.id === id))) {
      fail("Proposal-obligation repair does not freeze every original supporting event");
    }
  }
  if (!unique((plan.resolutionAbsences ?? []).map(ref => `${ref.kind}:${ref.mentionId}`))) fail("Duplicate resolution absence guard");
  for (const ref of plan.resolutionAbsences ?? []) {
    if (!plan.allowedCreations.some(slot => slot.kind === ref.kind && slot.id === ref.id)
      || !plan.baselineRefs.some(base => base.kind === (ref.kind === "entity-resolution" ? "entity-mention" : "event-mention") && base.id === ref.mentionId)) fail("Resolution absence guard lacks its exact creation slot and frozen mention");
  }
  for (const ref of plan.resolutionRevisions ?? []) {
    if (ref.id === ref.predecessorId || !unique(ref.mentionIds)
      || !plan.allowedCreations.some(slot => key(slot) === key(ref))
      || !plan.baselineRefs.some(base => base.kind === ref.kind && base.id === ref.predecessorId)
      || ref.mentionIds.some(id => !plan.baselineRefs.some(base => base.kind === (ref.kind === "entity-resolution" ? "entity-mention" : "event-mention") && base.id === id))) fail("Resolution revision lacks frozen predecessor, mentions or fresh successor slot");
  }
  if (!unique((plan.resolutionRevisions ?? []).map(key)) || !unique((plan.resolutionRevisions ?? []).flatMap(ref => ref.mentionIds.map(id => `${ref.kind}:${id}`)))) fail("Duplicate resolution revision scope");
  const semanticSlots = new Set<string>();
  for (const event of plan.semanticEventCreations ?? []) {
    const slots = [
      `event-mention:${event.eventMentionId}`,
      `event-resolution:${event.eventResolutionId}`,
      `canonical-event:${event.canonicalEventId}`,
      ...event.participants.map(item => `event-participation:${item.participationId}`),
    ];
    if (!plan.requirementIds.includes(event.requirementId)
      || new Set(event.participants.map(item => item.mentionId)).size !== event.participants.length
      || new Set(event.participants.map(item => item.entityId)).size !== event.participants.length
      || new Set(event.participants.map(item => item.participationId)).size !== event.participants.length
      || slots.some(slot => semanticSlots.has(slot))) fail("Semantic event creation has duplicate or unknown scope");
    slots.forEach(slot => semanticSlots.add(slot));
    if (slots.some(slot => !plan.allowedCreations.some(ref => key(ref) === slot))) fail("Semantic event creation lacks an exact creation slot");
    for (const participant of event.participants) for (const ref of [
      `entity-mention:${participant.mentionId}`,
      `entity-resolution:${participant.resolutionId}`,
      `entity:${participant.entityId}`,
    ]) if (!plan.baselineRefs.some(base => key(base) === ref)) fail("Semantic event participant lacks a frozen identity trace");
  }
  for (const creation of plan.allowedCreations) if (["canonical-event", "event-participation"].includes(creation.kind)
    && !semanticSlots.has(key(creation))) fail("Semantic creation lacks its reviewed event contract");
  if (plan.proposalObligation && plan.allowedCreations.some(creation => !semanticSlots.has(key(creation)))) {
    fail("Proposal-obligation repair contains a creation outside its reviewed missing-event contract");
  }
  const annotationSlots = [...plan.allowedWrites, ...plan.allowedCreations].filter(ref => ["entity-mention", "event-mention", "quotation", "discourse-segment"].includes(ref.kind));
  if (!unique(annotationSlots.map(ref => ref.id))) fail("Annotation write slots share a logical ID across types");
  if (plan.citableEvidenceRefs.some(id => !plan.sourceScope.segmentIds.includes(id))) fail("Citable evidence escapes source scope");
  if (plan.postconditionIds.length !== plan.requirementIds.length || plan.postconditionIds.some(id => !plan.requirementIds.includes(id))) fail("Repair postconditions must preserve the selected requirement denominator");
  for (const write of plan.allowedWrites) if (!plan.baselineRefs.some(ref => key(ref) === key(write))) fail("Repair write lacks immutable baseline");
  for (const ref of plan.baselineRefs) if (!plan.readableRefs.some(read => key(read) === key(ref))) fail("Baseline is not explicitly readable");
  for (const creation of plan.allowedCreations) {
    if (!plan.requirementIds.includes(creation.dependencyOf) || plan.baselineRefs.some(ref => key(ref) === key(creation))) fail("Creation has no fresh named requirement slot");
    if (!plan.dependencyEdges.some(edge => edge.from === `requirement:${creation.dependencyOf}` && edge.to === key(creation))) fail("Creation lacks its explicit dependency edge");
  }
  const nodes = new Set([...plan.requirementIds.map(id => `requirement:${id}`), ...plan.readableRefs.map(key), ...plan.allowedCreations.map(key)]);
  const pending = new Set(nodes), done = new Set<string>();
  for (const edge of plan.dependencyEdges) if (!nodes.has(edge.from) || !nodes.has(edge.to)) fail("Repair dependency has unknown node");
  while (pending.size) {
    const ready = [...pending].filter(node => plan.dependencyEdges.filter(edge => edge.from === node).every(edge => done.has(edge.to)));
    if (!ready.length) { fail("Repair dependency cycle"); break; }
    for (const node of ready) { pending.delete(node); done.add(node); }
  }
});
export type UpstreamRepairPlan = z.infer<typeof upstreamRepairPlanSchema>;
export function freezeUpstreamRepairPlan(input: z.input<typeof identitySchema>): UpstreamRepairPlan {
  const identity = identitySchema.parse(input);
  return upstreamRepairPlanSchema.parse({ ...identity, planHash: contentHash(identity) });
}

/** Negative dependencies are versioned policy, checked against actual active payloads. */
export function assertUpstreamResolutionAbsences(plan: UpstreamRepairPlan, payloads: ReadonlyMap<string, unknown>, committedOutputs: ReadonlyMap<string, string> = new Map()) {
  for (const absence of plan.resolutionAbsences ?? []) for (const [key, payload] of payloads) {
    if (!key.startsWith(`${absence.kind}:`)) continue;
    const resolution = payload as { id: string; mentionId?: string; eventMentionIds?: string[] };
    if (!(absence.kind === "entity-resolution" ? resolution.mentionId === absence.mentionId : resolution.eventMentionIds?.includes(absence.mentionId))) continue;
    if (resolution.id !== absence.id || committedOutputs.get(key) !== contentHash(payload)) throw new Error(`UPSTREAM_REPAIR_REQUIRES_HOST_REVIEW: Resolution absence changed for ${absence.kind}:${absence.mentionId}. Preserve the original plan and existing resolution; stop model retries and do not rotate identities.`);
  }
}

function payloadFor(kind: UpstreamRepairKind, raw: unknown) {
  if (kind === "entity-resolution") return identityResolutionSchema.parse(raw);
  if (kind === "event-resolution") return eventResolutionSchema.parse(raw);
  if (kind === "canonical-event") return canonicalEventSchema.parse(raw);
  if (kind === "event-participation") return eventParticipationSchema.parse(raw);
  const parsed = sourceAnnotationSchema.parse(raw);
  if (parsed.annotationType !== kind) throw new Error("Repair payload kind mismatch");
  return parsed;
}

export function upstreamRepairReferencedKeys(kind: UpstreamRepairKind, raw: unknown): string[] {
  const refs: string[] = [];
  const add = (type: string, ids: readonly (string | undefined)[]) => { for (const id of ids) if (id) refs.push(`${type}:${id}`); };
  if (kind === "entity-resolution") {
    const value = identityResolutionSchema.parse(raw);
    add("entity-mention", [value.mentionId, ...value.candidates.flatMap(item => item.basisMentionIds)]);
    add("entity", [value.entityId, value.intendedEntityId, ...value.candidates.map(item => item.entityId)]);
    add("evidence-assertion", value.candidates.flatMap(item => item.evidenceAssertionIds));
    add("entity-resolution", [value.supersedesResolutionId]);
  } else if (kind === "event-resolution") {
    const value = eventResolutionSchema.parse(raw);
    add("event-mention", [...value.eventMentionIds, ...value.candidates.flatMap(item => item.basisEventMentionIds)]);
    add("canonical-event", [value.canonicalEventId, ...value.candidates.map(item => item.canonicalEventId)]);
    add("evidence-assertion", value.candidates.flatMap(item => item.evidenceAssertionIds));
    add("event-resolution", value.supersedesResolutionIds);
  } else if (kind === "canonical-event") {
    const value = canonicalEventSchema.parse(raw);
    const fields = new Map(DEFAULT_STATE_FIELDS.map(field => [field.key, field]));
    add("entity", value.participants);
    add("entity", (value.participantPresence ?? []).map(item => item.entityId));
    add("canonical-event", value.causalParents);
    if (value.storyTime.kind === "relative") add("canonical-event", [value.storyTime.anchorEventId]);
    for (const predicate of value.preconditions) for (const ref of predicateReferences(predicate, fields)) add(ref.kind === "event" ? "canonical-event" : ref.kind === "rule" ? "world-rule" : "entity", [ref.id]);
    for (const operation of value.observedOutcome.operations) for (const ref of stateOperationReferences(operation, fields)) add(ref.kind === "event" ? "canonical-event" : ref.kind === "rule" ? "world-rule" : "entity", [ref.id]);
    for (const operation of value.observedKnowledge?.operations ?? []) {
      add("entity", [operation.actorId, operation.op === "learn" ? operation.sourceActorId : undefined]);
      add("claim", [operation.claimId]);
      add("proposition", [operation.propositionId]);
      if (operation.op === "learn") {
        add("attribution", [operation.attributionId]);
        add("utterance-expression", [operation.expressionId]);
        add("perception-observation", [operation.perceptionId]);
        add("acquisition", [operation.acquisitionId]);
      }
    }
    add("scene-occurrence", value.sceneOccurrenceIds ?? []);
    add("event-frame", [value.frameInstance?.frameId]);
    if (value.action?.lane === "schema-bound") {
      add("action-schema", [value.action.schemaId]);
      add("entity", value.action.roleBindings.flatMap(role => role.entityIds));
    }
    for (const checkpoint of value.characterEntryCheckpoints ?? []) {
      add("entity", [checkpoint.actorId, ...checkpoint.participantPresence.map(item => item.entityId)]);
      for (const operation of checkpoint.delta.operations) for (const ref of stateOperationReferences(operation, fields)) add(ref.kind === "event" ? "canonical-event" : ref.kind === "rule" ? "world-rule" : "entity", [ref.id]);
      for (const operation of checkpoint.knowledge?.operations ?? []) {
        add("entity", [operation.actorId, operation.op === "learn" ? operation.sourceActorId : undefined]);
        add("claim", [operation.claimId]);
        add("proposition", [operation.propositionId]);
      }
    }
  } else if (kind === "event-participation") {
    const value = eventParticipationSchema.parse(raw);
    add("canonical-event", [value.eventId]);
    add("entity", [value.entityId]);
  } else {
    const value = sourceAnnotationSchema.parse(raw);
    if (value.annotationType !== "discourse-segment") add("discourse-segment", [value.sceneId]);
    if (value.annotationType === "quotation") add("entity-mention", [value.speakerMentionId, ...value.addresseeMentionIds]);
    if (value.annotationType === "event-mention") { add("entity-mention", value.participantMentionIds); add("discourse-segment", [value.discourseSegmentId]); }
    if (value.annotationType === "discourse-segment") add("entity-mention", [value.viewpointMentionId]);
  }
  return [...new Set(refs)];
}

/** Pure pre-stage check. The executor still owns persisted budgets, evidence and finish validation. */
export function assertUpstreamRepairMutation(planInput: UpstreamRepairPlan, input: {
  kind: UpstreamRepairKind; id: string; baseline: unknown | null; payload: unknown;
  activeRevisions: ReadonlyMap<string, string>; sourceSha256: string; requirementSetHash: string;
  citedSegmentIds: readonly string[]; hostDerivation: unknown;
}): void {
  const plan = upstreamRepairPlanSchema.parse(planInput);
  const stop = (message: string): never => { throw new Error(`UPSTREAM_REPAIR_REQUIRES_HOST_REVIEW: ${message}. Preserve plan, budget and drafts; stop this task. Do not guess IDs, rotate namespaces or retry unchanged.`); };
  if (input.sourceSha256 !== plan.sourceScope.sourceSha256 || input.requirementSetHash !== plan.requirementSetHash) stop("Source or requirement revision changed");
  for (const ref of plan.baselineRefs) if (input.activeRevisions.get(key(ref)) !== ref.revisionHash) stop(`Active baseline changed: ${key(ref)}`);
  if (!input.citedSegmentIds.length || input.citedSegmentIds.some(id => !plan.citableEvidenceRefs.includes(id))) stop("Evidence is not citable under this plan");
  const next = payloadFor(input.kind, input.payload);
  if (next.id !== input.id || ("sourceId" in next && next.sourceId !== plan.sourceScope.sourceId)) stop("Payload identity or source escapes plan");
  const absence = plan.resolutionAbsences?.find(ref => ref.kind === input.kind && ref.id === input.id);
  if (absence) {
    const actualMentions = input.kind === "entity-resolution" ? [identityResolutionSchema.parse(next).mentionId] : eventResolutionSchema.parse(next).eventMentionIds;
    if (actualMentions.length !== 1 || actualMentions[0] !== absence.mentionId) stop("Resolution payload changed its exact absent mention slot");
  }
  const revision = plan.resolutionRevisions?.find(ref => key(ref) === key(input));
  if (revision) {
    const actual = input.kind === "entity-resolution" ? identityResolutionSchema.parse(next) : eventResolutionSchema.parse(next);
    const mentions = "mentionId" in actual ? [actual.mentionId] : actual.eventMentionIds;
    const predecessors = "mentionId" in actual ? [actual.supersedesResolutionId] : actual.supersedesResolutionIds;
    if (contentHash([...mentions].sort()) !== contentHash([...revision.mentionIds].sort()) || contentHash(predecessors) !== contentHash([revision.predecessorId])) stop("Resolution revision changed its predecessor or mention scope");
  }
  for (const reference of upstreamRepairReferencedKeys(input.kind, next)) {
    if (plan.allowedCreations.some(ref => key(ref) === reference)) {
      if (!plan.dependencyEdges.some(edge => edge.from === key(input) && edge.to === reference)) stop(`Undeclared creation dependency: ${reference}`);
      continue;
    }
    if (!plan.readableRefs.some(ref => key(ref) === reference) || !plan.baselineRefs.some(ref => key(ref) === reference)) stop(`Unfrozen dependency reference: ${reference}`);
  }
  if ("derivation" in next && (contentHash(next.derivation) !== contentHash(input.hostDerivation) || next.derivation.runId !== plan.batchId || next.derivation.compilerBatchId !== plan.batchId)) stop("Derivation differs from host batch provenance");
  const semantic = plan.semanticEventCreations?.find(item => item.eventMentionId === input.id
    || item.eventResolutionId === input.id || item.canonicalEventId === input.id
    || item.participants.some(participant => participant.participationId === input.id));
  if (["event-mention", "event-resolution", "canonical-event", "event-participation"].includes(input.kind) && semantic) {
    if (input.kind === "event-mention") {
      const mention = sourceAnnotationSchema.parse(next);
      if (mention.annotationType !== "event-mention"
        || contentHash(mention.triggerAnchor) !== contentHash(semantic.triggerAnchor)
        || contentHash(mention.extentAnchors) !== contentHash(semantic.extentAnchors)
        || contentHash([...mention.participantMentionIds].sort()) !== contentHash(semantic.participants.map(item => item.mentionId).sort())) stop("Event mention differs from the reviewed source occurrence");
    } else if (input.kind === "event-resolution") {
      const resolution = eventResolutionSchema.parse(next), candidate = resolution.candidates[0];
      if (resolution.status !== "new-event" || resolution.canonicalEventId !== semantic.canonicalEventId
        || resolution.relation !== "coreference" || contentHash(resolution.eventMentionIds) !== contentHash([semantic.eventMentionId])
        || resolution.candidates.length !== 1 || candidate?.canonicalEventId !== semantic.canonicalEventId
        || candidate.relation !== "coreference" || contentHash(candidate.basisEventMentionIds) !== contentHash([semantic.eventMentionId])
        || resolution.supersedesResolutionIds.length) stop("Event resolution differs from the reviewed new-event trace");
    } else if (input.kind === "canonical-event") {
      const event = canonicalEventSchema.parse(next);
      if (contentHash([...event.participants].sort()) !== contentHash(semantic.participants.map(item => item.entityId).sort())) stop("Canonical event participants differ from the reviewed identity trace");
    } else {
      const participation = eventParticipationSchema.parse(next);
      const binding = semantic.participants.find(item => item.participationId === participation.id);
      if (!binding || participation.eventId !== semantic.canonicalEventId || participation.entityId !== binding.entityId) stop("Event participation differs from the reviewed event/identity slot");
    }
  }
  const target = key(input);
  if (input.baseline === null) {
    const annotationKinds = ["entity-mention", "event-mention", "quotation", "discourse-segment"];
    const exists = input.activeRevisions.has(target) || (annotationKinds.includes(input.kind) && annotationKinds.some(kind => input.activeRevisions.has(`${kind}:${input.id}`)));
    if (!plan.allowedCreations.some(ref => key(ref) === target) || exists) stop("Creation is not a fresh host allocated dependency slot");
    return;
  }
  const write = plan.allowedWrites.find(ref => key(ref) === target);
  const baseline = payloadFor(input.kind, input.baseline);
  const ref = plan.baselineRefs.find(ref => key(ref) === target);
  if (!write || !ref || contentHash(baseline) !== ref.revisionHash || baseline.id !== input.id
    || ("sourceId" in baseline && "sourceId" in next && baseline.sourceId !== next.sourceId)) stop("Mutation lacks exact frozen baseline");
  const allowed = write!.pointers.map(repairPointerTokens);
  const before = baseline as Record<string, unknown>, after = next as Record<string, unknown>;
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (field === "derivation") continue; // Independently checked against host provenance above.
    if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
    if (!allowed.some(tokens => tokens.length === 1 && tokens[0] === field)) stop(`Unauthorized field difference: /${field}`);
  }
}

/** Recover superseded baseline evidence only from the original durable finish intent. */
export function recoverUpstreamResolutionBaselines(plan: UpstreamRepairPlan, payloads: Map<string, unknown>,
  outputs: ReadonlyMap<string, string>, baselines: readonly { kind: string; id: string; revisionHash: string; payload: unknown }[]) {
  for (const revision of plan.resolutionRevisions ?? []) {
    const priorKey = `${revision.kind}:${revision.predecessorId}`, nextKey = key(revision);
    const expected = plan.baselineRefs.find(ref => key(ref) === priorKey)!;
    const next = payloads.get(nextKey);
    if (next && outputs.get(nextKey) === contentHash(next)) {
      const original = baselines.find(ref => `${ref.kind}:${ref.id}` === priorKey);
      if (!original || original.revisionHash !== expected.revisionHash || contentHash(original.payload) !== expected.revisionHash) throw new Error("UPSTREAM_REPAIR_REQUIRES_HOST_REVIEW: Missing original resolution baseline; stop retries and preserve receipt");
      const parsed = payloadFor(revision.kind, next);
      const predecessors = "mentionId" in parsed ? [parsed.supersedesResolutionId] : "supersedesResolutionIds" in parsed ? parsed.supersedesResolutionIds : [];
      if (contentHash(predecessors) !== contentHash([revision.predecessorId])) throw new Error("UPSTREAM_REPAIR_REQUIRES_HOST_REVIEW: Resolution successor changed; stop retries");
      for (const [candidateKey, raw] of payloads) {
        if (!candidateKey.startsWith(`${revision.kind}:`) || candidateKey === nextKey) continue;
        const candidate = raw as { mentionId?: string; eventMentionIds?: string[] };
        if (revision.mentionIds.some(id => candidate.mentionId === id || candidate.eventMentionIds?.includes(id))) throw new Error("UPSTREAM_REPAIR_REQUIRES_HOST_REVIEW: Competing resolution revision; stop retries");
      }
      payloads.set(priorKey, original.payload);
    }
  }
}

import { z } from "zod";
import { idSchema, textAnchorSchema } from "../world/model.js";
import { contentHash } from "../world/canonical.js";
import { EntityResolutionStore } from "./entity-resolution.js";
import { EventResolutionStore } from "./event-resolution.js";
import { loadCompilerArtifactRecords } from "./artifact-retrieval.js";
import { SourceAnnotationStore } from "./annotations.js";
import { textAnchorForByteRange } from "./text-anchors.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { freezeUpstreamRepairPlan, type UpstreamRepairPlan } from "./upstream-repair-plan.js";
import { verifyUpstreamRepairPlan, upstreamRepairHostError } from "./upstream-repair-preflight.js";
import {
  CompilerProposalObligations,
  sourcePatternObligationRequirementId,
  sourcePatternObligationRequirementSetHash,
  sourcePatternUpstreamAuthoritySchema,
} from "./proposal-obligations.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1);
const candidates = z.array(z.object({ id: idSchema, revisionHash: hash }).strict()).max(32)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, "Duplicate candidate identity");
/** Host-reviewed diagnostics, never inferred by parsing error messages. */
export const upstreamRepairReviewSchema = z.object({
  version: z.literal(1), sourceId: idSchema, sourceSha256: hash,
  planId: idSchema, batchId: idSchema, requirementSetHash: hash,
  requirementIds: z.array(text).min(1).max(128), predecessorReceiptRefs: z.array(hash).max(128),
  proposalObligation: sourcePatternUpstreamAuthoritySchema.optional(),
  segmentIds: z.array(idSchema).min(1).max(128), citableEvidenceRefs: z.array(idSchema).min(1).max(128),
  authorizationRef: text, retryBudgetRef: idSchema,
  diagnostics: z.array(z.discriminatedUnion("code", [
    z.object({ code: z.literal("QUOTATION_ANCHOR_INCOMPLETE"), quotationId: idSchema, revisionHash: hash, expectedAnchor: textAnchorSchema, requirementId: text }).strict(),
    z.object({ code: z.literal("QUOTATION_SPEAKER_MENTION_MISSING"), quotationId: idSchema, revisionHash: hash, requirementId: text }).strict(),
    z.object({ code: z.literal("ENTITY_RESOLUTION_MISSING"), mentionId: idSchema, revisionHash: hash, requirementId: text, candidates }).strict(),
    z.object({ code: z.literal("EVENT_RESOLUTION_MISSING"), mentionId: idSchema, revisionHash: hash, requirementId: text, candidates }).strict(),
    z.object({ code: z.literal("ENTITY_RESOLUTION_REVISION"), mentionId: idSchema, revisionHash: hash, resolutionId: idSchema, resolutionHash: hash, requirementId: text, candidates }).strict(),
    z.object({ code: z.literal("EVENT_RESOLUTION_REVISION"), mentionId: idSchema, revisionHash: hash, resolutionId: idSchema, resolutionHash: hash, requirementId: text, candidates }).strict(),
    z.object({ code: z.literal("CANONICAL_EVENT_MISSING"), requirementId: text, triggerAnchor: textAnchorSchema,
      extentAnchors: z.array(textAnchorSchema).min(1).max(32), participantMentionIds: z.array(idSchema).min(1).max(64)
        .refine(ids => new Set(ids).size === ids.length, "Duplicate participant mention") }).strict(),
    z.object({ code: z.literal("SEMANTIC_MODULE_REQUIRED"), requirementId: text, semanticKind: text }).strict(),
  ])).min(1).max(128),
}).strict();

/** Build immutable policy from actual typed dependencies. Does not register or authorize it. */
export async function planUpstreamRepair(root: string, raw: unknown) {
  const review = upstreamRepairReviewSchema.parse(raw), reviewHash = contentHash(review);
  if (review.diagnostics.some(item => !review.requirementIds.includes(item.requirementId))) throw upstreamRepairHostError("Diagnostic escapes the selected independent requirements");
  if (review.proposalObligation) {
    const authority = new CompilerProposalObligations(root, review.proposalObligation.sourceId, review.proposalObligation.batchId)
      .verifySourcePatternUpstreamAuthority(review.proposalObligation);
    const requirementId = sourcePatternObligationRequirementId(review.proposalObligation);
    if (authority.correction) throw upstreamRepairHostError("The durable proposal obligation already has a host correction; preserve it instead of opening another upstream plan");
    if (review.sourceId !== review.proposalObligation.sourceId || review.batchId === review.proposalObligation.batchId
      || review.requirementSetHash !== sourcePatternObligationRequirementSetHash(review.proposalObligation)
      || contentHash(review.requirementIds) !== contentHash([requirementId])) {
      throw upstreamRepairHostError("Proposal-obligation review differs from the exact same-scope discovery result");
    }
    if (review.diagnostics.some(item => item.code !== "CANONICAL_EVENT_MISSING" || item.requirementId !== requirementId)) {
      throw upstreamRepairHostError("Proposal-obligation authority may only schedule reviewed missing canonical-event dependencies");
    }
  }
  const source = await WorkspaceStore.openReadOnly(root).getSource(review.sourceId);
  if (!source || source.contentSha256 !== review.sourceSha256) throw upstreamRepairHostError("Reviewed source revision is no longer registered");
  const bytes = await readSourceMaterial(root, source);
  const annotations = await new SourceAnnotationStore(root).list(review.sourceId);
  const baselines = new Map<string, UpstreamRepairPlan["baselineRefs"][number]>();
  const writes = new Map<string, UpstreamRepairPlan["allowedWrites"][number]>();
  const creations = new Map<string, UpstreamRepairPlan["allowedCreations"][number]>();
  const absences = new Map<string, NonNullable<UpstreamRepairPlan["resolutionAbsences"]>[number]>();
  const revisions: NonNullable<UpstreamRepairPlan["resolutionRevisions"]> = [];
  const semanticEventCreations: NonNullable<UpstreamRepairPlan["semanticEventCreations"]> = [];
  const edges = new Map<string, UpstreamRepairPlan["dependencyEdges"][number]>();
  const edge = (from: string, to: string, purpose: UpstreamRepairPlan["dependencyEdges"][number]["purpose"]) => edges.set(`${from}\0${to}`, { from, to, purpose });
  const unsupported = review.diagnostics.filter(item => item.code === "SEMANTIC_MODULE_REQUIRED");
  if (unsupported.length) return { authority: "diagnostic-only" as const, status: "needs-host-review" as const, reviewHash, diagnostics: unsupported, plan: null };
  const [entityResolutions, eventResolutions, records] = await Promise.all([
    new EntityResolutionStore(root).list(review.sourceId), new EventResolutionStore(root).list(review.sourceId),
    loadCompilerArtifactRecords(root, review.sourceId),
  ]);
  for (const eventId of review.proposalObligation?.originalSupportingEventIds ?? []) {
    const event = records.find(item => item.status === "canonical" && item.kind === "canonical-event" && item.logicalId === eventId);
    if (!event) throw upstreamRepairHostError(`Original source-pattern dependency is no longer canonical: ${eventId}`);
    baselines.set(`canonical-event:${event.logicalId}`, { kind: "canonical-event", id: event.logicalId, revisionHash: contentHash(event.payload) });
  }
  for (const diagnostic of review.diagnostics) {
    if (diagnostic.code === "SEMANTIC_MODULE_REQUIRED") continue;
    if (diagnostic.code === "CANONICAL_EVENT_MISSING") {
      const anchors = [diagnostic.triggerAnchor, ...diagnostic.extentAnchors];
      if (anchors.some(anchor => anchor.sourceId !== source.id
        || contentHash(anchor) !== contentHash(textAnchorForByteRange(source.id, bytes, anchor.startByte, anchor.endByte)))) throw upstreamRepairHostError("Reviewed missing-event anchor differs from immutable source bytes");
      const participants = [];
      for (const mentionId of diagnostic.participantMentionIds) {
        const mention = annotations.find(item => item.id === mentionId && item.annotationType === "entity-mention");
        const resolution = entityResolutions.find(item => item.mentionId === mentionId && item.entityId);
        const entity = resolution?.entityId ? records.find(item => item.status === "canonical" && item.kind === "entity" && item.logicalId === resolution.entityId) : undefined;
        if (!mention || !resolution?.entityId || !entity) throw upstreamRepairHostError("Reviewed missing-event participant lacks a current mention, selected identity resolution or canonical entity; discover source annotations/resolutions and copy their exact IDs into a new host review");
        baselines.set(`entity-mention:${mention.id}`, { kind: "entity-mention", id: mention.id, revisionHash: contentHash(mention) });
        baselines.set(`entity-resolution:${resolution.id}`, { kind: "entity-resolution", id: resolution.id, revisionHash: contentHash(resolution) });
        baselines.set(`entity:${entity.logicalId}`, { kind: "entity", id: entity.logicalId, revisionHash: contentHash(entity.payload) });
        participants.push({ mentionId: mention.id, resolutionId: resolution.id, entityId: entity.logicalId });
      }
      if (new Set(participants.map(item => item.entityId)).size !== participants.length) throw upstreamRepairHostError("Reviewed missing-event participant mentions do not resolve to a unique canonical participant inventory");
      const occurrenceHash = contentHash({ sourceId: source.id, triggerAnchor: diagnostic.triggerAnchor,
        extentAnchors: diagnostic.extentAnchors, participantMentionIds: [...diagnostic.participantMentionIds].sort() });
      const eventMentionId = `repair-event-mention-${occurrenceHash.slice(0, 32)}`;
      const eventResolutionId = `repair-event-resolution-${occurrenceHash.slice(0, 32)}`;
      const canonicalEventId = `repair-canonical-event-${occurrenceHash.slice(0, 32)}`;
      if (semanticEventCreations.some(item => item.eventMentionId === eventMentionId)) throw upstreamRepairHostError("One reviewed source occurrence cannot allocate duplicate semantic event repairs");
      const boundParticipants = participants.map(participant => ({ ...participant,
        participationId: `repair-event-participation-${contentHash({ sourceId: source.id, canonicalEventId, entityId: participant.entityId }).slice(0, 32)}` }));
      const slots = [
        { kind: "event-mention" as const, id: eventMentionId },
        { kind: "canonical-event" as const, id: canonicalEventId },
        { kind: "event-resolution" as const, id: eventResolutionId },
        ...boundParticipants.map(item => ({ kind: "event-participation" as const, id: item.participationId })),
      ];
      for (const slot of slots) {
        creations.set(`${slot.kind}:${slot.id}`, { ...slot, maxCount: 1, dependencyOf: diagnostic.requirementId });
        edge(`requirement:${diagnostic.requirementId}`, `${slot.kind}:${slot.id}`, "requirement");
      }
      edge(`canonical-event:${canonicalEventId}`, `event-mention:${eventMentionId}`, "source-evidence");
      edge(`event-resolution:${eventResolutionId}`, `event-mention:${eventMentionId}`, "identity");
      edge(`event-resolution:${eventResolutionId}`, `canonical-event:${canonicalEventId}`, "identity");
      for (const participant of boundParticipants) {
        edge(`event-mention:${eventMentionId}`, `entity-mention:${participant.mentionId}`, "identity");
        edge(`canonical-event:${canonicalEventId}`, `entity:${participant.entityId}`, "identity");
        edge(`event-participation:${participant.participationId}`, `canonical-event:${canonicalEventId}`, "identity");
        edge(`event-participation:${participant.participationId}`, `entity:${participant.entityId}`, "identity");
      }
      semanticEventCreations.push({ requirementId: diagnostic.requirementId, eventMentionId, eventResolutionId, canonicalEventId,
        triggerAnchor: diagnostic.triggerAnchor, extentAnchors: diagnostic.extentAnchors, participants: boundParticipants });
      continue;
    }
    if ("mentionId" in diagnostic) {
      const entity = diagnostic.code.startsWith("ENTITY_");
      const mentionKind = entity ? "entity-mention" : "event-mention", resolutionKind = entity ? "entity-resolution" : "event-resolution";
      const mention = annotations.find(item => item.id === diagnostic.mentionId && item.annotationType === mentionKind);
      if (!mention || contentHash(mention) !== diagnostic.revisionHash) throw upstreamRepairHostError("Reviewed resolution mention is missing or changed; find_source_annotations returns annotationId. Obtain a corrected host review instead of guessing");
      if (!("resolutionId" in diagnostic) && (entity ? entityResolutions.some(item => item.mentionId === mention.id) : eventResolutions.some(item => item.eventMentionIds.includes(mention.id)))) throw upstreamRepairHostError("Resolution already exists for the reviewed mention; preserve its unknown/ambiguous/resolved state and use a separately reviewed revision policy, not a new identity");
      const mentionKey = `${mentionKind}:${mention.id}`;
      baselines.set(mentionKey, { kind: mentionKind, id: mention.id, revisionHash: contentHash(mention) });
      const candidateKind = entity ? "entity" : "canonical-event";
      for (const candidate of diagnostic.candidates) {
        const record = records.find(item => item.status === "canonical" && item.kind === candidateKind && item.logicalId === candidate.id);
        if (!record || contentHash(record.payload) !== candidate.revisionHash) throw upstreamRepairHostError("Reviewed resolution candidate is missing, outside this source or changed; requirements discover-upstream-repairs in this source returns candidateRefs[].id and candidateRefs[].revisionHash. Copy the matching kind for one corrected host review; do not guess identity or revision hashes");
        baselines.set(`${candidateKind}:${candidate.id}`, { kind: candidateKind, id: candidate.id, revisionHash: candidate.revisionHash });
      }
      let predecessorId: string | undefined;
      if ("resolutionId" in diagnostic) {
        const prior = entity ? entityResolutions.find(item => item.id === diagnostic.resolutionId) : eventResolutions.find(item => item.id === diagnostic.resolutionId);
        if (!prior || contentHash(prior) !== diagnostic.resolutionHash) throw upstreamRepairHostError("Reviewed resolution predecessor changed; discover upstream repairs and copy resolutionId and resolutionHash for one corrected host review");
        const ids = "mentionId" in prior ? [prior.mentionId] : prior.eventMentionIds;
        // Splits/merges require a separately registered policy; this policy is one-for-one.
        if (ids.length !== 1 || ids[0] !== mention.id) throw upstreamRepairHostError("Resolution revision requires one exact mention; split/merge is unsupported");
        predecessorId = prior.id;
        baselines.set(`${resolutionKind}:${prior.id}`, { kind: resolutionKind, id: prior.id, revisionHash: contentHash(prior) });
      }
      const id = `repair-${resolutionKind}-${contentHash({ sourceId: source.id, kind: resolutionKind, mentionId: mention.id, ...(predecessorId ? { predecessorId, predecessorHash: "resolutionHash" in diagnostic ? diagnostic.resolutionHash : undefined } : {}) }).slice(0, 32)}`;
      const slot = `${resolutionKind}:${id}`;
      if (predecessorId) { if (!revisions.some(item => item.kind === resolutionKind && item.id === id)) revisions.push({ kind: resolutionKind, id, predecessorId, mentionIds: [mention.id] }); }
      else absences.set(slot, { kind: resolutionKind, id, mentionId: mention.id });
      creations.set(slot, { kind: resolutionKind, id, maxCount: 1, dependencyOf: diagnostic.requirementId });
      edge(`requirement:${diagnostic.requirementId}`, slot, "identity");
      edge(slot, mentionKey, "identity");
      for (const candidate of diagnostic.candidates) edge(slot, `${candidateKind}:${candidate.id}`, "identity");
      continue;
    }
    const quotation = annotations.find(item => item.id === diagnostic.quotationId && item.annotationType === "quotation");
    if (!quotation || quotation.annotationType !== "quotation" || contentHash(quotation) !== diagnostic.revisionHash) throw upstreamRepairHostError("Diagnostic quotation is missing or its reviewed revision changed; find_source_annotations in this source returns annotationId, then obtain a new host review, not a guessed ID");
    const key = `quotation:${quotation.id}`;
    baselines.set(key, { kind: "quotation", id: quotation.id, revisionHash: contentHash(quotation) });
    for (const mentionId of [quotation.speakerMentionId, ...quotation.addresseeMentionIds]) {
      if (!mentionId) continue;
      const mention = annotations.find(item => item.id === mentionId && item.annotationType === "entity-mention");
      if (mention) {
        baselines.set(`entity-mention:${mention.id}`, { kind: "entity-mention", id: mention.id, revisionHash: contentHash(mention) });
        edge(key, `entity-mention:${mention.id}`, "identity");
      }
    }
    if (diagnostic.code === "QUOTATION_ANCHOR_INCOMPLETE") {
      const expected = diagnostic.expectedAnchor, original = quotation.anchor;
      if (expected.sourceId !== source.id || expected.startByte > original.startByte || expected.endByte < original.endByte
        || (expected.startByte === original.startByte && expected.endByte === original.endByte)
        || contentHash(expected) !== contentHash(textAnchorForByteRange(source.id, bytes, expected.startByte, expected.endByte))) throw upstreamRepairHostError("Reviewed quotation extension is not a strict original-byte extension of the active anchor");
      writes.set(key, { kind: "quotation", id: quotation.id, pointers: ["/anchor"] });
      edge(`requirement:${diagnostic.requirementId}`, key, "quotation");
    } else {
      const mentionId = quotation.speakerMentionId;
      if (!mentionId || annotations.some(item => item.id === mentionId)) throw upstreamRepairHostError("Missing speaker diagnostic does not name a genuinely absent typed annotation dependency");
      const slot = `entity-mention:${mentionId}`;
      // The existing typed edge fixes the missing identity; the model cannot choose another ID.
      creations.set(slot, { kind: "entity-mention", id: mentionId, maxCount: 1, dependencyOf: diagnostic.requirementId });
      edge(`requirement:${diagnostic.requirementId}`, slot, "identity");
      edge(key, slot, "identity");
    }
  }
  const ordered = <T extends { kind: string; id: string }>(items: Iterable<T>) => [...items].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  const plan = freezeUpstreamRepairPlan({ version: 1, planId: review.planId, batchId: review.batchId,
    requirementSetHash: review.requirementSetHash, requirementIds: review.requirementIds, predecessorReceiptRefs: review.predecessorReceiptRefs,
    ...(review.proposalObligation ? { proposalObligation: review.proposalObligation } : {}),
    sourceScope: { sourceId: source.id, sourceSha256: review.sourceSha256, segmentIds: review.segmentIds },
    baselineRefs: ordered(baselines.values()), readableRefs: ordered(baselines.values()).map(({ kind, id }) => ({ kind, id })),
    allowedWrites: ordered(writes.values()), allowedCreations: ordered(creations.values()),
    ...(revisions.length ? { resolutionRevisions: revisions } : {}),
    ...(absences.size ? { resolutionAbsences: ordered(absences.values()) } : {}),
    ...(semanticEventCreations.length ? { semanticEventCreations } : {}),
    citableEvidenceRefs: review.citableEvidenceRefs, dependencyEdges: [...edges.values()].sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)),
    postconditionIds: review.requirementIds, authorizationRef: `${review.authorizationRef}#review=${reviewHash}`, retryBudgetRef: review.retryBudgetRef,
  });
  const verified = await verifyUpstreamRepairPlan(root, plan);
  for (const diagnostic of review.diagnostics) if (diagnostic.code === "QUOTATION_ANCHOR_INCOMPLETE") {
    const anchor = diagnostic.expectedAnchor;
    if (!review.citableEvidenceRefs.some(id => {
      const segment = verified.payloads.get(`source-segment:${id}`) as { startByte: number; endByte: number } | undefined;
      return segment && segment.startByte <= anchor.startByte && segment.endByte >= anchor.endByte;
    })) throw upstreamRepairHostError("Reviewed quotation extension lies outside citable source evidence");
  }
  for (const semantic of semanticEventCreations) for (const anchor of [semantic.triggerAnchor, ...semantic.extentAnchors]) {
    if (!review.citableEvidenceRefs.some(id => {
      const segment = verified.payloads.get(`source-segment:${id}`) as { startByte: number; endByte: number } | undefined;
      return segment && segment.startByte <= anchor.startByte && segment.endByte >= anchor.endByte;
    })) throw upstreamRepairHostError("Reviewed missing-event evidence lies outside citable source evidence");
  }
  return { authority: "diagnostic-only" as const, status: "ready-for-host-authorization" as const, reviewHash, diagnostics: review.diagnostics, plan };
}

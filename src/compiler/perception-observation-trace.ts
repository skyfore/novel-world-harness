import { ProposalStore } from "../world/canonical-model.js";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { idSchema, type EvidenceRef, type ValidationIssue } from "../world/model.js";
import { perceptionObservationSchema, type PerceptionObservation } from "../world/perception-observation.js";
import { SourceAnnotationStore, type SourceAnnotation } from "./annotations.js";
import { EntityResolutionStore, type IdentityResolution } from "./entity-resolution.js";
import { EventResolutionStore, type EventResolution } from "./event-resolution.js";
import { EvidenceVerifier } from "./evidence.js";

export type PerceptionTraceCatalog = {
  annotations: ReadonlyMap<string, SourceAnnotation>;
  identities: readonly IdentityResolution[];
  events: readonly EventResolution[];
};
export const perceptionObservationInputSchema = perceptionObservationSchema.omit({ trace: true, evidence: true }).extend({
  trace: z.object({ observerMentionId: idSchema, eventMentionId: idSchema }).strict(),
}).strict();
const recovery = "Use same-source find_source_annotations with the required annotation_type; copy results[].readArguments.ref into read_source_annotation.ref and payload.id into the logical mention field. For observer identity use same-source find_identity_resolutions and copy results[].ref into read_identity_resolution.ref; for the event use find_event_resolutions and copy results[].ref into read_event_resolution.ref. Use only returned logical IDs; the host freezes revision hashes. At most one corrected retry within current authority. If perception, identity, event scope or source evidence is absent, preserve drafts and stop for host review; never guess, relabel a report or retry unchanged.";

export async function loadPerceptionTraceCatalog(root: string, source: string,
  annotationIds: readonly string[] = [], identityIds: readonly string[] = [], eventIds: readonly string[] = []): Promise<PerceptionTraceCatalog> {
  const annotations = new SourceAnnotationStore(root), identities = new EntityResolutionStore(root), events = new EventResolutionStore(root);
  const annotationMap = new Map((await annotations.list(source)).map(item => [item.id, item]));
  const identityMap = new Map((await identities.list(source)).map(item => [item.mentionId, item]));
  const eventMap = new Map((await events.list(source)).flatMap(item => item.eventMentionIds.map(id => [id, item] as const)));
  for (const id of annotationIds) {
    const proposal = await annotations.readProposal(source, "pending", id).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return annotations.readProposal(source, "accepted", id); });
    annotationMap.set(proposal.payload.id, proposal.payload);
  }
  for (const id of identityIds) {
    const proposal = await identities.readProposal(source, "pending", id).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return identities.readProposal(source, "accepted", id); });
    identityMap.set(proposal.payload.mentionId, proposal.payload);
  }
  for (const id of eventIds) {
    const proposal = await events.readProposal(source, "pending", id).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return events.readProposal(source, "accepted", id); });
    for (const mentionId of proposal.payload.eventMentionIds) eventMap.set(mentionId, proposal.payload);
  }
  return { annotations: annotationMap, identities: [...identityMap.values()], events: [...new Map([...eventMap.values()].map(item => [item.id, item])).values()] };
}

export function hydratePerceptionObservationInput(input: unknown, evidence: EvidenceRef[], catalog: PerceptionTraceCatalog): PerceptionObservation {
  const value = perceptionObservationInputSchema.parse(input);
  const observer = catalog.annotations.get(value.trace.observerMentionId), event = catalog.annotations.get(value.trace.eventMentionId);
  const identity = catalog.identities.find(item => item.mentionId === value.trace.observerMentionId);
  const resolution = catalog.events.find(item => item.eventMentionIds.includes(value.trace.eventMentionId));
  if (observer?.annotationType !== "entity-mention" || event?.annotationType !== "event-mention" || !identity || !resolution) throw new Error(`PERCEPTION_TRACE_MISSING: ${recovery}`);
  return perceptionObservationSchema.parse({ ...value, evidence, trace: {
    observerMentionId: observer.id, observerMentionHash: contentHash(observer), observerResolutionId: identity.id, observerResolutionHash: contentHash(identity),
    eventMentionId: event.id, eventMentionHash: contentHash(event), eventResolutionId: resolution.id, eventResolutionHash: contentHash(resolution), anchors: event.extentAnchors,
  } });
}

export async function validatePerceptionObservationTrace(root: string, observation: PerceptionObservation, catalog?: PerceptionTraceCatalog): Promise<ValidationIssue[]> {
  const source = observation.trace.anchors[0]!.sourceId;
  const trace = catalog ?? await loadPerceptionTraceCatalog(root, source);
  const observer = trace.annotations.get(observation.trace.observerMentionId), event = trace.annotations.get(observation.trace.eventMentionId);
  const identity = trace.identities.find(item => item.id === observation.trace.observerResolutionId);
  const resolution = trace.events.find(item => item.id === observation.trace.eventResolutionId);
  const issues: ValidationIssue[] = [];
  const fail = (code: string, message: string) => issues.push({ code, message: `${message} ${recovery}`, path: "trace" });
  if (!observer || !event || !identity || !resolution || contentHash(observer) !== observation.trace.observerMentionHash
    || contentHash(event) !== observation.trace.eventMentionHash || contentHash(identity) !== observation.trace.observerResolutionHash || contentHash(resolution) !== observation.trace.eventResolutionHash) {
    issues.push({ code: "PERCEPTION_TRACE_REVISION_MISMATCH", message: "Perception requires its exact frozen annotation and resolution revisions. Preserve drafts and stop for host source review; do not retry, guess hashes or overwrite frozen proof.", path: "trace" });
    return issues;
  }
  if (observer.annotationType !== "entity-mention" || observer.sourceId !== source || identity.sourceId !== source || identity.mentionId !== observer.id
    || !["resolved", "new-entity", "misidentified"].includes(identity.status) || identity.entityId !== observation.observerId) fail("PERCEPTION_OBSERVER_TRACE_MISMATCH", "The actual observer must be resolved from this occurrence's participant mention.");
  if (event.annotationType !== "event-mention" || event.sourceId !== source || !event.eventTypeCandidates.includes("perception")
    || !event.participantMentionIds.includes(observer.id) || contentHash(event.extentAnchors) !== contentHash(observation.trace.anchors)
    || resolution.sourceId !== source || !resolution.eventMentionIds.includes(event.id) || !["resolved", "new-event"].includes(resolution.status)
    || resolution.relation !== "coreference" || resolution.canonicalEventId !== observation.canonicalEventId) fail("PERCEPTION_EVENT_TRACE_MISMATCH", "The perception mention must resolve to this occurrence itself, not a later report or a different subevent.");
  if (observation.lowering.status === "mapped") for (const annotation of trace.annotations.values()) {
    if (annotation.annotationType !== "quotation") continue;
    if (observation.trace.anchors.some(anchor => anchor.sourceId === annotation.anchor.sourceId && anchor.startByte < annotation.anchor.endByte && annotation.anchor.startByte < anchor.endByte)) fail("PERCEPTION_QUOTED_REPORT", "Quoted reports cannot establish direct state perception; retain unverified source meaning until independently grounded.");
  }
  const verifier = new EvidenceVerifier(root);
  const anchors = [...observation.trace.anchors,
    ...(observer.annotationType === "entity-mention" ? [observer.anchor] : []),
    ...(event.annotationType === "event-mention" ? [event.triggerAnchor] : [])];
  for (const anchor of anchors) for (const issue of (await verifier.inspectAnchor(anchor)).issues) fail(issue.code, issue.message);
  return issues;
}

export async function validatePerceptionObservationProposalTrace(root: string, source: string, worldIds: readonly string[], annotationIds: readonly string[], identityIds: readonly string[], eventIds: readonly string[]): Promise<string[]> {
  const catalog = await loadPerceptionTraceCatalog(root, source, annotationIds, identityIds, eventIds), proposals = new ProposalStore(root), issues: string[] = [];
  for (const id of worldIds) {
    const envelope = await proposals.readEnvelope("pending", id).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (envelope?.kind !== "perception-observation") continue;
    const observation = perceptionObservationSchema.parse(envelope.payload);
    if (observation.trace.anchors.some(anchor => anchor.sourceId !== source)) issues.push(`PERCEPTION_SOURCE_MISMATCH: ${id}. ${recovery}`);
    issues.push(...(await validatePerceptionObservationTrace(root, observation, catalog)).map(issue => `${id}: ${issue.code}: ${issue.message}`));
  }
  return issues;
}

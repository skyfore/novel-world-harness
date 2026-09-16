import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { idSchema } from "../world/model.js";
import { sourceAnnotationSchema } from "./annotations.js";
import { identityResolutionSchema } from "./entity-resolution.js";
import { eventResolutionSchema } from "./event-resolution.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1);
export const upstreamRepairKindSchema = z.enum(["entity-mention", "event-mention", "quotation", "discourse-segment", "entity-resolution", "event-resolution"]);
export type UpstreamRepairKind = z.infer<typeof upstreamRepairKindSchema>;
const fields: Record<UpstreamRepairKind, readonly string[]> = {
  "entity-mention": ["anchor", "surface", "form", "kindCandidates", "sceneId", "confidence", "interpretation"],
  "event-mention": ["triggerAnchor", "trigger", "extentAnchors", "eventTypeCandidates", "participantMentionIds", "sceneId", "discourseSegmentId", "salience", "confidence", "interpretation"],
  quotation: ["anchor", "mode", "speakerMentionId", "addresseeMentionIds", "cueAnchor", "sceneId", "attributionConfidence", "interpretation"],
  "discourse-segment": ["kind", "anchors", "viewpointMentionId", "confidence", "interpretation"],
  "entity-resolution": ["mentionId", "status", "entityId", "intendedEntityId", "candidates", "aliasType", "validStoryTime", "supersedesResolutionId", "rationale"],
  "event-resolution": ["eventMentionIds", "status", "canonicalEventId", "relation", "candidates", "supersedesResolutionIds", "rationale"],
};
const refSchema = z.object({ kind: upstreamRepairKindSchema, id: idSchema }).strict();
const readableRefSchema = z.object({ kind: z.enum([...upstreamRepairKindSchema.options, "entity", "canonical-event", "proposition", "source-segment", "evidence-assertion"]), id: idSchema }).strict();
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
  predecessorReceiptRefs: z.array(hash).max(128),
  sourceScope: z.object({ sourceId: idSchema, sourceSha256: hash, segmentIds: z.array(idSchema).min(1).max(128) }).strict(),
  baselineRefs: z.array(readableRefSchema.extend({ revisionHash: hash }).strict()).max(256),
  allowedWrites: z.array(writeSchema).max(128),
  // Host allocates one exact logical ID per dependency slot; no model-chosen IDs.
  allowedCreations: z.array(refSchema.extend({ maxCount: z.literal(1), dependencyOf: text }).strict()).max(128),
  readableRefs: z.array(readableRefSchema).max(256), citableEvidenceRefs: z.array(idSchema).min(1).max(128),
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

function payloadFor(kind: UpstreamRepairKind, raw: unknown) {
  if (kind === "entity-resolution") return identityResolutionSchema.parse(raw);
  if (kind === "event-resolution") return eventResolutionSchema.parse(raw);
  const parsed = sourceAnnotationSchema.parse(raw);
  if (parsed.annotationType !== kind) throw new Error("Repair payload kind mismatch");
  return parsed;
}

function referencedKeys(kind: UpstreamRepairKind, raw: unknown): string[] {
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
  if (next.id !== input.id || next.sourceId !== plan.sourceScope.sourceId) stop("Payload identity or source escapes plan");
  for (const reference of referencedKeys(input.kind, next)) {
    if (plan.allowedCreations.some(ref => key(ref) === reference)) {
      if (!plan.dependencyEdges.some(edge => edge.from === key(input) && edge.to === reference)) stop(`Undeclared creation dependency: ${reference}`);
      continue;
    }
    if (!plan.readableRefs.some(ref => key(ref) === reference) || !plan.baselineRefs.some(ref => key(ref) === reference)) stop(`Unfrozen dependency reference: ${reference}`);
  }
  if (contentHash(next.derivation) !== contentHash(input.hostDerivation) || next.derivation.runId !== plan.batchId || next.derivation.compilerBatchId !== plan.batchId) stop("Derivation differs from host batch provenance");
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
  if (!write || !ref || contentHash(baseline) !== ref.revisionHash || baseline.id !== input.id || baseline.sourceId !== next.sourceId) stop("Mutation lacks exact frozen baseline");
  const allowed = write!.pointers.map(repairPointerTokens);
  const before = baseline as Record<string, unknown>, after = next as Record<string, unknown>;
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (field === "derivation") continue; // Independently checked against host provenance above.
    if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
    if (!allowed.some(tokens => tokens.length === 1 && tokens[0] === field)) stop(`Unauthorized field difference: /${field}`);
  }
}

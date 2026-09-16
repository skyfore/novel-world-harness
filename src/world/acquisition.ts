import { z } from "zod";
import { contentHash } from "./canonical.js";
import { idSchema, evidenceRefSchema, type Attribution, type CanonicalEvent, type Claim, type Entity, type EvidenceAssertion, type KnowledgeOperation, type Proposition, type ValidationIssue } from "./model.js";
import { type PerceptionObservation, validatePerceptionAcquisition } from "./perception-observation.js";
import type { UtteranceExpression } from "./utterance-expression.js";
import type { KnowledgeState } from "./knowledge.js";

export const ACQUISITION_VERSION = "acquisition-v1" as const;
export const acquisitionSchema = z.object({
  ontologyVersion: z.literal(ACQUISITION_VERSION), id: idSchema,
  actorId: idSchema, canonicalEventId: idSchema, cut: z.literal("event-end"),
  claimId: idSchema, propositionId: idSchema,
  basis: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("observed"), perceptionId: idSchema }).strict(),
    z.object({ mode: z.literal("told"), expressionId: idSchema, attributionId: idSchema }).strict(),
    z.object({ mode: z.literal("read"), expressionId: idSchema, attributionId: idSchema, documentId: idSchema }).strict(),
    z.object({ mode: z.literal("inferred"), premiseAcquisitionIds: z.array(idSchema).min(1).max(16), rationale: z.string().trim().min(1).max(2_000) }).strict(),
    z.object({ mode: z.literal("remembered"), priorAcquisitionId: idSchema }).strict(),
    z.object({ mode: z.literal("deceived-misattributed"), expressionId: idSchema, attributionId: idSchema, actualSourceActorId: idSchema, believedSourceActorId: idSchema }).strict(),
  ]),
  reception: z.object({ received: z.literal(true), understood: z.boolean(), belief: z.enum(["accepted", "rejected", "undecided"]) }).strict(),
  // Frozen dependencies are supplied by the host, never inferred from a later store.
  revisions: z.array(z.object({ kind: z.enum(["canonical-event", "claim", "proposition", "utterance-expression", "perception-observation", "attribution", "acquisition"]), id: idSchema, hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(2).max(24),
  evidence: z.array(evidenceRefSchema).min(1),
}).strict().superRefine((value, ctx) => {
  if (!value.reception.understood && value.reception.belief !== "undecided") ctx.addIssue({ code: "custom", path: ["reception"], message: "Receipt without understanding cannot establish belief" });
  if (value.basis.mode === "inferred" && new Set(value.basis.premiseAcquisitionIds).size !== value.basis.premiseAcquisitionIds.length) ctx.addIssue({ code: "custom", path: ["basis", "premiseAcquisitionIds"], message: "Inference premises must be unique" });
});
export type Acquisition = z.infer<typeof acquisitionSchema>;
export const acquisitionInputSchema = z.object(acquisitionSchema.shape).strict().omit({ revisions: true, evidence: true });
export type AcquisitionCatalog = {
  sourceEventRevisions?: ReadonlyMap<string, string>;
  entities: ReadonlyMap<string, Entity>; events: ReadonlyMap<string, CanonicalEvent>;
  claims: ReadonlyMap<string, Claim>; propositions: ReadonlyMap<string, Proposition>;
  attributions: ReadonlyMap<string, Attribution>; utteranceExpressions?: ReadonlyMap<string, UtteranceExpression>;
  perceptionObservations?: ReadonlyMap<string, PerceptionObservation>; acquisitions?: ReadonlyMap<string, Acquisition>;
};
export function acquisitionDependencies(value: Pick<Acquisition, "canonicalEventId" | "claimId" | "propositionId" | "basis">): Array<{ kind: Acquisition["revisions"][number]["kind"]; id: string }> {
  const refs: ReturnType<typeof acquisitionDependencies> = [{ kind: "canonical-event", id: value.canonicalEventId }, { kind: "claim", id: value.claimId }, { kind: "proposition", id: value.propositionId }];
  const basis = value.basis;
  if ("expressionId" in basis) refs.push({ kind: "utterance-expression", id: basis.expressionId }, { kind: "attribution", id: basis.attributionId });
  if (basis.mode === "observed") refs.push({ kind: "perception-observation", id: basis.perceptionId });
  if (basis.mode === "remembered") refs.push({ kind: "acquisition", id: basis.priorAcquisitionId });
  if (basis.mode === "inferred") refs.push(...basis.premiseAcquisitionIds.map(id => ({ kind: "acquisition" as const, id })));
  return refs;
}
function dependency(catalog: AcquisitionCatalog, ref: { kind: string; id: string }): unknown {
  return ({ "canonical-event": catalog.events, claim: catalog.claims, proposition: catalog.propositions, attribution: catalog.attributions, "utterance-expression": catalog.utteranceExpressions, "perception-observation": catalog.perceptionObservations, acquisition: catalog.acquisitions } as Record<string, ReadonlyMap<string, unknown> | undefined>)[ref.kind]?.get(ref.id);
}
export function hydrateAcquisition(input: unknown, evidence: Acquisition["evidence"], catalog: AcquisitionCatalog): Acquisition {
  const parsed = acquisitionInputSchema.parse(input);
  const revisions = acquisitionDependencies(parsed).map(ref => {
    const payload = dependency(catalog, ref);
    if (!payload) throw new Error(`ACQUISITION_DEPENDENCY_MISSING: ${ref.kind}/${ref.id}. Use same-source find_compiler_artifacts with that kind, copy results[].readArguments.ref into read_compiler_artifact.ref and payload.id into the logical field. At most one corrected retry; if absent or outside authority, preserve drafts and stop. Never guess.`);
    return { ...ref, hash: contentHash(payload) };
  });
  return acquisitionSchema.parse({ ...parsed, revisions, evidence });
}

export function validateAcquisition(value: Acquisition, catalog: AcquisitionCatalog): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fail = (code: string, message: string, path = "basis") => issues.push({ code, message, path });
  const event = catalog.events.get(value.canonicalEventId), actor = catalog.entities.get(value.actorId);
  if (actor?.kind !== "character" || !event?.participants.includes(value.actorId)) fail("ACQUISITION_OCCURRENCE_MISMATCH", "Acquisition requires its actual character recipient in the acquiring occurrence", "actorId");
  if (value.evidence.some(ref => !event?.evidence.some(e => e.span.sourceId === ref.span.sourceId && e.span.startByte !== undefined && e.span.endByte !== undefined && ref.span.startByte !== undefined && ref.span.endByte !== undefined && e.span.startByte <= ref.span.startByte && ref.span.endByte <= e.span.endByte))) fail("ACQUISITION_OCCURRENCE_MISMATCH", "Acquisition evidence belongs to its acquiring event, not an earlier expression or later report", "evidence");
  const expected = acquisitionDependencies(value);
  if (value.revisions.length !== expected.length || new Set(value.revisions.map(ref => `${ref.kind}/${ref.id}`)).size !== expected.length) fail("ACQUISITION_REVISION_MISMATCH", "Acquisition must freeze exactly its typed dependencies", "revisions");
  for (const ref of expected) {
    const record = dependency(catalog, ref), frozen = value.revisions.find(item => item.kind === ref.kind && item.id === ref.id);
    const hash = ref.kind === "canonical-event" && catalog.sourceEventRevisions?.has(ref.id) ? catalog.sourceEventRevisions.get(ref.id) : record ? contentHash(record) : undefined;
    if (!record || !frozen || hash !== frozen.hash) fail("ACQUISITION_REVISION_MISMATCH", `Acquisition requires frozen ${ref.kind}/${ref.id}; stop for host source review`, "revisions");
    if (ref.kind === "acquisition" && ref.id === value.id) fail("ACQUISITION_DEPENDENCY_CYCLE", "Acquisition cannot use itself as prior experience");
  }
  const proposition = catalog.propositions.get(value.propositionId), claim = catalog.claims.get(value.claimId);
  if (proposition && claim && (claim.object === undefined || claim.subject !== proposition.subjectEntityId || claim.predicate !== proposition.relationId || contentHash(claim.object) !== contentHash(proposition.object.kind === "entity" ? proposition.object.entityId : proposition.object.kind === "literal" ? proposition.object.value : { propositionId: proposition.object.propositionId }))) fail("ACQUISITION_CONTENT_MISMATCH", "Claim and proposition must describe the same acquired content");
  const basis = value.basis;
  if ("expressionId" in basis) {
    const expression = catalog.utteranceExpressions?.get(basis.expressionId), attribution = catalog.attributions.get(basis.attributionId);
    if (!expression || expression.propositionId !== value.propositionId || !expression.addresseeIds.includes(value.actorId) || !attribution?.expressionIds?.includes(basis.expressionId) || attribution.propositionId !== value.propositionId) fail("ACQUISITION_CONTENT_MISMATCH", "Acquisition requires this expression's recipient and content with its bound attribution");
    if (basis.mode === "read") {
      if (expression?.modality !== "writing" || expression.documentId !== basis.documentId || attribution?.holderEntityId !== basis.documentId || !event?.participants.includes(basis.documentId) || !event.participantPresence?.some(item => item.entityId === value.actorId && item.mode === "physical")) fail("ACQUISITION_CONTENT_MISMATCH", "Read acquisition must retain its document expression and reading occurrence");
    } else if (expression?.modality !== "speech" || expression.canonicalEventId !== value.canonicalEventId) fail("ACQUISITION_OCCURRENCE_MISMATCH", "Spoken receipt must occur in this speech event; later recollection requires remembered mode");
    if (basis.mode === "deceived-misattributed" && (expression?.speakerId !== basis.actualSourceActorId || !catalog.entities.has(basis.believedSourceActorId))) fail("ACQUISITION_SOURCE_MISMATCH", "Deception must preserve both actual and believed source identities");
  }
  if (basis.mode === "observed") issues.push(...validatePerceptionAcquisition({ op: "learn", actorId: value.actorId, claimId: value.claimId, propositionId: value.propositionId, acquisitionMode: "observed", perceptionId: basis.perceptionId, status: "heard", confidence: 1 }, { observations: catalog.perceptionObservations ?? new Map(), propositions: catalog.propositions }, undefined, value.canonicalEventId));
  for (const ref of expected.filter(ref => ref.kind === "acquisition")) {
    const prior = catalog.acquisitions?.get(ref.id);
    if (!prior || prior.actorId !== value.actorId || (basis.mode === "remembered" && prior.propositionId !== value.propositionId)) fail("ACQUISITION_PRIOR_MISMATCH", "Prior experience must belong to this actor, and memory must preserve its content");
    if (prior?.canonicalEventId === value.canonicalEventId) fail("ACQUISITION_PRIOR_MISMATCH", "Prior experience must precede this acquiring event, not be manufactured in the same cut");
  }
  // Bounded traversal rejects cycles even when the referenced records were supplied together.
  const visited = new Set<string>();
  let visits = 0;
  const visit = (id: string, path: Set<string>, depth: number): void => {
    if (path.has(id) || depth > 32) { fail("ACQUISITION_DEPENDENCY_CYCLE", "Prior experience graph is cyclic or exceeds 32 levels"); return; }
    if (visited.has(id)) return;
    if (++visits > 128) { if (visits === 129) fail("ACQUISITION_DEPENDENCY_CYCLE", "Prior experience graph exceeds 128 records; stop for bounded host review"); return; }
    const record = id === value.id ? value : catalog.acquisitions?.get(id);
    if (!record) return;
    for (const ref of acquisitionDependencies(record)) if (ref.kind === "acquisition") visit(ref.id, new Set([...path, id]), depth + 1);
    visited.add(id);
  };
  visit(value.id, new Set(), 0);
  return issues;
}
export function validateAcquisitionEvidence(value: Acquisition, assertions: readonly EvidenceAssertion[]): ValidationIssue[] {
  const paths = ["/actorId", "/canonicalEventId", "/cut", "/claimId", "/propositionId", "/reception/received", "/reception/understood", "/reception/belief",
    ...Object.keys(value.basis).map(key => `/basis/${key}`)];
  return paths.filter(pointer => !assertions.some(item => item.target.artifactKind === "acquisition" && item.target.artifactId === value.id && item.target.jsonPointer === pointer && item.relation === "supports" && item.strength !== "weak-inference" && item.anchors.length && item.anchors.every(anchor => value.evidence.some(ref => ref.span.sourceId === anchor.sourceId && ref.span.startByte !== undefined && ref.span.endByte !== undefined && ref.span.startByte <= anchor.startByte && anchor.endByte <= ref.span.endByte))))
    .map(path => ({ code: "ACQUISITION_EVIDENCE_MISSING", message: `Acquisition ${value.id} requires independent occurrence evidence for ${path}`, path }));
}
export type AcquisitionReceipt = { acquisitionId: string; revisionHash: string; actorId: string; propositionId: string; acquiredAtCommit: string; reception: Acquisition["reception"] };
/** Compiler proposals remain dormant; only a committed branch occurrence is experience. */
export function validateAcquisitionOperation(operation: KnowledgeOperation, catalog: AcquisitionCatalog, runtime?: {
  knowledge: KnowledgeState; currentEventIds?: ReadonlySet<string>; realizedEventIds?: ReadonlySet<string>;
}, canonicalEventId?: string): ValidationIssue[] {
  if (operation.op !== "learn") return [];
  if (!operation.acquisitionId) {
    if ([...(catalog.acquisitions?.values() ?? [])].some(value => value.actorId === operation.actorId && value.claimId === operation.claimId)) return [{ code: "ACQUISITION_REQUIRED", message: "This frozen content has an explicit acquisition contract. Preserve acquisitionId and its mode; do not delete provenance to fall back to legacy knowledge.", path: "acquisitionId" }];
    return [];
  }
  const fail = (code: string, message: string): ValidationIssue[] => [{ code, message, path: "acquisitionId" }];
  const value = catalog.acquisitions?.get(operation.acquisitionId);
  if (!value) return fail("ACQUISITION_DEPENDENCY_MISSING", "Acquisition is absent from this frozen scope; stop at runtime, or discover same-source acquisition with find_compiler_artifacts and copy results[].readArguments.ref into read_compiler_artifact.ref and payload.id into acquisitionId for one corrected compiler retry.");
  if (value.actorId !== operation.actorId || value.claimId !== operation.claimId || value.propositionId !== operation.propositionId || value.basis.mode !== operation.acquisitionMode) return fail("ACQUISITION_CONTENT_MISMATCH", "Operation must preserve the compiled recipient, content and mode; do not delete provenance or relabel.");
  const basis = value.basis, status = !value.reception.understood || value.reception.belief === "undecided" ? "heard" : value.reception.belief === "rejected" ? "disbelieves" : "believes";
  if (operation.status !== status) return fail("ACQUISITION_RECEPTION_MISMATCH", "Receipt, understanding and belief are independent evidence. Operation status must match the source-grounded reception; acquisition does not certify world truth.");
  if (("expressionId" in basis ? basis.expressionId : undefined) !== operation.expressionId || ("attributionId" in basis ? basis.attributionId : undefined) !== operation.attributionId || (basis.mode === "observed" ? basis.perceptionId : undefined) !== operation.perceptionId) return fail("ACQUISITION_CONTENT_MISMATCH", "Operation must retain exactly the typed basis references");
  const source = basis.mode === "told" ? catalog.utteranceExpressions?.get(basis.expressionId)?.speakerId : basis.mode === "deceived-misattributed" ? basis.actualSourceActorId : undefined;
  if (operation.sourceActorId !== source) return fail("ACQUISITION_SOURCE_MISMATCH", "Actual source is distinct from believed source and must remain intact");
  if (canonicalEventId && value.canonicalEventId !== canonicalEventId) return fail("ACQUISITION_CUT_NOT_CURRENT", "Acquisition must belong to this acquiring event, not an earlier report or another cut; stop for source review.");
  if (!runtime) return [];
  if (runtime.currentEventIds && !runtime.currentEventIds.has(value.canonicalEventId)) return fail("ACQUISITION_CUT_NOT_CURRENT", "Acquisition requires this branch's current acquiring event cut; preserve head and stop. Future canon is not experience.");
  if ("expressionId" in basis) {
    const expression = catalog.utteranceExpressions?.get(basis.expressionId);
    if (runtime.realizedEventIds && (!expression || !runtime.realizedEventIds.has(expression.canonicalEventId))) return fail("ACQUISITION_EXPRESSION_NOT_REALIZED", "Expression has not occurred on this branch; stop without importing future canon.");
  }
  for (const ref of acquisitionDependencies(value).filter(ref => ref.kind === "acquisition")) {
    const prior = catalog.acquisitions?.get(ref.id), receipt = runtime.knowledge.acquisitions?.[ref.id];
    if (!prior || !receipt || receipt.revisionHash !== contentHash(prior) || receipt.actorId !== value.actorId || !receipt.reception.understood) return fail("ACQUISITION_PRIOR_NOT_REALIZED", "This actor lacks the committed understood experience; stop. Another actor's knowledge and compiler history cannot substitute.");
    if (basis.mode === "inferred" && (receipt.reception.belief !== "accepted" || !Object.values(runtime.knowledge.actors[value.actorId] ?? {}).some(fact => fact.acquisitionId === prior.id && fact.propositionId === prior.propositionId && (fact.status === "knows" || fact.status === "believes")))) return fail("ACQUISITION_PREMISE_UNAVAILABLE", "Inference requires each premise to remain available and accepted in this actor's pre-event knowledge; stop rather than invent premises.");
  }
  return [];
}

export function acquisitionCatalog(context: { sourceEventRevisions?: ReadonlyMap<string, string>; entities: AcquisitionCatalog["entities"]; events?: AcquisitionCatalog["events"]; claims?: AcquisitionCatalog["claims"]; propositions?: AcquisitionCatalog["propositions"]; attributions?: AcquisitionCatalog["attributions"]; utteranceExpressions?: AcquisitionCatalog["utteranceExpressions"]; perceptionObservations?: AcquisitionCatalog["perceptionObservations"]; acquisitions?: AcquisitionCatalog["acquisitions"] }): AcquisitionCatalog {
  return { ...context, events: context.events ?? new Map(), claims: context.claims ?? new Map(), propositions: context.propositions ?? new Map(), attributions: context.attributions ?? new Map() };
}

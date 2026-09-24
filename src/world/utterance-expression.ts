import crypto from "node:crypto";
import { z } from "zod";
import { contentHash } from "./canonical.js";
import { assessExpressionObjectSupport } from "./expression-content.js";
import { evidenceRefSchema, idSchema, propositionSchema, textAnchorSchema,
  type Attribution, type KnowledgeOperation, type CanonicalEvent, type Entity, type EvidenceAssertion, type Proposition, type TextAnchor, type ValidationIssue } from "./model.js";

const revisionHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const UTTERANCE_EXPRESSION_VERSION = "utterance-expression-v1" as const;
export const utteranceExpressionSchema = z.object({
  ontologyVersion: z.literal(UTTERANCE_EXPRESSION_VERSION), id: idSchema,
  canonicalEventId: idSchema, speakerId: idSchema,
  addresseeIds: z.array(idSchema).max(32).refine(ids => new Set(ids).size === ids.length, "Expression addressees must be unique"),
  modality: z.enum(["speech", "writing", "thought"]),
  documentId: idSchema.optional(),
  quotation: z.object({ quotationId: idSchema, revisionHash: revisionHashSchema, anchor: textAnchorSchema }).strict(),
  // Fragments remain separate. Gaps never become a fabricated continuous quote.
  fragments: z.array(z.object({ anchor: textAnchorSchema, text: z.string().min(1).max(16_000) }).strict()).min(1).max(32),
  propositionId: idSchema,
  propositions: z.array(z.object({ propositionId: idSchema, revisionHash: revisionHashSchema, snapshot: propositionSchema }).strict()).min(1).max(128),
  evidence: z.array(evidenceRefSchema).min(1),
}).strict().superRefine((value, ctx) => {
  if ((value.modality === "writing") !== Boolean(value.documentId)) ctx.addIssue({ code: "custom", path: ["documentId"], message: "Only writing requires its containing document; the document is not the speaker" });
  const seen = new Set<string>();
  for (const [index, item] of value.propositions.entries()) {
    if (seen.has(item.propositionId) || item.propositionId !== item.snapshot.id || item.revisionHash !== contentHash(item.snapshot)) {
      ctx.addIssue({ code: "custom", path: ["propositions", index], message: "Expression proposition snapshots must have unique matching IDs and exact revision hashes" });
    }
    seen.add(item.propositionId);
  }
  if (!seen.has(value.propositionId)) ctx.addIssue({ code: "custom", path: ["propositionId"], message: "Expression root requires its frozen proposition snapshot" });
  let previousEnd = value.quotation.anchor.startByte;
  for (const [index, fragment] of value.fragments.entries()) {
    if (!contains(value.quotation.anchor, fragment.anchor) || fragment.anchor.startByte < previousEnd) {
      ctx.addIssue({ code: "custom", path: ["fragments", index, "anchor"], message: "Expression fragments must be ordered, non-overlapping and inside this quotation" });
    }
    if (Buffer.byteLength(fragment.text, "utf8") !== fragment.anchor.endByte - fragment.anchor.startByte
      || crypto.createHash("sha256").update(fragment.text, "utf8").digest("hex") !== fragment.anchor.exactHash) {
      ctx.addIssue({ code: "custom", path: ["fragments", index, "text"], message: "Fragment text must preserve exact source UTF-8 bytes" });
    }
    previousEnd = fragment.anchor.endByte;
  }
});
export type UtteranceExpression = z.infer<typeof utteranceExpressionSchema>;

export function validateUtteranceExpression(expression: UtteranceExpression, catalog: {
  entities: ReadonlyMap<string, Entity>; events: ReadonlyMap<string, CanonicalEvent>; propositions: ReadonlyMap<string, Proposition>;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fail = (code: string, message: string, path: string) => issues.push({ code, message, path });
  const event = catalog.events.get(expression.canonicalEventId);
  if (!event) fail("EXPRESSION_EVENT_MISSING", "Expression occurrence is missing", "canonicalEventId");
  if (expression.documentId && (catalog.entities.get(expression.documentId)?.kind !== "artifact" || !event?.participants.includes(expression.documentId))) {
    fail("EXPRESSION_DOCUMENT_MISMATCH", "Written expression requires its artifact document in the occurrence", "documentId");
  }
  for (const [path, id] of [["speakerId", expression.speakerId], ...expression.addresseeIds.map((id, i) => [`addresseeIds.${i}`, id])] as Array<[string, string]>) {
    if (!catalog.entities.has(id)) fail("EXPRESSION_ENTITY_MISSING", `Expression participant ${id} is missing`, path);
    if (event && !event.participants.includes(id)) fail("EXPRESSION_PARTICIPANT_OUTSIDE_EVENT", `Expression participant ${id} is outside its occurrence`, path);
  }
  for (const [index, item] of expression.propositions.entries()) {
    const proposition = catalog.propositions.get(item.propositionId);
    if (!proposition || contentHash(proposition) !== item.revisionHash) fail("EXPRESSION_PROPOSITION_REVISION_MISMATCH", `Expression requires its exact proposition revision ${item.propositionId}`, `propositions.${index}.revisionHash`);
  }
  const sourceId = expression.quotation.anchor.sourceId;
  if (expression.evidence.some(ref => ref.span.sourceId !== sourceId)
    || event?.evidence.some(ref => ref.span.sourceId !== sourceId)
    || expression.propositions.some(item => item.snapshot.evidence.some(ref => ref.span.sourceId !== sourceId))) {
    fail("EXPRESSION_SOURCE_MISMATCH", "Expression and proposition revisions must belong to the same source", "evidence");
  }
  if (event && expression.fragments.some(fragment => !event.evidence.some(ref => ref.span.sourceId === sourceId
    && ref.span.startByte !== undefined && ref.span.endByte !== undefined
    && ref.span.startByte <= fragment.anchor.startByte && fragment.anchor.endByte <= ref.span.endByte))) {
    fail("EXPRESSION_OCCURRENCE_EVIDENCE_MISMATCH", "Every expression fragment requires byte evidence in its own canonical occurrence", "canonicalEventId");
  }
  return issues;
}

export function validateAttributionExpressions(attribution: Attribution, expressions: ReadonlyMap<string, UtteranceExpression>): ValidationIssue[] {
  return (attribution.expressionIds ?? []).flatMap(id => {
    const expression = expressions.get(id);
    return expression && expression.propositionId === attribution.propositionId
      && (attribution.holderKind === "document" ? expression.documentId : expression.speakerId) === attribution.holderEntityId
      && attribution.quotationIds?.includes(expression.quotation.quotationId) ? [] : [{
        code: "ATTRIBUTION_EXPRESSION_MISMATCH", message: `Attribution ${attribution.id} requires its own speaker, proposition and quotation in expression ${id}`, path: "expressionIds",
      }];
  });
}

/** No expression is inferred for legacy records. Canonical existence is not occurrence. */
export function validateExpressionAcquisition(operation: KnowledgeOperation, expressions: ReadonlyMap<string, UtteranceExpression>,
  realizedCanonicalEventIds?: ReadonlySet<string>, attributions?: ReadonlyMap<string, Attribution>): ValidationIssue[] {
  if (operation.op !== "learn" || operation.acquisitionId) return [];
  const fail = (code: string, message: string): ValidationIssue[] => [{ code, message, path: "expressionId" }];
  const bound = operation.attributionId ? attributions?.get(operation.attributionId)?.expressionIds : undefined;
  if (bound?.length && (!operation.expressionId || !bound.includes(operation.expressionId))) return fail("ACQUISITION_EXPRESSION_REQUIRED", "This attribution requires its explicit expression proof. Preserve attribution, proposition and acquisition mode; discover the named expression in the same scope and make at most one corrected retry. Stop if unavailable; do not remove the reference to fall back to legacy acquisition.");
  if (!operation.expressionId) return [];
  const expression = expressions.get(operation.expressionId);
  if (!expression) return fail("ACQUISITION_EXPRESSION_MISSING", "The expression is absent from this frozen world context. For compiler proposals, use same-source find_compiler_artifacts (kind utterance-expression), copy results[].readArguments.ref into read_compiler_artifact.ref and payload.id into expressionId; allow at most one corrected retry. At runtime preserve the head and stop for host compilation; do not consult compiler omniscience, guess or retry unchanged.");
  if (expression.propositionId !== operation.propositionId || !expression.addresseeIds.includes(operation.actorId)
    || (operation.acquisitionMode === "told" && (expression.modality !== "speech" || expression.speakerId !== operation.sourceActorId))
    || (operation.acquisitionMode === "read" && (expression.modality !== "writing"
      || (attributions && expression.documentId !== attributions.get(operation.attributionId ?? "")?.holderEntityId)))
    || (operation.acquisitionMode !== "told" && operation.acquisitionMode !== "read")) {
    return fail("ACQUISITION_EXPRESSION_MISMATCH", "Acquisition must preserve this expression's mode, content, speaker and addressee. Inspect source evidence once; stop if unsupported. Do not change acquisition mode or remove the expression reference to bypass this failure.");
  }
  if (realizedCanonicalEventIds && !realizedCanonicalEventIds.has(expression.canonicalEventId)) return fail("ACQUISITION_EXPRESSION_NOT_REALIZED", "This expression has not occurred on the branch. Preserve the branch head and stop; future canon is not acquisition evidence. Do not retry or relabel the source as observed.");
  return [];
}

/** This artifact's proofs only: another occurrence's proposition evidence grants nothing. */
export function validateUtteranceExpressionEvidence(expression: UtteranceExpression, assertions: readonly EvidenceAssertion[]): ValidationIssue[] {
  const own = assertions.filter(item => item.target.artifactKind === "utterance-expression" && item.target.artifactId === expression.id
    && item.relation === "supports" && item.strength !== "weak-inference");
  const supported = (pointer: string, content: boolean) => own.some(item => item.target.jsonPointer === pointer && item.anchors.length > 0
    && (!content || item.anchors.every(anchor => expression.fragments.some(fragment => contains(fragment.anchor, anchor)))));
  const required = ["/canonicalEventId", "/speakerId", "/modality", "/quotation/quotationId", "/propositionId", ...(expression.documentId ? ["/documentId"] : []), ...expression.addresseeIds.map((_, index) => `/addresseeIds/${index}`)];
  const issues: ValidationIssue[] = required.filter(pointer => !supported(pointer, false))
    .map(path => ({ code: "EXPRESSION_FIELD_EVIDENCE_MISSING", message: `Expression ${expression.id} requires its own exact support at ${path}`, path }));
  const translated: EvidenceAssertion[] = [];
  for (const [index, item] of expression.propositions.entries()) {
    const prefix = `/propositions/${index}/snapshot`;
    for (const key of ["subjectEntityId", "relationId", "polarity", "modality", ...(item.snapshot.validStoryTime ? ["validStoryTime"] : [])]) {
      const path = `${prefix}/${key}`;
      if (!supported(path, true)) issues.push({ code: "EXPRESSION_CONTENT_MISSING", message: `Expression ${expression.id} lacks in-fragment semantic support at ${path}`, path });
    }
    for (const assertion of own.filter(assertion => assertion.target.jsonPointer.startsWith(`${prefix}/object`))) {
      translated.push({ ...assertion, target: { artifactKind: "proposition", artifactId: item.propositionId, jsonPointer: assertion.target.jsonPointer.slice(prefix.length) } });
    }
  }
  const assessment = assessExpressionObjectSupport(expression.propositionId,
    new Map(expression.propositions.map(item => [item.propositionId, item.snapshot])), translated, expression.fragments.map(item => item.anchor));
  for (const issue of assessment.issues) issues.push({ code: issue.code, message: `${issue.code}: ${issue.propositionId} is not supported by this expression's ordered fragments`, path: "propositions" });
  const reachable = new Set(assessment.objects.map(item => item.propositionId));
  for (const item of expression.propositions) if (!reachable.has(item.propositionId)) issues.push({ code: "EXPRESSION_UNUSED_PROPOSITION", message: `Unrelated proposition ${item.propositionId} cannot be attached to this expression`, path: "propositions" });
  return issues;
}

function contains(outer: Pick<TextAnchor, "sourceId" | "startByte" | "endByte">, inner: Pick<TextAnchor, "sourceId" | "startByte" | "endByte">): boolean {
  return outer.sourceId === inner.sourceId && outer.startByte <= inner.startByte && inner.endByte <= outer.endByte;
}

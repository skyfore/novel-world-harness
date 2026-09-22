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

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1);
const candidates = z.array(z.object({ id: idSchema, revisionHash: hash }).strict()).max(32)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, "Duplicate candidate identity");
/** Host-reviewed diagnostics, never inferred by parsing error messages. */
export const upstreamRepairReviewSchema = z.object({
  version: z.literal(1), sourceId: idSchema, sourceSha256: hash,
  planId: idSchema, batchId: idSchema, requirementSetHash: hash,
  requirementIds: z.array(text).min(1).max(128), predecessorReceiptRefs: z.array(hash).max(128),
  segmentIds: z.array(idSchema).min(1).max(128), citableEvidenceRefs: z.array(idSchema).min(1).max(128),
  authorizationRef: text, retryBudgetRef: idSchema,
  diagnostics: z.array(z.discriminatedUnion("code", [
    z.object({ code: z.literal("QUOTATION_ANCHOR_INCOMPLETE"), quotationId: idSchema, revisionHash: hash, expectedAnchor: textAnchorSchema, requirementId: text }).strict(),
    z.object({ code: z.literal("QUOTATION_SPEAKER_MENTION_MISSING"), quotationId: idSchema, revisionHash: hash, requirementId: text }).strict(),
    z.object({ code: z.literal("ENTITY_RESOLUTION_MISSING"), mentionId: idSchema, revisionHash: hash, requirementId: text, candidates }).strict(),
    z.object({ code: z.literal("EVENT_RESOLUTION_MISSING"), mentionId: idSchema, revisionHash: hash, requirementId: text, candidates }).strict(),
    z.object({ code: z.literal("ENTITY_RESOLUTION_REVISION"), mentionId: idSchema, revisionHash: hash, resolutionId: idSchema, resolutionHash: hash, requirementId: text, candidates }).strict(),
    z.object({ code: z.literal("EVENT_RESOLUTION_REVISION"), mentionId: idSchema, revisionHash: hash, resolutionId: idSchema, resolutionHash: hash, requirementId: text, candidates }).strict(),
    z.object({ code: z.literal("SEMANTIC_MODULE_REQUIRED"), requirementId: text, semanticKind: text }).strict(),
  ])).min(1).max(128),
}).strict();

/** Build immutable policy from actual typed dependencies. Does not register or authorize it. */
export async function planUpstreamRepair(root: string, raw: unknown) {
  const review = upstreamRepairReviewSchema.parse(raw), reviewHash = contentHash(review);
  if (review.diagnostics.some(item => !review.requirementIds.includes(item.requirementId))) throw upstreamRepairHostError("Diagnostic escapes the selected independent requirements");
  const source = await WorkspaceStore.openReadOnly(root).getSource(review.sourceId);
  if (!source || source.contentSha256 !== review.sourceSha256) throw upstreamRepairHostError("Reviewed source revision is no longer registered");
  const bytes = await readSourceMaterial(root, source);
  const annotations = await new SourceAnnotationStore(root).list(review.sourceId);
  const baselines = new Map<string, UpstreamRepairPlan["baselineRefs"][number]>();
  const writes = new Map<string, UpstreamRepairPlan["allowedWrites"][number]>();
  const creations = new Map<string, UpstreamRepairPlan["allowedCreations"][number]>();
  const absences = new Map<string, NonNullable<UpstreamRepairPlan["resolutionAbsences"]>[number]>();
  const revisions: NonNullable<UpstreamRepairPlan["resolutionRevisions"]> = [];
  const edges = new Map<string, UpstreamRepairPlan["dependencyEdges"][number]>();
  const edge = (from: string, to: string, purpose: UpstreamRepairPlan["dependencyEdges"][number]["purpose"]) => edges.set(`${from}\0${to}`, { from, to, purpose });
  const unsupported = review.diagnostics.filter(item => item.code === "SEMANTIC_MODULE_REQUIRED");
  if (unsupported.length) return { authority: "diagnostic-only" as const, status: "needs-host-review" as const, reviewHash, diagnostics: unsupported, plan: null };
  const [entityResolutions, eventResolutions, records] = await Promise.all([
    new EntityResolutionStore(root).list(review.sourceId), new EventResolutionStore(root).list(review.sourceId),
    loadCompilerArtifactRecords(root, review.sourceId),
  ]);
  for (const diagnostic of review.diagnostics) {
    if (diagnostic.code === "SEMANTIC_MODULE_REQUIRED") continue;
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
    sourceScope: { sourceId: source.id, sourceSha256: review.sourceSha256, segmentIds: review.segmentIds },
    baselineRefs: ordered(baselines.values()), readableRefs: ordered(baselines.values()).map(({ kind, id }) => ({ kind, id })),
    allowedWrites: ordered(writes.values()), allowedCreations: ordered(creations.values()),
    ...(revisions.length ? { resolutionRevisions: revisions } : {}),
    ...(absences.size ? { resolutionAbsences: ordered(absences.values()) } : {}),
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
  return { authority: "diagnostic-only" as const, status: "ready-for-host-authorization" as const, reviewHash, diagnostics: review.diagnostics, plan };
}

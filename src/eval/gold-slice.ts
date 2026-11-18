import crypto from "node:crypto";
import { z } from "zod";
import type { PreparedNovelBundle } from "../compiler/prepared-cache.js";
import type { LoadedReferencePack } from "../compiler/reference-pack.js";
import type { ByteRange } from "../compiler/world-completeness.js";
import { compilerSemanticGoldSchema, evaluateCompilerAgainstGold, type CompilerSemanticGold, type SemanticLayerMetric, type SemanticLayerName } from "./compiler-eval.js";

/**
 * Gold slice (iteration 02, M2): a hand-checked semantic gold over one source
 * byte range (2–3 scenes, ~20 KB). It wraps the existing version-2 semantic
 * gold so the 13-layer scorer measures it, and records where each record came
 * from. A slice drafted from a legacy reference pack is a starting point
 * only: every record must be confirmed against the source before it scores.
 */
export const GOLD_SLICE_VERSION = 1 as const;

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const goldSliceSchema = z.object({
  version: z.literal(GOLD_SLICE_VERSION),
  kind: z.literal("nwh-gold-slice"),
  name: z.string().min(1),
  source: z.object({ id: z.string().min(1), sha256: digest }).strict(),
  range: z.object({ startByte: z.number().int().nonnegative(), endByte: z.number().int().positive() }).strict(),
  provenance: z.object({
    drafted: z.enum(["manual", "legacy-reference"]),
    referencePack: z.object({ directory: z.string().min(1), manifestSha256: digest }).strict().optional(),
    /** Records a human confirmed against the source text. Legacy drafts score only when every record is confirmed. */
    confirmedRecordIds: z.array(z.string().min(1)).default([]),
    reviewer: z.string().min(1).optional(),
    reviewedAt: z.string().datetime().optional(),
    notes: z.string().optional(),
  }).strict(),
  gold: compilerSemanticGoldSchema,
}).strict().superRefine((slice, ctx) => {
  if (slice.range.endByte <= slice.range.startByte) ctx.addIssue({ code: "custom", path: ["range"], message: "range end must follow its start" });
  if (slice.provenance.drafted === "legacy-reference" && !slice.provenance.referencePack) ctx.addIssue({ code: "custom", path: ["provenance", "referencePack"], message: "a legacy draft must name its reference pack" });
  const inside = (span: { sourceId: string; startByte: number; endByte: number }) => span.sourceId === slice.source.id && span.startByte >= slice.range.startByte && span.endByte <= slice.range.endByte;
  slice.gold.semantic.mentions.forEach((mention, index) => { if (!inside(mention.span)) ctx.addIssue({ code: "custom", path: ["gold", "semantic", "mentions", index, "span"], message: "outside the slice range or source" }); });
  slice.gold.semantic.quotations.forEach((quotation, index) => { if (!inside(quotation.span)) ctx.addIssue({ code: "custom", path: ["gold", "semantic", "quotations", index, "span"], message: "outside the slice range or source" }); });
  const ids = new Set(sliceRecordIds(slice.gold));
  slice.provenance.confirmedRecordIds.forEach((id, index) => { if (!ids.has(id)) ctx.addIssue({ code: "custom", path: ["provenance", "confirmedRecordIds", index], message: `unknown record '${id}'` }); });
});
export type GoldSlice = z.infer<typeof goldSliceSchema>;

/** Records a reviewer must confirm: mentions, quotations and the clusters that bind them. */
export function sliceRecordIds(gold: CompilerSemanticGold): string[] {
  return [...gold.semantic.mentions, ...gold.semantic.quotations, ...gold.semantic.entityClusters, ...gold.semantic.eventClusters].map((record) => record.id);
}

export function unconfirmedRecords(slice: GoldSlice): string[] {
  const confirmed = new Set(slice.provenance.confirmedRecordIds);
  return slice.provenance.drafted === "manual" ? [] : sliceRecordIds(slice.gold).filter((id) => !confirmed.has(id));
}

const overlaps = (left: ByteRange, right: ByteRange) => left.startByte < right.endByte && right.startByte < left.endByte;
const within = (anchor: ByteRange, range: ByteRange) => anchor.startByte >= range.startByte && anchor.endByte <= range.endByte;
const evidenceIn = (evidence: readonly { span: { startByte?: number; endByte?: number } }[], range: ByteRange) =>
  evidence.some(({ span }) => span.startByte !== undefined && span.endByte !== undefined && overlaps({ startByte: span.startByte, endByte: span.endByte }, range));

/** The candidate as seen from one range: observations inside it and canonical artifacts whose evidence or mentions touch it. */
export function restrictBundleToRange(bundle: PreparedNovelBundle, range: ByteRange): PreparedNovelBundle {
  const snapshot = bundle.compilerSnapshot;
  const annotations = snapshot.annotations.filter((item) => {
    switch (item.annotationType) {
      case "entity-mention": case "quotation": return within(item.anchor, range);
      case "event-mention": return within(item.triggerAnchor, range);
      case "discourse-segment": return item.anchors.some((anchor) => overlaps(anchor, range));
    }
  });
  const kept = new Set(annotations.map((item) => item.id));
  const eventResolutions = snapshot.eventResolutions.map((item) => ({ ...item, eventMentionIds: item.eventMentionIds.filter((id) => kept.has(id)) })).filter((item) => item.eventMentionIds.length > 0);
  const resolvedEvents = new Set(eventResolutions.flatMap((item) => item.canonicalEventId ? [item.canonicalEventId] : []));
  const events = bundle.canonical.events.filter((event) => resolvedEvents.has(event.id) || evidenceIn(event.evidence, range));
  const eventIds = new Set(events.map((event) => event.id));
  return {
    ...bundle,
    canonical: {
      ...bundle.canonical,
      events,
      eventParticipations: bundle.canonical.eventParticipations.filter((item) => eventIds.has(item.eventId)),
      eventRelations: bundle.canonical.eventRelations.filter((item) => eventIds.has(item.fromEventId) && eventIds.has(item.toEventId)),
      sceneOccurrences: bundle.canonical.sceneOccurrences.filter((scene) => evidenceIn(scene.evidence, range)),
      propositions: bundle.canonical.propositions.filter((item) => evidenceIn(item.evidence, range)),
    },
    compilerSnapshot: {
      ...snapshot,
      annotations,
      entityResolutions: snapshot.entityResolutions.filter((item) => kept.has(item.mentionId)),
      eventResolutions,
    },
  };
}

export type GoldSliceScore = {
  name: string;
  sourceId: string;
  range: ByteRange;
  drafted: GoldSlice["provenance"]["drafted"];
  unconfirmed: number;
  /** Only layers the slice annotates. Precision and recall are baselines; no thresholds this iteration (design 9.1). */
  layers: Partial<Record<SemanticLayerName, SemanticLayerMetric>>;
  macroF1: number | null;
};

export async function scoreGoldSlice(workspaceRoot: string, bundle: PreparedNovelBundle, input: unknown, options: { allowDraft?: boolean } = {}): Promise<GoldSliceScore> {
  const slice = goldSliceSchema.parse(input);
  if (slice.source.id !== bundle.source.id) throw new Error(`GOLD_SLICE_SOURCE_MISMATCH: slice ${slice.source.id}, candidate ${bundle.source.id}.`);
  const unconfirmed = unconfirmedRecords(slice);
  if (unconfirmed.length && !options.allowDraft) throw new Error(`GOLD_SLICE_UNCONFIRMED: ${unconfirmed.length} drafted records are not confirmed against the source (first: ${unconfirmed.slice(0, 5).join(", ")}). Confirm them or pass --allow-draft for a provisional score.`);
  const report = await evaluateCompilerAgainstGold(workspaceRoot, slice.gold, restrictBundleToRange(bundle, slice.range));
  const layers = Object.fromEntries(Object.entries(report.semanticLayers).filter(([, metric]) => metric.status === "evaluated")) as GoldSliceScore["layers"];
  const f1s = Object.values(layers).map((metric) => metric!.f1).filter((value): value is number => value !== null);
  return { name: slice.name, sourceId: slice.source.id, range: slice.range, drafted: slice.provenance.drafted, unconfirmed: unconfirmed.length, layers,
    macroF1: f1s.length ? f1s.reduce((sum, value) => sum + value, 0) / f1s.length : null };
}

/**
 * Draft a slice from a legacy reference pack: its mentions, quotation
 * speakers and event triggers inside the range, clustered by legacy ID. Every
 * record starts unconfirmed; legacy IDs are not copied into canonical fields.
 */
export function draftGoldSliceFromReference(pack: LoadedReferencePack, range: ByteRange, input: { name: string; directory: string; manifestSha256: string }): GoldSlice {
  const sourceId = pack.manifest.source.id;
  const span = (item: ByteRange) => ({ sourceId, startByte: item.startByte, endByte: item.endByte });
  const kindOf = new Map(pack.entities.map((entity) => [entity.id, entity.kind]));
  // Legacy compiles may hold duplicate mentions on one span; the first (by ID order in the pack) drafts it.
  const seen = new Set<string>();
  const mentions = pack.mentions.filter((mention) => {
    const key = `${mention.startByte}-${mention.endByte}`;
    if (!within(mention, range) || mention.endByte <= mention.startByte || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const goldMentions: CompilerSemanticGold["semantic"]["mentions"] = mentions.map((mention) => {
    const kind = mention.entityId ? kindOf.get(mention.entityId) : mention.kindCandidates[0];
    return { id: `gm-${mention.startByte}-${mention.endByte}`, kind: kind === "location" ? "place" : "entity", span: span(mention), ...(kind ? { type: kind } : {}) };
  });
  const clusterOf = new Map<string, string[]>();
  for (const mention of mentions) if (mention.entityId) clusterOf.set(mention.entityId, [...(clusterOf.get(mention.entityId) ?? []), `gm-${mention.startByte}-${mention.endByte}`]);
  const clusterId = (entityId: string) => `ge-${crypto.createHash("sha256").update(entityId).digest("hex").slice(0, 10)}`;
  const entityClusters = [...clusterOf.entries()].map(([entityId, mentionIds]) => ({ id: clusterId(entityId), mentionIds: [...new Set(mentionIds)] }));
  const eventMentions: CompilerSemanticGold["semantic"]["mentions"] = [];
  const eventClusters: CompilerSemanticGold["semantic"]["eventClusters"] = [];
  for (const event of pack.events) {
    const triggers = event.triggers.filter((trigger) => within(trigger, range) && trigger.endByte > trigger.startByte);
    if (!triggers.length) continue;
    const ids = triggers.map((trigger) => `gv-${trigger.startByte}-${trigger.endByte}`);
    triggers.forEach((trigger, index) => { if (!eventMentions.some((item) => item.id === ids[index])) eventMentions.push({ id: ids[index]!, kind: "event", span: span(trigger) }); });
    eventClusters.push({ id: `gev-${crypto.createHash("sha256").update(event.id).digest("hex").slice(0, 10)}`, mentionIds: [...new Set(ids)] });
  }
  const seenQuotes = new Set<string>();
  const quotations = pack.quotations.filter((quotation) => {
    const key = `${quotation.startByte}-${quotation.endByte}`;
    if (!within(quotation, range) || seenQuotes.has(key)) return false;
    seenQuotes.add(key);
    return true;
  }).map((quotation) => ({
    id: `gq-${quotation.startByte}-${quotation.endByte}`, span: span(quotation), addresseeEntityClusterIds: [],
    ...(quotation.speakerEntityId && clusterOf.has(quotation.speakerEntityId) ? { speakerEntityClusterId: clusterId(quotation.speakerEntityId) } : {}),
  }));
  // The scorer counts quotations as mentions too (kind "quotation").
  const quotationMentions: CompilerSemanticGold["semantic"]["mentions"] = quotations.map((quotation) => ({ id: `gmq-${quotation.span.startByte}-${quotation.span.endByte}`, kind: "quotation", span: quotation.span }));
  return goldSliceSchema.parse({
    version: GOLD_SLICE_VERSION, kind: "nwh-gold-slice", name: input.name,
    source: { id: sourceId, sha256: pack.manifest.source.sha256 }, range,
    provenance: { drafted: "legacy-reference", referencePack: { directory: input.directory, manifestSha256: input.manifestSha256 }, confirmedRecordIds: [],
      notes: "Drafted from a legacy reference pack. Confirm each record against the source text, add what the legacy compile missed, then list it in confirmedRecordIds." },
    gold: { version: 2, name: input.name, semantic: { mentions: [...goldMentions, ...eventMentions, ...quotationMentions], entityClusters, eventClusters, quotations } },
  });
}

import type { PreparedNovelBundle } from "./prepared-cache.js";
import { baseStructuralUnits } from "./structure.js";
import { buildLexicalInventory, type LexicalInventory } from "./lexical-inventory.js";
import { tierAtLeast, type AdmissionManifest } from "./cut-admission-schema.js";
import { spatialEndpoints } from "../world/spatial-ontology.js";

/**
 * World-model completeness against the end-state content contract
 * (iteration 02). Read-only and deterministic: every measure names its
 * denominator, and a denominator the bundle cannot supply is `unknown`,
 * never a pass. Source-derived denominators come from the immutable text
 * (structure units, direct-speech spans, established-name occurrences), so a
 * model that extracts less cannot shrink them.
 */
export const WORLD_COMPLETENESS_VERSION = "world-completeness-v2" as const;

export type CompletenessLayer = "source" | "observation" | "identity" | "relations" | "events" | "time" | "scenes" | "characters" | "space" | "knowledge" | "agency"
  | "causality" | "possibility" | "lore" | "cost";
/** `source`: counted in the text; `roster`: independent role review; `internal`: derived from compiled artifacts (consistency only). */
export type DenominatorKind = "source" | "roster" | "internal";
export type MeasureStatus = "satisfied" | "gap" | "unknown" | "info";

export type CompletenessMeasure = {
  id: string;
  layer: CompletenessLayer;
  label: string;
  denominator: DenominatorKind;
  numerator: number;
  total: number;
  ratio: number | null;
  /** Policy target; absent for informational measures. */
  target?: number;
  status: MeasureStatus;
  note?: string;
};

/**
 * Versioned policy, not truth: the protocol forbids one fixed artifact density
 * for every novel. Targets apply to coverage of things the text itself states.
 */
export const DEFAULT_COMPLETENESS_POLICY = {
  version: "completeness-policy-v2",
  /** A character with at least this many attributed lines is a speaking character (a source-derived role denominator). */
  speakingLineThreshold: 6,
  /** A setting term (quoted term or census lore entry) needs grounding once it occurs this often. */
  loreTermThreshold: 10,
  /** Roster pairs co-present in at least this many scenes need a relation record or an explicit "not stated". */
  rosterPairScenes: 2,
  /** Provisional roster: speaking characters plus this many most frequent event agents. */
  rosterTopAgents: 8,
  targets: {
    accounted: 1,
    hiddenUnits: 0,
    speechAnnotated: 1,
    speechAttributed: 0.85,
    namesAnnotated: 1,
    eventMentionsResolved: 1,
    nameCollisions: 0,
    scenesWithEvents: 1,
    effectfulEvents: 0.9,
    typedAgent: 0.9,
    speechInBeats: 0.9,
    narrativeInScenes: 0.95,
    sceneLocation: 1,
    speakerPresence: 1,
    characterDepth: 1,
    locationsOnGraph: 1,
    openingPositions: 1,
    acquisitions: 1,
    enterable: 1,
    aliasesAttached: 1,
    genericNames: 0,
    rosterPairs: 1,
    anchoredEvents: 0.9,
    conditionedKeyEvents: 1,
    /** An absolute floor: at least this many autonomous possibility templates. */
    autonomousTemplates: 1,
    termsGrounded: 1,
  },
} as const;
type Widen<T> = { [K in keyof T]: T[K] extends number ? number : T[K] extends string ? string : Widen<T[K]> };
export type CompletenessPolicy = Widen<typeof DEFAULT_COMPLETENESS_POLICY>;

export type ByteRange = { startByte: number; endByte: number };

/**
 * An explicit reviewed conclusion that stands in for an artifact: "the source
 * does not state a relation", "this key event is unconditioned", "this term is
 * narration only", "location unknown". It is legal only as the result of a
 * review, so it carries a rationale; an absent artifact is never read as one.
 */
export type ReviewDisposition = {
  measureId: string;
  /** Subject key: `pair:<a>|<b>` (sorted), `event:<id>`, `term:<surface>`, `location:<id>`, `actor:<id>`. */
  subject: string;
  verdict: "not-stated" | "unconditioned" | "narration-only" | "unknown" | "no-change" | "rejected-candidate";
  rationale: string;
};

/** Provisional or reviewed major-role set (design 5.7). */
export type RosterSummary = { reviewed: boolean; actorIds: string[]; missing?: string[] };

/** Model usage attributed to the compile of this source (all stages). */
export type CompileUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; nominalUsd: number; runs: number };

/** Surfaces a novel uses as setting vocabulary; a census entry classified as lore, or a frequently quoted term. */
export type LoreTerm = { surface: string; occurrences: number; origin: "census" | "quoted-term" };

export const pairSubject = (left: string, right: string) => `pair:${[left, right].sort().join("|")}`;

/** Pronouns and bare common nouns are not names; an unnamed person needs a qualified derived label. */
const GENERIC_NAMES = new Set([
  "他", "她", "它", "我", "你", "您", "他们", "她们", "它们", "我们", "你们", "咱们", "自己", "此人", "那人", "这人", "某人", "有人", "众人", "大家", "对方",
  "男人", "女人", "男孩", "女孩", "男子", "女子", "老人", "老头", "老者", "孩子", "少年", "少女", "青年", "姑娘", "小姐", "先生", "女士", "夫人",
  "叔叔", "阿姨", "婶婶", "舅舅", "爷爷", "奶奶", "爸爸", "妈妈", "父亲", "母亲", "哥哥", "姐姐", "弟弟", "妹妹",
  "老师", "教授", "医生", "司机", "警察", "士兵", "学生", "同学", "服务员", "列车员", "保安", "陌生人", "路人", "客人", "主人",
]);
export function isGenericName(name: string): boolean {
  return GENERIC_NAMES.has(name.trim());
}
export type HiddenUnitRange = ByteRange & { units: number; speech: number; names: number; statuses: string[] };

export type WorldCompletenessReport = {
  version: typeof WORLD_COMPLETENESS_VERSION;
  policy: CompletenessPolicy["version"];
  sourceId: string;
  /** Present when the report is limited to one source range (a stage gate or a slice). */
  scope?: ByteRange;
  measures: CompletenessMeasure[];
  summary: { satisfied: number; gap: number; unknown: number; info: number };
  /** Source-derived character denominator, most attributed lines first. */
  speakingCharacters: Array<{ actorId: string; name: string; lines: number; occurrences: number; annotatedMentions: number; model: boolean; depth: boolean; goals: number; effectfulGoals: number; scenes: number }>;
  /**
   * Ordered work lists for the gap loop, bounded by `queueLimit` (default 50);
   * `total` keeps a truncated tail discoverable, and the gap loop reads them
   * unbounded. Subjects closed by a reviewed disposition are not queued.
   */
  queues: {
    hiddenUnits: { total: number; ranges: HiddenUnitRange[] };
    unannotatedSpeech: { total: number; ranges: ByteRange[] };
    /** Narrative units still unresolved or deferred (they hold the cut horizon back). */
    blockingUnits: { total: number; ranges: ByteRange[] };
    unannotatedNames: { total: number; ranges: ByteRange[] };
    /** Direct-speech spans with no character speaker and no reviewed "speaker unknown". */
    unattributedSpeech: { total: number; ranges: ByteRange[] };
    unresolvedEntityMentions: { total: number; mentions: Array<ByteRange & { mentionId: string }> };
    unresolvedEventMentions: { total: number; mentions: Array<ByteRange & { mentionId: string; salience: string }> };
    uneffectfulEvents: string[];
    untypedAgentEvents: string[];
    /** Direct speech outside every canonical event extent and not reviewed as narration only. */
    speechOutsideBeats: { total: number; ranges: ByteRange[] };
    /** Narrative stretches outside every scene extent and every segment reviewed as narration only. */
    narrativeOutsideScenes: { total: number; ranges: ByteRange[] };
    unpositionedOpening: string[];
    /** Roster actors (reviewed majors and missing majors named by the review) without an entity, model or goal. */
    rosterUnmodelled: Array<{ subject: string; name: string; actorId?: string }>;
    speakingNotEnterable: string[];
    scenesWithoutEvents: string[];
    scenesWithoutLocation: string[];
    absentSpeakers: Array<{ sceneId: string; actorId: string; lines: number }>;
    locationsOffGraph: string[];
    nameCollisions: Array<{ surface: string; entityIds: string[] }>;
    eventGaps: ByteRange[];
    unattachedAliases: Array<{ entityId: string; surface: string; mentions: number }>;
    genericNames: Array<{ entityId: string; name: string }>;
    rosterPairs: Array<{ subject: string; scenes: number }>;
    unanchoredEvents: string[];
    unconditionedKeyEvents: string[];
    ungroundedTerms: LoreTerm[];
    unacquiredKnowledge: Array<{ eventId: string; actorId: string; claimId: string }>;
  };
  roster: RosterSummary;
};

export const DEFAULT_QUEUE_LIMIT = 50;

/** Disjoint, sorted union of ranges with an overlap query. */
class RangeUnion {
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  constructor(ranges: Iterable<ByteRange>) {
    const sorted = [...ranges].filter((range) => range.endByte > range.startByte).sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);
    for (const range of sorted) {
      const last = this.ends.length - 1;
      if (last >= 0 && range.startByte <= this.ends[last]!) this.ends[last] = Math.max(this.ends[last]!, range.endByte);
      else { this.starts.push(range.startByte); this.ends.push(range.endByte); }
    }
  }
  overlaps(startByte: number, endByte: number): boolean {
    let low = 0, high = this.starts.length - 1, candidate = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.starts[mid]! < endByte) { candidate = mid; low = mid + 1; } else high = mid - 1;
    }
    return candidate >= 0 && this.ends[candidate]! > startByte;
  }
  coveredBytes(startByte: number, endByte: number): number {
    let total = 0;
    for (let index = 0; index < this.starts.length; index += 1) {
      if (this.starts[index]! >= endByte) break;
      total += Math.max(0, Math.min(endByte, this.ends[index]!) - Math.max(startByte, this.starts[index]!));
    }
    return total;
  }
  get ranges(): ByteRange[] { return this.starts.map((startByte, index) => ({ startByte, endByte: this.ends[index]! })); }
}

type Anchor = { startByte: number; endByte: number };
type Annotation = PreparedNovelBundle["compilerSnapshot"]["annotations"][number];

function measure(input: Omit<CompletenessMeasure, "ratio" | "status"> & { status?: MeasureStatus; lowerIsBetter?: boolean; atLeast?: boolean }): CompletenessMeasure {
  const { lowerIsBetter, atLeast, ...rest } = input;
  if (atLeast) {
    const status = input.status ?? (input.target === undefined ? "info" : input.numerator >= input.target ? "satisfied" : "gap");
    return { ...rest, ratio: null, status };
  }
  if (lowerIsBetter) {
    const status = input.status ?? (input.target === undefined ? "info" : input.numerator <= input.target ? "satisfied" : "gap");
    return { ...rest, ratio: null, status };
  }
  const ratio = input.total > 0 ? input.numerator / input.total : null;
  const status = input.status ?? (input.target === undefined ? "info" : ratio === null ? "unknown" : ratio >= input.target ? "satisfied" : "gap");
  return { ...rest, ratio, status };
}

function anchorsOf(annotation: Annotation): Anchor[] {
  switch (annotation.annotationType) {
    case "entity-mention": case "quotation": return [annotation.anchor];
    case "event-mention": return annotation.extentAnchors;
    case "discourse-segment": return annotation.anchors;
  }
}

/** Spans (sorted by start) overlapping one range. */
function overlapping<T extends ByteRange>(sorted: readonly T[], range: ByteRange): T[] {
  let low = 0, high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid]!.startByte < range.startByte) low = mid + 1; else high = mid;
  }
  const result: T[] = [];
  if (low > 0 && sorted[low - 1]!.endByte > range.startByte) result.push(sorted[low - 1]!);
  for (let index = low; index < sorted.length && sorted[index]!.startByte < range.endByte; index += 1) result.push(sorted[index]!);
  return result;
}

function mergeAdjacent<T extends ByteRange>(items: readonly T[], combine: (left: T, right: T) => T, maxGap: number): T[] {
  const merged: T[] = [];
  for (const item of items) {
    const last = merged.at(-1);
    if (last && item.startByte - last.endByte <= maxGap) merged[merged.length - 1] = combine(last, item);
    else merged.push(item);
  }
  return merged;
}

export type WorldCompletenessOptions = {
  policy?: CompletenessPolicy;
  inventory?: LexicalInventory;
  /** Admission computed for this bundle when it carries none frozen. */
  admission?: AdmissionManifest | null;
  /**
   * Limit every measure to one source range: source denominators count only
   * spans inside it; scenes and events count when their extent overlaps it.
   * Stage gates and slice acceptance use this with the same implementation.
   */
  scope?: ByteRange;
  /** Explicit reviewed conclusions (not stated / unconditioned / narration only). */
  dispositions?: readonly ReviewDisposition[];
  roster?: RosterSummary;
  /** Census lore entries; quoted terms from the text are always included. */
  loreTerms?: readonly LoreTerm[];
  usage?: CompileUsage | null;
  /** Host candidates the model rejected with a reason: they count as handled, not as missing annotations. */
  handled?: { speech?: readonly ByteRange[]; names?: readonly ByteRange[]; times?: readonly ByteRange[] };
  /** Queue bound (default 50). The gap loop passes Infinity so held items at the head never hide the tail. */
  queueLimit?: number;
};

export function measureWorldCompleteness(bundle: PreparedNovelBundle, source: Uint8Array, options: WorldCompletenessOptions = {}): WorldCompletenessReport {
  const policy = options.policy ?? DEFAULT_COMPLETENESS_POLICY;
  const targets = policy.targets;
  const { canonical, compilerSnapshot: snapshot } = bundle;
  const sourceId = bundle.source.id;
  const scope = options.scope;
  const inScope = (range: ByteRange) => !scope || (range.endByte > scope.startByte && range.startByte < scope.endByte);
  const annotations = snapshot.annotations.filter((item) => anchorsOf(item).some(inScope));
  const fullInventory = options.inventory ?? buildLexicalInventory({ source, entities: canonical.entities, annotations: snapshot.annotations, entityResolutions: snapshot.entityResolutions });
  const inventory: LexicalInventory = scope ? {
    ...fullInventory,
    speech: fullInventory.speech.filter(inScope),
    occurrences: fullInventory.occurrences.filter(inScope),
    cues: fullInventory.cues.filter((cue) => inScope({ startByte: cue.speechStartByte, endByte: cue.speechEndByte })),
    times: fullInventory.times.filter(inScope),
  } : fullInventory;
  const dispositions = new Map((options.dispositions ?? []).map((item) => [`${item.measureId}\u0000${item.subject}`, item]));
  const disposed = (measureId: string, subject: string) => dispositions.get(`${measureId}\u0000${subject}`);
  const names = new Map(canonical.entities.map((entity) => [entity.id, entity.canonicalName]));
  const characters = new Set(canonical.entities.filter((entity) => entity.kind === "character").map((entity) => entity.id));
  const measures: CompletenessMeasure[] = [];

  // Resolutions in force.
  const supersededEntity = new Set(snapshot.entityResolutions.flatMap((item) => item.supersedesResolutionId ? [item.supersedesResolutionId] : []));
  const mentionEntity = new Map<string, string>();
  const resolvedMentions = new Set<string>();
  for (const item of snapshot.entityResolutions) {
    if (supersededEntity.has(item.id)) continue;
    if (["resolved", "new-entity", "non-referential", "misidentified"].includes(item.status)) resolvedMentions.add(item.mentionId);
    if (item.entityId && ["resolved", "new-entity"].includes(item.status)) mentionEntity.set(item.mentionId, item.entityId);
  }
  const supersededEvent = new Set(snapshot.eventResolutions.flatMap((item) => item.supersedesResolutionIds ?? []));
  const mentionEvent = new Map<string, string>();
  /** Event mentions reviewed as not an occurrence (habitual, hypothetical): "explicitly not entering canon" (design 3.3). */
  const nonReferentialEvents = new Set<string>();
  for (const item of snapshot.eventResolutions) {
    if (supersededEvent.has(item.id)) continue;
    if (item.status === "non-referential") for (const mentionId of item.eventMentionIds) nonReferentialEvents.add(mentionId);
    if (!item.canonicalEventId) continue;
    for (const mentionId of item.eventMentionIds) mentionEvent.set(mentionId, item.canonicalEventId);
  }
  // Event extents: resolved event-mention extents, else the event's own evidence spans.
  const mentionExtents = new Map(snapshot.annotations.flatMap((item) => item.annotationType === "event-mention" ? [[item.id, item.extentAnchors] as const] : []));
  const eventExtents = new Map<string, ByteRange[]>();
  for (const [mentionId, eventId] of mentionEvent) eventExtents.set(eventId, [...(eventExtents.get(eventId) ?? []), ...(mentionExtents.get(mentionId) ?? [])]);
  for (const event of canonical.events) {
    if (eventExtents.get(event.id)?.length) continue;
    eventExtents.set(event.id, event.evidence.flatMap(({ span }) => span.sourceId === sourceId && span.startByte !== undefined && span.endByte !== undefined ? [{ startByte: span.startByte, endByte: span.endByte }] : []));
  }
  const events = scope ? canonical.events.filter((event) => (eventExtents.get(event.id) ?? []).some(inScope)) : canonical.events;
  const canonicalEventIds = new Set(canonical.events.map((event) => event.id));

  const quotations = annotations.filter((item) => item.annotationType === "quotation");
  const entityMentions = annotations.filter((item) => item.annotationType === "entity-mention");
  const eventMentions = annotations.filter((item) => item.annotationType === "event-mention");
  const discourse = new Map(annotations.filter((item) => item.annotationType === "discourse-segment").map((item) => [item.id, item.anchors]));
  const quotationUnion = new RangeUnion([...quotations.map((item) => item.anchor), ...(options.handled?.speech ?? [])]);
  const mentionUnion = new RangeUnion([...entityMentions.map((item) => item.anchor), ...(options.handled?.names ?? [])]);
  const resolvedEventExtents = eventMentions.filter((item) => canonicalEventIds.has(mentionEvent.get(item.id) ?? "")).flatMap((item) => item.extentAnchors);
  const eventUnion = new RangeUnion(resolvedEventExtents);
  const bindingUnion = new RangeUnion(snapshot.evidenceBindings.flatMap((binding) => binding.assertions.flatMap((assertion) =>
    assertion.anchors.filter((anchor) => anchor.sourceId === sourceId))));

  // L0 source accounting.
  const records = new Map((snapshot.accounting?.records ?? []).map((record) => [record.unitId, record]));
  const units = baseStructuralUnits(snapshot.structure).filter((unit) => unit.kind !== "non-scene" && inScope(unit.anchor));
  const speech = inventory.speech.filter((span) => span.kind === "speech");
  const speechByStart = [...speech].sort((a, b) => a.startByte - b.startByte);
  const occurrences = inventory.occurrences;
  const narrative = units.filter((unit) => records.get(unit.id)?.status !== "paratext");
  const narrativeBytes = narrative.reduce((total, unit) => total + unit.anchor.endByte - unit.anchor.startByte, 0);
  const statusBytes = (status: string) => narrative.filter((unit) => records.get(unit.id)?.status === status)
    .reduce((total, unit) => total + unit.anchor.endByte - unit.anchor.startByte, 0);
  measures.push(measure({ id: "source.accounted", layer: "source", label: "base units with an accounting disposition", denominator: "source",
    numerator: units.filter((unit) => records.has(unit.id)).length, total: units.length, target: targets.accounted }));
  measures.push(measure({ id: "source.represented-bytes", layer: "source", label: "narrative bytes host-derived as represented (any exact annotation or assertion)", denominator: "source",
    numerator: statusBytes("represented"), total: narrativeBytes }));
  const modelled = narrative.filter((unit) => eventUnion.overlaps(unit.anchor.startByte, unit.anchor.endByte) || bindingUnion.overlaps(unit.anchor.startByte, unit.anchor.endByte));
  measures.push(measure({ id: "source.modelled-bytes", layer: "source", label: "narrative bytes inside a canonical event's mention extent or a canonical exact-evidence binding", denominator: "source",
    numerator: modelled.reduce((total, unit) => total + unit.anchor.endByte - unit.anchor.startByte, 0), total: narrativeBytes }));
  const blocking = narrative.filter((unit) => ["unresolved", "intentionally-deferred"].includes(records.get(unit.id)?.status ?? "unresolved"));
  measures.push(measure({ id: "source.blocking-units", layer: "source", label: "units still unresolved or deferred", denominator: "source",
    numerator: blocking.length, total: narrative.length, target: 0, lowerIsBetter: true }));
  // A unit closed as background/duplicate cannot hide direct speech or a named character the inventory never recorded.
  const speechUnion = new RangeUnion(speech.filter((span) => !quotationUnion.overlaps(span.startByte, span.endByte)));
  const unannotatedNames = new RangeUnion(occurrences.filter((item) => !mentionUnion.overlaps(item.startByte, item.endByte)));
  const hidden: HiddenUnitRange[] = [];
  for (const unit of narrative) {
    const status = records.get(unit.id)?.status;
    if (status !== "background-only" && status !== "duplicate-description") continue;
    const hasSpeech = speechUnion.overlaps(unit.anchor.startByte, unit.anchor.endByte);
    const hasNames = unannotatedNames.overlaps(unit.anchor.startByte, unit.anchor.endByte);
    if (hasSpeech || hasNames) hidden.push({ startByte: unit.anchor.startByte, endByte: unit.anchor.endByte, units: 1, speech: hasSpeech ? 1 : 0, names: hasNames ? 1 : 0, statuses: [status] });
  }
  measures.push(measure({ id: "source.hidden-units", layer: "source", label: "background/duplicate units that contain unannotated direct speech or a named character", denominator: "source",
    numerator: hidden.length, total: narrative.length, target: targets.hiddenUnits, lowerIsBetter: true,
    note: "The protocol forbids background/duplicate dispositions from hiding actions, speech or unresolved people; each range is an accounting-review task." }));
  const hiddenRanges = mergeAdjacent(hidden, (left, right) => ({ startByte: left.startByte, endByte: right.endByte, units: left.units + right.units,
    speech: left.speech + right.speech, names: left.names + right.names, statuses: [...new Set([...left.statuses, ...right.statuses])].sort() }), 8);

  // L1 observation inventory. A speech span's speaker comes from an overlapping
  // quotation annotation whose speaker resolves to a character, else from a host cue.
  const annotationSpeaker = new Map<number, string>();
  for (const item of quotations) {
    const entityId = item.speakerMentionId ? mentionEntity.get(item.speakerMentionId) : undefined;
    if (!entityId || !characters.has(entityId)) continue;
    for (const span of overlapping(speechByStart, item.anchor)) if (!annotationSpeaker.has(span.startByte)) annotationSpeaker.set(span.startByte, entityId);
  }
  const speechSpeaker = new Map(annotationSpeaker);
  for (const cue of inventory.cues) if (!speechSpeaker.has(cue.speechStartByte) && characters.has(cue.entityId)) speechSpeaker.set(cue.speechStartByte, cue.entityId);
  const speakerOf = (span: ByteRange) => speechSpeaker.get(span.startByte);
  measures.push(measure({ id: "observation.speech-annotated", layer: "observation", label: "direct-speech spans covered by a quotation annotation", denominator: "source",
    numerator: speech.filter((span) => quotationUnion.overlaps(span.startByte, span.endByte)).length, total: speech.length, target: targets.speechAnnotated }));
  const attributedAny = speech.filter((span) => speechSpeaker.has(span.startByte)).length;
  const unattributedSpeech = speech.filter((span) => !speechSpeaker.has(span.startByte) && !disposed("observation.speech-attributed", `speech:${span.startByte}`));
  measures.push(measure({ id: "observation.speech-attributed", layer: "observation", label: "direct-speech spans with a character speaker (annotation or host lexical cue)", denominator: "source",
    numerator: attributedAny, total: speech.length, target: targets.speechAttributed,
    note: `${annotationSpeaker.size} by compiled quotation annotations, ${attributedAny - annotationSpeaker.size} by host lexical cue only.${speech.length - attributedAny - unattributedSpeech.length ? ` ${speech.length - attributedAny - unattributedSpeech.length} reviewed as speaker unknown.` : ""}` }));
  measures.push(measure({ id: "observation.names-annotated", layer: "observation", label: "established-name occurrences covered by an entity-mention annotation", denominator: "source",
    numerator: occurrences.filter((item) => mentionUnion.overlaps(item.startByte, item.endByte)).length, total: occurrences.length, target: targets.namesAnnotated }));
  const eventMentionResolved = (item: { id: string }) => canonicalEventIds.has(mentionEvent.get(item.id) ?? "") || nonReferentialEvents.has(item.id);
  const unresolvedEventMentions = eventMentions.filter((item) => !eventMentionResolved(item));
  measures.push(measure({ id: "observation.event-mentions-resolved", layer: "observation", label: "event mentions resolved into a canonical event or reviewed as non-referential", denominator: "internal",
    numerator: eventMentions.length - unresolvedEventMentions.length, total: eventMentions.length, target: targets.eventMentionsResolved,
    note: `${unresolvedEventMentions.filter((item) => item.annotationType === "event-mention" && item.salience === "major").length} unresolved mentions are marked major; ${eventMentions.filter((item) => nonReferentialEvents.has(item.id)).length} reviewed as non-referential.` }));

  // Identity.
  measures.push(measure({ id: "identity.name-collisions", layer: "identity", label: "proper names attested for more than one character entity", denominator: "source",
    numerator: inventory.lexicon.collisions.length, total: inventory.lexicon.entries.length + inventory.lexicon.collisions.length, target: targets.nameCollisions, lowerIsBetter: true,
    note: "Each collision is a duplicate-entity or alias-scope question for identity review." }));
  const unresolvedEntityMentions = entityMentions.filter((item) => !resolvedMentions.has(item.id));
  measures.push(measure({ id: "identity.mentions-resolved", layer: "identity", label: "entity mentions with a resolution in force", denominator: "internal",
    numerator: entityMentions.length - unresolvedEntityMentions.length, total: entityMentions.length, target: 1 }));

  // Events and beats.
  const allScenes = canonical.sceneOccurrences;
  const effectEvents = new Set([
    ...canonical.semanticEffects.flatMap((item) => "eventId" in item && typeof item.eventId === "string" ? [item.eventId] : []),
    ...canonical.eventExecutions.map((item) => item.canonicalEventId),
  ]);
  const changing = events.filter((event) => event.observedOutcome.operations.length > 0
    || (event.observedKnowledge?.operations.length ?? 0) > 0 || effectEvents.has(event.id));
  // A reviewed "no change" satisfies the beat contract but never makes an event a key event.
  const effectful = [...changing, ...events.filter((event) => !changing.includes(event) && disposed("events.effectful", `event:${event.id}`))];
  const agents = new Set(canonical.eventParticipations.filter((item) => item.role === "agent").map((item) => item.eventId));
  const scenesWithEventsAt = measures.length;
  measures.push(measure({ id: "events.effectful", layer: "events", label: "events with a state, knowledge, semantic or execution effect", denominator: "internal",
    numerator: effectful.length, total: events.length, target: targets.effectfulEvents,
    note: `${effectful.length - changing.length} by a reviewed "no change".` }));
  // Reviewed exceptions ("agentless", "narration only") close a gap-loop item but never count as the fact the measure counts; the target's slack absorbs them.
  const untypedAgentEvents = events.filter((event) => !agents.has(event.id) && !disposed("events.typed-agent", `event:${event.id}`));
  measures.push(measure({ id: "events.typed-agent", layer: "events", label: "events with a typed agent participation", denominator: "internal",
    numerator: events.filter((event) => agents.has(event.id)).length, total: events.length, target: targets.typedAgent,
    ...(events.length - events.filter((event) => agents.has(event.id)).length - untypedAgentEvents.length ? { note: `${events.length - events.filter((event) => agents.has(event.id)).length - untypedAgentEvents.length} reviewed as agentless.` } : {}) }));
  const speechOutsideBeats = speech.filter((span) => !eventUnion.overlaps(span.startByte, span.endByte) && !disposed("events.speech-in-beats", `speech:${span.startByte}`));
  measures.push(measure({ id: "events.speech-in-beats", layer: "events", label: "direct-speech spans inside a canonical event's mention extent", denominator: "source",
    numerator: speech.filter((span) => eventUnion.overlaps(span.startByte, span.endByte)).length, total: speech.length, target: targets.speechInBeats,
    note: `Dialogue outside every event extent is talk the world model does not stage as a beat.${speech.length - speech.filter((span) => eventUnion.overlaps(span.startByte, span.endByte)).length - speechOutsideBeats.length ? ` ${speech.length - speech.filter((span) => eventUnion.overlaps(span.startByte, span.endByte)).length - speechOutsideBeats.length} lines reviewed as narration only.` : ""}` }));
  const narrativeRanges = new RangeUnion(narrative.map((unit) => unit.anchor));
  const eventGaps: ByteRange[] = [];
  let cursor = narrativeRanges.ranges[0]?.startByte ?? scope?.startByte ?? 0;
  const gapEnd = scope ? Math.min(scope.endByte, source.byteLength) : source.byteLength;
  for (const range of [...eventUnion.ranges.filter((item) => item.startByte < gapEnd), { startByte: gapEnd, endByte: gapEnd }]) {
    if (range.startByte > cursor) eventGaps.push({ startByte: cursor, endByte: range.startByte });
    cursor = Math.max(cursor, range.endByte);
  }
  eventGaps.sort((a, b) => (b.endByte - b.startByte) - (a.endByte - a.startByte));
  measures.push(measure({ id: "events.largest-gap-bytes", layer: "events", label: "largest source stretch outside every canonical event extent (bytes)", denominator: "source",
    numerator: eventGaps[0] ? eventGaps[0].endByte - eventGaps[0].startByte : 0, total: gapEnd - (scope?.startByte ?? 0), lowerIsBetter: true }));

  // Scenes.
  // Discourse anchors mark scene boundaries; the scene's evidence spans are the extent it claims.
  const sceneRanges = new Map(allScenes.map((scene) => [scene.id, new RangeUnion([
    ...scene.discourseSegmentIds.flatMap((id) => discourse.get(id) ?? []),
    ...scene.evidence.flatMap(({ span }) => span.sourceId === sourceId && span.startByte !== undefined && span.endByte !== undefined
      ? [{ startByte: span.startByte, endByte: span.endByte }] : []),
  ])]));
  const scenes = scope ? allScenes.filter((scene) => sceneRanges.get(scene.id)!.ranges.some(inScope)) : allScenes;
  measures.splice(scenesWithEventsAt, 0, measure({ id: "events.scenes-with-events", layer: "events", label: "scenes with at least one canonical event", denominator: "internal",
    numerator: scenes.filter((scene) => scene.eventIds.length > 0).length, total: scenes.length, target: targets.scenesWithEvents }));
  // A discourse segment reviewed as narration only (narrator commentary, a summary with no staged occurrence) is accounted narrative, not a missing scene.
  const narrationOnly = [...discourse.entries()].filter(([id]) => disposed("scenes.narrative-covered", `segment:${id}`)).flatMap(([, anchors]) => anchors);
  const allSceneRanges = new RangeUnion([...sceneRanges.values()].flatMap((union) => union.ranges));
  const coveredRanges = new RangeUnion([...allSceneRanges.ranges, ...narrationOnly]);
  const sceneBytes = narrative.reduce((total, unit) => total + allSceneRanges.coveredBytes(unit.anchor.startByte, unit.anchor.endByte), 0);
  const coveredBytes = narrative.reduce((total, unit) => total + coveredRanges.coveredBytes(unit.anchor.startByte, unit.anchor.endByte), 0);
  measures.push(measure({ id: "scenes.narrative-covered", layer: "scenes", label: "narrative bytes inside a scene's extent or a segment reviewed as narration only", denominator: "source",
    numerator: coveredBytes, total: narrativeBytes, target: targets.narrativeInScenes,
    note: `${sceneBytes} bytes in scenes, ${coveredBytes - sceneBytes} in segments reviewed as narration only.` }));
  const narrativeOutsideScenes = mergeAdjacent(narrative.filter((unit) => coveredRanges.coveredBytes(unit.anchor.startByte, unit.anchor.endByte) < unit.anchor.endByte - unit.anchor.startByte)
    .map((unit) => ({ startByte: unit.anchor.startByte, endByte: unit.anchor.endByte })).sort((a, b) => a.startByte - b.startByte), (left, right) => ({ startByte: left.startByte, endByte: right.endByte }), 8);
  measures.push(measure({ id: "scenes.location-contract", layer: "scenes", label: "scenes with a location or an explicit reasoned unknown", denominator: "internal",
    numerator: scenes.filter((scene) => scene.locationId || scene.locationUnknown).length, total: scenes.length, target: targets.sceneLocation }));
  const speakerLines = new Map<string, number>();
  for (const span of speechByStart) {
    const speaker = speakerOf(span);
    if (speaker) speakerLines.set(speaker, (speakerLines.get(speaker) ?? 0) + 1);
  }
  const absentSpeakers: WorldCompletenessReport["queues"]["absentSpeakers"] = [];
  let presencePairs = 0, presentPairs = 0;
  for (const scene of scenes) {
    const union = sceneRanges.get(scene.id)!;
    const lines = new Map<string, number>();
    for (const span of speechByStart) {
      if (!union.overlaps(span.startByte, span.endByte)) continue;
      const speaker = speakerOf(span);
      if (speaker) lines.set(speaker, (lines.get(speaker) ?? 0) + 1);
    }
    const present = new Set([...scene.presentActorIds, ...scene.viewpointActorIds]);
    for (const [actorId, count] of lines) {
      presencePairs += 1;
      if (present.has(actorId)) presentPairs += 1;
      else absentSpeakers.push({ sceneId: scene.id, actorId, lines: count });
    }
  }
  absentSpeakers.sort((a, b) => b.lines - a.lines || a.sceneId.localeCompare(b.sceneId));
  measures.push(measure({ id: "scenes.speakers-present", layer: "scenes", label: "(scene, speaker) pairs where the speaker is recorded present", denominator: "source",
    numerator: presentPairs, total: presencePairs, target: targets.speakerPresence }));

  // Characters: the source-derived denominator is everyone with enough attributed lines.
  const models = new Map(canonical.models.map((model) => [model.actorId, model]));
  const goalsBy = new Map<string, typeof canonical.goals>();
  for (const goal of canonical.goals) goalsBy.set(goal.actorId, [...(goalsBy.get(goal.actorId) ?? []), goal]);
  const occurrenceCount = new Map<string, number>(), annotatedCount = new Map<string, number>();
  for (const item of occurrences) {
    occurrenceCount.set(item.entityId, (occurrenceCount.get(item.entityId) ?? 0) + 1);
    if (mentionUnion.overlaps(item.startByte, item.endByte)) annotatedCount.set(item.entityId, (annotatedCount.get(item.entityId) ?? 0) + 1);
  }
  const sceneCount = new Map<string, number>();
  for (const scene of scenes) for (const actorId of new Set([...scene.presentActorIds, ...scene.viewpointActorIds])) sceneCount.set(actorId, (sceneCount.get(actorId) ?? 0) + 1);
  const speaking = [...speakerLines.entries()].filter(([actorId, lines]) => characters.has(actorId) && lines >= policy.speakingLineThreshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([actorId, lines]) => {
      const model = models.get(actorId);
      const goals = goalsBy.get(actorId) ?? [];
      return {
        actorId, name: names.get(actorId) ?? actorId, lines, occurrences: occurrenceCount.get(actorId) ?? 0, annotatedMentions: annotatedCount.get(actorId) ?? 0,
        model: Boolean(model), depth: Boolean(model && (Object.keys(model.traits).length > 0 || (model.dispositions?.length ?? 0) > 0)),
        goals: goals.length, effectfulGoals: goals.filter((goal) => (goal.candidateAction?.proposedDelta.operations.length ?? 0) > 0).length,
        scenes: sceneCount.get(actorId) ?? 0,
      };
    });
  const speakingMeasure = (id: string, label: string, predicate: (item: typeof speaking[number]) => boolean, target: number) =>
    measures.push(measure({ id, layer: "characters", label, denominator: "source", numerator: speaking.filter((item) => predicate(item) || disposed(id, `actor:${item.actorId}`)).length, total: speaking.length, target }));
  speakingMeasure("characters.speaking-modelled", "speaking characters with a character model", (item) => item.model, targets.characterDepth);
  speakingMeasure("characters.speaking-with-disposition", "speaking characters whose model carries a trait or disposition", (item) => item.depth, targets.characterDepth);
  speakingMeasure("characters.speaking-with-goal", "speaking characters with at least one goal", (item) => item.goals > 0, targets.characterDepth);
  speakingMeasure("characters.speaking-in-scenes", "speaking characters recorded present in at least one scene", (item) => item.scenes > 0, targets.characterDepth);
  const rosterReviewedAt = measures.length;

  // Space.
  const graph = new Set(canonical.spatialRelations.flatMap((relation) => spatialEndpoints(relation)));
  const locations = new Set(canonical.entities.filter((entity) => entity.kind === "location").map((entity) => entity.id));
  const used = new Set<string>(scenes.flatMap((scene) => scene.locationId ? [scene.locationId] : []));
  const locationWrites = [...(scope ? [] : canonical.initialWorld.delta.operations), ...events.flatMap((event) => event.observedOutcome.operations)]
    .filter((operation) => "field" in operation && operation.field === "character.location" && "value" in operation && typeof operation.value === "string");
  for (const operation of locationWrites) if (locations.has((operation as { value: string }).value)) used.add((operation as { value: string }).value);
  measures.push(measure({ id: "space.locations-on-graph", layer: "space", label: "locations used by scenes or character positions that sit in the spatial graph", denominator: "internal",
    numerator: [...used].filter((id) => graph.has(id) || disposed("space.locations-on-graph", `location:${id}`)).length, total: used.size, target: targets.locationsOnGraph,
    note: `${canonical.spatialRelations.length} spatial relations over ${locations.size} location entities.` }));
  const openingActors = new Set([...(canonical.initialWorld.participantPresence ?? []).map((item) => item.entityId)].filter((id) => characters.has(id)));
  const openingPositioned = new Set(canonical.initialWorld.delta.operations
    .filter((operation) => "field" in operation && operation.field === "character.location" && "entityId" in operation).map((operation) => (operation as { entityId: string }).entityId));
  measures.push(measure({ id: "space.opening-positions", layer: "space", label: "opening characters with a starting location", denominator: "internal",
    numerator: [...openingActors].filter((id) => openingPositioned.has(id)).length, total: openingActors.size, target: targets.openingPositions }));

  // Knowledge.
  const learns = events.flatMap((event) => (event.observedKnowledge?.operations ?? []).filter((operation) => operation.op === "learn")
    .map((operation) => ({ eventId: event.id, actorId: operation.actorId, claimId: operation.claimId })));
  const acquired = new Set(canonical.acquisitions.map((item) => `${item.canonicalEventId}:${item.actorId}:${item.claimId}`));
  measures.push(measure({ id: "knowledge.acquisition-paths", layer: "knowledge", label: "knowledge gains with an explicit acquisition path (observed / told / read / inferred)", denominator: "internal",
    numerator: learns.filter((item) => acquired.has(`${item.eventId}:${item.actorId}:${item.claimId}`)).length, total: learns.length, target: targets.acquisitions }));

  // Agency: can each speaking character actually be entered and act?
  const admission = bundle.admission ?? options.admission ?? null;
  let speakingNotEnterable: string[] = [];
  if (admission) {
    const enterable = new Set(admission.cuts.filter((cut) => cut.tier !== "blocked").flatMap((cut) => cut.actors.filter((actor) => tierAtLeast(actor.tier, "enterable")).map((actor) => actor.actorId)));
    speakingNotEnterable = speaking.filter((item) => !enterable.has(item.actorId)).map((item) => item.actorId);
    measures.push(measure({ id: "agency.speaking-enterable", layer: "agency", label: "speaking characters with at least one enterable cut", denominator: "source",
      numerator: speaking.filter((item) => enterable.has(item.actorId)).length, total: speaking.length, target: targets.enterable }));
  } else {
    measures.push(measure({ id: "agency.speaking-enterable", layer: "agency", label: "speaking characters with at least one enterable cut", denominator: "source",
      numerator: 0, total: speaking.length, target: targets.enterable, status: "unknown", note: "No admission manifest; rerun with --admission or use `compile-novel cuts`." }));
  }
  measures.push(measure({ id: "agency.effectful-goals", layer: "agency", label: "speaking characters with a goal whose candidate action changes state", denominator: "source",
    numerator: speaking.filter((item) => item.effectfulGoals > 0 || disposed("agency.effectful-goals", `actor:${item.actorId}`)).length, total: speaking.length, target: targets.characterDepth }));

  // Aliases and generic names (design 3.3, identity layer extension).
  const entitiesById = new Map(canonical.entities.map((entity) => [entity.id, entity]));
  const aliasTypeOf = new Map(snapshot.entityResolutions.filter((item) => !supersededEntity.has(item.id)).map((item) => [item.mentionId, item.aliasType]));
  const unattached = new Map<string, { entityId: string; surface: string; mentions: number }>();
  let aliasMentions = 0, attachedMentions = 0;
  for (const mention of entityMentions) {
    if (mention.form !== "proper" || !mention.surface) continue;
    const entityId = mentionEntity.get(mention.id);
    const entity = entityId ? entitiesById.get(entityId) : undefined;
    if (!entity) continue;
    const surface = mention.surface.trim();
    aliasMentions += 1;
    if (surface === entity.canonicalName.trim() || entity.aliases.some((alias) => alias.trim() === surface)) { attachedMentions += 1; continue; }
    const key = `${entity.id}\u0000${surface}`;
    const item = unattached.get(key) ?? { entityId: entity.id, surface, mentions: 0 };
    item.mentions += 1;
    unattached.set(key, item);
  }
  measures.push(measure({ id: "identity.aliases-attached", layer: "identity", label: "resolved proper-name mentions whose surface is the entity's canonical name or a recorded alias", denominator: "internal",
    numerator: attachedMentions, total: aliasMentions, target: targets.aliasesAttached,
    note: `${[...aliasTypeOf.values()].filter(Boolean).length} resolutions carry an alias type; ${canonical.entities.reduce((total, entity) => total + entity.aliases.length, 0)} aliases recorded on entities.` }));
  const scopedEntityIds = scope ? new Set([...mentionEntity.entries()].filter(([mentionId]) => entityMentions.some((item) => item.id === mentionId)).map(([, entityId]) => entityId)) : null;
  const generic = canonical.entities.filter((entity) => entity.kind === "character" && isGenericName(entity.canonicalName) && (!scopedEntityIds || scopedEntityIds.has(entity.id)));
  measures.push(measure({ id: "identity.generic-names", layer: "identity", label: "character entities whose canonical name is a pronoun or a bare common noun", denominator: "internal",
    numerator: generic.length, total: canonical.entities.filter((entity) => entity.kind === "character").length, target: targets.genericNames, lowerIsBetter: true,
    note: "An unnamed person keeps a qualified derived label (\"列车上的男人\"); a bare noun merges every such person into one identity." }));

  // Roster: reviewed when supplied, else provisional (speaking characters plus the most frequent agents).
  const agentCounts = new Map<string, number>();
  for (const item of canonical.eventParticipations) {
    if (item.role !== "agent" || !characters.has(item.entityId) || (scope && !events.some((event) => event.id === item.eventId))) continue;
    agentCounts.set(item.entityId, (agentCounts.get(item.entityId) ?? 0) + 1);
  }
  const provisional = [...new Set([...speaking.map((item) => item.actorId),
    ...[...agentCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, policy.rosterTopAgents).map(([actorId]) => actorId)])];
  const roster: RosterSummary = options.roster ?? { reviewed: Boolean(snapshot.roleRoster?.reviews.length), actorIds: provisional };
  // Missing majors named by the review stay in the denominator (design 5.7): once an entity carries the name it joins the roster set, until then it is an open roster slot.
  const characterByName = new Map<string, string>();
  for (const entity of canonical.entities) if (entity.kind === "character") for (const name of [entity.canonicalName, ...entity.aliases]) if (!characterByName.has(name.trim())) characterByName.set(name.trim(), entity.id);
  const missingMajors = (roster.missing ?? []).map((name) => ({ name, actorId: characterByName.get(name.trim()) }));
  const rosterActors = [...new Set([...roster.actorIds, ...missingMajors.flatMap((item) => item.actorId ? [item.actorId] : [])])];
  const rosterSet = new Set(rosterActors);
  measures.splice(rosterReviewedAt, 0, measure({ id: "characters.roster-reviewed", layer: "characters", label: "role roster independently reviewed", denominator: "roster",
    numerator: roster.reviewed ? 1 : 0, total: 1, target: 1, ...(roster.reviewed ? {} : { status: "unknown" as const }),
    note: `${roster.actorIds.length} roster actors${missingMajors.length ? `, ${missingMajors.length} missing majors named by review (${missingMajors.filter((item) => !item.actorId).length} without an entity yet)` : ""}; without a review the major-role denominator is provisional.` }));
  const rosterStatus = (computed: number, total: number, target: number): MeasureStatus | undefined =>
    roster.reviewed ? undefined : total === 0 ? "unknown" : computed / total >= target ? undefined : "unknown";
  // Every roster role (reviewed majors and missing majors) needs an entity, a model and a goal, or a reviewed "not stated".
  const rosterSlots: Array<{ subject: string; name: string; actorId?: string }> = [
    ...rosterActors.map((actorId) => ({ subject: `actor:${actorId}`, name: names.get(actorId) ?? actorId, actorId })),
    ...missingMajors.filter((item) => !item.actorId).map((item) => ({ subject: `missing:${item.name}`, name: item.name })),
  ];
  const rosterModelled = (slot: typeof rosterSlots[number]) => Boolean(disposed("characters.roster-modelled", slot.subject))
    || Boolean(slot.actorId && models.has(slot.actorId) && (goalsBy.get(slot.actorId)?.length ?? 0) > 0);
  const rosterUnmodelled = rosterSlots.filter((slot) => !rosterModelled(slot));
  const rosterModelStatus = rosterStatus(rosterSlots.length - rosterUnmodelled.length, rosterSlots.length, targets.characterDepth);
  measures.splice(rosterReviewedAt + 1, 0, measure({ id: "characters.roster-modelled", layer: "characters", label: "roster roles (reviewed and missing majors) with an entity, a character model and a goal, or a reviewed \"not stated\"", denominator: "roster",
    numerator: rosterSlots.length - rosterUnmodelled.length, total: rosterSlots.length, target: targets.characterDepth, ...(rosterModelStatus ? { status: rosterModelStatus } : {}),
    note: `${missingMajors.length} missing majors in the denominator.` }));

  // Relations between roster characters who share scenes.
  const related = new Set<string>();
  const relationshipEnds = new Map<string, { from?: string; to?: string }>();
  for (const operation of [...canonical.initialWorld.delta.operations, ...canonical.events.flatMap((event) => event.observedOutcome.operations)]) {
    if (!("field" in operation) || !("entityId" in operation) || !("value" in operation) || typeof operation.value !== "string") continue;
    if (operation.field !== "relationship.from" && operation.field !== "relationship.to") continue;
    const ends = relationshipEnds.get(operation.entityId) ?? {};
    if (operation.field === "relationship.from") ends.from = operation.value; else ends.to = operation.value;
    relationshipEnds.set(operation.entityId, ends);
  }
  for (const ends of relationshipEnds.values()) if (ends.from && ends.to) related.add(pairSubject(ends.from, ends.to));
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.op === "adjust-relationship" && typeof record.fromActorId === "string" && typeof record.toActorId === "string") related.add(pairSubject(record.fromActorId, record.toActorId));
    for (const item of Object.values(record)) if (item && typeof item === "object") visit(item);
  };
  visit([canonical.events, canonical.semanticEffects, canonical.initialWorld]);
  for (const proposition of canonical.propositions) {
    if (proposition.object.kind === "entity" && characters.has(proposition.subjectEntityId) && characters.has(proposition.object.entityId)) related.add(pairSubject(proposition.subjectEntityId, proposition.object.entityId));
  }
  const pairScenes = new Map<string, number>();
  for (const scene of scenes) {
    const present = [...new Set([...scene.presentActorIds, ...scene.viewpointActorIds])].filter((id) => rosterSet.has(id)).sort();
    for (let left = 0; left < present.length; left += 1) for (let right = left + 1; right < present.length; right += 1) {
      const subject = pairSubject(present[left]!, present[right]!);
      pairScenes.set(subject, (pairScenes.get(subject) ?? 0) + 1);
    }
  }
  const pairs = [...pairScenes.entries()].filter(([, count]) => count >= policy.rosterPairScenes);
  const pairDone = (subject: string) => related.has(subject) || Boolean(disposed("relations.roster-pairs", subject));
  const pairsDone = pairs.filter(([subject]) => pairDone(subject)).length;
  const rosterPairStatus = rosterStatus(pairsDone, pairs.length, targets.rosterPairs);
  measures.push(measure({ id: "relations.roster-pairs", layer: "relations", label: `roster pairs co-present in ≥${policy.rosterPairScenes} scenes with a directed relation record or an explicit "not stated"`, denominator: "roster",
    numerator: pairsDone, total: pairs.length, target: targets.rosterPairs, ...(rosterPairStatus ? { status: rosterPairStatus } : {}),
    note: `${related.size} related pairs recorded${roster.reviewed ? "" : "; roster not independently reviewed, so the denominator is provisional"}.` }));

  // Time: events whose mention extent states a time should carry a story time that is not an ordinal label.
  // A time expression the observation review rejected (an idiom, a date in a quoted document) is not story time.
  const rejectedTimes = new Set((options.handled?.times ?? []).map((range) => `${range.startByte}-${range.endByte}`));
  const storyTimes = inventory.times.filter((item) => !rejectedTimes.has(`${item.startByte}-${item.endByte}`));
  const timeUnion = new RangeUnion(storyTimes);
  const timed = events.filter((event) => (eventExtents.get(event.id) ?? []).some((range) => timeUnion.overlaps(range.startByte, range.endByte)));
  const anchored = (event: typeof events[number]) => ["exact", "range", "relative"].includes(event.storyTime.kind);
  const unanchoredEvents = timed.filter((event) => !anchored(event) && !disposed("time.anchored-events", `event:${event.id}`));
  measures.push(measure({ id: "time.anchored-events", layer: "time", label: "events whose extent contains an explicit time expression and whose story time is exact, a range or relative", denominator: "source",
    numerator: timed.filter(anchored).length, total: timed.length, target: targets.anchoredEvents,
    note: `${storyTimes.length} explicit time expressions in scope${rejectedTimes.size ? ` (${inventory.times.length - storyTimes.length} reviewed as not story time)` : ""}; ${events.filter(anchored).length} events anchored overall.` }));

  // Causality: key events are roster-agent events with an effect.
  const effectfulIds = new Set(changing.map((event) => event.id));
  const rosterAgentEvents = new Set(canonical.eventParticipations.filter((item) => item.role === "agent" && rosterSet.has(item.entityId)).map((item) => item.eventId));
  const keyEvents = events.filter((event) => effectfulIds.has(event.id) && rosterAgentEvents.has(event.id));
  const dependents = new Set(canonical.eventRelations.filter((relation) => ["cause", "enable", "motivate", "prevent"].includes(relation.type)).map((relation) => relation.toEventId));
  const conditioned = (event: typeof events[number]) => event.preconditions.length > 0 || event.causalParents.length > 0 || dependents.has(event.id)
    || Boolean(disposed("causality.conditioned-key-events", `event:${event.id}`));
  const conditionedCount = keyEvents.filter(conditioned).length;
  const causalityStatus = rosterStatus(conditionedCount, keyEvents.length, targets.conditionedKeyEvents);
  measures.push(measure({ id: "causality.conditioned-key-events", layer: "causality", label: "key events (roster agent, non-empty effect) with a precondition, a typed causal dependency or a reviewed \"unconditioned\"", denominator: "roster",
    numerator: conditionedCount, total: keyEvents.length, target: targets.conditionedKeyEvents, ...(causalityStatus ? { status: causalityStatus } : {}) }));
  const autonomous = canonical.normTemplates.length + canonical.processTemplates.length
    + canonical.possibilities.filter((item) => JSON.stringify(item).match(/"(?:obligation|pressure|process|deadline|pursuit)"/u)).length;
  measures.push(measure({ id: "possibility.autonomous-templates", layer: "possibility", label: "possibility templates that stay in force after divergence (norms, processes, obligations, pressures)", denominator: "internal",
    numerator: autonomous, total: autonomous, target: targets.autonomousTemplates, atLeast: true,
    note: `${canonical.normTemplates.length} norm templates, ${canonical.processTemplates.length} process templates, ${canonical.possibilities.length} possibility templates.` }));

  // Lore: frequent setting vocabulary needs a landing place.
  const quotedCounts = new Map<string, number>();
  const text = Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("utf8");
  for (const span of fullInventory.speech) {
    if (span.kind !== "embedded") continue;
    const surface = Buffer.from(source.buffer, source.byteOffset + span.startByte, span.endByte - span.startByte).toString("utf8").slice(1, -1).trim();
    if (Array.from(surface).length >= 2 && Array.from(surface).length <= 12 && /\p{Script=Han}|[A-Za-z]{3,}/u.test(surface)) quotedCounts.set(surface, 0);
  }
  // Person names are identity material, not setting vocabulary.
  const personNames = new Set([...fullInventory.lexicon.entries.map((entry) => entry.surface), ...fullInventory.lexicon.collisions.map((item) => item.surface),
    ...canonical.entities.filter((entity) => entity.kind === "character").flatMap((entity) => [entity.canonicalName, ...entity.aliases].map((name) => name.trim()))]);
  for (const surface of personNames) quotedCounts.delete(surface);
  for (const surface of quotedCounts.keys()) quotedCounts.set(surface, countOccurrences(text, surface));
  const terms = new Map<string, LoreTerm>();
  for (const [surface, occurrences] of quotedCounts) if (occurrences >= policy.loreTermThreshold) terms.set(surface, { surface, occurrences, origin: "quoted-term" });
  for (const item of options.loreTerms ?? []) if (item.occurrences >= policy.loreTermThreshold) terms.set(item.surface, item);
  const scopedTerms = [...terms.values()].filter((term) => !scope || countOccurrences(text.slice(byteToChar(text, scope.startByte), byteToChar(text, Math.min(scope.endByte, source.byteLength))), term.surface) > 0);
  const nonCharacterNames = new Set(canonical.entities.filter((entity) => entity.kind !== "character").flatMap((entity) => [entity.canonicalName, ...entity.aliases].map((name) => name.trim())));
  const mechanismText = JSON.stringify([canonical.rules, canonical.actionSchemas, canonical.normTemplates, canonical.processTemplates]);
  const grounded = (term: LoreTerm) => nonCharacterNames.has(term.surface) || mechanismText.includes(term.surface) || Boolean(disposed("lore.terms-grounded", `term:${term.surface}`));
  const ungrounded = scopedTerms.filter((term) => !grounded(term)).sort((a, b) => b.occurrences - a.occurrences || a.surface.localeCompare(b.surface));
  measures.push(measure({ id: "lore.terms-grounded", layer: "lore", label: `setting terms occurring ≥${policy.loreTermThreshold} times grounded in a concept entity, rule, mechanism, institution or a reviewed "narration only"`, denominator: "source",
    numerator: scopedTerms.length - ungrounded.length, total: scopedTerms.length, target: targets.termsGrounded,
    note: `${[...terms.values()].filter((term) => term.origin === "quoted-term").length} frequent quoted terms, ${[...terms.values()].filter((term) => term.origin === "census").length} census lore entries.` }));

  // Cost (information only).
  const usage = options.usage ?? null;
  const scopeBytes = scope ? Math.min(scope.endByte, source.byteLength) - scope.startByte : source.byteLength;
  const accepted = snapshot.annotations.length + snapshot.entityResolutions.length + snapshot.eventResolutions.length + canonical.entities.length + canonical.events.length
    + canonical.eventParticipations.length + canonical.sceneOccurrences.length + canonical.models.length + canonical.goals.length + canonical.rules.length + canonical.actionSchemas.length;
  measures.push(measure({ id: "cost.per-source-kb", layer: "cost", label: "nominal model cost per KB of source (USD × 1000)", denominator: "source",
    numerator: usage ? Math.round(usage.nominalUsd * 1000 * 1024 / Math.max(1, scopeBytes) * 1000) / 1000 : 0, total: scopeBytes, lowerIsBetter: true,
    ...(usage ? { note: `${usage.runs} runs; ${usage.inputTokens} input, ${usage.outputTokens} output, ${usage.cacheReadTokens} cache-read tokens; $${usage.nominalUsd.toFixed(2)} nominal.` } : { note: "No usage summary supplied." }) }));
  measures.push(measure({ id: "cost.per-accepted-artifact", layer: "cost", label: "nominal model cost per accepted artifact (USD × 1000)", denominator: "internal",
    numerator: usage && accepted ? Math.round(usage.nominalUsd * 1000 / accepted * 1000) / 1000 : 0, total: accepted, lowerIsBetter: true }));

  const summary = { satisfied: 0, gap: 0, unknown: 0, info: 0 };
  for (const item of measures) summary[item.status] += 1;
  const unannotatedSpeech = mergeAdjacent(speechUnion.ranges, (left, right) => ({ startByte: left.startByte, endByte: right.endByte }), 64);
  const limit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
  const head = <T>(items: readonly T[]) => items.slice(0, limit);
  const spans = (items: ReadonlyArray<ByteRange>) => items.map(({ startByte, endByte }) => ({ startByte, endByte }));
  const blockingRanges = spans(blocking.map((unit) => unit.anchor)).sort((a, b) => a.startByte - b.startByte);
  const status = (id: string) => measures.find((item) => item.id === id)?.status;
  return {
    version: WORLD_COMPLETENESS_VERSION,
    policy: policy.version,
    sourceId,
    ...(scope ? { scope } : {}),
    measures,
    summary,
    speakingCharacters: speaking,
    queues: {
      hiddenUnits: { total: hiddenRanges.length, ranges: head([...hiddenRanges].sort((a, b) => b.units - a.units || a.startByte - b.startByte)) },
      unannotatedSpeech: { total: unannotatedSpeech.length, ranges: head(unannotatedSpeech) },
      blockingUnits: { total: blockingRanges.length, ranges: head(blockingRanges) },
      unannotatedNames: { total: unannotatedNames.ranges.length, ranges: head(unannotatedNames.ranges) },
      unattributedSpeech: { total: unattributedSpeech.length, ranges: head(spans(unattributedSpeech)) },
      unresolvedEntityMentions: { total: unresolvedEntityMentions.length, mentions: head(unresolvedEntityMentions.flatMap((item) => item.annotationType === "entity-mention" ? [{ mentionId: item.id, startByte: item.anchor.startByte, endByte: item.anchor.endByte }] : [])) },
      unresolvedEventMentions: { total: unresolvedEventMentions.length, mentions: head(unresolvedEventMentions.flatMap((item) => item.annotationType === "event-mention" ? [{ mentionId: item.id, startByte: item.triggerAnchor.startByte, endByte: item.triggerAnchor.endByte, salience: item.salience }] : [])) },
      // Ratio measures queue their exceptions only while the measure misses its target.
      uneffectfulEvents: status("events.effectful") === "gap" ? head(events.filter((event) => !effectful.includes(event)).map((event) => event.id)) : [],
      untypedAgentEvents: status("events.typed-agent") === "gap" ? head(untypedAgentEvents.map((event) => event.id)) : [],
      speechOutsideBeats: status("events.speech-in-beats") === "gap" ? { total: speechOutsideBeats.length, ranges: head(spans(speechOutsideBeats)) } : { total: 0, ranges: [] },
      narrativeOutsideScenes: status("scenes.narrative-covered") === "gap" ? { total: narrativeOutsideScenes.length, ranges: head(narrativeOutsideScenes) } : { total: 0, ranges: [] },
      unpositionedOpening: [...openingActors].filter((id) => !openingPositioned.has(id)).sort(),
      rosterUnmodelled: head(rosterUnmodelled.map((slot) => ({ subject: slot.subject, name: slot.name, ...(slot.actorId ? { actorId: slot.actorId } : {}) }))),
      speakingNotEnterable,
      scenesWithoutEvents: scenes.filter((scene) => scene.eventIds.length === 0).map((scene) => scene.id),
      scenesWithoutLocation: scenes.filter((scene) => !scene.locationId && !scene.locationUnknown).map((scene) => scene.id),
      absentSpeakers: head(absentSpeakers),
      locationsOffGraph: [...used].filter((id) => !graph.has(id) && !disposed("space.locations-on-graph", `location:${id}`)).sort(),
      nameCollisions: inventory.lexicon.collisions,
      eventGaps: eventGaps.slice(0, 10),
      unattachedAliases: head([...unattached.values()].sort((a, b) => b.mentions - a.mentions || a.surface.localeCompare(b.surface))),
      genericNames: generic.map((entity) => ({ entityId: entity.id, name: entity.canonicalName })),
      rosterPairs: head(pairs.filter(([subject]) => !pairDone(subject)).map(([subject, count]) => ({ subject, scenes: count })).sort((a, b) => b.scenes - a.scenes || a.subject.localeCompare(b.subject))),
      unanchoredEvents: status("time.anchored-events") === "gap" ? head(unanchoredEvents.map((event) => event.id)) : [],
      unconditionedKeyEvents: head(keyEvents.filter((event) => !conditioned(event)).map((event) => event.id)),
      ungroundedTerms: head(ungrounded),
      unacquiredKnowledge: head(learns.filter((item) => !acquired.has(`${item.eventId}:${item.actorId}:${item.claimId}`))),
    },
    roster: { ...roster, actorIds: rosterActors },
  };
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + needle.length)) count += 1;
  return count;
}

/** UTF-16 index of a UTF-8 byte offset (clamped). */
function byteToChar(text: string, byte: number): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes >= byte) return index;
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; index += 1; } else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  return text.length;
}

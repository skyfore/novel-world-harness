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
export const WORLD_COMPLETENESS_VERSION = "world-completeness-v1" as const;

export type CompletenessLayer = "source" | "observation" | "identity" | "events" | "scenes" | "characters" | "space" | "knowledge" | "agency";
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
  version: "completeness-policy-v1",
  /** A character with at least this many attributed lines is a speaking character (a source-derived role denominator). */
  speakingLineThreshold: 6,
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
    narrativeInScenes: 0.95,
    sceneLocation: 1,
    speakerPresence: 1,
    characterDepth: 1,
    locationsOnGraph: 1,
    openingPositions: 1,
    acquisitions: 1,
    enterable: 1,
  },
} as const;
export type CompletenessPolicy = typeof DEFAULT_COMPLETENESS_POLICY;

export type ByteRange = { startByte: number; endByte: number };
export type HiddenUnitRange = ByteRange & { units: number; speech: number; names: number; statuses: string[] };

export type WorldCompletenessReport = {
  version: typeof WORLD_COMPLETENESS_VERSION;
  policy: CompletenessPolicy["version"];
  sourceId: string;
  measures: CompletenessMeasure[];
  summary: { satisfied: number; gap: number; unknown: number; info: number };
  /** Source-derived character denominator, most attributed lines first. */
  speakingCharacters: Array<{ actorId: string; name: string; lines: number; occurrences: number; annotatedMentions: number; model: boolean; depth: boolean; goals: number; effectfulGoals: number; scenes: number }>;
  /** Bounded, ordered work lists for the repair milestones; `total` keeps the tail discoverable. */
  queues: {
    hiddenUnits: { total: number; ranges: HiddenUnitRange[] };
    unannotatedSpeech: { total: number; ranges: ByteRange[] };
    scenesWithoutEvents: string[];
    scenesWithoutLocation: string[];
    absentSpeakers: Array<{ sceneId: string; actorId: string; lines: number }>;
    locationsOffGraph: string[];
    nameCollisions: Array<{ surface: string; entityIds: string[] }>;
    eventGaps: ByteRange[];
  };
};

const QUEUE_LIMIT = 50;

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

function measure(input: Omit<CompletenessMeasure, "ratio" | "status"> & { status?: MeasureStatus; lowerIsBetter?: boolean }): CompletenessMeasure {
  const { lowerIsBetter, ...rest } = input;
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

export function measureWorldCompleteness(bundle: PreparedNovelBundle, source: Uint8Array, options: {
  policy?: CompletenessPolicy;
  inventory?: LexicalInventory;
  /** Admission computed for this bundle when it carries none frozen. */
  admission?: AdmissionManifest | null;
} = {}): WorldCompletenessReport {
  const policy = options.policy ?? DEFAULT_COMPLETENESS_POLICY;
  const targets = policy.targets;
  const { canonical, compilerSnapshot: snapshot } = bundle;
  const sourceId = bundle.source.id;
  const annotations = snapshot.annotations;
  const inventory = options.inventory ?? buildLexicalInventory({ source, entities: canonical.entities, annotations, entityResolutions: snapshot.entityResolutions });
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
  for (const item of snapshot.eventResolutions) {
    if (supersededEvent.has(item.id) || !item.canonicalEventId) continue;
    for (const mentionId of item.eventMentionIds) mentionEvent.set(mentionId, item.canonicalEventId);
  }
  const canonicalEventIds = new Set(canonical.events.map((event) => event.id));

  const quotations = annotations.filter((item) => item.annotationType === "quotation");
  const entityMentions = annotations.filter((item) => item.annotationType === "entity-mention");
  const eventMentions = annotations.filter((item) => item.annotationType === "event-mention");
  const discourse = new Map(annotations.filter((item) => item.annotationType === "discourse-segment").map((item) => [item.id, item.anchors]));
  const quotationUnion = new RangeUnion(quotations.map((item) => item.anchor));
  const mentionUnion = new RangeUnion(entityMentions.map((item) => item.anchor));
  const resolvedEventExtents = eventMentions.filter((item) => canonicalEventIds.has(mentionEvent.get(item.id) ?? "")).flatMap((item) => item.extentAnchors);
  const eventUnion = new RangeUnion(resolvedEventExtents);
  const bindingUnion = new RangeUnion(snapshot.evidenceBindings.flatMap((binding) => binding.assertions.flatMap((assertion) =>
    assertion.anchors.filter((anchor) => anchor.sourceId === sourceId))));

  // L0 source accounting.
  const records = new Map((snapshot.accounting?.records ?? []).map((record) => [record.unitId, record]));
  const units = baseStructuralUnits(snapshot.structure).filter((unit) => unit.kind !== "non-scene");
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
  measures.push(measure({ id: "observation.speech-attributed", layer: "observation", label: "direct-speech spans with a character speaker (annotation or host lexical cue)", denominator: "source",
    numerator: attributedAny, total: speech.length, target: targets.speechAttributed,
    note: `${annotationSpeaker.size} by compiled quotation annotations, ${attributedAny - annotationSpeaker.size} by host lexical cue only.` }));
  measures.push(measure({ id: "observation.names-annotated", layer: "observation", label: "established-name occurrences covered by an entity-mention annotation", denominator: "source",
    numerator: occurrences.filter((item) => mentionUnion.overlaps(item.startByte, item.endByte)).length, total: occurrences.length, target: targets.namesAnnotated }));
  measures.push(measure({ id: "observation.event-mentions-resolved", layer: "observation", label: "event mentions resolved into a canonical event", denominator: "internal",
    numerator: eventMentions.filter((item) => canonicalEventIds.has(mentionEvent.get(item.id) ?? "")).length, total: eventMentions.length, target: targets.eventMentionsResolved,
    note: `${eventMentions.filter((item) => item.salience === "major" && !canonicalEventIds.has(mentionEvent.get(item.id) ?? "")).length} unresolved mentions are marked major.` }));

  // Identity.
  measures.push(measure({ id: "identity.name-collisions", layer: "identity", label: "proper names attested for more than one character entity", denominator: "source",
    numerator: inventory.lexicon.collisions.length, total: inventory.lexicon.entries.length + inventory.lexicon.collisions.length, target: targets.nameCollisions, lowerIsBetter: true,
    note: "Each collision is a duplicate-entity or alias-scope question for identity review." }));
  measures.push(measure({ id: "identity.mentions-resolved", layer: "identity", label: "entity mentions with a resolution in force", denominator: "internal",
    numerator: entityMentions.filter((item) => resolvedMentions.has(item.id)).length, total: entityMentions.length, target: 1 }));

  // Events and beats.
  const scenes = canonical.sceneOccurrences;
  const effectEvents = new Set([
    ...canonical.semanticEffects.flatMap((item) => "eventId" in item && typeof item.eventId === "string" ? [item.eventId] : []),
    ...canonical.eventExecutions.map((item) => item.canonicalEventId),
  ]);
  const effectful = canonical.events.filter((event) => event.observedOutcome.operations.length > 0
    || (event.observedKnowledge?.operations.length ?? 0) > 0 || effectEvents.has(event.id));
  const agents = new Set(canonical.eventParticipations.filter((item) => item.role === "agent").map((item) => item.eventId));
  measures.push(measure({ id: "events.scenes-with-events", layer: "events", label: "scenes with at least one canonical event", denominator: "internal",
    numerator: scenes.filter((scene) => scene.eventIds.length > 0).length, total: scenes.length, target: targets.scenesWithEvents }));
  measures.push(measure({ id: "events.effectful", layer: "events", label: "events with a state, knowledge, semantic or execution effect", denominator: "internal",
    numerator: effectful.length, total: canonical.events.length, target: targets.effectfulEvents }));
  measures.push(measure({ id: "events.typed-agent", layer: "events", label: "events with a typed agent participation", denominator: "internal",
    numerator: canonical.events.filter((event) => agents.has(event.id)).length, total: canonical.events.length, target: targets.typedAgent }));
  measures.push(measure({ id: "events.speech-in-beats", layer: "events", label: "direct-speech spans inside a canonical event's mention extent", denominator: "source",
    numerator: speech.filter((span) => eventUnion.overlaps(span.startByte, span.endByte)).length, total: speech.length,
    note: "Dialogue outside every event extent is talk the world model does not stage as a beat." }));
  const narrativeRanges = new RangeUnion(narrative.map((unit) => unit.anchor));
  const eventGaps: ByteRange[] = [];
  let cursor = narrativeRanges.ranges[0]?.startByte ?? 0;
  for (const range of [...eventUnion.ranges, { startByte: source.byteLength, endByte: source.byteLength }]) {
    if (range.startByte > cursor) eventGaps.push({ startByte: cursor, endByte: range.startByte });
    cursor = Math.max(cursor, range.endByte);
  }
  eventGaps.sort((a, b) => (b.endByte - b.startByte) - (a.endByte - a.startByte));
  measures.push(measure({ id: "events.largest-gap-bytes", layer: "events", label: "largest source stretch outside every canonical event extent (bytes)", denominator: "source",
    numerator: eventGaps[0] ? eventGaps[0].endByte - eventGaps[0].startByte : 0, total: source.byteLength, lowerIsBetter: true }));

  // Scenes.
  // Discourse anchors mark scene boundaries; the scene's evidence spans are the extent it claims.
  const sceneRanges = new Map(scenes.map((scene) => [scene.id, new RangeUnion([
    ...scene.discourseSegmentIds.flatMap((id) => discourse.get(id) ?? []),
    ...scene.evidence.flatMap(({ span }) => span.sourceId === sourceId && span.startByte !== undefined && span.endByte !== undefined
      ? [{ startByte: span.startByte, endByte: span.endByte }] : []),
  ])]));
  const allSceneRanges = new RangeUnion([...sceneRanges.values()].flatMap((union) => union.ranges));
  measures.push(measure({ id: "scenes.narrative-covered", layer: "scenes", label: "narrative bytes inside a scene's extent (discourse anchors and scene evidence)", denominator: "source",
    numerator: narrative.reduce((total, unit) => total + allSceneRanges.coveredBytes(unit.anchor.startByte, unit.anchor.endByte), 0), total: narrativeBytes, target: targets.narrativeInScenes }));
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
    measures.push(measure({ id, layer: "characters", label, denominator: "source", numerator: speaking.filter(predicate).length, total: speaking.length, target }));
  speakingMeasure("characters.speaking-modelled", "speaking characters with a character model", (item) => item.model, targets.characterDepth);
  speakingMeasure("characters.speaking-with-disposition", "speaking characters whose model carries a trait or disposition", (item) => item.depth, targets.characterDepth);
  speakingMeasure("characters.speaking-with-goal", "speaking characters with at least one goal", (item) => item.goals > 0, targets.characterDepth);
  speakingMeasure("characters.speaking-in-scenes", "speaking characters recorded present in at least one scene", (item) => item.scenes > 0, targets.characterDepth);
  const roster = snapshot.roleRoster;
  measures.push(measure({ id: "characters.roster-reviewed", layer: "characters", label: "independent role-roster reviews", denominator: "roster",
    numerator: roster?.reviews.length ?? 0, total: roster ? 1 : 0, target: 1, ...(roster && roster.reviews.length === 0 ? { status: "unknown" as const } : {}),
    note: roster ? `${roster.candidates.length} roster candidates; without a review no major-role denominator exists.` : "No role roster in this bundle." }));

  // Space.
  const graph = new Set(canonical.spatialRelations.flatMap((relation) => spatialEndpoints(relation)));
  const locations = new Set(canonical.entities.filter((entity) => entity.kind === "location").map((entity) => entity.id));
  const used = new Set<string>(scenes.flatMap((scene) => scene.locationId ? [scene.locationId] : []));
  const locationWrites = [...canonical.initialWorld.delta.operations, ...canonical.events.flatMap((event) => event.observedOutcome.operations)]
    .filter((operation) => "field" in operation && operation.field === "character.location" && "value" in operation && typeof operation.value === "string");
  for (const operation of locationWrites) if (locations.has((operation as { value: string }).value)) used.add((operation as { value: string }).value);
  measures.push(measure({ id: "space.locations-on-graph", layer: "space", label: "locations used by scenes or character positions that sit in the spatial graph", denominator: "internal",
    numerator: [...used].filter((id) => graph.has(id)).length, total: used.size, target: targets.locationsOnGraph,
    note: `${canonical.spatialRelations.length} spatial relations over ${locations.size} location entities.` }));
  const openingActors = new Set([...(canonical.initialWorld.participantPresence ?? []).map((item) => item.entityId)].filter((id) => characters.has(id)));
  const openingPositioned = new Set(canonical.initialWorld.delta.operations
    .filter((operation) => "field" in operation && operation.field === "character.location" && "entityId" in operation).map((operation) => (operation as { entityId: string }).entityId));
  measures.push(measure({ id: "space.opening-positions", layer: "space", label: "opening characters with a starting location", denominator: "internal",
    numerator: [...openingActors].filter((id) => openingPositioned.has(id)).length, total: openingActors.size, target: targets.openingPositions }));

  // Knowledge.
  const learns = canonical.events.flatMap((event) => (event.observedKnowledge?.operations ?? []).filter((operation) => operation.op === "learn")
    .map((operation) => ({ eventId: event.id, actorId: operation.actorId, claimId: operation.claimId })));
  const acquired = new Set(canonical.acquisitions.map((item) => `${item.canonicalEventId}:${item.actorId}:${item.claimId}`));
  measures.push(measure({ id: "knowledge.acquisition-paths", layer: "knowledge", label: "knowledge gains with an explicit acquisition path (observed / told / read / inferred)", denominator: "internal",
    numerator: learns.filter((item) => acquired.has(`${item.eventId}:${item.actorId}:${item.claimId}`)).length, total: learns.length, target: targets.acquisitions }));

  // Agency: can each speaking character actually be entered and act?
  const admission = bundle.admission ?? options.admission ?? null;
  if (admission) {
    const enterable = new Set(admission.cuts.filter((cut) => cut.tier !== "blocked").flatMap((cut) => cut.actors.filter((actor) => tierAtLeast(actor.tier, "enterable")).map((actor) => actor.actorId)));
    measures.push(measure({ id: "agency.speaking-enterable", layer: "agency", label: "speaking characters with at least one enterable cut", denominator: "source",
      numerator: speaking.filter((item) => enterable.has(item.actorId)).length, total: speaking.length, target: targets.enterable }));
  } else {
    measures.push(measure({ id: "agency.speaking-enterable", layer: "agency", label: "speaking characters with at least one enterable cut", denominator: "source",
      numerator: 0, total: speaking.length, target: targets.enterable, status: "unknown", note: "No admission manifest; rerun with --admission or use `compile-novel cuts`." }));
  }
  measures.push(measure({ id: "agency.effectful-goals", layer: "agency", label: "speaking characters with a goal whose candidate action changes state", denominator: "source",
    numerator: speaking.filter((item) => item.effectfulGoals > 0).length, total: speaking.length, target: targets.characterDepth }));

  const summary = { satisfied: 0, gap: 0, unknown: 0, info: 0 };
  for (const item of measures) summary[item.status] += 1;
  const unannotatedSpeech = mergeAdjacent(speechUnion.ranges, (left, right) => ({ startByte: left.startByte, endByte: right.endByte }), 64);
  return {
    version: WORLD_COMPLETENESS_VERSION,
    policy: policy.version,
    sourceId,
    measures,
    summary,
    speakingCharacters: speaking,
    queues: {
      hiddenUnits: { total: hiddenRanges.length, ranges: [...hiddenRanges].sort((a, b) => b.units - a.units || a.startByte - b.startByte).slice(0, QUEUE_LIMIT) },
      unannotatedSpeech: { total: unannotatedSpeech.length, ranges: unannotatedSpeech.slice(0, QUEUE_LIMIT) },
      scenesWithoutEvents: scenes.filter((scene) => scene.eventIds.length === 0).map((scene) => scene.id),
      scenesWithoutLocation: scenes.filter((scene) => !scene.locationId && !scene.locationUnknown).map((scene) => scene.id),
      absentSpeakers: absentSpeakers.slice(0, QUEUE_LIMIT),
      locationsOffGraph: [...used].filter((id) => !graph.has(id)).sort(),
      nameCollisions: inventory.lexicon.collisions,
      eventGaps: eventGaps.slice(0, 10),
    },
  };
}

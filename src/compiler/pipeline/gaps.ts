import crypto from "node:crypto";
import type { ByteRange, WorldCompletenessReport } from "../world-completeness.js";
import { artifactTools } from "./artifacts.js";
import { convergeCanonical } from "./canon.js";
import { identityTools } from "./identity.js";
import { observationTools, observationWindows } from "./observation.js";
import { openingTools } from "./opening.js";
import { gateOf, type ScopePlan, type StageContext, type StageDefinition } from "./runner.js";
import { sceneTools } from "./scenes.js";
import { ScopeText, windowUnits } from "./text.js";
import { sourceReadingTools, worldWorkItems } from "./world.js";
import { ENTITY_CENSUS_CLASSES, measureView, type PipelineView } from "./view.js";

/**
 * Gap loop (design 5.8, the gap-driven flow of design.md section 6): every
 * repair queue of the completeness report becomes bounded scopes — a source
 * range plus a target — so every measure that can be a gap has a repair path.
 * Items that hold the cut horizon back (unaccounted units) come first, then
 * the layer dependency order (observation, identity, scenes, world). Any
 * stage's tools may be used inside a scope (decision D3). A scope completes
 * when its target leaves the queue (fixed, or closed by a reviewed
 * disposition); one failing twice is held and the loop moves on.
 *
 * Range items are grouped per observation window (observation and identity)
 * or per discourse segment / scene (scenes), so a book yields a bounded
 * number of scopes. Queues are read unbounded, so held items at the head
 * never hide the tail.
 */
export type GapItem = {
  key: string;
  layer: "observation" | "identity" | "scenes" | "world";
  range: ByteRange;
  describe: string;
  segmentId?: string;
  /** Extra tool families the target needs beyond observation, identity, scenes and world. */
  opening?: boolean;
  /** Unaccounted source before a cut keeps the cut out of the admission horizon. */
  blocksHorizon?: boolean;
};
const LAYER_ORDER = ["observation", "identity", "scenes", "world"] as const;
const FALLBACK_WINDOW = 16 * 1024;
const LIST = 30;

const overlaps = (left: ByteRange, right: ByteRange) => left.startByte < right.endByte && right.startByte < left.endByte;

/** Report options for the gap loop: queues unbounded. */
export const GAP_REPORT_OPTIONS = { queueLimit: Number.POSITIVE_INFINITY } as const;

export function gapItems(view: PipelineView, report: WorldCompletenessReport, limit: number, windows: readonly ByteRange[] = []): GapItem[] {
  const whole = { startByte: 0, endByte: limit };
  const units = windowUnits(view.structure, view.bytes, whole);
  const labelAt = (byte: number) => units.find((unit) => unit.startByte <= byte && byte < unit.endByte)?.label ?? "?";
  const windowOf = (byte: number): ByteRange => windows.find((window) => window.startByte <= byte && byte < window.endByte)
    ?? { startByte: Math.floor(byte / FALLBACK_WINDOW) * FALLBACK_WINDOW, endByte: Math.min(limit, (Math.floor(byte / FALLBACK_WINDOW) + 1) * FALLBACK_WINDOW) };
  const segments = view.bundle.compilerSnapshot.annotations.flatMap((item) => item.annotationType === "discourse-segment"
    ? [{ id: item.id, kind: item.kind, range: { startByte: Math.min(...item.anchors.map((anchor) => anchor.startByte)), endByte: Math.max(...item.anchors.map((anchor) => anchor.endByte)) }, anchors: item.anchors }] : []);
  const segmentAt = (range: ByteRange) => segments.find((segment) => segment.anchors.some((anchor) => anchor.startByte <= range.startByte && range.startByte < anchor.endByte))
    ?? segments.find((segment) => segment.anchors.some((anchor) => overlaps(anchor, range)));
  const scenes = new Map(view.bundle.canonical.sceneOccurrences.map((scene) => [scene.id, scene]));
  const sceneRange = (sceneId: string): { range: ByteRange; segmentId?: string } => {
    const scene = scenes.get(sceneId);
    const spans = (scene?.evidence ?? []).flatMap(({ span }) => span.startByte !== undefined && span.endByte !== undefined ? [{ startByte: span.startByte, endByte: span.endByte }] : []);
    return { range: spans.length ? { startByte: Math.min(...spans.map((item) => item.startByte)), endByte: Math.max(...spans.map((item) => item.endByte)) } : whole, ...(scene?.discourseSegmentIds[0] ? { segmentId: scene.discourseSegmentIds[0] } : {}) };
  };
  const eventById = new Map(view.bundle.canonical.events.map((event) => [event.id, event]));
  /** The scene an event belongs to, or the segment its evidence falls in. */
  const eventHome = (eventId: string): { key: string; range: ByteRange; segmentId?: string } => {
    const event = eventById.get(eventId);
    const sceneId = event?.sceneOccurrenceIds?.[0];
    if (sceneId && scenes.has(sceneId)) return { key: sceneId, ...sceneRange(sceneId) };
    const start = Math.min(...(event?.evidence ?? []).map((item) => item.span.startByte ?? Number.MAX_SAFE_INTEGER));
    const segment = Number.isFinite(start) && start < Number.MAX_SAFE_INTEGER ? segmentAt({ startByte: start, endByte: start + 1 }) : undefined;
    return segment ? { key: segment.id, range: segment.range, segmentId: segment.id } : { key: "unplaced", range: whole };
  };
  const group = <T>(items: readonly T[], keyOf: (item: T) => string) => {
    const groups = new Map<string, T[]>();
    for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
    return groups;
  };
  const byWindow = <T extends ByteRange>(ranges: readonly T[]) => [...group(ranges, (range) => `${windowOf(range.startByte).startByte}`).entries()]
    .map(([, members]) => ({ window: windowOf(members[0]!.startByte), members }));
  const bySegment = <T extends ByteRange>(ranges: readonly T[]) => [...group(ranges, (range) => segmentAt(range)?.id ?? `w${windowOf(range.startByte).startByte}`).entries()]
    .map(([key, members]) => { const segment = segments.find((item) => item.id === key); return { key, segment, range: segment?.range ?? windowOf(members[0]!.startByte), members }; });
  const spanList = (ranges: readonly ByteRange[], prefix = "") => `${ranges.slice(0, LIST).map((range) => `${prefix}${range.startByte}@${labelAt(range.startByte)}`).join(", ")}${ranges.length > LIST ? ` (+${ranges.length - LIST} more)` : ""}`;
  const idList = (ids: readonly string[]) => `${ids.slice(0, LIST).join(", ")}${ids.length > LIST ? ` (+${ids.length - LIST} more)` : ""}`;
  const q = report.queues;

  const items: GapItem[] = [
    // Observation: unaccounted source first (it holds the cut horizon back).
    ...q.hiddenUnits.ranges.map((range) => ({ key: `hidden:${range.startByte}-${range.endByte}`, layer: "observation" as const, range, blocksHorizon: true,
      describe: `Units ${labelAt(range.startByte)}.. closed as ${range.statuses.join("/")} hide ${range.speech} speech span(s) and ${range.names} name(s): review their candidates and annotate them.` })),
    ...byWindow(q.blockingUnits.ranges).map(({ window, members }) => ({ key: `blocking@${window.startByte}`, layer: "observation" as const, range: window, blocksHorizon: true,
      describe: `Units still unresolved: ${members.slice(0, LIST).map((range) => labelAt(range.startByte)).join(", ")}${members.length > LIST ? ` (+${members.length - LIST})` : ""}. Annotate what they hold (review candidates, mentions, events, discourse segments) or close a contentless unit with account_units.` })),
    ...byWindow(q.unannotatedSpeech.ranges).map(({ window, members }) => ({ key: `speech@${window.startByte}`, layer: "observation" as const, range: window,
      describe: `Direct speech without a quotation annotation near ${spanList(members, "s")}: review those speech candidates (list_open_candidates).` })),
    ...byWindow(q.unannotatedNames.ranges).map(({ window, members }) => ({ key: `names@${window.startByte}`, layer: "observation" as const, range: window,
      describe: `Name occurrences without an entity mention: ${spanList(members, "n")}. Accept each name candidate, or reject it with the reason the surface is not that name here.` })),
    ...byWindow(q.unattributedSpeech.ranges).map(({ window, members }) => ({ key: `attribution@${window.startByte}`, layer: "observation" as const, range: window,
      describe: `Direct speech with no character speaker: ${spanList(members, "s")}. Give each its speaker (review_observation_candidates with the s-id and speaker; resolve a speaker mention with resolve_mentions), or record observation.speech-attributed speech:<start byte> unknown when the text does not say who speaks.` })),
    // Identity. A name that joined the lexicon after the identity stage (observation feedback) still needs its one decision.
    ...undecidedSurfaces(view, limit).map((entry) => ({ key: `lexicon:${entry.surface}`, layer: "identity" as const, range: whole,
      describe: `Lexicon surface "${entry.surface}" (${entry.class}, ${entry.occurrences} occurrences) has no identity decision: create its entity if needed (propose_entities), then decide it (decide_lexicon_entries) so the host resolves every mention.` })),
    ...q.nameCollisions.map((item) => ({ key: `collision:${item.surface}`, layer: "identity" as const, range: whole, describe: `"${item.surface}" resolves to ${item.entityIds.join(" and ")}: give ranged decisions or per-mention resolutions.` })),
    ...q.unattachedAliases.map((item) => ({ key: `alias:${item.entityId}:${item.surface}`, layer: "identity" as const, range: whole, describe: `Mentions "${item.surface}" resolve to ${item.entityId} but it is not a recorded alias: decide the surface (decide_lexicon_entries) so the host attaches it.` })),
    ...q.genericNames.map((item) => ({ key: `generic:${item.entityId}`, layer: "identity" as const, range: whole, describe: `Entity ${item.entityId} is named "${item.name}", a pronoun or bare noun: re-propose it with a qualifying derived label from the text.` })),
    ...[...group(q.unresolvedEntityMentions.mentions, (item) => `${windowOf(item.startByte).startByte}`).values()].map((members) => ({ key: `mentions@${windowOf(members[0]!.startByte).startByte}`, layer: "identity" as const,
      range: windowOf(members[0]!.startByte), describe: `Entity mentions without a resolution: ${idList(members.map((item) => item.mentionId))}. Resolve each (resolve_mentions: resolved, non-referential, ambiguous with candidates), creating entities when needed.` })),
    // Scenes.
    ...q.scenesWithoutLocation.map((id) => ({ key: `scene-location:${id}`, layer: "scenes" as const, ...sceneRange(id), describe: `Scene ${id} has neither a location nor a reasoned unknown: re-propose the scene (propose_scene).` })),
    ...q.absentSpeakers.map((item) => ({ key: `absent-speaker:${item.sceneId}:${item.actorId}`, layer: "scenes" as const, ...sceneRange(item.sceneId), describe: `${item.actorId} speaks ${item.lines} line(s) in ${item.sceneId} but is not recorded present: re-propose the scene with them present.` })),
    ...q.scenesWithoutEvents.map((id) => ({ key: `scene-events:${id}`, layer: "scenes" as const, ...sceneRange(id), describe: `Scene ${id} has no beats: propose its beats.` })),
    ...bySegment(q.unresolvedEventMentions.mentions).map(({ key, segment, range, members }) => ({ key: `event-mentions@${key}`, layer: "scenes" as const, range, ...(segment ? { segmentId: segment.id } : {}),
      describe: `Event mentions not in canon: ${idList(members.map((item) => `${item.mentionId} (${item.salience})`))}. Make each a beat (propose_beats), bind it to an existing event (resolve_event_mentions), or resolve it non-referential with the reason it is not an occurrence.` })),
    ...[...group(q.uneffectfulEvents, (id) => eventHome(id).key).values()].map((ids) => ({ key: `effect@${eventHome(ids[0]!).key}`, layer: "scenes" as const, ...omitKey(eventHome(ids[0]!)),
      describe: `Events with no effect: ${idList(ids)}. Re-propose each beat (propose_beats, same id) with the state or knowledge change the text states, propose a semantic-effect artifact, or record events.effectful event:<id> no-change with the reason.` })),
    ...[...group(q.untypedAgentEvents, (id) => eventHome(id).key).values()].map((ids) => ({ key: `agent@${eventHome(ids[0]!).key}`, layer: "scenes" as const, ...omitKey(eventHome(ids[0]!)),
      describe: `Events with no typed agent: ${idList(ids)}. Re-propose each beat (propose_beats, same id) with the agent first, or record events.typed-agent event:<id> not-stated when the occurrence has no agent.` })),
    ...bySegment(q.speechOutsideBeats.ranges).map(({ key, segment, range, members }) => ({ key: `beats@${key}`, layer: "scenes" as const, range, ...(segment ? { segmentId: segment.id } : {}),
      describe: `Dialogue outside every beat: ${spanList(members, "speech:")}. Add an event mention covering the exchange (propose_event_mentions) and a beat for it, or record events.speech-in-beats speech:<start byte> narration-only when the line stages nothing.` })),
    ...bySegment(q.narrativeOutsideScenes.ranges).map(({ key, segment, range, members }) => ({ key: `coverage@${key}`, layer: "scenes" as const, range, ...(segment ? { segmentId: segment.id } : {}),
      describe: segment
        ? `Narrative in ${segment.kind} segment ${segment.id} (${labelAt(segment.range.startByte)}..) lies outside every scene: propose_scene for it when it stages an occurrence, or record scenes.narrative-covered segment:${segment.id} narration-only with the reason.`
        : `Narrative outside every discourse segment: ${members.slice(0, LIST).map((item) => labelAt(item.startByte)).join(", ")}. Mark it with propose_discourse_segments.` })),
    ...[...group(q.unanchoredEvents, (id) => eventHome(id).key).values()].map((ids) => ({ key: `time@${eventHome(ids[0]!).key}`, layer: "scenes" as const, ...omitKey(eventHome(ids[0]!)),
      describe: `Events whose text states a time but whose story time is an ordinal label: ${idList(ids)}. Re-propose each beat (propose_beats, same id) with an exact, range or relative story time from the stated expression, or record time.anchored-events event:<id> not-stated when the expression is not this event's time.` })),
    ...(q.unpositionedOpening.length ? [{ key: "opening", layer: "scenes" as const, range: whole, opening: true,
      describe: `Opening characters with no starting location: ${idList(q.unpositionedOpening)}. Re-propose the initial world (propose_initial_world) with their positions.` }] : []),
    // World.
    ...worldWorkItems(report).map((item) => ({ key: `world:${item}`, layer: "world" as const, range: whole, describe: `World work item ${item}.` })),
  ];
  return items.sort((a, b) => Number(Boolean(b.blocksHorizon)) - Number(Boolean(a.blocksHorizon))
    || (a.blocksHorizon && b.blocksHorizon ? a.range.startByte - b.range.startByte : 0)
    || LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer) || a.range.startByte - b.range.startByte || a.key.localeCompare(b.key));
}

/** Entity-class lexicon surfaces in range with no identity decision. */
export function undecidedSurfaces(view: PipelineView, limit: number) {
  const decided = new Set(view.decisions.map((item) => item.surface));
  return view.census.filter((entry) => ENTITY_CENSUS_CLASSES.has(entry.class) && entry.firstByte < limit && Array.from(entry.surface).length >= 2 && !decided.has(entry.surface));
}

function omitKey(home: { key: string; range: ByteRange; segmentId?: string }): { range: ByteRange; segmentId?: string } {
  return { range: home.range, ...(home.segmentId ? { segmentId: home.segmentId } : {}) };
}

const scopeIdFor = (sourceId: string, key: string) => `gaps-${sourceId}-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}`;

async function currentItems(ctx: StageContext, view: PipelineView): Promise<GapItem[]> {
  const windows = (await observationWindows(ctx, view)).map((scope) => scope.range);
  return gapItems(view, measureView(view, { startByte: 0, endByte: ctx.limit }, GAP_REPORT_OPTIONS), ctx.limit, windows);
}

export const gapsStage: StageDefinition = {
  stage: "gaps",
  async plan(ctx, view) {
    return (await currentItems(ctx, view)).map((item): ScopePlan => ({
      id: scopeIdFor(ctx.sourceId, item.key), range: item.range,
      items: [item.key, ...(item.segmentId ? [`segment:${item.segmentId}`] : []), ...(item.opening ? ["tools:opening"] : [])], title: `${item.layer}: ${item.describe}` }));
  },
  prompt(ctx, view, scope, previous) {
    const text = new ScopeText(ctx.sourceId, view.bytes, windowUnits(view.structure, view.bytes, scope.range));
    const whole = scope.range.startByte === 0 && scope.range.endByte >= ctx.limit;
    return [
      `Gap repair. Target: ${scope.title}`,
      "You may use any observation, identity, scene or world tool inside this scope. Fix exactly this target from the text, or record a reviewed conclusion where one is legal; then call finish_scope.",
      previous ? `Previous attempt failed: ${previous.checks.filter((check) => !check.passed).map((check) => `${check.id}: ${check.detail}`).join("; ")}` : "",
      "Entities:", ...view.bundle.canonical.entities.map((entity) => `${entity.id} (${entity.kind}) ${entity.canonicalName}`),
      whole ? "Use search_source / read_units to find the text." : `--- scope text ---\n${text.render()}`,
    ].filter(Boolean).join("\n");
  },
  tools(ctx, scope) {
    const segment = scope.items.find((item) => item.startsWith("segment:"))?.slice("segment:".length);
    const names = new Set<string>();
    // One tool per name: later families do not shadow earlier ones.
    return [
      ...observationTools(ctx, scope), ...identityTools(ctx, scope),
      ...(segment ? sceneTools(ctx, { ...scope, items: [segment] }) : []),
      ...(scope.items.includes("tools:opening") ? openingTools(ctx, scope) : []),
      ...artifactTools(ctx, scope, { startByte: 0, endByte: ctx.limit }), ...sourceReadingTools(ctx),
    ].filter((tool) => !names.has(tool.name) && Boolean(names.add(tool.name)));
  },
  async commit(ctx) { return convergeCanonical(ctx); },
  async gate(ctx, view, scope) {
    const key = scope.items[0]!;
    const open = (await currentItems(ctx, view)).some((item) => item.key === key);
    return gateOf([{ id: "gaps.target-closed", passed: !open, detail: open ? `${key} still open` : `${key} closed` }]);
  },
};

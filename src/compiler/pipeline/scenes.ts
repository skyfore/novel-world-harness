import crypto from "node:crypto";
import { Type } from "typebox";
import { z } from "zod";
import { idSchema, knowledgeOperationSchema, participantPresenceModeSchema, predicateSchema, stateOperationSchema, storyTimeSchema, eventParticipationRoleSchema,
  type CanonicalEvent, type EventParticipation, type EvidenceRef } from "../../world/model.js";
import { SCENE_OCCURRENCE_ONTOLOGY_VERSION, type SceneOccurrence } from "../../world/scene-occurrence.js";
import type { EventMention } from "../annotations.js";
import { EVENT_RESOLUTION_ONTOLOGY_VERSION, EventResolutionStore, eventResolutionSchema, type EventResolution } from "../event-resolution.js";
import type { ByteRange } from "../world-completeness.js";
import { artifactTools } from "./artifacts.js";
import { convergeCanonical, submitCanonical } from "./canon.js";
import { identityTools } from "./identity.js";
import { observationTools } from "./observation.js";
import { gateOf, type ScopePlan, type StageContext, type StageDefinition } from "./runner.js";
import { ScopeText, windowUnits } from "./text.js";
import { applyEach, pipelineTool, stageOnce, T } from "./tooling.js";
import { AnnotationWriter } from "./annotate.js";
import { loadPipelineView, measureView, type PipelineView } from "./view.js";

/**
 * Scenes (design 5.5): one scope per discourse segment the observation stage
 * established. Each delivers a scene record (location or a reasoned unknown,
 * who is present) and beats: canonical events with typed participants and
 * effects, or an explicit reviewed "no change". Event evidence is the mention
 * extent, never a whole-segment span.
 */
const overlaps = (left: ByteRange, right: ByteRange) => left.startByte < right.endByte && right.startByte < left.endByte;
const SCENE_KINDS = new Set(["scene", "flashback", "recollection", "dream", "hypothetical", "frame", "flashforward"]);

type Snapshot = PipelineView["bundle"]["compilerSnapshot"];
const eventMentions = (snapshot: Snapshot) => snapshot.annotations.filter((item): item is EventMention => item.annotationType === "event-mention");
const segmentOf = (view: PipelineView, id: string) => view.bundle.compilerSnapshot.annotations.find((item) => item.id === id && item.annotationType === "discourse-segment");

export const sceneIdFor = (segmentId: string) => `scene-${segmentId}`;

function evidenceOf(text: ScopeText, ranges: readonly ByteRange[]): EvidenceRef[] {
  const merged: ByteRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.startByte - b.startByte)) {
    const last = merged.at(-1);
    if (last && range.startByte <= last.endByte) last.endByte = Math.max(last.endByte, range.endByte); else merged.push({ ...range });
  }
  return merged.map((range) => text.evidence(range));
}

async function writeEventResolutions(ctx: StageContext, scopeId: string, items: readonly EventResolution[]): Promise<void> {
  const store = new EventResolutionStore(ctx.root);
  const ids: string[] = [];
  for (const item of items) {
    ids.push(await stageOnce((id) => store.stage(ctx.sourceId, { version: 1, id, payload: item, generatedBy: { worker: item.derivation.worker, compilerBatchId: scopeId }, createdAt: new Date().toISOString() }),
      `per-${crypto.createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 24)}`));
  }
  if (ids.length) await store.commitProposals(ctx.sourceId, ids);
}

function eventResolution(ctx: StageContext, scopeId: string, mentionIds: string[], input: { status: EventResolution["status"]; eventId?: string; relation?: "coreference" | "subevent"; rationale: string }): EventResolution {
  return eventResolutionSchema.parse({
    version: 1, id: `eres-${crypto.createHash("sha256").update(mentionIds.join("|")).digest("hex").slice(0, 16)}`, sourceId: ctx.sourceId, eventMentionIds: mentionIds, status: input.status,
    ...(input.eventId ? { canonicalEventId: input.eventId, relation: input.relation ?? "coreference" } : {}),
    candidates: input.eventId ? [{ canonicalEventId: input.eventId, relation: input.relation ?? "coreference", confidence: 0.85, basisEventMentionIds: mentionIds, evidenceAssertionIds: [], rationale: input.rationale }] : [],
    supersedesResolutionIds: [], rationale: input.rationale,
    derivation: { runId: ctx.runId, worker: "pipeline-scenes", compilerBatchId: scopeId, ...(ctx.generatedBy.provider ? { provider: ctx.generatedBy.provider } : {}), ...(ctx.generatedBy.model ? { model: ctx.generatedBy.model } : {}), ontologyVersion: EVENT_RESOLUTION_ONTOLOGY_VERSION },
  });
}

/**
 * Scene and event links are reciprocal (scene.eventIds ↔ event.sceneOccurrenceIds)
 * and validated together, so both sides are resubmitted before one convergence.
 * `pending` are events proposed in this call and not yet committed.
 */
async function submitLinkedScene(ctx: StageContext, scope: ScopePlan, view: PipelineView, scene: SceneOccurrence, pending: readonly CanonicalEvent[] = []): Promise<void> {
  const committed = view.bundle.canonical.events.filter((event) => eventsInScope(view, scope.range).includes(event.id) && !pending.some((item) => item.id === event.id));
  const all = [...committed, ...pending].map((event) => ({ event, start: Math.min(...event.evidence.map((item) => item.span.startByte ?? Number.MAX_SAFE_INTEGER)) }))
    .sort((a, b) => a.start - b.start).map(({ event }) => event);
  const present = new Set(scene.presentActorIds);
  for (const event of all) for (const presence of event.participantPresence ?? []) if (presence.mode === "physical") present.add(presence.entityId);
  await submitCanonical(ctx, scope.id, "scene-occurrence", { ...scene, eventIds: all.map((event) => event.id), presentActorIds: [...present] } satisfies SceneOccurrence);
  for (const event of committed) {
    if (event.sceneOccurrenceIds?.includes(scene.id)) continue;
    await submitCanonical(ctx, scope.id, "canonical-event", { ...event, sceneOccurrenceIds: [...(event.sceneOccurrenceIds ?? []), scene.id] } satisfies CanonicalEvent);
  }
}

const sceneInput = z.object({
  location: idSchema.optional(), locationUnknown: z.string().trim().min(1).max(500).optional(),
  present: z.array(idSchema).max(64), viewpoint: z.array(idSchema).max(8).default([]),
  storyInterval: z.object({ start: storyTimeSchema, end: storyTimeSchema.optional() }).strict().optional(),
  /** Stated conditions for being in the scene or leaving it (design 5.5: "when the text has them"). */
  entryConditions: z.array(predicateSchema).max(16).default([]),
  exitConditions: z.array(predicateSchema).max(16).default([]),
}).strict().refine((value) => Boolean(value.location) !== Boolean(value.locationUnknown), "Give exactly one of location or locationUnknown (with the reason the text does not say where).");
const beatInput = z.object({
  items: z.array(z.object({
    id: idSchema, title: z.string().trim().min(1).max(200), readerSummary: z.string().trim().min(1).max(1_500).optional(),
    mentions: z.array(z.string().min(1)).min(1).max(32),
    participants: z.array(z.object({ entity: idSchema, role: eventParticipationRoleSchema, presence: participantPresenceModeSchema.optional() }).strict()).min(1).max(32),
    effects: z.array(stateOperationSchema).max(32).default([]),
    knowledge: z.array(knowledgeOperationSchema).max(32).default([]),
    noChange: z.string().trim().min(1).max(500).optional().describe("Reviewed reason this beat changes no state"),
    storyTime: storyTimeSchema,
    preconditions: z.array(predicateSchema).max(16).default([]),
    causalParents: z.array(idSchema).max(16).default([]),
  }).strict()).min(1).max(40),
}).strict();
const eventResolveInput = z.object({
  items: z.array(z.object({ mention: z.string().min(1), status: z.enum(["resolved", "non-referential"]), event: idSchema.optional(), relation: z.enum(["coreference", "subevent"]).optional(), rationale: z.string().trim().min(1).max(1_000) }).strict()).min(1).max(100),
}).strict();

export function sceneTools(ctx: StageContext, scope: ScopePlan) {
  const segmentId = scope.items[0]!;
  const load = async () => {
    const view = await loadPipelineView(ctx.root, ctx.sourceId);
    return { view, text: new ScopeText(ctx.sourceId, view.bytes, windowUnits(view.structure, view.bytes, scope.range)) };
  };
  return [
    pipelineTool({
      name: "propose_scene", label: "Propose scene",
      description: "The scene record for this segment: location (entity id) or locationUnknown with the reason the text does not say; everyone present (bodily) and viewpoint characters; optional story interval; entry and exit conditions (predicates) only when the text states them (who may enter, what ends the scene). The host attaches this segment's events.",
      parameters: Type.Object({ location: Type.Optional(Type.String()), locationUnknown: Type.Optional(T.rationale()), present: Type.Array(Type.String()), viewpoint: Type.Optional(Type.Array(Type.String())), storyInterval: Type.Optional(Type.Unknown()),
        entryConditions: Type.Optional(Type.Array(Type.Unknown())), exitConditions: Type.Optional(Type.Array(Type.Unknown())) }, { additionalProperties: false }),
      input: sceneInput,
      async execute(input) {
        const { view, text } = await load();
        const entities = new Set(view.bundle.canonical.entities.map((entity) => entity.id));
        for (const id of [input.location, ...input.present, ...input.viewpoint]) if (id && !entities.has(id)) throw new Error(`Unknown entity ${id}.`);
        const segment = segmentOf(view, segmentId);
        if (!segment || segment.annotationType !== "discourse-segment") throw new Error(`Discourse segment ${segmentId} is gone; rerun observation.`);
        const scene: SceneOccurrence = { ontologyVersion: SCENE_OCCURRENCE_ONTOLOGY_VERSION, id: sceneIdFor(segmentId), discourseSegmentIds: [segmentId], eventIds: [],
          ...(input.location ? { locationId: input.location } : {}), ...(input.locationUnknown ? { locationUnknown: { reason: input.locationUnknown } } : {}),
          ...(input.storyInterval ? { storyInterval: input.storyInterval } : {}), viewpointActorIds: input.viewpoint, presentActorIds: input.present, entryConditions: input.entryConditions, exitConditions: input.exitConditions,
          evidence: evidenceOf(text, segment.anchors) };
        await submitLinkedScene(ctx, scope, view, scene);
        return { scene: scene.id, convergenceIssues: await convergeCanonical(ctx) };
      },
    }),
    pipelineTool({
      name: "propose_beats", label: "Propose beats",
      description: "Canonical events for this segment, one per beat: its event-mention ids, typed participants (agent first), state effects and knowledge operations, or noChange with the reviewed reason; story time (exact/range/relative to another event/ordinal/unknown); preconditions and causal parents when the text states them. Evidence is the mentions' extents.",
      parameters: Type.Object({ items: Type.Array(Type.Object({ id: Type.String(), title: Type.String(), readerSummary: Type.Optional(Type.String()), mentions: Type.Array(Type.String()),
        participants: Type.Array(Type.Object({ entity: Type.String(), role: Type.String(), presence: Type.Optional(Type.String()) }, { additionalProperties: false })),
        effects: Type.Optional(Type.Array(Type.Unknown())), knowledge: Type.Optional(Type.Array(Type.Unknown())), noChange: Type.Optional(Type.String()), storyTime: Type.Unknown(),
        preconditions: Type.Optional(Type.Array(Type.Unknown())), causalParents: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false })) }, { additionalProperties: false }),
      input: beatInput,
      async execute(input) {
        const { view, text } = await load();
        const mentions = new Map(eventMentions(view.bundle.compilerSnapshot).map((item) => [item.id, item]));
        const entities = new Map(view.bundle.canonical.entities.map((entity) => [entity.id, entity]));
        const scene = view.bundle.canonical.sceneOccurrences.find((item) => item.id === sceneIdFor(segmentId));
        const proposed: CanonicalEvent[] = [];
        const result = await applyEach(input.items, async (item) => {
          const cited = item.mentions.map((id) => { const mention = mentions.get(id); if (!mention) throw new Error(`Unknown event mention ${id}.`); return mention; });
          for (const participant of item.participants) if (!entities.has(participant.entity)) throw new Error(`Unknown entity ${participant.entity}.`);
          if (!item.effects.length && !item.knowledge.length && !item.noChange) throw new Error(`Beat ${item.id} needs effects, knowledge or a reviewed noChange reason.`);
          // The event trace needs a resolved mention of every participant: link resolved mentions inside the extent.
          const resolvedEntity = new Map(view.bundle.compilerSnapshot.entityResolutions.filter((res) => ["resolved", "new-entity"].includes(res.status) && res.entityId).map((res) => [res.mentionId, res.entityId!]));
          const inExtent = (anchor: ByteRange, mention: EventMention) => mention.extentAnchors.some((extent) => anchor.startByte >= extent.startByte && anchor.endByte <= extent.endByte);
          const writer = new AnnotationWriter(ctx, scope.id, text);
          for (const mention of cited) {
            const linked = new Set(mention.participantMentionIds.map((id) => resolvedEntity.get(id)));
            const add: string[] = [];
            for (const participant of item.participants) {
              if (linked.has(participant.entity) || entities.get(participant.entity)?.kind !== "character") continue;
              const found = view.bundle.compilerSnapshot.annotations.find((annotation) => annotation.annotationType === "entity-mention" && resolvedEntity.get(annotation.id) === participant.entity && inExtent(annotation.anchor, mention));
              if (!found) throw new Error(`Participant ${participant.entity} has no resolved mention inside ${mention.id}'s extent; annotate and resolve one, or drop the participant.`);
              add.push(found.id); linked.add(participant.entity);
            }
            if (add.length) await writer.commit({ ...mention, participantMentionIds: [...mention.participantMentionIds, ...add] });
          }
          const evidence = evidenceOf(text, cited.flatMap((mention) => mention.extentAnchors));
          const characters = [...new Set(item.participants.filter((participant) => entities.get(participant.entity)?.kind === "character").map((participant) => participant.entity))];
          const event: CanonicalEvent = {
            id: item.id, title: item.title, ...(item.readerSummary ? { readerSummary: item.readerSummary } : {}),
            participants: [...new Set(item.participants.map((participant) => participant.entity))],
            participantPresence: characters.map((entityId) => ({ entityId, mode: item.participants.find((participant) => participant.entity === entityId)?.presence ?? "physical" })),
            storyTime: item.storyTime, preconditions: item.preconditions, observedOutcome: { version: 1, operations: item.effects },
            ...(item.knowledge.length ? { observedKnowledge: { version: 1, operations: item.knowledge } } : {}),
            ...(scene ? { sceneOccurrenceIds: [scene.id] } : {}), evidence, causalParents: item.causalParents, confidence: 0.85,
          };
          proposed.push(event);
          // The trace (mention → event) is committed first; validation requires it.
          await writeEventResolutions(ctx, scope.id, [eventResolution(ctx, scope.id, item.mentions, { status: "new-event", eventId: item.id, rationale: `Beat ${item.id}: ${item.title}` })]);
          await submitCanonical(ctx, scope.id, "canonical-event", event);
          for (const participant of item.participants) {
            const participation: EventParticipation = { id: `part-${item.id}-${participant.entity}-${participant.role}`, eventId: item.id, entityId: participant.entity, role: participant.role,
              ...(entities.get(participant.entity)?.kind === "character" ? { presence: participant.presence ?? "physical" } : {}), confidence: 0.85, evidence };
            await submitCanonical(ctx, scope.id, "event-participation", participation);
          }
          if (item.noChange) await ctx.store.recordDispositions([{ measureId: "events.effectful", subject: `event:${item.id}`, verdict: "no-change", rationale: item.noChange, scopeId: scope.id }]);
          return item.id;
        });
        if (scene && proposed.length) await submitLinkedScene(ctx, scope, view, scene, proposed);
        const issues = result.applied.length ? await convergeCanonical(ctx) : [];
        return { proposed: result.applied, failed: result.failed, convergenceIssues: issues };
      },
    }),
    pipelineTool({
      name: "resolve_event_mentions", label: "Resolve event mentions",
      description: "Bind event mentions to an existing event (coreference or subevent), or mark them non-referential with a reason (a habitual or hypothetical action that is not an occurrence).",
      parameters: Type.Object({ items: Type.Array(Type.Object({ mention: Type.String(), status: Type.String(), event: Type.Optional(Type.String()), relation: Type.Optional(Type.String()), rationale: T.rationale() }, { additionalProperties: false })) }, { additionalProperties: false }),
      input: eventResolveInput,
      async execute(input) {
        const { view } = await load();
        const mentions = new Set(eventMentions(view.bundle.compilerSnapshot).map((item) => item.id));
        const events = new Set(view.bundle.canonical.events.map((event) => event.id));
        const out: EventResolution[] = [];
        const result = await applyEach(input.items, async (item) => {
          if (!mentions.has(item.mention)) throw new Error(`Unknown event mention ${item.mention}.`);
          if (item.status === "resolved" && (!item.event || !events.has(item.event))) throw new Error(`Unknown event ${item.event ?? "(missing)"}.`);
          out.push(eventResolution(ctx, scope.id, [item.mention], { status: item.status, ...(item.event ? { eventId: item.event } : {}), ...(item.relation ? { relation: item.relation } : {}), rationale: item.rationale }));
          return item.mention;
        });
        await writeEventResolutions(ctx, scope.id, out);
        return { resolved: result.applied, failed: result.failed };
      },
    }),
  ];
}

/** Canonical events whose evidence lies in a range, ordered by position. */
export function eventsInScope(view: PipelineView, range: ByteRange): string[] {
  return view.bundle.canonical.events.map((event) => ({ event, start: Math.min(...event.evidence.map((item) => item.span.startByte ?? Number.MAX_SAFE_INTEGER)) }))
    .filter(({ event }) => event.evidence.some((item) => item.span.startByte !== undefined && item.span.endByte !== undefined && overlaps({ startByte: item.span.startByte, endByte: item.span.endByte }, range)))
    .sort((a, b) => a.start - b.start).map(({ event }) => event.id);
}

export const scenesStage: StageDefinition = {
  stage: "scenes",
  plan(ctx, view) {
    return view.bundle.compilerSnapshot.annotations.filter((item) => item.annotationType === "discourse-segment" && item.anchors[0]!.startByte < ctx.limit)
      .map((item) => {
        const anchors = item.annotationType === "discourse-segment" ? item.anchors : [];
        return { id: `scenes-${ctx.sourceId}-${item.id}`, range: { startByte: Math.min(...anchors.map((anchor) => anchor.startByte)), endByte: Math.max(...anchors.map((anchor) => anchor.endByte)) },
          items: [item.id], title: `${item.annotationType === "discourse-segment" ? item.kind : ""} ${item.id}` };
      }).sort((a, b) => a.range.startByte - b.range.startByte);
  },
  prompt(ctx, view, scope, previous) {
    const text = new ScopeText(ctx.sourceId, view.bytes, windowUnits(view.structure, view.bytes, scope.range));
    const mentions = eventMentions(view.bundle.compilerSnapshot).filter((item) => overlaps(item.triggerAnchor, scope.range));
    const resolved = new Map(view.bundle.compilerSnapshot.eventResolutions.flatMap((item) => item.eventMentionIds.map((id) => [id, item.status] as const)));
    const speakers = view.bundle.compilerSnapshot.annotations.filter((item) => item.annotationType === "quotation" && overlaps(item.anchor, scope.range));
    const times = view.inventory.times.filter((item) => overlaps(item, scope.range));
    const segment = segmentOf(view, scope.items[0]!);
    return [
      `Scene compilation for ${scope.title}${segment?.annotationType === "discourse-segment" ? ` (${segment.kind})` : ""}.`,
      "1. propose_scene: location (or locationUnknown with the reason), everyone bodily present (every speaker of a line here must be present unless the text says otherwise), viewpoint.",
      "2. propose_beats: every major event mention becomes an event or is resolved to one (resolve_event_mentions); give each beat a typed agent, effects (state, knowledge) or noChange with the reason, and story time. Use the explicit time expressions; never invent dates.",
      "3. Every line of direct speech must fall inside some beat's mention extent: if dialogue sits outside every event mention, add an event mention covering the exchange (propose_event_mentions) and a beat for it.",
      "4. Create missing participants with propose_entities / resolve_mentions. Then call finish_scope.",
      previous ? `Previous attempt failed: ${previous.checks.filter((check) => !check.passed).map((check) => `${check.id}: ${check.detail}`).join("; ")}` : "",
      "Entities:", ...view.bundle.canonical.entities.map((entity) => `${entity.id} (${entity.kind}) ${entity.canonicalName}`),
      "Event mentions:", ...mentions.map((item) => `${item.id} [${text.unitAt(item.triggerAnchor.startByte)?.label ?? "?"}] "${item.trigger}" ${item.salience} ${item.eventTypeCandidates.join("/")} ${resolved.get(item.id) ?? "unresolved"}`),
      `Quotations in scope: ${speakers.length}. Time expressions: ${times.map((item) => item.surface).join(", ") || "none"}.`,
      "--- scene text ---", text.render(),
    ].filter(Boolean).join("\n");
  },
  tools(ctx, scope) {
    return [...sceneTools(ctx, scope), ...observationTools(ctx, scope).filter((tool) => ["propose_event_mentions", "propose_entity_mentions", "list_window_annotations"].includes(tool.name)),
      ...identityTools(ctx, scope).filter((tool) => tool.name !== "decide_lexicon_entries"), ...artifactTools(ctx, scope)];
  },
  async commit(ctx, scope) {
    // Keep the scene's event list current and reciprocal.
    const view = await loadPipelineView(ctx.root, ctx.sourceId);
    const scene = view.bundle.canonical.sceneOccurrences.find((item) => item.id === sceneIdFor(scope.items[0]!));
    const events = eventsInScope(view, scope.range);
    const unlinked = view.bundle.canonical.events.filter((event) => events.includes(event.id) && !event.sceneOccurrenceIds?.includes(scene?.id ?? ""));
    if (scene && (JSON.stringify(scene.eventIds) !== JSON.stringify(events) || unlinked.length)) await submitLinkedScene(ctx, scope, view, scene);
    return convergeCanonical(ctx);
  },
  gate(_ctx, view, scope) {
    const segment = segmentOf(view, scope.items[0]!);
    const needsScene = segment?.annotationType === "discourse-segment" && SCENE_KINDS.has(segment.kind);
    const scene = view.bundle.canonical.sceneOccurrences.find((item) => item.id === sceneIdFor(scope.items[0]!));
    const report = measureView(view, scope.range);
    const byId = new Map(report.measures.map((item) => [item.id, item]));
    const full = (id: string) => {
      const item = byId.get(id)!;
      return { id, passed: item.total === 0 || item.numerator === item.total, detail: `${item.numerator}/${item.total}` };
    };
    const resolvedStatus = new Map(view.bundle.compilerSnapshot.eventResolutions.flatMap((item) => item.eventMentionIds.map((id) => [id, item.status] as const)));
    const majors = eventMentions(view.bundle.compilerSnapshot).filter((item) => item.salience === "major" && overlaps(item.triggerAnchor, scope.range));
    const openMajors = majors.filter((item) => !["resolved", "new-event", "non-referential"].includes(resolvedStatus.get(item.id) ?? ""));
    return gateOf([
      { id: "scenes.record", passed: !needsScene || Boolean(scene), detail: scene ? scene.id : needsScene ? "no scene record" : "not a scene segment" },
      { id: "scenes.location-contract", passed: !scene || Boolean(scene.locationId || scene.locationUnknown), detail: scene?.locationId ?? scene?.locationUnknown?.reason ?? "missing" },
      { id: "observation.major-mentions-resolved", passed: openMajors.length === 0, detail: `${majors.length - openMajors.length}/${majors.length}${openMajors.length ? `: ${openMajors.slice(0, 10).map((item) => item.id).join(", ")}` : ""}` },
      full("events.speech-in-beats"),
      full("scenes.speakers-present"),
      full("events.effectful"),
    ]);
  },
};

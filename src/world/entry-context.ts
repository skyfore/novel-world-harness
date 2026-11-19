import { entryKnowledgeSupplement } from "./entry-knowledge.js";
import { remoteEntryOccurrenceIssues } from "./entry-agency.js";
import { assessEntryState, entryContextFields } from "./entry-contract.js";
import { applyProcessDelta, emptyProcessState } from "./process-effects.js";
import { applyStateDelta, emptyWorldState, StateSchemaRegistry, DEFAULT_STATE_FIELDS, evaluatePredicateTruth, advanceTemporalState } from "./state.js";
import { resolveActionInvocation } from "./action-ontology.js";
import { contentHash } from "./canonical.js";
import { capacityUseIssues, incapacityOnsets, incapacityRecoveries, validateIncapacityChanges } from "./process-capacity.js";
import { materializeProcessProposal } from "./process-ontology.js";
import { validateSemanticEffect } from "./semantic-effect.js";
import { deriveEntryCut, type EntryCut } from "./entry-cut.js";
import { canonTimelineProjectionIssues, cutIdFor, openingTimelineIndex, timelineGroupStart, timelineIndex, type CanonTimeline } from "./canon-timeline.js";
import { timeAdvanceInDays } from "./time.js";
import { applyEventExecutions, validateEventExecutions } from "./event-execution.js";
import type { EntryProjectionSeed } from "./model.js";
import type { PreparedNovelBundle } from "../compiler/prepared-cache.js";
import type {
  StateValue,
  CanonicalEvent,
  CharacterEntryCheckpoint,
  ActorEventObservation,
  Entity,
  EvidenceRef,
  KnowledgeDelta,
  ParticipantPresence,
  StateDelta,
  StoryTime,
} from "./model.js";
import type { OpeningReaderContext } from "./initial.js";

export type CharacterEntryPoint = {
  actorId: string;
  kind: "opening" | "canonical-scene";
  title: string;
  discourseOrder: number;
  storyTime?: StoryTime;
  canonicalEventId?: string;
  readerSetup?: string;
  readerOrientation?: OpeningReaderContext;
  evidence: EvidenceRef[];
};

export type CharacterEntryOption = {
  actorId: string;
  canonicalName: string;
  aliases: string[];
  entry: CharacterEntryPoint;
};

export type ReaderContextBeat = {
  eventId: string;
  title: string;
  summary: string;
  participantNames: string[];
  causalParentTitles: string[];
  discourseOrder: number;
  mode: NonNullable<CanonicalEvent["narrativeContext"]>["mode"] | "unspecified";
  storyTime: StoryTime;
};

export type ReaderOrientationContext = {
  facts: Array<{
    kind: OpeningReaderContext["facts"][number]["kind"];
    summary: string;
    temporalClass: OpeningReaderContext["facts"][number]["temporalClass"];
    holderName?: string;
    stance?: NonNullable<OpeningReaderContext["facts"][number]["stance"]>;
  }>;
  entityGlosses: Array<{
    name: string;
    relationshipToFocal: string;
    whyRelevantNow: string;
  }>;
  immediateSituation: { summary: string };
};

/** Reader knowledge is presentation-only and must never enter actor knowledge. */
export type ReaderEntryContext = {
  version: 2;
  actorId: string;
  entryKind: CharacterEntryPoint["kind"];
  entryTitle: string;
  entryCanonicalEventId?: string;
  entryStoryTime?: StoryTime;
  entrySetup?: string;
  orientation?: ReaderOrientationContext;
  storySoFar: ReaderContextBeat[];
};

export type CharacterEntrySeed = {
  cut: EntryCut;
  projectionSeed?: EntryProjectionSeed;
  delta: StateDelta;
  knowledge?: KnowledgeDelta;
  evidence: EvidenceRef[];
  storyTime?: StoryTime;
  realizesCanonicalEventIds: string[];
  participantPresence?: ParticipantPresence[];
  actorObservation?: string;
  actorObservations?: ActorEventObservation[];
  readerContext: ReaderEntryContext;
};

/**
 * List only characters for whom the compiler can identify a grounded lived
 * entry. Merely being named, signing a letter, or existing in the entity catalog
 * is not a playable checkpoint.
 */
export function deriveCharacterEntryOptions(bundle: PreparedNovelBundle): CharacterEntryOption[] {
  bundle = withExecutionEntries(bundle);
  const characters = bundle.canonical.entities.filter((entity) => entity.kind === "character");
  const { ordered: orderedEvents, rank: eventRanks, opening: openingOrder } = entryChronology(bundle);
  const completeReaderContextBefore = new Set<string>();
  let readerContextComplete = true;
  for (const event of orderedEvents) {
    if (readerContextComplete) completeReaderContextBefore.add(event.id);
    if (!event.readerSummary?.trim()) readerContextComplete = false;
  }
  const options: CharacterEntryOption[] = [];

  for (const character of characters) {
    let entry: CharacterEntryPoint | undefined;
    if (initialWorldRepresentsActor(bundle, character.id)) {
      entry = {
        actorId: character.id,
        kind: "opening",
        title: "小说开场",
        discourseOrder: openingOrder,
        ...(bundle.canonical.initialWorld.readerSetup
          ? { readerSetup: bundle.canonical.initialWorld.readerSetup }
          : {}),
        ...(bundle.canonical.initialWorld.readerContext
          ? { readerOrientation: structuredClone(bundle.canonical.initialWorld.readerContext) }
          : {}),
        ...(bundle.canonical.initialWorld.checkpoint?.storyTime
          ? { storyTime: structuredClone(bundle.canonical.initialWorld.checkpoint.storyTime) }
          : {}),
        evidence: structuredClone(bundle.canonical.initialWorld.evidence),
      };
    } else {
      const event = orderedEvents.find((candidate) =>
        eventOffersEntry(candidate, character.id, bundle)
        && completeReaderContextBefore.has(candidate.id));
      if (event) {
        const checkpoint = entryCheckpointFor(event, character.id, bundle)!;
        entry = {
          actorId: character.id,
          kind: "canonical-scene",
          title: `${character.canonicalName} 的首次亲历场景`,
          discourseOrder: eventRanks.get(event.id)!,
          storyTime: structuredClone(event.storyTime),
          canonicalEventId: event.id,
          readerSetup: checkpoint.readerSetup,
          evidence: structuredClone(event.evidence),
        };
      }
    }
    if (entry) options.push(characterEntryOption(character, entry));
  }

  return options.sort((left, right) =>
    left.entry.discourseOrder - right.entry.discourseOrder
    || left.canonicalName.localeCompare(right.canonicalName));
}

export function deriveCharacterEntrySeed(
  bundle: PreparedNovelBundle,
  actorId: string,
): CharacterEntrySeed {
  bundle = withExecutionEntries(bundle);
  const option = deriveCharacterEntryOptions(bundle).find((candidate) => candidate.actorId === actorId);
  if (!option) {
    throw new Error(
      `Character '${actorId}' has no grounded playable entry with complete prior reader context. A name, mention, letter signature, remote reference, or incomplete recap is not enough to establish a lived scene.`,
    );
  }
  const targetEvent = option.entry.canonicalEventId
    ? bundle.canonical.events.find((event) => event.id === option.entry.canonicalEventId)
    : undefined;
  return seedForEntry(bundle, actorId, option, targetEvent ? entryCheckpointFor(targetEvent, actorId, bundle) : undefined);
}

/**
 * The entry seed for one actor at one entry point: an opening, a compiled
 * checkpoint, or a derived checkpoint. Shared by first-entry and scene entry.
 */
function seedForEntry(
  bundle: PreparedNovelBundle,
  actorId: string,
  option: Pick<CharacterEntryOption, "entry">,
  entryCheckpoint: CharacterEntryCheckpoint | undefined,
  derived = false,
): CharacterEntrySeed {
  const { ordered: orderedEvents, opening: baselineIndex, timeline } = entryChronology(bundle);
  const priorEvents = orderedEvents.slice(0, option.entry.discourseOrder);
  const cutChronology = timeline ? { timeline, baselineIndex } : {};
  const targetEvent = option.entry.canonicalEventId
    ? orderedEvents.find((event) => event.id === option.entry.canonicalEventId)
    : undefined;
  let projectionSeed = entryCheckpoint?.projectionSeed ?? (option.entry.kind === "opening" ? bundle.canonical.initialWorld.projectionSeed : undefined);
  const openingSeed = bundle.canonical.initialWorld.projectionSeed;
  if (option.entry.kind !== "opening" && !entryCheckpoint?.projectionSeed && openingSeed
    && [openingSeed.semantics, openingSeed.processes, openingSeed.norms].some((delta) => delta.operations.length)) {
    throw new Error("ENTRY_PROJECTION_SEED_REQUIRED: a later entry must explicitly restore its semantic, process and norm state; opening obligations cannot silently disappear or be assumed unchanged.");
  }
  const cut = deriveEntryCut({
    events: bundle.canonical.events, relations: bundle.canonical.eventRelations ?? [],
    beforeEventId: targetEvent?.id ?? bundle.canonical.initialWorld.checkpoint?.beforeCanonicalEventId,
    storyTime: option.entry.storyTime,
    baselineEventId: bundle.canonical.initialWorld.checkpoint?.beforeCanonicalEventId,
    baselineTime: bundle.canonical.initialWorld.checkpoint?.storyTime,
    completeCheckpoint: Boolean(projectionSeed),
    ...cutChronology,
  });
  if (cut.issues.length) throw new Error(cut.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
  const forwardEvents = cut.replayEventIds.map((id) => bundle.canonical.events.find((event) => event.id === id)!);
  const useOpening = !entryCheckpoint?.projectionSeed;
  const stateOperations = [
    ...(useOpening ? structuredClone(bundle.canonical.initialWorld.delta.operations) : []),
    ...forwardEvents.flatMap((event) => structuredClone(event.observedOutcome.operations)),
    ...structuredClone(entryCheckpoint?.delta.operations ?? []),
  ];
  let knowledgeOperations = [
    ...(useOpening ? structuredClone(bundle.canonical.initialWorld.knowledge?.operations ?? []) : []),
    ...forwardEvents.flatMap((event) => structuredClone(event.observedKnowledge?.operations ?? [])),
    ...structuredClone(entryCheckpoint?.knowledge?.operations ?? []),
  ];
  if (targetEvent && entryCheckpoint?.projectionSeed && entryCheckpoint.participantPresence.some(item => item.entityId === actorId && item.mode === "remote")) {
    // A complete process/state snapshot does not replace the actor's actual learning history.
    const historicalCut = deriveEntryCut({ events: bundle.canonical.events, relations: bundle.canonical.eventRelations ?? [],
      beforeEventId: targetEvent.id, storyTime: targetEvent.storyTime,
      baselineEventId: bundle.canonical.initialWorld.checkpoint?.beforeCanonicalEventId,
      baselineTime: bundle.canonical.initialWorld.checkpoint?.storyTime, ...cutChronology });
    if (historicalCut.issues.length) throw new Error(historicalCut.issues.map(issue => `${issue.code}: ${issue.message}`).join("; "));
    knowledgeOperations = [
      ...structuredClone(bundle.canonical.initialWorld.knowledge?.operations ?? []),
      ...historicalCut.replayEventIds.flatMap(id => structuredClone(bundle.canonical.events.find(event => event.id === id)!.observedKnowledge?.operations ?? [])),
    ];
    knowledgeOperations.push(...structuredClone(entryCheckpoint.projectionSeed.knowledgeHistory ? [] : entryKnowledgeSupplement(knowledgeOperations, entryCheckpoint.knowledge)?.operations ?? []));
    projectionSeed = { ...entryCheckpoint.projectionSeed, knowledgeHistory: { version: 1, actorId, beforeCanonicalEventId: targetEvent.id, cutHash: historicalCut.hash } };
  }
  if (!projectionSeed) {
    const activeRuleIds = new Set(openingSeed?.activeRuleIds ?? []);
    for (const operation of stateOperations) {
      if (operation.op === "activate-rule") activeRuleIds.add(operation.ruleId);
      if (operation.op === "deactivate-rule") activeRuleIds.delete(operation.ruleId);
    }
    const templates = new Map((bundle.canonical.processTemplates ?? []).map(template => [template.id, template]));
    const processes: EntryProjectionSeed["processes"] = { version: 1, operations: [] };
    const entities = new Map(bundle.canonical.entities.map(entity => [entity.id, entity]));
    const rules = new Map(bundle.canonical.rules.map(rule => [rule.id, rule]));
    const actions = new Map((bundle.canonical.actionSchemas ?? []).map(action => [action.id, action]));
    const recoveryBindings = (bundle.canonical.eventExecutions ?? []).filter(binding => binding.processRecoveries?.length);
    const recoveryIssues = validateEventExecutions(recoveryBindings, { entities, events: new Map(bundle.canonical.events.map(event => [event.id, event])), actionSchemas: actions, processTemplates: templates, participations: bundle.canonical.eventParticipations });
    if (recoveryIssues.length) throw new Error(recoveryIssues.map(issue => `${issue.code}: ${issue.message}`).join("; "));
    const registry = new StateSchemaRegistry(DEFAULT_STATE_FIELDS);
    let processState = emptyProcessState(contentHash(cut));
    let world = emptyWorldState(contentHash(cut));
    world.logicalTime.elapsedDays = openingSeed?.elapsedDays ?? 0;
    world.activeRuleIds = [...(openingSeed?.activeRuleIds ?? [])];
    world = applyStateDelta(world, bundle.canonical.initialWorld.delta, registry, entities, rules);
    let elapsedDays = openingSeed?.elapsedDays ?? 0;
    for (const event of forwardEvents) {
      const before = world;
      elapsedDays += timeAdvanceInDays(event.timeAdvance);
      world = advanceTemporalState(world, { step: world.logicalTime.step + 1, elapsedDays, storyTime: event.storyTime }, registry, entities);
      world = applyStateDelta(world, event.observedOutcome, registry, entities, rules);
      const binding = recoveryBindings.find(binding => binding.canonicalEventId === event.id);
      if (binding?.action) {
        const resolved = resolveActionInvocation(binding.action, actions, entities, { actorId: binding.actorId, participants: event.participants, proposedDelta: event.observedOutcome, hasKnowledge: Boolean(event.observedKnowledge?.operations.length), hasTimeAdvance: Boolean(event.timeAdvance), hasSceneTransition: false });
        const capacityIssues = capacityUseIssues({ actorId: binding.actorId }, processState, processState, templates);
        if (resolved.issues.length || capacityIssues.length || [...event.preconditions, ...resolved.preconditions].some(predicate => evaluatePredicateTruth(before, predicate, registry) !== "true")) throw new Error("PROCESS_RECOVERY_PRECONDITION_UNPROVEN: Entry recovery action is not executable at its original cut; stop for source review.");
      }
      const effects = (bundle.canonical.semanticEffects ?? []).filter(effect => effect.canonicalEventId === event.id);
      const issues = effects.flatMap(effect => validateSemanticEffect(effect, {
        entities: new Map(bundle.canonical.entities.map(entity => [entity.id, entity])), events: new Map(bundle.canonical.events.map(item => [item.id, item])),
        processTemplates: templates, eventExecutions: new Map((bundle.canonical.eventExecutions ?? []).map(item => [item.id, item])), actionSchemas: new Map((bundle.canonical.actionSchemas ?? []).map(item => [item.id, item])),
        eventParticipations: new Map((bundle.canonical.eventParticipations ?? []).map(item => [item.id, item])),
      }));
      if (issues.length) throw new Error(issues.map(issue => `${issue.code}: ${issue.message}`).join("; "));
      if (effects.some(effect => effect.lowering.status === "unmapped")) throw new Error("SEMANTIC_EFFECT_UNMAPPED: Entry history contains an unsupported mechanism; preserve source and stop for host compilation.");
      const onsets = incapacityOnsets(effects, new Set([event.id]), templates);
      const operations = [...onsets, ...incapacityRecoveries(recoveryBindings, new Set([event.id]), processState, templates, event.action)];
      if (operations.length) {
        const delta = materializeProcessProposal({ version: 1, operations }, { branchId: `entry-${actorId}`, parentCommitId: contentHash(cut), proposalHash: contentHash(event), templates, elapsedDays }).delta;
        const provenance = { commitId: contentHash(cut), eventId: event.id, eventHash: contentHash(event) };
        validateIncapacityChanges({ actorId: binding?.action ? binding.actorId : undefined, action: event.action }, delta, processState, { entities, templates }, before, world, provenance, onsets);
        processState = applyProcessDelta(processState, delta, { entities, templates }, provenance, elapsedDays);
        processes.operations.push(...delta.operations);
      }
    }
    projectionSeed = { version: 1,
      ...(targetEvent && forwardEvents.some(event => event.observedKnowledge?.operations.length) ? { knowledgeHistory: { version: 1 as const, actorId, beforeCanonicalEventId: targetEvent.id, cutHash: cut.hash, ...(derived ? { basis: "derived-scene" as const } : {}) } } : {}), semantics: { version: 1, operations: [] }, processes, norms: { version: 1, operations: [] },
      activeRuleIds: [...activeRuleIds].sort(), elapsedDays };
  }
  const evidence = uniqueEvidence([
    ...bundle.canonical.initialWorld.evidence,
    ...priorEvents.flatMap((event) => event.evidence),
    ...option.entry.evidence,
  ]);
  const realizesCanonicalEventIds = cut.completedEventIds;

  const initialActorObservation = bundle.canonical.initialWorld.actorObservations
    ?.find((observation) => observation.actorId === actorId)?.summary;
  return {
    cut,
    ...(projectionSeed ? { projectionSeed: structuredClone(projectionSeed) } : {}),
    delta: { version: 1, operations: stateOperations },
    ...(knowledgeOperations.length ? { knowledge: { version: 1, operations: knowledgeOperations } } : {}),
    evidence,
    ...(option.entry.storyTime ? { storyTime: structuredClone(option.entry.storyTime) } : {}),
    realizesCanonicalEventIds: [...new Set(realizesCanonicalEventIds)].sort(),
    ...(entryCheckpoint
      ? {
          participantPresence: structuredClone(entryCheckpoint.participantPresence),
          actorObservation: entryCheckpoint.actorObservation,
          actorObservations: [{ actorId, summary: entryCheckpoint.actorObservation }],
        }
      : {
          ...(bundle.canonical.initialWorld.participantPresence?.length
            ? { participantPresence: structuredClone(bundle.canonical.initialWorld.participantPresence) }
            : {}),
          ...(initialActorObservation
            ? { actorObservation: initialActorObservation }
            : {}),
          ...(bundle.canonical.initialWorld.actorObservations?.length
            ? { actorObservations: structuredClone(bundle.canonical.initialWorld.actorObservations) }
            : {}),
        }),
    readerContext: readerContextForEntry(option.entry, priorEvents, bundle.canonical.entities),
  };
}

export type SceneEntryBasis = "opening" | "checkpoint" | "derived";
export type SceneEntrySeed = CharacterEntrySeed & { cutId: string; entryBasis: SceneEntryBasis; sceneIds: string[] };

/**
 * Entry at any admitted cut x actor, tried in order: the frozen opening, a
 * compiled checkpoint on the cut's event, then a deterministic derivation.
 * A derived entry re-asserts the actor's prefix-folded operational state, adds
 * the scene location when none is known and explicit life for a physically
 * present actor, and is grounded under the same entry contract. It never
 * applies the cut event's own outcome or future knowledge.
 */
export function deriveSceneEntrySeed(input: PreparedNovelBundle, cutId: string, actorId: string): SceneEntrySeed {
  const bundle = withExecutionEntries(input);
  const timeline = bundle.canonical.timeline;
  if (!timeline) throw new Error("ENTRY_TIMELINE_REQUIRED: scene entry needs the revision's frozen canonical timeline");
  const { ordered, opening } = entryChronology(bundle);
  const index = timelineIndex(timeline);
  const entry = timeline.entries.find((candidate) => cutIdFor(candidate.eventId, timeline.hash) === cutId);
  if (!entry) throw new Error(`ENTRY_CUT_UNKNOWN: ${cutId} is not a cut of this revision's timeline`);
  const position = timelineGroupStart(timeline, entry.eventId, index)!;
  const target = ordered[position]!;
  const actor = bundle.canonical.entities.find((entity) => entity.id === actorId);
  if (actor?.kind !== "character") throw new Error(`ENTRY_ACTOR_UNKNOWN: ${actorId} is not a character of this revision`);
  const scenes = bundle.canonical.sceneOccurrences.filter((scene) => {
    const starts = ordered.filter((event) => scene.eventIds.includes(event.id) || event.sceneOccurrenceIds?.includes(scene.id))
      .map((event) => timelineGroupStart(timeline, event.id, index)!);
    return starts.length > 0 && Math.min(...starts) === position;
  });
  const sceneIds = scenes.map((scene) => scene.id).sort();
  const priorComplete = ordered.slice(0, position).every((event) => event.readerSummary?.trim());
  if (!priorComplete) throw new Error("ENTRY_READER_CONTEXT_INCOMPLETE: every event before the cut needs a reader recap");
  const done = (entryBasis: SceneEntryBasis, seed: CharacterEntrySeed): SceneEntrySeed => ({ ...seed, cutId, entryBasis, sceneIds });

  if (position === opening && initialWorldRepresentsActor(bundle, actorId)) {
    const option = deriveCharacterEntryOptions(bundle).find((candidate) => candidate.actorId === actorId && candidate.entry.kind === "opening");
    if (option) return done("opening", seedForEntry(bundle, actorId, option, undefined));
  }
  const entryPoint = (title: string, readerSetup: string, evidence: EvidenceRef[]): Pick<CharacterEntryOption, "entry"> => ({ entry: {
    actorId, kind: "canonical-scene", title, discourseOrder: position, storyTime: structuredClone(target.storyTime),
    canonicalEventId: target.id, readerSetup, evidence,
  } });
  const compiled = eventOffersEntry(target, actorId, bundle) ? entryCheckpointFor(target, actorId, bundle) : undefined;
  if (compiled) {
    const checkpoint = withExplicitLife(compiled, actorId, prefixActorValues(bundle, timeline, opening, target, actorId));
    return done("checkpoint", seedForEntry(bundle, actorId, entryPoint(`${actor.canonicalName} 的亲历场景`, compiled.readerSetup, structuredClone(target.evidence)), checkpoint));
  }

  const scene = scenes.find((candidate) => candidate.presentActorIds.includes(actorId));
  if (!scene) throw new Error(`ENTRY_CONTEXT_MISSING: ${actorId} is not present in a scene that starts at this cut`);
  const checkpoint = derivedSceneCheckpoint(bundle, timeline, opening, target, scene, actor);
  return done("derived", seedForEntry(bundle, actorId, entryPoint(`${actor.canonicalName} 的场景入场`, checkpoint.readerSetup, structuredClone(scene.evidence)), checkpoint, true));
}

/** The actor's own state after the opening and the replayed canonical prefix of a cut. */
function prefixActorValues(bundle: PreparedNovelBundle, timeline: CanonTimeline, opening: number, target: CanonicalEvent, actorId: string): Record<string, StateValue> {
  const cut = deriveEntryCut({ events: bundle.canonical.events, relations: bundle.canonical.eventRelations ?? [], beforeEventId: target.id, timeline, baselineIndex: opening,
    baselineEventId: bundle.canonical.initialWorld.checkpoint?.beforeCanonicalEventId, storyTime: target.storyTime });
  if (cut.issues.length) throw new Error(cut.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
  const events = new Map(bundle.canonical.events.map((event) => [event.id, event]));
  const operations = [
    ...bundle.canonical.initialWorld.delta.operations,
    ...cut.replayEventIds.flatMap((id) => events.get(id)!.observedOutcome.operations),
  ].filter((operation) => "entityId" in operation && operation.entityId === actorId);
  try {
    return applyStateDelta(emptyWorldState("scene-entry"), { version: 1, operations }, new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
      new Map(bundle.canonical.entities.map((entity) => [entity.id, entity])), new Map()).values[actorId] ?? {};
  } catch { return {}; }
}

/** A bodily present actor whose life is never stated is alive at its own lived scene. */
function withExplicitLife(checkpoint: CharacterEntryCheckpoint, actorId: string, prefix: Record<string, StateValue>): CharacterEntryCheckpoint {
  const physical = checkpoint.participantPresence.some((item) => item.entityId === actorId && item.mode === "physical");
  const stated = prefix["character.alive"] !== undefined || checkpoint.delta.operations.some((operation) => "entityId" in operation && operation.entityId === actorId && "field" in operation && operation.field === "character.alive");
  if (!physical || stated) return checkpoint;
  return { ...checkpoint, delta: { ...checkpoint.delta, operations: [...checkpoint.delta.operations, { op: "set", entityId: actorId, field: "character.alive", value: true }] } };
}

function derivedSceneCheckpoint(
  bundle: PreparedNovelBundle,
  timeline: CanonTimeline,
  opening: number,
  target: CanonicalEvent,
  scene: PreparedNovelBundle["canonical"]["sceneOccurrences"][number],
  actor: Entity,
): CharacterEntryCheckpoint {
  const registry = new StateSchemaRegistry(DEFAULT_STATE_FIELDS);
  const entities = new Map(bundle.canonical.entities.map((entity) => [entity.id, entity]));
  const values = prefixActorValues(bundle, timeline, opening, target, actor.id);
  if (values["character.alive"] === false) throw new Error(`ENTRY_ACTOR_DEAD: ${actor.id} is dead before this cut`);
  const operations: StateDelta["operations"] = [];
  for (const field of entryContextFields(values, registry)) operations.push({ op: "set", entityId: actor.id, field, value: structuredClone(values[field]!) });
  const location = typeof values["character.location"] === "string" ? values["character.location"] : scene.locationId;
  if (values["character.location"] === undefined && scene.locationId && entities.get(scene.locationId)) {
    operations.push({ op: "set", entityId: actor.id, field: "character.location", value: scene.locationId });
  }
  if (values["character.alive"] === undefined) operations.push({ op: "set", entityId: actor.id, field: "character.alive", value: true });
  const placeName = typeof location === "string" ? entities.get(location)?.canonicalName ?? location : undefined;
  const checkpoint: CharacterEntryCheckpoint = {
    actorId: actor.id,
    readerSetup: placeName ? `${actor.canonicalName}此刻在${placeName}，下面的场景即将展开。` : `${actor.canonicalName}身处下面即将展开的场景之中。`,
    actorObservation: placeName ? `你此刻在${placeName}。` : "你正身处这一场景之中。",
    participantPresence: scene.presentActorIds.filter((id) => entities.get(id)?.kind === "character").map((id) => ({ entityId: id, mode: "physical" as const })),
    delta: { version: 1, operations },
  };
  const assessed = assessEntryState(actor.id, checkpoint, {
    sourceId: bundle.source.id, entities, processTemplates: new Map((bundle.canonical.processTemplates ?? []).map((item) => [item.id, item])),
    actionSchemas: new Map((bundle.canonical.actionSchemas ?? []).map((item) => [item.id, item])), acquisitions: new Map((bundle.canonical.acquisitions ?? []).map((item) => [item.id, item])),
  });
  if (assessed.state !== "grounded") throw new Error(`ENTRY_CONTEXT_MISSING: ${assessed.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`);
  return checkpoint;
}

function withExecutionEntries(bundle: PreparedNovelBundle): PreparedNovelBundle {
  if (!bundle.canonical.eventExecutions?.length) return bundle;
  return { ...bundle, canonical: { ...bundle.canonical, events: applyEventExecutions(bundle.canonical.events, bundle.canonical.eventExecutions) } };
}

export function readerContextForEntry(
  entry: CharacterEntryPoint,
  priorEvents: readonly CanonicalEvent[],
  entities: readonly Entity[] = [],
): ReaderEntryContext {
  const entityNames = new Map(entities.map((entity) => [entity.id, entity.canonicalName]));
  const eventTitles = new Map(priorEvents.map((event) => [event.id, event.title]));
  return {
    version: 2,
    actorId: entry.actorId,
    entryKind: entry.kind,
    entryTitle: entry.title,
    ...(entry.canonicalEventId ? { entryCanonicalEventId: entry.canonicalEventId } : {}),
    ...(entry.storyTime ? { entryStoryTime: structuredClone(entry.storyTime) } : {}),
    ...(entry.readerSetup ? { entrySetup: entry.readerSetup } : {}),
    ...(entry.readerOrientation
      ? {
          orientation: {
            facts: entry.readerOrientation.facts.map((fact) => ({
              kind: fact.kind,
              summary: fact.summary,
              temporalClass: fact.temporalClass,
              ...(fact.holderEntityId
                ? { holderName: entityNames.get(fact.holderEntityId) ?? fact.holderEntityId }
                : {}),
              ...(fact.stance ? { stance: fact.stance } : {}),
            })),
            entityGlosses: entry.readerOrientation.entityGlosses.map((gloss) => ({
              name: entityNames.get(gloss.entityId) ?? gloss.entityId,
              relationshipToFocal: gloss.relationshipToFocal,
              whyRelevantNow: gloss.whyRelevantNow,
            })),
            immediateSituation: { summary: entry.readerOrientation.immediateSituation.summary },
          },
        }
      : {}),
    storySoFar: priorEvents.map((event, index) => ({
      eventId: event.id,
      title: event.title,
      summary: event.readerSummary ?? event.title,
      participantNames: event.participants.map((participantId) => entityNames.get(participantId) ?? participantId),
      causalParentTitles: event.causalParents.flatMap((parentId) => {
        const title = eventTitles.get(parentId);
        return title ? [title] : [];
      }),
      discourseOrder: index,
      mode: event.narrativeContext?.mode ?? "unspecified",
      storyTime: structuredClone(event.storyTime),
    })),
  };
}

export function formatReaderEntryContext(
  context: ReaderEntryContext,
  actorName: string,
): string {
  const lines: string[] = [];
  if (context.storySoFar.length) {
    lines.push("## 故事前情", "");
    for (let index = 0; index < context.storySoFar.length; index += 1) {
      const beat = context.storySoFar[index]!;
      const details = [
        storyTimeLabel(beat.storyTime),
        beat.participantNames.length ? `涉及：${beat.participantNames.join("、")}` : undefined,
        beat.causalParentTitles.length ? `承接：${beat.causalParentTitles.join("；")}` : undefined,
      ].filter(Boolean).join("；");
      lines.push(
        `${index + 1}. **${beat.title}**${beat.mode === "unspecified" ? "" : `（${narrativeModeLabel(beat.mode)}）`}`,
        ...(beat.summary === beat.title ? [] : [`   ${beat.summary}`]),
        ...(details ? [`   ${details}`] : []),
      );
    }
    lines.push("");
  }
  lines.push(
    `## ${actorName} 的代入起点`,
    "",
    context.entryTitle,
    ...(context.entrySetup ? ["", context.entrySetup] : []),
  );
  if (context.orientation) {
    lines.push("", "### 入场所需上下文", "");
    for (const fact of context.orientation.facts) lines.push(`- ${fact.summary}`);
    for (const gloss of context.orientation.entityGlosses) {
      lines.push(`- ${gloss.name}：${gloss.relationshipToFocal}；${gloss.whyRelevantNow}`);
    }
    lines.push(`- 当前未决局面：${context.orientation.immediateSituation.summary}`);
  }
  return lines.join("\n");
}

function characterEntryOption(entity: Entity, entry: CharacterEntryPoint): CharacterEntryOption {
  return {
    actorId: entity.id,
    canonicalName: entity.canonicalName,
    aliases: [...entity.aliases],
    entry,
  };
}

function initialWorldRepresentsActor(
  bundle: PreparedNovelBundle,
  actorId: string,
): boolean {
  return assessEntryState(actorId, bundle.canonical.initialWorld, {
    sourceId: bundle.source.id, entities: new Map(bundle.canonical.entities.map(entity => [entity.id, entity])),
    acquisitions: new Map((bundle.canonical.acquisitions ?? []).map(item => [item.id, item])),
    processTemplates: new Map((bundle.canonical.processTemplates ?? []).map(template => [template.id, template])),
    actionSchemas: new Map((bundle.canonical.actionSchemas ?? []).map(action => [action.id, action])),
  }).state === "grounded";
}

function eventOffersEntry(event: CanonicalEvent, actorId: string, bundle: PreparedNovelBundle): boolean {
  const mode = event.narrativeContext?.mode;
  if (mode && mode !== "scene") return false;
  return Boolean(entryCheckpointFor(event, actorId, bundle));
}

function entryCheckpointFor(event: CanonicalEvent, actorId: string, bundle: PreparedNovelBundle): CharacterEntryCheckpoint | undefined {
  return event.characterEntryCheckpoints?.find((checkpoint) =>
    checkpoint.actorId === actorId
    && !remoteEntryOccurrenceIssues(actorId, checkpoint, event, bundle.canonical.eventParticipations).length
    && assessEntryState(actorId, checkpoint, {
      sourceId: bundle.source.id, entities: new Map(bundle.canonical.entities.map(item => [item.id, item])),
      processTemplates: new Map((bundle.canonical.processTemplates ?? []).map(item => [item.id, item])),
      actionSchemas: new Map((bundle.canonical.actionSchemas ?? []).map(item => [item.id, item])),
      acquisitions: new Map((bundle.canonical.acquisitions ?? []).map(item => [item.id, item])),
    }).state === "grounded");
}

/**
 * Entry ordering: the frozen canonical timeline when present (hypothetical
 * events never complete), otherwise the legacy evidence-line discourse order.
 * `rank` is the cut position used for an event's entry.
 */
function entryChronology(bundle: PreparedNovelBundle): { ordered: CanonicalEvent[]; rank: Map<string, number>; opening: number; timeline?: CanonTimeline } {
  const timeline = bundle.canonical.timeline;
  if (!timeline) {
    const ordered = eventsInDiscourseOrder(bundle.canonical.events);
    return { ordered, rank: new Map(ordered.map((event, index) => [event.id, index])), opening: openingDiscourseOrder(bundle, ordered) };
  }
  const issues = canonTimelineProjectionIssues(timeline, bundle.canonical.events, bundle.source.id);
  if (issues.length) throw new Error(`TIMELINE_STALE: ${issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`);
  const events = new Map(bundle.canonical.events.map((event) => [event.id, event]));
  const index = timelineIndex(timeline);
  return {
    ordered: timeline.entries.map((entry) => events.get(entry.eventId)!),
    rank: new Map(timeline.entries.map((entry) => [entry.eventId, timelineGroupStart(timeline, entry.eventId, index)!])),
    opening: openingTimelineIndex(timeline, bundle.canonical.initialWorld),
    timeline,
  };
}

function eventsInDiscourseOrder(events: readonly CanonicalEvent[]): CanonicalEvent[] {
  return [...events].sort((left, right) =>
    earliestEvidenceLine(left) - earliestEvidenceLine(right)
    || (left.narrativeContext?.discourseOrder ?? 0) - (right.narrativeContext?.discourseOrder ?? 0)
    || left.id.localeCompare(right.id));
}

function earliestEvidenceLine(event: CanonicalEvent): number {
  return Math.min(...event.evidence.map((reference) => reference.span.startLine), Number.MAX_SAFE_INTEGER);
}

function openingDiscourseOrder(
  bundle: PreparedNovelBundle,
  orderedEvents: readonly CanonicalEvent[],
): number {
  const beforeId = bundle.canonical.initialWorld.checkpoint?.beforeCanonicalEventId;
  const beforeIndex = beforeId ? orderedEvents.findIndex((event) => event.id === beforeId) : -1;
  if (beforeIndex >= 0) return beforeIndex;
  const evidenceLine = Math.min(
    ...bundle.canonical.initialWorld.evidence.map((reference) => reference.span.startLine),
    Number.MAX_SAFE_INTEGER,
  );
  if (!Number.isSafeInteger(evidenceLine)) return 0;
  const firstAtOrAfterOpening = orderedEvents.findIndex((event) => earliestEvidenceLine(event) >= evidenceLine);
  return firstAtOrAfterOpening < 0 ? orderedEvents.length : firstAtOrAfterOpening;
}

function uniqueEvidence(evidence: readonly EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const result: EvidenceRef[] = [];
  for (const reference of evidence) {
    const key = JSON.stringify(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(structuredClone(reference));
  }
  return result;
}

function narrativeModeLabel(mode: ReaderContextBeat["mode"]): string {
  const labels: Record<ReaderContextBeat["mode"], string> = {
    scene: "现场",
    summary: "概述",
    flashback: "闪回",
    flashforward: "预叙",
    frame: "叙事框架",
    recollection: "回忆",
    hypothetical: "假设",
    unspecified: "未标注",
  };
  return labels[mode];
}

function storyTimeLabel(time: StoryTime): string | undefined {
  if (time.kind === "unknown") return undefined;
  if (time.kind === "ordinal") return `故事时点：${time.label}`;
  if (time.kind === "exact") return `故事时间：${time.value}`;
  if (time.kind === "range") return `故事时间：${time.earliest} 至 ${time.latest}`;
  const relation = { before: "之前", after: "之后", during: "期间" }[time.relation];
  return `故事时点：相对前述事件${relation}${time.offset ? `（${time.offset}）` : ""}`;
}

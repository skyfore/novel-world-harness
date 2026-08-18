import { contentHash } from "./canonical.js";
import type { WorldEngine } from "./engine.js";
import type { CommitId, CommittedEvent, Entity, EntityId, NarrativeProgress, StateDelta, StateValue } from "./model.js";
import { observeCommittedEvent, projectActorVisibleState } from "./actor-visible.js";
import { evidenceBelongsExclusivelyToSource, resolveCommitSourceId } from "./source-scope.js";

export type SceneEventProjection = {
  eventId: string;
  eventHash: string;
  title: string;
  actorId?: string;
  participantIds: string[];
  step: number;
  storyTime?: CommittedEvent["logicalTime"]["storyTime"];
  progress?: NarrativeProgress;
};

export type ActorSceneProjection = {
  actorId: EntityId;
  atCommit: CommitId;
  key: string;
  beat: number;
  locationId?: EntityId;
  label?: string;
  /** Actor-observable persistent state of the committed location. */
  locationState: Record<string, StateValue>;
  presentEntityIds: EntityId[];
  recentEvents: SceneEventProjection[];
  recentNoveltyKeys: string[];
  signature: string;
};

export type CommittedHistoryEntry = {
  commitId: CommitId;
  eventHash: string;
  event: CommittedEvent;
  delta: StateDelta;
};

/**
 * Project the persistent scene from committed history.  Presence is not tied
 * to only the newest commit: a solo reflection or metadata-only event cannot
 * make everyone else disappear.  Explicit movement and committed scene
 * transitions are the only boundaries that reset an uncertain scene.
 */
export async function projectActorScene(
  engine: WorldEngine,
  actorId: EntityId,
  commitId: CommitId,
  sourceId?: string,
): Promise<ActorSceneProjection> {
  const [context, state, history] = await Promise.all([
    engine.contextForCommit(commitId),
    engine.projector.project(commitId),
    committedHistory(engine, commitId),
  ]);
  const actor = context.entities.get(actorId);
  if (!actor || actor.kind !== "character") throw new Error(`Scene projection requires a character actor: ${actorId}`);
  const effectiveSourceId = await resolveCommitSourceId(engine, context, commitId, sourceId, "Scene");
  if (!evidenceBelongsExclusivelyToSource(actor.evidence, effectiveSourceId)) {
    throw new Error(`Scene actor ${actorId} is not owned by source ${effectiveSourceId}.`);
  }

  const present = new Set<EntityId>([actorId]);
  let locationId: EntityId | undefined;
  let label: string | undefined;
  let beat = 0;
  let lastBoundaryEventId: string | undefined;
  let openSceneOverridesStableLocation = false;
  const relevantEvents: SceneEventProjection[] = [];

  for (const entry of history) {
    if (entry.event.evidence.length
      && !evidenceBelongsExclusivelyToSource(entry.event.evidence, effectiveSourceId)) continue;
    const actorLocationWrite = finalLocationWrite(entry.delta, actorId);
    const progressScene = entry.event.participants.includes(actorId) ? entry.event.progress?.scene : undefined;
    const boundary = actorLocationWrite !== undefined
      || Boolean(progressScene && progressScene.kind !== "stay");

    if (actorLocationWrite !== undefined) {
      locationId = typeof actorLocationWrite === "string"
        && isSourceOwnedLocation(context.entities, actorLocationWrite, effectiveSourceId)
        ? actorLocationWrite
        : undefined;
      label = locationId ? context.entities.get(locationId)?.canonicalName : progressScene?.label;
      openSceneOverridesStableLocation = false;
    }
    if (progressScene) {
      beat = Math.max(beat + (progressScene.kind === "stay" ? 0 : 1), progressScene.beat);
      if (progressScene.destinationEntityId
        && isSourceOwnedLocation(context.entities, progressScene.destinationEntityId, effectiveSourceId)) {
        locationId = progressScene.destinationEntityId;
        openSceneOverridesStableLocation = false;
      } else if (progressScene.kind === "depart" || progressScene.kind === "explore") {
        // An open-world move may intentionally leave the stable canonical
        // location untouched because its destination is not yet an entity.
        // The committed scene transition still moves the lived scene forward;
        // otherwise the old state value would visually snap the player back.
        locationId = undefined;
        openSceneOverridesStableLocation = true;
      }
      if (progressScene.label) label = progressScene.label;
    } else if (boundary) {
      beat += 1;
    }
    if (boundary) {
      present.clear();
      present.add(actorId);
      lastBoundaryEventId = entry.event.eventId;
    }

    removeCharactersWhoMovedAway(entry.delta, actorId, locationId, present);
    if (!entry.event.participants.includes(actorId) || entry.event.title === "Genesis") continue;

    for (const participantId of entry.event.participants) {
      const entity = context.entities.get(participantId);
      if (!entity || entity.kind !== "character" || !evidenceBelongsExclusivelyToSource(entity.evidence, effectiveSourceId)) continue;
      if (isProvenRemote(state.values, actorId, participantId)) continue;
      present.add(participantId);
    }
    const observation = observeCommittedEvent(entry.event, actorId);
    if (!observation) continue;
    const visibleParticipantIds = entry.event.participants.filter((participantId) => {
      if (participantId === actorId) return true;
      const participant = context.entities.get(participantId);
      return participant?.kind === "character"
        && evidenceBelongsExclusivelyToSource(participant.evidence, effectiveSourceId)
        && !isProvenRemote(state.values, actorId, participantId);
    });
    relevantEvents.push({
      eventId: entry.event.eventId,
      eventHash: entry.eventHash,
      title: observation.summary,
      ...(entry.event.actorId ? { actorId: entry.event.actorId } : {}),
      participantIds: visibleParticipantIds,
      step: observation.step,
      ...(observation.storyTime ? { storyTime: structuredClone(observation.storyTime) } : {}),
      ...(entry.event.progress ? { progress: structuredClone(entry.event.progress) } : {}),
    });
  }

  const projectedLocation = state.values[actorId]?.["character.location"];
  if (
    !openSceneOverridesStableLocation
    && typeof projectedLocation === "string"
    && isSourceOwnedLocation(context.entities, projectedLocation, effectiveSourceId)
  ) {
    locationId = projectedLocation;
    label = context.entities.get(projectedLocation)?.canonicalName;
    for (const entity of context.entities.values()) {
      if (entity.kind !== "character" || !evidenceBelongsExclusivelyToSource(entity.evidence, effectiveSourceId)) continue;
      if (state.values[entity.id]?.["character.location"] === projectedLocation) present.add(entity.id);
    }
  }

  for (const entityId of [...present]) {
    const entity = context.entities.get(entityId);
    if (!entity || !evidenceBelongsExclusivelyToSource(entity.evidence, effectiveSourceId) || isProvenRemote(state.values, actorId, entityId)) present.delete(entityId);
  }
  present.add(actorId);

  const presentEntityIds = [...present].sort();
  const recentEvents = relevantEvents.slice(-8);
  const recentNoveltyKeys = relevantEvents
    .flatMap((event) => event.progress?.noveltyKey ? [event.progress.noveltyKey] : [])
    .slice(-8);
  const key = locationId
    ? `location:${locationId}`
    : label
      ? `scene:${contentHash(label.normalize("NFKC").trim()).slice(0, 16)}`
      : `scene:${lastBoundaryEventId ?? "opening"}`;
  const locationState = locationId
    ? projectActorVisibleState(state.values[locationId] ?? {}, context.stateSchema, "public")
    : {};
  const signature = contentHash({
    key,
    beat,
    presentEntityIds,
    locationState,
    latestMeaningfulEventId: recentEvents.at(-1)?.eventId,
  });
  return {
    actorId,
    atCommit: commitId,
    key,
    beat,
    ...(locationId ? { locationId } : {}),
    ...(label ? { label } : {}),
    locationState,
    presentEntityIds,
    recentEvents,
    recentNoveltyKeys,
    signature,
  };
}

export async function committedHistory(engine: WorldEngine, commitId: CommitId): Promise<CommittedHistoryEntry[]> {
  const commits: Array<{ id: CommitId; eventHashes: string[]; parentCommitId?: CommitId }> = [];
  const seen = new Set<string>();
  let cursor: CommitId | undefined = commitId;
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
    seen.add(cursor);
    const commit = await engine.objects.getCommit(cursor);
    commits.push({ id: cursor, eventHashes: [...commit.eventHashes], ...(commit.parentCommitId ? { parentCommitId: commit.parentCommitId } : {}) });
    cursor = commit.parentCommitId;
    if (commits.length > 100_000) throw new Error("Commit ancestry exceeds safety limit");
  }
  commits.reverse();
  const result: CommittedHistoryEntry[] = [];
  for (const commit of commits) {
    for (const eventHash of commit.eventHashes) {
      const event = await engine.objects.getEvent(eventHash);
      result.push({ commitId: commit.id, eventHash, event, delta: await engine.objects.getDelta(event.deltaHash) });
    }
  }
  return result;
}

export function realizedCanonicalEvents(history: readonly CommittedHistoryEntry[]): ReadonlySet<string> {
  const realized = new Set<string>();
  for (const { event } of history) {
    for (const eventId of event.realizesCanonicalEventIds ?? []) realized.add(eventId);
    if (event.possibilityId?.startsWith("canon-")) realized.add(event.possibilityId.slice("canon-".length));
  }
  return realized;
}

function finalLocationWrite(delta: StateDelta, actorId: string): string | null | undefined {
  let found = false;
  let result: string | null | undefined;
  for (const operation of delta.operations) {
    if (!("entityId" in operation) || operation.entityId !== actorId || operation.field !== "character.location") continue;
    found = true;
    result = operation.op === "set" && typeof operation.value === "string" ? operation.value : null;
  }
  return found ? result : undefined;
}

function isSourceOwnedLocation(
  entities: ReadonlyMap<EntityId, Entity>,
  entityId: EntityId,
  sourceId?: string,
): boolean {
  const entity = entities.get(entityId);
  return Boolean(entity
    && entity.kind === "location"
    && evidenceBelongsExclusivelyToSource(entity.evidence, sourceId));
}

function removeCharactersWhoMovedAway(
  delta: StateDelta,
  actorId: string,
  actorLocationId: string | undefined,
  present: Set<string>,
): void {
  for (const operation of delta.operations) {
    if (!("entityId" in operation) || operation.entityId === actorId || operation.field !== "character.location") continue;
    if (!present.has(operation.entityId)) continue;
    if (operation.op !== "set" || typeof operation.value !== "string" || operation.value !== actorLocationId) {
      present.delete(operation.entityId);
    }
  }
}

function isProvenRemote(
  values: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  actorId: string,
  otherId: string,
): boolean {
  if (actorId === otherId) return false;
  const actorLocation = values[actorId]?.["character.location"];
  const otherLocation = values[otherId]?.["character.location"];
  return typeof actorLocation === "string" && typeof otherLocation === "string" && actorLocation !== otherLocation;
}

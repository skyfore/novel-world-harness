import type { PreparedNovelBundle } from "../compiler/prepared-cache.js";
import type {
  CanonicalEvent,
  CharacterEntryCheckpoint,
  Entity,
  EvidenceRef,
  KnowledgeDelta,
  ParticipantPresence,
  StateDelta,
  StoryTime,
} from "./model.js";

export type CharacterEntryPoint = {
  actorId: string;
  kind: "opening" | "canonical-scene";
  title: string;
  discourseOrder: number;
  storyTime?: StoryTime;
  canonicalEventId?: string;
  readerSetup?: string;
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

/** Reader knowledge is presentation-only and must never enter actor knowledge. */
export type ReaderEntryContext = {
  version: 2;
  actorId: string;
  entryKind: CharacterEntryPoint["kind"];
  entryTitle: string;
  entryCanonicalEventId?: string;
  entryStoryTime?: StoryTime;
  entrySetup?: string;
  storySoFar: ReaderContextBeat[];
};

export type CharacterEntrySeed = {
  delta: StateDelta;
  knowledge?: KnowledgeDelta;
  evidence: EvidenceRef[];
  storyTime?: StoryTime;
  realizesCanonicalEventIds: string[];
  participantPresence?: ParticipantPresence[];
  actorObservation?: string;
  readerContext: ReaderEntryContext;
};

/**
 * List only characters for whom the compiler can identify a grounded lived
 * entry. Merely being named, signing a letter, or existing in the entity catalog
 * is not a playable checkpoint.
 */
export function deriveCharacterEntryOptions(bundle: PreparedNovelBundle): CharacterEntryOption[] {
  const characters = bundle.canonical.entities.filter((entity) => entity.kind === "character");
  const orderedEvents = eventsInDiscourseOrder(bundle.canonical.events);
  const eventRanks = new Map(orderedEvents.map((event, index) => [event.id, index]));
  const soleCharacterId = characters.length === 1 ? characters[0]!.id : undefined;
  const openingOrder = openingDiscourseOrder(bundle, orderedEvents);
  const completeReaderContextBefore = new Set<string>();
  let readerContextComplete = true;
  for (const event of orderedEvents) {
    if (readerContextComplete) completeReaderContextBefore.add(event.id);
    if (!event.readerSummary?.trim()) readerContextComplete = false;
  }
  const options: CharacterEntryOption[] = [];

  for (const character of characters) {
    let entry: CharacterEntryPoint | undefined;
    if (initialWorldRepresentsActor(bundle, character.id, soleCharacterId === character.id)) {
      entry = {
        actorId: character.id,
        kind: "opening",
        title: "小说开场",
        discourseOrder: openingOrder,
        ...(bundle.canonical.initialWorld.readerSetup
          ? { readerSetup: bundle.canonical.initialWorld.readerSetup }
          : {}),
        ...(bundle.canonical.initialWorld.checkpoint?.storyTime
          ? { storyTime: structuredClone(bundle.canonical.initialWorld.checkpoint.storyTime) }
          : {}),
        evidence: structuredClone(bundle.canonical.initialWorld.evidence),
      };
    } else {
      const event = orderedEvents.find((candidate) =>
        eventEmbodiesActor(candidate, character.id)
        && completeReaderContextBefore.has(candidate.id));
      if (event) {
        const checkpoint = entryCheckpointFor(event, character.id)!;
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
  const option = deriveCharacterEntryOptions(bundle).find((candidate) => candidate.actorId === actorId);
  if (!option) {
    throw new Error(
      `Character '${actorId}' has no grounded playable entry with complete prior reader context. A name, mention, letter signature, remote reference, or incomplete recap is not enough to establish a lived scene.`,
    );
  }
  const orderedEvents = eventsInDiscourseOrder(bundle.canonical.events);
  const baselineOrder = openingDiscourseOrder(bundle, orderedEvents);
  const priorEvents = orderedEvents.slice(0, option.entry.discourseOrder);
  const forwardEvents = priorEvents.filter((event, index) =>
    index >= baselineOrder && eventAdvancesMainTimeline(event));
  const targetEvent = option.entry.canonicalEventId
    ? orderedEvents.find((event) => event.id === option.entry.canonicalEventId)
    : undefined;
  const entryCheckpoint = targetEvent ? entryCheckpointFor(targetEvent, actorId) : undefined;
  const stateOperations = [
    ...structuredClone(bundle.canonical.initialWorld.delta.operations),
    ...forwardEvents.flatMap((event) => structuredClone(event.observedOutcome.operations)),
    ...structuredClone(entryCheckpoint?.delta.operations ?? []),
  ];
  const knowledgeOperations = [
    ...structuredClone(bundle.canonical.initialWorld.knowledge?.operations ?? []),
    ...forwardEvents.flatMap((event) => structuredClone(event.observedKnowledge?.operations ?? [])),
    ...structuredClone(entryCheckpoint?.knowledge?.operations ?? []),
  ];
  const evidence = uniqueEvidence([
    ...bundle.canonical.initialWorld.evidence,
    ...priorEvents.flatMap((event) => event.evidence),
    ...option.entry.evidence,
  ]);
  const realizesCanonicalEventIds = priorEvents
    .filter((event) => event.narrativeContext?.mode !== "hypothetical"
      && event.narrativeContext?.mode !== "flashforward")
    .map((event) => event.id);

  return {
    delta: { version: 1, operations: stateOperations },
    ...(knowledgeOperations.length ? { knowledge: { version: 1, operations: knowledgeOperations } } : {}),
    evidence,
    ...(option.entry.storyTime ? { storyTime: structuredClone(option.entry.storyTime) } : {}),
    realizesCanonicalEventIds: [...new Set(realizesCanonicalEventIds)].sort(),
    ...(entryCheckpoint
      ? {
          participantPresence: structuredClone(entryCheckpoint.participantPresence),
          actorObservation: entryCheckpoint.actorObservation,
        }
      : bundle.canonical.initialWorld.participantPresence?.length
        ? { participantPresence: structuredClone(bundle.canonical.initialWorld.participantPresence) }
        : {}),
    readerContext: readerContextForEntry(option.entry, priorEvents, bundle.canonical.entities),
  };
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
  allowSoleAliveFallback: boolean,
): boolean {
  const actorOperations = bundle.canonical.initialWorld.delta.operations.filter((operation) =>
    "entityId" in operation && operation.entityId === actorId);
  const physicallyPresent = bundle.canonical.initialWorld.participantPresence?.some((presence) =>
    presence.entityId === actorId && presence.mode === "physical") ?? false;
  if (physicallyPresent && actorOperations.some((operation) =>
    "entityId" in operation
    && ["character.location", "character.plan", "character.momentum"].includes(operation.field))) return true;
  return allowSoleAliveFallback && actorOperations.some((operation) =>
    operation.op === "set" && operation.field === "character.alive" && operation.value === true);
}

function eventEmbodiesActor(event: CanonicalEvent, actorId: string): boolean {
  const mode = event.narrativeContext?.mode;
  if (mode && mode !== "scene") return false;
  return Boolean(entryCheckpointFor(event, actorId));
}

function entryCheckpointFor(event: CanonicalEvent, actorId: string): CharacterEntryCheckpoint | undefined {
  return event.characterEntryCheckpoints?.find((checkpoint) =>
    checkpoint.actorId === actorId
    && checkpoint.participantPresence.some((presence) =>
      presence.entityId === actorId && presence.mode === "physical")
    && checkpoint.delta.operations.some((operation) =>
      "entityId" in operation
      && operation.entityId === actorId
      && ["character.location", "character.plan", "character.momentum"].includes(operation.field)));
}

function eventAdvancesMainTimeline(event: CanonicalEvent): boolean {
  return !["flashback", "flashforward", "recollection", "hypothetical"].includes(
    event.narrativeContext?.mode ?? "scene",
  );
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

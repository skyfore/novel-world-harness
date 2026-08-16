import type { PlayerActionTranslator, PlayerTurnResult } from "./player-action.js";
import { PlayerTurnService } from "./player-action.js";
import type { Entity } from "./model.js";
import { PlaySessionStore, type ActivePlaySession } from "./play-session.js";
import { openWorkspaceWorld } from "./workspace-runtime.js";
import { BranchStore } from "./store.js";
import { WorkspaceStore, type SourceDocument, type StoredProject } from "../storage/workspace-store.js";

export type PlayableCharacter = {
  id: string;
  canonicalName: string;
  aliases: string[];
  alive?: boolean;
  locationId?: string;
  locationName?: string;
  sourceIds: string[];
};

export type PlayInstanceSummary = {
  branchId: string;
  name: string;
  headCommitId: string;
  logicalStep: number;
  commitCount: number;
  eventCount: number;
  lastEventTitle?: string;
  parentBranchId?: string;
  active: boolean;
  sourceId?: string;
  sourceTitle?: string;
  actorId?: string;
  actorName?: string;
  sessionAtHead?: boolean;
  preparedRevisionHash?: string;
  createdAt?: string;
  updatedAt: string;
  lastPlayedAt?: string;
};

export type PlayExperienceCatalog = {
  project: StoredProject | null;
  novels: SourceDocument[];
  instances: PlayInstanceSummary[];
  activeSession: ActivePlaySession | null;
  savedSessions: ActivePlaySession[];
};

export type SelectedPlayExperience = {
  session: ActivePlaySession;
  branchName: string;
  source?: SourceDocument;
  actor: PlayableCharacter;
  logicalStep: number;
};

export type PlayTurnOutcome = {
  result: PlayerTurnResult;
  finalHead: string;
  logicalStep: number;
  backgroundEvents: Array<{ eventHash: string; title: string }>;
  backgroundError?: string;
};

export async function inspectPlayExperience(root: string): Promise<PlayExperienceCatalog> {
  const store = await WorkspaceStore.create(root);
  const sessions = new PlaySessionStore(root);
  const [project, novels, activeSession, savedSessions] = await Promise.all([
    store.readProject(),
    store.listSources(),
    sessions.read(),
    sessions.listInstances(),
  ]);
  const branchIds = await new BranchStore(root).listIds();
  if (!branchIds.length) return { project, novels, instances: [], activeSession, savedSessions };
  const { engine } = await openWorkspaceWorld(root);
  const instances = await Promise.all(branchIds.map(async (branchId): Promise<PlayInstanceSummary> => {
    const [branch, headInfo] = await Promise.all([
      engine.branches.read(branchId),
      engine.branches.readHeadInfo(branchId),
    ]);
    const history = await inspectHistory(engine, branch.headCommitId);
    const context = await engine.contextForCommit(branch.headCommitId);
    const saved = savedSessions.find((session) => session.branchId === branchId);
    const sourceId = branch.sourceId ?? saved?.sourceId ?? await inferLegacyBranchSourceId(engine, branch.headCommitId);
    const source = sourceId ? novels.find((novel) => novel.id === sourceId) : undefined;
    const actor = saved ? context.entities.get(saved.actorId) : undefined;
    return {
      branchId,
      name: branch.name,
      headCommitId: branch.headCommitId,
      logicalStep: history.logicalStep,
      commitCount: history.commitCount,
      eventCount: history.eventCount,
      ...(history.lastEventTitle ? { lastEventTitle: history.lastEventTitle } : {}),
      ...(branch.parentBranchId ? { parentBranchId: branch.parentBranchId } : {}),
      active: activeSession?.branchId === branchId,
      ...(sourceId ? { sourceId } : {}),
      ...(source ? { sourceTitle: source.title } : {}),
      ...(actor ? { actorId: actor.id, actorName: actor.canonicalName } : {}),
      ...(saved
        ? { sessionAtHead: saved.lastCommitId === branch.headCommitId }
        : {}),
      ...(branch.preparedRevisionHash ? { preparedRevisionHash: branch.preparedRevisionHash } : {}),
      ...(branch.createdAt ? { createdAt: branch.createdAt } : {}),
      updatedAt: headInfo.updatedAt,
      ...(saved ? { lastPlayedAt: saved.updatedAt } : {}),
    };
  }));
  instances.sort(comparePlayInstancesNewestFirst);
  return { project, novels, instances, activeSession, savedSessions };
}

export function comparePlayInstancesNewestFirst(left: PlayInstanceSummary, right: PlayInstanceSummary): number {
  const leftTime = Date.parse(left.lastPlayedAt ?? left.updatedAt ?? left.createdAt ?? "1970-01-01T00:00:00.000Z");
  const rightTime = Date.parse(right.lastPlayedAt ?? right.updatedAt ?? right.createdAt ?? "1970-01-01T00:00:00.000Z");
  return rightTime - leftTime
    || Number(right.active) - Number(left.active)
    || left.branchId.localeCompare(right.branchId);
}

async function inferLegacyBranchSourceId(
  engine: Awaited<ReturnType<typeof openWorkspaceWorld>>["engine"],
  headCommitId: string,
): Promise<string | undefined> {
  let genesisId = headCommitId;
  for (;;) {
    const commit = await engine.objects.getCommit(genesisId);
    if (!commit.parentCommitId) break;
    genesisId = commit.parentCommitId;
  }
  const [genesis, context] = await Promise.all([
    engine.objects.getCommit(genesisId),
    engine.contextForCommit(genesisId),
  ]);
  const participantSourceIds = new Set<string>();
  for (const eventHash of genesis.eventHashes) {
    const event = await engine.objects.getEvent(eventHash);
    for (const participant of event.participants) {
      for (const evidence of context.entities.get(participant)?.evidence ?? []) {
        participantSourceIds.add(evidence.span.sourceId);
      }
    }
  }
  if (participantSourceIds.size === 1) return [...participantSourceIds][0];
  if (participantSourceIds.size > 1) return undefined;

  const contextSourceIds = new Set(
    [...context.entities.values()]
      .filter((entity) => entity.kind === "character")
      .flatMap((entity) => entity.evidence.map((evidence) => evidence.span.sourceId)),
  );
  return contextSourceIds.size === 1 ? [...contextSourceIds][0] : undefined;
}

export async function listPlayableCharacters(
  root: string,
  options: { branchId?: string; source?: string } = {},
): Promise<{ branchId: string; source?: SourceDocument; characters: PlayableCharacter[] }> {
  const store = await WorkspaceStore.create(root);
  const source = options.source ? await resolveNovelSource(store, options.source) : undefined;
  const active = await new PlaySessionStore(root).read();
  const branchId = await resolveBranchId(new BranchStore(root), options.branchId, active?.branchId);
  const { engine } = await openWorkspaceWorld(root);
  const head = await engine.branches.readHead(branchId);
  const [context, state] = await Promise.all([
    engine.contextForCommit(head),
    engine.projector.project(head),
  ]);
  const characters = [...context.entities.values()]
    .filter((entity) => entity.kind === "character")
    .filter((entity) => !source || entity.evidence.some((reference) => reference.span.sourceId === source.id))
    .map((entity) => characterSummary(entity, state.values[entity.id] ?? {}, context.entities))
    .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName));
  return { branchId, ...(source ? { source } : {}), characters };
}

export async function selectPlayExperience(
  root: string,
  options: { branchId?: string; character?: string; source?: string } = {},
): Promise<SelectedPlayExperience> {
  const sessionStore = new PlaySessionStore(root);
  const active = await sessionStore.read();
  const branchId = await resolveBranchId(new BranchStore(root), options.branchId, active?.branchId);
  const saved = await sessionStore.readInstance(branchId);
  const { engine } = await openWorkspaceWorld(root);
  const branch = await engine.branches.read(branchId);
  const [context, state] = await Promise.all([
    engine.contextForCommit(branch.headCommitId),
    engine.projector.project(branch.headCommitId),
  ]);
  const requestedSource = options.source ?? saved?.sourceId ?? branch.sourceId ?? context.sourceId;
  const source = requestedSource
    ? await resolveNovelSource(await WorkspaceStore.create(root), requestedSource)
    : undefined;
  const ownedSourceId = branch.sourceId ?? context.sourceId;
  if (source && ownedSourceId && source.id !== ownedSourceId) {
    throw new Error(`Instance '${branchId}' belongs to source '${ownedSourceId}', not '${source.title}'.`);
  }
  const characters = [...context.entities.values()]
    .filter((entity) => entity.kind === "character")
    .filter((entity) => !source || entity.evidence.some((reference) => reference.span.sourceId === source.id))
    .map((entity) => characterSummary(entity, state.values[entity.id] ?? {}, context.entities))
    .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName));
  const requestedActor = options.character
    ?? saved?.actorId
    ?? (characters.length === 1 ? characters[0]!.id : undefined);
  if (!requestedActor) {
    throw new Error(`Choose a character for '${branchId}'. Available: ${characterChoices(characters)}`);
  }
  const actor = resolveCharacter(characters, requestedActor);
  if (!actor) {
    throw new Error(`Unknown or ambiguous character '${requestedActor}' on '${branchId}'. Available: ${characterChoices(characters)}`);
  }
  if (actor.alive === false) throw new Error(`${actor.canonicalName} (${actor.id}) is not alive at branch '${branchId}' head.`);
  const session = await sessionStore.write({
    branchId,
    ...(source ? { sourceId: source.id } : {}),
    actorId: actor.id,
    lastCommitId: branch.headCommitId,
  });
  return { session, branchName: branch.name, ...(source ? { source } : {}), actor, logicalStep: state.logicalTime.step };
}

export async function performPlayTurn(options: {
  root: string;
  branchId: string;
  actorId: string;
  utterance: string;
  translator: PlayerActionTranslator;
  advanceBackground?: number;
}): Promise<PlayTurnOutcome> {
  const advanceBackground = options.advanceBackground ?? 1;
  if (!Number.isInteger(advanceBackground) || advanceBackground < 0 || advanceBackground > 100) {
    throw new Error("advanceBackground must be an integer between 0 and 100");
  }
  const { engine, runtime } = await openWorkspaceWorld(options.root);
  const previousHead = await engine.branches.readHead(options.branchId);
  const context = await engine.contextForCommit(previousHead);
  const actor = context.entities.get(options.actorId);
  if (!actor || actor.kind !== "character") {
    throw new Error(`Character '${options.actorId}' is not available on branch '${options.branchId}'.`);
  }
  const stateBefore = await engine.projector.project(previousHead);
  if (stateBefore.values[options.actorId]?.["character.alive"] === false) {
    throw new Error(`${actor.canonicalName} (${actor.id}) is not alive at branch '${options.branchId}' head.`);
  }
  const sessionStore = new PlaySessionStore(options.root);
  const previousSession = await sessionStore.readInstance(options.branchId);
  const turns = new PlayerTurnService(
    engine,
    options.translator,
    undefined,
    (proposal) => runtime.resolveEligibleCanonicalEvents(proposal),
  );
  const result = await turns.turn({
    branchId: options.branchId,
    ...(previousSession?.sourceId ? { sourceId: previousSession.sourceId } : {}),
    actorId: options.actorId,
    utterance: options.utterance,
  });
  let finalHead = result.newHead;
  const backgroundEvents: PlayTurnOutcome["backgroundEvents"] = [];
  let backgroundError: string | undefined;
  if (result.accepted && advanceBackground > 0) {
    try {
      const advanced = await runtime.move({
        branchId: options.branchId,
        maxActorCandidates: 0,
        maxBackgroundCandidates: advanceBackground,
      });
      finalHead = advanced.newHead;
      for (const eventHash of advanced.committedEvents) {
        const event = await engine.objects.getEvent(eventHash);
        backgroundEvents.push({ eventHash, title: event.title });
      }
    } catch (error) {
      finalHead = await engine.branches.readHead(options.branchId);
      backgroundError = error instanceof Error ? error.message : String(error);
    }
  }
  const finalState = await engine.projector.project(finalHead);
  await sessionStore.write({
    branchId: options.branchId,
    ...(previousSession?.sourceId ? { sourceId: previousSession.sourceId } : {}),
    actorId: options.actorId,
    lastCommitId: finalHead,
  });
  return { result, finalHead, logicalStep: finalState.logicalTime.step, backgroundEvents, ...(backgroundError ? { backgroundError } : {}) };
}

export function resolveCharacter(
  characters: readonly PlayableCharacter[],
  value: string,
): PlayableCharacter | undefined {
  const exactId = characters.find((character) => character.id === value);
  if (exactId) return exactId;
  const normalized = normalize(value);
  const matches = characters.filter((character) =>
    [character.canonicalName, ...character.aliases].some((name) => normalize(name) === normalized));
  return matches.length === 1 ? matches[0] : undefined;
}

export async function resolveNovelSource(store: WorkspaceStore, value: string): Promise<SourceDocument> {
  const sources = await store.listSources();
  const exactId = sources.find((source) => source.id === value);
  if (exactId) return exactId;
  const normalized = normalize(value);
  const matches = sources.filter((source) =>
    normalize(source.title) === normalized || normalize(source.sourcePath) === normalized);
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) throw new Error(`Unknown novel '${value}'. Use nwh novels to list registered sources.`);
  throw new Error(`Ambiguous novel '${value}'. Use its source id from nwh novels.`);
}

async function resolveBranchId(
  branches: { listIds(): Promise<string[]> },
  requested?: string,
  active?: string,
): Promise<string> {
  const ids = await branches.listIds();
  const candidates = [requested, active, ids.includes("main") ? "main" : undefined, ids.length === 1 ? ids[0] : undefined];
  const selected = candidates.find((candidate): candidate is string => Boolean(candidate));
  if (!selected) {
    if (!ids.length) throw new Error("No playable instances exist. Run nwh prepare-all first.");
    throw new Error(`Choose an instance. Available: ${ids.join(", ")}`);
  }
  if (!ids.includes(selected)) throw new Error(`Unknown instance '${selected}'. Available: ${ids.join(", ") || "none"}`);
  return selected;
}

async function inspectHistory(
  engine: Awaited<ReturnType<typeof openWorkspaceWorld>>["engine"],
  headCommitId: string,
): Promise<{ logicalStep: number; commitCount: number; eventCount: number; lastEventTitle?: string }> {
  let cursor: string | undefined = headCommitId;
  let commitCount = 0;
  let eventCount = 0;
  let logicalStep = 0;
  let lastEventTitle: string | undefined;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
    seen.add(cursor);
    const commit = await engine.objects.getCommit(cursor);
    if (commitCount === 0) {
      logicalStep = commit.logicalTime.step;
      const lastHash = commit.eventHashes.at(-1);
      if (lastHash) lastEventTitle = (await engine.objects.getEvent(lastHash)).title;
    }
    commitCount += 1;
    if (commitCount > 100_000) throw new Error("Commit ancestry exceeds safety limit");
    eventCount += commit.eventHashes.length;
    cursor = commit.parentCommitId;
  }
  return { logicalStep, commitCount, eventCount, ...(lastEventTitle ? { lastEventTitle } : {}) };
}

function characterSummary(
  entity: Entity,
  state: Record<string, unknown>,
  entities: ReadonlyMap<string, Entity>,
): PlayableCharacter {
  const alive = typeof state["character.alive"] === "boolean" ? state["character.alive"] : undefined;
  const locationId = typeof state["character.location"] === "string" ? state["character.location"] : undefined;
  const sourceIds = [...new Set(entity.evidence.map((reference) => reference.span.sourceId))].sort();
  return {
    id: entity.id,
    canonicalName: entity.canonicalName,
    aliases: [...entity.aliases],
    ...(alive !== undefined ? { alive } : {}),
    ...(locationId ? { locationId, locationName: entities.get(locationId)?.canonicalName ?? locationId } : {}),
    sourceIds,
  };
}

function characterChoices(characters: readonly PlayableCharacter[]): string {
  return characters.length
    ? characters.map((character) => `${character.canonicalName} (${character.id})`).join(", ")
    : "none";
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

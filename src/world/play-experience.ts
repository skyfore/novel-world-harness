import type { PlayerActionTranslator, PlayerTurnResult, PlayerWorldAdjudicator } from "./player-action.js";
import { buildActorScopedActionContext, PlayerTurnService } from "./player-action.js";
import { AUTONOMOUS_BACKGROUND_KINDS, type Entity } from "./model.js";
import { PlaySessionStore, type ActivePlaySession } from "./play-session.js";
import { openWorkspaceWorld } from "./workspace-runtime.js";
import { BranchStore } from "./store.js";
import { WorkspaceStore, type SourceDocument, type StoredProject } from "../storage/workspace-store.js";
import { PlayerTurnAuditStore, type PlayerTurnOrigin } from "./player-turn-audit.js";
import { resolvePlayerAffordance } from "./narrative-director.js";
import { evidenceBelongsExclusivelyToSource, inferLegacyBranchSourceId, resolveCommitSourceId } from "./source-scope.js";
import type { PlayerWorldResponseOption, PlayerWorldResponseResolver, PlayerWorldResponseResolution } from "./runtime.js";
import {
  modelPlayConversation,
  playConversationAtCommit,
  PlayConversationStore,
  recentPlayConversation,
} from "./play-conversation.js";
import {
  respondToNpcInteractions,
  type NpcReactionEmotion,
  type NpcReactionEvent,
  type NpcReactionReasoner,
  type NpcResponseKind,
} from "./npc-reaction.js";
import type { ReaderEntryContext } from "./entry-context.js";
import { committedHistory } from "./scene.js";
import type {
  CanonicalAttachmentResolution,
  CanonicalAttachmentResolver,
} from "./canonical-adaptation.js";
import type { CanonicalRecoveryTrace } from "./runtime.js";

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
  /** Player-facing warnings must describe a condition the player can act on. */
  readinessWarnings: string[];
  /** Engine/readiness details retained for inspection, never shown in the story UI. */
  readinessDiagnostics: string[];
  /** Reader-only recap for a newly created character checkpoint. Never model/actor knowledge. */
  readerContext?: ReaderEntryContext;
};

export type PlayTurnOutcome = {
  result: PlayerTurnResult;
  finalHead: string;
  logicalStep: number;
  worldResponseEvents: Array<{ eventHash: string; title: string; possibilityId: string }>;
  worldResponseCandidates: PlayerWorldResponseOption[];
  worldResponseResolution?: PlayerWorldResponseResolution;
  worldResponseError?: string;
  canonicalRecoveryEvents: Array<{
    eventHash: string;
    title: string;
    scaffoldPossibilityId: string;
    canonicalEventId: string;
  }>;
  canonicalRecoveryTraces: CanonicalRecoveryTrace[];
  excludedCanonicalPossibilityIds: string[];
  canonicalRecoveryResolution?: CanonicalAttachmentResolution;
  canonicalRecoveryError?: string;
  backgroundEvents: Array<{ eventHash: string; title: string }>;
  reactionEvents: Array<{
    eventHash: string;
    title: string;
    actorId: string;
    responseKind?: NpcResponseKind;
    emotion?: NpcReactionEmotion;
    trace?: NpcReactionEvent["trace"];
  }>;
  npcResponseError?: string;
  backgroundError?: string;
  conversationError?: string;
  auditId?: string;
  auditError?: string;
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
  const [branch, context, state, history] = await Promise.all([
    engine.branches.read(branchId),
    engine.contextForCommit(head),
    engine.projector.project(head),
    committedHistory(engine, head),
  ]);
  const activeSourceId = await resolveCommitSourceId(
    engine,
    context,
    head,
    source?.id ?? branch.sourceId,
    "Playable character listing",
  );
  const characters = playableCharactersForContext(
    context.entities,
    state.values,
    activeSourceId,
    embodiedCharacterIds(history),
    !branch.preparedRevisionHash,
  );
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
  const [context, state, history] = await Promise.all([
    engine.contextForCommit(branch.headCommitId),
    engine.projector.project(branch.headCommitId),
    committedHistory(engine, branch.headCommitId),
  ]);
  const store = await WorkspaceStore.create(root);
  const explicitlyRequestedSource = options.source ? await resolveNovelSource(store, options.source) : undefined;
  const requestedSourceId = explicitlyRequestedSource?.id ?? saved?.sourceId ?? branch.sourceId;
  const activeSourceId = await resolveCommitSourceId(
    engine,
    context,
    branch.headCommitId,
    requestedSourceId,
    `Instance '${branchId}'`,
  );
  const source = explicitlyRequestedSource ?? (activeSourceId ? await resolveNovelSource(store, activeSourceId) : undefined);
  const characters = playableCharactersForContext(
    context.entities,
    state.values,
    activeSourceId,
    embodiedCharacterIds(history),
    !branch.preparedRevisionHash,
  );
  const requestedActor = options.character;
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
    ...(activeSourceId ? { sourceId: activeSourceId } : {}),
    actorId: actor.id,
    lastCommitId: branch.headCommitId,
  });
  const readinessWarnings: string[] = [];
  const readinessDiagnostics: string[] = [];
  const actorState = state.values[actor.id] ?? {};
  if (!Object.keys(actorState).length) {
    readinessDiagnostics.push(
      `${branch.preparedRevisionHash ? "当前实例固定的 prepared revision" : "当前实例的 genesis"}没有为 ${actor.canonicalName} 提供动态状态；场景会按 unknown 处理缺失字段。`,
    );
  } else if (typeof actorState["character.location"] !== "string") {
    readinessDiagnostics.push(
      `${actor.canonicalName} 的当前位置尚未写入该实例的 committed state；当前事件可以证明同场人物，但跨场景移动会要求更明确的落点。`,
    );
  }
  return {
    session,
    branchName: branch.name,
    ...(source ? { source } : {}),
    actor,
    logicalStep: state.logicalTime.step,
    readinessWarnings,
    readinessDiagnostics,
  };
}

export async function performPlayTurn(options: {
  root: string;
  branchId: string;
  actorId: string;
  utterance: string;
  translator: PlayerActionTranslator;
  adjudicator?: PlayerWorldAdjudicator;
  worldResponseResolver?: PlayerWorldResponseResolver;
  canonicalAttachmentResolver?: CanonicalAttachmentResolver;
  npcResponseReasoner?: NpcReactionReasoner;
  advanceBackground?: number;
  origin?: PlayerTurnOrigin;
  intent?: "act" | "observe" | "reflect" | "wait";
  affordanceId?: string;
  advanceActors?: number;
  beforeCommit?: () => void;
}): Promise<PlayTurnOutcome> {
  const startedAt = new Date();
  const advanceBackground = options.advanceBackground ?? 0;
  const advanceActors = options.advanceActors ?? 1;
  if (!Number.isInteger(advanceBackground) || advanceBackground < 0 || advanceBackground > 100) {
    throw new Error("advanceBackground must be an integer between 0 and 100");
  }
  if (!Number.isInteger(advanceActors) || advanceActors < 0 || advanceActors > 10) {
    throw new Error("advanceActors must be an integer between 0 and 10");
  }
  const { engine, runtime } = await openWorkspaceWorld(options.root);
  const previousHead = await engine.branches.readHead(options.branchId);
  const [branch, context] = await Promise.all([
    engine.branches.read(options.branchId),
    engine.contextForCommit(previousHead),
  ]);
  const sessionStore = new PlaySessionStore(options.root);
  const previousSession = await sessionStore.readInstance(options.branchId);
  const sourceId = await resolveCommitSourceId(
    engine,
    context,
    previousHead,
    previousSession?.sourceId ?? branch.sourceId,
    "Player turn",
  );
  const actor = context.entities.get(options.actorId);
  if (!actor || actor.kind !== "character" || (sourceId
    ? !evidenceBelongsExclusivelyToSource(actor.evidence, sourceId)
    : actor.evidence.length > 0)) {
    throw new Error(`Character '${options.actorId}' is not available on branch '${options.branchId}'.`);
  }
  const stateBefore = await engine.projector.project(previousHead);
  if (stateBefore.values[options.actorId]?.["character.alive"] === false) {
    throw new Error(`${actor.canonicalName} (${actor.id}) is not alive at branch '${options.branchId}' head.`);
  }
  const affordance = options.affordanceId
    ? await resolvePlayerAffordance(
        engine,
        runtime,
        options.actorId,
        previousHead,
        options.affordanceId,
        sourceId,
      )
    : undefined;
  if (options.affordanceId && !affordance) {
    throw new Error(`Player affordance '${options.affordanceId}' is stale or no longer executable at the current branch head.`);
  }
  const turns = new PlayerTurnService(
    engine,
    affordance ? () => structuredClone(affordance.candidate) : options.translator,
    undefined,
    (proposal) => runtime.resolveEligibleCanonicalEvents(proposal),
    options.beforeCommit,
    options.adjudicator,
  );
  const result = await turns.turn({
    branchId: options.branchId,
    ...(sourceId ? { sourceId } : {}),
    actorId: options.actorId,
    utterance: options.utterance,
  }, {
    ...(options.intent ?? affordance?.intent ? { intent: options.intent ?? affordance!.intent } : {}),
    ...(affordance
      ? {
          affordanceId: affordance.id,
          progress: affordance.progress,
          authorizedKnowledgeClaimIds: affordance.authorizedKnowledgeClaimIds,
        }
      : {}),
  });
  let conversationError: string | undefined;
  try {
    const playerEvent = result.eventHash ? await engine.objects.getEvent(result.eventHash) : undefined;
    await new PlayConversationStore(options.root).append({
      branchId: options.branchId,
      actorId: options.actorId,
      atCommit: result.newHead,
      ...(playerEvent ? { eventId: playerEvent.eventId } : {}),
      role: "player",
      status: result.accepted ? "accepted" : "rejected",
      text: options.utterance,
    });
  } catch (error) {
    conversationError = error instanceof Error ? error.message : String(error);
  }
  let finalHead = result.newHead;
  const worldResponseEvents: PlayTurnOutcome["worldResponseEvents"] = [];
  let worldResponseCandidates: PlayerWorldResponseOption[] = [];
  const backgroundEvents: PlayTurnOutcome["backgroundEvents"] = [];
  const canonicalRecoveryEvents: PlayTurnOutcome["canonicalRecoveryEvents"] = [];
  const canonicalRecoveryTraces: CanonicalRecoveryTrace[] = [];
  const excludedCanonicalPossibilityIds = new Set<string>();
  const reactionEvents: PlayTurnOutcome["reactionEvents"] = [];
  let worldResponseResolution: PlayerWorldResponseResolution | undefined;
  let canonicalRecoveryResolution: CanonicalAttachmentResolution | undefined;
  let worldResponseError: string | undefined;
  let canonicalRecoveryError: string | undefined;
  let npcResponseError: string | undefined;
  let backgroundError: string | undefined;
  if (result.accepted) {
    const explicitWait = result.candidate?.intent?.kind === "wait";
    const divergedFromCanonThisTurn = Boolean(result.proposal?.supersedesCanonicalEventIds?.length);
    // A newly committed contradiction of an eligible canonical event grants
    // exactly one progression slot. This is the user-authorized trigger for
    // looking forward; old divergence alone never advances an ordinary turn.
    const effectiveAdvanceBackground = explicitWait
      ? 1
      : Math.max(advanceBackground, divergedFromCanonThisTurn ? 1 : 0);
    let directNpcAttempts = 0;
    if (options.npcResponseReasoner && result.candidate && result.eventHash) {
      const interaction = result.candidate.intent?.controlledAct?.interaction;
      directNpcAttempts = new Set(
        (interaction?.addresseeIds ?? []).filter((id) => id !== options.actorId),
      ).size;
      if (directNpcAttempts > 0) {
        try {
          const playerEvent = await engine.objects.getEvent(result.eventHash);
          const npcResponses = await respondToNpcInteractions({
            engine,
            branchId: options.branchId,
            playerId: options.actorId,
            ...(sourceId ? { sourceId } : {}),
            playerCandidate: result.candidate,
            triggerEvent: playerEvent,
            reasoner: options.npcResponseReasoner,
          });
          finalHead = npcResponses.newHead;
          reactionEvents.push(...npcResponses.responses);
          if (npcResponses.failures.length) {
            npcResponseError = npcResponses.failures
              .map((failure) => `${failure.actorId}: ${failure.error}`)
              .join("; ");
          }
        } catch (error) {
          finalHead = await engine.branches.readHead(options.branchId);
          npcResponseError = error instanceof Error ? error.message : String(error);
        }
      }
    }
    if (options.worldResponseResolver && result.candidate) {
      try {
        const playerEvent = result.eventHash ? await engine.objects.getEvent(result.eventHash) : undefined;
        const currentPlayerContext = finalHead === result.newHead
          ? result.contextAfter
          : await buildActorScopedActionContext(engine, options.actorId, finalHead, undefined, sourceId);
        const presentEntities = currentPlayerContext.presentEntities.map((entity) => ({
          id: entity.id,
          name: entity.name,
          kind: entity.kind,
        }));
        if (!presentEntities.some((entity) => entity.id === actor.id)) {
          presentEntities.unshift({ id: actor.id, name: actor.canonicalName, kind: actor.kind });
        }
        const responseConversation = await playConversationAtCommit(engine, options.branchId, finalHead, options.actorId);
        const relatedMessages = modelPlayConversation(responseConversation);
        const response = await runtime.respondToPlayer({
          branchId: options.branchId,
          actorId: options.actorId,
          utterance: options.utterance,
          candidate: result.candidate,
          scene: {
            ...(currentPlayerContext.scene.label ? { label: currentPlayerContext.scene.label } : {}),
            presentEntities,
            recentEvents: currentPlayerContext.recentVisibleEvents.map(({ summary }) => ({ summary })),
          },
          expectedHead: finalHead,
          recentMessages: modelPlayConversation(recentPlayConversation(responseConversation)),
          relatedMessages,
          resolver: async (input) => {
            worldResponseCandidates = structuredClone(input.eligibleResponses);
            return options.worldResponseResolver!(input);
          },
          ...(playerEvent ? { causalParentEventId: playerEvent.eventId } : {}),
        });
        worldResponseResolution = response.resolution;
        finalHead = response.newHead;
        if (response.eventHash && response.possibilityId && response.title) {
          worldResponseEvents.push({
            eventHash: response.eventHash,
            title: response.title,
            possibilityId: response.possibilityId,
          });
        }
      } catch (error) {
        finalHead = await engine.branches.readHead(options.branchId);
        worldResponseError = error instanceof Error ? error.message : String(error);
      }
    }
    if (options.canonicalAttachmentResolver || effectiveAdvanceBackground > 0) {
      try {
        const recovery = await runtime.recoverCanonicalTrajectory({
          branchId: options.branchId,
          actorId: options.actorId,
          expectedHead: finalHead,
          // Low-level/custom callers may omit the semantic adapter. The
          // deterministic scan still runs so stronger scaffold gates can deny
          // an unsafe exact candidate; it simply declines creative attachment.
          resolver: options.canonicalAttachmentResolver ?? (() => ({ decision: "none" as const })),
          temporalMode: divergedFromCanonThisTurn || (effectiveAdvanceBackground > 0 && !explicitWait)
            ? "advance"
            : "current-window",
        });
        canonicalRecoveryResolution = recovery.resolution;
        canonicalRecoveryTraces.push(...recovery.traces);
        recovery.excludedCanonicalPossibilityIds.forEach((id) => excludedCanonicalPossibilityIds.add(id));
        finalHead = recovery.newHead;
        if (
          recovery.eventHash
          && recovery.title
          && recovery.scaffoldPossibilityId
          && recovery.canonicalEventId
        ) {
          canonicalRecoveryEvents.push({
            eventHash: recovery.eventHash,
            title: recovery.title,
            scaffoldPossibilityId: recovery.scaffoldPossibilityId,
            canonicalEventId: recovery.canonicalEventId,
          });
        }
      } catch (error) {
        finalHead = await engine.branches.readHead(options.branchId);
        canonicalRecoveryError = error instanceof Error ? error.message : String(error);
      }
    }
    try {
      const advanced = await runtime.move({
        branchId: options.branchId,
        maxActorCandidates: Math.max(0, advanceActors - directNpcAttempts),
        // A committed attachment already consumed one requested progression
        // slot; do not silently chain a second world event in the same slot.
        // A failed recovery stops background scheduling for this turn;
        // falling through could let the scheduler bypass gates computed before
        // the failed semantic/commit boundary returned its exclusions.
        maxBackgroundCandidates: canonicalRecoveryError
          ? 0
          : Math.max(0, effectiveAdvanceBackground - canonicalRecoveryEvents.length),
        excludedBackgroundPossibilityIds: [...excludedCanonicalPossibilityIds],
        temporalMode: explicitWait ? "current-window" : effectiveAdvanceBackground > 0 ? "advance" : "current-window",
        ...(explicitWait ? { backgroundKinds: AUTONOMOUS_BACKGROUND_KINDS } : {}),
      });
      finalHead = advanced.newHead;
      for (const eventHash of advanced.committedEvents) {
        const event = await engine.objects.getEvent(eventHash);
        if (event.actorId) reactionEvents.push({ eventHash, title: event.title, actorId: event.actorId });
        else backgroundEvents.push({ eventHash, title: event.title });
      }
    } catch (error) {
      finalHead = await engine.branches.readHead(options.branchId);
      backgroundError = error instanceof Error ? error.message : String(error);
    }
  }
  const finalState = await engine.projector.project(finalHead);
  await sessionStore.write({
    branchId: options.branchId,
    ...(sourceId ? { sourceId } : {}),
    actorId: options.actorId,
    lastCommitId: finalHead,
  });
  const finishedAt = new Date();
  let auditId: string | undefined;
  let auditError: string | undefined;
  try {
    const audit = await new PlayerTurnAuditStore(options.root).write({
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      branchId: options.branchId,
      actorId: options.actorId,
      utterance: options.utterance,
      origin: options.origin ?? "cli",
      ...(options.intent ? { intent: options.intent } : {}),
      ...(options.affordanceId ? { affordanceId: options.affordanceId } : {}),
      previousHead: result.previousHead,
      finalHead,
      stage: result.stage,
      accepted: result.accepted,
      issues: structuredClone(result.issues),
      ...(result.intendedCandidate ? { intendedCandidate: structuredClone(result.intendedCandidate) } : {}),
      ...(result.candidate ? { candidate: structuredClone(result.candidate) } : {}),
      ...(result.adjudication ? { adjudication: structuredClone(result.adjudication) } : {}),
      ...(result.proposal ? { proposal: structuredClone(result.proposal) } : {}),
      ...(result.validation ? { validation: structuredClone(result.validation) } : {}),
      ...(result.eventHash ? { eventHash: result.eventHash } : {}),
      ...(result.progressCertificate ? { progressCertificate: structuredClone(result.progressCertificate) } : {}),
      ...(worldResponseResolution ? { worldResponseResolution: structuredClone(worldResponseResolution) } : {}),
      worldResponseCandidates: structuredClone(worldResponseCandidates),
      worldResponseEvents: structuredClone(worldResponseEvents),
      ...(worldResponseError ? { worldResponseError } : {}),
      ...(canonicalRecoveryResolution ? { canonicalRecoveryResolution: structuredClone(canonicalRecoveryResolution) } : {}),
      canonicalRecoveryTraces: structuredClone(canonicalRecoveryTraces),
      excludedCanonicalPossibilityIds: [...excludedCanonicalPossibilityIds].sort(),
      canonicalRecoveryEvents: structuredClone(canonicalRecoveryEvents),
      ...(canonicalRecoveryError ? { canonicalRecoveryError } : {}),
      ...(npcResponseError ? { npcResponseError } : {}),
      reactionEvents: structuredClone(reactionEvents),
      backgroundEvents: structuredClone(backgroundEvents),
      ...(backgroundError ? { backgroundError } : {}),
      ...(conversationError ? { conversationError } : {}),
    });
    auditId = audit.id;
  } catch (error) {
    auditError = error instanceof Error ? error.message : String(error);
  }
  return {
    result,
    finalHead,
    logicalStep: finalState.logicalTime.step,
    worldResponseCandidates,
    worldResponseEvents,
    ...(worldResponseResolution ? { worldResponseResolution } : {}),
    ...(worldResponseError ? { worldResponseError } : {}),
    canonicalRecoveryEvents,
    canonicalRecoveryTraces,
    excludedCanonicalPossibilityIds: [...excludedCanonicalPossibilityIds].sort(),
    ...(canonicalRecoveryResolution ? { canonicalRecoveryResolution } : {}),
    ...(canonicalRecoveryError ? { canonicalRecoveryError } : {}),
    ...(npcResponseError ? { npcResponseError } : {}),
    backgroundEvents,
    reactionEvents,
    ...(backgroundError ? { backgroundError } : {}),
    ...(conversationError ? { conversationError } : {}),
    ...(auditId ? { auditId } : {}),
    ...(auditError ? { auditError } : {}),
  };
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

function playableCharactersForContext(
  entities: ReadonlyMap<string, Entity>,
  state: Readonly<Record<string, Record<string, unknown>>>,
  sourceId?: string,
  embodiedIds: ReadonlySet<string> = new Set(),
  allowLegacyStateFallback = true,
): PlayableCharacter[] {
  const sourceCharacters = [...entities.values()]
    .filter((entity) => entity.kind === "character")
    .filter((entity) => sourceId
      ? evidenceBelongsExclusivelyToSource(entity.evidence, sourceId)
      : entity.evidence.length === 0);
  return sourceCharacters
    .filter((entity) => state[entity.id]?.["character.alive"] !== false)
    .filter((entity) => embodiedIds.has(entity.id)
      || (allowLegacyStateFallback && Object.keys(state[entity.id] ?? {}).length > 0))
    .map((entity) => characterSummary(entity, state[entity.id] ?? {}, entities))
    .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName));
}

function embodiedCharacterIds(
  history: readonly Awaited<ReturnType<typeof committedHistory>>[number][],
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const { event } of history) {
    if (event.actorId) result.add(event.actorId);
    for (const presence of event.participantPresence ?? []) {
      if (presence.mode === "physical") result.add(presence.entityId);
    }
    // Legacy interactive commits made local participation explicit through
    // actor observations even before participantPresence existed.
    if (!event.participantPresence && (event.actorId || event.actorObservations?.length)) {
      for (const participantId of event.participants) result.add(participantId);
    }
  }
  return result;
}

function characterChoices(characters: readonly PlayableCharacter[]): string {
  return characters.length
    ? characters.map((character) => `${character.canonicalName} (${character.id})`).join(", ")
    : "none";
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

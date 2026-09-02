import crypto from "node:crypto";
import path from "node:path";
import { createPiCanonicalAttachmentResolver } from "../agent/pi-canonical-attachment.js";
import { createPiNpcReactionReasoner } from "../agent/pi-npc-reaction.js";
import { createPiPlayerActionTranslator } from "../agent/pi-player-action.js";
import {
  createPiPlayerOpeningNarrator,
  type PlayerOpeningNarrator,
} from "../agent/pi-player-opening.js";
import { createPiPlayerWorldAdjudicator } from "../agent/pi-player-world-adjudicator.js";
import { createPiPlayerWorldResponseResolver } from "../agent/pi-player-world-response.js";
import { createPiRuntimeContextResolver } from "../agent/pi-runtime-context.js";
import { playerSceneChoicesSchema, type PlayerSceneChoice } from "../agent/player-scene-choice-tool.js";
import { loadOptionalConfig, profileForRole } from "../config/load.js";
import type { LlmProfile } from "../config/schema.js";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import type { CanonicalAttachmentResolver } from "../world/canonical-adaptation.js";
import { readFrozenWorldBase } from "../world/base.js";
import { deriveCharacterEntryOptions } from "../world/entry-context.js";
import type { NpcReactionReasoner } from "../world/npc-reaction.js";
import {
  type PlayerActionTranslator,
  type PlayerWorldAdjudicator,
} from "../world/player-action.js";
import type { RuntimeContextResolver, RuntimeContextSupplement } from "../world/runtime-context.js";
import {
  PlayConversationStore,
  modelPlayConversation,
  type PlayConversationMessage,
} from "../world/play-conversation.js";
import {
  inspectPlayExperience,
  listPlayableCharacters,
  performPlayTurn,
  type PlayTurnOutcome,
} from "../world/play-experience.js";
import { choosePlayExperience } from "../world/play-choice.js";
import {
  assertPlaySceneNarration,
  buildPlayOpeningFrame,
  playSceneRequestForEntry,
  playerRuntimeContextFrame,
  playerSceneModelFrame,
  resolvePlayScenePurpose,
  type PlayOpeningFrame,
  type PlayScenePurpose,
  type PlayerTurnResolution,
} from "../world/play-opening.js";
import { logicalTimeSchema } from "../world/model.js";
import { newPlaySessionIdentity, PlaySessionStore, type ActivePlaySession } from "../world/play-session.js";
import type { PlayerWorldResponseResolver } from "../world/runtime.js";
import { BranchStore } from "../world/store.js";
import { openWorkspaceWorld } from "../world/workspace-runtime.js";
import {
  clearPlayConversationResultSchema,
  createPlaySessionRequestSchema,
  enterPlaySessionRequestSchema,
  narrationRetryRequestSchema,
  narrationRetryResultSchema,
  playableCharacterListSchema,
  playSessionCommandRequestSchema,
  playMoveRequestSchema,
  playOperationResultSchema,
  playSessionEntryResultSchema,
  playSessionDetailSchema,
  removePlaySessionResultSchema,
  sceneNarrationRequestSchema,
  sceneNarrationResultSchema,
  sourcePlayRoleListSchema,
  startFreshPlayRequestSchema,
  startFreshPlayResultSchema,
  updatePlaySessionRequestSchema,
  type ClearPlayConversationResult,
  type CreatePlaySessionRequest,
  type EnterPlaySessionRequest,
  type NarrationRetryRequest,
  type NarrationRetryResult,
  type OperationAccepted,
  type PlayableCharacterList,
  type PlaySessionCommandRequest,
  type PlayMoveRequest,
  type PlayOperationResult,
  type PlaySessionEntryResult,
  type PlaySessionDetail,
  type PlayerChoiceSummary,
  type RemovePlaySessionResult,
  type SceneNarrationRequest,
  type SceneNarrationResult,
  type SourcePlayRoleList,
  type StartFreshPlayRequest,
  type StartFreshPlayResult,
  type UpdatePlaySessionRequest,
} from "../web/contracts.js";
import { WebEventBroker } from "../web/event-stream.js";
import { webError } from "../web/errors.js";
import { WebMutationJournal } from "../web/mutation-journal.js";
import { OperationManager, type OperationRunContext } from "../web/operation-manager.js";
import { CatalogService } from "./catalog-service.js";
import { traceProvesCommittedPlayerMove } from "./play-trace-recovery-service.js";
import { TraceRecorder, newTraceId, type TraceContext } from "../trace/recorder.js";
import { TraceStore } from "../trace/store.js";
import type { TraceErrorSummary, TraceRunManifest, TraceRunStatus } from "../trace/schema.js";

export interface PlayApplicationServiceOptions {
  root: string;
  operations: OperationManager;
  events: WebEventBroker;
  configPath?: string;
  model?: string;
  preparedCacheRoot?: string;
  translator?: PlayerActionTranslator;
  adjudicator?: PlayerWorldAdjudicator;
  contextResolver?: RuntimeContextResolver;
  worldResponseResolver?: PlayerWorldResponseResolver;
  canonicalAttachmentResolver?: CanonicalAttachmentResolver;
  npcResponseReasoner?: NpcReactionReasoner;
  narrator?: PlayerOpeningNarrator;
  advanceBackground?: number;
  traceStore?: TraceStore;
  mutations?: WebMutationJournal;
}

type NarrationOutcome = {
  narration: string;
  choices: PlayerChoiceSummary[];
  message: PlayConversationMessage;
};

type ResolvedSceneNarrationRequest = Omit<SceneNarrationRequest, "purpose"> & {
  purpose: PlayScenePurpose;
};

export class PlayApplicationService {
  readonly root: string;
  private readonly sessions: PlaySessionStore;
  private readonly conversations: PlayConversationStore;
  private readonly branches: BranchStore;
  private readonly catalog: CatalogService;
  private readonly traces: TraceStore;
  private readonly mutations: WebMutationJournal;
  private readonly entryRequests = new Map<string, Promise<PlaySessionEntryResult>>();

  constructor(private readonly options: PlayApplicationServiceOptions) {
    this.root = path.resolve(options.root);
    this.sessions = new PlaySessionStore(this.root);
    this.conversations = new PlayConversationStore(this.root);
    this.branches = new BranchStore(this.root);
    this.catalog = new CatalogService(this.root);
    this.traces = options.traceStore ?? new TraceStore(this.root);
    this.mutations = options.mutations ?? new WebMutationJournal(this.root);
  }

  get traceStore(): TraceStore {
    return this.traces;
  }

  async listCharacters(branchId: string, sourceId?: string): Promise<PlayableCharacterList> {
    const listed = await listPlayableCharacters(this.root, {
      branchId,
      ...(sourceId ? { source: sourceId } : {}),
    });
    const currentCharacters = listed.characters.map((character) => ({
      ...character,
      availability: "current-head" as const,
    }));
    let characters: PlayableCharacterList["characters"] = currentCharacters;
    try {
      const catalog = await inspectPlayExperience(this.root);
      const instance = catalog.instances.find((candidate) => candidate.branchId === branchId);
      const source = catalog.novels.find((candidate) => candidate.id === (sourceId ?? instance?.sourceId));
      if (source && instance?.preparedRevisionHash) {
        const prepared = await new PreparedNovelCache(this.root, this.options.preparedCacheRoot)
          .loadRevision(source, instance.preparedRevisionHash);
        if (prepared) {
          const currentById = new Map(currentCharacters.map((character) => [character.id, character]));
          const entryCharacters = deriveCharacterEntryOptions(prepared.bundle).map((entry) => {
            const current = currentById.get(entry.actorId);
            currentById.delete(entry.actorId);
            return {
              ...(current ?? {
                id: entry.actorId,
                canonicalName: entry.canonicalName,
                aliases: entry.aliases,
                sourceIds: [source.id],
              }),
              availability: current ? "current-head" as const : "entry-checkpoint" as const,
              entryKind: entry.entry.kind,
              entryTitle: entry.entry.title,
            };
          });
          characters = [...entryCharacters, ...currentById.values()];
        }
      }
    } catch {
      // A pinned legacy revision may remain playable even when its newer entry
      // metadata cannot be loaded. Current committed roles still remain valid.
    }
    return playableCharacterListSchema.parse({
      branchId: listed.branchId,
      ...(listed.source ? { sourceId: listed.source.id, sourceTitle: listed.source.title } : {}),
      characters,
    });
  }

  /** List role checkpoints from the active frozen base, not from a mutable branch head. */
  async listSourceRoles(sourceId: string): Promise<SourcePlayRoleList> {
    const workspace = await WorkspaceStore.create(this.root);
    const source = await workspace.getSource(sourceId);
    if (!source) throw this.sourceNotFound(sourceId);
    let prepared;
    try {
      prepared = await new PreparedNovelCache(this.root, this.options.preparedCacheRoot).loadFreshActive(source);
    } catch (error) {
      throw webError(409, "FROZEN_BASE_NOT_READY", errorMessage(error), {
        kind: "after-refresh",
        discoveryEndpoint: `/api/v1/novels/${encodeURIComponent(sourceId)}/preparation`,
        copyField: "stage",
        maxAttempts: 1,
      });
    }
    if (!prepared) {
      throw webError(409, "FROZEN_BASE_NOT_READY", `Novel '${source.title}' has no published frozen world base.`, {
        kind: "after-user-action",
        discoveryEndpoint: `/api/v1/novels/${encodeURIComponent(sourceId)}/preparation`,
        copyField: "nextAction",
        maxAttempts: 1,
      });
    }
    return sourcePlayRoleListSchema.parse({
      sourceId: source.id,
      sourceTitle: source.title,
      preparedRevisionHash: prepared.bundleHash,
      roles: deriveCharacterEntryOptions(prepared.bundle).map((entry) => ({
        id: entry.actorId,
        canonicalName: entry.canonicalName,
        aliases: entry.aliases,
        entryKind: entry.entry.kind,
        entryTitle: entry.entry.title,
      })),
    });
  }

  /**
   * Start a new playthrough as one atomic harness use case: select a role from
   * the frozen base, create a sibling branch, and create its private
   * conversation. The Web UI never assembles these state transitions itself.
   */
  async startFreshPlay(inputValue: StartFreshPlayRequest): Promise<StartFreshPlayResult> {
    const input = startFreshPlayRequestSchema.parse(inputValue);
    const execution = await this.mutations.execute({
      kind: "fresh-play-start",
      scopeId: input.sourceId,
      clientRequestId: input.clientRequestId,
      request: input,
    }, () => this.startFreshPlayOnce(input));
    return startFreshPlayResultSchema.parse({
      ...execution.value,
      reused: execution.reused,
    });
  }

  private async startFreshPlayOnce(
    input: StartFreshPlayRequest,
  ): Promise<Omit<StartFreshPlayResult, "reused">> {
    const roles = await this.listSourceRoles(input.sourceId);
    if (roles.preparedRevisionHash !== input.preparedRevisionHash) {
      throw webError(409, "FROZEN_BASE_MOVED", "The active frozen base changed after role selection. Refresh the role list before starting play.", {
        kind: "after-refresh",
        discoveryEndpoint: `/api/v1/novels/${encodeURIComponent(input.sourceId)}/play-roles`,
        copyField: "preparedRevisionHash",
        maxAttempts: 1,
      });
    }
    if (!roles.roles.some((role) => role.id === input.actorId)) {
      throw webError(400, "PLAY_ROLE_NOT_IN_FROZEN_BASE", `Role '${input.actorId}' has no grounded entry in the active frozen base.`, {
        kind: "after-refresh",
        discoveryEndpoint: `/api/v1/novels/${encodeURIComponent(input.sourceId)}/play-roles`,
        copyField: "roles[].id",
        maxAttempts: 1,
      });
    }
    let selection;
    try {
      selection = await choosePlayExperience(this.root, {
        source: input.sourceId,
        expectedPreparedRevisionHash: input.preparedRevisionHash,
        character: input.actorId,
        instanceMode: "create",
        preferSavedCharacter: false,
        preferActiveSource: false,
        ...(this.options.preparedCacheRoot ? { preparedCacheRoot: this.options.preparedCacheRoot } : {}),
        sessionIdentity: newPlaySessionIdentity(),
      }, async () => undefined);
    } catch (error) {
      throw webError(409, "FRESH_PLAY_START_FAILED", errorMessage(error), {
        kind: "after-refresh",
        discoveryEndpoint: `/api/v1/novels/${encodeURIComponent(input.sourceId)}/play-roles`,
        copyField: "preparedRevisionHash",
        maxAttempts: 1,
      });
    }
    if (!selection) {
      throw webError(409, "FRESH_PLAY_START_FAILED", "The selected frozen-base role could not create a play instance.", {
        kind: "after-refresh",
        discoveryEndpoint: `/api/v1/novels/${encodeURIComponent(input.sourceId)}/play-roles`,
        copyField: "roles[].id",
        maxAttempts: 1,
      });
    }
    if (input.title && selection.session.title !== input.title) {
      await this.sessions.updateMetadata(selection.session.id, { title: input.title });
    }
    const catalog = await this.catalog.read();
    const instance = catalog.instances.find((candidate) => candidate.branchId === selection.session.branchId);
    if (!instance) throw new Error(`Fresh instance '${selection.session.branchId}' was not discoverable after creation.`);
    const [session, base] = await Promise.all([
      this.getSession(selection.session.id),
      readFrozenWorldBase(this.root, selection.session.branchId),
    ]);
    this.invalidateCatalog("fresh-play-created", selection.session.id);
    return { instance, session, base };
  }

  async createSession(inputValue: CreatePlaySessionRequest): Promise<PlaySessionDetail> {
    const input = createPlaySessionRequestSchema.parse(inputValue);
    const execution = await this.mutations.execute({
      kind: "play-session-create",
      scopeId: input.branchId,
      clientRequestId: input.clientRequestId,
      request: input,
    }, () => this.createSessionOnce(input));
    return this.getSession(execution.value.sessionId);
  }

  private async createSessionOnce(input: CreatePlaySessionRequest): Promise<{ sessionId: string }> {
    let selection;
    try {
      selection = await choosePlayExperience(this.root, {
        branchId: input.branchId,
        character: input.actorId,
        ...(input.sourceId ? { source: input.sourceId } : {}),
        preferSavedCharacter: false,
        instanceMode: "switch",
        ...(this.options.preparedCacheRoot ? { preparedCacheRoot: this.options.preparedCacheRoot } : {}),
        sessionIdentity: newPlaySessionIdentity(),
      }, async () => undefined);
    } catch (error) {
      throw webError(400, "PLAY_SESSION_SELECTION_FAILED", errorMessage(error), {
        kind: "after-refresh",
        discoveryEndpoint: `/api/v1/instances/${encodeURIComponent(input.branchId)}/characters`,
        copyField: "characters[].id",
        maxAttempts: 1,
      });
    }
    if (!selection) {
      throw webError(400, "PLAY_SESSION_SELECTION_FAILED", `No unique playable role '${input.actorId}' is available.`, {
        kind: "after-refresh",
        discoveryEndpoint: `/api/v1/instances/${encodeURIComponent(input.branchId)}/characters`,
        copyField: "characters[].id",
        maxAttempts: 1,
      });
    }
    const title = input.title ?? `${selection.actor.canonicalName} · ${selection.branchName}`;
    if (selection.session.title !== title) {
      await this.sessions.updateMetadata(selection.session.id, { title });
    }
    this.invalidateCatalog("play-session-created", selection.session.id);
    return { sessionId: selection.session.id };
  }

  async getSession(sessionId: string): Promise<PlaySessionDetail> {
    const session = await this.requireSession(sessionId);
    const [catalog, messages, headCommitId] = await Promise.all([
      this.catalog.read(),
      this.conversations.list(session.branchId, session.conversationId),
      this.readHeadOrNull(session.branchId),
    ]);
    const summary = catalog.playSessions.find((candidate) => candidate.id === session.id);
    if (!summary) throw this.sessionNotFound(sessionId);
    return playSessionDetailSchema.parse({
      session: summary,
      headCommitId,
      messages: messages.map(({ version: _version, ...message }) => message),
    });
  }

  async enterSession(sessionId: string, inputValue: EnterPlaySessionRequest): Promise<PlaySessionEntryResult> {
    const input = enterPlaySessionRequestSchema.parse(inputValue);
    const pending = this.entryRequests.get(sessionId);
    if (pending) return structuredClone(await pending);
    const execution = this.enterSessionOnce(sessionId, input);
    this.entryRequests.set(sessionId, execution);
    try {
      return structuredClone(await execution);
    } finally {
      if (this.entryRequests.get(sessionId) === execution) this.entryRequests.delete(sessionId);
    }
  }

  private async enterSessionOnce(sessionId: string, input: EnterPlaySessionRequest): Promise<PlaySessionEntryResult> {
    const session = await this.requireSession(sessionId);
    if (session.status === "archived" || session.status === "detached") {
      return playSessionEntryResultSchema.parse({
        sessionId: session.id,
        state: "unavailable",
        reason: "session-not-writable",
      });
    }

    const [messages, headCommitId] = await Promise.all([
      this.conversations.list(session.branchId, session.conversationId),
      this.readHeadOrNull(session.branchId),
    ]);
    if (!headCommitId) {
      return playSessionEntryResultSchema.parse({
        sessionId: session.id,
        state: "unavailable",
        reason: "session-not-writable",
      });
    }
    if (messages.some((message) =>
      message.role === "scene"
      && message.status === "rendered"
      && message.atCommit === headCommitId)) {
      return playSessionEntryResultSchema.parse({
        sessionId: session.id,
        state: "ready",
        reason: "scene-present",
      });
    }

    const sceneRequest = playSceneRequestForEntry(input.intent, messages.length === 0);
    const storyTime = await this.storyTimeAt(headCommitId);
    const logicalTime = logicalTimeSchema.parse(storyTime.logicalTime);
    const purpose = resolvePlayScenePurpose(sceneRequest, {
      logicalStep: logicalTime.step,
      selectionChanged: true,
      hadPreviousSelection: false,
    });
    const clientRequestId = entryNarrationClientRequestId(session.id, headCommitId);
    const existing = this.options.operations.findByClientRequest("scene-narration", session.id, clientRequestId);
    if (existing) {
      const terminal = operationIsTerminal(existing.status);
      return playSessionEntryResultSchema.parse({
        sessionId: session.id,
        state: terminal ? "recovery-required" : "starting",
        reason: terminal
          ? existing.status === "succeeded" ? "prior-session-activity" : "scene-operation-failed"
          : "scene-operation-active",
        sceneRequest,
        ...(purpose ? { purpose } : {}),
        operation: existing,
      });
    }

    const priorRuns = await this.traces.listRuns({ playSessionId: session.id, limit: 1_000 });
    const hasCurrentActivity = messages.some((message) => message.atCommit === headCommitId)
      || priorRuns.some((run) => run.previousHead === headCommitId || run.finalHead === headCommitId);
    if (hasCurrentActivity) {
      return playSessionEntryResultSchema.parse({
        sessionId: session.id,
        state: "recovery-required",
        reason: "prior-session-activity",
        sceneRequest,
        ...(purpose ? { purpose } : {}),
      });
    }
    if (!purpose) {
      return playSessionEntryResultSchema.parse({
        sessionId: session.id,
        state: "ready",
        reason: "entry-does-not-request-scene",
        sceneRequest,
      });
    }

    const accepted = await this.startSceneNarration(session.id, {
      purpose,
      expectedHead: headCommitId,
      clientRequestId,
    });
    const terminal = operationIsTerminal(accepted.operation.status);
    return playSessionEntryResultSchema.parse({
      sessionId: session.id,
      state: terminal
        ? accepted.operation.status === "succeeded" ? "ready" : "recovery-required"
        : "starting",
      reason: terminal
        ? accepted.operation.status === "succeeded" ? "prior-session-activity" : "scene-operation-failed"
        : accepted.reused ? "scene-operation-active" : "scene-started",
      sceneRequest,
      purpose,
      operation: accepted.operation,
    });
  }

  async activateSession(sessionId: string, inputValue: PlaySessionCommandRequest): Promise<PlaySessionDetail> {
    const input = playSessionCommandRequestSchema.parse(inputValue);
    const execution = await this.mutations.execute({
      kind: "play-session-activate",
      scopeId: sessionId,
      clientRequestId: input.clientRequestId,
      request: input,
    }, async () => {
      const session = await this.requireSession(sessionId);
      if (session.status === "archived") {
        throw webError(409, "PLAY_SESSION_ARCHIVED", `Play session '${session.id}' must be restored before it can be activated.`, {
          kind: "after-user-action",
          discoveryEndpoint: `/api/v1/play-sessions/${encodeURIComponent(session.id)}/restore`,
          copyField: "session.id",
          maxAttempts: 1,
        });
      }
      await this.sessions.activate(session.id);
      this.invalidateCatalog("play-session-activated", session.id);
      return { sessionId: session.id };
    });
    return this.getSession(execution.value.sessionId);
  }

  async updateSession(sessionId: string, inputValue: UpdatePlaySessionRequest): Promise<PlaySessionDetail> {
    const input = updatePlaySessionRequestSchema.parse(inputValue);
    const execution = await this.mutations.execute({
      kind: "play-session-update",
      scopeId: sessionId,
      clientRequestId: input.clientRequestId,
      request: input,
    }, async () => {
      const session = await this.requireSession(sessionId);
      this.assertNoActiveOperation(session.id);
      await this.sessions.updateMetadata(session.id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      });
      this.invalidateCatalog("play-session-updated", session.id);
      return { sessionId: session.id };
    });
    return this.getSession(execution.value.sessionId);
  }

  async restoreSession(sessionId: string, inputValue: PlaySessionCommandRequest): Promise<PlaySessionDetail> {
    const input = playSessionCommandRequestSchema.parse(inputValue);
    const execution = await this.mutations.execute({
      kind: "play-session-restore",
      scopeId: sessionId,
      clientRequestId: input.clientRequestId,
      request: input,
    }, async () => {
      const session = await this.requireSession(sessionId);
      await this.sessions.restore(session.id);
      this.invalidateCatalog("play-session-restored", session.id);
      return { sessionId: session.id };
    });
    return this.getSession(execution.value.sessionId);
  }

  async clearConversation(sessionId: string, inputValue: PlaySessionCommandRequest): Promise<ClearPlayConversationResult> {
    const input = playSessionCommandRequestSchema.parse(inputValue);
    const execution = await this.mutations.execute({
      kind: "play-conversation-clear",
      scopeId: sessionId,
      clientRequestId: input.clientRequestId,
      request: input,
    }, async () => {
      const session = await this.requireSession(sessionId);
      this.assertNoActiveOperation(session.id);
      await this.conversations.remove(session.branchId, session.conversationId);
      this.invalidateCatalog("play-conversation-cleared", session.id);
      return clearPlayConversationResultSchema.parse({
        sessionId: session.id,
        branchId: session.branchId,
        branchPreserved: true,
        cleared: true,
      });
    });
    return clearPlayConversationResultSchema.parse(execution.value);
  }

  async removeSession(sessionId: string, inputValue: PlaySessionCommandRequest): Promise<RemovePlaySessionResult> {
    const input = playSessionCommandRequestSchema.parse(inputValue);
    const execution = await this.mutations.execute({
      kind: "play-session-remove",
      scopeId: sessionId,
      clientRequestId: input.clientRequestId,
      request: input,
    }, async () => {
      const session = await this.requireSession(sessionId);
      this.assertNoActiveOperation(session.id);
      await this.sessions.removeSession(session.id);
      await this.conversations.remove(session.branchId, session.conversationId);
      this.invalidateCatalog("play-session-removed", session.id);
      return removePlaySessionResultSchema.parse({
        sessionId: session.id,
        branchId: session.branchId,
        branchPreserved: true,
        conversationRemoved: true,
      });
    });
    return removePlaySessionResultSchema.parse(execution.value);
  }

  async startPlayerMove(sessionId: string, inputValue: PlayMoveRequest): Promise<OperationAccepted> {
    const input = playMoveRequestSchema.parse(inputValue);
    const existing = this.options.operations.findByClientRequest("player-move", sessionId, input.clientRequestId);
    if (existing) {
      return this.options.operations.start({
        kind: "player-move",
        scopeId: sessionId,
        clientRequestId: input.clientRequestId,
        request: input,
        run: async () => { throw new Error("An idempotent operation must not be executed twice."); },
      });
    }
    const session = await this.requireWritableSession(sessionId);
    await this.assertExpectedHead(session, input.expectedHead);
    this.assertNoActiveOperation(session.id);
    const storyTimeBefore = await this.storyTimeAt(input.expectedHead);
    const playerMoveId = newTraceId("move");
    const recorder = await TraceRecorder.start(this.traces, {
      kind: "player-move",
      sourceId: session.sourceId,
      branchId: session.branchId,
      playSessionId: session.id,
      playerMoveId,
      actorId: session.actorId,
      previousHead: input.expectedHead,
      storyTimeBefore,
    });
    try {
      const accepted = this.options.operations.start({
        kind: "player-move",
        scopeId: session.id,
        clientRequestId: input.clientRequestId,
        request: input,
        runId: recorder.manifest.id,
        run: (context) => this.runWithTrace(
          recorder,
          session.branchId,
          context,
          () => this.runPlayerMove(session.id, input, context, recorder, playerMoveId),
        ),
      });
      if (accepted.reused) {
        await recorder.finish("cancelled", {}, {
          code: "IDEMPOTENT_OPERATION_REUSED",
          message: "A concurrent request reused an existing operation; this unused trace was closed without executing.",
          retryable: false,
        });
        return accepted;
      }
      await recorder.link({ operationId: accepted.operation.id });
      return accepted;
    } catch (error) {
      await recorder.finish("failed", {}, traceError(error, "failed")).catch(() => undefined);
      throw error;
    }
  }

  async startSceneNarration(sessionId: string, inputValue: SceneNarrationRequest): Promise<OperationAccepted> {
    const input = sceneNarrationRequestSchema.parse(inputValue);
    const existing = this.options.operations.findByClientRequest("scene-narration", sessionId, input.clientRequestId);
    if (existing) {
      return this.options.operations.start({
        kind: "scene-narration",
        scopeId: sessionId,
        clientRequestId: input.clientRequestId,
        request: input,
        run: async () => { throw new Error("An idempotent operation must not be executed twice."); },
      });
    }
    const session = await this.requireWritableSession(sessionId);
    await this.assertExpectedHead(session, input.expectedHead);
    this.assertNoActiveOperation(session.id);
    const storyTimeBefore = await this.storyTimeAt(input.expectedHead);
    const logicalTime = logicalTimeSchema.parse(storyTimeBefore.logicalTime);
    const purpose = resolvePlayScenePurpose(input.purpose, {
      logicalStep: logicalTime.step,
      selectionChanged: true,
      hadPreviousSelection: false,
    });
    if (!purpose) throw new Error(`Scene request '${input.purpose}' did not resolve to a narration purpose.`);
    const resolvedInput: ResolvedSceneNarrationRequest = { ...input, purpose };
    const recorder = await TraceRecorder.start(this.traces, {
      kind: "scene-narration",
      sourceId: session.sourceId,
      branchId: session.branchId,
      playSessionId: session.id,
      actorId: session.actorId,
      previousHead: input.expectedHead,
      storyTimeBefore,
    });
    try {
      const accepted = this.options.operations.start({
        kind: "scene-narration",
        scopeId: session.id,
        clientRequestId: input.clientRequestId,
        request: input,
        runId: recorder.manifest.id,
        run: (context) => this.runWithTrace(
          recorder,
          session.branchId,
          context,
          () => this.runSceneNarration(session.id, resolvedInput, context, recorder),
        ),
      });
      if (accepted.reused) {
        await recorder.finish("cancelled", {}, {
          code: "IDEMPOTENT_OPERATION_REUSED",
          message: "A concurrent request reused an existing operation; this unused trace was closed without executing.",
          retryable: false,
        });
        return accepted;
      }
      await recorder.link({ operationId: accepted.operation.id });
      return accepted;
    } catch (error) {
      await recorder.finish("failed", {}, traceError(error, "failed")).catch(() => undefined);
      throw error;
    }
  }

  async startNarrationRetry(sessionId: string, inputValue: NarrationRetryRequest): Promise<OperationAccepted> {
    const input = narrationRetryRequestSchema.parse(inputValue);
    const existing = this.options.operations.findByClientRequest("narration-retry", sessionId, input.clientRequestId);
    if (existing) {
      return this.options.operations.start({
        kind: "narration-retry",
        scopeId: sessionId,
        clientRequestId: input.clientRequestId,
        request: input,
        run: async () => { throw new Error("An idempotent operation must not be executed twice."); },
      });
    }
    const session = await this.requireWritableSession(sessionId);
    await this.assertExpectedHead(session, input.expectedHead);
    this.assertNoActiveOperation(session.id);
    const sourceRun = await this.requireNarrationRetrySource(session, input);
    const storyTimeBefore = await this.storyTimeAt(input.expectedHead);
    const recorder = await TraceRecorder.start(this.traces, {
      kind: "narration-retry",
      sourceId: session.sourceId,
      branchId: session.branchId,
      playSessionId: session.id,
      playerMoveId: sourceRun.playerMoveId,
      actorId: session.actorId,
      previousHead: input.expectedHead,
      storyTimeBefore,
    });
    try {
      const accepted = this.options.operations.start({
        kind: "narration-retry",
        scopeId: session.id,
        clientRequestId: input.clientRequestId,
        request: input,
        runId: recorder.manifest.id,
        run: (context) => this.runWithTrace(
          recorder,
          session.branchId,
          context,
          () => this.runNarrationRetry(session.id, input, sourceRun, context, recorder),
        ),
      });
      if (accepted.reused) {
        await recorder.finish("cancelled", {}, {
          code: "IDEMPOTENT_OPERATION_REUSED",
          message: "A concurrent request reused an existing operation; this unused trace was closed without executing.",
          retryable: false,
        });
        return accepted;
      }
      await recorder.link({ operationId: accepted.operation.id });
      return accepted;
    } catch (error) {
      await recorder.finish("failed", {}, traceError(error, "failed")).catch(() => undefined);
      throw error;
    }
  }

  private async runPlayerMove(
    sessionId: string,
    input: PlayMoveRequest,
    context: OperationRunContext,
    recorder: TraceRecorder,
    playerMoveId: string,
  ): Promise<PlayOperationResult> {
    const session = await this.requireWritableSession(sessionId);
    await this.assertExpectedHead(session, input.expectedHead);
    await this.sessions.activate(session.id);
    const turnTrace = await recorder.child(recorder.rootContext, "Resolve player move", "player-move-orchestration");
    let turnTraceFinished = false;
    try {
      const adapters = await this.adapters(context, turnTrace);
      let commitBoundaryCrossed = false;
      context.update("translating", { statusText: "正在理解你的行动…" });
      let outcome: PlayTurnOutcome;
      try {
        outcome = await performPlayTurn({
          root: this.root,
          branchId: session.branchId,
          actorId: session.actorId,
          sessionId: session.id,
          conversationId: session.conversationId,
          ...(session.sourceId ? { sourceId: session.sourceId } : {}),
          utterance: input.text,
          expectedHead: input.expectedHead,
          translator: adapters.translator,
          ...(adapters.adjudicator ? { adjudicator: adapters.adjudicator } : {}),
          ...(adapters.contextResolver ? { contextResolver: adapters.contextResolver } : {}),
          contextObserver: {
            onGapDetected: async (need) => {
              await recorder.record("context.gap.detected", {
                needId: need.id,
                requestedBy: need.requestedBy,
                domain: need.domain,
                issueCodes: need.issueCodes,
              }, turnTrace);
            },
            onSupplementValidated: async (result) => {
              await recorder.record("context.supplement.validated", {
                needId: result.record.need.id,
                status: result.record.status,
                retryRecommended: result.record.retryRecommended,
                evidenceCount: result.record.evidenceRefs.length,
                artifactCount: result.record.artifactRefs.length,
                repairHintCount: result.repairHints.length,
              }, turnTrace);
            },
          },
          ...(adapters.worldResponseResolver ? { worldResponseResolver: adapters.worldResponseResolver } : {}),
          ...(adapters.canonicalAttachmentResolver ? { canonicalAttachmentResolver: adapters.canonicalAttachmentResolver } : {}),
          ...(adapters.npcResponseReasoner ? { npcResponseReasoner: adapters.npcResponseReasoner } : {}),
          advanceBackground: this.options.advanceBackground ?? 0,
          origin: "web",
          runId: recorder.manifest.id,
          playerMoveId,
          ...(input.intent ? { intent: input.intent } : {}),
          ...(input.affordanceId ? { affordanceId: input.affordanceId } : {}),
          beforeCommit: async () => {
            context.signal.throwIfAborted();
            await recorder.record("world.commit.started", {
              kind: "player-action",
              previousHead: input.expectedHead,
            }, turnTrace, { storyTime: recorder.manifest.storyTimeBefore });
            context.signal.throwIfAborted();
            commitBoundaryCrossed = true;
            context.markCommitBoundary({ previousHead: input.expectedHead });
          },
        });
      } catch (error) {
        if (commitBoundaryCrossed) {
          await recorder.record("world.commit.failed", {
            kind: "player-action",
            previousHead: input.expectedHead,
            error: errorMessage(error),
          }, turnTrace).catch(() => undefined);
        }
        await recorder.failStage(turnTrace, error);
        turnTraceFinished = true;
        throw error;
      }
      const validationRef = await recorder.putBlob({
        accepted: outcome.result.accepted,
        stage: outcome.result.stage,
        issues: outcome.result.issues,
        intendedCandidate: outcome.result.intendedCandidate,
        candidate: outcome.result.candidate,
        adjudication: outcome.result.adjudication,
        proposal: outcome.result.proposal,
        validation: outcome.result.validation,
        contextConsultations: outcome.result.contextConsultations,
        repairHintIds: outcome.repairHintIds,
        repairHintError: outcome.repairHintError,
      });
      await recorder.record("validation.completed", {
        accepted: outcome.result.accepted,
        stage: outcome.result.stage,
        issueCount: outcome.result.issues.length,
      }, turnTrace, { blobRef: validationRef });
      const storyTimeAfter = await this.storyTimeAt(outcome.finalHead);
      if (commitBoundaryCrossed) {
        await recorder.record(outcome.result.accepted ? "world.commit.completed" : "world.commit.failed", {
          kind: "player-action",
          accepted: outcome.result.accepted,
          previousHead: outcome.result.previousHead,
          finalHead: outcome.finalHead,
          eventHash: outcome.result.eventHash,
          relatedEventHashes: [
            ...outcome.reactionEvents.map((event) => event.eventHash),
            ...outcome.worldResponseEvents.map((event) => event.eventHash),
            ...outcome.canonicalRecoveryEvents.map((event) => event.eventHash),
            ...outcome.backgroundEvents.map((event) => event.eventHash),
          ],
        }, turnTrace, { storyTime: storyTimeAfter });
      }
      if (outcome.playerMessage) this.publishMessage(session.id, outcome.playerMessage, context.operationId, recorder.manifest.id);
      context.update("world-resolved", {
        accepted: outcome.result.accepted,
        finalHead: outcome.finalHead,
        logicalStep: outcome.logicalStep,
      });

      let narrationStatus: PlayOperationResult["narrationStatus"] = "skipped";
      let narration: string | undefined;
      let narrationError: string | undefined;
      let choices: PlayerChoiceSummary[] = [];
      let narrationMessage: PlayConversationMessage | undefined;
      if (!context.signal.aborted) {
        const purpose: PlayScenePurpose = outcome.result.accepted ? "turn" : "recovery";
        const turnResolution: PlayerTurnResolution | undefined = outcome.result.accepted ? undefined : {
          kind: "unresolved",
          utterance: input.text,
          actorVisibleSummary: "这项请求没有成为世界事件；角色没有执行它，当前世界仍处于请求之前的已提交时刻。",
        };
        try {
          const rendered = await this.narrate(
            session,
            purpose,
            context,
            adapters.narrator,
            recorder,
            turnTrace,
            playerMoveId,
            turnResolution,
            outcome.result.contextSupplement,
          );
          narrationStatus = "rendered";
          narration = rendered.narration;
          narrationMessage = rendered.message;
          choices = rendered.choices;
        } catch (error) {
          if (context.signal.aborted && commitBoundaryCrossed) {
            narrationStatus = "skipped";
            narrationError = "Narration was stopped after the world commit; committed world truth was preserved.";
          } else if (context.signal.aborted) {
            throw error;
          } else {
            narrationStatus = "failed";
            narrationError = errorMessage(error);
          }
        }
      } else if (commitBoundaryCrossed) {
        narrationError = "Narration was skipped after the world commit because Stop was requested.";
      }

      const presentationMessageIds = [outcome.playerMessage?.id, narrationMessage?.id]
        .filter((id): id is string => Boolean(id));
      await recorder.link({
        finalHead: outcome.finalHead,
        ...(outcome.result.eventHash ? { eventHash: outcome.result.eventHash } : {}),
        ...(outcome.auditId ? { auditId: outcome.auditId } : {}),
        presentationMessageIds,
        storyTimeAfter,
      });
      await recorder.finishStage(turnTrace, {
        status: context.signal.aborted && commitBoundaryCrossed ? "narration-interrupted" : "completed",
        accepted: outcome.result.accepted,
        narrationStatus,
      });
      turnTraceFinished = true;
      this.invalidateCatalog("player-move-completed", session.id, context.operationId, recorder.manifest.id);
      const result = playOperationResultSchema.parse({
        sessionId: session.id,
        branchId: session.branchId,
        actorId: session.actorId,
        runId: recorder.manifest.id,
        playerMoveId,
        accepted: outcome.result.accepted,
        stage: outcome.result.stage,
        previousHead: outcome.result.previousHead,
        finalHead: outcome.finalHead,
        logicalStep: outcome.logicalStep,
        narrationStatus,
        ...(narration ? { narration } : {}),
        ...(narrationError ? { narrationError } : {}),
        warnings: playWarnings(outcome),
        choices,
        issues: outcome.result.issues,
        ...(outcome.auditId ? { auditId: outcome.auditId } : {}),
        ...(outcome.result.eventHash ? { eventHash: outcome.result.eventHash } : {}),
        worldResponseEvents: outcome.worldResponseEvents,
        reactionEvents: outcome.reactionEvents,
        backgroundEvents: outcome.backgroundEvents,
      });
      return result;
    } catch (error) {
      if (!turnTraceFinished) await recorder.failStage(turnTrace, error);
      throw error;
    }
  }

  private async runSceneNarration(
    sessionId: string,
    input: ResolvedSceneNarrationRequest,
    context: OperationRunContext,
    recorder: TraceRecorder,
  ): Promise<SceneNarrationResult> {
    const session = await this.requireWritableSession(sessionId);
    await this.assertExpectedHead(session, input.expectedHead);
    await this.sessions.activate(session.id);
    const narrationTrace = await recorder.child(recorder.rootContext, "Render scene narration", "narration-orchestration");
    const adapters = await this.adapters(context, narrationTrace);
    let rendered: NarrationOutcome;
    try {
      rendered = await this.narrate(session, input.purpose, context, adapters.narrator, recorder, narrationTrace);
      await recorder.finishStage(narrationTrace, { status: "completed", purpose: input.purpose });
    } catch (error) {
      await recorder.failStage(narrationTrace, error);
      throw error;
    }
    await recorder.link({
      finalHead: input.expectedHead,
      presentationMessageIds: [rendered.message.id],
      storyTimeAfter: await this.storyTimeAt(input.expectedHead),
    });
    this.invalidateCatalog("scene-narration-completed", session.id, context.operationId, recorder.manifest.id);
    return sceneNarrationResultSchema.parse({
      sessionId: session.id,
      branchId: session.branchId,
      actorId: session.actorId,
      runId: recorder.manifest.id,
      headCommitId: input.expectedHead,
      purpose: input.purpose,
      narrationStatus: "rendered",
      narration: rendered.narration,
      choices: rendered.choices,
    });
  }

  private async runNarrationRetry(
    sessionId: string,
    input: NarrationRetryRequest,
    sourceRun: TraceRunManifest,
    context: OperationRunContext,
    recorder: TraceRecorder,
  ): Promise<NarrationRetryResult> {
    const session = await this.requireWritableSession(sessionId);
    await this.assertExpectedHead(session, input.expectedHead);
    await this.requireNarrationRetrySource(session, input);
    await this.sessions.activate(session.id);
    const narrationTrace = await recorder.child(recorder.rootContext, "Retry narration only", "narration-retry");
    await recorder.record("validation.completed", {
      kind: "narration-retry-eligibility",
      sourceRunId: sourceRun.id,
      playerMoveId: sourceRun.playerMoveId,
      committedHead: sourceRun.finalHead,
      worldMutationAllowed: false,
    }, narrationTrace, { storyTime: recorder.manifest.storyTimeBefore });
    const adapters = await this.adapters(context, narrationTrace);
    let rendered: NarrationOutcome;
    try {
      rendered = await this.narrate(
        session,
        "turn",
        context,
        adapters.narrator,
        recorder,
        narrationTrace,
        sourceRun.playerMoveId,
      );
      await recorder.finishStage(narrationTrace, {
        status: "completed",
        sourceRunId: sourceRun.id,
        worldMutationPerformed: false,
      });
    } catch (error) {
      await recorder.failStage(narrationTrace, error);
      throw error;
    }
    await recorder.link({
      finalHead: input.expectedHead,
      presentationMessageIds: [rendered.message.id],
      storyTimeAfter: await this.storyTimeAt(input.expectedHead),
    });
    this.invalidateCatalog("narration-retry-completed", session.id, context.operationId, recorder.manifest.id);
    return narrationRetryResultSchema.parse({
      sessionId: session.id,
      branchId: session.branchId,
      actorId: session.actorId,
      runId: recorder.manifest.id,
      sourceRunId: sourceRun.id,
      playerMoveId: sourceRun.playerMoveId,
      headCommitId: input.expectedHead,
      narrationStatus: "rendered",
      narration: rendered.narration,
      choices: rendered.choices,
    });
  }

  private async narrate(
    session: ActivePlaySession,
    purpose: PlayScenePurpose,
    context: OperationRunContext,
    narrator: PlayerOpeningNarrator,
    recorder: TraceRecorder,
    traceContext: TraceContext,
    playerMoveId?: string,
    turnResolution?: PlayerTurnResolution,
    runtimeContext?: RuntimeContextSupplement,
  ): Promise<NarrationOutcome> {
    context.signal.throwIfAborted();
    context.update("building-scene", { purpose });
    let frame: PlayOpeningFrame = await buildPlayOpeningFrame(
      this.root,
      session.branchId,
      session.actorId,
      session.sourceId,
      session.conversationId,
      this.options.preparedCacheRoot,
    );
    if (turnResolution) frame = { ...frame, turnResolution: structuredClone(turnResolution) };
    const projectedRuntimeContext = playerRuntimeContextFrame(runtimeContext);
    if (projectedRuntimeContext) {
      frame = {
        ...frame,
        runtimeContext: projectedRuntimeContext,
      };
    }
    context.update("narrating", { purpose });
    try {
      const output = await narrator(
        playerSceneModelFrame(frame, purpose),
        purpose,
        {
          signal: context.signal,
          onAttempt: (attempt) => context.update("narrating", { purpose, attempt }),
          onRetry: (message) => context.update("narration-retry", { purpose, statusText: message }),
          onText: (delta) => this.options.events.publish("play.narration.delta", {
            sessionId: session.id,
            branchId: session.branchId,
            delta,
          }, { operationId: context.operationId, runId: recorder.manifest.id }),
        },
        modelPlayConversation(frame.messageHistory),
      );
      context.signal.throwIfAborted();
      const narration = assertPlaySceneNarration(
        typeof output === "string" ? output : output.narration,
        { frame: playerSceneModelFrame(frame, purpose), purpose },
      );
      const narratedChoices = typeof output === "string"
        ? []
        : parsedNarratedChoices(output.choices);
      const hostChoices: PlayerChoiceSummary[] = frame.affordances.map((affordance) => ({
        action: affordance.action,
        affordanceId: affordance.id,
      }));
      const choices = mergeChoices(hostChoices, narratedChoices);
      const message = await this.conversations.append({
        branchId: session.branchId,
        conversationId: session.conversationId,
        actorId: session.actorId,
        atCommit: frame.commitId,
        role: "scene",
        status: "rendered",
        text: narration,
        runId: recorder.manifest.id,
        ...(playerMoveId ? { playerMoveId } : {}),
      });
      const { version: _version, ...messageSummary } = message;
      const messageRef = await recorder.putBlob(messageSummary);
      await recorder.record("presentation.message.appended", {
        messageId: message.id,
        role: message.role,
        status: message.status,
        atCommit: message.atCommit,
      }, traceContext, { blobRef: messageRef });
      this.publishMessage(session.id, message, context.operationId, recorder.manifest.id);
      this.options.events.publish("play.narration.completed", {
        sessionId: session.id,
        branchId: session.branchId,
        headCommitId: frame.commitId,
        purpose,
        narration,
        choices,
      }, { operationId: context.operationId, runId: recorder.manifest.id });
      return { narration, choices, message };
    } catch (error) {
      this.options.events.publish("play.narration.completed", {
        sessionId: session.id,
        branchId: session.branchId,
        purpose,
        status: context.signal.aborted ? "skipped" : "failed",
        error: errorMessage(error),
      }, { operationId: context.operationId, runId: recorder.manifest.id });
      throw error;
    }
  }

  private async adapters(context: OperationRunContext, trace: TraceContext): Promise<{
    translator: PlayerActionTranslator;
    adjudicator?: PlayerWorldAdjudicator;
    contextResolver?: RuntimeContextResolver;
    worldResponseResolver?: PlayerWorldResponseResolver;
    canonicalAttachmentResolver?: CanonicalAttachmentResolver;
    npcResponseReasoner?: NpcReactionReasoner;
    narrator: PlayerOpeningNarrator;
  }> {
    const profiles = await this.profiles(["player-action", "adjudicator", "specialist", "npc", "narrator"]);
    const onStatus = (statusText: string) => context.update("model-working", { statusText });
    const common = (profile: LlmProfile | undefined) => ({
      root: this.root,
      ...(profile ? { profile } : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      signal: context.signal,
      onStatus,
      trace,
    });
    const usePiTurnAdapters = !this.options.translator;
    return {
      translator: this.options.translator ?? createPiPlayerActionTranslator(common(profiles.get("player-action"))),
      ...(this.options.adjudicator
        ? { adjudicator: this.options.adjudicator }
        : usePiTurnAdapters ? { adjudicator: createPiPlayerWorldAdjudicator(common(profiles.get("adjudicator"))) } : {}),
      ...(this.options.contextResolver
        ? { contextResolver: this.options.contextResolver }
        : usePiTurnAdapters ? {
            contextResolver: createPiRuntimeContextResolver({
              ...common(profiles.get("specialist")),
              ...(this.options.preparedCacheRoot ? { preparedCacheRoot: this.options.preparedCacheRoot } : {}),
            }),
          } : {}),
      ...(this.options.worldResponseResolver
        ? { worldResponseResolver: this.options.worldResponseResolver }
        : usePiTurnAdapters ? { worldResponseResolver: createPiPlayerWorldResponseResolver(common(profiles.get("specialist"))) } : {}),
      ...(this.options.canonicalAttachmentResolver
        ? { canonicalAttachmentResolver: this.options.canonicalAttachmentResolver }
        : usePiTurnAdapters ? { canonicalAttachmentResolver: createPiCanonicalAttachmentResolver(common(profiles.get("specialist"))) } : {}),
      ...(this.options.npcResponseReasoner
        ? { npcResponseReasoner: this.options.npcResponseReasoner }
        : usePiTurnAdapters ? { npcResponseReasoner: createPiNpcReactionReasoner(common(profiles.get("npc"))) } : {}),
      narrator: this.options.narrator ?? createPiPlayerOpeningNarrator({
        root: this.root,
        ...(profiles.get("narrator") ? { profile: profiles.get("narrator") } : {}),
        ...(this.options.model ? { model: this.options.model } : {}),
        trace,
      }),
    };
  }

  private async profiles(roles: string[]): Promise<Map<string, LlmProfile | undefined>> {
    const config = await loadOptionalConfig(this.options.configPath ?? path.join(this.root, "novel-harness.yaml"));
    return new Map(roles.map((role) => [role, config ? profileForRole(config, role).profile : undefined]));
  }

  private async storyTimeAt(commitId: string): Promise<{ commitId: string; logicalTime: unknown }> {
    const { engine } = await openWorkspaceWorld(this.root);
    const commit = await engine.objects.getCommit(commitId);
    return { commitId, logicalTime: structuredClone(commit.logicalTime) };
  }

  private async requireSession(sessionId: string): Promise<ActivePlaySession> {
    const session = await this.sessions.getById(sessionId);
    if (!session) throw this.sessionNotFound(sessionId);
    return session;
  }

  private async requireWritableSession(sessionId: string): Promise<ActivePlaySession> {
    const session = await this.requireSession(sessionId);
    if (session.status === "archived") {
      throw webError(409, "PLAY_SESSION_ARCHIVED", `Play session '${session.id}' is archived. Restore it before continuing.`, {
        kind: "after-user-action",
        discoveryEndpoint: `/api/v1/play-sessions/${encodeURIComponent(session.id)}/restore`,
        copyField: "session.id",
        maxAttempts: 1,
      });
    }
    if (session.status === "detached") {
      throw webError(409, "PLAY_SESSION_DETACHED", `Play session '${session.id}' has no writable world instance.`, { kind: "none" });
    }
    return session;
  }

  private sessionNotFound(sessionId: string) {
    return webError(404, "PLAY_SESSION_NOT_FOUND", `Unknown play session '${sessionId}'.`, {
      kind: "after-refresh",
      discoveryEndpoint: "/api/v1/play-sessions",
      copyField: "id",
      maxAttempts: 1,
    });
  }

  private sourceNotFound(sourceId: string) {
    return webError(404, "SOURCE_NOT_FOUND", `Unknown novel source '${sourceId}'.`, {
      kind: "after-refresh",
      discoveryEndpoint: "/api/v1/novels",
      copyField: "id",
      maxAttempts: 1,
    });
  }

  private async assertExpectedHead(session: ActivePlaySession, expectedHead: string): Promise<void> {
    const actualHead = await this.branches.readHead(session.branchId);
    if (actualHead !== expectedHead) {
      throw webError(409, "BRANCH_HEAD_MOVED", `Play session '${session.id}' expected head '${expectedHead}', but the world is at '${actualHead}'.`, {
        kind: "after-refresh",
        discoveryEndpoint: `/api/v1/play-sessions/${encodeURIComponent(session.id)}`,
        copyField: "headCommitId",
        maxAttempts: 1,
      }, { expectedHead, actualHead });
    }
  }

  private assertNoActiveOperation(sessionId: string): void {
    const active = this.options.operations.list().find((operation) =>
      operation.scopeId === sessionId
      && operation.status !== "succeeded"
      && operation.status !== "failed"
      && operation.status !== "cancelled"
      && operation.status !== "interrupted");
    if (!active) return;
    throw webError(409, "PLAY_OPERATION_ACTIVE", `Operation '${active.id}' is already changing play session '${sessionId}'.`, {
      kind: "after-refresh",
      discoveryEndpoint: `/api/v1/operations/${encodeURIComponent(active.id)}`,
      copyField: "id",
      maxAttempts: 1,
    });
  }

  private async requireNarrationRetrySource(
    session: ActivePlaySession,
    input: NarrationRetryRequest,
  ): Promise<TraceRunManifest> {
    let sourceRun: TraceRunManifest;
    try {
      sourceRun = await this.traces.getRun(input.sourceRunId);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Unknown trace run")) {
        throw webError(404, "TRACE_RUN_NOT_FOUND", `Unknown source run '${input.sourceRunId}'.`, {
          kind: "after-refresh",
          discoveryEndpoint: `/api/v1/runs?sessionId=${encodeURIComponent(session.id)}&kind=player-move`,
          copyField: "id",
          maxAttempts: 1,
        });
      }
      throw error;
    }
    if (sourceRun.kind !== "player-move" || sourceRun.playSessionId !== session.id || sourceRun.branchId !== session.branchId) {
      throw webError(409, "NARRATION_RETRY_SOURCE_SCOPE_MISMATCH", `Run '${sourceRun.id}' is not a player move from this play session and branch.`, {
        kind: "after-user-action",
        discoveryEndpoint: `/api/v1/runs?sessionId=${encodeURIComponent(session.id)}&kind=player-move`,
        copyField: "id",
        maxAttempts: 1,
      });
    }
    if (!sourceRun.playerMoveId || !sourceRun.finalHead) {
      throw webError(409, "NARRATION_RETRY_SOURCE_INCOMPLETE", `Run '${sourceRun.id}' does not contain a committed move identity and final head. Do not retry it as narration.`, { kind: "none" });
    }
    if (sourceRun.finalHead !== input.expectedHead) {
      throw webError(409, "NARRATION_RETRY_HEAD_MISMATCH", `Run '${sourceRun.id}' committed at '${sourceRun.finalHead}', but the selected branch head is '${input.expectedHead}'.`, {
        kind: "after-refresh",
        discoveryEndpoint: `/api/v1/play-sessions/${encodeURIComponent(session.id)}`,
        copyField: "headCommitId",
        maxAttempts: 1,
      });
    }
    const events = await this.traces.readEvents(sourceRun.id);
    const committed = traceProvesCommittedPlayerMove(sourceRun, events);
    if (!committed) {
      throw webError(409, "NARRATION_RETRY_WORLD_NOT_COMMITTED", `Run '${sourceRun.id}' has no accepted world commit. Narration retry cannot be used to replay or manufacture a move.`, { kind: "none" });
    }
    const existingNarration = (await this.conversations.list(session.branchId, session.conversationId)).find((message) =>
      message.playerMoveId === sourceRun.playerMoveId
      && message.role === "scene"
      && message.status === "rendered");
    if (existingNarration) {
      throw webError(409, "NARRATION_ALREADY_RENDERED", `Player move '${sourceRun.playerMoveId}' already has rendered presentation '${existingNarration.id}'.`, { kind: "none" });
    }
    return sourceRun;
  }

  private async readHeadOrNull(branchId: string): Promise<string | null> {
    try {
      return await this.branches.readHead(branchId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private publishMessage(sessionId: string, message: PlayConversationMessage, operationId: string, runId?: string): void {
    const { version: _version, ...data } = message;
    this.options.events.publish("play.message.appended", { sessionId, message: data }, {
      operationId,
      ...(runId ? { runId } : {}),
    });
  }

  private invalidateCatalog(reason: string, sessionId: string, operationId?: string, runId?: string): void {
    this.options.events.publish("catalog.invalidated", { reason, sessionId }, {
      ...(operationId ? { operationId } : {}),
      ...(runId ? { runId } : {}),
    });
  }

  private async runWithTrace<T>(
    recorder: TraceRecorder,
    branchId: string,
    context: OperationRunContext,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await run();
      const status: Exclude<TraceRunStatus, "running"> = context.signal.aborted
        ? context.commitBoundaryCrossed ? "interrupted" : "cancelled"
        : "succeeded";
      const finalHead = await this.readHeadOrNull(branchId);
      if (finalHead) await recorder.link({ finalHead });
      await recorder.finish(
        status,
        {},
        status === "succeeded" ? undefined : traceError(
          new Error(context.commitBoundaryCrossed
            ? "Stop was requested after the world commit boundary; committed truth was preserved."
            : "The operation was cancelled before its commit boundary."),
          status,
        ),
      );
      return result;
    } catch (error) {
      const status: Exclude<TraceRunStatus, "running"> = context.signal.aborted
        ? context.commitBoundaryCrossed ? "interrupted" : "cancelled"
        : "failed";
      try {
        const finalHead = await this.readHeadOrNull(branchId);
        if (finalHead) await recorder.link({ finalHead });
        await recorder.finish(status, {}, traceError(error, status));
      } catch (traceFailure) {
        throw new AggregateError([error, traceFailure], "The operation failed and its trace could not be finalized.");
      }
      throw error;
    }
  }
}

function parsedNarratedChoices(choices: readonly PlayerSceneChoice[]): PlayerChoiceSummary[] {
  const parsed = playerSceneChoicesSchema.safeParse({ choices });
  return parsed.success ? structuredClone(parsed.data.choices) : [];
}

function mergeChoices(
  hostChoices: readonly PlayerChoiceSummary[],
  narratedChoices: readonly PlayerChoiceSummary[],
): PlayerChoiceSummary[] {
  const result: PlayerChoiceSummary[] = [];
  const seen = new Set<string>();
  const add = (choice: PlayerChoiceSummary | undefined) => {
    if (!choice || result.length >= 4) return;
    const key = choice.action.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(structuredClone(choice));
  };
  add(hostChoices[0]);
  narratedChoices.forEach(add);
  hostChoices.slice(1).forEach(add);
  return result;
}

function playWarnings(outcome: PlayTurnOutcome): string[] {
  return [
    outcome.worldResponseError,
    outcome.canonicalRecoveryError,
    outcome.npcResponseError,
    outcome.backgroundError,
    outcome.conversationError,
    outcome.auditError,
    outcome.repairHintError,
  ].filter((value): value is string => Boolean(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function entryNarrationClientRequestId(sessionId: string, headCommitId: string): string {
  const direct = `auto-entry-${sessionId}-${headCommitId}`;
  if (direct.length <= 200) return direct;
  return `auto-entry-${crypto.createHash("sha256").update(`${sessionId}:${headCommitId}`).digest("hex")}`;
}

function operationIsTerminal(status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted"): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function traceError(error: unknown, status: Exclude<TraceRunStatus, "running">): TraceErrorSummary {
  return {
    code: status === "cancelled"
      ? "OPERATION_CANCELLED_BEFORE_COMMIT"
      : status === "interrupted"
        ? "OPERATION_INTERRUPTED_AFTER_COMMIT"
        : "OPERATION_FAILED",
    message: errorMessage(error),
    retryable: status === "cancelled",
  };
}

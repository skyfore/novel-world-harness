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
import { playerSceneChoicesSchema, type PlayerSceneChoice } from "../agent/player-scene-choice-tool.js";
import { loadOptionalConfig, profileForRole } from "../config/load.js";
import type { LlmProfile } from "../config/schema.js";
import type { CanonicalAttachmentResolver } from "../world/canonical-adaptation.js";
import type { NpcReactionReasoner } from "../world/npc-reaction.js";
import {
  type PlayerActionTranslator,
  type PlayerWorldAdjudicator,
} from "../world/player-action.js";
import {
  PlayConversationStore,
  modelPlayConversation,
  type PlayConversationMessage,
} from "../world/play-conversation.js";
import {
  listPlayableCharacters,
  performPlayTurn,
  selectPlayExperience,
  type PlayTurnOutcome,
} from "../world/play-experience.js";
import {
  assertPlaySceneNarration,
  buildPlayOpeningFrame,
  playerSceneModelFrame,
  type PlayOpeningFrame,
  type PlayScenePurpose,
  type PlayerTurnResolution,
} from "../world/play-opening.js";
import { PlaySessionStore, type ActivePlaySession } from "../world/play-session.js";
import type { PlayerWorldResponseResolver } from "../world/runtime.js";
import { BranchStore } from "../world/store.js";
import {
  clearPlayConversationResultSchema,
  createPlaySessionRequestSchema,
  playableCharacterListSchema,
  playMoveRequestSchema,
  playOperationResultSchema,
  playSessionDetailSchema,
  removePlaySessionResultSchema,
  sceneNarrationRequestSchema,
  sceneNarrationResultSchema,
  updatePlaySessionRequestSchema,
  type ClearPlayConversationResult,
  type CreatePlaySessionRequest,
  type OperationAccepted,
  type PlayableCharacterList,
  type PlayMoveRequest,
  type PlayOperationResult,
  type PlaySessionDetail,
  type PlayerChoiceSummary,
  type RemovePlaySessionResult,
  type SceneNarrationRequest,
  type SceneNarrationResult,
  type UpdatePlaySessionRequest,
} from "../web/contracts.js";
import { WebEventBroker } from "../web/event-stream.js";
import { webError } from "../web/errors.js";
import { OperationManager, type OperationRunContext } from "../web/operation-manager.js";
import { CatalogService } from "./catalog-service.js";

export interface PlayApplicationServiceOptions {
  root: string;
  operations: OperationManager;
  events: WebEventBroker;
  configPath?: string;
  model?: string;
  translator?: PlayerActionTranslator;
  adjudicator?: PlayerWorldAdjudicator;
  worldResponseResolver?: PlayerWorldResponseResolver;
  canonicalAttachmentResolver?: CanonicalAttachmentResolver;
  npcResponseReasoner?: NpcReactionReasoner;
  narrator?: PlayerOpeningNarrator;
  advanceBackground?: number;
}

type NarrationOutcome = {
  narration: string;
  choices: PlayerChoiceSummary[];
  message: PlayConversationMessage;
};

export class PlayApplicationService {
  readonly root: string;
  private readonly sessions: PlaySessionStore;
  private readonly conversations: PlayConversationStore;
  private readonly branches: BranchStore;
  private readonly catalog: CatalogService;
  private readonly sessionRequests = new Map<string, { fingerprint: string; sessionId: string }>();
  private profilePromise?: Promise<LlmProfile | undefined>;

  constructor(private readonly options: PlayApplicationServiceOptions) {
    this.root = path.resolve(options.root);
    this.sessions = new PlaySessionStore(this.root);
    this.conversations = new PlayConversationStore(this.root);
    this.branches = new BranchStore(this.root);
    this.catalog = new CatalogService(this.root);
  }

  async listCharacters(branchId: string, sourceId?: string): Promise<PlayableCharacterList> {
    const listed = await listPlayableCharacters(this.root, {
      branchId,
      ...(sourceId ? { source: sourceId } : {}),
    });
    return playableCharacterListSchema.parse({
      branchId: listed.branchId,
      ...(listed.source ? { sourceId: listed.source.id, sourceTitle: listed.source.title } : {}),
      characters: listed.characters,
    });
  }

  async createSession(inputValue: CreatePlaySessionRequest): Promise<PlaySessionDetail> {
    const input = createPlaySessionRequestSchema.parse(inputValue);
    const requestKey = `${input.branchId}:${input.clientRequestId}`;
    const fingerprint = JSON.stringify(input);
    const previous = this.sessionRequests.get(requestKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw webError(409, "IDEMPOTENCY_CONFLICT", `Client request '${input.clientRequestId}' was already used with different input.`, { kind: "none" });
      }
      return this.getSession(previous.sessionId);
    }

    const existing = await this.sessions.readInstance(input.branchId);
    let selection;
    try {
      selection = await selectPlayExperience(this.root, {
        branchId: input.branchId,
        character: input.actorId,
        ...(input.sourceId ? { source: input.sourceId } : {}),
      });
    } catch (error) {
      throw webError(400, "PLAY_SESSION_SELECTION_FAILED", errorMessage(error), {
        kind: "after-refresh",
        discoveryEndpoint: `/api/v1/instances/${encodeURIComponent(input.branchId)}/characters`,
        copyField: "characters[].id",
        maxAttempts: 1,
      });
    }
    const title = input.title ?? existing?.title ?? `${selection.actor.canonicalName} · ${selection.branchName}`;
    if (selection.session.title !== title) {
      await this.sessions.updateMetadata(selection.session.id, { title });
    }
    this.sessionRequests.set(requestKey, { fingerprint, sessionId: selection.session.id });
    this.invalidateCatalog("play-session-created", selection.session.id);
    return this.getSession(selection.session.id);
  }

  async getSession(sessionId: string): Promise<PlaySessionDetail> {
    const session = await this.requireSession(sessionId);
    const [catalog, messages, headCommitId] = await Promise.all([
      this.catalog.read(),
      this.conversations.list(session.branchId),
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

  async activateSession(sessionId: string): Promise<PlaySessionDetail> {
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
    return this.getSession(session.id);
  }

  async updateSession(sessionId: string, inputValue: UpdatePlaySessionRequest): Promise<PlaySessionDetail> {
    const input = updatePlaySessionRequestSchema.parse(inputValue);
    const session = await this.requireSession(sessionId);
    this.assertNoActiveOperation(session.id);
    await this.sessions.updateMetadata(session.id, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    });
    this.invalidateCatalog("play-session-updated", session.id);
    return this.getSession(session.id);
  }

  async restoreSession(sessionId: string): Promise<PlaySessionDetail> {
    const session = await this.requireSession(sessionId);
    await this.sessions.restore(session.id);
    this.invalidateCatalog("play-session-restored", session.id);
    return this.getSession(session.id);
  }

  async clearConversation(sessionId: string): Promise<ClearPlayConversationResult> {
    const session = await this.requireSession(sessionId);
    this.assertNoActiveOperation(session.id);
    await this.conversations.remove(session.branchId);
    this.invalidateCatalog("play-conversation-cleared", session.id);
    return clearPlayConversationResultSchema.parse({
      sessionId: session.id,
      branchId: session.branchId,
      branchPreserved: true,
      cleared: true,
    });
  }

  async removeSession(sessionId: string): Promise<RemovePlaySessionResult> {
    const session = await this.requireSession(sessionId);
    this.assertNoActiveOperation(session.id);
    await this.sessions.removeSession(session.id);
    await this.conversations.remove(session.branchId);
    this.invalidateCatalog("play-session-removed", session.id);
    return removePlaySessionResultSchema.parse({
      sessionId: session.id,
      branchId: session.branchId,
      branchPreserved: true,
      conversationRemoved: true,
    });
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
    return this.options.operations.start({
      kind: "player-move",
      scopeId: session.id,
      clientRequestId: input.clientRequestId,
      request: input,
      run: (context) => this.runPlayerMove(session.id, input, context),
    });
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
    return this.options.operations.start({
      kind: "scene-narration",
      scopeId: session.id,
      clientRequestId: input.clientRequestId,
      request: input,
      run: (context) => this.runSceneNarration(session.id, input, context),
    });
  }

  private async runPlayerMove(
    sessionId: string,
    input: PlayMoveRequest,
    context: OperationRunContext,
  ): Promise<PlayOperationResult> {
    const session = await this.requireWritableSession(sessionId);
    await this.assertExpectedHead(session, input.expectedHead);
    await this.sessions.activate(session.id);
    const adapters = await this.adapters(context);
    let commitBoundaryCrossed = false;
    context.update("translating", { statusText: "正在理解你的行动…" });
    const outcome = await performPlayTurn({
      root: this.root,
      branchId: session.branchId,
      actorId: session.actorId,
      utterance: input.text,
      expectedHead: input.expectedHead,
      translator: adapters.translator,
      ...(adapters.adjudicator ? { adjudicator: adapters.adjudicator } : {}),
      ...(adapters.worldResponseResolver ? { worldResponseResolver: adapters.worldResponseResolver } : {}),
      ...(adapters.canonicalAttachmentResolver ? { canonicalAttachmentResolver: adapters.canonicalAttachmentResolver } : {}),
      ...(adapters.npcResponseReasoner ? { npcResponseReasoner: adapters.npcResponseReasoner } : {}),
      advanceBackground: this.options.advanceBackground ?? 0,
      origin: "web",
      ...(input.intent ? { intent: input.intent } : {}),
      ...(input.affordanceId ? { affordanceId: input.affordanceId } : {}),
      beforeCommit: () => {
        context.signal.throwIfAborted();
        commitBoundaryCrossed = true;
        context.markCommitBoundary({ previousHead: input.expectedHead });
      },
    });
    if (outcome.playerMessage) this.publishMessage(session.id, outcome.playerMessage, context.operationId);
    context.update("world-resolved", {
      accepted: outcome.result.accepted,
      finalHead: outcome.finalHead,
      logicalStep: outcome.logicalStep,
    });

    let narrationStatus: PlayOperationResult["narrationStatus"] = "skipped";
    let narration: string | undefined;
    let narrationError: string | undefined;
    let choices: PlayerChoiceSummary[] = [];
    if (!context.signal.aborted) {
      const purpose: PlayScenePurpose = outcome.result.accepted ? "turn" : "recovery";
      const turnResolution: PlayerTurnResolution | undefined = outcome.result.accepted ? undefined : {
        kind: "unresolved",
        utterance: input.text,
        actorVisibleSummary: "这项请求没有成为世界事件；角色没有执行它，当前世界仍处于请求之前的已提交时刻。",
      };
      try {
        const rendered = await this.narrate(session, purpose, context, adapters.narrator, turnResolution);
        narrationStatus = "rendered";
        narration = rendered.narration;
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

    this.invalidateCatalog("player-move-completed", session.id, context.operationId);
    return playOperationResultSchema.parse({
      sessionId: session.id,
      branchId: session.branchId,
      actorId: session.actorId,
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
      worldResponseEvents: outcome.worldResponseEvents,
      reactionEvents: outcome.reactionEvents,
      backgroundEvents: outcome.backgroundEvents,
    });
  }

  private async runSceneNarration(
    sessionId: string,
    input: SceneNarrationRequest,
    context: OperationRunContext,
  ): Promise<SceneNarrationResult> {
    const session = await this.requireWritableSession(sessionId);
    await this.assertExpectedHead(session, input.expectedHead);
    await this.sessions.activate(session.id);
    const adapters = await this.adapters(context);
    const rendered = await this.narrate(session, input.purpose, context, adapters.narrator);
    this.invalidateCatalog("scene-narration-completed", session.id, context.operationId);
    return sceneNarrationResultSchema.parse({
      sessionId: session.id,
      branchId: session.branchId,
      actorId: session.actorId,
      headCommitId: input.expectedHead,
      purpose: input.purpose,
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
    turnResolution?: PlayerTurnResolution,
  ): Promise<NarrationOutcome> {
    context.signal.throwIfAborted();
    context.update("building-scene", { purpose });
    let frame: PlayOpeningFrame = await buildPlayOpeningFrame(
      this.root,
      session.branchId,
      session.actorId,
      session.sourceId,
    );
    if (turnResolution) frame = { ...frame, turnResolution: structuredClone(turnResolution) };
    context.update("narrating", { purpose });
    try {
      const output = await narrator(
        playerSceneModelFrame(frame),
        purpose,
        {
          signal: context.signal,
          onAttempt: (attempt) => context.update("narrating", { purpose, attempt }),
          onRetry: (message) => context.update("narration-retry", { purpose, statusText: message }),
          onText: (delta) => this.options.events.publish("play.narration.delta", {
            sessionId: session.id,
            branchId: session.branchId,
            delta,
          }, { operationId: context.operationId }),
        },
        modelPlayConversation(frame.messageHistory),
      );
      context.signal.throwIfAborted();
      const narration = assertPlaySceneNarration(
        typeof output === "string" ? output : output.narration,
        { frame: playerSceneModelFrame(frame), purpose },
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
        actorId: session.actorId,
        atCommit: frame.commitId,
        role: "scene",
        status: "rendered",
        text: narration,
      });
      this.publishMessage(session.id, message, context.operationId);
      this.options.events.publish("play.narration.completed", {
        sessionId: session.id,
        branchId: session.branchId,
        headCommitId: frame.commitId,
        purpose,
        narration,
        choices,
      }, { operationId: context.operationId });
      return { narration, choices, message };
    } catch (error) {
      this.options.events.publish("play.narration.completed", {
        sessionId: session.id,
        branchId: session.branchId,
        purpose,
        status: context.signal.aborted ? "skipped" : "failed",
        error: errorMessage(error),
      }, { operationId: context.operationId });
      throw error;
    }
  }

  private async adapters(context: OperationRunContext): Promise<{
    translator: PlayerActionTranslator;
    adjudicator?: PlayerWorldAdjudicator;
    worldResponseResolver?: PlayerWorldResponseResolver;
    canonicalAttachmentResolver?: CanonicalAttachmentResolver;
    npcResponseReasoner?: NpcReactionReasoner;
    narrator: PlayerOpeningNarrator;
  }> {
    const profile = await this.profile();
    const onStatus = (statusText: string) => context.update("model-working", { statusText });
    const common = {
      root: this.root,
      ...(profile ? { profile } : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      signal: context.signal,
      onStatus,
    };
    const usePiTurnAdapters = !this.options.translator;
    return {
      translator: this.options.translator ?? createPiPlayerActionTranslator(common),
      ...(this.options.adjudicator
        ? { adjudicator: this.options.adjudicator }
        : usePiTurnAdapters ? { adjudicator: createPiPlayerWorldAdjudicator(common) } : {}),
      ...(this.options.worldResponseResolver
        ? { worldResponseResolver: this.options.worldResponseResolver }
        : usePiTurnAdapters ? { worldResponseResolver: createPiPlayerWorldResponseResolver(common) } : {}),
      ...(this.options.canonicalAttachmentResolver
        ? { canonicalAttachmentResolver: this.options.canonicalAttachmentResolver }
        : usePiTurnAdapters ? { canonicalAttachmentResolver: createPiCanonicalAttachmentResolver(common) } : {}),
      ...(this.options.npcResponseReasoner
        ? { npcResponseReasoner: this.options.npcResponseReasoner }
        : usePiTurnAdapters ? { npcResponseReasoner: createPiNpcReactionReasoner(common) } : {}),
      narrator: this.options.narrator ?? createPiPlayerOpeningNarrator({
        root: this.root,
        ...(profile ? { profile } : {}),
        ...(this.options.model ? { model: this.options.model } : {}),
      }),
    };
  }

  private profile(): Promise<LlmProfile | undefined> {
    this.profilePromise ??= (async () => {
      const config = await loadOptionalConfig(this.options.configPath ?? path.join(this.root, "novel-harness.yaml"));
      return config ? profileForRole(config, "narrator").profile : undefined;
    })();
    return this.profilePromise;
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

  private async assertExpectedHead(session: ActivePlaySession, expectedHead: string): Promise<void> {
    const actualHead = await this.branches.readHead(session.branchId);
    if (actualHead !== expectedHead) {
      throw webError(409, "STALE_BRANCH_HEAD", `Play session '${session.id}' expected head '${expectedHead}', but the world is at '${actualHead}'.`, {
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

  private async readHeadOrNull(branchId: string): Promise<string | null> {
    try {
      return await this.branches.readHead(branchId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private publishMessage(sessionId: string, message: PlayConversationMessage, operationId: string): void {
    const { version: _version, ...data } = message;
    this.options.events.publish("play.message.appended", { sessionId, message: data }, { operationId });
  }

  private invalidateCatalog(reason: string, sessionId: string, operationId?: string): void {
    this.options.events.publish("catalog.invalidated", { reason, sessionId }, {
      ...(operationId ? { operationId } : {}),
    });
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
  ].filter((value): value is string => Boolean(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

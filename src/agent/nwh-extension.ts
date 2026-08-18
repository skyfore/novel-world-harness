import path from "node:path";
import { getMarkdownTheme, type AgentSessionEvent, type ExtensionAPI, type ExtensionContext, type ExtensionFactory, type TransientAssistantStream } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { Key, Markdown, Text, matchesKey } from "@earendil-works/pi-tui";
import { expandFileMentions } from "./file-mentions.js";
import { createNwhWelcomeHeader, hasPlayerConversation, isFreshConversation, NWH_WORKING_FRAMES } from "./nwh-welcome.js";
import {
  BOUNDARY_CALIBRATION_TOOL_NAMES,
  COMPILER_TOOL_NAMES,
  createCompilerProposalToolset,
  type CompilerProposalToolset,
} from "../compiler/proposal-tools.js";
import {
  compilerBatchFailure,
  compilerBatchOutcomeFromMessages,
  isRetryableCompilerBatchInterruption,
} from "../compiler/batch-outcome.js";
import {
  markSourceLoopBatchComplete,
  parseStandaloneSourcePath,
  prepareNextSourceLoopTurn,
  prepareSourceLoopFromContent,
  prepareSourceLoopFromInput,
  type SourceLoopTurn,
} from "../compiler/source-loop.js";
import { LocalFileWorkspace } from "../workspace/local-files.js";
import { COMPILER_SYSTEM_PROMPT, compilerModeInstructions, SOURCE_BATCH_DISABLED_PROPOSAL_TOOLS } from "../compiler/pi-compiler.js";
import { SOURCE_EVIDENCE_TOOL_NAMES } from "../compiler/source-evidence-retrieval.js";
import { prepareCompilerBatches, prepareOpeningWorldCompilerBatch, proposeMinimalOpeningWorld } from "../compiler/batches.js";
import { rejectPendingCompilerBatchProposals } from "../compiler/proposals.js";
import { convergeWorldProposals, quarantineUncommittableProposals } from "../compiler/converge.js";
import { inspectPreparation, resolvePreparationBranchId } from "../workflow/prepare.js";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { PlaySessionStore } from "../world/play-session.js";
import { workspaceStateDir } from "./runtime-paths.js";
import { createPiPlayerActionTranslator } from "./pi-player-action.js";
import type { LlmProfile } from "../config/schema.js";
import {
  deterministicPlayerIntentCandidate,
  type PlayerActionTranslator,
  type SafePlayerIntent,
} from "../world/player-action.js";
import {
  inspectPlayExperience,
  listPlayableCharacters,
  performPlayTurn,
  resolveNovelSource,
  type SelectedPlayExperience,
} from "../world/play-experience.js";
import {
  catalogForSource,
  choosePlayExperience,
  choosePlayInstance,
  choosePlayNovel,
  createSourcePlayInstance,
  type PlayInstanceMode,
} from "../world/play-choice.js";
import { formatCharacters, formatInstances, formatNovels, formatProgress } from "../commands/catalog.js";
import { createTuiUserQuestion } from "../util/tui-user-question.js";
import type { UserQuestionCustomInput } from "../util/ask-user-question.js";
import { auditCompiler } from "../compiler/audit.js";
import { buildWorldReconciliationPrompt, semanticRepairIsIsolated } from "../compiler/reconcile-world.js";
import { parseOrdinalSelection, reparseCommand } from "../commands/reparse.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { NwhTask, showNwhTask, taskSummary } from "./nwh-task.js";
import { createWorldBranch } from "../world/instance.js";
import {
  assertPlaySceneNarration,
  buildPlayOpeningFrame,
  playSceneRequestForEntry,
  renderPlaySceneFailure,
  resolvePlayScenePurpose,
  playerSceneModelFrame,
  type PlayScenePurpose,
  type PlaySceneRequest,
} from "../world/play-opening.js";
import {
  createPiPlayerOpeningNarrator,
  type PlayerOpeningNarrator,
  type PlayerSceneNarrationObserver,
} from "./pi-player-opening.js";
import { playerSceneChoicesSchema, type PlayerSceneChoice } from "./player-scene-choice-tool.js";
import { formatElapsed } from "../util/elapsed-status.js";
import { removeNovel, removeNovelAnalysis, removeWorldInstance } from "../world/removal.js";
import { createRenameSessionTool, normalizeSessionTitle } from "./session-title.js";
import { createNwhModelLoadingIndicator } from "./nwh-model-loading.js";
import { NWH_DOUBLE_CTRL_C_WINDOW_MS, NwhDoubleCtrlCExit } from "./nwh-exit.js";
import { classifyPlayerInput, renderPlayerMetaResponse } from "../world/player-input-route.js";
import {
  branchContainsNwhPrivateContext,
  branchHasUntrustedSummary,
  contextPolicyMarker,
  projectCompletedNwhMessages,
  projectNwhModelMessages,
  projectNwhSummaryEntries,
  NWH_CONTEXT_POLICY_MARKER,
  type NwhContextMessage,
} from "./context-policy.js";
import { promptJson } from "../util/prompt-data.js";

export type NwhInteractionMode = "assistant" | "compiler";

const COMPILER_TOOL_NAME_SET = new Set(COMPILER_TOOL_NAMES);

export function compilerToolNamesForScope(
  availableNames: readonly string[],
  scope: "source" | "opening" | "reconciliation",
  sourcePurpose: "structure-discovery" | "source-review" | "boundary-calibration" = "source-review",
): string[] {
  const known = new Set(COMPILER_TOOL_NAMES);
  return [...new Set(availableNames)]
    .filter((name) => known.has(name))
    .filter((name) => !SOURCE_BATCH_DISABLED_PROPOSAL_TOOLS.has(name))
    .filter((name) => scope === "source" && sourcePurpose === "structure-discovery"
      ? name === "configure_chapter_split" || name === "finish_compiler_batch"
      : name !== "configure_chapter_split")
    .filter((name) => scope === "reconciliation" || !SOURCE_EVIDENCE_TOOL_NAMES.includes(name as typeof SOURCE_EVIDENCE_TOOL_NAMES[number]))
    .filter((name) => scope === "source" || !BOUNDARY_CALIBRATION_TOOL_NAMES.includes(name as typeof BOUNDARY_CALIBRATION_TOOL_NAMES[number]))
    .filter((name) => {
      if (scope !== "source") return true;
      return sourcePurpose === "boundary-calibration"
        ? name !== "peek_adjacent_evidence" && name !== "defer_boundary_artifact"
        : name !== "replace_boundary_proposal";
    })
    .filter((name) => scope !== "source" || name !== "propose_initial_world")
    .filter((name) => scope !== "opening" || [
      "find_compiler_artifacts",
      "read_compiler_artifact",
      "propose_entity",
      "propose_claim",
      "propose_initial_world",
      "withdraw_compiler_proposal",
      "finish_compiler_batch",
    ].includes(name));
}

export type NwhExtensionOptions = {
  workspace: LocalFileWorkspace;
  saveSession: boolean;
  mode: NwhInteractionMode;
  profile?: LlmProfile;
  playerTranslator?: PlayerActionTranslator;
  advanceBackground?: number;
  onSessionShutdown?: () => Promise<void>;
  resetCompilerProposalTools?: (segmentIds?: readonly string[], compilerBatchId?: string, sourceId?: string) => Promise<void> | void;
  preparedCacheRoot?: string;
  activeWorldScene?: PlaySceneRequest;
  restoreSavedWorldOnStartup?: boolean;
  playerOpeningNarrator?: PlayerOpeningNarrator;
  runReparse?: typeof reparseCommand;
};

const COMMAND_HELP = `NWH commands:
  /novels                   list registered novel sources
  /instances                list playable branches and committed progress
  /remove [instance|analysis|all] [target] remove debug instances or novel-derived state
  /characters [instance] [novel] list characters from a novel at an instance head
  /play [character] [instance] [novel] choose a novel, then a character
  /world-resume [instance] [character] [novel] resume a saved or named instance
  /continue [novel] [character] continue that novel's latest instance
  /switch [novel] [instance] [character] switch novel, instance or character
  /create-instance [novel] [instance] [character] create a fresh world instance
  /scene                    render the current scene again without advancing it
  /progress [instance]      show committed progress for an instance
  /leave                    leave player mode without deleting resume state
  /files [path filter]       list safe workspace files
  /search <text>             search local files for fixed text
  /read <path> [start:end]   read a bounded line range
  /prepare-content <text>    archive and compile pasted novel text
  /compile-next              process the next evidence batch for the active novel
  /prepare-all [source]      finish compilation and create a playable world
  /reparse [--source id] (--chapters 2,37 | --all) rebuild selected novel evidence
  /tasks                    show or foreground the current long-running task
  /audit [--source id]       audit novel evidence and canonical consistency
  /prepared-cache [list|activate] inspect or activate prepared revisions
  /status                    show workspace, model and session
  /clear                     start a new conversation
  /help                      show this help
  /exit                      end the session

Provider and model:
  /login                     sign in to a provider (subscription/OAuth or API key)
  /logout                    remove provider authentication
  /model                     select a model after signing in

TUI shortcuts:
  Enter send · Shift+Enter newline · Esc interrupt · Ctrl+O toggle tool details
  Ctrl+T toggle reasoning · PgUp/PgDn scroll transcript · Ctrl+Shift+F search
  ↑/↓ prompt history · ← backgrounds the focused NWH task panel · /tasks restores it
  Ctrl+C stops the current response/task; press it again within 2s to exit
  /hotkeys shows every shortcut. Prefix ! runs a user shell command.`;

const LOCAL_EVIDENCE_TOOL_NAMES = new Set(["list_files", "search_files", "read_file"]);
const INITIAL_WORLD_PROMPT = `Inspect the registered novel's opening evidence and existing artifact catalog. Propose one evidence-backed initial-world at one coherent temporal checkpoint. Distinguish narrator frames, recollections, and lived chronology; include checkpoint.mode/rationale and every supported time/layer/event anchor. Never merge an older frame self with a younger remembered self or grant later knowledge. Propose genuinely missing referenced entities or claims first. Do not include later canonical developments.`;

type TuiPrepareAllState = {
  sourceId: string;
  branchId: string;
  compileAllApproved: boolean;
  initialWorldRequestRunning: boolean;
  initialWorldAttempted: boolean;
  initialWorldBatchId?: string;
  reconciliationRequestRunning: boolean;
  reconciliationAttempts: number;
  reconciliationBatchId?: string;
  preparedCacheVerified: boolean;
  providerRetryCounts: Map<string, number>;
};

const MAX_PREPARE_ALL_PROVIDER_RETRIES = 1;

const PLAY_INTENT = /(?:体验|扮演|饰演|想玩|游玩|代入|(?:选择|挑选|切换).{0,8}(?:人物|角色)|进入.{0,8}(?:世界|角色)|以.{0,12}(?:身份|视角)|play\s+as|inhabit|resume\s+as)/iu;
const CHARACTER_LIST_INTENT = /(?:有哪些|列出|查看|显示|选择|什么|哪些).{0,12}(?:人物|角色)|(?:characters|cast|who\s+can\s+i\s+play)/iu;

export function splitCommandArguments(value: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  return tokens;
}

export type TuiReparseArguments = {
  source?: string;
  chapters?: string;
  all: boolean;
  model?: string;
};

export function parseTuiReparseArguments(value: string): TuiReparseArguments {
  const tokens = splitCommandArguments(value);
  const parsed: TuiReparseArguments = { all: false };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--all") {
      parsed.all = true;
      continue;
    }
    if (token === "--source" || token === "--chapters" || token === "--model") {
      const next = tokens[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${token} requires a value.`);
      index += 1;
      if (token === "--source") parsed.source = next;
      else if (token === "--chapters") parsed.chapters = next;
      else parsed.model = next;
      continue;
    }
    throw new Error(`Unknown /reparse argument '${token}'. Use --source, --chapters, --all, or --model.`);
  }
  if (parsed.all && parsed.chapters) throw new Error("Choose only one reparse scope: --all or --chapters <selection>.");
  return parsed;
}

function modelLabel(model: { provider: string; id: string } | undefined): string {
  return model ? `${model.provider}/${model.id}` : "unresolved";
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abortHandler: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        abortHandler = () => reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
        signal.addEventListener("abort", abortHandler, { once: true });
      }),
    ]);
  } finally {
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

type PlayerTranscriptEntry = {
  type: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
  message?: unknown;
};

function transcriptCustomMessage(entry: PlayerTranscriptEntry): { customType?: string; details?: unknown } {
  if (entry.type === "custom_message") return { customType: entry.customType, details: entry.details };
  if (entry.type === "custom" && entry.customType) {
    const data = entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
      ? entry.data as Record<string, unknown>
      : undefined;
    return {
      customType: entry.customType,
      ...(data?.details !== undefined ? { details: data.details } : {}),
    };
  }
  if (!entry.message || typeof entry.message !== "object" || Array.isArray(entry.message)) return {};
  const message = entry.message as Record<string, unknown>;
  return {
    ...(typeof message.customType === "string" ? { customType: message.customType } : {}),
    ...(message.details !== undefined ? { details: message.details } : {}),
  };
}

function restoredPlayerChoices(
  entries: readonly PlayerTranscriptEntry[],
  selection: SelectedPlayExperience,
): PlayerSceneChoice[] {
  const latestPlayerEntry = [...entries].reverse().find((entry) => {
    const { customType } = transcriptCustomMessage(entry);
    return customType === "nwh-play" || customType === "nwh-narrator";
  });
  if (!latestPlayerEntry) return [];
  const { customType, details } = transcriptCustomMessage(latestPlayerEntry);
  if (customType !== "nwh-narrator") return [];
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  const record = details as Record<string, unknown>;
  if (
    record.branchId !== selection.session.branchId
    || record.actorId !== selection.actor.id
    || record.commitId !== selection.session.lastCommitId
  ) return [];
  const parsed = playerSceneChoicesSchema.safeParse({ choices: upgradeLegacyPlayerChoices(record.choices) });
  return parsed.success ? parsed.data.choices : [];
}

function playerTranscriptNeedsRecovery(entries: readonly PlayerTranscriptEntry[]): boolean {
  const latestPlayerEntry = [...entries].reverse().find((entry) => {
    const { customType } = transcriptCustomMessage(entry);
    return customType === "nwh-play" || customType === "nwh-narrator";
  });
  if (!latestPlayerEntry || transcriptCustomMessage(latestPlayerEntry).customType !== "nwh-play") return false;
  try {
    const serialized = JSON.stringify(latestPlayerEntry);
    return serialized.includes("Action rejected at")
      || serialized.includes("当前场景和已提交事实保持不变")
      || serialized.includes("场景恢复生成失败");
  } catch {
    return false;
  }
}

function upgradeLegacyPlayerChoices(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((choice) => {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) return choice;
    const record = choice as Record<string, unknown>;
    if (typeof record.action !== "string") return choice;
    return { action: record.action };
  });
}

/**
 * Compiler turns stay visible in the transcript, but completed compiler
 * prompts/answers must not silently become context for a later assistant turn.
 */
export function filterNwhModelContext<T extends NwhContextMessage>(
  messages: readonly T[],
  compilerTurnActive: boolean,
): T[] {
  return projectNwhModelMessages(messages, compilerTurnActive);
}

export function createNwhExtension(options: NwhExtensionOptions): ExtensionFactory {
  const { workspace, saveSession, mode } = options;
  return (pi: ExtensionAPI) => {
    const customMessageText = (content: string | Array<{ type: string; text?: string }>) => typeof content === "string"
      ? content
      : content.flatMap((item) => item.type === "text" && item.text ? [item.text] : []).join("\n");
    pi.registerMessageRenderer("nwh-narrator", (message) =>
      new Markdown(customMessageText(message.content), 1, 0, getMarkdownTheme()));
    pi.registerMessageRenderer("nwh-play", (message) => {
      const content = customMessageText(message.content);
      return /^Entered \*\*.+committed step \d+\./m.test(content)
        ? new Text("", 0, 0)
        : new Markdown(content, 1, 0, getMarkdownTheme());
    });
    let compilerToolsRegistered = mode === "compiler";
    let compilerToolScope: "source" | "opening" | "reconciliation" | undefined;
    let activeSourceId: string | undefined;
    let pendingTurn: SourceLoopTurn | undefined;
    let pendingTurnInitiatedByUserInput = false;
    let pendingRunMessages: unknown[] = [];
    let registeredCompilerToolset: CompilerProposalToolset | undefined;
    let prepareAllState: TuiPrepareAllState | undefined;
    let compilerCircuitBroken = false;
    let playerMode = false;
    let selectedPlay: SelectedPlayExperience | undefined;
    let activePlayerScene: {
      controller: AbortController;
      promise: Promise<PlayerSceneChoice[]>;
    } | undefined;
    let activePlayerTurn: { controller: AbortController; cancellable: boolean; completion: Promise<void> } | undefined;
    let activePlayerChoicePrompt: symbol | undefined;
    let stopTerminalInput: (() => void) | undefined;
    const doubleCtrlCExit = new NwhDoubleCtrlCExit();
    let startupRestorePromise: Promise<void> | undefined;
    let shuttingDown = false;
    let activeTask: NwhTask | undefined;
    const taskHistory: NwhTask[] = [];
    let taskForeground = false;
    let prepareAllHostActivity: { update(message: string): void; close(): void } | undefined;
    const hostActivities = new Map<string, symbol>();
    const preparedCache = new PreparedNovelCache(workspace.root, options.preparedCacheRoot);
    const runReparse = options.runReparse ?? reparseCommand;
    const taskRunning = () => activeTask?.snapshot.status === "running"
      || activeTask?.snapshot.status === "cancelling";
    let managedSessionName: string | undefined;
    const setAgentSessionName = (title: string) => {
      const normalized = normalizeSessionTitle(title);
      pi.setSessionName(normalized);
      managedSessionName = normalized;
    };
    const setContextSessionName = (title: string) => {
      const current = pi.getSessionName();
      if (current && current !== managedSessionName) return;
      setAgentSessionName(title);
    };
    pi.registerTool(createRenameSessionTool(setAgentSessionName));
    let assistantToolNames: string[];
    try {
      assistantToolNames = [...new Set([...pi.getActiveTools(), "rename_session"])];
    } catch {
      // Synthetic embedding contexts may not expose Pi's active-tool registry.
      assistantToolNames = ["rename_session"];
    }

    const beginHostActivity = (ctx: ExtensionContext, key: string, initial: string) => {
      const token = Symbol(key);
      const startedAt = Date.now();
      let message = initial;
      hostActivities.set(key, token);
      const render = () => {
        if (hostActivities.get(key) !== token || ctx.mode !== "tui") return;
        const text = `${message} · elapsed ${formatElapsed(Date.now() - startedAt)}`;
        const styled = ctx.ui.theme?.fg?.("dim", text) ?? text;
        ctx.ui.setStatus?.(`nwh-host-${key}`, styled);
        if (typeof ctx.ui.setWidget === "function") {
          ctx.ui.setWidget(
            `nwh-host-${key}`,
            [ctx.ui.theme?.fg?.("dim", `⟳ ${text}`) ?? `⟳ ${text}`],
            { placement: "belowEditor" },
          );
        }
      };
      render();
      const timer = setInterval(render, 1_000);
      timer.unref();
      return {
        update(next: string) {
          message = next;
          render();
        },
        close() {
          clearInterval(timer);
          if (hostActivities.get(key) !== token) return;
          hostActivities.delete(key);
          if (ctx.mode === "tui") {
            ctx.ui.setStatus?.(`nwh-host-${key}`, undefined);
            ctx.ui.setWidget?.(`nwh-host-${key}`, undefined, { placement: "belowEditor" });
          }
        },
      };
    };

    const guardForegroundIdle = (
      ctx: ExtensionContext,
      action: string,
      options: { includeTask?: boolean } = {},
    ): boolean => {
      if (typeof ctx.isIdle === "function" && ctx.isIdle() === false) {
        ctx.ui.notify(`Cannot ${action} while the current model response is streaming. Press Esc to interrupt it, or wait for it to finish.`, "warning");
        return false;
      }
      if (pendingTurn || prepareAllState) {
        ctx.ui.notify(`Cannot ${action} while novel preparation is active. Its model output remains in the foreground.`, "warning");
        return false;
      }
      if (activePlayerTurn) {
        ctx.ui.notify(`Cannot ${action} while a player action is being resolved. Press Esc to cancel it before commitment, or wait for the committed result.`, "warning");
        return false;
      }
      if (activePlayerScene) {
        ctx.ui.notify(`Cannot ${action} while scene narration is streaming. Press Esc to stop the narration first.`, "warning");
        return false;
      }
      if (options.includeTask !== false && taskRunning()) {
        ctx.ui.notify(`Cannot ${action} while ${activeTask!.snapshot.title} is ${activeTask!.snapshot.status}. Use /tasks to inspect or cancel it.`, "warning");
        return false;
      }
      return true;
    };

    const syncTaskChrome = (ctx: ExtensionContext, task: NwhTask) => {
      const running = task.snapshot.status === "running" || task.snapshot.status === "cancelling";
      if (!running) {
        ctx.ui.setStatus("nwh-task", undefined);
        const glyph = task.snapshot.status === "completed" ? "✓" : task.snapshot.status === "cancelled" ? "⊘" : "!";
        ctx.ui.setWidget(
          "nwh-task",
          [ctx.ui.theme.fg("dim", `${glyph} ${taskSummary(task)} · /tasks to inspect`) ],
          { placement: "belowEditor" },
        );
        return;
      }
      ctx.ui.setStatus("nwh-task", ctx.ui.theme.fg("dim", taskSummary(task)));
      ctx.ui.setWidget(
        "nwh-task",
        taskForeground ? undefined : [ctx.ui.theme.fg("dim", `↳ ${taskSummary(task)} · /tasks to foreground`)],
        { placement: "belowEditor" },
      );
    };

    const foregroundTask = async (ctx: ExtensionContext, task: NwhTask) => {
      const isActiveTask = task === activeTask;
      if (isActiveTask) {
        taskForeground = true;
        syncTaskChrome(ctx, task);
      }
      const outcome = await showNwhTask(ctx.ui, task, ctx.cwd);
      if (isActiveTask) taskForeground = false;
      if (activeTask) syncTaskChrome(ctx, activeTask);
      if (outcome === "background" && (task.snapshot.status === "running" || task.snapshot.status === "cancelling")) {
        ctx.ui.notify(`${task.snapshot.title} continues in the background; use /tasks to foreground it.`, "info");
      }
    };

    const setPlayerStatus = (ctx: ExtensionContext, selection: SelectedPlayExperience) => {
      if (ctx.mode !== "tui") return;
      ctx.ui.setStatus(
        "nwh-mode",
        ctx.ui.theme.fg("dim", `NWH · ${selection.actor.canonicalName}@${selection.session.branchId} · step ${selection.logicalStep}`),
      );
      ctx.ui.setWorkingMessage(`Advancing ${selection.actor.canonicalName}'s world...`);
    };

    const showPlayMessage = (content: string) => {
      pi.sendMessage({ customType: "nwh-play", content, display: true });
    };

    const showNarratorMessage = (
      content: string,
      details: {
        version: 1;
        branchId: string;
        actorId: string;
        commitId: string;
        purpose: PlayScenePurpose;
        choices: PlayerSceneChoice[];
      },
    ) => {
      pi.sendMessage({ customType: "nwh-narrator", content, display: true, details });
    };

    const createPlayerSceneObserver = (
      ctx: ExtensionContext,
      purpose: PlayScenePurpose,
      signal: AbortSignal,
    ): {
      observer: PlayerSceneNarrationObserver;
      verifyFinalText: (text: string) => void;
      commit: (text: string, details: Record<string, unknown>) => boolean;
      close: () => void;
    } => {
      let content = "";
      let retryNotice = "";
      let toolActivity = "";
      let model = "";
      let attempt: 1 | 2 = 1;
      let sawNativeEvents = false;
      let currentStream: TransientAssistantStream | undefined;
      const sceneLoading = ctx.mode === "tui" && typeof ctx.ui.setWidget === "function" ? createNwhModelLoadingIndicator(ctx.ui, {
        phaseLabels: {
          waiting: "场景正在准备",
          thinking: "叙事正在推演",
          streaming: "场景正在展开",
          tool: "正在整理可选行动",
        },
      }) : undefined;
      const streams: TransientAssistantStream[] = [];
      const completedMessages: AssistantMessage[] = [];
      let currentMessage: AssistantMessage | undefined;
      const title = () => {
        return purpose === "opening"
          ? "故事正在展开"
          : purpose === "turn"
            ? "世界正在回应"
            : purpose === "blocked"
              ? "行动受阻，场景仍在继续"
              : purpose === "recovery"
                ? "正在恢复当前场景"
                : "正在进入当前场景";
      };
      const updateStatus = () => {
        if (ctx.mode !== "tui" || signal.aborted) return;
        const activity = retryNotice || toolActivity || "实时生成场景";
        ctx.ui.setStatus(
          "nwh-play-opening",
          ctx.ui.theme.fg("dim", `NWH · ${title()} · ${model || "模型连接中"} · ${activity}`),
        );
      };
      const disposeStreams = () => {
        for (const stream of streams.splice(0)) stream.dispose();
        currentStream = undefined;
      };
      const openStream = () => {
        if (ctx.mode !== "tui" || typeof ctx.ui.openTransientAssistantStream !== "function") return undefined;
        const stream = ctx.ui.openTransientAssistantStream(
          `nwh-player-scene-${attempt}`,
          {
            hiddenThinkingLabel: "思考已隐藏 · Ctrl+T 显示",
            completedThinkingLabel: "思考已完成 · Ctrl+T 展开",
          },
        );
        streams.push(stream);
        currentStream = stream;
        return stream;
      };
      const sceneBlocks = (message: AssistantMessage) => message.content.filter(
        (block) => block.type === "thinking" || block.type === "text",
      );
      const mergedMessage = (): AssistantMessage | undefined => {
        const messages = [...completedMessages, ...(currentMessage ? [currentMessage] : [])];
        const base = messages.at(-1);
        if (!base) return undefined;
        return {
          ...base,
          content: messages.flatMap(sceneBlocks),
        };
      };
      const remapAssistantEvent = (event: AssistantMessageEvent): AssistantMessageEvent => {
        if (!("contentIndex" in event) || typeof event.contentIndex !== "number" || !currentMessage) return event;
        const completedBlockCount = completedMessages.reduce((sum, message) => sum + sceneBlocks(message).length, 0);
        const currentBlockOffset = currentMessage.content
          .slice(0, event.contentIndex)
          .filter((block) => block.type === "thinking" || block.type === "text")
          .length;
        return { ...event, contentIndex: completedBlockCount + currentBlockOffset } as AssistantMessageEvent;
      };
      const observer: PlayerSceneNarrationObserver = {
        signal,
        onAttempt(nextAttempt) {
          if (nextAttempt > attempt) disposeStreams();
          attempt = nextAttempt;
          content = "";
          toolActivity = "";
          completedMessages.splice(0);
          currentMessage = undefined;
          retryNotice = nextAttempt === 2 ? "首稿未通过校验，正在重写" : "";
          sceneLoading?.setPhase("thinking", retryNotice || title());
          updateStatus();
        },
        onText(delta) {
          if (sawNativeEvents) return;
          content += delta;
          sceneLoading?.setPhase("streaming", title());
          updateStatus();
        },
        onRetry(message) {
          retryNotice = message;
          sceneLoading?.setPhase("waiting", message);
          updateStatus();
        },
        onEvent(event: AgentSessionEvent) {
          sawNativeEvents = true;
          if ((event.type === "message_start" || event.type === "message_update" || event.type === "message_end") && event.message.role === "assistant") {
            model = `${event.message.provider}/${event.message.model}`;
          }
          if (event.type === "message_start" && event.message.role === "assistant") {
            currentMessage = event.message;
            currentStream ??= openStream();
            const merged = mergedMessage();
            if (merged) currentStream?.update(merged);
            retryNotice = "";
            sceneLoading?.setPhase("thinking", title());
            updateStatus();
            return;
          }
          if (event.type === "message_update" && event.message.role === "assistant") {
            if (event.assistantMessageEvent.type === "text_delta") content += event.assistantMessageEvent.delta;
            currentMessage = event.message;
            sceneLoading?.setPhase(
              event.assistantMessageEvent.type === "text_delta" ? "streaming" : "thinking",
              title(),
            );
            currentStream ??= openStream();
            const merged = mergedMessage();
            if (merged) currentStream?.update(merged, remapAssistantEvent(event.assistantMessageEvent));
            updateStatus();
            return;
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            if (!content) {
              content = event.message.content
                .flatMap((block) => block.type === "text" ? [block.text] : [])
                .join("");
            }
            currentMessage = event.message;
            const merged = mergedMessage();
            if (merged) currentStream?.complete(merged);
            completedMessages.push(structuredClone(event.message));
            currentMessage = undefined;
            updateStatus();
            return;
          }
          if (event.type === "tool_execution_start") {
            toolActivity = event.toolName === "propose_player_choices"
              ? "正在整理可选行动"
              : `正在执行 ${event.toolName}`;
            sceneLoading?.setPhase("tool", toolActivity);
            updateStatus();
            return;
          }
          if (event.type === "tool_execution_end") {
            toolActivity = event.isError ? `${event.toolName} 执行失败` : "可选行动已生成";
            sceneLoading?.setPhase("waiting", toolActivity);
            updateStatus();
            return;
          }
          if (event.type === "auto_retry_start") {
            retryNotice = `连接重试 ${event.attempt}/${event.maxAttempts}，${Math.ceil(event.delayMs / 1_000)} 秒后继续`;
            sceneLoading?.setPhase("waiting", retryNotice);
            updateStatus();
            return;
          }
          if (event.type === "auto_retry_end") {
            retryNotice = event.success ? "连接已恢复" : `连接重试 ${event.attempt} 失败`;
            sceneLoading?.setPhase("waiting", retryNotice);
            updateStatus();
          }
        },
      };
      return {
        observer,
        verifyFinalText(text) {
          if (!sawNativeEvents) return;
          if (content !== text) {
            throw new Error("Scene narrator settled text did not match the text shown in the live provider stream.");
          }
        },
        commit(text, details) {
          const stream = currentStream;
          const base = completedMessages.at(-1) ?? currentMessage;
          if (!sawNativeEvents || !stream || !base) return false;
          const persistedMessage: AssistantMessage = {
            ...base,
            content: [
              ...[...completedMessages, ...(currentMessage ? [currentMessage] : [])]
                .flatMap(sceneBlocks)
                .filter((block) => block.type === "thinking"),
              { type: "text", text },
            ],
          };
          stream.complete(persistedMessage);
          stream.commit("nwh-narrator", details);
          const index = streams.indexOf(stream);
          if (index >= 0) streams.splice(index, 1);
          currentStream = undefined;
          return true;
        },
        close() {
          disposeStreams();
          sceneLoading?.stop();
        },
      };
    };

    const runPlayerScene = async (
      ctx: ExtensionContext,
      selection: SelectedPlayExperience,
      purpose: PlayScenePurpose,
      controller: AbortController,
      turnResolution?: Awaited<ReturnType<typeof buildPlayOpeningFrame>>["turnResolution"],
      fallbackChoices: readonly PlayerSceneChoice[] = [],
    ): Promise<PlayerSceneChoice[]> => {
      let frame: Awaited<ReturnType<typeof buildPlayOpeningFrame>> = {
        branchId: selection.session.branchId,
        commitId: selection.session.lastCommitId,
        logicalStep: selection.logicalStep,
        elapsedDays: 0,
        actor: { id: selection.actor.id, name: selection.actor.canonicalName },
        selfState: {},
        development: {
          elapsedDays: 0,
          recentExperiences: [],
        },
        ownedEntityState: {},
        knowledge: [],
        presentEntities: [{ id: selection.actor.id, kind: "character", name: selection.actor.canonicalName }],
        referenceableEntities: [{ id: selection.actor.id, kind: "character", name: selection.actor.canonicalName }],
        visibleEntities: [{ id: selection.actor.id, kind: "character", name: selection.actor.canonicalName }],
        recentVisibleEvents: [],
        scene: { key: "scene:unavailable", beat: 0, locationState: {}, signature: "unavailable" },
        activeThreads: [],
        behavioralContext: { traits: {}, decisionBiases: {}, activeGoals: [] },
        affordances: [],
        ...(turnResolution ? { turnResolution } : {}),
      };
      const stream = createPlayerSceneObserver(ctx, purpose, controller.signal);
      try {
        frame = await buildPlayOpeningFrame(
          workspace.root,
          selection.session.branchId,
          selection.actor.id,
          selection.source?.id,
        );
        if (turnResolution) {
          frame = {
            ...frame,
            turnResolution: structuredClone(turnResolution),
          };
        }
        if (ctx.mode === "tui") {
          ctx.ui.setStatus(
            "nwh-play-opening",
            ctx.ui.theme.fg(
              "dim",
              purpose === "opening"
                ? "Opening story..."
                : purpose === "turn"
                  ? "Rendering outcome..."
                  : purpose === "blocked" || purpose === "recovery"
                    ? "Recovering current scene..."
                    : "Establishing scene...",
            ),
          );
        }
        const narrator = options.playerOpeningNarrator ?? createPiPlayerOpeningNarrator({
          root: workspace.root,
          ...(options.profile ? { profile: options.profile } : {}),
          ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
        });
        const output = await narrator(playerSceneModelFrame(frame), purpose, stream.observer);
        const narration = assertPlaySceneNarration(typeof output === "string" ? output : output.narration);
        const rawChoices = typeof output === "string"
          ? []
          : playerSceneChoicesSchema.parse({ choices: output.choices }).choices;
        // Scene choices are actor-flavored utterance suggestions, not host
        // capabilities. Keep only their schema-validated text; selection later enters
        // the same translation and deterministic gates as free-form input.
        const choices = structuredClone(rawChoices);
        stream.verifyFinalText(narration);
        if (controller.signal.aborted) return [];
        const stillSelected = playerMode
          && selectedPlay?.session.branchId === selection.session.branchId
          && selectedPlay.actor.id === selection.actor.id;
        if (stillSelected) {
          const details = {
            version: 1,
            branchId: frame.branchId,
            actorId: frame.actor.id,
            commitId: frame.commitId,
            purpose,
            choices: structuredClone(choices),
          } as const;
          if (!stream.commit(narration, details)) showNarratorMessage(narration, details);
          return choices;
        }
      } catch (error) {
        if (controller.signal.aborted) return [];
        showPlayMessage(renderPlaySceneFailure(frame, purpose));
        ctx.ui.notify(`Scene narration failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        const rejected = turnResolution ? normalizePlayerUtterance(turnResolution.utterance) : undefined;
        const recoverableChoices = structuredClone(fallbackChoices);
        return recoverableChoices.filter((choice) =>
          !rejected || normalizePlayerUtterance(choice.action) !== rejected);
      } finally {
        stream.close();
        if (ctx.mode === "tui") ctx.ui.setStatus("nwh-play-opening", undefined);
      }
      return [];
    };

    const narratePlayerScene = async (
      ctx: ExtensionContext,
      selection: SelectedPlayExperience,
      purpose: PlayScenePurpose,
      turnResolution?: Awaited<ReturnType<typeof buildPlayOpeningFrame>>["turnResolution"],
      fallbackChoices: readonly PlayerSceneChoice[] = [],
    ): Promise<void> => {
      const previous = activePlayerScene;
      if (previous) {
        previous.controller.abort();
        await previous.promise;
      }
      const controller = new AbortController();
      const promise = runPlayerScene(ctx, selection, purpose, controller, turnResolution, fallbackChoices);
      const active = { controller, promise };
      activePlayerScene = active;
      let choices: PlayerSceneChoice[] = [];
      try {
        choices = await promise;
      } finally {
        if (activePlayerScene === active) activePlayerScene = undefined;
      }
      if (!shuttingDown) await offerPlayerChoices(ctx, selection, choices);
    };

    const activatePlayer = async (
      ctx: ExtensionContext,
      input: {
        branchId?: string;
        character?: string;
        source?: string;
        preferActiveSource?: boolean;
        preferSavedCharacter?: boolean;
        instanceMode?: PlayInstanceMode;
        scene?: PlaySceneRequest;
      } = {},
    ): Promise<SelectedPlayExperience | undefined> => {
      const previousSelection = selectedPlay;
      let selection: SelectedPlayExperience | undefined;
      const activity = beginHostActivity(ctx, "player-select", "Resolving novel, instance, and character");
      try {
        selection = await choosePlayExperience(workspace.root, {
          ...input,
          ...(options.preparedCacheRoot ? { preparedCacheRoot: options.preparedCacheRoot } : {}),
          onInstanceLifecycle: (event) => {
            if (event.type === "continued") return;
            const action = event.type === "created" ? "Created" : "Switched to";
            ctx.ui.notify(
              `${action} ${event.sourceTitle} instance '${event.branchId}'${event.preparedRevisionHash ? ` · revision ${event.preparedRevisionHash.slice(0, 12)}` : ""}.`,
              "info",
            );
          },
        }, createTuiUserQuestion(ctx.ui));
      } catch (error) {
        ctx.ui.notify(`Cannot enter novel world: ${error instanceof Error ? error.message : String(error)}`, "error");
        return undefined;
      } finally {
        activity.close();
      }
      if (!selection) {
        ctx.ui.notify("Player selection cancelled; the current mode is unchanged.", "info");
        return undefined;
      }
      selectedPlay = selection;
      playerMode = true;
      setContextSessionName(`${selection.source?.title ?? "Novel world"} · ${selection.actor.canonicalName} · ${selection.session.branchId}`);
      setPlayerStatus(ctx, selection);
      const selectionChanged = !previousSelection
        || previousSelection.session.branchId !== selection.session.branchId
        || previousSelection.actor.id !== selection.actor.id;
      if (selectionChanged) {
        for (const warning of selection.readinessWarnings) ctx.ui.notify(warning, "warning");
      }
      const requestedScene = input.scene ?? "none";
      const purpose = resolvePlayScenePurpose(requestedScene, {
        logicalStep: selection.logicalStep,
        selectionChanged,
        hadPreviousSelection: Boolean(previousSelection),
      });
      if (purpose) await narratePlayerScene(ctx, selection, purpose);
      return selection;
    };

    const runPlayerInput = async (
      utterance: string,
      ctx: ExtensionContext,
      input: {
        intent?: "act" | SafePlayerIntent;
        origin?: "freeform" | "scene-choice" | "host-safe-choice";
        fallbackChoices?: readonly PlayerSceneChoice[];
      } = {},
    ): Promise<void> => {
      if (shuttingDown) return;
      const selection = selectedPlay ?? await activatePlayer(ctx);
      if (!selection) return;
      const pendingScene = activePlayerScene;
      if (pendingScene) await pendingScene.promise;
      if (shuttingDown) return;
      showPlayMessage(`**${selection.actor.canonicalName}:** ${utterance}`);
      const turnLoading = ctx.mode === "tui" && typeof ctx.ui.setWidget === "function" ? createNwhModelLoadingIndicator(ctx.ui, {
        phaseLabels: {
          waiting: "世界正在回应",
          thinking: "正在理解行动",
          streaming: "场景正在抵达",
          tool: "正在校验世界状态",
        },
      }) : undefined;
      const showTurnActivity = (message: string) => {
        if (ctx.mode !== "tui") return;
        ctx.ui.setStatus("nwh-play-turn", ctx.ui.theme.fg("dim", `${message} · ${selection.actor.canonicalName}`));
        turnLoading?.setPhase(message.includes("校验") || message.includes("写入") ? "tool" : "thinking", message);
      };
      const controller = new AbortController();
      let completeTurn!: () => void;
      const completion = new Promise<void>((resolve) => { completeTurn = resolve; });
      const activeTurn = { controller, cancellable: true, completion };
      activePlayerTurn = activeTurn;
      const safeIntent = input.intent && input.intent !== "act" ? input.intent : undefined;
      const baseTranslator: PlayerActionTranslator = safeIntent
        ? (translationInput) => deterministicPlayerIntentCandidate(safeIntent, translationInput)
        : options.playerTranslator ?? createPiPlayerActionTranslator({
            root: workspace.root,
            ...(options.profile ? { profile: options.profile } : {}),
            ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
            onStatus: showTurnActivity,
            signal: controller.signal,
          });
      const translator: PlayerActionTranslator = async (input) => {
        const candidate = await raceWithAbort(Promise.resolve(baseTranslator(input)), controller.signal);
        controller.signal.throwIfAborted();
        return candidate;
      };
      showTurnActivity("正在理解你的行动…");
      let outcome: Awaited<ReturnType<typeof performPlayTurn>>;
      try {
        outcome = await performPlayTurn({
          root: workspace.root,
          branchId: selection.session.branchId,
          actorId: selection.actor.id,
          utterance,
          translator,
          advanceBackground: options.advanceBackground ?? 0,
          origin: input.origin ?? "freeform",
          ...(input.intent ? { intent: input.intent } : {}),
          beforeCommit: () => { activeTurn.cancellable = false; },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          showPlayMessage("行动已取消；候选尚未进入确定性提交，世界状态没有改变。");
          return;
        }
        throw error;
      } finally {
        if (activePlayerTurn === activeTurn) activePlayerTurn = undefined;
        completeTurn();
        turnLoading?.stop();
        if (ctx.mode === "tui") {
          ctx.ui.setStatus("nwh-play-turn", undefined);
        }
      }
      if (controller.signal.aborted) {
        showPlayMessage("行动已取消；候选尚未进入确定性提交，世界状态没有改变。");
        return;
      }
      const persisted = await new PlaySessionStore(workspace.root).read();
      selectedPlay = {
        ...selection,
        ...(persisted ? { session: persisted } : {}),
        logicalStep: outcome.logicalStep,
      };
      setPlayerStatus(ctx, selectedPlay);
      if (outcome.auditError) ctx.ui.notify(`Player-turn audit could not be persisted: ${outcome.auditError}`, "warning");
      if (!outcome.result.accepted) {
        const issueCode = outcome.result.issues[0]?.code ?? "UNKNOWN";
        showPlayMessage("刚才的请求没有形成可验证的新进展，因此没有写入世界；当前场景和已提交事实保持不变。系统会从同一时刻重新给出可执行且能推进场景、关系、计划或任务线程的行动。");
        ctx.ui.notify(`行动未提交（${outcome.result.stage}/${issueCode}）；正在从同一场景恢复。`, "warning");
        const purpose: PlayScenePurpose = outcome.result.stage === "translation" || outcome.result.stage === "scope"
          ? "recovery"
          : "blocked";
        await narratePlayerScene(
          ctx,
          selectedPlay,
          purpose,
          {
            kind: purpose === "blocked" ? "blocked" : "unresolved",
            utterance,
            actorVisibleSummary: purpose === "blocked"
              ? "这项意图没有在可确认的当前世界里产生效果；现场仍停留在原有的 committed state。"
              : "这项请求没有被解释为一个可靠的世界事件；它没有在场景中发生。",
          },
          input.fallbackChoices?.length ? input.fallbackChoices : [],
        );
        return;
      }
      if (outcome.backgroundError) {
        ctx.ui.notify(`Background advancement stopped: ${outcome.backgroundError}`, "warning");
      }
      await narratePlayerScene(ctx, selectedPlay, "turn");
    };

    const offerPlayerChoices = async (
      ctx: ExtensionContext,
      selection: SelectedPlayExperience,
      choices: readonly PlayerSceneChoice[],
    ): Promise<void> => {
      if (
        ctx.mode !== "tui"
        || (typeof ctx.ui.custom !== "function" && typeof ctx.ui.select !== "function")
      ) return;
      const token = Symbol("player-choice");
      activePlayerChoicePrompt = token;
      const bounded = choices.slice(0, 4);
      let answer: string | undefined;
      try {
        answer = await createTuiUserQuestion(ctx.ui)({
          header: "Next move",
          question: `${selection.actor.canonicalName}，你接下来准备怎么做或怎么说？`,
          options: bounded.map((choice, index) => ({
            value: `choice:${index}`,
            label: choice.action,
            description: "",
          })),
          customInput: {
            label: "自由输入行动或台词",
            description: "",
            prompt: "输入行动或台词",
            placeholder: "例如：走近窗边听外面的声音；或对他说：“先等等。”",
            invalidMessage: "行动或台词不能为空，且不能超过 20000 个字符。",
            resolve: (input) => {
              const normalized = input.trim();
              return normalized && Array.from(normalized).length <= 20_000 ? `custom:${normalized}` : undefined;
            },
          },
        });
      } finally {
        if (activePlayerChoicePrompt === token) activePlayerChoicePrompt = undefined;
      }
      if (!answer || activePlayerChoicePrompt !== undefined || shuttingDown) return;
      const stillSelected = playerMode
        && selectedPlay?.session.branchId === selection.session.branchId
        && selectedPlay.actor.id === selection.actor.id
        && selectedPlay.session.lastCommitId === selection.session.lastCommitId;
      if (!stillSelected) return;
      const selectedIndex = answer.startsWith("choice:") ? Number(answer.slice("choice:".length)) : Number.NaN;
      const selectedChoice = Number.isInteger(selectedIndex) ? bounded[selectedIndex] : undefined;
      const utterance = selectedChoice?.action ?? (answer.startsWith("custom:") ? answer.slice("custom:".length) : undefined);
      if (!utterance) return;
      const timer = setTimeout(() => {
        void runPlayerInput(utterance, ctx, {
          origin: selectedChoice ? "scene-choice" : "freeform",
          fallbackChoices: bounded,
        }).catch((error) => {
          ctx.ui.notify(`Cannot perform player action: ${error instanceof Error ? error.message : String(error)}`, "error");
        });
      }, 0);
      timer.unref();
    };

    const tryNaturalWorldIntent = async (text: string, ctx: ExtensionContext): Promise<boolean> => {
      if (!PLAY_INTENT.test(text) && !CHARACTER_LIST_INTENT.test(text)) return false;
      const activity = beginHostActivity(ctx, "play-intent", "Finding the requested novel world");
      try {
        const catalog = await inspectPlayExperience(workspace.root);
        const sourceId = catalog.novels.length
          ? await choosePlayNovel(catalog, undefined, createTuiUserQuestion(ctx.ui), { preferActive: false })
          : undefined;
        if (catalog.novels.length && !sourceId) return true;
        let instanceCatalog = sourceId ? catalogForSource(catalog, sourceId) : catalog;
        if (sourceId && !instanceCatalog.instances.length) {
          activity.update("Creating the first playable instance");
          await createSourcePlayInstance(workspace.root, catalog, sourceId, {
            ...(options.preparedCacheRoot ? { cacheRoot: options.preparedCacheRoot } : {}),
          });
          instanceCatalog = catalogForSource(await inspectPlayExperience(workspace.root), sourceId);
          const source = catalog.novels.find((novel) => novel.id === sourceId);
          ctx.ui.notify(`Created the first playable instance for ${source?.title ?? sourceId}.`, "info");
        }
        const branchId = await choosePlayInstance(workspace.root, undefined, createTuiUserQuestion(ctx.ui), instanceCatalog);
        if (!branchId) return true;
        activity.update("Loading playable characters");
        const available = await listPlayableCharacters(workspace.root, {
          branchId,
          ...(sourceId ? { source: sourceId } : {}),
        });
        if (CHARACTER_LIST_INTENT.test(text) && !PLAY_INTENT.test(text)) {
          const characters = formatCharacters(available.characters, available.branchId);
          if (ctx.mode === "tui") ctx.ui.notify(characters, "info");
          else showPlayMessage(characters);
          return true;
        }
        const matches = available.characters.filter((character) =>
          [character.canonicalName, ...character.aliases]
            .some((name) => text.normalize("NFKC").toLocaleLowerCase().includes(name.normalize("NFKC").toLocaleLowerCase())),
        );
        const actor = matches.length === 1 ? matches[0] : undefined;
        activity.update("Entering the selected character");
        await activatePlayer(ctx, {
          branchId: available.branchId,
          ...(sourceId ? { source: sourceId } : {}),
          ...(actor ? { character: actor.id } : {}),
          preferActiveSource: false,
          preferSavedCharacter: false,
          instanceMode: "continue",
          scene: playSceneRequestForEntry("play"),
        });
        return true;
      } finally {
        activity.close();
      }
    };

    const resetCompilerBatch = async (segmentIds: readonly string[], compilerBatchId: string, sourceId: string) => {
      await registeredCompilerToolset?.beginBatch(segmentIds, compilerBatchId, sourceId);
      await options.resetCompilerProposalTools?.(segmentIds, compilerBatchId, sourceId);
      compilerCircuitBroken = false;
      pendingRunMessages = [];
    };

    const beginTurn = async (turn: SourceLoopTurn, initiatedByUserInput = false) => {
      await resetCompilerBatch(turn.batch.segmentIds, turn.batch.id, turn.source.id);
      pendingTurn = turn;
      pendingTurnInitiatedByUserInput = initiatedByUserInput;
      setContextSessionName(`${turn.source.title} · world compilation`);
    };

    const activateCompilerTools = (
      ctx: ExtensionContext,
      scope: "source" | "opening" | "reconciliation" = "source",
      sourcePurpose: "structure-discovery" | "source-review" | "boundary-calibration" = "source-review",
    ) => {
      if (!compilerToolsRegistered) {
        const generatedBy = ctx.model ? { provider: ctx.model.provider, model: ctx.model.id } : {};
        registeredCompilerToolset = createCompilerProposalToolset(workspace.root, generatedBy);
        for (const tool of registeredCompilerToolset.tools) {
          if (!SOURCE_BATCH_DISABLED_PROPOSAL_TOOLS.has(tool.name)) pi.registerTool(tool);
        }
        compilerToolsRegistered = true;
      }
      const knownCompilerNames = new Set(COMPILER_TOOL_NAMES);
      const availableCompilerTools = registeredCompilerToolset?.tools ?? pi.getAllTools()
        .filter((tool) => knownCompilerNames.has(tool.name));
      const compilerNames = compilerToolNamesForScope(availableCompilerTools.map((tool) => tool.name), scope, sourcePurpose);
      pi.setActiveTools([...new Set(compilerNames)]);
      compilerToolScope = scope;
      if (ctx.mode === "tui") ctx.ui.setStatus("nwh-mode", ctx.ui.theme.fg("dim", "NWH · world compiler loop"));
    };

    const restoreAssistantTools = (ctx?: ExtensionContext) => {
      if (!compilerToolScope) return;
      pi.setActiveTools(assistantToolNames);
      compilerToolScope = undefined;
      if (ctx?.mode === "tui") {
        ctx.ui.setStatus(
          "nwh-mode",
          ctx.ui.theme.fg("dim", mode === "compiler" ? "NWH · compiler proposals" : "NWH · read-only assistant"),
        );
      }
    };

    const compilerPromptForTurn = (turn: SourceLoopTurn, retryAttempt = 0) => [
      turn.batch.purpose === "structure-discovery"
        ? `Begin preliminary chapter-structure discovery ${turn.completedBatches + 1}/${turn.totalBatches} for source path ${promptJson(turn.source.sourcePath)}. Infer only a safe declarative split rule from the supplied structural sample.`
        : `Begin novel-world compiler batch ${turn.completedBatches + 1}/${turn.totalBatches} for source path ${promptJson(turn.source.sourcePath)}. Analyze the supplied evidence now and record typed pending proposals.`,
      ...(retryAttempt > 0 ? [
        `This is provider-recovery attempt ${retryAttempt}/${MAX_PREPARE_ALL_PROVIDER_RETRIES}. Use neutral, concise literary-analysis language; do not reproduce or embellish narrative passages in prose. Prefer typed tool calls and short clinical summaries. Recover active current-batch proposals instead of duplicating them.`,
      ] : []),
    ].join("\n\n");

    const choose = async <T extends string>(
      ctx: ExtensionContext,
      title: string,
      choices: ReadonlyArray<{ value: T; label: string; description: string; recommended?: boolean }>,
      customInput?: UserQuestionCustomInput<T>,
    ): Promise<T | undefined> => {
      return createTuiUserQuestion(ctx.ui)({
        header: title,
        question: title,
        options: choices,
        ...(customInput ? { customInput } : {}),
      });
    };

    const chooseNovelSourceId = async (
      ctx: ExtensionContext,
      requested?: string,
      question = "Choose a novel source",
    ): Promise<string | undefined> => {
      const store = await WorkspaceStore.create(workspace.root);
      const sources = await store.listSources();
      if (!sources.length) throw new Error("No novel source is registered. Ingest or prepare a novel first.");
      if (requested) return (await resolveNovelSource(store, requested)).id;
      if (sources.length === 1) return sources[0]!.id;
      return choose(ctx, question, sources.map((source, index) => ({
        value: source.id,
        label: source.title,
        description: `${source.sourcePath} (${source.id})`,
        recommended: index === 0,
      })), {
        label: "Enter a source",
        description: "Type a registered source id, title, or path.",
        prompt: "Source id, title, or path",
        placeholder: sources[0]?.id,
        invalidMessage: "No unique registered novel matches that value.",
        resolve: async (value) => {
          try {
            return (await resolveNovelSource(store, value)).id;
          } catch {
            return undefined;
          }
        },
      });
    };

    const stopPrepareAll = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "warning") => {
      restoreAssistantTools(ctx);
      prepareAllState = undefined;
      pendingTurn = undefined;
      pendingTurnInitiatedByUserInput = false;
      pendingRunMessages = [];
      compilerCircuitBroken = false;
      prepareAllHostActivity?.close();
      prepareAllHostActivity = undefined;
      ctx.ui.setStatus("nwh-prepare-all", undefined);
      ctx.ui.setWidget("nwh-prepare-all", undefined, { placement: "belowEditor" });
      ctx.ui.notify(message, level);
    };

    const sendHiddenPreparationTurn = (
      ctx: ExtensionContext,
      content: string,
      customType: string,
      expectedSegmentIds: readonly string[],
    ): boolean => {
      const missingSegmentIds = expectedSegmentIds.filter((segmentId) =>
        !content.includes(`<source-segment id="${segmentId}">`));
      if (missingSegmentIds.length) {
        pendingTurn = undefined;
        pendingTurnInitiatedByUserInput = false;
        pendingRunMessages = [];
        compilerCircuitBroken = false;
        stopPrepareAll(
          ctx,
          `Full preparation stopped before the model turn because compiler evidence was missing for: ${missingSegmentIds.join(", ")}.`,
          "error",
        );
        return false;
      }
      pi.sendMessage({ customType, content, display: false }, { triggerTurn: true });
      return true;
    };

    const advancePrepareAll = async (ctx: ExtensionContext): Promise<void> => {
      const state = prepareAllState;
      if (!state) return;
      try {
      prepareAllHostActivity?.update("Checking deterministic preparation state");
      const inspection = await inspectPreparation(workspace.root, {
        sourceId: state.sourceId,
        branchId: state.branchId,
      });
      if (inspection.stage === "compile") {
        prepareAllHostActivity?.update(`Preparing evidence batch ${inspection.completedBatches + 1}/${inspection.totalBatches}`);
        if (!state.compileAllApproved) {
          const decision = await choose(ctx, "Complete novel compilation?", [
            { value: "continue", label: "Compile all", description: `Run all ${inspection.totalBatches - inspection.completedBatches} remaining evidence batches.`, recommended: true },
            { value: "pause", label: "Pause", description: "Keep current progress and return to the TUI." },
          ]);
          if (decision !== "continue") {
            stopPrepareAll(ctx, `Full preparation paused. Next: ${inspection.next}`, "info");
            return;
          }
          state.compileAllApproved = true;
        }
        const preparation = await prepareNextSourceLoopTurn(workspace.root, state.sourceId);
        if (!preparation || preparation.status === "complete") {
          stopPrepareAll(ctx, "Could not resolve the next compiler batch.", "error");
          return;
        }
        activeSourceId = preparation.source.id;
        activateCompilerTools(ctx, "source", preparation.batch.purpose);
        await beginTurn(preparation);
        const retryAttempt = state.providerRetryCounts.get(preparation.batch.id) ?? 0;
        ctx.ui.setStatus("nwh-prepare-all", ctx.ui.theme.fg("dim", `Preparing · batch ${preparation.completedBatches + 1}/${preparation.totalBatches}`));
        ctx.ui.notify(
          retryAttempt > 0
            ? `Full preparation: retrying compiler batch ${preparation.completedBatches + 1}/${preparation.totalBatches} after a provider interruption.`
            : `Full preparation: starting compiler batch ${preparation.completedBatches + 1}/${preparation.totalBatches}.`,
          "info",
        );
        sendHiddenPreparationTurn(
          ctx,
          `${compilerPromptForTurn(preparation, retryAttempt)}\n\n${preparation.prompt}`,
          "nwh-prepare-all-batch",
          preparation.batch.segmentIds,
        );
        return;
      }
      if (inspection.stage === "review") {
        prepareAllHostActivity?.update(`Reviewing ${inspection.pending.length} pending proposal(s)`);
        const decision = await choose(ctx, "Accept validated proposals?", [
          { value: "accept", label: "Converge safely", description: `Commit valid proposals and preserve uncommittable drafts in rejected history (${inspection.pending.length} pending).`, recommended: true },
          { value: "review", label: "Review first", description: "Stop before accepting anything; use proposal CLI commands." },
        ]);
        if (decision !== "accept") {
          stopPrepareAll(ctx, `Full preparation paused for proposal review. Next: ${inspection.next}`, "info");
          return;
        }
        let lastReported = 0;
        prepareAllHostActivity?.update("Converging validated proposals");
        const result = await convergeWorldProposals(workspace.root, state.sourceId, {
          onProgress: (progress) => {
            if (progress.phase === "complete" || progress.processed === progress.total || progress.processed - lastReported >= 10) {
              ctx.ui.setStatus("nwh-prepare-all", ctx.ui.theme.fg("dim", `Converging · ${progress.phase} ${progress.processed}/${progress.total}`));
              prepareAllHostActivity?.update(`Converging ${progress.phase} ${progress.processed}/${progress.total}`);
              lastReported = progress.processed;
            }
          },
        });
        const blocked = result.canonical.blocked.length + result.possibilities.blocked.length;
        const quarantined = await quarantineUncommittableProposals(workspace.root, result);
        if (quarantined.length) {
          ctx.ui.notify(
            `Rejected ${blocked} validation-blocked and ${result.staging.length} staging-only proposal(s) to immutable history; continuing with validated artifacts.`,
            "warning",
          );
        }
        ctx.ui.notify(`Accepted ${result.canonical.accepted.length + result.possibilities.accepted.length} validated proposal(s).`, "info");
        await advancePrepareAll(ctx);
        return;
      }
      if (inspection.stage === "needs-initial-world") {
        prepareAllHostActivity?.update("Preparing the opening world state");
        if (state.initialWorldAttempted) {
          const fallbackId = await proposeMinimalOpeningWorld(workspace.root, inspection.source!);
          const result = await convergeWorldProposals(workspace.root, state.sourceId);
          await quarantineUncommittableProposals(workspace.root, result);
          ctx.ui.notify(`The model did not leave a valid opening state; accepted a conservative evidence-backed opening-cast fallback ${fallbackId}.`, "warning");
          const afterFallback = await inspectPreparation(workspace.root, {
            sourceId: state.sourceId,
            branchId: state.branchId,
          });
          if (afterFallback.stage === "needs-initial-world") {
            stopPrepareAll(ctx, "The deterministic opening-state fallback could not be committed. Run nwh audit for conflicting world data.", "error");
            return;
          }
          await advancePrepareAll(ctx);
          return;
        }
        const decision = await choose(ctx, "Generate opening world?", [
          { value: "generate", label: "Generate proposal", description: "Ask the current compiler session for an evidence-backed opening state.", recommended: true },
          { value: "pause", label: "Pause", description: "Leave the opening world unresolved for manual work." },
        ]);
        if (decision !== "generate") {
          stopPrepareAll(ctx, `Full preparation paused. Next: ${inspection.next}`, "info");
          return;
        }
        activateCompilerTools(ctx, "opening");
        const openingBatch = await prepareOpeningWorldCompilerBatch(workspace.root, inspection.source!);
        await resetCompilerBatch(openingBatch.segmentIds, openingBatch.id, inspection.source!.id);
        state.initialWorldRequestRunning = true;
        state.initialWorldAttempted = true;
        state.initialWorldBatchId = openingBatch.id;
        ctx.ui.setStatus("nwh-prepare-all", ctx.ui.theme.fg("dim", "Preparing · opening world"));
        sendHiddenPreparationTurn(
          ctx,
          `${INITIAL_WORLD_PROMPT}\n\n${openingBatch.prompt}`,
          "nwh-prepare-all-initial-world",
          openingBatch.segmentIds,
        );
        return;
      }
      if (inspection.stage === "create-branch") {
        prepareAllHostActivity?.update("Publishing the prepared revision");
        const cached = await preparedCache.publish(inspection.source!);
        state.preparedCacheVerified = true;
        ctx.ui.notify(`${cached.status === "published" ? "Published" : "Verified"} prepared revision ${cached.bundleHash} for ${cached.contentMd5}.`, "info");
        const decision = await choose(ctx, "Create playable branch?", [
          { value: "create", label: "Create branch", description: `Commit genesis for branch '${state.branchId}'.`, recommended: true },
          { value: "pause", label: "Pause", description: "Keep canonical preparation complete without creating a branch." },
        ]);
        if (decision !== "create") {
          stopPrepareAll(ctx, `Full preparation paused. Next: ${inspection.next}`, "info");
          return;
        }
        await createWorldBranch(workspace.root, state.branchId, undefined, state.sourceId, options.preparedCacheRoot);
        await advancePrepareAll(ctx);
        return;
      }
      if (inspection.stage === "repair" && inspection.audit && semanticRepairIsIsolated(inspection.audit) && state.reconciliationAttempts < 2) {
        if (state.reconciliationAttempts === 0) {
          const decision = await choose(ctx, "Reconcile world semantics?", [
            { value: "repair", label: "Reconcile world", description: "Repair evidence-backed timeline, effects, and character phases through typed proposals.", recommended: true },
            { value: "pause", label: "Pause", description: "Keep the semantic audit findings for manual repair." },
          ]);
          if (decision !== "repair") {
            stopPrepareAll(ctx, `Full preparation paused. Next: ${inspection.next}`, "info");
            return;
          }
        }
        const iteration = state.reconciliationAttempts + 1;
        const batchId = `reconcile-${state.sourceId}-v2-${iteration}`;
        activateCompilerTools(ctx, "reconciliation");
        await resetCompilerBatch([], batchId, state.sourceId);
        state.reconciliationAttempts = iteration;
        state.reconciliationRequestRunning = true;
        state.reconciliationBatchId = batchId;
        ctx.ui.setStatus("nwh-prepare-all", ctx.ui.theme.fg("dim", `Reconciling world · ${iteration}/2`));
        sendHiddenPreparationTurn(
          ctx,
          await buildWorldReconciliationPrompt(workspace.root, state.sourceId, inspection.audit, iteration),
          "nwh-prepare-all-reconciliation",
          [],
        );
        return;
      }
      if (inspection.stage === "ready") {
        prepareAllHostActivity?.update("Verifying the playable revision");
        if (!state.preparedCacheVerified) {
          const cached = await preparedCache.publish(inspection.source!);
          ctx.ui.notify(`${cached.status === "published" ? "Published" : "Verified"} prepared revision ${cached.bundleHash} for ${cached.contentMd5}.`, "info");
        }
        stopPrepareAll(ctx, `Preparation complete. Run /play to choose a character on '${state.branchId}'.`, "info");
        return;
      }
      const diagnosis = inspection.repairReasons?.length
        ? ` ${inspection.repairReasons.join(" ")}`
        : "";
      stopPrepareAll(
        ctx,
        `Full preparation stopped at '${inspection.stage}'.${diagnosis} Next: ${inspection.next}`,
        inspection.stage === "repair" ? "error" : "warning",
      );
      } catch (error) {
        if (prepareAllState === state) {
          stopPrepareAll(
            ctx,
            `Full preparation stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}. Progress already checkpointed remains resumable with /prepare-all.`,
            "error",
          );
        }
      }
    };

    pi.on("session_shutdown", async () => {
      shuttingDown = true;
      stopTerminalInput?.();
      stopTerminalInput = undefined;
      prepareAllHostActivity?.close();
      prepareAllHostActivity = undefined;
      if (startupRestorePromise) await startupRestorePromise;
      const pendingPlayerTurn = activePlayerTurn;
      if (pendingPlayerTurn?.cancellable) pendingPlayerTurn.controller.abort();
      if (taskRunning()) activeTask!.cancel();
      const pendingScene = activePlayerScene;
      if (pendingScene) {
        pendingScene.controller.abort();
        await pendingScene.promise;
      }
      if (pendingPlayerTurn) await pendingPlayerTurn.completion;
      if (activeTask) await activeTask.completion;
      await options.onSessionShutdown?.();
    });

    pi.on("tool_call", (event) => {
      if (playerMode) {
        return {
          block: true,
          reason: "Player narration is limited to the committed actor frame; tools are unavailable in player mode.",
        };
      }
      if (compilerCircuitBroken) {
        return {
          block: true,
          reason: "The compiler circuit breaker opened; this batch turn is stopping without a checkpoint.",
          terminate: true,
        };
      }
      const compilerTurnActive = Boolean(
        pendingTurn
        || prepareAllState?.initialWorldRequestRunning
        || prepareAllState?.reconciliationRequestRunning,
      );
      if (pendingTurn && event.toolName === "propose_initial_world") {
        return {
          block: true,
          reason: "Ordinary source-review batches cannot propose the initial world; NWH runs a dedicated opening-world pass after source compilation.",
        };
      }
      if (COMPILER_TOOL_NAME_SET.has(event.toolName)) {
        if (mode === "assistant" && !compilerTurnActive) {
          return {
            block: true,
            reason: "Compiler proposal tools are unavailable outside an explicit compiler turn.",
          };
        }
        try {
          if (!pi.getActiveTools().includes(event.toolName)) {
            return {
              block: true,
              reason: `Compiler tool ${event.toolName} is outside the active compiler scope.`,
            };
          }
        } catch {
          // The real Pi runtime exposes active tools. Synthetic embeddings may
          // omit the registry and still enforce their own configured toolset.
        }
      }
      if (!pendingTurn || !LOCAL_EVIDENCE_TOOL_NAMES.has(event.toolName)) return;
      return {
        block: true,
        reason: "This compiler batch may use only the evidence slice supplied by the host; workspace file tools are disabled until the batch settles.",
      };
    });

    pi.on("tool_result", (event) => {
      const details = event.details && typeof event.details === "object" && !Array.isArray(event.details)
        ? event.details as Record<string, unknown>
        : undefined;
      if (details?.compilerBatchBlocked === true) {
        compilerCircuitBroken = true;
        return { isError: true };
      }
    });

    pi.on("input", async (event, ctx) => {
      if (event.source === "extension") return { action: "continue" };
      if (shuttingDown) return { action: "handled" };
      if (startupRestorePromise) await startupRestorePromise;
      if (pendingTurn || prepareAllState) {
        ctx.ui.notify("Novel preparation is already running. Wait for it to finish before sending another message.", "warning");
        return { action: "handled" };
      }
      const sourceCandidate = parseStandaloneSourcePath(event.text);
      const sourceLike = Boolean(sourceCandidate && /\.(?:txt|text|novel|md|markdown)$/iu.test(sourceCandidate));
      if (
        taskRunning()
        && !playerMode
        && (sourceLike || PLAY_INTENT.test(event.text) || CHARACTER_LIST_INTENT.test(event.text))
      ) {
        ctx.ui.notify(
          `${activeTask!.snapshot.title} is ${activeTask!.snapshot.status}. Use /tasks to inspect or cancel it before starting another compiler or world-selection flow.`,
          "warning",
        );
        return { action: "handled" };
      }

      if (playerMode) {
        try {
          if (classifyPlayerInput(event.text) === "meta" && selectedPlay) {
            const activity = beginHostActivity(ctx, "player-meta", "Reading the committed actor-visible timeline");
            try {
              showPlayMessage(`**场外：** ${event.text}`);
              const frame = await buildPlayOpeningFrame(
                workspace.root,
                selectedPlay.session.branchId,
                selectedPlay.actor.id,
                selectedPlay.source?.id,
              );
              showPlayMessage(renderPlayerMetaResponse(frame, event.text));
            } finally {
              activity.close();
            }
            return { action: "handled" };
          }
          await runPlayerInput(event.text, ctx);
        } catch (error) {
          ctx.ui.notify(`Cannot perform player action: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return { action: "handled" };
      }

      const sourceActivity = sourceLike ? beginHostActivity(ctx, "source-ingest", "Reading and indexing the novel source") : undefined;
      try {
        const preparation = await prepareSourceLoopFromInput(workspace.root, event.text, { cacheRoot: options.preparedCacheRoot });
        if (preparation) {
          activeSourceId = preparation.source.id;
          if (preparation.status === "complete") {
            ctx.ui.notify(
              preparation.preparedCache?.status === "restored"
                ? `Restored active prepared revision ${preparation.preparedCache.bundleHash} for ${preparation.source.title}; run /prepare-all to create an independent branch.`
                : `${preparation.source.title} has all ${preparation.totalBatches} source batches checkpointed; run /prepare-all to verify canonical readiness.`,
              "info",
            );
            return { action: "handled" };
          }
          sourceActivity?.update("Preparing the foreground compiler turn");
          activateCompilerTools(ctx, "source", preparation.batch.purpose);
          await beginTurn(preparation, true);
          ctx.ui.notify(
            `Novel indexed: ${preparation.source.sourcePath} · starting batch ${preparation.completedBatches + 1}/${preparation.totalBatches}`,
            "info",
          );
          return { action: "continue" };
        }
      } catch (error) {
        ctx.ui.notify(`Cannot start novel compiler: ${error instanceof Error ? error.message : String(error)}`, "error");
        return { action: "handled" };
      } finally {
        sourceActivity?.close();
      }

      try {
        if (await tryNaturalWorldIntent(event.text, ctx)) return { action: "handled" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.mode === "tui") ctx.ui.notify(`Cannot enter novel world: ${message}`, "error");
        else showPlayMessage(`Cannot enter novel world: ${message}`);
        return { action: "handled" };
      }

      try {
        await expandFileMentions(event.text, workspace);
        return { action: "continue" };
      } catch (error) {
        ctx.ui.notify(`Cannot attach local file: ${error instanceof Error ? error.message : String(error)}`, "error");
        return { action: "handled" };
      }
    });

    pi.on("before_agent_start", async (event) => {
      const compilerActive = Boolean(
        pendingTurn
        || prepareAllState?.initialWorldRequestRunning
        || prepareAllState?.reconciliationRequestRunning,
      );
      // Automatic compiler turns have a host-selected evidence boundary.
      // Generic @file expansion would bypass both the selected segment and the
      // source-scoped exact-retrieval tools, so it is allowed only outside
      // such a turn (including explicit standalone manual compiler sessions).
      const expanded = compilerActive ? event.prompt : await expandFileMentions(event.prompt, workspace);
      const context: string[] = [];
      if (pendingTurn) context.push(pendingTurn.prompt);
      if (expanded !== event.prompt) context.push(expanded.slice(event.prompt.length).trim());
      let activeCompilerTools: Array<{ name: string; guidelines: readonly string[] }> = [];
      if (compilerActive) {
        try {
          const activeNames = new Set(pi.getActiveTools());
          activeCompilerTools = pi.getAllTools()
            .filter((tool) => activeNames.has(tool.name))
            .map((tool) => ({ name: tool.name, guidelines: tool.promptGuidelines ?? [] }));
        } catch {
          activeCompilerTools = (registeredCompilerToolset?.tools ?? [])
            .filter((tool) => !SOURCE_BATCH_DISABLED_PROPOSAL_TOOLS.has(tool.name))
            .map((tool) => ({ name: tool.name, guidelines: tool.promptGuidelines ?? [] }));
        }
      }
      const compilerTurnContract = compilerActive
        ? `<nwh-compiler-turn-contract>\n${promptJson({
            mode: "compiler",
            evidence: pendingTurn?.batch.purpose === "structure-discovery"
              ? "supplied non-citable bounded source-structure sample"
              : pendingTurn
                ? "supplied bounded source segment"
                : "supplied host reconciliation/opening payload",
            projectInstructions: "disabled",
            ordinaryConversation: "excluded",
            tools: activeCompilerTools,
            persistence: "typed writes are pending proposals only; successful finish is required for checkpointing",
          })}\n</nwh-compiler-turn-contract>`
        : undefined;
      if (!context.length && !compilerTurnContract) return;
      return {
        ...(context.length
          ? {
              message: {
                customType: pendingTurn ? "nwh-compiler-batch" : "nwh-file-context",
                content: context.join("\n\n"),
                display: false,
                ...(pendingTurnInitiatedByUserInput ? { details: { excludePreviousUser: true } } : {}),
              },
            }
          : {}),
        ...(compilerTurnContract
          ? {
              systemPrompt: `${COMPILER_SYSTEM_PROMPT}\n\n${compilerModeInstructions(false)}\n\n${compilerTurnContract}`,
            }
          : {}),
      };
    });

    pi.on("session_before_compact", (event, ctx) => {
      let sessionContainsPrivateContext = branchContainsNwhPrivateContext(event.branchEntries);
      try {
        sessionContainsPrivateContext ||= branchContainsNwhPrivateContext(ctx.sessionManager.getEntries());
      } catch {
        // Synthetic embeddings may expose only the branch supplied by Pi.
      }
      const dropSummaries = branchHasUntrustedSummary(event.branchEntries, sessionContainsPrivateContext);
      const history = projectCompletedNwhMessages(
        event.preparation.messagesToSummarize,
        false,
        dropSummaries,
      );
      const prefix = projectCompletedNwhMessages(
        event.preparation.turnPrefixMessages,
        history.state.compilerSpan,
        dropSummaries,
      );
      event.preparation.messagesToSummarize = history.messages;
      event.preparation.turnPrefixMessages = prefix.messages;
      if (dropSummaries) event.preparation.previousSummary = undefined;
      if (!history.messages.length && !prefix.messages.length && !event.preparation.previousSummary) {
        return {
          compaction: {
            summary: `No ordinary model-visible history was compacted. NWH private entries were excluded by context policy v2.`,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            details: { nwhContextPolicyVersion: 2, privateEntriesExcluded: true },
          },
        };
      }
    });

    pi.on("session_compact", (event) => {
      pi.appendEntry(
        NWH_CONTEXT_POLICY_MARKER,
        contextPolicyMarker(event.compactionEntry.id, "compaction"),
      );
    });

    pi.on("session_before_tree", (event, ctx) => {
      let branch = event.preparation.entriesToSummarize;
      let sessionContainsPrivateContext = branchContainsNwhPrivateContext(branch);
      try {
        branch = ctx.sessionManager.getBranch();
        sessionContainsPrivateContext ||= branchContainsNwhPrivateContext(ctx.sessionManager.getEntries());
      } catch {
        // Synthetic embedding contexts may not provide a session manager.
      }
      const allowedIds = new Set(projectNwhSummaryEntries(branch, sessionContainsPrivateContext).map((entry) => entry.id));
      event.preparation.entriesToSummarize = event.preparation.entriesToSummarize
        .filter((entry) => allowedIds.has(entry.id));
    });

    pi.on("session_tree", (event) => {
      if (!event.summaryEntry) return;
      pi.appendEntry(
        NWH_CONTEXT_POLICY_MARKER,
        contextPolicyMarker(event.summaryEntry.id, "branch"),
      );
    });

    pi.on("context", (event, ctx) => {
      let dropSummaries = false;
      try {
        const branch = ctx.sessionManager.getBranch();
        dropSummaries = branchHasUntrustedSummary(
          branch,
          branchContainsNwhPrivateContext(ctx.sessionManager.getEntries()),
        );
      } catch {
        // A context can be synthetic in embedding tests. The real Pi runtime
        // always supplies a read-only session manager.
      }
      const messages = projectNwhModelMessages(
        event.messages,
        Boolean(pendingTurn || prepareAllState?.initialWorldRequestRunning || prepareAllState?.reconciliationRequestRunning),
        dropSummaries,
      );
      if (messages.length === event.messages.length && messages.every((message, index) => message === event.messages[index])) return;
      return { messages };
    });

    pi.on("agent_end", (event) => {
      if (!pendingTurn && !prepareAllState?.initialWorldRequestRunning && !prepareAllState?.reconciliationRequestRunning) return;
      // agent_end is per low-level run. Keep every run until agent_settled so
      // provider retries, compaction retries, and queued continuations cannot
      // erase an earlier unresolved proposal failure or finish handshake.
      pendingRunMessages.push(...event.messages);
    });

    pi.on("agent_settled", async (_event, ctx) => {
      compilerCircuitBroken = false;
      const completedTurn = pendingTurn;
      const openingRequest = !completedTurn && prepareAllState?.initialWorldRequestRunning;
      const reconciliationRequest = !completedTurn && prepareAllState?.reconciliationRequestRunning;
      if (!completedTurn && !openingRequest && !reconciliationRequest) return;
      restoreAssistantTools(ctx);
      const outcome = compilerBatchOutcomeFromMessages(pendingRunMessages);
      pendingRunMessages = [];
      if (!completedTurn) {
        if (openingRequest) prepareAllState!.initialWorldRequestRunning = false;
        if (reconciliationRequest) prepareAllState!.reconciliationRequestRunning = false;
        const failure = compilerBatchFailure(outcome);
        if (failure) {
          const specialBatchId = reconciliationRequest
            ? prepareAllState!.reconciliationBatchId
            : prepareAllState!.initialWorldBatchId;
          const rejected = specialBatchId
            ? await rejectPendingCompilerBatchProposals(workspace.root, specialBatchId)
            : [];
          ctx.ui.notify(`${reconciliationRequest ? "World reconciliation" : "Opening-state compiler"} did not complete (${failure}); incomplete drafts will not enter canonical truth.`, "warning");
          if (rejected.length) ctx.ui.notify(`Rejected ${rejected.length} partial proposal(s).`, "warning");
        }
        await advancePrepareAll(ctx);
        return;
      }
      const failure = compilerBatchFailure(outcome);
      if (failure) {
        const preparation = prepareAllState;
        if (preparation && isRetryableCompilerBatchInterruption(outcome)) {
          const retries = preparation.providerRetryCounts.get(completedTurn.batch.id) ?? 0;
          if (retries < MAX_PREPARE_ALL_PROVIDER_RETRIES) {
            preparation.providerRetryCounts.set(completedTurn.batch.id, retries + 1);
            pendingTurn = undefined;
            pendingTurnInitiatedByUserInput = false;
            ctx.ui.notify(
              `Compiler batch ${completedTurn.batch.ordinal + 1} was interrupted by the provider (${failure}); retrying automatically ${retries + 1}/${MAX_PREPARE_ALL_PROVIDER_RETRIES}.`,
              "warning",
            );
            await advancePrepareAll(ctx);
            return;
          }
        }
        pendingTurn = undefined;
        pendingTurnInitiatedByUserInput = false;
        const wasPreparingAll = Boolean(preparation);
        ctx.ui.notify(
          `Compiler batch ${completedTurn.batch.ordinal + 1} was not checkpointed (${failure}); /compile-next retries the same evidence.`,
          "warning",
        );
        if (wasPreparingAll) {
          stopPrepareAll(ctx, `Full preparation stopped because the compiler batch did not complete (${failure}). Retry /prepare-all to resume.`);
        }
        return;
      }
      pendingTurn = undefined;
      pendingTurnInitiatedByUserInput = false;
      await markSourceLoopBatchComplete(workspace.root, completedTurn.source.id, completedTurn.batch.id);
      ctx.ui.notify(
        completedTurn.batch.purpose === "structure-discovery"
          ? `Chapter split plan checkpointed for ${completedTurn.source.title}; evidence batches will be regenerated on the next compiler turn.`
          : completedTurn.remainingAfterBatch > 0
          ? `Compiler batch ${completedTurn.completedBatches + 1}/${completedTurn.totalBatches} checkpointed · ${completedTurn.remainingAfterBatch} remaining · /compile-next to continue`
          : `All ${completedTurn.totalBatches} compiler batches for ${completedTurn.source.title} are checkpointed.`,
        "info",
      );
      if (prepareAllState) await advancePrepareAll(ctx);
    });

    pi.on("session_start", (event, ctx) => {
      if (ctx.mode !== "tui") return;
      const modeLabel = mode === "compiler" ? "compiler proposals" : "read-only assistant";
      const terminalTitle = `NWH — ${path.basename(workspace.root)}`;
      ctx.ui.setTitle(terminalTitle);
      const titleTimer = setTimeout(() => ctx.ui.setTitle(terminalTitle), 0);
      titleTimer.unref();
      // Pi owns foreground agent turns, including retries and compaction. Keep
      // their progress on its native row; the widget loader is only for nested
      // model sessions (player translation and scene narration).
      ctx.ui.setWorkingMessage(mode === "compiler" ? "Building evidence-backed proposals..." : "Consulting local evidence...");
      ctx.ui.setWorkingIndicator({ frames: NWH_WORKING_FRAMES, intervalMs: 180 });
      ctx.ui.setHiddenThinkingLabel("Thinking hidden · Ctrl+T to show");
      ctx.ui.setStatus("nwh-mode", ctx.ui.theme.fg("dim", `NWH · ${modeLabel}`));
      if (!stopTerminalInput && typeof ctx.ui.onTerminalInput === "function") {
        stopTerminalInput = ctx.ui.onTerminalInput((data) => {
          if (matchesKey(data, Key.ctrl("c"))) {
            if (doubleCtrlCExit.press() === "exit") {
              ctx.shutdown();
              return { consume: true };
            }

            let firstPressResult = "";
            if (activePlayerTurn?.cancellable) {
              activePlayerTurn.controller.abort();
              firstPressResult = "Stopping the current player action. ";
            } else if (activePlayerScene) {
              activePlayerScene.controller.abort();
              firstPressResult = "Stopping the current scene. ";
            } else if (taskForeground && taskRunning()) {
              activeTask!.cancel();
              firstPressResult = `Cancelling ${activeTask!.snapshot.title} safely. `;
            } else if (ctx.isIdle() === false) {
              ctx.abort();
              firstPressResult = "Stopping the current model response. ";
            } else if (ctx.ui.getEditorText()) {
              ctx.ui.setEditorText("");
              firstPressResult = "Input cleared. ";
            }
            ctx.ui.notify(
              `${firstPressResult}Press Ctrl+C again within ${NWH_DOUBLE_CTRL_C_WINDOW_MS / 1_000}s to exit; this session will remain resumable.`,
              "info",
            );
            return { consume: true };
          }
          if (!matchesKey(data, Key.escape)) return undefined;
          if (activePlayerTurn?.cancellable) {
            activePlayerTurn.controller.abort();
            return { consume: true };
          }
          if (activePlayerScene) {
            activePlayerScene.controller.abort();
            return { consume: true };
          }
          return undefined;
        });
      }
      const transcriptEntries = ctx.sessionManager.getEntries();
      const freshConversation = isFreshConversation(transcriptEntries);
      const playerConversation = hasPlayerConversation(transcriptEntries);
      ctx.ui.setHeader((tui, theme) => createNwhWelcomeHeader(tui, theme, { mode, freshConversation }));
      if (mode === "assistant") {
        const restoreSavedWorld = event.reason !== "new"
          && (event.reason !== "startup" || options.restoreSavedWorldOnStartup !== false);
        if (!restoreSavedWorld) {
          ctx.ui.setStatus("nwh-mode", ctx.ui.theme.fg("dim", "NWH · ready · no world selected · /novels or /play"));
          return;
        }
        const restore = async () => {
          if (shuttingDown) return;
          const activity = beginHostActivity(ctx, "startup", "Restoring the previous novel world");
          try {
            const saved = await new PlaySessionStore(workspace.root).read();
            if (saved) {
              activity.update("Opening the saved character and instance");
              const configuredScene = options.activeWorldScene ?? playSceneRequestForEntry("startup", freshConversation);
              const requestedScene = !freshConversation && configuredScene === "auto" ? "none" : configuredScene;
              const selection = await activatePlayer(ctx, {
                branchId: saved.branchId,
                ...(saved.sourceId ? { source: saved.sourceId } : {}),
                character: saved.actorId,
                instanceMode: "continue",
                scene: "none",
              });
              const purpose = selection ? resolvePlayScenePurpose(requestedScene, {
                logicalStep: selection.logicalStep,
                selectionChanged: true,
                hadPreviousSelection: false,
              }) : undefined;
              if (selection && purpose && !shuttingDown) {
                void narratePlayerScene(ctx, selection, purpose);
              } else if (selection && playerConversation && !shuttingDown) {
                if (playerTranscriptNeedsRecovery(transcriptEntries)) {
                  void narratePlayerScene(
                    ctx,
                    selection,
                    "recovery",
                    {
                      kind: "unresolved",
                      utterance: "上一轮行动没有形成 committed world effect。",
                      actorVisibleSummary: "分支仍停留在同一个 committed head；重新建立现场并把选择权交还给玩家。",
                    },
                    [],
                  );
                } else {
                  const persistedChoices = restoredPlayerChoices(transcriptEntries, selection);
                  void offerPlayerChoices(ctx, selection, persistedChoices).catch((error) => {
                    ctx.ui.notify(`Cannot restore player choices: ${error instanceof Error ? error.message : String(error)}`, "warning");
                  });
                }
              }
              return;
            }
            ctx.ui.setStatus("nwh-mode", ctx.ui.theme.fg("dim", "NWH · ready · /play to choose a novel world"));
          } catch (error) {
            ctx.ui.notify(`Saved play session is unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
          } finally {
            activity.close();
          }
        };
        startupRestorePromise = new Promise<void>((resolve) => {
          const timer = setTimeout(() => { void restore().finally(resolve); }, 0);
          timer.unref();
        });
        void startupRestorePromise.finally(() => {
          startupRestorePromise = undefined;
        });
      }
    });

    pi.registerCommand("novels", {
      description: "List registered novels in this workspace",
      handler: async (_args, ctx) => {
        if (!guardForegroundIdle(ctx, "inspect novels", { includeTask: false })) return;
        const activity = beginHostActivity(ctx, "catalog", "Scanning registered novels");
        try {
          ctx.ui.notify(formatNovels(await inspectPlayExperience(workspace.root)), "info");
        } finally {
          activity.close();
        }
      },
    });

    pi.registerCommand("instances", {
      description: "List playable world instances and progress",
      handler: async (_args, ctx) => {
        if (!guardForegroundIdle(ctx, "inspect instances", { includeTask: false })) return;
        const activity = beginHostActivity(ctx, "catalog", "Scanning playable instances");
        try {
          ctx.ui.notify(formatInstances((await inspectPlayExperience(workspace.root)).instances), "info");
        } finally {
          activity.close();
        }
      },
    });

    pi.registerCommand("remove", {
      description: "Remove one instance, reset a novel analysis, or remove both",
      handler: async (args, ctx) => {
        if (!guardForegroundIdle(ctx, "remove novel-world state")) return;
        const tokens = splitCommandArguments(args);
        let scope = tokens.shift() as "instance" | "analysis" | "all" | undefined;
        const requestedTarget = tokens.join(" ") || undefined;
        if (scope && !["instance", "analysis", "all"].includes(scope)) {
          throw new Error("Usage: /remove [instance|analysis|all] [instance-or-novel]");
        }
        if (!scope) {
          scope = await choose(ctx, "What do you want to remove?", [
            {
              value: "instance",
              label: "One instance",
              description: "Delete one branch and its saved evolution; keep the novel analysis.",
              recommended: true,
            },
            {
              value: "analysis",
              label: "Novel analysis",
              description: "Reset evidence, compiler artifacts, and prepared revisions; keep registered source and pinned instances.",
            },
            {
              value: "all",
              label: "Novel and instances",
              description: "Remove the registration, analysis, and every instance owned by that novel.",
            },
          ]);
        }
        if (!scope) return;

        if (scope === "instance") {
          const catalog = await inspectPlayExperience(workspace.root);
          const branchId = await choosePlayInstance(
            workspace.root,
            requestedTarget,
            createTuiUserQuestion(ctx.ui),
            catalog,
            { forcePrompt: !requestedTarget },
          );
          if (!branchId) return;
          const instance = catalog.instances.find((candidate) => candidate.branchId === branchId);
          if (!instance) throw new Error(`Unknown instance '${branchId}'.`);
          const confirmation = await choose(ctx, "Remove this instance?", [
            { value: "cancel", label: "Cancel", description: "Keep the instance and all committed evolution.", recommended: true },
            {
              value: "remove",
              label: "Remove instance",
              description: `${branchId} at step ${instance.logicalStep} will no longer be playable.`,
            },
          ]);
          if (confirmation !== "remove") return;
          const activity = beginHostActivity(ctx, "removal", `Removing instance ${branchId}`);
          try {
            const result = await withWorkspaceOperationLock(
              workspace.root,
              "removal",
              () => removeWorldInstance(workspace.root, branchId),
            );
            if (selectedPlay?.session.branchId === branchId) {
              const scene = activePlayerScene;
              if (scene) {
                scene.controller.abort();
                await scene.promise;
              }
              playerMode = false;
              selectedPlay = undefined;
              ctx.ui.setStatus("nwh-mode", ctx.ui.theme.fg("dim", "NWH · ready · /play to choose a novel world"));
            }
            ctx.ui.notify(
              `Removed instance '${result.branchId}'.${result.nextActiveSession ? ` Active resume target is now '${result.nextActiveSession.branchId}'.` : " No active resume target remains."}`,
              "info",
            );
          } finally {
            activity.close();
          }
          return;
        }

        const sourceId = await chooseNovelSourceId(
          ctx,
          requestedTarget,
          scope === "analysis" ? "Choose a novel analysis to reset" : "Choose a novel to remove",
        );
        if (!sourceId) return;
        const catalog = await inspectPlayExperience(workspace.root);
        const source = catalog.novels.find((candidate) => candidate.id === sourceId);
        if (!source) throw new Error(`Unknown source '${sourceId}'.`);
        const ownedInstances = catalog.instances.filter((instance) => instance.sourceId === sourceId);
        const confirmation = await choose(ctx, scope === "analysis" ? "Reset this novel analysis?" : "Remove this novel and its instances?", [
          {
            value: "cancel",
            label: "Cancel",
            description: "Keep the current novel-world state.",
            recommended: true,
          },
          scope === "analysis"
            ? {
                value: "remove",
                label: "Reset analysis",
                description: `Rebuild ${source.title} from archived evidence later; ${ownedInstances.length} pinned instance(s) remain.`,
              }
            : {
                value: "remove",
                label: "Remove everything",
                description: `Unregister ${source.title}, reset its analysis, and remove ${ownedInstances.length} instance(s).`,
              },
        ]);
        if (confirmation !== "remove") return;
        setContextSessionName(`${source.title} · ${scope === "analysis" ? "reset analysis" : "remove novel"}`);
        const activity = beginHostActivity(ctx, "removal", scope === "analysis" ? `Resetting ${source.title} analysis` : `Removing ${source.title}`);
        try {
          if (scope === "analysis") {
            const result = await withWorkspaceOperationLock(workspace.root, "compiler", () => removeNovelAnalysis(
              workspace.root,
              source,
              { ...(options.preparedCacheRoot ? { cacheRoot: options.preparedCacheRoot } : {}) },
            ));
            if (activeSourceId === sourceId) activeSourceId = undefined;
            ctx.ui.notify(
              `Reset analysis for ${source.title}: reset ${result.canonicalArtifacts + result.actorArtifacts + result.possibilities} active artifact(s) and removed ${result.proposals} proposal(s). ${ownedInstances.length} pinned instance(s) remain playable; archived source evidence is retained.`,
              "info",
            );
            return;
          }

          const result = await withWorkspaceOperationLock(workspace.root, "compiler", () => removeNovel(
            workspace.root,
            source,
            { ...(options.preparedCacheRoot ? { cacheRoot: options.preparedCacheRoot } : {}) },
          ));
          if (activeSourceId === sourceId) activeSourceId = undefined;
          if (selectedPlay?.source?.id === sourceId || result.removedBranchIds.includes(selectedPlay?.session.branchId ?? "")) {
            playerMode = false;
            selectedPlay = undefined;
            ctx.ui.setStatus("nwh-mode", ctx.ui.theme.fg("dim", "NWH · ready · /play to choose a novel world"));
          }
          ctx.ui.notify(
            `Removed ${source.title}, ${result.removedBranchIds.length} instance(s), and its active parsed-world state. Immutable archived source evidence is retained by design.`,
            "info",
          );
        } finally {
          activity.close();
        }
      },
    });

    pi.registerCommand("characters", {
      description: "List committed characters at an instance head",
      handler: async (args, ctx) => {
        if (!guardForegroundIdle(ctx, "inspect characters", { includeTask: false })) return;
        const activity = beginHostActivity(ctx, "catalog", "Loading playable characters");
        try {
        const [requestedBranchId, requestedSource] = splitCommandArguments(args);
        const catalog = await inspectPlayExperience(workspace.root);
        const sourceId = catalog.novels.length || requestedSource
          ? await choosePlayNovel(catalog, requestedSource, createTuiUserQuestion(ctx.ui), { preferActive: false })
          : undefined;
        if (catalog.novels.length && !sourceId) return;
        let instanceCatalog = sourceId ? catalogForSource(catalog, sourceId) : catalog;
        if (sourceId && !instanceCatalog.instances.length) {
          await createSourcePlayInstance(workspace.root, catalog, sourceId, {
            ...(options.preparedCacheRoot ? { cacheRoot: options.preparedCacheRoot } : {}),
          });
          instanceCatalog = catalogForSource(await inspectPlayExperience(workspace.root), sourceId);
          ctx.ui.notify(`Created the first playable instance for the selected novel.`, "info");
        }
        const branchId = await choosePlayInstance(
          workspace.root,
          requestedBranchId,
          createTuiUserQuestion(ctx.ui),
          instanceCatalog,
        );
        if (!branchId) return;
        const result = await listPlayableCharacters(workspace.root, {
          branchId,
          ...(sourceId ? { source: sourceId } : {}),
        });
        ctx.ui.notify(formatCharacters(result.characters, result.branchId, result.source?.title), "info");
        } finally {
          activity.close();
        }
      },
    });

    pi.registerCommand("play", {
      description: "Choose a novel, then choose or name a character",
      handler: async (args, ctx) => {
        if (!guardForegroundIdle(ctx, "enter player mode")) return;
        const [character, branchId, source] = splitCommandArguments(args);
        await activatePlayer(ctx, {
          ...(branchId ? { branchId } : {}),
          ...(character ? { character } : {}),
          ...(source ? { source } : {}),
          preferActiveSource: false,
          preferSavedCharacter: false,
          instanceMode: "switch",
          scene: playSceneRequestForEntry("play"),
        });
      },
    });

    pi.registerCommand("world-resume", {
      description: "Resume the saved or named playable instance",
      handler: async (args, ctx) => {
        if (!guardForegroundIdle(ctx, "resume a world")) return;
        const [branchId, character, source] = splitCommandArguments(args);
        await activatePlayer(ctx, {
          ...(branchId ? { branchId } : {}),
          ...(character ? { character } : {}),
          ...(source ? { source } : {}),
          instanceMode: "continue",
          scene: playSceneRequestForEntry("resume"),
        });
      },
    });

    pi.registerCommand("continue", {
      description: "Continue the latest saved instance for a novel",
      handler: async (args, ctx) => {
        if (!guardForegroundIdle(ctx, "continue a world")) return;
        const [source, character] = splitCommandArguments(args);
        await activatePlayer(ctx, {
          ...(source ? { source } : {}),
          ...(character ? { character } : {}),
          instanceMode: "continue",
          scene: playSceneRequestForEntry("continue"),
        });
      },
    });

    pi.registerCommand("switch", {
      description: "Switch to another novel, instance, or character",
      handler: async (args, ctx) => {
        if (!guardForegroundIdle(ctx, "switch worlds")) return;
        const [source, branchId, character] = splitCommandArguments(args);
        await activatePlayer(ctx, {
          ...(source ? { source } : {}),
          ...(branchId ? { branchId } : {}),
          ...(character ? { character } : {}),
          preferActiveSource: false,
          preferSavedCharacter: true,
          instanceMode: "switch",
          scene: playSceneRequestForEntry("switch"),
        });
      },
    });

    pi.registerCommand("create-instance", {
      description: "Create a fresh instance for a novel revision",
      handler: async (args, ctx) => {
        if (!guardForegroundIdle(ctx, "create an instance")) return;
        const [source, branchId, character] = splitCommandArguments(args);
        await activatePlayer(ctx, {
          ...(source ? { source } : {}),
          ...(branchId ? { branchId } : {}),
          ...(character ? { character } : {}),
          preferActiveSource: false,
          preferSavedCharacter: false,
          instanceMode: "create",
          scene: playSceneRequestForEntry("create"),
        });
      },
    });

    pi.registerCommand("scene", {
      description: "Render the current character scene without advancing the world",
      handler: async (_args, ctx) => {
        if (!guardForegroundIdle(ctx, "render a scene")) return;
        const selection = selectedPlay ?? await activatePlayer(ctx, { instanceMode: "continue", scene: "none" });
        if (!selection) return;
        await narratePlayerScene(ctx, selection, selection.logicalStep === 0 ? "opening" : "orientation");
      },
    });

    pi.registerCommand("progress", {
      description: "Show committed progress for a playable instance",
      handler: async (args, ctx) => {
        if (!guardForegroundIdle(ctx, "inspect world progress", { includeTask: false })) return;
        const activity = beginHostActivity(ctx, "catalog", "Reading committed world progress");
        try {
        const [requestedBranchId] = splitCommandArguments(args);
        const catalog = await inspectPlayExperience(workspace.root);
        const branchId = await choosePlayInstance(
          workspace.root,
          requestedBranchId,
          createTuiUserQuestion(ctx.ui),
          catalog,
        );
        if (!branchId) return;
        const instance = catalog.instances.find((candidate) => candidate.branchId === branchId);
        if (!instance) throw new Error(`Unknown instance '${branchId}'.`);
        ctx.ui.notify(formatProgress(instance), "info");
        } finally {
          activity.close();
        }
      },
    });

    pi.registerCommand("leave", {
      description: "Leave player mode while keeping resume state",
      handler: async (_args, ctx) => {
        const pendingPlayerTurn = activePlayerTurn;
        if (pendingPlayerTurn?.cancellable) pendingPlayerTurn.controller.abort();
        if (pendingPlayerTurn) await pendingPlayerTurn.completion;
        const pendingScene = activePlayerScene;
        if (pendingScene) {
          pendingScene.controller.abort();
          await pendingScene.promise;
        }
        playerMode = false;
        selectedPlay = undefined;
        const modeLabel = compilerToolScope && mode === "assistant" ? "world compiler loop" : "read-only assistant";
        ctx.ui.setStatus("nwh-mode", ctx.ui.theme.fg("dim", `NWH · ${modeLabel}`));
        ctx.ui.setWorkingMessage("Consulting local evidence...");
        ctx.ui.notify("Left player mode. The selected instance and character remain saved; use /world-resume to return.", "info");
      },
    });

    pi.registerCommand("files", {
      description: "List safe local workspace files",
      handler: async (args, ctx) => {
        if (!guardForegroundIdle(ctx, "list files", { includeTask: false })) return;
        const files = await workspace.listFiles({ pattern: args.trim() || undefined });
        ctx.ui.notify(files.length ? files.join("\n") : "No matching files.", "info");
      },
    });

    pi.registerCommand("search", {
      description: "Search local files for fixed text",
      handler: async (args, ctx) => {
        if (!guardForegroundIdle(ctx, "search files", { includeTask: false })) return;
        const query = args.trim();
        if (!query) throw new Error("Usage: /search <text>");
        const matches = await workspace.searchFiles({ query });
        ctx.ui.notify(matches.length ? matches.join("\n") : "No matches.", "info");
      },
    });

    pi.registerCommand("read", {
      description: "Read a bounded local file range",
      handler: async (args, ctx) => {
        if (!guardForegroundIdle(ctx, "read a file", { includeTask: false })) return;
        const [filePath, range] = splitCommandArguments(args);
        if (!filePath) throw new Error("Usage: /read <path> [start:end]");
        const rangeMatch = range?.match(/^(\d+)(?::(\d+))?$/);
        if (range && !rangeMatch) throw new Error("Line range must use start:end, for example 40:80.");
        const startLine = rangeMatch ? Number(rangeMatch[1]) : undefined;
        const endLine = rangeMatch?.[2] ? Number(rangeMatch[2]) : undefined;
        ctx.ui.notify(await workspace.readFile({ path: filePath, startLine, endLine }), "info");
      },
    });

    pi.registerCommand("prepare-content", {
      description: "Archive pasted novel text and start its compiler loop",
      handler: async (args, ctx) => {
        if (!guardForegroundIdle(ctx, "prepare pasted content")) return;
        if (!args.trim()) throw new Error("Usage: /prepare-content <novel text>");
        const content = args;
        const activity = beginHostActivity(ctx, "compiler-preflight", "Archiving and indexing pasted novel content");
        try {
          const preparation = await prepareSourceLoopFromContent(workspace.root, content, {
            title: "pasted-novel.txt",
            cacheRoot: options.preparedCacheRoot,
          });
          activeSourceId = preparation.source.id;
          if (preparation.status === "complete") {
            ctx.ui.notify(
              preparation.preparedCache?.status === "restored"
                ? `Restored active prepared revision ${preparation.preparedCache.bundleHash} for pasted content; run /prepare-all to create an independent branch.`
                : `Pasted content has all ${preparation.totalBatches} source batches checkpointed; run /prepare-all to verify canonical readiness.`,
              "info",
            );
            return;
          }
          activity.update("Preparing the foreground compiler turn");
          activateCompilerTools(ctx, "source", preparation.batch.purpose);
          await beginTurn(preparation);
          ctx.ui.notify(`Archived pasted content as ${preparation.source.id} · starting batch 1/${preparation.totalBatches}.`, "info");
          pi.sendMessage({
            customType: "nwh-compiler-batch",
            content: `${compilerPromptForTurn(preparation)}\n\n${preparation.prompt}`,
            display: false,
          }, { triggerTurn: true });
        } finally {
          activity.close();
        }
      },
    });

    pi.registerCommand("compile-next", {
      description: "Process the next evidence batch for the active novel",
      handler: async (_args, ctx) => {
        if (!guardForegroundIdle(ctx, "compile the next evidence batch")) return;
        const activity = beginHostActivity(ctx, "compiler-preflight", "Loading the next evidence batch");
        try {
          const preparation = await prepareNextSourceLoopTurn(workspace.root, activeSourceId);
          if (!preparation) {
            ctx.ui.notify("No novel source is registered. Paste or drag a novel file path into the TUI first.", "warning");
            return;
          }
          activeSourceId = preparation.source.id;
          if (preparation.status === "complete") {
            ctx.ui.notify(`${preparation.source.title} has all ${preparation.totalBatches} source batches checkpointed; run /prepare-all to verify canonical readiness.`, "info");
            return;
          }
          activity.update("Preparing the foreground compiler turn");
          activateCompilerTools(ctx, "source", preparation.batch.purpose);
          await beginTurn(preparation);
          ctx.ui.notify(`Starting compiler batch ${preparation.completedBatches + 1}/${preparation.totalBatches} for ${preparation.source.title}.`, "info");
          // Host-generated compiler context must never be represented as a user
          // message: doing so replaces the visible slash-command transcript.
          pi.sendMessage({
            customType: "nwh-compiler-batch",
            content: `${compilerPromptForTurn(preparation)}\n\n${preparation.prompt}`,
            display: false,
          }, { triggerTurn: true });
        } finally {
          activity.close();
        }
      },
    });

    pi.registerCommand("prepare-all", {
      description: "Complete compilation, accept validated proposals and create a playable branch",
      handler: async (args, ctx) => {
        if (!guardForegroundIdle(ctx, "prepare the complete novel world")) return;
        const activity = beginHostActivity(ctx, "prepare-all", "Inspecting novel readiness");
        let handedOff = false;
        try {
        const [requestedSourceId, requestedBranchId] = splitCommandArguments(args);
        let branchId = requestedBranchId || "main";
        let inspection = await inspectPreparation(workspace.root, {
          sourceId: requestedSourceId || activeSourceId,
          branchId,
        });
        let sourceId = inspection.source?.id;
        if (inspection.stage === "needs-source") {
          ctx.ui.notify("No novel source is registered. Paste or drag a novel path into the TUI first, then run /prepare-all.", "warning");
          return;
        }
        if (inspection.stage === "choose-source") {
          const choices = inspection.sources.map((source, index) => ({
            value: source.id,
            label: source.title,
            description: `${source.sourcePath} (${source.id})`,
            recommended: index === 0,
          }));
          const store = await WorkspaceStore.create(workspace.root);
          sourceId = await choose(ctx, "Choose a novel source", choices, {
            label: "Enter a source",
            description: "Type a registered source id, title, or path.",
            prompt: "Source id, title, or path",
            placeholder: choices[0]?.value,
            invalidMessage: "No unique registered novel matches that value.",
            resolve: async (value) => {
              try {
                return (await resolveNovelSource(store, value)).id;
              } catch {
                return undefined;
              }
            },
          });
          if (!sourceId) {
            ctx.ui.notify("Full preparation cancelled.", "info");
            return;
          }
          inspection = await inspectPreparation(workspace.root, { sourceId, branchId });
        }
        if (!sourceId) {
          ctx.ui.notify(`Cannot start full preparation at '${inspection.stage}'.`, "error");
          return;
        }
        if (!requestedBranchId) {
          const resolvedBranchId = await resolvePreparationBranchId(workspace.root, inspection.source!, undefined);
          if (resolvedBranchId !== branchId) {
            branchId = resolvedBranchId;
            inspection = await inspectPreparation(workspace.root, { sourceId, branchId });
            ctx.ui.notify(`The default 'main' instance belongs to another novel revision; using independent branch '${branchId}'.`, "info");
          }
        }
        activeSourceId = sourceId;
        const source = inspection.source ?? await (await WorkspaceStore.create(workspace.root)).getSource(sourceId);
        if (source) setContextSessionName(`${source.title} · full preparation`);
        // A changed source cannot be identified as the immutable cached input.
        // Preserve the audit diagnosis instead of letting cache lookup throw a
        // less useful hash-mismatch error before the repair stage is reported.
        if (source && inspection.stage !== "repair") {
          activity.update("Checking the prepared revision cache");
          const restored = await preparedCache.restore(source);
          if (restored.status === "restored") {
            ctx.ui.notify(`Restored active prepared revision ${restored.bundleHash} for ${restored.contentMd5}; source compilation is skipped.`, "info");
          } else if (restored.status === "workspace-not-empty" && restored.reason) {
            ctx.ui.notify(`Prepared cache was not restored: ${restored.reason}`, "warning");
          }
        }
        prepareAllState = {
          sourceId,
          branchId,
          compileAllApproved: false,
          initialWorldRequestRunning: false,
          initialWorldAttempted: false,
          reconciliationRequestRunning: false,
          reconciliationAttempts: 0,
          preparedCacheVerified: false,
          providerRetryCounts: new Map(),
        };
        prepareAllHostActivity = activity;
        handedOff = true;
        ctx.ui.setStatus("nwh-prepare-all", ctx.ui.theme.fg("dim", "Preparing world"));
        await advancePrepareAll(ctx);
        } finally {
          if (!handedOff) activity.close();
        }
      },
    });

    pi.registerCommand("reparse", {
      description: "Rebuild selected chapters or an entire novel into a new prepared revision",
      handler: async (args, ctx) => {
        const runningTask = taskRunning() ? activeTask : undefined;
        if (runningTask) {
          ctx.ui.notify(`${runningTask.snapshot.title} is already running; bringing it to the foreground.`, "info");
          await foregroundTask(ctx, runningTask);
          return;
        }
        if (!guardForegroundIdle(ctx, "start a reparse")) return;
        const parsed = parseTuiReparseArguments(args);
        const preflight = beginHostActivity(ctx, "reparse-preflight", "Loading novel chapters and compiler batches");
        let sourceId: string | undefined;
        let source: Awaited<ReturnType<WorkspaceStore["getSource"]>>;
        let batches: Awaited<ReturnType<typeof prepareCompilerBatches>>;
        try {
          sourceId = await chooseNovelSourceId(ctx, parsed.source, "Choose a novel to reparse");
          if (!sourceId) {
            ctx.ui.notify("Reparse cancelled.", "info");
            return;
          }
          const store = await WorkspaceStore.create(workspace.root);
          source = await store.getSource(sourceId);
          if (!source) throw new Error(`Unknown source '${sourceId}'.`);
          batches = await prepareCompilerBatches(workspace.root, source);
        } finally {
          preflight.close();
        }
        if (!sourceId) {
          ctx.ui.notify("Reparse cancelled.", "info");
          return;
        }
        if (!source) throw new Error(`Unknown source '${sourceId}'.`);
        if (!batches.length) throw new Error(`Source ${source.id} has no compiler batches.`);
        const chapterMap = new Map<number, { title?: string; batches: number }>();
        for (const batch of batches.filter((candidate) => candidate.purpose !== "structure-discovery")) {
          const current = chapterMap.get(batch.chapterOrdinal);
          chapterMap.set(batch.chapterOrdinal, {
            ...(batch.chapterTitle ? { title: batch.chapterTitle } : current?.title ? { title: current.title } : {}),
            batches: (current?.batches ?? 0) + 1,
          });
        }
        const availableChapters = [...chapterMap.keys()].sort((left, right) => left - right);
        let all = parsed.all;
        let chapters = parsed.chapters;
        if (!all && !chapters) {
          const scope = await choose(ctx, "Choose reparse scope", [
            {
              value: "chapters",
              label: "Selected chapters",
              description: "Rebuild one chapter or enter a comma-separated range.",
              recommended: true,
            },
            {
              value: "all",
              label: "Entire novel",
              description: `Rebuild all ${batches.length} compiler batches while retaining the prior revision.`,
            },
          ]);
          if (!scope) {
            ctx.ui.notify("Reparse cancelled.", "info");
            return;
          }
          all = scope === "all";
        }
        if (!all) {
          if (!chapters) {
            chapters = await choose(ctx, "Choose chapters to reparse", availableChapters.map((ordinal) => {
              const chapter = chapterMap.get(ordinal)!;
              return {
                value: String(ordinal),
                label: chapter.title ? `${ordinal}. ${chapter.title}` : `Detected chapter ${ordinal}`,
                description: `${chapter.batches} compiler batch(es)`,
              };
            }), {
              label: "Enter chapter range",
              description: "Use comma-separated ordinals or ranges, for example 2,37 or 3-5.",
              prompt: "Detected chapter ordinals",
              placeholder: availableChapters.length > 1 ? `${availableChapters[0]},${availableChapters.at(-1)}` : String(availableChapters[0]),
              invalidMessage: `Use available chapter ordinals: ${availableChapters.join(", ")}`,
              resolve: (value) => {
                try {
                  return parseOrdinalSelection(value, availableChapters, "chapters").join(",");
                } catch {
                  return undefined;
                }
              },
            });
            if (!chapters) {
              ctx.ui.notify("Reparse cancelled.", "info");
              return;
            }
          }
          chapters = parseOrdinalSelection(chapters, availableChapters, "--chapters").join(",");
        }
        const selectedChapters = all ? availableChapters : parseOrdinalSelection(chapters!, availableChapters, "--chapters");
        const selectedBatchCount = batches.filter((batch) => selectedChapters.includes(batch.chapterOrdinal)).length;
        const confirmation = await choose(ctx, "Start novel reparse?", [
          {
            value: "start",
            label: "Start reparse",
            description: `Rebuild ${selectedBatchCount} batch(es) for ${source.title}; prior revision and branch snapshots are retained.`,
            recommended: true,
          },
          {
            value: "cancel",
            label: "Cancel",
            description: "Keep the current prepared revision unchanged.",
          },
        ]);
        if (confirmation !== "start") {
          ctx.ui.notify("Reparse cancelled.", "info");
          return;
        }
        activeSourceId = sourceId;
        setContextSessionName(`${source.title} · reparse chapters ${selectedChapters.join(",")}`);
        ctx.ui.notify(`Starting reparse for ${source.title}: chapter(s) ${selectedChapters.join(", ")}.`, "info");
        const task = new NwhTask(
          `reparse-${source.id}`,
          `Reparse ${source.title} · chapters ${selectedChapters.join(",")}`,
          "Preparing compiler request",
        );
        activeTask = task;
        taskHistory.push(task);
        const unsubscribe = task.subscribe(() => syncTaskChrome(ctx, task));
        task.start(async (signal) => {
          const selectedModel = parsed.model ?? (ctx.model ? modelLabel(ctx.model) : undefined);
          const result = await runReparse({
            root: workspace.root,
            configPath: path.join(workspace.root, "novel-harness.yaml"),
            sourceId,
            ...(all ? { all: true } : { chapters }),
            ...(selectedModel ? { model: selectedModel } : {}),
            cacheRoot: options.preparedCacheRoot,
            signal,
            onProgress: (message) => task.log(message),
            onStatus: (message) => task.update(message),
            onModelEvent: (event) => task.appendAgentEvent(event),
          });
          task.log(`Active revision: ${result.activeBundleHash}`);
        });
        void task.completion.then(() => {
          unsubscribe();
          syncTaskChrome(ctx, task);
          if (task.snapshot.status === "completed") {
            ctx.ui.notify(`Reparse complete for chapter(s) ${selectedChapters.join(", ")}.`, "info");
          } else if (task.snapshot.status === "cancelled") {
            ctx.ui.notify(`Reparse cancelled safely; the prior prepared revision remains active.`, "info");
          } else {
            ctx.ui.notify(`Reparse stopped: ${task.snapshot.error ?? "unknown error"}`, "error");
          }
        });
        syncTaskChrome(ctx, task);
        await foregroundTask(ctx, task);
      },
    });

    pi.registerCommand("tasks", {
      description: "Show or foreground the current NWH long-running task",
      handler: async (_args, ctx) => {
        if (!taskHistory.length) {
          ctx.ui.notify("No NWH task has been started in this session.", "info");
          return;
        }
        let task = activeTask ?? taskHistory.at(-1)!;
        if (taskHistory.length > 1) {
          const selected = await choose(ctx, "Choose an NWH task", taskHistory.map((candidate, index) => ({
            value: String(index),
            label: `${candidate.snapshot.status} · ${candidate.snapshot.title}`,
            description: taskSummary(candidate),
            recommended: candidate === activeTask,
          })));
          if (selected === undefined) return;
          task = taskHistory[Number(selected)]!;
        }
        await foregroundTask(ctx, task);
      },
    });

    pi.registerCommand("audit", {
      description: "Audit novel evidence and canonical consistency",
      handler: async (args, ctx) => {
        if (!guardForegroundIdle(ctx, "audit compiler state")) return;
        const activity = beginHostActivity(ctx, "audit", "Auditing evidence and canonical consistency");
        try {
        const tokens = splitCommandArguments(args);
        let requestedSource: string | undefined;
        if (tokens.length) {
          if (tokens[0] === "--source" && tokens.length === 2) requestedSource = tokens[1];
          else if (tokens.length === 1 && !tokens[0]!.startsWith("--")) requestedSource = tokens[0];
          else throw new Error("Usage: /audit [--source <id-or-title>]");
        }
        const sourceId = await chooseNovelSourceId(ctx, requestedSource, "Choose a novel to audit");
        if (!sourceId) return;
        const report = await auditCompiler(workspace.root, { sourceId });
        ctx.ui.notify(JSON.stringify(report, null, 2), report.sources.changedSinceIngest.length || report.evidence.invalidReferences || report.consistency.causalGraphValid === false ? "warning" : "info");
        } finally {
          activity.close();
        }
      },
    });

    pi.registerCommand("prepared-cache", {
      description: "List or activate prepared novel revisions",
      handler: async (args, ctx) => {
        if (!guardForegroundIdle(ctx, "inspect or activate prepared revisions")) return;
        const activity = beginHostActivity(ctx, "prepared-cache", "Loading prepared novel revisions");
        try {
        const tokens = splitCommandArguments(args);
        let action = tokens.shift();
        let requestedSource: string | undefined;
        let bundleHash: string | undefined;
        for (let index = 0; index < tokens.length; index += 1) {
          const token = tokens[index]!;
          if (token === "--source") {
            requestedSource = tokens[index + 1];
            if (!requestedSource) throw new Error("--source requires a value.");
            index += 1;
          } else if (action === "activate" && !bundleHash && !token.startsWith("--")) bundleHash = token;
          else throw new Error("Usage: /prepared-cache [list|activate [bundle-hash]] [--source <id-or-title>]");
        }
        if (!action) {
          action = await choose(ctx, "Prepared revision action", [
            { value: "list", label: "List revisions", description: "Inspect stored and active prepared revisions.", recommended: true },
            { value: "activate", label: "Activate revision", description: "Switch the baseline for future branches; existing branches stay pinned." },
          ]);
        }
        if (action !== "list" && action !== "activate") throw new Error("Prepared-cache action must be 'list' or 'activate'.");
        const sourceId = await chooseNovelSourceId(ctx, requestedSource, "Choose a novel revision set");
        if (!sourceId) return;
        const source = await (await WorkspaceStore.create(workspace.root)).getSource(sourceId);
        if (!source) throw new Error(`Unknown source '${sourceId}'.`);
        const revisions = await preparedCache.listRevisions(source);
        if (!revisions.length) {
          ctx.ui.notify(`No prepared revisions exist for ${source.title}.`, "info");
          return;
        }
        if (action === "list") {
          ctx.ui.notify([
            `Prepared revisions for ${source.title}:`,
            ...revisions.map((revision) => `${revision.active ? "* active" : "  stored"}\t${revision.bundleHash}\t${revision.createdAt}`),
          ].join("\n"), "info");
          return;
        }
        if (bundleHash) {
          const matches = revisions.filter((revision) => revision.bundleHash === bundleHash || revision.bundleHash.startsWith(bundleHash!));
          if (matches.length !== 1) throw new Error(`Prepared revision '${bundleHash}' does not uniquely match a stored revision.`);
          bundleHash = matches[0]!.bundleHash;
        } else {
          bundleHash = await choose(ctx, "Choose a prepared revision", revisions.map((revision) => ({
            value: revision.bundleHash,
            label: `${revision.active ? "Active" : "Stored"} · ${revision.bundleHash.slice(0, 12)}`,
            description: revision.createdAt,
            recommended: revision.active,
          })));
        }
        if (!bundleHash) return;
        const confirmation = await choose(ctx, "Activate prepared revision?", [
          { value: "activate", label: "Activate revision", description: `Use ${bundleHash.slice(0, 12)} for future branches; existing branches remain pinned.`, recommended: true },
          { value: "cancel", label: "Cancel", description: "Keep the current active revision." },
        ]);
        if (confirmation !== "activate") return;
        activity.update("Activating the selected prepared revision");
        const result = await withWorkspaceOperationLock(workspace.root, "compiler", () => preparedCache.activate(source, bundleHash!));
        ctx.ui.notify(`Activated prepared revision ${result.bundleHash} for ${source.title}; existing branches remain pinned.`, "info");
        } finally {
          activity.close();
        }
      },
    });

    pi.registerCommand("status", {
      description: "Show NWH workspace and session status",
      handler: async (_args, ctx) => {
        if (!guardForegroundIdle(ctx, "inspect status", { includeTask: false })) return;
        const activity = beginHostActivity(ctx, "catalog", "Reading workspace and session status");
        try {
        const catalog = await inspectPlayExperience(workspace.root);
        const current = catalog.instances.find((instance) => instance.active);
        ctx.ui.notify([
          `workspace: ${workspace.root}`,
          `state: ${workspaceStateDir(workspace.root)}`,
          `mode: ${playerMode ? "player" : compilerToolScope && mode === "assistant" ? "world-compiler-loop" : mode}`,
          `active source: ${activeSourceId ?? "none"}`,
          `registered novels: ${catalog.novels.length}`,
          `playable instances: ${catalog.instances.length}`,
          `current play: ${current ? `${current.actorName ?? current.actorId ?? "no character"}@${current.branchId} step ${current.logicalStep}` : "none"}`,
          `model: ${modelLabel(ctx.model)}`,
          `session: ${ctx.sessionManager.getSessionId()}`,
          `session title: ${ctx.sessionManager.getSessionName() ?? "unnamed (agent will name it after a substantive turn)"}`,
          `entries: ${ctx.sessionManager.getEntries().length}`,
          `persistence: ${saveSession ? "on" : "off"}`,
          `task: ${activeTask ? taskSummary(activeTask) : "none"}`,
        ].join("\n"), "info");
        } finally {
          activity.close();
        }
      },
    });

    pi.registerCommand("clear", {
      description: "Start a new NWH conversation",
      handler: async (_args, ctx) => {
        if (!guardForegroundIdle(ctx, "clear the conversation")) return;
        await ctx.newSession({
          withSession: async (replacementCtx) => {
            replacementCtx.ui.notify(
              "Conversation history cleared. No novel world is active in this conversation; use /novels or /play to choose one.",
              "info",
            );
          },
        });
      },
    });

    pi.registerCommand("help", {
      description: "Show NWH commands and key hints",
      handler: async (_args, ctx) => ctx.ui.notify(COMMAND_HELP, "info"),
    });

    pi.registerCommand("exit", {
      description: "Exit NWH",
      handler: async (_args, ctx) => {
        if (taskRunning()) {
          ctx.ui.notify(`Cancelling ${activeTask!.snapshot.title} safely before exit...`, "info");
          activeTask!.cancel();
          await activeTask!.completion;
        }
        ctx.shutdown();
      },
    });
  };
}

function normalizePlayerUtterance(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").replace(/[，。！？、,.!?;；:："'“”‘’]/g, "").toLocaleLowerCase();
}

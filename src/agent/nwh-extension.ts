import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { expandFileMentions } from "./file-mentions.js";
import { createNwhWelcomeHeader, isFreshConversation, NWH_WORKING_FRAMES } from "./nwh-welcome.js";
import {
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
  prepareNextSourceLoopTurn,
  prepareSourceLoopFromContent,
  prepareSourceLoopFromInput,
  type SourceLoopTurn,
} from "../compiler/source-loop.js";
import { LocalFileWorkspace } from "../workspace/local-files.js";
import { SOURCE_BATCH_DISABLED_PROPOSAL_TOOLS } from "../compiler/pi-compiler.js";
import { prepareCompilerBatches, prepareOpeningWorldCompilerBatch, proposeMinimalOpeningWorld } from "../compiler/batches.js";
import { rejectPendingCompilerBatchProposals } from "../compiler/proposals.js";
import { convergeWorldProposals, quarantineUncommittableProposals } from "../compiler/converge.js";
import { inspectPreparation } from "../workflow/prepare.js";
import { InitialWorldStore } from "../world/initial.js";
import { openWorkspaceWorld } from "../world/workspace-runtime.js";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { PlaySessionStore } from "../world/play-session.js";
import { workspaceStateDir } from "./runtime-paths.js";
import { createPiPlayerActionTranslator } from "./pi-player-action.js";
import type { LlmProfile } from "../config/schema.js";
import type { PlayerActionTranslator } from "../world/player-action.js";
import {
  inspectPlayExperience,
  listPlayableCharacters,
  performPlayTurn,
  resolveNovelSource,
  type SelectedPlayExperience,
} from "../world/play-experience.js";
import { choosePlayExperience, choosePlayInstance, choosePlayNovel } from "../world/play-choice.js";
import { formatCharacters, formatInstances, formatNovels, formatProgress } from "../commands/catalog.js";
import { createTuiUserQuestion } from "../util/tui-user-question.js";
import type { UserQuestionCustomInput } from "../util/ask-user-question.js";
import { auditCompiler } from "../compiler/audit.js";
import { parseOrdinalSelection, reparseCommand } from "../commands/reparse.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { NwhTask, showNwhTask, taskSummary } from "./nwh-task.js";

export type NwhInteractionMode = "assistant" | "compiler";

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
  runReparse?: typeof reparseCommand;
};

const COMMAND_HELP = `NWH commands:
  /novels                   list registered novel sources
  /instances                list playable branches and committed progress
  /characters [instance] [novel] list characters from a novel at an instance head
  /play [character] [instance] [novel] choose a novel, then a character
  /world-resume [instance] [character] [novel] resume a saved or named instance
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
  /hotkeys shows every shortcut. Prefix ! runs a user shell command.`;

const LOCAL_EVIDENCE_TOOL_NAMES = new Set(["list_files", "search_files", "read_file"]);
const INITIAL_WORLD_PROMPT = `Inspect the registered novel's opening evidence and existing artifact catalog. Propose one evidence-backed initial-world representing only the state already true at the opening. Propose genuinely missing referenced entities or claims first. Do not include later canonical developments.`;

type TuiPrepareAllState = {
  sourceId: string;
  branchId: string;
  compileAllApproved: boolean;
  initialWorldRequestRunning: boolean;
  initialWorldAttempted: boolean;
  initialWorldBatchId?: string;
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

export function compilerBatchTerminalText(message: { stopReason?: string; errorMessage?: string }): string {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const detail = message.errorMessage?.replace(/\s+/g, " ").trim().slice(0, 500);
    return `Model batch ended with ${message.stopReason}${detail ? `: ${detail}` : ""}. NWH did not checkpoint the batch or commit world truth; the host is deciding whether it can be retried.`;
  }
  return "Model batch output ended. NWH is verifying the finish handshake and deriving checkpoint status from host state. All submitted artifacts remain pending proposals until deterministic convergence accepts them.";
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

export function createNwhExtension(options: NwhExtensionOptions): ExtensionFactory {
  const { workspace, saveSession, mode } = options;
  return (pi: ExtensionAPI) => {
    let compilerToolsActive = mode === "compiler";
    let activeSourceId: string | undefined;
    let pendingTurn: SourceLoopTurn | undefined;
    let pendingRunMessages: unknown[] = [];
    let registeredCompilerToolset: CompilerProposalToolset | undefined;
    let prepareAllState: TuiPrepareAllState | undefined;
    let compilerCircuitBroken = false;
    let playerMode = false;
    let selectedPlay: SelectedPlayExperience | undefined;
    let activeTask: NwhTask | undefined;
    let taskForeground = false;
    const preparedCache = new PreparedNovelCache(workspace.root, options.preparedCacheRoot);
    const runReparse = options.runReparse ?? reparseCommand;
    const taskRunning = () => activeTask?.snapshot.status === "running";

    const syncTaskChrome = (ctx: ExtensionContext, task: NwhTask) => {
      if (task.snapshot.status !== "running") {
        ctx.ui.setStatus("nwh-task", undefined);
        ctx.ui.setWidget("nwh-task", undefined, { placement: "belowEditor" });
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
      taskForeground = true;
      syncTaskChrome(ctx, task);
      const outcome = await showNwhTask(ctx.ui, task, ctx.cwd);
      taskForeground = false;
      syncTaskChrome(ctx, task);
      if (outcome === "background" && task.snapshot.status === "running") {
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

    const activatePlayer = async (
      ctx: ExtensionContext,
      input: {
        branchId?: string;
        character?: string;
        source?: string;
        preferActiveSource?: boolean;
        preferSavedCharacter?: boolean;
      } = {},
    ): Promise<SelectedPlayExperience | undefined> => {
      const selection = await choosePlayExperience(workspace.root, input, createTuiUserQuestion(ctx.ui));
      if (!selection) {
        ctx.ui.notify("Player selection cancelled; the current mode is unchanged.", "info");
        return undefined;
      }
      selectedPlay = selection;
      playerMode = true;
      setPlayerStatus(ctx, selection);
      showPlayMessage([
        `Entered **${selection.actor.canonicalName}** (${selection.actor.id}) on **${selection.session.branchId}** at committed step ${selection.logicalStep}.`,
        selection.source ? `Novel: **${selection.source.title}**.` : "",
        selection.actor.locationName ? `Current location: ${selection.actor.locationName}.` : "",
        "Your next ordinary message is treated as this character's immediate action. Use /leave to return to compiler/assistant mode.",
      ].filter(Boolean).join("\n"));
      return selection;
    };

    const runPlayerInput = async (utterance: string, ctx: ExtensionContext): Promise<void> => {
      const selection = selectedPlay ?? await activatePlayer(ctx);
      if (!selection) return;
      showPlayMessage(`**${selection.actor.canonicalName}:** ${utterance}`);
      const translator = options.playerTranslator ?? createPiPlayerActionTranslator({
        root: workspace.root,
        ...(options.profile ? { profile: options.profile } : {}),
        ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
      });
      if (ctx.mode === "tui") {
        ctx.ui.setStatus("nwh-play-turn", ctx.ui.theme.fg("dim", `Validating action · ${selection.actor.canonicalName}`));
      }
      try {
        const outcome = await performPlayTurn({
          root: workspace.root,
          branchId: selection.session.branchId,
          actorId: selection.actor.id,
          utterance,
          translator,
          advanceBackground: options.advanceBackground ?? 1,
        });
        if (!outcome.result.accepted) {
          showPlayMessage([
            `Action rejected at **${outcome.result.stage}**; committed world truth is unchanged.`,
            ...outcome.result.issues.map((issue) => `- ${issue.code}: ${issue.message}`),
          ].join("\n"));
        } else {
          showPlayMessage([
            outcome.result.renderedText,
            `Committed at step ${outcome.logicalStep} (${outcome.finalHead.slice(0, 12)}).`,
            ...outcome.backgroundEvents.map((event) => `World advanced: ${event.title}`),
            ...(outcome.backgroundError ? [`Background advancement stopped: ${outcome.backgroundError}`] : []),
          ].join("\n\n"));
        }
        const persisted = await new PlaySessionStore(workspace.root).read();
        selectedPlay = {
          ...selection,
          ...(persisted ? { session: persisted } : {}),
          logicalStep: outcome.logicalStep,
        };
        setPlayerStatus(ctx, selectedPlay);
      } finally {
        if (ctx.mode === "tui") ctx.ui.setStatus("nwh-play-turn", undefined);
      }
    };

    const tryNaturalWorldIntent = async (text: string, ctx: ExtensionContext): Promise<boolean> => {
      if (!PLAY_INTENT.test(text) && !CHARACTER_LIST_INTENT.test(text)) return false;
      const catalog = await inspectPlayExperience(workspace.root);
      const sourceId = catalog.novels.length
        ? await choosePlayNovel(catalog, undefined, createTuiUserQuestion(ctx.ui), { preferActive: false })
        : undefined;
      if (catalog.novels.length && !sourceId) return true;
      const branchId = await choosePlayInstance(workspace.root, undefined, createTuiUserQuestion(ctx.ui), catalog);
      if (!branchId) return true;
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
      const actor = matches.length === 1
        ? matches[0]
        : available.characters.length === 1
          ? available.characters[0]
          : undefined;
      await activatePlayer(ctx, {
        branchId: available.branchId,
        ...(sourceId ? { source: sourceId } : {}),
        ...(actor ? { character: actor.id } : {}),
        preferActiveSource: false,
        preferSavedCharacter: false,
      });
      return true;
    };

    const resetCompilerBatch = async (segmentIds: readonly string[], compilerBatchId: string, sourceId: string) => {
      await registeredCompilerToolset?.beginBatch(segmentIds, compilerBatchId, sourceId);
      await options.resetCompilerProposalTools?.(segmentIds, compilerBatchId, sourceId);
      compilerCircuitBroken = false;
      pendingRunMessages = [];
    };

    const beginTurn = async (turn: SourceLoopTurn) => {
      await resetCompilerBatch(turn.batch.segmentIds, turn.batch.id, turn.source.id);
      pendingTurn = turn;
    };

    const activateCompilerTools = (ctx: ExtensionContext) => {
      if (!compilerToolsActive) {
        const generatedBy = ctx.model ? { provider: ctx.model.provider, model: ctx.model.id } : {};
        registeredCompilerToolset = createCompilerProposalToolset(workspace.root, generatedBy);
        for (const tool of registeredCompilerToolset.tools) {
          if (!SOURCE_BATCH_DISABLED_PROPOSAL_TOOLS.has(tool.name)) pi.registerTool(tool);
        }
        compilerToolsActive = true;
      }
      if (ctx.mode === "tui") ctx.ui.setStatus("nwh-mode", ctx.ui.theme.fg("dim", "NWH · world compiler loop"));
    };

    const compilerPromptForTurn = (turn: SourceLoopTurn, retryAttempt = 0) => [
      `Begin novel-world compiler batch ${turn.completedBatches + 1}/${turn.totalBatches} for ${turn.source.sourcePath}. Analyze the supplied evidence now and record typed pending proposals.`,
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
      prepareAllState = undefined;
      ctx.ui.setStatus("nwh-prepare-all", undefined);
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
      const inspection = await inspectPreparation(workspace.root, {
        sourceId: state.sourceId,
        branchId: state.branchId,
      });
      if (inspection.stage === "compile") {
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
        activateCompilerTools(ctx);
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
        const decision = await choose(ctx, "Accept validated proposals?", [
          { value: "accept", label: "Converge safely", description: `Commit valid proposals and preserve uncommittable drafts in rejected history (${inspection.pending.length} pending).`, recommended: true },
          { value: "review", label: "Review first", description: "Stop before accepting anything; use proposal CLI commands." },
        ]);
        if (decision !== "accept") {
          stopPrepareAll(ctx, `Full preparation paused for proposal review. Next: ${inspection.next}`, "info");
          return;
        }
        let lastReported = 0;
        const result = await convergeWorldProposals(workspace.root, state.sourceId, {
          onProgress: (progress) => {
            if (progress.phase === "complete" || progress.processed === progress.total || progress.processed - lastReported >= 50) {
              ctx.ui.setStatus("nwh-prepare-all", ctx.ui.theme.fg("dim", `Converging · ${progress.phase} ${progress.processed}/${progress.total}`));
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
        if (state.initialWorldAttempted) {
          const fallbackId = await proposeMinimalOpeningWorld(workspace.root, inspection.source!);
          const result = await convergeWorldProposals(workspace.root, state.sourceId);
          await quarantineUncommittableProposals(workspace.root, result);
          ctx.ui.notify(`The model did not leave a valid opening state; accepted conservative empty-delta fallback ${fallbackId}.`, "warning");
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
        activateCompilerTools(ctx);
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
        const initial = await new InitialWorldStore(workspace.root).get();
        if (!initial) {
          stopPrepareAll(ctx, "Cannot create a branch without an accepted initial world.", "error");
          return;
        }
        const { engine } = await openWorkspaceWorld(workspace.root);
        await engine.createBranch(state.branchId, state.branchId, initial.delta, initial.knowledge);
        await advancePrepareAll(ctx);
        return;
      }
      if (inspection.stage === "ready") {
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
    };

    pi.on("session_shutdown", async () => options.onSessionShutdown?.());

    pi.on("tool_call", (event) => {
      if (compilerCircuitBroken) {
        return {
          block: true,
          reason: "The compiler circuit breaker opened; this batch turn is stopping without a checkpoint.",
          terminate: true,
        };
      }
      if (pendingTurn && event.toolName === "propose_initial_world") {
        return {
          block: true,
          reason: "Ordinary source-review batches cannot propose the initial world; NWH runs a dedicated opening-world pass after source compilation.",
        };
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
      if (pendingTurn || prepareAllState) {
        ctx.ui.notify("Novel preparation is already running. Wait for it to finish before sending another message.", "warning");
        return { action: "handled" };
      }

      if (playerMode) {
        try {
          await runPlayerInput(event.text, ctx);
        } catch (error) {
          ctx.ui.notify(`Cannot perform player action: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return { action: "handled" };
      }

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
          activateCompilerTools(ctx);
          await beginTurn(preparation);
          ctx.ui.notify(
            `Novel indexed: ${preparation.source.sourcePath} · starting batch ${preparation.completedBatches + 1}/${preparation.totalBatches}`,
            "info",
          );
          return { action: "continue" };
        }
      } catch (error) {
        ctx.ui.notify(`Cannot start novel compiler: ${error instanceof Error ? error.message : String(error)}`, "error");
        return { action: "handled" };
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
      const expanded = await expandFileMentions(event.prompt, workspace);
      const context: string[] = [];
      if (pendingTurn) context.push(pendingTurn.prompt);
      if (expanded !== event.prompt) context.push(expanded.slice(event.prompt.length).trim());
      if (!context.length) return;
      return {
        message: {
          customType: pendingTurn ? "nwh-compiler-batch" : "nwh-file-context",
          content: context.join("\n\n"),
          display: false,
        },
      };
    });

    pi.on("context", (event) => {
      if (!pendingTurn && !prepareAllState?.initialWorldRequestRunning) return;
      const boundary = event.messages.findLastIndex((message) =>
        message.role === "custom" && (
          message.customType === "nwh-compiler-batch"
          || message.customType === "nwh-prepare-all-batch"
          || message.customType === "nwh-prepare-all-initial-world"
        ));
      if (boundary <= 0) return;
      return { messages: event.messages.slice(boundary) };
    });

    pi.on("message_end", (event) => {
      if ((!pendingTurn && !prepareAllState?.initialWorldRequestRunning) || event.message.role !== "assistant") return;
      if (event.message.content.some((content) => content.type === "toolCall")) return;
      return {
        message: {
          ...event.message,
          content: [{
            type: "text",
            text: compilerBatchTerminalText(event.message),
          }],
        },
      };
    });

    pi.on("agent_end", (event) => {
      if (!pendingTurn && !prepareAllState?.initialWorldRequestRunning) return;
      // agent_end is per low-level run. Keep every run until agent_settled so
      // provider retries, compaction retries, and queued continuations cannot
      // erase an earlier unresolved proposal failure or finish handshake.
      pendingRunMessages.push(...event.messages);
    });

    pi.on("agent_settled", async (_event, ctx) => {
      compilerCircuitBroken = false;
      const completedTurn = pendingTurn;
      const openingRequest = !completedTurn && prepareAllState?.initialWorldRequestRunning;
      if (!completedTurn && !openingRequest) return;
      const outcome = compilerBatchOutcomeFromMessages(pendingRunMessages);
      pendingRunMessages = [];
      if (!completedTurn) {
        prepareAllState!.initialWorldRequestRunning = false;
        const failure = compilerBatchFailure(outcome);
        if (failure) {
          const rejected = prepareAllState!.initialWorldBatchId
            ? await rejectPendingCompilerBatchProposals(workspace.root, prepareAllState!.initialWorldBatchId!)
            : [];
          ctx.ui.notify(`Opening-state compiler did not complete (${failure}); converging any valid drafts before fallback.`, "warning");
          if (rejected.length) ctx.ui.notify(`Rejected ${rejected.length} partial opening-state proposal(s); incomplete model turns cannot enter canonical truth.`, "warning");
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
            ctx.ui.notify(
              `Compiler batch ${completedTurn.batch.ordinal + 1} was interrupted by the provider (${failure}); retrying automatically ${retries + 1}/${MAX_PREPARE_ALL_PROVIDER_RETRIES}.`,
              "warning",
            );
            await advancePrepareAll(ctx);
            return;
          }
        }
        pendingTurn = undefined;
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
      await markSourceLoopBatchComplete(workspace.root, completedTurn.source.id, completedTurn.batch.id);
      ctx.ui.notify(
        completedTurn.remainingAfterBatch > 0
          ? `Compiler batch ${completedTurn.completedBatches + 1}/${completedTurn.totalBatches} checkpointed · ${completedTurn.remainingAfterBatch} remaining · /compile-next to continue`
          : `All ${completedTurn.totalBatches} compiler batches for ${completedTurn.source.title} are checkpointed.`,
        "info",
      );
      if (prepareAllState) await advancePrepareAll(ctx);
    });

    pi.on("session_start", async (_event, ctx) => {
      if (ctx.mode !== "tui") return;
      const modeLabel = mode === "compiler" ? "compiler proposals" : "read-only assistant";
      const terminalTitle = `NWH — ${path.basename(workspace.root)}`;
      ctx.ui.setTitle(terminalTitle);
      const titleTimer = setTimeout(() => ctx.ui.setTitle(terminalTitle), 0);
      titleTimer.unref();
      ctx.ui.setWorkingMessage(mode === "compiler" ? "Building evidence-backed proposals..." : "Consulting local evidence...");
      ctx.ui.setWorkingIndicator({ frames: NWH_WORKING_FRAMES, intervalMs: 180 });
      ctx.ui.setHiddenThinkingLabel("Thinking hidden · Ctrl+T to show");
      ctx.ui.setStatus("nwh-mode", ctx.ui.theme.fg("dim", `NWH · ${modeLabel}`));
      const freshConversation = isFreshConversation(ctx.sessionManager.getEntries());
      ctx.ui.setHeader((tui, theme) => createNwhWelcomeHeader(tui, theme, { mode, freshConversation }));
      if (mode === "assistant") {
        const catalog = await inspectPlayExperience(workspace.root);
        if (catalog.activeSession) {
          try {
            await activatePlayer(ctx, {
              branchId: catalog.activeSession.branchId,
              ...(catalog.activeSession.sourceId ? { source: catalog.activeSession.sourceId } : {}),
              character: catalog.activeSession.actorId,
            });
          } catch (error) {
            ctx.ui.notify(`Saved play session is unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
          }
        } else if (catalog.instances.length) {
          ctx.ui.setStatus("nwh-mode", ctx.ui.theme.fg("dim", `NWH · ${catalog.instances.length} world instance(s) ready · /play to choose`));
        }
      }
    });

    pi.registerCommand("novels", {
      description: "List registered novels in this workspace",
      handler: async (_args, ctx) => ctx.ui.notify(formatNovels(await inspectPlayExperience(workspace.root)), "info"),
    });

    pi.registerCommand("instances", {
      description: "List playable world instances and progress",
      handler: async (_args, ctx) => ctx.ui.notify(formatInstances((await inspectPlayExperience(workspace.root)).instances), "info"),
    });

    pi.registerCommand("characters", {
      description: "List committed characters at an instance head",
      handler: async (args, ctx) => {
        const [requestedBranchId, requestedSource] = splitCommandArguments(args);
        const catalog = await inspectPlayExperience(workspace.root);
        const sourceId = catalog.novels.length || requestedSource
          ? await choosePlayNovel(catalog, requestedSource, createTuiUserQuestion(ctx.ui), { preferActive: false })
          : undefined;
        if (catalog.novels.length && !sourceId) return;
        const branchId = await choosePlayInstance(
          workspace.root,
          requestedBranchId,
          createTuiUserQuestion(ctx.ui),
          catalog,
        );
        if (!branchId) return;
        const result = await listPlayableCharacters(workspace.root, {
          branchId,
          ...(sourceId ? { source: sourceId } : {}),
        });
        ctx.ui.notify(formatCharacters(result.characters, result.branchId, result.source?.title), "info");
      },
    });

    pi.registerCommand("play", {
      description: "Choose a novel, then choose or name a character",
      handler: async (args, ctx) => {
        const [character, branchId, source] = splitCommandArguments(args);
        await activatePlayer(ctx, {
          ...(branchId ? { branchId } : {}),
          ...(character ? { character } : {}),
          ...(source ? { source } : {}),
          preferActiveSource: false,
          preferSavedCharacter: false,
        });
      },
    });

    pi.registerCommand("world-resume", {
      description: "Resume the saved or named playable instance",
      handler: async (args, ctx) => {
        const [branchId, character, source] = splitCommandArguments(args);
        await activatePlayer(ctx, {
          ...(branchId ? { branchId } : {}),
          ...(character ? { character } : {}),
          ...(source ? { source } : {}),
        });
      },
    });

    pi.registerCommand("progress", {
      description: "Show committed progress for a playable instance",
      handler: async (args, ctx) => {
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
      },
    });

    pi.registerCommand("leave", {
      description: "Leave player mode while keeping resume state",
      handler: async (_args, ctx) => {
        playerMode = false;
        selectedPlay = undefined;
        const modeLabel = compilerToolsActive && mode === "assistant" ? "world compiler loop" : "read-only assistant";
        ctx.ui.setStatus("nwh-mode", ctx.ui.theme.fg("dim", `NWH · ${modeLabel}`));
        ctx.ui.setWorkingMessage("Consulting local evidence...");
        ctx.ui.notify("Left player mode. The selected instance and character remain saved; use /world-resume to return.", "info");
      },
    });

    pi.registerCommand("files", {
      description: "List safe local workspace files",
      handler: async (args, ctx) => {
        const files = await workspace.listFiles({ pattern: args.trim() || undefined });
        ctx.ui.notify(files.length ? files.join("\n") : "No matching files.", "info");
      },
    });

    pi.registerCommand("search", {
      description: "Search local files for fixed text",
      handler: async (args, ctx) => {
        const query = args.trim();
        if (!query) throw new Error("Usage: /search <text>");
        const matches = await workspace.searchFiles({ query });
        ctx.ui.notify(matches.length ? matches.join("\n") : "No matches.", "info");
      },
    });

    pi.registerCommand("read", {
      description: "Read a bounded local file range",
      handler: async (args, ctx) => {
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
        if (pendingTurn || prepareAllState || taskRunning()) {
          ctx.ui.notify("A novel preparation run is already active.", "warning");
          return;
        }
        if (!args.trim()) throw new Error("Usage: /prepare-content <novel text>");
        const content = args;
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
        activateCompilerTools(ctx);
        await beginTurn(preparation);
        ctx.ui.notify(`Archived pasted content as ${preparation.source.id} · starting batch 1/${preparation.totalBatches}.`, "info");
        pi.sendMessage({
          customType: "nwh-compiler-batch",
          content: `${compilerPromptForTurn(preparation)}\n\n${preparation.prompt}`,
          display: false,
        }, { triggerTurn: true });
      },
    });

    pi.registerCommand("compile-next", {
      description: "Process the next evidence batch for the active novel",
      handler: async (_args, ctx) => {
        if (pendingTurn || prepareAllState || taskRunning()) {
          ctx.ui.notify("A novel preparation run is already active.", "warning");
          return;
        }
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
        activateCompilerTools(ctx);
        await beginTurn(preparation);
        ctx.ui.notify(`Starting compiler batch ${preparation.completedBatches + 1}/${preparation.totalBatches} for ${preparation.source.title}.`, "info");
        // Host-generated compiler context must never be represented as a user
        // message: doing so replaces the visible slash-command transcript.
        pi.sendMessage({
          customType: "nwh-compiler-batch",
          content: `${compilerPromptForTurn(preparation)}\n\n${preparation.prompt}`,
          display: false,
        }, { triggerTurn: true });
      },
    });

    pi.registerCommand("prepare-all", {
      description: "Complete compilation, accept validated proposals and create a playable branch",
      handler: async (args, ctx) => {
        if (pendingTurn || prepareAllState || taskRunning()) {
          ctx.ui.notify("A compiler or full-preparation run is already active.", "warning");
          return;
        }
        const [requestedSourceId, requestedBranchId] = splitCommandArguments(args);
        const branchId = requestedBranchId || "main";
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
        activeSourceId = sourceId;
        const source = inspection.source ?? await (await WorkspaceStore.create(workspace.root)).getSource(sourceId);
        // A changed source cannot be identified as the immutable cached input.
        // Preserve the audit diagnosis instead of letting cache lookup throw a
        // less useful hash-mismatch error before the repair stage is reported.
        if (source && inspection.stage !== "repair") {
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
          preparedCacheVerified: false,
          providerRetryCounts: new Map(),
        };
        ctx.ui.setStatus("nwh-prepare-all", ctx.ui.theme.fg("dim", "Preparing world"));
        await advancePrepareAll(ctx);
      },
    });

    pi.registerCommand("reparse", {
      description: "Rebuild selected chapters or an entire novel into a new prepared revision",
      handler: async (args, ctx) => {
        if (activeTask?.snapshot.status === "running") {
          ctx.ui.notify(`${activeTask.snapshot.title} is already running; bringing it to the foreground.`, "info");
          await foregroundTask(ctx, activeTask);
          return;
        }
        if (pendingTurn || prepareAllState || taskRunning()) {
          ctx.ui.notify("A compiler or full-preparation run is already active.", "warning");
          return;
        }
        const parsed = parseTuiReparseArguments(args);
        const sourceId = await chooseNovelSourceId(ctx, parsed.source, "Choose a novel to reparse");
        if (!sourceId) {
          ctx.ui.notify("Reparse cancelled.", "info");
          return;
        }
        const store = await WorkspaceStore.create(workspace.root);
        const source = await store.getSource(sourceId);
        if (!source) throw new Error(`Unknown source '${sourceId}'.`);
        const batches = await prepareCompilerBatches(workspace.root, source);
        if (!batches.length) throw new Error(`Source ${source.id} has no compiler batches.`);
        const chapterMap = new Map<number, { title?: string; batches: number }>();
        for (const batch of batches) {
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
        ctx.ui.notify(`Starting reparse for ${source.title}: chapter(s) ${selectedChapters.join(", ")}.`, "info");
        const task = new NwhTask(
          `reparse-${source.id}`,
          `Reparse ${source.title} · chapters ${selectedChapters.join(",")}`,
          "Preparing compiler request",
        );
        activeTask = task;
        const unsubscribe = task.subscribe(() => syncTaskChrome(ctx, task));
        task.start(async () => {
          const selectedModel = parsed.model ?? (ctx.model ? modelLabel(ctx.model) : undefined);
          const result = await runReparse({
            root: workspace.root,
            configPath: path.join(workspace.root, "novel-harness.yaml"),
            sourceId,
            ...(all ? { all: true } : { chapters }),
            ...(selectedModel ? { model: selectedModel } : {}),
            cacheRoot: options.preparedCacheRoot,
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
        if (!activeTask) {
          ctx.ui.notify("No NWH task has been started in this session.", "info");
          return;
        }
        await foregroundTask(ctx, activeTask);
      },
    });

    pi.registerCommand("audit", {
      description: "Audit novel evidence and canonical consistency",
      handler: async (args, ctx) => {
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
      },
    });

    pi.registerCommand("prepared-cache", {
      description: "List or activate prepared novel revisions",
      handler: async (args, ctx) => {
        if (pendingTurn || prepareAllState || taskRunning()) {
          ctx.ui.notify("A compiler or full-preparation run is already active.", "warning");
          return;
        }
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
        const result = await withWorkspaceOperationLock(workspace.root, "compiler", () => preparedCache.activate(source, bundleHash!));
        ctx.ui.notify(`Activated prepared revision ${result.bundleHash} for ${source.title}; existing branches remain pinned.`, "info");
      },
    });

    pi.registerCommand("status", {
      description: "Show NWH workspace and session status",
      handler: async (_args, ctx) => {
        const catalog = await inspectPlayExperience(workspace.root);
        const current = catalog.instances.find((instance) => instance.active);
        ctx.ui.notify([
          `workspace: ${workspace.root}`,
          `state: ${workspaceStateDir(workspace.root)}`,
          `mode: ${playerMode ? "player" : compilerToolsActive && mode === "assistant" ? "world-compiler-loop" : mode}`,
          `active source: ${activeSourceId ?? "none"}`,
          `registered novels: ${catalog.novels.length}`,
          `playable instances: ${catalog.instances.length}`,
          `current play: ${current ? `${current.actorName ?? current.actorId ?? "no character"}@${current.branchId} step ${current.logicalStep}` : "none"}`,
          `model: ${modelLabel(ctx.model)}`,
          `session: ${ctx.sessionManager.getSessionId()}`,
          `entries: ${ctx.sessionManager.getEntries().length}`,
          `persistence: ${saveSession ? "on" : "off"}`,
          `task: ${activeTask ? taskSummary(activeTask) : "none"}`,
        ].join("\n"), "info");
      },
    });

    pi.registerCommand("clear", {
      description: "Start a new NWH conversation",
      handler: async (_args, ctx) => {
        if (pendingTurn || prepareAllState || taskRunning()) {
          ctx.ui.notify("Wait for the active preparation run to finish before clearing the conversation.", "warning");
          return;
        }
        const result = await ctx.newSession();
        if (!result.cancelled) ctx.ui.notify("Conversation history cleared.", "info");
      },
    });

    pi.registerCommand("help", {
      description: "Show NWH commands and key hints",
      handler: async (_args, ctx) => ctx.ui.notify(COMMAND_HELP, "info"),
    });

    pi.registerCommand("exit", {
      description: "Exit NWH",
      handler: async (_args, ctx) => ctx.shutdown(),
    });
  };
}

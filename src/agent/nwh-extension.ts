import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { expandFileMentions } from "./file-mentions.js";
import { createNwhWelcomeHeader, isFreshConversation, NWH_WORKING_FRAMES } from "./nwh-welcome.js";
import {
  createCompilerProposalToolset,
  type CompilerProposalToolset,
} from "../compiler/proposal-tools.js";
import { compilerBatchFailure, compilerBatchOutcomeFromMessages } from "../compiler/batch-outcome.js";
import {
  markSourceLoopBatchComplete,
  prepareNextSourceLoopTurn,
  prepareSourceLoopFromInput,
  type SourceLoopTurn,
} from "../compiler/source-loop.js";
import { LocalFileWorkspace } from "../workspace/local-files.js";
import { SOURCE_BATCH_DISABLED_PROPOSAL_TOOLS } from "../compiler/pi-compiler.js";
import { convergeWorldProposals } from "../compiler/converge.js";
import { inspectPreparation } from "../workflow/prepare.js";
import { InitialWorldStore } from "../world/initial.js";
import { openWorkspaceWorld } from "../world/workspace-runtime.js";

export type NwhInteractionMode = "assistant" | "compiler";

export type NwhExtensionOptions = {
  workspace: LocalFileWorkspace;
  saveSession: boolean;
  mode: NwhInteractionMode;
  onSessionShutdown?: () => Promise<void>;
  resetCompilerProposalTools?: (segmentIds?: readonly string[]) => void;
};

const COMMAND_HELP = `NWH commands:
  /files [path filter]       list safe workspace files
  /search <text>             search local files for fixed text
  /read <path> [start:end]   read a bounded line range
  /compile-next              process the next evidence batch for the active novel
  /prepare-all [source]      finish compilation and create a playable world
  /status                    show workspace, model and session
  /clear                     start a new conversation
  /help                      show this help
  /exit                      end the session

Provider and model:
  /login                     sign in to a provider (subscription/OAuth or API key)
  /logout                    remove provider authentication
  /model                     select a model after signing in

TUI shortcuts:
  Enter send · Shift+Enter newline · Esc interrupt · Ctrl+O expand tools
  /hotkeys shows every shortcut. Prefix ! runs a user shell command.`;

const LOCAL_EVIDENCE_TOOL_NAMES = new Set(["list_files", "search_files", "read_file"]);
const INITIAL_WORLD_PROMPT = `Inspect the registered novel's opening evidence and existing artifact catalog. Propose one evidence-backed initial-world representing only the state already true at the opening. Propose genuinely missing referenced entities or claims first. Do not include later canonical developments.`;

type TuiPrepareAllState = {
  sourceId: string;
  branchId: string;
  compileAllApproved: boolean;
  initialWorldRequestRunning: boolean;
};

export function splitCommandArguments(value: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  return tokens;
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

    const beginTurn = (turn: SourceLoopTurn) => {
      registeredCompilerToolset?.beginBatch(turn.batch.segmentIds);
      options.resetCompilerProposalTools?.(turn.batch.segmentIds);
      compilerCircuitBroken = false;
      pendingTurn = turn;
      pendingRunMessages = [];
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

    const compilerPromptForTurn = (turn: SourceLoopTurn) =>
      `Begin novel-world compiler batch ${turn.completedBatches + 1}/${turn.totalBatches} for ${turn.source.sourcePath}. Analyze the supplied evidence now and record typed pending proposals.`;

    const choose = async <T extends string>(
      ctx: ExtensionContext,
      title: string,
      choices: ReadonlyArray<{ value: T; label: string; description: string; recommended?: boolean }>,
    ): Promise<T | undefined> => {
      const labels = choices.map((choice) =>
        `${choice.label}${choice.recommended ? " (recommended)" : ""} — ${choice.description}`);
      const selected = await ctx.ui.select(title, labels);
      return choices.find((_choice, index) => labels[index] === selected)?.value;
    };

    const stopPrepareAll = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "warning") => {
      prepareAllState = undefined;
      ctx.ui.setStatus("nwh-prepare-all", undefined);
      ctx.ui.notify(message, level);
    };

    const sendHiddenPreparationTurn = (content: string, customType: string) => {
      pi.sendMessage({ customType, content, display: false }, { triggerTurn: true });
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
        beginTurn(preparation);
        ctx.ui.setStatus("nwh-prepare-all", ctx.ui.theme.fg("dim", `Preparing · batch ${preparation.completedBatches + 1}/${preparation.totalBatches}`));
        ctx.ui.notify(`Full preparation: starting compiler batch ${preparation.completedBatches + 1}/${preparation.totalBatches}.`, "info");
        sendHiddenPreparationTurn(compilerPromptForTurn(preparation), "nwh-prepare-all-batch");
        return;
      }
      if (inspection.stage === "review") {
        const decision = await choose(ctx, "Accept validated proposals?", [
          { value: "accept", label: "Accept valid", description: `Validate and commit all ${inspection.pending.length} pending proposals that pass.`, recommended: true },
          { value: "review", label: "Review first", description: "Stop before accepting anything; use proposal CLI commands." },
        ]);
        if (decision !== "accept") {
          stopPrepareAll(ctx, `Full preparation paused for proposal review. Next: ${inspection.next}`, "info");
          return;
        }
        const result = await convergeWorldProposals(workspace.root);
        const blocked = result.canonical.blocked.length + result.possibilities.blocked.length;
        if (blocked || result.staging.length) {
          stopPrepareAll(
            ctx,
            `Full preparation stopped: ${blocked} validation-blocked and ${result.staging.length} staging-only proposal(s). Run nwh proposals list for details.`,
            "error",
          );
          return;
        }
        ctx.ui.notify(`Accepted ${result.canonical.accepted.length + result.possibilities.accepted.length} validated proposal(s).`, "info");
        await advancePrepareAll(ctx);
        return;
      }
      if (inspection.stage === "needs-initial-world") {
        if (state.initialWorldRequestRunning) {
          stopPrepareAll(ctx, "The opening-state compiler did not produce an acceptable initial-world proposal. Review the model output and retry /prepare-all.", "error");
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
        registeredCompilerToolset?.beginBatch();
        options.resetCompilerProposalTools?.();
        compilerCircuitBroken = false;
        state.initialWorldRequestRunning = true;
        ctx.ui.setStatus("nwh-prepare-all", ctx.ui.theme.fg("dim", "Preparing · opening world"));
        sendHiddenPreparationTurn(INITIAL_WORLD_PROMPT, "nwh-prepare-all-initial-world");
        return;
      }
      if (inspection.stage === "create-branch") {
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
        stopPrepareAll(ctx, `Preparation complete. Run nwh play-world --branch ${state.branchId} --list-characters to enter the world.`, "info");
        return;
      }
      stopPrepareAll(ctx, `Full preparation stopped at '${inspection.stage}'. Next: ${inspection.next}`, inspection.stage === "repair" ? "error" : "warning");
    };

    pi.on("session_shutdown", async () => options.onSessionShutdown?.());

    pi.on("tool_call", (event) => {
      if (compilerCircuitBroken) {
        return {
          block: true,
          reason: "The compiler finish circuit breaker opened; this batch turn is stopping without a checkpoint.",
          terminate: true,
        };
      }
      if (!pendingTurn || !LOCAL_EVIDENCE_TOOL_NAMES.has(event.toolName)) return;
      return {
        block: true,
        reason: "This compiler batch may use only the evidence slice supplied by the host; workspace file tools are disabled until the batch settles.",
      };
    });

    pi.on("tool_result", (event) => {
      if (event.toolName !== "finish_compiler_batch") return;
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

      try {
        const preparation = await prepareSourceLoopFromInput(workspace.root, event.text);
        if (preparation) {
          activeSourceId = preparation.source.id;
          if (preparation.status === "complete") {
            ctx.ui.notify(`${preparation.source.title} is already fully processed (${preparation.totalBatches} batches).`, "info");
            return { action: "handled" };
          }
          activateCompilerTools(ctx);
          beginTurn(preparation);
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

    pi.on("agent_end", (event) => {
      if (!pendingTurn) return;
      // agent_end is per low-level run. Keep every run until agent_settled so
      // provider retries, compaction retries, and queued continuations cannot
      // erase an earlier unresolved proposal failure or finish handshake.
      pendingRunMessages.push(...event.messages);
    });

    pi.on("agent_settled", async (_event, ctx) => {
      compilerCircuitBroken = false;
      const completedTurn = pendingTurn;
      if (!completedTurn) {
        if (prepareAllState?.initialWorldRequestRunning) await advancePrepareAll(ctx);
        return;
      }
      pendingTurn = undefined;
      const outcome = compilerBatchOutcomeFromMessages(pendingRunMessages);
      pendingRunMessages = [];
      const failure = compilerBatchFailure(outcome);
      if (failure) {
        const wasPreparingAll = Boolean(prepareAllState);
        ctx.ui.notify(
          `Compiler batch ${completedTurn.batch.ordinal + 1} was not checkpointed (${failure}); /compile-next retries the same evidence.`,
          "warning",
        );
        if (wasPreparingAll) stopPrepareAll(ctx, "Full preparation stopped because the compiler batch did not complete. Retry /prepare-all to resume.");
        return;
      }
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
      ctx.ui.setHiddenThinkingLabel("Reasoning");
      ctx.ui.setStatus("nwh-mode", ctx.ui.theme.fg("dim", `NWH · ${modeLabel}`));
      const freshConversation = isFreshConversation(ctx.sessionManager.getEntries());
      ctx.ui.setHeader((tui, theme) => createNwhWelcomeHeader(tui, theme, { mode, freshConversation }));
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

    pi.registerCommand("compile-next", {
      description: "Process the next evidence batch for the active novel",
      handler: async (_args, ctx) => {
        if (pendingTurn || prepareAllState) {
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
          ctx.ui.notify(`${preparation.source.title} is already fully processed (${preparation.totalBatches} batches).`, "info");
          return;
        }
        activateCompilerTools(ctx);
        beginTurn(preparation);
        ctx.ui.notify(`Starting compiler batch ${preparation.completedBatches + 1}/${preparation.totalBatches} for ${preparation.source.title}.`, "info");
        pi.sendUserMessage(compilerPromptForTurn(preparation));
      },
    });

    pi.registerCommand("prepare-all", {
      description: "Complete compilation, accept validated proposals and create a playable branch",
      handler: async (args, ctx) => {
        if (pendingTurn || prepareAllState) {
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
          sourceId = await choose(ctx, "Choose a novel source", choices);
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
        prepareAllState = {
          sourceId,
          branchId,
          compileAllApproved: false,
          initialWorldRequestRunning: false,
        };
        ctx.ui.setStatus("nwh-prepare-all", ctx.ui.theme.fg("dim", "Preparing world"));
        await advancePrepareAll(ctx);
      },
    });

    pi.registerCommand("status", {
      description: "Show NWH workspace and session status",
      handler: async (_args, ctx) => {
        ctx.ui.notify([
          `workspace: ${workspace.root}`,
          `mode: ${compilerToolsActive && mode === "assistant" ? "world-compiler-loop" : mode}`,
          `active source: ${activeSourceId ?? "none"}`,
          `model: ${modelLabel(ctx.model)}`,
          `session: ${ctx.sessionManager.getSessionId()}`,
          `entries: ${ctx.sessionManager.getEntries().length}`,
          `persistence: ${saveSession ? "on" : "off"}`,
        ].join("\n"), "info");
      },
    });

    pi.registerCommand("clear", {
      description: "Start a new NWH conversation",
      handler: async (_args, ctx) => {
        if (pendingTurn || prepareAllState) {
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

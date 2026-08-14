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
  prepareSourceLoopFromContent,
  prepareSourceLoopFromInput,
  type SourceLoopTurn,
} from "../compiler/source-loop.js";
import { LocalFileWorkspace } from "../workspace/local-files.js";
import { SOURCE_BATCH_DISABLED_PROPOSAL_TOOLS } from "../compiler/pi-compiler.js";
import { prepareOpeningWorldCompilerBatch, proposeMinimalOpeningWorld } from "../compiler/batches.js";
import { rejectPendingCompilerBatchProposals } from "../compiler/proposals.js";
import { convergeWorldProposals, quarantineUncommittableProposals } from "../compiler/converge.js";
import { inspectPreparation } from "../workflow/prepare.js";
import { InitialWorldStore } from "../world/initial.js";
import { openWorkspaceWorld } from "../world/workspace-runtime.js";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { workspaceStateDir } from "./runtime-paths.js";

export type NwhInteractionMode = "assistant" | "compiler";

export type NwhExtensionOptions = {
  workspace: LocalFileWorkspace;
  saveSession: boolean;
  mode: NwhInteractionMode;
  onSessionShutdown?: () => Promise<void>;
  resetCompilerProposalTools?: (segmentIds?: readonly string[], compilerBatchId?: string, sourceId?: string) => Promise<void> | void;
  preparedCacheRoot?: string;
};

const COMMAND_HELP = `NWH commands:
  /files [path filter]       list safe workspace files
  /search <text>             search local files for fixed text
  /read <path> [start:end]   read a bounded line range
  /prepare-content <text>    archive and compile pasted novel text
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
  initialWorldAttempted: boolean;
  initialWorldBatchId?: string;
  preparedCacheVerified: boolean;
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
    const preparedCache = new PreparedNovelCache(workspace.root, options.preparedCacheRoot);

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
        ctx.ui.setStatus("nwh-prepare-all", ctx.ui.theme.fg("dim", `Preparing · batch ${preparation.completedBatches + 1}/${preparation.totalBatches}`));
        ctx.ui.notify(`Full preparation: starting compiler batch ${preparation.completedBatches + 1}/${preparation.totalBatches}.`, "info");
        sendHiddenPreparationTurn(
          ctx,
          `${compilerPromptForTurn(preparation)}\n\n${preparation.prompt}`,
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
        stopPrepareAll(ctx, `Preparation complete. Run nwh play-world --branch ${state.branchId} --list-characters to enter the world.`, "info");
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
            text: "Model batch output ended. NWH is verifying the finish handshake and deriving checkpoint status from host state. All submitted artifacts remain pending proposals until deterministic convergence accepts them.",
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
      pendingTurn = undefined;
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

    pi.registerCommand("prepare-content", {
      description: "Archive pasted novel text and start its compiler loop",
      handler: async (args, ctx) => {
        if (pendingTurn || prepareAllState) {
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
          `state: ${workspaceStateDir(workspace.root)}`,
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

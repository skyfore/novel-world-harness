import { stderr, stdout } from "node:process";
import { formatRetryNotice } from "../agent/pi-session.js";
import type { AgentSessionEvent, TuiMode } from "@earendil-works/pi-coding-agent";
import { createPiCompilerSession } from "../compiler/pi-compiler.js";
import { compilerBatchFailure } from "../compiler/batch-outcome.js";
import { loadConfig, profileForRole } from "../config/load.js";
import { startElapsedStatus } from "../util/elapsed-status.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";

export type CompileCommandOptions = {
  root: string;
  configPath: string;
  allowMissingConfig?: boolean;
  model?: string;
  saveSession?: boolean;
  prompt?: string;
  tuiMode?: TuiMode;
  segmentIds?: readonly string[];
  compilerBatchId?: string;
  sourceId?: string;
  includeLocalTools?: boolean;
  disabledProposalTools?: readonly string[];
  acquireLock?: boolean;
  promptTimeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onStatus?: (message: string) => void;
  onModelText?: (delta: string) => void;
  onModelThinking?: (delta: string) => void;
  onModelToolCall?: (name: string, input: unknown) => void;
  onModelToolResult?: (name: string, result: unknown, isError: boolean) => void;
  onModelEvent?: (event: AgentSessionEvent) => void;
};

const COMPILER_PROMPT_TIMEOUT_MS = 10 * 60 * 1_000;

const DEFAULT_COMPILER_PROMPT = `Inspect the novel workspace and build a small, evidence-backed compiler batch. Start by searching and reading relevant source spans. Prefer stable entity proposals first, then claims, world rules, and canonical events whose references can be validated. Use propose_state_delta or propose_possibility only when they are useful staging artifacts. Do not attempt to commit anything and do not describe pending proposals as truth.`;

async function optionalConfig(options: CompileCommandOptions) {
  try {
    return await loadConfig(options.configPath);
  } catch (error) {
    if (options.allowMissingConfig && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function compileCommand(options: CompileCommandOptions): Promise<void> {
  options.signal?.throwIfAborted();
  if (options.acquireLock !== false) {
    return withWorkspaceOperationLock(options.root, "compiler", () =>
      compileCommand({ ...options, acquireLock: false }));
  }
  const config = await optionalConfig(options);
  const profile = config ? profileForRole(config, "controller").profile : undefined;
  const printMode = options.prompt !== undefined;
  let wroteText = false;
  let reasoningStreamed = false;
  let elapsed: ReturnType<typeof startElapsedStatus> | undefined;
  const session = await createPiCompilerSession({
    root: options.root,
    ...(profile ? { profile } : {}),
    ...(options.model ? { model: options.model } : {}),
    saveSession: options.saveSession ?? true,
    ...(options.segmentIds ? { segmentIds: options.segmentIds } : {}),
    ...(options.compilerBatchId ? { compilerBatchId: options.compilerBatchId } : {}),
    ...(options.sourceId ? { sourceId: options.sourceId } : {}),
    ...(options.includeLocalTools !== undefined ? { includeLocalTools: options.includeLocalTools } : {}),
    ...(options.disabledProposalTools ? { disabledProposalTools: options.disabledProposalTools } : {}),
    ...(printMode ? { onRetry(event) {
      const message = formatRetryNotice(event);
      elapsed?.update(`retrying model request: ${message}`);
      if (options.onProgress) options.onProgress(message);
      else stderr.write(`\n${message}\n`);
    } } : {}),
    ...(printMode ? { onText(delta: string) {
      if (!wroteText) {
        if (!options.onModelEvent) {
          const message = "Compiler prompt model text stream started (unverified; not committed world truth).";
          if (options.onProgress) options.onProgress(message);
          else stderr.write(`${message}\n`);
        }
      }
      wroteText = true;
      elapsed?.update("receiving unverified model text");
      if (options.onModelText) options.onModelText(delta);
      else stdout.write(delta);
    } } : {}),
    ...(printMode ? { onThinking(delta: string) {
      if (!reasoningStreamed) {
        reasoningStreamed = true;
        if (!options.onModelEvent) {
          const message = "Compiler prompt provider reasoning stream started (content hidden).";
          if (options.onProgress) options.onProgress(message);
          else stderr.write(`${message}\n`);
        }
      }
      elapsed?.update("receiving model reasoning stream");
      options.onModelThinking?.(delta);
    } } : {}),
    ...(printMode ? { onTool(name: string, input: unknown) {
      const details = input as Record<string, unknown>;
      const message = `↳ ${name}${details.proposal_id ? ` ${String(details.proposal_id)}` : ""}`;
      elapsed?.update(`last tool call ${name}${details.proposal_id ? ` ${String(details.proposal_id)}` : ""}`);
      if (!options.onModelEvent) {
        if (options.onProgress) options.onProgress(message);
        else stderr.write(`\n${message}\n`);
      }
      options.onModelToolCall?.(name, input);
    } } : {}),
    ...(printMode ? { onToolResult(name: string, result: unknown, isError: boolean) {
      options.onModelToolResult?.(name, result, isError);
    } } : {}),
    ...(options.onModelEvent ? { onEvent: options.onModelEvent } : {}),
  });
  const abortSession = () => { void session.abort(); };
  options.signal?.addEventListener("abort", abortSession, { once: true });
  try {
    options.signal?.throwIfAborted();
    if (options.prompt !== undefined) {
      elapsed = startElapsedStatus({
        label: "Compiler prompt",
        activity: "waiting for model response or tool call",
        onStatus: options.onStatus,
        onHeartbeat: options.onProgress ?? ((message) => stderr.write(`${message}\n`)),
      });
      const report = await session.promptWithReport(options.prompt.trim() || DEFAULT_COMPILER_PROMPT, {
        timeoutMs: options.promptTimeoutMs ?? COMPILER_PROMPT_TIMEOUT_MS,
      });
      elapsed.stop("model response received; verifying finish handshake");
      if (!wroteText && report.text) {
        if (options.onModelText) options.onModelText(report.text);
        else if (!options.onModelEvent) stdout.write(report.text);
        wroteText = true;
      }
      const failure = compilerBatchFailure(report);
      if (failure) throw new Error(`Compiler prompt was not completed: ${failure}.`);
      if (wroteText && !options.onModelText && !options.onModelEvent) stdout.write("\n");
      return;
    }
    await session.runInteractive({ tuiMode: options.tuiMode, initialMessage: DEFAULT_COMPILER_PROMPT });
  } finally {
    options.signal?.removeEventListener("abort", abortSession);
    elapsed?.stop();
    await session.dispose();
  }
}

import { stderr, stdout } from "node:process";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { formatRetryNotice } from "../agent/pi-session.js";
import { hydrateCompilerBatch, runCompilerBatches } from "../compiler/batches.js";
import type { CompilerBatch } from "../compiler/batches.js";
import { compilerBatchFailure, isRecoverableCompilerBatchInterruption } from "../compiler/batch-outcome.js";
import { createPiCompilerSession } from "../compiler/pi-compiler.js";
import { COMPILER_TOOL_NAMES } from "../compiler/proposal-tools.js";
import { loadConfig, profileForRole } from "../config/load.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { startElapsedStatus } from "../util/elapsed-status.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";

export type CompileSourceOptions = {
  root: string;
  configPath: string;
  allowMissingConfig?: boolean;
  sourceId?: string;
  model?: string;
  maxBatches?: number;
  resume?: boolean;
  batchIds?: readonly string[];
  promptTransform?: (prompt: string, batch: CompilerBatch) => string;
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

const COMPILER_PROMPT_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_COMPILER_BATCH_RECOVERY_RETRIES = 1;

export function isRecoverableCompilerSessionException(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  if (/wall-clock limit|timed? out|timeout/i.test(message)) return true;
  if (error.name === "AbortError") return false;
  return /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|fetch failed|socket hang up|connection reset|temporary network/i.test(message);
}

async function optionalConfig(options: CompileSourceOptions) {
  try {
    return await loadConfig(options.configPath);
  } catch (error) {
    if (options.allowMissingConfig && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function compileSourceCommand(options: CompileSourceOptions): Promise<void> {
  options.signal?.throwIfAborted();
  if (options.acquireLock !== false) {
    return withWorkspaceOperationLock(options.root, "compiler", () =>
      compileSourceCommand({ ...options, acquireLock: false }));
  }
  const store = await WorkspaceStore.create(options.root);
  const sources = await store.listSources();
  if (!sources.length) throw new Error("No ingested sources. Run nwh ingest first.");
  const source = options.sourceId
    ? sources.find((candidate) => candidate.id === options.sourceId)
    : sources.length === 1
      ? sources[0]
      : undefined;
  if (!source) {
    if (options.sourceId) throw new Error(`Unknown source id: ${options.sourceId}`);
    throw new Error(`Multiple sources are registered; specify --source. Available: ${sources.map((item) => item.id).join(", ")}`);
  }

  const config = await optionalConfig(options);
  const profile = config ? profileForRole(config, "extractor").profile : undefined;
  const result = await runCompilerBatches({
    workspaceRoot: options.root,
    source,
    ...(options.maxBatches !== undefined ? { maxBatches: options.maxBatches } : {}),
    resume: options.resume ?? true,
    ...(options.batchIds ? { batchIds: options.batchIds } : {}),
    ...(options.promptTransform ? { promptTransform: options.promptTransform } : {}),
    onProgress(message) {
      if (options.onProgress) options.onProgress(message);
      else stderr.write(`${message}\n`);
    },
    async runner(batch, context) {
      options.signal?.throwIfAborted();
      const label = batch.purpose === "structure-discovery"
        ? `Chapter structure discovery ${batch.ordinal + 1}/${context.totalBatches}`
        : batch.purpose === "boundary-calibration"
          ? `Boundary calibration ${batch.ordinal + 1}/${context.totalBatches}`
          : `Compiler batch ${batch.ordinal + 1}/${context.totalBatches}`;
      let activeBatch = batch;
      for (let attempt = 0; ; attempt += 1) {
        options.onStatus?.(`${label} · creating model session${attempt ? ` · recovery ${attempt}/${MAX_COMPILER_BATCH_RECOVERY_RETRIES}` : ""}`);
        let elapsed: ReturnType<typeof startElapsedStatus> | undefined;
        let modelTextStreamed = false;
        let reasoningStreamed = false;
        const session = await createPiCompilerSession({
          root: options.root,
          ...(profile ? { profile } : {}),
          ...(options.model ? { model: options.model } : {}),
          saveSession: false,
          includeLocalTools: false,
          enableBoundaryCalibration: true,
          segmentIds: activeBatch.segmentIds,
          compilerBatchId: activeBatch.id,
          sourceId: activeBatch.sourceId,
          disabledProposalTools: activeBatch.purpose === "structure-discovery"
            ? COMPILER_TOOL_NAMES.filter((name) => !["configure_chapter_split", "finish_compiler_batch"].includes(name))
            : [
                "configure_chapter_split",
                "propose_initial_world",
                ...(activeBatch.purpose === "boundary-calibration"
                  ? ["peek_adjacent_evidence", "defer_boundary_artifact"]
                  : ["replace_boundary_proposal"]),
              ],
          onRetry(event) {
            const message = formatRetryNotice(event);
            elapsed?.update(`retrying model request: ${message}`);
            if (options.onProgress) options.onProgress(message);
            else stderr.write(`${message}\n`);
          },
          onText(delta) {
            if (!modelTextStreamed) {
              modelTextStreamed = true;
              if (!options.onModelEvent) {
                const message = `${label} model text stream started (unverified; not committed world truth).`;
                if (options.onProgress) options.onProgress(message);
                else stderr.write(`${message}\n`);
              }
            }
            elapsed?.update("receiving unverified model text");
            if (options.onModelText) options.onModelText(delta);
            else stdout.write(delta);
          },
          onThinking(delta) {
            if (!reasoningStreamed) {
              reasoningStreamed = true;
              if (!options.onModelEvent) {
                const message = `${label} provider reasoning stream started (content hidden).`;
                if (options.onProgress) options.onProgress(message);
                else stderr.write(`${message}\n`);
              }
            }
            elapsed?.update("receiving model reasoning stream");
            options.onModelThinking?.(delta);
          },
          onTool(name, input) {
            const details = input as Record<string, unknown>;
            const message = `↳ ${name}${details.proposal_id ? ` ${String(details.proposal_id)}` : ""}`;
            elapsed?.update(`last tool call ${name}${details.proposal_id ? ` ${String(details.proposal_id)}` : ""}`);
            if (!options.onModelEvent) {
              if (options.onProgress) options.onProgress(message);
              else stderr.write(`${message}\n`);
            }
            options.onModelToolCall?.(name, input);
          },
          onToolResult(name, result, isError) {
            options.onModelToolResult?.(name, result, isError);
          },
          onEvent: options.onModelEvent,
        });
        const abortSession = () => { void session.abort(); };
        options.signal?.addEventListener("abort", abortSession, { once: true });
        try {
          options.signal?.throwIfAborted();
          elapsed = startElapsedStatus({
            label,
            activity: attempt ? "recovering current batch after a bounded interruption" : "waiting for model response or tool call",
            onStatus: options.onStatus,
            onHeartbeat: options.onProgress ?? ((message) => stderr.write(`${message}\n`)),
          });
          const report = await session.promptWithReport(activeBatch.prompt, {
            timeoutMs: options.promptTimeoutMs ?? COMPILER_PROMPT_TIMEOUT_MS,
          });
          elapsed.stop("model response received; verifying finish handshake");
          if (!modelTextStreamed && report.text) {
            if (options.onModelText) options.onModelText(report.text);
            else if (!options.onModelEvent) stdout.write(report.text);
            modelTextStreamed = true;
          }
          if (!options.onModelText && !options.onModelEvent && report.text && !report.text.endsWith("\n")) stdout.write("\n");
          const failure = compilerBatchFailure(report);
          if (!failure) {
            const message = `Compiler batch ${batch.ordinal + 1} finish handshake verified; `
              + `${report.proposalSucceeded} active proposal(s) remain pending deterministic convergence.`;
            if (options.onProgress) options.onProgress(message);
            else stdout.write(`${message}\n`);
            return;
          }
          if (attempt < MAX_COMPILER_BATCH_RECOVERY_RETRIES && isRecoverableCompilerBatchInterruption(report)) {
            const message = `Compiler batch ${batch.ordinal + 1} had a recoverable interruption (${failure}); `
              + `retrying the same batch once with its active drafts.`;
            if (options.onProgress) options.onProgress(message);
            else stderr.write(`${message}\n`);
            const hydrated = await hydrateCompilerBatch(options.root, batch);
            activeBatch = {
              ...hydrated,
              prompt: `Batch-recovery attempt ${attempt + 1}/${MAX_COMPILER_BATCH_RECOVERY_RETRIES}. `
                + "Recover the exact active current-batch proposals shown below instead of duplicating them. "
                + "Use concise analysis, then complete the finish handshake.\n\n"
                + hydrated.prompt,
            };
            continue;
          }
          throw new Error(`Compiler batch ${batch.ordinal + 1} was not checkpointed: ${failure}.`);
        } catch (error) {
          // A wall-clock/network failure can be thrown before Pi can produce a
          // CompilerBatchOutcome. Preserve the exact pending drafts and retry
          // this batch once in a fresh session, just like a report-level
          // provider interruption or tool-budget circuit break.
          options.signal?.throwIfAborted();
          if (attempt < MAX_COMPILER_BATCH_RECOVERY_RETRIES && isRecoverableCompilerSessionException(error)) {
            const failure = error instanceof Error ? error.message : String(error);
            const message = `Compiler batch ${batch.ordinal + 1} had a recoverable session interruption (${failure}); `
              + `retrying the same batch once with its active drafts.`;
            if (options.onProgress) options.onProgress(message);
            else stderr.write(`${message}\n`);
            const hydrated = await hydrateCompilerBatch(options.root, batch);
            activeBatch = {
              ...hydrated,
              prompt: `Batch-recovery attempt ${attempt + 1}/${MAX_COMPILER_BATCH_RECOVERY_RETRIES}. `
                + "Recover the exact active current-batch proposals shown below instead of duplicating them. "
                + "Use concise analysis, then complete the finish handshake.\n\n"
                + hydrated.prompt,
            };
            continue;
          }
          throw error;
        } finally {
          options.signal?.removeEventListener("abort", abortSession);
          elapsed?.stop();
          await session.dispose();
        }
      }
    },
  });
  options.signal?.throwIfAborted();
  const summary = `Compiler batches: total=${result.total} completed=${result.completed} skipped=${result.skipped} remaining=${result.remaining}`;
  if (options.onProgress) options.onProgress(summary);
  else stdout.write(`${summary}\n`);
}

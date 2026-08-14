import { stderr, stdout } from "node:process";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { formatRetryNotice } from "../agent/pi-session.js";
import { runCompilerBatches } from "../compiler/batches.js";
import type { CompilerBatch } from "../compiler/batches.js";
import { compilerBatchFailure } from "../compiler/batch-outcome.js";
import { createPiCompilerSession } from "../compiler/pi-compiler.js";
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
  onProgress?: (message: string) => void;
  onStatus?: (message: string) => void;
  onModelText?: (delta: string) => void;
  onModelThinking?: (delta: string) => void;
  onModelToolCall?: (name: string, input: unknown) => void;
  onModelToolResult?: (name: string, result: unknown, isError: boolean) => void;
  onModelEvent?: (event: AgentSessionEvent) => void;
};

const COMPILER_PROMPT_TIMEOUT_MS = 10 * 60 * 1_000;

async function optionalConfig(options: CompileSourceOptions) {
  try {
    return await loadConfig(options.configPath);
  } catch (error) {
    if (options.allowMissingConfig && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function compileSourceCommand(options: CompileSourceOptions): Promise<void> {
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
      const label = `Compiler batch ${batch.ordinal + 1}/${context.totalBatches}`;
      options.onStatus?.(`${label} · creating model session`);
      let elapsed: ReturnType<typeof startElapsedStatus> | undefined;
      let modelTextStreamed = false;
      let reasoningStreamed = false;
      const session = await createPiCompilerSession({
        root: options.root,
        ...(profile ? { profile } : {}),
        ...(options.model ? { model: options.model } : {}),
        saveSession: false,
        includeLocalTools: false,
        segmentIds: batch.segmentIds,
        compilerBatchId: batch.id,
        sourceId: batch.sourceId,
        disabledProposalTools: ["propose_initial_world"],
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
      try {
        elapsed = startElapsedStatus({
          label,
          activity: "waiting for model response or tool call",
          onStatus: options.onStatus,
          onHeartbeat: options.onProgress ?? ((message) => stderr.write(`${message}\n`)),
        });
        const report = await session.promptWithReport(batch.prompt, {
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
        if (failure) throw new Error(`Compiler batch ${batch.ordinal + 1} was not checkpointed: ${failure}.`);
        const message = `Compiler batch ${batch.ordinal + 1} finish handshake verified; `
          + `${report.proposalSucceeded} active proposal(s) remain pending deterministic convergence.`;
        if (options.onProgress) options.onProgress(message);
        else stdout.write(`${message}\n`);
      } finally {
        elapsed?.stop();
        await session.dispose();
      }
    },
  });
  const summary = `Compiler batches: total=${result.total} completed=${result.completed} skipped=${result.skipped} remaining=${result.remaining}`;
  if (options.onProgress) options.onProgress(summary);
  else stdout.write(`${summary}\n`);
}

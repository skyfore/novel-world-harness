import { stderr, stdout } from "node:process";
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
        onText() {
          // Batch prose is model-authored and may not describe persisted state
          // accurately. The host prints a derived checkpoint result below.
        },
        onTool(name, input) {
          const details = input as Record<string, unknown>;
          const message = `↳ ${name}${details.proposal_id ? ` ${String(details.proposal_id)}` : ""}`;
          elapsed?.update(`last tool call ${name}${details.proposal_id ? ` ${String(details.proposal_id)}` : ""}`);
          if (options.onProgress) options.onProgress(message);
          else stderr.write(`${message}\n`);
        },
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

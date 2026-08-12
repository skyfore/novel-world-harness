import { stderr, stdout } from "node:process";
import { runCompilerBatches } from "../compiler/batches.js";
import { compilerBatchFailure } from "../compiler/batch-outcome.js";
import { createPiCompilerSession } from "../compiler/pi-compiler.js";
import { loadConfig, profileForRole } from "../config/load.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import type { PiLiveTestOptions } from "../agent/pi-session.js";

export type CompileSourceOptions = {
  root: string;
  configPath: string;
  allowMissingConfig?: boolean;
  sourceId?: string;
  model?: string;
  maxBatches?: number;
  resume?: boolean;
  liveTest?: PiLiveTestOptions;
};

async function optionalConfig(options: CompileSourceOptions) {
  try {
    return await loadConfig(options.configPath);
  } catch (error) {
    if (options.allowMissingConfig && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function compileSourceCommand(options: CompileSourceOptions): Promise<void> {
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
    onProgress(message) {
      stderr.write(`${message}\n`);
    },
    async runner(batch) {
      let wroteText = false;
      const session = await createPiCompilerSession({
        root: options.root,
        ...(profile ? { profile } : {}),
        ...(options.model ? { model: options.model } : {}),
        saveSession: false,
        segmentIds: batch.segmentIds,
        ...(options.liveTest ? { liveTest: options.liveTest } : {}),
        onText(delta) {
          wroteText = true;
          stdout.write(delta);
        },
        onTool(name, input) {
          const details = input as Record<string, unknown>;
          stderr.write(`↳ ${name}${details.proposal_id ? ` ${String(details.proposal_id)}` : ""}\n`);
        },
      });
      try {
        const report = await session.promptWithReport(batch.prompt);
        const failure = compilerBatchFailure(report);
        if (failure) throw new Error(`Compiler batch ${batch.ordinal + 1} was not checkpointed: ${failure}.`);
        if (wroteText) stdout.write("\n");
      } finally {
        await session.dispose();
      }
    },
  });
  stdout.write(`Compiler batches: total=${result.total} completed=${result.completed} skipped=${result.skipped} remaining=${result.remaining}\n`);
}

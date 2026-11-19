import type { SourceDocument } from "../../storage/workspace-store.js";
import type { StageAgent } from "./agent.js";
import { censusStage } from "./census.js";
import { checkPipelineClosure, type PipelineClosure } from "./closure.js";
import { gapsStage } from "./gaps.js";
import { identityStage } from "./identity.js";
import { observationStage } from "./observation.js";
import { openingStage } from "./opening.js";
import { rosterStage } from "./roster.js";
import { runStage, type PipelineModelStage, type StageContext, type StageDefinition, type StageRunSummary } from "./runner.js";
import { scenesStage } from "./scenes.js";
import { prefixLimit, prepareSourceStage } from "./source-stage.js";
import { PipelineStore, type PipelineRun } from "./store.js";
import { worldStage } from "./world.js";

/**
 * The slim compile chain (design 5.1):
 * source → census → observation → identity → scenes → world → roster → opening → closure
 * then archive / admit and the certification track, driven by compile-novel.
 */
export const PIPELINE_VERSION = 60 as const;
export const PIPELINE_STAGE_ORDER = ["census", "observation", "identity", "scenes", "world", "roster", "opening"] as const satisfies readonly PipelineModelStage[];

export const STAGE_DEFINITIONS: Record<PipelineModelStage, StageDefinition> = {
  census: censusStage, observation: observationStage, identity: identityStage, scenes: scenesStage, world: worldStage, roster: rosterStage, opening: openingStage, gaps: gapsStage,
};

export type PipelineOptions = {
  root: string;
  source: SourceDocument;
  agent: StageAgent;
  generatedBy?: { provider?: string; model?: string };
  throughChapter?: number;
  throughByte?: number;
  runId?: string;
  signal?: AbortSignal;
  report?: (message: string) => void;
  /** Scopes of one stage that may run side by side when their ranges do not overlap (default 1). */
  concurrency?: number;
  /** Model provenance per stage when stages route to different profiles (design 5.9). */
  stageGeneratedBy?: StageContext["stageGeneratedBy"];
};

/** Resolve (and persist) the prefix limit. A later call without a limit reuses the saved one. */
export async function pipelineContext(options: PipelineOptions): Promise<StageContext> {
  const store = new PipelineStore(options.root, options.source.id);
  const chapters = await prepareSourceStage(options.root, options.source);
  const saved = await store.run();
  const explicit = options.throughChapter !== undefined || options.throughByte !== undefined;
  const limit = explicit ? prefixLimit(chapters, options.source.bytes, options) : saved?.limit ?? options.source.bytes;
  const now = new Date().toISOString();
  const run: PipelineRun = { version: 1, sourceId: options.source.id, limit, ...(options.throughChapter ? { throughChapter: options.throughChapter } : saved?.throughChapter && !explicit ? { throughChapter: saved.throughChapter } : {}),
    ...(options.throughByte ? { throughByte: options.throughByte } : saved?.throughByte && !explicit ? { throughByte: saved.throughByte } : {}), startedAt: saved?.startedAt ?? now, updatedAt: now };
  await store.writeRun(run);
  return { root: options.root, sourceId: options.source.id, limit, agent: options.agent, store, runId: options.runId ?? `pipeline-${Date.now().toString(36)}`,
    generatedBy: options.generatedBy ?? {}, ...(options.signal ? { signal: options.signal } : {}), report: options.report ?? (() => undefined),
    ...(options.concurrency ? { concurrency: options.concurrency } : {}), ...(options.stageGeneratedBy ? { stageGeneratedBy: options.stageGeneratedBy } : {}) };
}

export async function runPipelineStage(options: PipelineOptions, stage: PipelineModelStage, scopeIds?: readonly string[]): Promise<StageRunSummary> {
  const ctx = await pipelineContext(options);
  return runStage(STAGE_DEFINITIONS[stage], ctx, scopeIds ? { scopeIds } : {});
}

/** Run the gap loop until a round makes no progress (every remaining item is held or answered). */
export async function runGapLoop(options: PipelineOptions, maxRounds = 5): Promise<StageRunSummary[]> {
  const rounds: StageRunSummary[] = [];
  for (let round = 0; round < maxRounds; round += 1) {
    const summary = await runPipelineStage(options, "gaps");
    rounds.push(summary);
    if (!summary.completed.length) break;
  }
  return rounds;
}

export type PipelineResult = { limit: number; stages: StageRunSummary[]; gaps: StageRunSummary[]; closure: PipelineClosure };

/** Run the whole chain through the prefix, then the gap loop, then closure. Held scopes never stop the chain. */
export async function runPipeline(options: PipelineOptions & { stages?: readonly PipelineModelStage[]; gaps?: boolean }): Promise<PipelineResult> {
  const ctx = await pipelineContext(options);
  const stages: StageRunSummary[] = [];
  for (const stage of options.stages ?? PIPELINE_STAGE_ORDER) {
    options.signal?.throwIfAborted();
    options.report?.(`Pipeline stage ${stage}`);
    stages.push(await runStage(STAGE_DEFINITIONS[stage], ctx));
  }
  const gaps = options.gaps === false ? [] : await runGapLoop(options);
  return { limit: ctx.limit, stages, gaps, closure: await checkPipelineClosure(options.root, options.source.id, ctx.limit) };
}

import crypto from "node:crypto";
import path from "node:path";
import { stdout } from "node:process";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { CompilerBatchStore, prepareCompilerBatches, type CompilerBatch } from "../compiler/batches.js";
import { convergeWorldProposals, quarantineUncommittableProposals } from "../compiler/converge.js";
import { rejectPendingCompilerBatchProposals } from "../compiler/proposals.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { ActorModelStore } from "../world/actors.js";
import { CanonicalModelStore } from "../world/canonical-model.js";
import { pinBranchPreparationContexts } from "../world/context.js";
import { InitialWorldStore } from "../world/initial.js";
import { PossibilityTemplateStore } from "../world/possibility-model.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { compileSourceCommand } from "./compile-source.js";
import { prepareAllCommand } from "./prepare-all.js";

export type ReparseCommandOptions = {
  root: string;
  configPath: string;
  sourceId?: string;
  all?: boolean;
  chapters?: string;
  model?: string;
  cacheRoot?: string;
  acquireLock?: boolean;
  onProgress?: (message: string) => void;
  onStatus?: (message: string) => void;
  onModelText?: (delta: string) => void;
  onModelThinking?: (delta: string) => void;
  onModelToolCall?: (name: string, input: unknown) => void;
  onModelToolResult?: (name: string, result: unknown, isError: boolean) => void;
};

type ReparseDependencies = {
  compileSource: typeof compileSourceCommand;
  finishPreparation: typeof prepareAllCommand;
};

const defaultDependencies: ReparseDependencies = {
  compileSource: compileSourceCommand,
  finishPreparation: prepareAllCommand,
};

export async function reparseCommand(
  options: ReparseCommandOptions,
  dependencyOverrides: Partial<ReparseDependencies> = {},
): Promise<{ sourceId: string; chapters: number[]; previousBundleHash: string; activeBundleHash: string }> {
  const root = path.resolve(options.root);
  if (options.acquireLock !== false) {
    return withWorkspaceOperationLock(root, "compiler", () => reparseCommand({ ...options, root, acquireLock: false }, dependencyOverrides));
  }
  if (Boolean(options.all) === Boolean(options.chapters)) {
    throw new Error("Choose exactly one reparse scope: --all or --chapters <selection>.");
  }
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const report = (message: string) => options.onProgress ? options.onProgress(message) : stdout.write(`${message}\n`);
  const source = await resolveSource(root, options.sourceId);
  const batches = await prepareCompilerBatches(root, source);
  if (!batches.length) throw new Error(`Source ${source.id} has no compiler batches.`);
  const availableChapters = [...new Set(batches.map((batch) => batch.chapterOrdinal))].sort((left, right) => left - right);
  const selectedChapters = options.all
    ? availableChapters
    : parseOrdinalSelection(options.chapters!, availableChapters, "--chapters");
  const selected = batches.filter((batch) => selectedChapters.includes(batch.chapterOrdinal));
  if (!selected.length) throw new Error("The chapter selection did not match any compiler batch.");

  const cache = new PreparedNovelCache(root, options.cacheRoot);
  const selectedBatchIds = selected.map((batch) => batch.id);
  options.onStatus?.("Checking active revision and rollback baseline");
  report("Checking the active prepared revision and rollback baseline.");
  await recoverInterruptedReparse(root, source, batches, selectedBatchIds, cache, report);
  const baseline = await cache.publish(source);
  if (!baseline.bundleHash) throw new Error("Current prepared revision was not published.");
  const previousBundleHash = baseline.bundleHash;
  await pinBranchPreparationContexts(root);
  const runId = `reparse-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
  report(
    `Starting ${options.all ? "whole-novel" : "chapter"} reparse ${runId} for ${source.id}: `
    + `${selected.length} batch(es), chapter(s) ${selectedChapters.join(", ")}.`,
  );

  try {
    options.onStatus?.("Invalidating selected preparation artifacts");
    await new CompilerBatchStore(root).markIncomplete(source.id, selectedBatchIds);
    const invalidated = await invalidatePreparationArtifacts(root, source.id, selected, Boolean(options.all));
    for (const batchId of selectedBatchIds) await rejectPendingCompilerBatchProposals(root, batchId);
    report(`Invalidated ${invalidated} current preparation artifact(s); immutable revisions and branch snapshots were retained.`);

    await dependencies.compileSource({
      root,
      configPath: options.configPath,
      allowMissingConfig: true,
      sourceId: source.id,
      ...(options.model ? { model: options.model } : {}),
      batchIds: selectedBatchIds,
      resume: true,
      acquireLock: false,
      promptTransform: (prompt, batch) => reparsePrompt(prompt, batch, runId, Boolean(options.all)),
      onProgress: report,
      onStatus: options.onStatus,
      onModelText: options.onModelText,
      onModelThinking: options.onModelThinking,
      onModelToolCall: options.onModelToolCall,
      onModelToolResult: options.onModelToolResult,
    });
    options.onStatus?.("Converging validated compiler proposals");
    const convergence = await convergeWorldProposals(root, source.id, {
      onProgress: (progress) => options.onStatus?.(
        `Converging proposals · ${progress.phase} ${progress.processed}/${progress.total}`,
      ),
    });
    const quarantined = await quarantineUncommittableProposals(root, convergence);
    report(
      `Reparse convergence accepted ${convergence.canonical.accepted.length + convergence.possibilities.accepted.length} proposal(s)`
      + ` and quarantined ${quarantined.length} uncommittable draft(s).`,
    );
    options.onStatus?.("Finalizing prepared revision");
    await dependencies.finishPreparation({
      root,
      configPath: options.configPath,
      sourceId: source.id,
      ...(options.model ? { model: options.model } : {}),
      yes: true,
      createBranch: false,
      restoreCache: false,
      acquireLock: false,
      cacheRoot: options.cacheRoot,
      onProgress: report,
      onStatus: options.onStatus,
      onModelText: options.onModelText,
      onModelThinking: options.onModelThinking,
      onModelToolCall: options.onModelToolCall,
      onModelToolResult: options.onModelToolResult,
    });
    const active = await cache.lookup(source);
    if (!active.bundleHash) throw new Error("Reparse completed without an active prepared-cache revision.");
    report(active.bundleHash === previousBundleHash
      ? `Reparse reproduced and reactivated the existing content-identical revision ${active.bundleHash}.`
      : `Activated prepared revision ${active.bundleHash}; previous revision ${previousBundleHash} remains available.`);
    options.onStatus?.("Reparse complete");
    return { sourceId: source.id, chapters: selectedChapters, previousBundleHash, activeBundleHash: active.bundleHash };
  } catch (error) {
    options.onStatus?.(`Reparse failed; restoring revision ${previousBundleHash}`);
    for (const batchId of [...selectedBatchIds, `opening-${batches[0]!.id}`]) {
      await rejectPendingCompilerBatchProposals(root, batchId);
    }
    try {
      await cache.activate(source, previousBundleHash);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Reparse failed and rollback to ${previousBundleHash} also failed.`);
    }
    throw new Error(
      `Reparse failed; current preparation was rolled back to ${previousBundleHash}. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function recoverInterruptedReparse(
  root: string,
  source: SourceDocument,
  batches: readonly CompilerBatch[],
  selectedBatchIds: readonly string[],
  cache: PreparedNovelCache,
  report: (message: string) => void,
): Promise<void> {
  const progress = await new CompilerBatchStore(root).read(source.id);
  const completed = new Set(progress.completedBatchIds);
  const unfinished = batches.filter((batch) => !completed.has(batch.id));
  if (!unfinished.length) return;
  const selected = new Set(selectedBatchIds);
  const outsideSelection = unfinished.filter((batch) => !selected.has(batch.id));
  if (outsideSelection.length) {
    const chapters = [...new Set(outsideSelection.map((batch) => batch.chapterOrdinal))].sort((left, right) => left - right);
    throw new Error(
      `Cannot start reparse while ${outsideSelection.length} unfinished compiler batch(es) exist outside the selected scope `
      + `(chapter(s) ${chapters.join(", ")}). Resume preparation first or include those chapters in this reparse.`,
    );
  }
  const active = await cache.lookup(source);
  if (!active.bundleHash) {
    throw new Error(
      `Cannot recover ${unfinished.length} unfinished selected compiler batch(es): no active prepared revision is available as a rollback baseline. `
      + "Complete preparation before reparsing.",
    );
  }
  report(
    `Detected an interrupted reparse affecting ${unfinished.length} selected batch(es); `
    + `restoring active revision ${active.bundleHash} before retrying.`,
  );
  for (const batchId of [...selectedBatchIds, `opening-${batches[0]!.id}`]) {
    await rejectPendingCompilerBatchProposals(root, batchId);
  }
  await cache.activate(source, active.bundleHash);
  report("Interrupted reparse baseline restored; restarting the selected scope from a clean prepared revision.");
}

export function parseOrdinalSelection(value: string, available: readonly number[], optionName: string): number[] {
  const allowed = new Set(available);
  const selected = new Set<number>();
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) throw new Error(`${optionName} must use comma-separated ordinals or ranges, for example 1,3-5.`);
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start) throw new Error(`${optionName} contains an invalid range: ${part}`);
    for (let ordinal = start; ordinal <= end; ordinal += 1) selected.add(ordinal);
  }
  const unavailable = [...selected].filter((ordinal) => !allowed.has(ordinal)).sort((left, right) => left - right);
  if (unavailable.length) {
    throw new Error(`${optionName} references unavailable chapter(s): ${unavailable.join(", ")}. Available: ${[...allowed].sort((a, b) => a - b).join(", ")}`);
  }
  return [...selected].sort((left, right) => left - right);
}

async function resolveSource(root: string, sourceId?: string): Promise<SourceDocument> {
  const sources = await (await WorkspaceStore.create(root)).listSources();
  if (!sources.length) throw new Error("No ingested sources. Run nwh ingest first.");
  const source = sourceId ? sources.find((candidate) => candidate.id === sourceId) : sources.length === 1 ? sources[0] : undefined;
  if (source) return source;
  if (sourceId) throw new Error(`Unknown source id: ${sourceId}`);
  throw new Error(`Multiple sources are registered; specify --source. Available: ${sources.map((item) => item.id).join(", ")}`);
}

function reparsePrompt(prompt: string, batch: CompilerBatch, runId: string, whole: boolean): string {
  return `Explicit ${whole ? "whole-novel" : "chapter"} reparse run ${runId}; detected chapter ${batch.chapterOrdinal}`
    + `${batch.chapterTitle ? ` (${batch.chapterTitle})` : ""}. Re-evaluate the supplied evidence even when related identities appear in the catalog. `
    + `The host preserved prior immutable revisions for existing branches. Reuse stable payload logical IDs for corrected artifacts, but every newly submitted proposal envelope ID must be unique and end with -${runId}. `
    + `Do not resubmit an unchanged artifact merely to manufacture a revision. Finish this batch normally after the evidence has been reconsidered.\n\n${prompt}`;
}

async function invalidatePreparationArtifacts(
  root: string,
  sourceId: string,
  selectedBatches: readonly CompilerBatch[],
  whole: boolean,
): Promise<number> {
  const selectedSpans = new Set(selectedBatches.flatMap((batch) => batch.evidence.map((reference) => spanKey(reference.span))));
  const shouldInvalidate = (item: { evidence: readonly { span: EvidenceSpanKey }[] }) => {
    if (!item.evidence.length) return false;
    if (whole) return item.evidence.every((reference) => reference.span.sourceId === sourceId);
    return item.evidence.every((reference) => selectedSpans.has(spanKey(reference.span)));
  };
  const canon = new CanonicalModelStore(root);
  const actors = new ActorModelStore(root);
  const possibilities = new PossibilityTemplateStore(root);
  const initial = new InitialWorldStore(root);
  const [entities, claims, events, rules, goals, models, templates, opening] = await Promise.all([
    canon.listEntities(), canon.listClaims(), canon.listEvents(), canon.listRules(),
    actors.listGoals(), actors.listModels(), possibilities.list(), initial.get(),
  ]);
  let count = 0;
  for (const item of entities) if (shouldInvalidate(item)) { await canon.removeCurrent("entities", item.id); count += 1; }
  for (const item of claims) if (shouldInvalidate(item)) { await canon.removeCurrent("claims", item.id); count += 1; }
  for (const item of events) if (shouldInvalidate(item)) { await canon.removeCurrent("events", item.id); count += 1; }
  for (const item of rules) if (shouldInvalidate(item)) { await canon.removeCurrent("rules", item.id); count += 1; }
  for (const item of goals) if (shouldInvalidate(item)) { await actors.removeGoal(item.id); count += 1; }
  for (const item of models) if (shouldInvalidate(item)) { await actors.removeModel(item.actorId); count += 1; }
  for (const item of templates) if (shouldInvalidate(item)) { await possibilities.remove(item.id); count += 1; }
  if (opening && shouldInvalidate(opening)) { await initial.clear(); count += 1; }
  return count;
}

type EvidenceSpanKey = {
  sourceId: string;
  startLine: number;
  endLine: number;
  startByte?: number;
  endByte?: number;
  quoteHash: string;
};

function spanKey(span: EvidenceSpanKey): string {
  return `${span.sourceId}:${span.startByte ?? `line-${span.startLine}`}:${span.endByte ?? `line-${span.endLine}`}:${span.quoteHash}`;
}

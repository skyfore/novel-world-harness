import crypto from "node:crypto";
import path from "node:path";
import { stdout } from "node:process";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SourceAnnotationStore } from "../compiler/annotations.js";
import {
  COMPILER_PIPELINE_VERSION,
  CompilerBatchStore,
  prepareCompilerBatches,
  type CompilerBatch,
} from "../compiler/batches.js";
import { BoundaryCalibrationStore } from "../compiler/boundary-calibration.js";
import { convergeWorldProposals, quarantineUncommittableProposals } from "../compiler/converge.js";
import { EntityResolutionStore } from "../compiler/entity-resolution.js";
import { EventResolutionStore } from "../compiler/event-resolution.js";
import { backfillLegacyExactEvidence } from "../compiler/exact-evidence-backfill.js";
import { PreparedNovelCache, type ActivePreparedNovel } from "../compiler/prepared-cache.js";
import { rejectPendingCompilerSourceProposals } from "../compiler/proposals.js";
import { RepairRunStore, type RepairRun } from "../compiler/repair-run.js";
import { SourceAccountingStore } from "../compiler/source-accounting.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { ProposalStore } from "../world/canonical-model.js";
import { compileSourceCommand } from "./compile-source.js";
import { prepareAllCommand } from "./prepare-all.js";

export type RepairExistingCommandOptions = {
  root: string;
  configPath: string;
  sourceId?: string;
  fromRevision?: string;
  replaceStaging?: boolean;
  model?: string;
  cacheRoot?: string;
  acquireLock?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onStatus?: (message: string) => void;
  onModelText?: (delta: string) => void;
  onModelThinking?: (delta: string) => void;
  onModelToolCall?: (name: string, input: unknown) => void;
  onModelToolResult?: (name: string, result: unknown, isError: boolean) => void;
  onModelEvent?: (event: AgentSessionEvent) => void;
};

export type RepairExistingCommandResult = {
  sourceId: string;
  parentBundleHash: string;
  activeBundleHash: string;
  runId: string;
  resumed: boolean;
  replacedProposalIds: string[];
};

type RepairExistingDependencies = {
  compileSource: typeof compileSourceCommand;
  finishPreparation: typeof prepareAllCommand;
  converge: typeof convergeWorldProposals;
};

const defaultDependencies: RepairExistingDependencies = {
  compileSource: compileSourceCommand,
  finishPreparation: prepareAllCommand,
  converge: convergeWorldProposals,
};

/**
 * Fork one immutable prepared revision into a resumable working repair.
 *
 * The parent revision remains immutable and active while proposals are staged.
 * A successful finalization publishes the materialized repair as a new active
 * content-addressed revision. A failed or interrupted run keeps its journal and
 * checkpoints so an expensive source review can resume in place.
 */
export async function repairExistingCommand(
  options: RepairExistingCommandOptions,
  dependencyOverrides: Partial<RepairExistingDependencies> = {},
): Promise<RepairExistingCommandResult> {
  options.signal?.throwIfAborted();
  const root = path.resolve(options.root);
  if (options.acquireLock !== false) {
    return withWorkspaceOperationLock(root, "compiler", () =>
      repairExistingCommand({ ...options, root, acquireLock: false }, dependencyOverrides));
  }

  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const report = (message: string) => options.onProgress ? options.onProgress(message) : stdout.write(`${message}\n`);
  const source = await resolveSource(root, options.sourceId);
  const cache = new PreparedNovelCache(root, options.cacheRoot);
  const runStore = new RepairRunStore(root);
  const batchStore = new CompilerBatchStore(root);
  let run = await runStore.read(source.id);
  const resumed = Boolean(run);
  let replacedProposalIds: string[] = [];

  const activeBefore = await cache.lookup(source);
  const baselineBundleHash = run?.baselineBundleHash
    ?? options.fromRevision
    ?? activeBefore.bundleHash;
  if (!baselineBundleHash) {
    throw new Error(
      `Cannot fork a repair for ${source.id}: no prepared revision is active. `
      + "Publish preparation first, or copy a bundle hash from `nwh prepared-cache list --source "
      + `${source.id}\` and retry once with --from-revision <bundle-hash>.`,
    );
  }
  if (run && options.fromRevision && options.fromRevision !== run.baselineBundleHash) {
    throw new Error(
      `Repair ${run.runId} already forks ${run.baselineBundleHash}; --from-revision ${options.fromRevision} conflicts with its durable journal. `
      + `Resume with --from-revision ${run.baselineBundleHash}; do not guess or retry unchanged.`,
    );
  }

  const parent = await cache.loadRevision(source, baselineBundleHash, { allowIncompatible: true });
  if (!parent) {
    throw new Error(
      `Prepared revision ${baselineBundleHash} was not found for ${source.id}. `
      + `Run \`nwh prepared-cache list --source ${source.id}\`, copy an exact bundle hash from its second column, and retry once; do not guess.`,
    );
  }

  if (run) {
    await validateRepairResume(root, source, parent, run, cache);
    const active = await cache.lookup(source);
    if (active.bundleHash !== run.baselineBundleHash) {
      if (run.phase === "finalizing" && active.bundleHash && !active.requiresReparse) {
        const difference = await cache.workspaceDifferenceFromRevision(source, active.bundleHash);
        if (!difference) {
          await runStore.remove(source.id);
          report(`Repair ${run.runId} had already published revision ${active.bundleHash}; cleared its completed journal.`);
          return {
            sourceId: source.id,
            parentBundleHash: run.baselineBundleHash,
            activeBundleHash: active.bundleHash,
            runId: run.runId,
            resumed: true,
            replacedProposalIds,
          };
        }
      }
      throw new Error(
        `Cannot resume repair ${run.runId}: active revision changed from parent ${run.baselineBundleHash} `
        + `to ${active.bundleHash ?? "missing"}. The repair journal was preserved; inspect prepared-cache history and do not retry unchanged.`,
      );
    }
    const foreignProposalIds = (await pendingSourceProposalIds(root, source))
      .filter((id) => !id.endsWith(`-${run!.runId}`));
    if (foreignProposalIds.length) {
      throw new Error(
        `Cannot resume repair ${run.runId}: pending proposal(s) do not belong to this repair namespace: `
        + `${foreignProposalIds.join(", ")}. The journal and proposals were preserved; review the conflict and do not retry unchanged.`,
      );
    }
    report(`Resuming historical-revision repair ${run.runId} from parent ${run.baselineBundleHash} (${run.phase}).`);
  } else {
    options.onStatus?.("Checking historical revision fork conflicts");
    const conflicts = await forkConflicts(root, source, parent, activeBefore, cache);
    if (conflicts.length) {
      for (const conflict of conflicts) report(`Fork conflict: ${conflict}`);
      if (!options.replaceStaging) {
        throw new Error(
          `Historical revision ${baselineBundleHash} conflicts with the current compiler staging area. `
          + "No state was replaced. Review the conflicts, then run "
          + `\`nwh repair-existing --source ${source.id} --from-revision ${baselineBundleHash} --replace-staging\` `
          + "to preserve pending drafts in rejected history and make that revision the repair parent.",
        );
      }
    }

    if (options.replaceStaging) {
      replacedProposalIds = await rejectPendingCompilerSourceProposals(root, source.id, {
        code: "SOURCE_REPAIR_FORK_REPLACEMENT",
        message: `Pending proposal was displaced when repair fork ${baselineBundleHash} replaced the current staging area for source ${source.id}.`,
      });
      if (replacedProposalIds.length) {
        report(`Preserved ${replacedProposalIds.length} displaced pending proposal(s) in rejected history: ${replacedProposalIds.join(", ")}.`);
      }
    }

    options.signal?.throwIfAborted();
    options.onStatus?.(`Materializing historical revision ${baselineBundleHash}`);
    await cache.activate(source, baselineBundleHash, { allowIncompatibleRollback: true });
    await new BoundaryCalibrationStore(root).reset(source.id);
    const difference = await cache.workspaceDifferenceFromRevision(source, baselineBundleHash);
    if (difference) {
      throw new Error(`Historical revision ${baselineBundleHash} did not materialize exactly: ${difference}`);
    }

    const { sourceReviewBatchIds } = await validateRepairLayout(root, source, parent);
    await batchStore.markIncomplete(source.id, sourceReviewBatchIds);
    const now = new Date().toISOString();
    run = {
      version: 1,
      sourceId: source.id,
      baselineBundleHash,
      runId: `repair-${now.replace(/\D/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`,
      pipelineVersion: COMPILER_PIPELINE_VERSION,
      batchIds: sourceReviewBatchIds,
      phase: "compiling",
      startedAt: now,
      updatedAt: now,
    };
    await runStore.write(run);
    report(
      `Forked immutable revision ${baselineBundleHash} into repair ${run.runId}; `
      + `${sourceReviewBatchIds.length} source-review batch(es) will reuse its existing artifacts.`,
    );
  }

  // TypeScript cannot retain the assignment made by the mutually exclusive
  // journal branches above without this explicit invariant check.
  if (!run) throw new Error("Repair journal was not initialized.");
  const repair = run;
  const resumeCommand = `nwh repair-existing --source ${source.id} --from-revision ${repair.baselineBundleHash}`;

  try {
    options.signal?.throwIfAborted();
    options.onStatus?.(`Repairing ${repair.batchIds.length} source-review batch(es)`);
    await dependencies.compileSource({
      root,
      configPath: options.configPath,
      allowMissingConfig: true,
      sourceId: source.id,
      ...(options.model ? { model: options.model } : {}),
      batchIds: repair.batchIds,
      resume: true,
      acquireLock: false,
      signal: options.signal,
      promptTransform: (prompt, batch) => repairPrompt(prompt, batch, repair),
      onProgress: report,
      onStatus: options.onStatus,
      onModelText: options.onModelText,
      onModelThinking: options.onModelThinking,
      onModelToolCall: options.onModelToolCall,
      onModelToolResult: options.onModelToolResult,
      onModelEvent: options.onModelEvent,
    });
    options.signal?.throwIfAborted();

    const progress = await batchStore.read(source.id);
    const completed = new Set(progress.completedBatchIds);
    const unfinished = repair.batchIds.filter((id) => !completed.has(id));
    if (unfinished.length) {
      throw new Error(`Compiler returned with ${unfinished.length} repair batch(es) unfinished: ${unfinished.join(", ")}.`);
    }

    options.onStatus?.("Converging repair proposals");
    const convergence = await dependencies.converge(root, source.id, {
      onProgress: (progress) => options.onStatus?.(
        `Converging repair proposals · ${progress.phase} ${progress.processed}/${progress.total}`,
      ),
    });
    const quarantined = await quarantineUncommittableProposals(root, convergence);
    report(
      `Repair convergence accepted ${convergence.canonical.accepted.length + convergence.possibilities.accepted.length} proposal(s)`
      + ` and preserved ${quarantined.length} uncommittable draft(s) in rejected history.`,
    );

    options.onStatus?.("Backfilling exact evidence for retained legacy artifacts");
    const exactBackfill = await backfillLegacyExactEvidence(root, source.id, repair.runId);
    report(
      `Backfilled exact evidence for ${exactBackfill.created.length} retained artifact(s)`
      + (exactBackfill.skipped.length
        ? `; ${exactBackfill.skipped.length} artifact(s) remain fail-closed for explicit review.`
        : "."),
    );

    const finalizing: RepairRun = { ...repair, phase: "finalizing", updatedAt: new Date().toISOString() };
    await runStore.write(finalizing);
    options.signal?.throwIfAborted();
    options.onStatus?.("Checking semantic conflicts and publishing repaired revision");
    await dependencies.finishPreparation({
      root,
      configPath: options.configPath,
      sourceId: source.id,
      ...(options.model ? { model: options.model } : {}),
      yes: true,
      createBranch: false,
      restoreCache: false,
      reparseBaselineBundleHash: repair.baselineBundleHash,
      reparseRunId: repair.runId,
      acquireLock: false,
      signal: options.signal,
      cacheRoot: options.cacheRoot,
      onProgress: report,
      onStatus: options.onStatus,
      onModelText: options.onModelText,
      onModelThinking: options.onModelThinking,
      onModelToolCall: options.onModelToolCall,
      onModelToolResult: options.onModelToolResult,
      onModelEvent: options.onModelEvent,
    });
    options.signal?.throwIfAborted();

    const active = await cache.lookup(source);
    if (!active.bundleHash || active.requiresReparse) {
      throw new Error("Repair finalization did not activate a current-pipeline prepared revision.");
    }
    const activeRevision = await cache.loadRevision(source, active.bundleHash);
    if (
      !activeRevision
      || activeRevision.bundle.version !== 4
      || activeRevision.bundle.lineage?.operation !== "repair"
      || activeRevision.bundle.lineage.parentBundleHash !== repair.baselineBundleHash
      || activeRevision.bundle.lineage.runId !== repair.runId
    ) {
      throw new Error(
        `Published revision ${active.bundleHash} does not retain repair lineage to ${repair.baselineBundleHash} for ${repair.runId}.`,
      );
    }
    const activeDifference = await cache.workspaceDifferenceFromRevision(source, active.bundleHash);
    if (activeDifference) throw new Error(`Published repair revision is not the current materialization: ${activeDifference}`);
    if (!await cache.loadRevision(source, repair.baselineBundleHash, { allowIncompatible: true })) {
      throw new Error(`Repair parent revision ${repair.baselineBundleHash} disappeared during publication.`);
    }
    await runStore.remove(source.id);
    report(
      active.bundleHash === repair.baselineBundleHash
        ? `Repair verified and retained content-identical revision ${active.bundleHash}.`
        : `Activated repaired revision ${active.bundleHash}; immutable parent ${repair.baselineBundleHash} remains in history.`,
    );
    options.onStatus?.("Historical revision repair complete");
    return {
      sourceId: source.id,
      parentBundleHash: repair.baselineBundleHash,
      activeBundleHash: active.bundleHash,
      runId: repair.runId,
      resumed,
      replacedProposalIds,
    };
  } catch (error) {
    throw new Error(
      `Repair ${repair.runId} paused without discarding completed work. `
      + `Resume with \`${resumeCommand}\`. `
      + `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function validateRepairResume(
  root: string,
  source: SourceDocument,
  parent: ActivePreparedNovel,
  run: RepairRun,
  cache: PreparedNovelCache,
): Promise<void> {
  if (run.pipelineVersion !== COMPILER_PIPELINE_VERSION) {
    throw new Error(
      `Repair ${run.runId} uses compiler pipeline ${run.pipelineVersion}, but the current pipeline is ${COMPILER_PIPELINE_VERSION}. `
      + "Its journal was preserved; start no new repair until this migration conflict is reviewed.",
    );
  }
  const { sourceReviewBatchIds } = await validateRepairLayout(root, source, parent);
  if (!sameStrings(sourceReviewBatchIds, run.batchIds)) {
    throw new Error(
      `Repair ${run.runId} batch layout conflicts with the current source layout. `
      + "Its journal was preserved; do not retry unchanged.",
    );
  }
  // Validate that the immutable parent itself still resolves before allowing a
  // journal to authorize divergence from that parent's materialization.
  if (!await cache.loadRevision(source, run.baselineBundleHash, { allowIncompatible: true })) {
    throw new Error(`Repair parent revision is missing: ${run.baselineBundleHash}`);
  }
}

async function validateRepairLayout(
  root: string,
  source: SourceDocument,
  parent: ActivePreparedNovel,
): Promise<{ sourceReviewBatchIds: string[] }> {
  const batches = await prepareCompilerBatches(root, source, {
    chapterSplitPlan: parent.bundle.chapterSplitPlan ?? null,
  });
  const stableBatchIds = batches
    .filter((batch) => batch.purpose !== "boundary-calibration")
    .map((batch) => batch.id)
    .sort();
  if (!sameStrings(stableBatchIds, [...parent.bundle.batchIds].sort())) {
    throw new Error(
      `Prepared revision ${parent.bundleHash} uses a different source/segment layout. `
      + "Targeted artifact reuse is unsafe; keep the revision immutable and use a full reparse for this source layout.",
    );
  }
  const sourceReviewBatchIds = batches
    .filter((batch) => batch.purpose === "source-review")
    .map((batch) => batch.id);
  if (!sourceReviewBatchIds.length) throw new Error(`Source ${source.id} has no source-review compiler batches.`);
  return { sourceReviewBatchIds };
}

async function forkConflicts(
  root: string,
  source: SourceDocument,
  parent: ActivePreparedNovel,
  active: Awaited<ReturnType<PreparedNovelCache["lookup"]>>,
  cache: PreparedNovelCache,
): Promise<string[]> {
  const conflicts: string[] = [];
  if (active.bundleHash !== parent.bundleHash) {
    conflicts.push(`active prepared revision is ${active.bundleHash ?? "missing"}, not requested parent ${parent.bundleHash}`);
  }
  const difference = await cache.workspaceDifferenceFromRevision(source, parent.bundleHash);
  if (difference) conflicts.push(`materialized workspace differs from the requested parent: ${difference}`);
  const proposalIds = await pendingSourceProposalIds(root, source);
  if (proposalIds.length) conflicts.push(`${proposalIds.length} pending compiler proposal(s): ${proposalIds.join(", ")}`);
  const persisted = await new CompilerBatchStore(root).readPersisted(source.id);
  if (!persisted) {
    conflicts.push("compiler checkpoint is missing");
  } else if (
    persisted.pipelineVersion !== COMPILER_PIPELINE_VERSION
    || !sameStrings([...persisted.completedBatchIds].sort(), [...parent.bundle.batchIds].sort())
  ) {
    conflicts.push(
      `compiler checkpoint is pipeline ${persisted.pipelineVersion ?? "legacy"} with `
      + `${persisted.completedBatchIds.length}/${parent.bundle.batchIds.length} parent batch(es) complete`,
    );
  }
  const boundaryRequests = await new BoundaryCalibrationStore(root).list(source.id);
  if (boundaryRequests.length) conflicts.push(`${boundaryRequests.length} transient boundary-calibration request(s) are staged`);
  return [...new Set(conflicts)];
}

async function pendingSourceProposalIds(root: string, source: SourceDocument): Promise<string[]> {
  const workspace = await WorkspaceStore.create(root);
  const currentSource = await workspace.getSource(source.id);
  const [world, annotations, entityResolutions, eventResolutions, accounting] = await Promise.all([
    new ProposalStore(root).list("pending", source.id),
    new SourceAnnotationStore(root).listProposals(source.id, "pending"),
    new EntityResolutionStore(root).listProposals(source.id, "pending"),
    new EventResolutionStore(root).listProposals(source.id, "pending"),
    new SourceAccountingStore(root).listProposals(source.id, "pending"),
  ]);
  return [...new Set([
    ...world.map((item) => item.id),
    ...annotations.map((item) => item.id),
    ...entityResolutions.map((item) => item.id),
    ...eventResolutions.map((item) => item.id),
    ...accounting.map((item) => item.id),
    ...(currentSource?.pendingTitleProposal ? [currentSource.pendingTitleProposal.proposalId] : []),
  ])].sort();
}

function repairPrompt(prompt: string, batch: CompilerBatch, run: RepairRun): string {
  return `You are repairing a working fork of immutable prepared revision ${run.baselineBundleHash}. `
    + `This is repair run ${run.runId}, compiler pipeline ${run.pipelineVersion}, batch ${batch.id}. `
    + "The materialized existing catalog is reusable candidate work, not authority over the supplied source evidence. "
    + "Audit every supplied evidence slice under the current semantics. Preserve correct existing artifacts without re-proposing them. "
    + "Propose only genuinely missing artifacts or evidence-backed corrections. For a correction, retrieve the exact payload first, "
    + "keep its stable logical artifact ID, and use a new immutable proposal envelope. Do not change an artifact merely to stamp a new pipeline version. "
    + "Resolve identity, event, graph, exact-evidence, annotation, and source-accounting gaps exposed by this batch. "
    + `Every proposal envelope ID created in this repair must end with -${run.runId}. `
    + "The historical parent and existing branch snapshots are immutable; never treat later canon as active branch truth or character knowledge.\n\n"
    + prompt;
}

async function resolveSource(root: string, sourceId?: string): Promise<SourceDocument> {
  const sources = await (await WorkspaceStore.create(root)).listSources();
  const source = sourceId ? sources.find((candidate) => candidate.id === sourceId) : sources.length === 1 ? sources[0] : undefined;
  if (source) return source;
  if (!sources.length) throw new Error("No ingested sources. Run nwh ingest first.");
  if (sourceId) throw new Error(`Unknown source id: ${sourceId}`);
  throw new Error(`Multiple sources are registered; specify --source. Available: ${sources.map((item) => item.id).join(", ")}`);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

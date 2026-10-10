import fs from "node:fs/promises";
import path from "node:path";
import { CompilerBatchStore, prepareCompilerBatches } from "../compiler/batches.js";
import { convergeWorldProposals, quarantineUncommittableProposals } from "../compiler/converge.js";
import { CompilerFinishReceipts } from "../compiler/finish-receipts.js";
import { recoverCompilerFinish } from "../compiler/finish-recovery.js";
import { pendingAuthorizedUpstreamRepairs, prepareAuthorizedUpstreamRepair } from "../compiler/upstream-repair-preparation.js";
import { CompilerProposalObligations } from "../compiler/proposal-obligations.js";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { preparedSubjectHash, assertPreparedReadiness } from "../compiler/certification.js";
import { inspectCompilerStatus } from "../compiler/status.js";
import { RepairRunStore } from "../compiler/repair-run.js";
import { SourceMaterialStore } from "../storage/source-material-store.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { ProposalStore } from "../world/canonical-model.js";
import { InitialWorldStore } from "../world/initial.js";
import { BranchStore } from "../world/store.js";
import { createWorldBranch } from "../world/instance.js";
import { loadOptionalConfig, profileForRole } from "../config/load.js";
import { NovelEvaluationPlanStore, validateEvaluationPlan } from "../eval/novel-evaluation-plan.js";
import { evaluateNovelPlay } from "../eval/novel-play-evaluator.js";
import { NovelPlayQualityStore } from "../eval/novel-play-quality.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { resolveNovelSource } from "../world/play-experience.js";
import { resolvePreparationBranchId } from "../workflow/prepare.js";
import { reviewNovelRoles } from "../workflow/role-review.js";
import { reviewNovelEvaluation, inspectEvaluationReview } from "../workflow/novel-evaluation-review.js";
import { newNovelCompilationRun, NovelCompilationRunStore, runNovelCompilation,
  type NovelCompilationPhase, type NovelCompilationRun } from "../workflow/novel-compilation.js";
import { ingestWorkspaceSource } from "./ingest.js";
import { compileSourceCommand } from "./compile-source.js";
import { prepareAllCommand, type PrepareAllCommandOptions } from "./prepare-all.js";
import { invalidatePreparationArtifacts } from "./reparse.js";

export type CompileNovelOptions = Pick<PrepareAllCommandOptions, "root" | "configPath" | "novelPath" | "sourceId" | "branchId" | "model" | "signal" | "cacheRoot" | "onProgress" | "upstreamRepairPlan" | "upstreamRepairFinishFile"> & {
  rebuild?: boolean;
  phase?: NovelCompilationPhase | "status";
  evaluationPlanFile?: string;
  evaluationPlanHash?: string;
  batchStage?: "structure" | "observation" | "semantic" | "executable" | "boundary";
};

/** Read-only: no migrations, audit/probes, model calls or implicit publication. */
export async function inspectNovelCompilation(root: string, sourceId?: string) {
  const status = await inspectCompilerStatus(root, sourceId), runs = new NovelCompilationRunStore(root);
  return { ...status, compilation: await Promise.all(status.sources.map(async source => {
    const run = await runs.read(source.sourceId);
    return { sourceId: source.sourceId, run,
      evaluationReview: run?.subjectHash ? await inspectEvaluationReview(root, run.subjectHash) : null,
      evaluation: run?.subjectHash ? await new NovelPlayQualityStore(root).read(run.subjectHash) : null };
  })), interpretation: `${status.interpretation} Orchestration receipts are historical scheduling records, not current certification.` };
}

export async function compileNovelCommand(options: CompileNovelOptions): Promise<NovelCompilationRun | undefined> {
  const root = path.resolve(options.root);
  if (options.phase === "status") {
    if (options.novelPath || options.rebuild) throw new Error("Status is read-only; omit the novel path and --rebuild.");
    console.log(JSON.stringify(await inspectNovelCompilation(root, options.sourceId), null, 2));
    return;
  }
  if (options.rebuild && options.phase) throw new Error("--rebuild belongs to the full compile-novel command; individual stages preserve existing progress.");
  if (options.evaluationPlanFile && options.evaluationPlanHash) throw new Error("Choose --evaluation-plan or --plan-hash, not both.");
  if (options.upstreamRepairFinishFile && !options.upstreamRepairPlan) throw new Error("--upstream-finish requires the exact --upstream-plan; correct the host selection before retrying.");
  return withWorkspaceOperationLock(root, "compiler", async () => {
    options.signal?.throwIfAborted();
    const configPath = options.configPath ?? path.join(root, "novel-harness.yaml");
    const config = await loadOptionalConfig(configPath);
    let source: SourceDocument;
    if (options.novelPath) {
      const ingested = await ingestWorkspaceSource(root, options.novelPath, config?.project);
      if (options.sourceId && options.sourceId !== ingested.document.id) throw new Error("NOVEL_SOURCE_CONFLICT: the file and --source select different immutable novels; correct the selection before retrying.");
      source = ingested.document;
    } else {
      const workspace = await WorkspaceStore.create(root), sources = await workspace.listSources();
      if (options.sourceId) source = await resolveNovelSource(workspace, options.sourceId);
      else if (sources.length === 1) source = sources[0]!;
      else throw new Error(`Select one novel with --source or a novel path. Registered sources: ${sources.map(source => source.id).join(", ") || "none"}.`);
    }
    if (!await new SourceMaterialStore().read(source)) throw new Error("NOVEL_SOURCE_MISSING: re-ingest the original source before compiling; do not substitute another file.");
    const store = new NovelCompilationRunStore(root);
    const previous = await store.read(source.id);
    if (previous && previous.sourceSha256 !== source.contentSha256) throw new Error("NOVEL_SOURCE_CHANGED: the saved run belongs to another source hash. Inspect the source registration; do not retry unchanged.");
    // An unfinished rebuild is resumed even when --rebuild is repeated. Its generation
    // and proposal namespace may not be rotated to reset durable failure budgets.
    if (options.rebuild && previous && !previous.completed && previous.mode !== "rebuild") {
      await assertRebuildSafe(root, source.id);
    }
    const run = previous && (!options.rebuild || (!previous.completed && previous.mode === "rebuild"))
      ? previous : newNovelCompilationRun(source, Boolean(options.rebuild));
    if (run.completed && !options.rebuild) run.mode = "resume";
    const cache = new PreparedNovelCache(root, options.cacheRoot);
    const report = options.onProgress ?? ((message: string) => console.log(message));
    const common: PrepareAllCommandOptions & { configPath: string } = {
      root, configPath, sourceId: source.id, model: options.model, signal: options.signal,
      cacheRoot: options.cacheRoot, onProgress: report, onStatus: report, acquireLock: false,
      yes: true, restoreCache: false, createBranch: false,
      upstreamRepairPlan: options.upstreamRepairPlan, upstreamRepairFinishFile: options.upstreamRepairFinishFile,
    };
    if (run.mode === "rebuild" && !run.rebuildInitialized) {
      await initializeRebuild(root, source, run, store, cache);
    }
    if (run.baselineBundleHash) common.reparseBaselineBundleHash = run.baselineBundleHash;
    if (run.mode === "rebuild") common.reparseRunId = run.id;
    const lineage = run.baselineBundleHash ? { lineage: { operation: "reparse" as const, parentBundleHash: run.baselineBundleHash, runId: run.id } } : {};
    const requirePlan = async () => {
      const bundle = await cache.candidateSnapshot(source), plans = new NovelEvaluationPlanStore(root);
      const hash = options.evaluationPlanHash ?? run.planHash ?? (await plans.findCurrent(bundle))?.hash;
      if (!hash) throw new Error(`EVALUATION_PLAN_REQUIRED: run nwh compile-novel evaluation-plan --source ${source.id}.`);
      validateEvaluationPlan(await plans.read(hash), bundle);
      run.planHash = hash;
      run.subjectHash = preparedSubjectHash(bundle);
      return hash;
    };
    const execute = async (phase: NovelCompilationPhase) => {
      options.signal?.throwIfAborted();
      if (run.mode === "rebuild" && phase !== "branch") {
        const active = (await cache.lookup(source)).bundleHash ?? null;
        // Activation may have succeeded just before interruption. Remember that
        // exact publication before archive/certify replace the working bundle ref.
        if (active && active === run.bundleHash && active !== run.activeAtStart) run.activatedBundleHash = active;
        if (active !== run.activeAtStart && active !== run.bundleHash && active !== run.activatedBundleHash) {
          throw new Error("NOVEL_REBUILD_ACTIVE_CHANGED: publication changed outside this rebuild; inspect the original run and active revision before continuing. Do not retry unchanged.");
        }
      }
      switch (phase) {
        case "source":
          await prepareCompilerBatches(root, source);
          break;
        case "recover": {
          const upstreamPlans = options.upstreamRepairPlan ? [options.upstreamRepairPlan] : await pendingAuthorizedUpstreamRepairs(root, source.id);
          for (const planHash of upstreamPlans) {
            const input: unknown = options.upstreamRepairFinishFile ? JSON.parse(await fs.readFile(path.resolve(root, options.upstreamRepairFinishFile), "utf8")) : undefined;
            const result = await prepareAuthorizedUpstreamRepair(root, source.id, planHash, input, {
              profile: config ? profileForRole(config, "extractor").profile : undefined, model: options.model, signal: options.signal,
            });
            report(`Recovered authorized upstream repair ${result.planHash}: ${result.state}; original receipt ${result.receiptFingerprint}.`);
            if (result.issues.length) throw new Error(result.issues.join("; "));
          }
          const completed = new Set((await new CompilerBatchStore(root).read(source.id)).completedBatchIds);
          const planned = new Set((await prepareCompilerBatches(root, source)).map(batch => batch.id));
          for (const receipt of await CompilerFinishReceipts.list(root, source.id)) {
            if (receipt.state !== "completed" || (planned.has(receipt.identity.batchId) && !completed.has(receipt.identity.batchId))) {
              await recoverCompilerFinish(root, source.id, receipt.identity.batchId, { retireSupersededPipelineReceipt: true });
            }
          }
          break;
        }
        case "batches": {
          let batchIds: string[] | undefined;
          if (options.batchStage) {
            const batches = await prepareCompilerBatches(root, source);
            const stages = ["structure", "observation", "semantic", "executable", "boundary"];
            const rank = (batch: typeof batches[number]) => stages.indexOf(batch.purpose === "structure-discovery" ? "structure"
              : batch.purpose === "boundary-calibration" ? "boundary" : batch.semanticStage ?? "executable");
            const completed = new Set((await new CompilerBatchStore(root).read(source.id)).completedBatchIds);
            const prerequisites = batches.filter(batch => rank(batch) < stages.indexOf(options.batchStage!) && !completed.has(batch.id));
            if (prerequisites.length) throw new Error(`COMPILATION_STAGE_DEPENDENCIES: finish prior batches ${prerequisites.map(batch => batch.id).join(", ")} using compile-novel batches, or the corresponding earlier stage commands.`);
            batchIds = batches.filter(batch => options.batchStage === "structure" ? batch.purpose === "structure-discovery"
              : options.batchStage === "boundary" ? batch.purpose === "boundary-calibration" : batch.semanticStage === options.batchStage).map(batch => batch.id);
            if (!batchIds.length) throw new Error(`No ${options.batchStage} batches in the current plan; inspect compile-novel status before selecting a stage.`);
          }
          await compileSourceCommand({ ...common, allowMissingConfig: true, resume: true, batchIds,
            ...(run.mode === "rebuild" ? { promptTransform: (prompt: string) => `Full rebuild ${run.id}. Reconsider all supplied evidence. Keep stable logical artifact IDs; newly submitted proposal envelope IDs must end in -${run.id}. Never rotate IDs of failed obligations.\n\n${prompt}` } : {}) });
          const current = (await inspectCompilerStatus(root, source.id)).sources[0]!;
          if (!options.batchStage && !current.batchReviewComplete) throw new Error("COMPILER_BATCHES_INCOMPLETE: current plan, finish receipts or proposal obligations are not closed; inspect status and recover the original scopes.");
          const checked = new Set(batchIds ?? current.completedBatchIds);
          const verified = new Set(current.finish.receipts.filter(receipt => receipt.state === "completed" && !receipt.recoveryRequired).map(receipt => receipt.batchId));
          if (current.finish.inspection !== "verified" || [...checked].some(id => !verified.has(id))) throw new Error("COMPILER_FINISH_UNVERIFIED: a selected checkpoint has no verifiable completed finish receipt. Inspect status and recover its original receipt before continuing; checkpoint counts alone do not certify a batch.");
          break;
        }
        case "converge": {
          const converged = await convergeWorldProposals(root, source.id);
          await quarantineUncommittableProposals(root, converged);
          const issues = [...(converged.upstreamRepairIssues ?? []), ...(converged.requirementValidityIssues ?? [])];
          if (issues.length) throw new Error(issues.join("; "));
          break;
        }
        case "opening": case "repair": case "requirements":
          await prepareAllCommand({ ...common, onlyPhase: phase,
            ...(!options.phase ? { upstreamRepairPlan: undefined, upstreamRepairFinishFile: undefined } : {}) });
          break;
        case "roles":
          await reviewNovelRoles({ ...common, sourceId: source.id, allowMissingConfig: true });
          break;
        case "archive": {
          const archived = await cache.archiveCandidate(source, lineage);
          run.bundleHash = archived.bundleHash;
          report(`Candidate archived: ${run.bundleHash}; certification pending.`);
          break;
        }
        case "evaluation-plan": {
          const bundle = await cache.candidateSnapshot(source), plans = new NovelEvaluationPlanStore(root);
          run.subjectHash = preparedSubjectHash(bundle);
          await store.write(run);
          if (options.evaluationPlanHash) {
            validateEvaluationPlan(await plans.read(options.evaluationPlanHash), bundle);
            run.planHash = options.evaluationPlanHash;
          } else if (options.evaluationPlanFile) {
            run.planHash = (await plans.freeze(JSON.parse(await fs.readFile(path.resolve(root, options.evaluationPlanFile), "utf8")), bundle)).hash;
          } else run.planHash = await reviewNovelEvaluation({ root, bundle, model: options.model, signal: options.signal,
            profile: config ? profileForRole(config, "extractor").profile : undefined, onStatus: report });
          run.subjectHash = preparedSubjectHash(bundle);
          report(`Independent evaluation plan: ${run.planHash}`);
          break;
        }
        case "evaluate": {
          const planHash = await requirePlan();
          const quality = await evaluateNovelPlay({ root, planHash, model: options.model, signal: options.signal,
            profile: config ? profileForRole(config, "player").profile : undefined, onStatus: report, resume: true });
          if (quality.issues.length) throw new Error(`NOVEL_EVALUATION_FAILED: ${quality.issues.map(issue => `${issue.code}: ${issue.message}`).join("; ")}`);
          break;
        }
        case "certify": {
          const planHash = await requirePlan();
          if ((await new NovelPlayQualityStore(root).read(run.subjectHash!))?.gold.hash !== planHash) {
            throw new Error("EVALUATION_PLAN_NOT_RUN: the selected plan has no matching evaluation report; run compile-novel evaluate first.");
          }
          const certified = await cache.certifyCandidate(source, lineage);
          run.bundleHash = certified.bundleHash;
          report(`Certified candidate: ${run.bundleHash}; activation pending.`);
          break;
        }
        case "activate": {
          if (!run.bundleHash) throw new Error(`CERTIFIED_CANDIDATE_REQUIRED: run compile-novel certify --source ${source.id} first.`);
          const frozen = await cache.loadRevision(source, run.bundleHash);
          if (!frozen) throw new Error(`CERTIFIED_CANDIDATE_MISSING: inspect prepared-cache list --source ${source.id}, then certify the current candidate; do not guess a hash.`);
          assertPreparedReadiness(frozen.bundle);
          if (preparedSubjectHash(frozen.bundle) !== preparedSubjectHash(await cache.candidateSnapshot(source))) throw new Error("CERTIFIED_CANDIDATE_STALE: compiler inputs changed; rerun evaluation-plan, evaluate and certify before activation.");
          await cache.activate(source, run.bundleHash);
          run.activatedBundleHash = run.bundleHash;
          break;
        }
        case "branch": {
          const active = await cache.loadFreshActive(source);
          if (!active) throw new Error(`ACTIVE_CERTIFIED_NOVEL_REQUIRED: run compile-novel activate --source ${source.id} first.`);
          if (preparedSubjectHash(active.bundle) !== preparedSubjectHash(await cache.candidateSnapshot(source))) throw new Error("ACTIVE_CANDIDATE_STALE: activate the current certified candidate before creating its branch.");
          const branches = new BranchStore(root);
          let branchId = options.branchId ?? run.branchId ?? await resolvePreparationBranchId(root, source);
          if ((await branches.listIds()).includes(branchId)) {
            const branch = await branches.read(branchId);
            if (branch.sourceId !== source.id || branch.preparedRevisionHash !== active.bundleHash) {
              if (options.branchId) throw new Error(`BRANCH_REVISION_CONFLICT: ${branchId} is pinned to another revision. Choose a new --branch; existing history cannot be overwritten.`);
              branchId = await resolvePreparationBranchId(root, source, undefined, { preferNew: true });
            } else { run.branchId = branchId; break; }
          }
          // Save the name before genesis so an interrupted delivery can discover it.
          run.branchId = branchId;
          await store.write(run);
          await createWorldBranch(root, branchId, undefined, source.id, options.cacheRoot);
          break;
        }
      }
    };
    const completed = await runNovelCompilation({ run, phase: options.phase as NovelCompilationPhase | undefined, save: value => store.write(value),
      execute, signal: options.signal, report });
    report(completed.completed ? `Novel compilation complete: source=${source.id}, certifiedRevision=${run.bundleHash}, branch=${run.branchId}.`
      : `Stage ${options.phase} completed. This is not a full-novel completion certificate.`);
    return completed;
  });
}

async function assertRebuildSafe(root: string, sourceId: string) {
  const existingRepair = await new RepairRunStore(root).read(sourceId);
  if (existingRepair) throw new Error(`NOVEL_REBUILD_REPAIR_ACTIVE: resume original repair-existing run ${existingRepair.runId}; do not replace its staging or failure budget.`);
  for (const batchId of CompilerProposalObligations.listBatchIds(root, sourceId)) {
    if (new CompilerProposalObligations(root, sourceId, batchId).unresolved().length) throw new Error(`NOVEL_REBUILD_OBLIGATIONS_OPEN: recover original scope ${batchId} via compiler-obligations inspect before rebuilding; no IDs or attempt counters were reset.`);
  }
  if ((await CompilerFinishReceipts.list(root, sourceId)).some(receipt => receipt.state !== "completed")) throw new Error("NOVEL_REBUILD_FINISH_PENDING: recover the original finish receipt before rebuilding; do not archive an unfinished write.");
  if ((await new ProposalStore(root).list("pending", sourceId)).length) throw new Error(`NOVEL_REBUILD_PROPOSALS_PENDING: run compile-novel converge --source ${sourceId} and resolve its diagnostics first; pending proposals were retained.`);
}

async function initializeRebuild(root: string, source: SourceDocument, run: NovelCompilationRun, store: NovelCompilationRunStore, cache: PreparedNovelCache) {
  await assertRebuildSafe(root, source.id);
  const batches = await prepareCompilerBatches(root, source);
  if (!run.rebuildBatchIds) {
    const initial = await new InitialWorldStore(root).get();
    const completed = new Set((await new CompilerBatchStore(root).read(source.id)).completedBatchIds);
    run.activeAtStart = (await cache.lookup(source)).bundleHash ?? null;
    if (initial?.evidence.some(reference => reference.span.sourceId === source.id)
      && batches.every(batch => completed.has(batch.id))) {
      run.baselineBundleHash = (await cache.archiveCandidate(source)).bundleHash;
    } else if (run.activeAtStart) run.baselineBundleHash = run.activeAtStart;
    // Incomplete materialization is not a valid prepared bundle. Its per-artifact
    // immutable revisions/proposal history are retained by invalidation below;
    // never fabricate completed checkpoints just to make it archivable.
    run.rebuildBatchIds = batches.map(batch => batch.id);
    await store.write(run);
  }
  // Idempotent initialization, completed before any new model call. Historical
  // revisions, branches, proposal failures and requirement ledgers remain intact.
  const openingFinishes = (await CompilerFinishReceipts.list(root, source.id))
    .filter(receipt => receipt.identity.batchId.startsWith("opening-"))
    .map(receipt => receipt.identity.batchId);
  await CompilerFinishReceipts.archiveSource(root, source.id, `Full rebuild ${run.id}`, [...run.rebuildBatchIds!, ...openingFinishes]);
  await new CompilerBatchStore(root).markIncomplete(source.id, run.rebuildBatchIds);
  await invalidatePreparationArtifacts(root, source.id, batches, true);
  run.rebuildInitialized = true;
  await store.write(run);
}

import fs from "node:fs/promises";
import path from "node:path";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { preparedSubjectHash } from "../compiler/certification.js";
import { assertPlayableRevision, buildAdmissionManifest } from "../compiler/cut-admission.js";
import { tierAtLeast } from "../compiler/cut-admission-schema.js";
import { PiStageAgent, type StageAgent } from "../compiler/pipeline/agent.js";
import { checkPipelineClosure } from "../compiler/pipeline/closure.js";
import { pipelineContext, runGapLoop, runPipelineStage, type PipelineOptions } from "../compiler/pipeline/compile.js";
import { releaseHeldScopes } from "../compiler/pipeline/runner.js";
import { prepareSourceStage } from "../compiler/pipeline/source-stage.js";
import { PipelineStore } from "../compiler/pipeline/store.js";
import { SourceMaterialStore } from "../storage/source-material-store.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { BranchStore } from "../world/store.js";
import { createWorldBranch } from "../world/instance.js";
import { loadOptionalConfig, profileForRole } from "../config/load.js";
import { NovelEvaluationPlanStore, validateEvaluationPlan } from "../eval/novel-evaluation-plan.js";
import { evaluateNovelPlay } from "../eval/novel-play-evaluator.js";
import { NovelPlayQualityStore } from "../eval/novel-play-quality.js";
import { withWorkspaceOperationLock, WorkspaceOperationLock } from "../util/workspace-lock.js";
import { resolveNovelSource } from "../world/play-experience.js";
import { resolvePreparationBranchId } from "../workflow/prepare.js";
import { reviewNovelEvaluation, inspectEvaluationReview } from "../workflow/novel-evaluation-review.js";
import { newNovelCompilationRun, NovelCompilationRunStore, PIPELINE_PHASES, runNovelCompilation,
  type NovelCompilationPhase, type NovelCompilationRun } from "../workflow/novel-compilation.js";
import { ingestWorkspaceSource } from "./ingest.js";

export type CompileNovelOptions = {
  root: string;
  configPath?: string;
  novelPath?: string;
  sourceId?: string;
  branchId?: string;
  model?: string;
  signal?: AbortSignal;
  cacheRoot?: string;
  onProgress?: (message: string) => void;
  phase?: NovelCompilationPhase | "status" | "plan";
  evaluationPlanFile?: string;
  evaluationPlanHash?: string;
  /** Prefix compile (design 5.1): compile only through this chapter (1-based) or byte offset. */
  throughChapter?: number;
  throughByte?: number;
  /** Test seam: the model side of every pipeline scope. Defaults to an isolated Pi session per scope. */
  agent?: StageAgent;
  /** Pipeline scopes with non-overlapping ranges that may run side by side (default 1). */
  concurrency?: number;
};

/** Pipeline status for one source: scopes by stage, held scopes, usage and cost per source KB. Read-only. */
export async function inspectPipelineStatus(root: string, source: SourceDocument) {
  const store = new PipelineStore(root, source.id);
  const [run, receipts] = await Promise.all([store.run(), store.receipts()]);
  const stages: Record<string, { completed: number; held: number; running: number }> = {};
  const usage = { input: 0, output: 0, cacheRead: 0, cost: 0, requests: 0 };
  for (const receipt of receipts) {
    const entry = stages[receipt.stage] ?? { completed: 0, held: 0, running: 0 };
    entry[receipt.status] += 1;
    stages[receipt.stage] = entry;
    usage.input += receipt.usage.input; usage.output += receipt.usage.output; usage.cacheRead += receipt.usage.cacheRead; usage.cost += receipt.usage.cost; usage.requests += receipt.usage.requests;
  }
  const limit = run?.limit ?? source.bytes;
  return {
    limit, ...(run?.throughChapter ? { throughChapter: run.throughChapter } : {}), ...(run?.throughByte ? { throughByte: run.throughByte } : {}),
    stages, held: receipts.filter((receipt) => receipt.status === "held").map((receipt) => ({ id: receipt.id, stage: receipt.stage, failing: receipt.gate?.checks.filter((check) => !check.passed).map((check) => check.id) ?? [], error: receipt.error })),
    usage: { ...usage, costPerSourceKb: limit ? usage.cost * 1024 / limit : 0 },
  };
}

/** Read-only: no model calls, migration or publication. */
export async function inspectNovelCompilation(root: string, sourceId?: string) {
  const { inspectCompileLoop } = await import("../runtime/compile-loop/state.js");
  const workspace = WorkspaceStore.openReadOnly(root);
  const sources = (await workspace.listSources()).filter((source) => !sourceId || source.id === sourceId);
  const runs = new NovelCompilationRunStore(root);
  const lock = await WorkspaceOperationLock.inspect(root);
  const materials = new SourceMaterialStore();
  return {
    capturedAt: new Date().toISOString(),
    workspace: root,
    compilerLock: { present: Boolean(lock.owner), ...(lock.owner ? { owner: lock.owner } : {}) },
    sources: await Promise.all(sources.map(async (source) => ({ sourceId: source.id, sourceSha256: source.contentSha256, bytes: source.bytes,
      sourceIntegrity: (await materials.read(source).catch(() => null)) ? "verified" as const : "missing" as const }))),
    compilation: await Promise.all(sources.map(async (source) => {
      const run = await runs.read(source.id);
      return { sourceId: source.id, run, pipeline: await inspectPipelineStatus(root, source), supervision: inspectCompileLoop(root, source.id),
        evaluationReview: run?.subjectHash ? await inspectEvaluationReview(root, run.subjectHash) : null,
        evaluation: run?.subjectHash ? await new NovelPlayQualityStore(root).read(run.subjectHash) : null };
    })),
    interpretation: "Pipeline receipts are scheduling and gate records; a held scope stays skipped until host review re-opens it with compile-novel release (the gap loop also repairs what it measured). Run records are not certification.",
  };
}

/**
 * Host review of held scopes (design 5.8 step 5): re-open them so the next
 * stage run or gap loop attempts them again. The release and its note are
 * kept on the scope receipt. No model call.
 */
export async function releaseHeldScopesCommand(options: { root: string; sourceId?: string; scopeIds?: readonly string[]; stage?: string; all?: boolean; note?: string }): Promise<string[]> {
  const root = path.resolve(options.root);
  return withWorkspaceOperationLock(root, "compiler", async () => {
    const workspace = await WorkspaceStore.create(root), sources = await workspace.listSources();
    const source = options.sourceId ? await resolveNovelSource(workspace, options.sourceId) : sources.length === 1 ? sources[0]! : undefined;
    if (!source) throw new Error(`Select one novel with --source. Registered sources: ${sources.map((item) => item.id).join(", ") || "none"}.`);
    const released = await releaseHeldScopes(new PipelineStore(root, source.id), { ...(options.scopeIds ? { scopeIds: options.scopeIds } : {}), ...(options.stage ? { stage: options.stage } : {}), ...(options.all ? { all: true } : {}) }, options.note);
    console.log(JSON.stringify({ sourceId: source.id, released, next: released.length ? "Rerun the scope's stage (or compile-novel gaps) to attempt it again." : "Nothing was held for this selection." }, null, 2));
    return released;
  });
}

export async function compileNovelCommand(options: CompileNovelOptions): Promise<NovelCompilationRun | undefined> {
  const root = path.resolve(options.root);
  if (options.phase === "status" || options.phase === "plan") {
    if (options.novelPath) throw new Error("Status is read-only; omit the novel path.");
    console.log(JSON.stringify(await inspectNovelCompilation(root, options.sourceId), null, 2));
    return;
  }
  if (options.evaluationPlanFile && options.evaluationPlanHash) throw new Error("Choose --evaluation-plan or --plan-hash, not both.");
  return withWorkspaceOperationLock(root, "compiler", () => compileNovelLocked({ ...options, root }));
}

/** TUI compilation already owns the lock. Reuse the CLI's delivery stages, including independent evaluation and certification. */
export async function certifyPreparedNovel(options: Pick<CompileNovelOptions, "root" | "sourceId" | "configPath" | "model" | "cacheRoot" | "onProgress" | "signal">): Promise<NovelCompilationRun> {
  const root = path.resolve(options.root);
  if ((await WorkspaceOperationLock.inspect(root)).owner?.pid !== process.pid) throw new Error("Prepared delivery requires the owning compiler lock; stop and inspect the active preparation before retrying.");
  let run: NovelCompilationRun | undefined;
  for (const phase of ["closure", "archive", "evaluation-plan", "evaluate", "certify", "activate"] as const) {
    run = await compileNovelLocked({ ...options, root, phase });
  }
  return run!;
}

async function resolveSource(root: string, options: CompileNovelOptions, project?: Parameters<typeof ingestWorkspaceSource>[2]): Promise<SourceDocument> {
  if (options.novelPath) {
    const ingested = await ingestWorkspaceSource(root, options.novelPath, project);
    if (options.sourceId && options.sourceId !== ingested.document.id) throw new Error("NOVEL_SOURCE_CONFLICT: the file and --source select different immutable novels; correct the selection before retrying.");
    return ingested.document;
  }
  const workspace = await WorkspaceStore.create(root), sources = await workspace.listSources();
  if (options.sourceId) return resolveNovelSource(workspace, options.sourceId);
  if (sources.length === 1) return sources[0]!;
  throw new Error(`Select one novel with --source or a novel path. Registered sources: ${sources.map((source) => source.id).join(", ") || "none"}.`);
}

async function compileNovelLocked(options: CompileNovelOptions): Promise<NovelCompilationRun> {
  const root = options.root;
  options.signal?.throwIfAborted();
  const configPath = options.configPath ?? path.join(root, "novel-harness.yaml");
  const config = await loadOptionalConfig(configPath);
  const source = await resolveSource(root, options, config?.project);
  if (!await new SourceMaterialStore().read(source)) throw new Error("NOVEL_SOURCE_MISSING: re-ingest the original source before compiling; do not substitute another file.");
  const store = new NovelCompilationRunStore(root);
  const previous = await store.read(source.id);
  if (previous && previous.sourceSha256 !== source.contentSha256) throw new Error("NOVEL_SOURCE_CHANGED: the saved run belongs to another source hash. Inspect the source registration; do not retry unchanged.");
  const run = previous ?? newNovelCompilationRun(source);
  const cache = new PreparedNovelCache(root, options.cacheRoot);
  const report = options.onProgress ?? ((message: string) => console.log(message));
  const extractor = config ? profileForRole(config, "extractor").profile : undefined;
  // Design 5.9: `llm.routing["extractor.<stage>"]` routes one stage to its own profile (e.g. a cheaper tier for census and observation).
  const stageProfiles = Object.fromEntries(PIPELINE_PHASES.flatMap((stage) => {
    const name = config?.llm?.routing[`extractor.${stage}`];
    const profile = name ? config!.llm!.profiles[name] : undefined;
    if (name && !profile) throw new Error(`llm.routing.extractor.${stage} names unknown profile ${name}.`);
    return profile ? [[stage, profile] as const] : [];
  }));
  const agent = options.agent ?? new PiStageAgent({ root, ...(extractor ? { profile: extractor } : {}), ...(Object.keys(stageProfiles).length ? { stageProfiles } : {}), ...(options.model ? { model: options.model } : {}), onStatus: report });
  const stageGeneratedBy = options.model ? undefined : Object.fromEntries(Object.entries(stageProfiles).map(([stage, profile]) => [stage, { ...(profile.provider ? { provider: profile.provider } : {}), ...(profile.model ? { model: profile.model } : {}) }]));
  const pipeline: PipelineOptions = { root, source, agent, runId: run.id, report,
    generatedBy: { ...(extractor?.provider ? { provider: extractor.provider } : {}), ...(options.model ?? extractor?.model ? { model: options.model ?? extractor?.model } : {}) },
    ...(stageGeneratedBy && Object.keys(stageGeneratedBy).length ? { stageGeneratedBy } : {}), ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    ...(options.throughChapter !== undefined ? { throughChapter: options.throughChapter } : {}), ...(options.throughByte !== undefined ? { throughByte: options.throughByte } : {}),
    ...(options.signal ? { signal: options.signal } : {}) };
  const minimumAdmissionTier = config?.play?.minimumAdmissionTier;
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
    if ((PIPELINE_PHASES as readonly string[]).includes(phase)) {
      const summary = phase === "gaps" ? (await runGapLoop(pipeline)).at(-1)! : await runPipelineStage(pipeline, phase as typeof PIPELINE_PHASES[number]);
      run.limit = (await pipelineContext(pipeline)).limit;
      report(`${phase}: ${summary.completed.length} completed, ${summary.skipped.length} already passing, ${summary.held.length} held; $${summary.usage.cost.toFixed(4)} nominal.`);
      return;
    }
    switch (phase) {
      case "source": {
        const chapters = await prepareSourceStage(root, source);
        run.limit = (await pipelineContext(pipeline)).limit;
        report(`Source: ${chapters.length} chapter(s); compiling through byte ${run.limit} of ${source.bytes}.`);
        break;
      }
      case "closure": {
        const limit = run.limit ?? (await pipelineContext(pipeline)).limit;
        let admission = null;
        try {
          const { bundle, baselineIssues } = await cache.repairCandidateSnapshot(source);
          admission = await buildAdmissionManifest(bundle, { inputIssues: baselineIssues, probe: true });
        } catch (error) { report(`Closure: no candidate bundle yet (${error instanceof Error ? error.message.slice(0, 300) : String(error)}).`); }
        const closure = await checkPipelineClosure(root, source.id, limit, { admission });
        run.closure = closure;
        await store.write(run);
        if (!closure.passed) throw new Error(`COMPILATION_CLOSURE_BLOCKED: ${closure.issues.slice(0, 20).join("; ")}`);
        report("Closure passed: structure, completeness and admission checked; independent certification remains separate.");
        break;
      }
      case "archive": {
        const archived = await cache.archiveCandidate(source);
        run.bundleHash = archived.bundleHash;
        report(`Candidate archived: ${run.bundleHash}; not activated.`);
        break;
      }
      case "admit": {
        const admitted = await cache.admitCandidate(source, minimumAdmissionTier ? { minimumAdmissionTier } : {});
        run.bundleHash = admitted.bundleHash!;
        const entries = admitted.admission.cuts.flatMap((cut) => cut.actors.filter((actor) => tierAtLeast(actor.tier, minimumAdmissionTier ?? "enterable")));
        report(`Admitted revision ${run.bundleHash}: ${entries.length} cut x actor entr${entries.length === 1 ? "y" : "ies"}; activate with compile-novel activate.`);
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
        } else run.planHash = await reviewNovelEvaluation({ root, bundle, model: options.model, signal: options.signal, profile: extractor, onStatus: report });
        report(`Independent evaluation plan: ${run.planHash}`);
        break;
      }
      case "evaluate": {
        const planHash = await requirePlan();
        const quality = await evaluateNovelPlay({ root, planHash, model: options.model, signal: options.signal,
          profile: config ? profileForRole(config, "player").profile : undefined, onStatus: report, resume: true });
        if (quality.issues.length) throw new Error(`NOVEL_EVALUATION_FAILED: ${quality.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`);
        break;
      }
      case "certify": {
        const planHash = await requirePlan();
        if ((await new NovelPlayQualityStore(root).read(run.subjectHash!))?.gold.hash !== planHash) {
          throw new Error("EVALUATION_PLAN_NOT_RUN: the selected plan has no matching evaluation report; run compile-novel evaluate first.");
        }
        const certified = await cache.certifyCandidate(source);
        run.bundleHash = certified.bundleHash;
        report(`Certified candidate: ${run.bundleHash}; activation pending.`);
        break;
      }
      case "activate": {
        if (!run.bundleHash) throw new Error(`CANDIDATE_REVISION_REQUIRED: run compile-novel certify (or admit) --source ${source.id} first.`);
        const frozen = await cache.loadRevision(source, run.bundleHash);
        if (!frozen) throw new Error(`CANDIDATE_REVISION_MISSING: inspect prepared-cache list --source ${source.id}; do not guess a hash.`);
        assertPlayableRevision(frozen.bundle, minimumAdmissionTier);
        if (preparedSubjectHash(frozen.bundle) !== preparedSubjectHash(await cache.candidateSnapshot(source))) throw new Error("CANDIDATE_REVISION_STALE: compiler inputs changed; rerun closure, archive or admit before activation.");
        await cache.activate(source, run.bundleHash, minimumAdmissionTier ? { minimumAdmissionTier } : {});
        run.activatedBundleHash = run.bundleHash;
        break;
      }
      case "branch": {
        const active = await cache.loadFreshActive(source, minimumAdmissionTier ? { minimumAdmissionTier } : {});
        if (!active) throw new Error(`ACTIVE_NOVEL_REQUIRED: run compile-novel activate --source ${source.id} first.`);
        if (preparedSubjectHash(active.bundle) !== preparedSubjectHash(await cache.candidateSnapshot(source))) throw new Error("ACTIVE_CANDIDATE_STALE: activate the current candidate before creating its branch.");
        const branches = new BranchStore(root);
        let branchId = options.branchId ?? run.branchId ?? await resolvePreparationBranchId(root, source);
        if ((await branches.listIds()).includes(branchId)) {
          const branch = await branches.read(branchId);
          if (branch.sourceId !== source.id || branch.preparedRevisionHash !== active.bundleHash) {
            if (options.branchId) throw new Error(`BRANCH_REVISION_CONFLICT: ${branchId} is pinned to another revision. Choose a new --branch; existing history cannot be overwritten.`);
            branchId = await resolvePreparationBranchId(root, source, undefined, { preferNew: true });
          } else { run.branchId = branchId; break; }
        }
        run.branchId = branchId;
        await store.write(run);
        await createWorldBranch(root, branchId, undefined, source.id, options.cacheRoot);
        break;
      }
    }
  };
  const completed = await runNovelCompilation({ run, phase: options.phase as NovelCompilationPhase | undefined, save: (value) => store.write(value), execute, signal: options.signal, report });
  report(completed.completed ? `Novel compilation complete: source=${source.id}, revision=${run.bundleHash}, branch=${run.branchId}.`
    : `Stage ${options.phase} completed. This is not a full-novel completion certificate.`);
  return completed;
}

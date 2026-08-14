import path from "node:path";
import { stdout } from "node:process";
import { convergeWorldProposals, quarantineUncommittableProposals, type WorldProposalConvergence } from "../compiler/converge.js";
import { loadOptionalConfig } from "../config/load.js";
import { inspectPreparation, type PreparationInspection } from "../workflow/prepare.js";
import { askUserQuestion, recommendedAnswer, type AskUserQuestion } from "../util/ask-user-question.js";
import { compileCommand } from "./compile.js";
import { compileSourceCommand } from "./compile-source.js";
import { prepareOpeningWorldCompilerBatch, proposeMinimalOpeningWorld } from "../compiler/batches.js";
import { rejectPendingCompilerBatchProposals } from "../compiler/proposals.js";
import { ingestWorkspaceSource } from "./ingest.js";
import { worldCreateCommand } from "./world.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { resolveNovelSource } from "../world/play-experience.js";

export type PrepareAllCommandOptions = {
  root: string;
  configPath?: string;
  novelPath?: string;
  sourceId?: string;
  branchId?: string;
  model?: string;
  yes?: boolean;
  acquireLock?: boolean;
  cacheRoot?: string;
  createBranch?: boolean;
  restoreCache?: boolean;
  onProgress?: (message: string) => void;
  onStatus?: (message: string) => void;
};

type PrepareAllDependencies = {
  compileSource: typeof compileSourceCommand;
  compileInitialWorld: typeof compileCommand;
  converge: typeof convergeWorldProposals;
  createBranch: typeof worldCreateCommand;
  ask: AskUserQuestion;
};

const defaultDependencies: PrepareAllDependencies = {
  compileSource: compileSourceCommand,
  compileInitialWorld: compileCommand,
  converge: convergeWorldProposals,
  createBranch: worldCreateCommand,
  ask: askUserQuestion,
};

const INITIAL_WORLD_PROMPT = `Inspect the opening evidence and existing artifact catalog, then propose one evidence-backed initial world representing only the state already true at the opening. Propose any genuinely missing referenced entities or claims first. Do not include later canonical developments. Finish the compiler batch explicitly after all proposal calls succeed.`;

export async function prepareAllCommand(
  options: PrepareAllCommandOptions,
  dependencyOverrides: Partial<PrepareAllDependencies> = {},
): Promise<PreparationInspection> {
  const root = path.resolve(options.root);
  if (options.acquireLock !== false) {
    return withWorkspaceOperationLock(root, "compiler", () =>
      prepareAllCommand({ ...options, root, acquireLock: false }, dependencyOverrides));
  }
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const configPath = options.configPath ?? path.join(root, "novel-harness.yaml");
  const branchId = options.branchId ?? "main";
  const ask = options.yes ? recommendedAnswer() : dependencies.ask;
  const report = (message: string) => options.onProgress ? options.onProgress(message) : stdout.write(`${message}\n`);
  let sourceId = options.sourceId;
  let cacheVerified = false;

  if (options.novelPath) {
    const config = await loadOptionalConfig(configPath);
    const ingested = await ingestWorkspaceSource(root, options.novelPath, config?.project);
    sourceId = ingested.document.id;
    report(`Registered ${ingested.document.sourcePath} as ${sourceId}; indexed ${ingested.manifest.segments.length} segment(s).`);
  }

  let inspection = await inspectPreparation(root, { sourceId, branchId });
  if (inspection.stage === "needs-source") {
    throw new Error("No novel source is registered. Pass a novel path to `nwh prepare-all <novel-path>`.");
  }
  if (inspection.stage === "choose-source") {
    const store = await WorkspaceStore.create(root);
    sourceId = await ask({
      header: "Source",
      question: "Multiple novels are registered. Which source should be prepared?",
      options: inspection.sources.map((source, index) => ({
        value: source.id,
        label: source.title,
        description: `${source.sourcePath} (${source.id})`,
        recommended: index === 0,
      })),
      customInput: {
        label: "Enter a source",
        description: "Type a registered source id, title, or path.",
        prompt: "Source id, title, or path",
        placeholder: inspection.sources[0]?.id,
        invalidMessage: "No unique registered novel matches that value.",
        resolve: async (value) => {
          try {
            return (await resolveNovelSource(store, value)).id;
          } catch {
            return undefined;
          }
        },
      },
    });
    inspection = await inspectPreparation(root, { sourceId, branchId });
  }
  if (inspection.stage === "repair") throw preparationFailure(inspection);
  sourceId = inspection.source!.id;

  const preparedCache = new PreparedNovelCache(root, options.cacheRoot);
  if (options.restoreCache !== false) {
    const restored = await preparedCache.restore(inspection.source!);
    if (restored.status === "restored") {
      report(`Restored active prepared revision ${restored.bundleHash} for ${restored.contentMd5}; model compilation is not required.`);
      inspection = await inspectPreparation(root, { sourceId, branchId });
    } else if (restored.status === "workspace-not-empty" && restored.reason) {
      report(`Prepared cache was not restored: ${restored.reason}`);
    }
  }

  if (inspection.stage === "compile") {
    const decision = await ask({
      header: "Compile",
      question: `Compile all ${inspection.totalBatches - inspection.completedBatches} unfinished evidence batch(es) for ${inspection.source!.title}?`,
      options: [
        { value: "continue", label: "Compile all", description: "Run every remaining model-backed compiler batch.", recommended: true },
        { value: "pause", label: "Pause here", description: "Leave progress unchanged and print the next command." },
      ],
    });
    if (decision === "pause") return pausePreparation(inspection, report);
    report(`Compiling every unfinished evidence batch for ${sourceId}.`);
    await dependencies.compileSource({
      root,
      configPath,
      allowMissingConfig: true,
      sourceId,
      ...(options.model ? { model: options.model } : {}),
      resume: true,
      acquireLock: false,
      onProgress: report,
      onStatus: options.onStatus,
    });
  }

  inspection = await inspectPreparation(root, { sourceId, branchId });
  if (inspection.pending.length) {
    const decision = await ask({
      header: "Proposals",
      question: `Accept all ${inspection.pending.length} pending proposal(s) that pass deterministic validation?`,
      options: [
        { value: "accept", label: "Converge safely", description: "Commit validated proposals and preserve uncommittable drafts in rejected history.", recommended: true },
        { value: "review", label: "Review first", description: "Stop at the proposal review barrier without accepting anything." },
      ],
    });
    if (decision === "review") return pausePreparation(inspection, report);
    await convergeForPreparation(root, sourceId, dependencies.converge, report);
    inspection = await inspectPreparation(root, { sourceId, branchId });
  }

  if (inspection.stage === "needs-initial-world") {
    const decision = await ask({
      header: "Opening state",
      question: "No accepted opening world exists. Ask the compiler to propose one from opening evidence?",
      options: [
        { value: "generate", label: "Generate proposal", description: "Run one constrained compiler request for the initial world.", recommended: true },
        { value: "pause", label: "Pause here", description: "Leave the initial world unresolved for manual preparation." },
      ],
    });
    if (decision === "pause") return pausePreparation(inspection, report);
    report("No accepted initial world exists; compiling an opening-state proposal.");
    const openingBatch = await prepareOpeningWorldCompilerBatch(root, inspection.source!);
    try {
      await dependencies.compileInitialWorld({
        root,
        configPath,
        allowMissingConfig: true,
        ...(options.model ? { model: options.model } : {}),
        saveSession: false,
        prompt: `${INITIAL_WORLD_PROMPT}\n\n${openingBatch.prompt}`,
        segmentIds: openingBatch.segmentIds,
        compilerBatchId: openingBatch.id,
        sourceId,
        includeLocalTools: false,
        disabledProposalTools: ["propose_state_delta"],
        acquireLock: false,
        onProgress: report,
        onStatus: options.onStatus,
      });
    } catch (error) {
      report(`Opening-state model pass did not complete: ${error instanceof Error ? error.message : String(error)}`);
      const rejected = await rejectPendingCompilerBatchProposals(root, openingBatch.id);
      if (rejected.length) report(`Rejected ${rejected.length} partial opening-state proposal(s) before fallback.`);
    }
    inspection = await inspectPreparation(root, { sourceId, branchId });
    if (inspection.pending.length) {
      const acceptance = await ask({
        header: "Opening proposal",
        question: `Accept the ${inspection.pending.length} new proposal(s) that pass deterministic validation?`,
        options: [
          { value: "accept", label: "Converge safely", description: "Commit validated opening artifacts and reject uncommittable drafts.", recommended: true },
          { value: "review", label: "Review first", description: "Stop before committing the generated proposals." },
        ],
      });
      if (acceptance === "review") return pausePreparation(inspection, report);
      await convergeForPreparation(root, sourceId, dependencies.converge, report);
      inspection = await inspectPreparation(root, { sourceId, branchId });
    }
    if (inspection.stage === "needs-initial-world") {
      const fallbackId = await proposeMinimalOpeningWorld(root, inspection.source!);
      report(`No valid model opening state remained; created conservative empty-delta proposal ${fallbackId}.`);
      await convergeForPreparation(root, sourceId, dependencies.converge, report);
      inspection = await inspectPreparation(root, { sourceId, branchId });
    }
  }

  if (inspection.stage === "create-branch") {
    const cached = await preparedCache.publish(inspection.source!);
    cacheVerified = true;
    report(`${cached.status === "published" ? "Published" : "Verified"} prepared revision ${cached.bundleHash} for ${cached.contentMd5}.`);
    if (options.createBranch === false) {
      report("Preparation revision is complete; branch creation was intentionally skipped.");
      return inspection;
    }
    const decision = await ask({
      header: "Playable branch",
      question: `Create the playable branch '${branchId}' from the accepted opening world?`,
      options: [
        { value: "create", label: "Create branch", description: "Commit genesis and make the world playable.", recommended: true },
        { value: "pause", label: "Pause here", description: "Keep canonical preparation complete without creating a branch." },
      ],
    });
    if (decision === "pause") return pausePreparation(inspection, report);
    report(`Creating playable branch ${branchId}.`);
    await dependencies.createBranch(root, branchId);
    inspection = await inspectPreparation(root, { sourceId, branchId });
  }

  if (inspection.stage !== "ready") throw preparationFailure(inspection);
  if (!cacheVerified) {
    const cached = await preparedCache.publish(inspection.source!);
    report(`${cached.status === "published" ? "Published" : "Verified"} prepared revision ${cached.bundleHash} for ${cached.contentMd5}.`);
  }
  report(`Preparation complete. Next: ${inspection.next}`);
  return inspection;
}

async function convergeForPreparation(
  root: string,
  sourceId: string,
  converge: typeof convergeWorldProposals,
  report: (message: string) => void,
): Promise<void> {
  let lastReported = 0;
  const result = await converge(root, sourceId, {
    onProgress: (progress) => {
      if (progress.phase === "complete" || progress.processed === progress.total || progress.processed - lastReported >= 25) {
        report(`Convergence ${progress.phase}: ${progress.processed}/${progress.total} · accepted ${progress.accepted} · blocked ${progress.blocked}.`);
        lastReported = progress.processed;
      }
    },
  });
  printConvergence(result, report);
  const quarantined = await quarantineUncommittableProposals(root, result);
  for (const item of quarantined) {
    report(`Rejected uncommittable ${item.kind} proposal ${item.id}; preserved in rejected history.`);
  }
}

function printConvergence(result: WorldProposalConvergence, report: (message: string) => void): void {
  for (const item of result.canonical.accepted) report(`Accepted ${item.kind} proposal ${item.id}.`);
  for (const id of result.possibilities.accepted) report(`Accepted possibility proposal ${id}.`);
  for (const item of result.canonical.blocked) {
    report(`Blocked ${item.kind} proposal ${item.id}.`);
    for (const issue of item.errors) report(`- ${issue.code}: ${issue.message}`);
  }
  for (const item of result.possibilities.blocked) {
    report(`Blocked possibility proposal ${item.id}.`);
    for (const issue of item.errors) report(`- ${issue.code}: ${issue.message}`);
  }
  for (const item of result.staging) report(`Staging-only proposal remains: ${item.kind} ${item.id}.`);
}

function preparationFailure(inspection: PreparationInspection): Error {
  const diagnosis = inspection.repairReasons?.length
    ? ` ${inspection.repairReasons.join(" ")}`
    : "";
  return new Error(`Automatic preparation stopped at '${inspection.stage}'.${diagnosis} Next diagnostic step: ${inspection.next}`);
}

function pausePreparation(inspection: PreparationInspection, report: (message: string) => void): PreparationInspection {
  report(`Preparation paused at ${inspection.stage}. Next: ${inspection.next}`);
  return inspection;
}

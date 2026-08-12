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

export type PrepareAllCommandOptions = {
  root: string;
  configPath?: string;
  novelPath?: string;
  sourceId?: string;
  branchId?: string;
  model?: string;
  yes?: boolean;
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
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const root = path.resolve(options.root);
  const configPath = options.configPath ?? path.join(root, "novel-harness.yaml");
  const branchId = options.branchId ?? "main";
  const ask = options.yes ? recommendedAnswer() : dependencies.ask;
  let sourceId = options.sourceId;

  if (options.novelPath) {
    const config = await loadOptionalConfig(configPath);
    const ingested = await ingestWorkspaceSource(root, options.novelPath, config?.project);
    sourceId = ingested.document.id;
    stdout.write(`Registered ${ingested.document.sourcePath} as ${sourceId}; indexed ${ingested.manifest.segments.length} segment(s).\n`);
  }

  let inspection = await inspectPreparation(root, { sourceId, branchId });
  if (inspection.stage === "needs-source") {
    throw new Error("No novel source is registered. Pass a novel path to `nwh prepare-all <novel-path>`.");
  }
  if (inspection.stage === "choose-source") {
    sourceId = await ask({
      header: "Source",
      question: "Multiple novels are registered. Which source should be prepared?",
      options: inspection.sources.map((source, index) => ({
        value: source.id,
        label: source.title,
        description: `${source.sourcePath} (${source.id})`,
        recommended: index === 0,
      })),
    });
    inspection = await inspectPreparation(root, { sourceId, branchId });
  }
  if (inspection.stage === "repair") throw preparationFailure(inspection);
  sourceId = inspection.source!.id;

  if (inspection.stage === "compile") {
    const decision = await ask({
      header: "Compile",
      question: `Compile all ${inspection.totalBatches - inspection.completedBatches} unfinished evidence batch(es) for ${inspection.source!.title}?`,
      options: [
        { value: "continue", label: "Compile all", description: "Run every remaining model-backed compiler batch.", recommended: true },
        { value: "pause", label: "Pause here", description: "Leave progress unchanged and print the next command." },
      ],
    });
    if (decision === "pause") return pausePreparation(inspection);
    stdout.write(`Compiling every unfinished evidence batch for ${sourceId}.\n`);
    await dependencies.compileSource({
      root,
      configPath,
      allowMissingConfig: true,
      sourceId,
      ...(options.model ? { model: options.model } : {}),
      resume: true,
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
    if (decision === "review") return pausePreparation(inspection);
    await convergeForPreparation(root, sourceId, dependencies.converge);
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
    if (decision === "pause") return pausePreparation(inspection);
    stdout.write("No accepted initial world exists; compiling an opening-state proposal.\n");
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
      });
    } catch (error) {
      stdout.write(`Opening-state model pass did not complete: ${error instanceof Error ? error.message : String(error)}\n`);
      const rejected = await rejectPendingCompilerBatchProposals(root, openingBatch.id);
      if (rejected.length) stdout.write(`Rejected ${rejected.length} partial opening-state proposal(s) before fallback.\n`);
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
      if (acceptance === "review") return pausePreparation(inspection);
      await convergeForPreparation(root, sourceId, dependencies.converge);
      inspection = await inspectPreparation(root, { sourceId, branchId });
    }
    if (inspection.stage === "needs-initial-world") {
      const fallbackId = await proposeMinimalOpeningWorld(root, inspection.source!);
      stdout.write(`No valid model opening state remained; created conservative empty-delta proposal ${fallbackId}.\n`);
      await convergeForPreparation(root, sourceId, dependencies.converge);
      inspection = await inspectPreparation(root, { sourceId, branchId });
    }
  }

  if (inspection.stage === "create-branch") {
    const decision = await ask({
      header: "Playable branch",
      question: `Create the playable branch '${branchId}' from the accepted opening world?`,
      options: [
        { value: "create", label: "Create branch", description: "Commit genesis and make the world playable.", recommended: true },
        { value: "pause", label: "Pause here", description: "Keep canonical preparation complete without creating a branch." },
      ],
    });
    if (decision === "pause") return pausePreparation(inspection);
    stdout.write(`Creating playable branch ${branchId}.\n`);
    await dependencies.createBranch(root, branchId);
    inspection = await inspectPreparation(root, { sourceId, branchId });
  }

  if (inspection.stage !== "ready") throw preparationFailure(inspection);
  stdout.write(`Preparation complete. Next: ${inspection.next}\n`);
  return inspection;
}

async function convergeForPreparation(
  root: string,
  sourceId: string,
  converge: typeof convergeWorldProposals,
): Promise<void> {
  const result = await converge(root, sourceId);
  printConvergence(result);
  const quarantined = await quarantineUncommittableProposals(root, result);
  for (const item of quarantined) {
    stdout.write(`Rejected uncommittable ${item.kind} proposal ${item.id}; preserved in rejected history.\n`);
  }
}

function printConvergence(result: WorldProposalConvergence): void {
  for (const item of result.canonical.accepted) stdout.write(`Accepted ${item.kind} proposal ${item.id}.\n`);
  for (const id of result.possibilities.accepted) stdout.write(`Accepted possibility proposal ${id}.\n`);
  for (const item of result.canonical.blocked) {
    stdout.write(`Blocked ${item.kind} proposal ${item.id}.\n`);
    for (const issue of item.errors) stdout.write(`- ${issue.code}: ${issue.message}\n`);
  }
  for (const item of result.possibilities.blocked) {
    stdout.write(`Blocked possibility proposal ${item.id}.\n`);
    for (const issue of item.errors) stdout.write(`- ${issue.code}: ${issue.message}\n`);
  }
  for (const item of result.staging) stdout.write(`Staging-only proposal remains: ${item.kind} ${item.id}.\n`);
}

function preparationFailure(inspection: PreparationInspection): Error {
  return new Error(`Automatic preparation stopped at '${inspection.stage}'. Next diagnostic step: ${inspection.next}`);
}

function pausePreparation(inspection: PreparationInspection): PreparationInspection {
  stdout.write(`Preparation paused at ${inspection.stage}. Next: ${inspection.next}\n`);
  return inspection;
}

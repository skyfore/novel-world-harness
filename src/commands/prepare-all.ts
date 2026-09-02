import path from "node:path";
import { stdout } from "node:process";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { convergeWorldProposals, quarantineUncommittableProposals, type WorldProposalConvergence } from "../compiler/converge.js";
import { loadOptionalConfig } from "../config/load.js";
import { inspectPreparation, resolvePreparationBranchId, type PreparationInspection } from "../workflow/prepare.js";
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
import {
  buildWorldReconciliationPrompt,
  MAX_RECONCILIATION_ITERATIONS,
  narrativeGraphRepairIsTargetable,
  narrativeGraphRepairIterations,
  reparseReconciliationIterations,
  semanticRepairIsIsolated,
  semanticRepairRequiresReparse,
} from "../compiler/reconcile-world.js";
import type { ReparseCommandOptions } from "./reparse.js";
import {
  ENTITY_RESOLUTION_PROPOSAL_TOOL_NAMES,
  EVENT_RESOLUTION_PROPOSAL_TOOL_NAMES,
  SOURCE_ACCOUNTING_TOOL_NAMES,
  SOURCE_ANNOTATION_PROPOSAL_TOOL_NAMES,
} from "../compiler/proposal-tools.js";

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
  /** Active immutable revision that an enclosing reparse is using as its rollback baseline. */
  reparseBaselineBundleHash?: string;
  /** Stable identifier for resumable proposal namespaces inside an enclosing reparse. */
  reparseRunId?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onStatus?: (message: string) => void;
  onModelText?: (delta: string) => void;
  onModelThinking?: (delta: string) => void;
  onModelToolCall?: (name: string, input: unknown) => void;
  onModelToolResult?: (name: string, result: unknown, isError: boolean) => void;
  onModelEvent?: (event: AgentSessionEvent) => void;
};

type PrepareAllDependencies = {
  compileSource: typeof compileSourceCommand;
  compileInitialWorld: typeof compileCommand;
  converge: typeof convergeWorldProposals;
  createBranch: typeof worldCreateCommand;
  ask: AskUserQuestion;
  reparse: (options: ReparseCommandOptions) => Promise<unknown>;
};

const defaultDependencies: PrepareAllDependencies = {
  compileSource: compileSourceCommand,
  compileInitialWorld: compileCommand,
  converge: convergeWorldProposals,
  createBranch: worldCreateCommand,
  ask: askUserQuestion,
  reparse: async (options) => (await import("./reparse.js")).reparseCommand(options),
};

export const INITIAL_WORLD_PROMPT = `Inspect the selected opening evidence, whole-source evidence retrieval, and existing artifact catalog, then propose one evidence-backed initial world representing one explicit world-time cut, not merely the facts stated in the opening passage. Treat the player as a human who has never read the novel. Add a concise readerSetup and a structured readerContext whose facts establish the focal identity, time/place, every first-use character identity and relationship needed now, causal premises, completed pre-checkpoint beats, the actual holder and direction of relevant attitudes or social pressure, and the immediate unresolved situation. Add an entityGloss for every non-focal character referenced by those facts, explaining who that person is relative to the focal actor and why they matter now. Reader context is presentation-only and never character knowledge. Add one actorObservation for each physically present opening character, limited to that actor's direct checkpoint perception. readerSetup, every readerContext fact summary, entity-gloss relationship/relevance field, immediate-situation summary, and actorObservation summary requires its own exact explicit or strong-inference evidence_selector JSON Pointer; weak inference is not sufficient. Use find_source_evidence/read_source_evidence only to recover context that later discourse establishes as already true at or before the checkpoint; mark it later-discourse-preexisting. Never import the result of the unresolved opening situation, any later development, or later-acquired character knowledge. Set participantPresence explicitly for every character represented at the checkpoint; only bodily co-presence is physical, while mention, memory, dream, remote contact, or representation never establishes an opening role. Separate textual narrator frames, recollections, flashbacks, and lived chronology. Prefer the earliest playable chronological scene when it is present in the supplied evidence; otherwise mark a textual-frame checkpoint. Include checkpoint.mode and rationale, plus storyTime, narrativeLayerId, and beforeCanonicalEventId whenever supported. Never merge old-age frame facts with a younger remembered self. Retrieve exact existing artifact payloads as needed and seed grounded actionable state only for source characters bodily present at this checkpoint, including location, plan, momentum, and actor-known active relationships when supported. Do not create a catalog-wide alive inventory: later characters become playable through separate source-backed checkpoints attached to their first embodied canonical events. Store relationship entity IDs, never counterpart character IDs, in character.relationships. Propose genuinely missing referenced entities or base claims first. Finish the compiler batch explicitly after all proposal calls succeed.`;

export async function prepareAllCommand(
  options: PrepareAllCommandOptions,
  dependencyOverrides: Partial<PrepareAllDependencies> = {},
): Promise<PreparationInspection> {
  options.signal?.throwIfAborted();
  const root = path.resolve(options.root);
  if (options.acquireLock !== false) {
    return withWorkspaceOperationLock(root, "compiler", () =>
      prepareAllCommand({ ...options, root, acquireLock: false }, dependencyOverrides));
  }
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const configPath = options.configPath ?? path.join(root, "novel-harness.yaml");
  let branchId = options.branchId ?? "main";
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
  options.signal?.throwIfAborted();
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
  sourceId = inspection.source!.id;
  let preferNewBranch = false;
  const refreshDerivedBranchId = async (): Promise<boolean> => {
    if (options.branchId || !inspection.source) return false;
    const resolved = await resolvePreparationBranchId(
      root,
      inspection.source,
      undefined,
      { preferNew: preferNewBranch },
    );
    if (resolved === branchId && inspection.branchId === branchId) return false;
    branchId = resolved;
    inspection = await inspectPreparation(root, { sourceId, branchId });
    return true;
  };
  await refreshDerivedBranchId();
  const preparedCache = new PreparedNovelCache(root, options.cacheRoot);
  const cachedBeforePreparation = await preparedCache.lookup(inspection.source!);
  if (
    options.reparseBaselineBundleHash
    && cachedBeforePreparation.bundleHash !== options.reparseBaselineBundleHash
  ) {
    throw new Error(
      `Cannot finalize reparse against baseline ${options.reparseBaselineBundleHash}: `
      + `active prepared revision is ${cachedBeforePreparation.bundleHash ?? "missing"}.`,
    );
  }
  if (!options.reparseBaselineBundleHash && cachedBeforePreparation.requiresReparse) {
    const decision = await ask({
      header: "Pipeline upgrade",
      question: "The active prepared novel uses older world semantics. Reparse the whole novel before continuing?",
      options: [
        { value: "reparse", label: "Reparse all", description: "Preserve the old immutable revision and rebuild every source batch with the current world model.", recommended: true },
        { value: "pause", label: "Pause here", description: "Keep the legacy revision active and run an explicit reparse later." },
      ],
    });
    if (decision === "pause") {
      return pausePreparation({
        ...inspection,
        next: `nwh reparse --source ${sourceId} --all`,
      }, report);
    }
    report(`Prepared revision ${cachedBeforePreparation.bundleHash} requires a semantic pipeline upgrade; starting a rollback-safe whole-novel reparse.`);
    await dependencies.reparse({
      root,
      configPath,
      sourceId,
      all: true,
      ...(options.model ? { model: options.model } : {}),
      cacheRoot: options.cacheRoot,
      acquireLock: false,
      signal: options.signal,
      onProgress: report,
      onStatus: options.onStatus,
      onModelText: options.onModelText,
      onModelThinking: options.onModelThinking,
      onModelToolCall: options.onModelToolCall,
      onModelToolResult: options.onModelToolResult,
      onModelEvent: options.onModelEvent,
    });
    inspection = await inspectPreparation(root, { sourceId, branchId });
    if (!options.branchId) {
      preferNewBranch = true;
      await refreshDerivedBranchId();
      report(`Existing branches remain pinned to their prior revision; the upgraded world will use new branch '${branchId}'.`);
    }
  }
  if (
    inspection.stage === "repair"
    && !(
      inspection.audit
      && (
        semanticRepairIsIsolated(inspection.audit)
        || narrativeGraphRepairIsTargetable(inspection.audit)
        || (Boolean(options.reparseBaselineBundleHash) && semanticRepairRequiresReparse(inspection.audit))
      )
    )
  ) throw preparationFailure(inspection);

  if (options.restoreCache !== false) {
    const restored = await preparedCache.restore(inspection.source!);
    if (restored.status === "restored") {
      report(`Restored active prepared revision ${restored.bundleHash} for ${restored.contentMd5}; model compilation is not required.`);
      inspection = await inspectPreparation(root, { sourceId, branchId });
      await refreshDerivedBranchId();
    } else if (restored.status === "workspace-not-empty" && restored.reason) {
      report(`Prepared cache was not restored: ${restored.reason}`);
    }
  }

  if (inspection.stage === "compile") {
    options.signal?.throwIfAborted();
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
      signal: options.signal,
      onProgress: report,
      onStatus: options.onStatus,
      onModelText: options.onModelText,
      onModelThinking: options.onModelThinking,
      onModelToolCall: options.onModelToolCall,
      onModelToolResult: options.onModelToolResult,
      onModelEvent: options.onModelEvent,
    });
  }

  inspection = await inspectPreparation(root, { sourceId, branchId });
  await refreshDerivedBranchId();
  options.signal?.throwIfAborted();
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
    options.signal?.throwIfAborted();
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
    const repairNamespace = options.reparseRunId
      ? ` Every proposal envelope ID in this pass must end with -${options.reparseRunId}.`
      : "";
    try {
      await dependencies.compileInitialWorld({
        root,
        configPath,
        allowMissingConfig: true,
        ...(options.model ? { model: options.model } : {}),
        saveSession: false,
        prompt: `${INITIAL_WORLD_PROMPT}${repairNamespace}\n\n${openingBatch.prompt}`,
        segmentIds: openingBatch.segmentIds,
        compilerBatchId: openingBatch.id,
        sourceId,
        includeLocalTools: false,
        disabledProposalTools: [
          "propose_state_delta",
          ...SOURCE_ANNOTATION_PROPOSAL_TOOL_NAMES,
          ...ENTITY_RESOLUTION_PROPOSAL_TOOL_NAMES,
          ...EVENT_RESOLUTION_PROPOSAL_TOOL_NAMES,
        ],
        acquireLock: false,
        signal: options.signal,
        onProgress: report,
        onStatus: options.onStatus,
        onModelText: options.onModelText,
        onModelThinking: options.onModelThinking,
        onModelToolCall: options.onModelToolCall,
        onModelToolResult: options.onModelToolResult,
        onModelEvent: options.onModelEvent,
      });
    } catch (error) {
      options.signal?.throwIfAborted();
      report(`Opening-state model pass did not complete: ${error instanceof Error ? error.message : String(error)}`);
      const rejected = await rejectPendingCompilerBatchProposals(root, openingBatch.id);
      if (rejected.length) report(`Rejected ${rejected.length} partial opening-state proposal(s) before fallback.`);
    }
    inspection = await inspectPreparation(root, { sourceId, branchId });
    if (inspection.pending.length) {
      options.signal?.throwIfAborted();
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
      options.signal?.throwIfAborted();
      inspection = await inspectPreparation(root, { sourceId, branchId });
    }
    if (inspection.stage === "needs-initial-world") {
      const fallbackId = await proposeMinimalOpeningWorld(root, inspection.source!, {
        ...(options.reparseRunId ? { proposalIdSuffix: options.reparseRunId } : {}),
      });
      report(`No valid model opening state remained; created the restricted single-character opening fallback ${fallbackId}.`);
      await convergeForPreparation(root, sourceId, dependencies.converge, report);
      inspection = await inspectPreparation(root, { sourceId, branchId });
    }
  }

  if (inspection.audit && narrativeGraphRepairIsTargetable(inspection.audit)) {
    const plannedIterations = narrativeGraphRepairIterations(inspection.audit);
    const decision = await ask({
      header: "Event graph",
      question: `The canonical timeline has ${inspection.audit.consistency.unconditionalRootEvents.length} disconnected unconditional roots. Run ${plannedIterations} evidence-constrained graph adjudication shard(s)?`,
      options: [
        { value: "repair", label: "Adjudicate graph", description: "Review roots for explicit causes, enabling conditions, or genuine independence through normal validation.", recommended: true },
        { value: "pause", label: "Pause here", description: "Keep the graph finding for manual evidence review." },
      ],
    });
    if (decision === "pause") return pausePreparation(inspection, report);
    for (
      let iteration = 1;
      iteration <= plannedIterations && inspection.audit && narrativeGraphRepairIsTargetable(inspection.audit);
      iteration += 1
    ) {
      report(`Running narrative-graph adjudication shard ${iteration}/${plannedIterations}.`);
      await runWorldReconciliationPass({
        root,
        sourceId,
        branchId,
        configPath,
        iteration,
        mode: "graph-adjudication",
        inspection,
        options,
        dependencies,
        report,
      });
      inspection = await inspectPreparation(root, { sourceId, branchId });
    }
    if (inspection.audit?.consistency.narrativeGraphNavigable === false) {
      throw preparationFailure(inspection);
    }
  }

  if (inspection.audit && semanticRepairIsIsolated(inspection.audit)) {
    const decision = await ask({
      header: "World semantics",
      question: "The novel-scale audit found timeline/effect/character-growth gaps. Run a bounded whole-world reconciliation pass?",
      options: [
        { value: "repair", label: "Reconcile world", description: "Propose evidence-backed replacements through the normal validation barrier.", recommended: true },
        { value: "pause", label: "Pause here", description: "Keep the audit findings for manual repair." },
      ],
    });
    if (decision === "pause") return pausePreparation(inspection, report);
    for (
      let iteration = 1;
      iteration <= MAX_RECONCILIATION_ITERATIONS && inspection.audit && semanticRepairIsIsolated(inspection.audit);
      iteration += 1
    ) {
      report(`Running whole-world semantic reconciliation pass ${iteration}/${MAX_RECONCILIATION_ITERATIONS}.`);
      await runWorldReconciliationPass({
        root,
        sourceId,
        branchId,
        configPath,
        iteration,
        mode: "bounded",
        inspection,
        options,
        dependencies,
        report,
      });
      inspection = await inspectPreparation(root, { sourceId, branchId });
    }
  } else if (
    options.reparseBaselineBundleHash
    && inspection.audit
    && semanticRepairRequiresReparse(inspection.audit)
  ) {
    const plannedIterations = reparseReconciliationIterations(inspection.audit);
    report(`Whole-novel reparse needs ${plannedIterations} bounded semantic finalization shard(s).`);
    for (
      let iteration = 1;
      iteration <= plannedIterations && inspection.audit?.consistency.semanticReady === false;
      iteration += 1
    ) {
      report(`Running reparse semantic finalization shard ${iteration}/${plannedIterations}.`);
      await runWorldReconciliationPass({
        root,
        sourceId,
        branchId,
        configPath,
        iteration,
        mode: "reparse-finalization",
        inspection,
        options,
        dependencies,
        report,
      });
      inspection = await inspectPreparation(root, { sourceId, branchId });
      if (
        inspection.audit?.consistency.semanticReady === false
        && !semanticRepairRequiresReparse(inspection.audit)
        && !semanticRepairIsIsolated(inspection.audit)
      ) throw preparationFailure(inspection);
    }
  }

  if (inspection.stage === "create-branch") {
    const cached = await preparedCache.publish(inspection.source!, preparedRevisionPublishOptions(options));
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
    await dependencies.createBranch(root, branchId, undefined, sourceId, options.cacheRoot);
    options.signal?.throwIfAborted();
    inspection = await inspectPreparation(root, { sourceId, branchId });
  }

  if (inspection.stage !== "ready") throw preparationFailure(inspection);
  if (!cacheVerified) {
    const cached = await preparedCache.publish(inspection.source!, preparedRevisionPublishOptions(options));
    report(`${cached.status === "published" ? "Published" : "Verified"} prepared revision ${cached.bundleHash} for ${cached.contentMd5}.`);
  }
  report(`Preparation complete. Next: ${inspection.next}`);
  return inspection;
}

function preparedRevisionPublishOptions(options: PrepareAllCommandOptions) {
  if (!options.reparseBaselineBundleHash || !options.reparseRunId) return {};
  return {
    lineage: {
      operation: options.reparseRunId.startsWith("repair-") ? "repair" as const : "reparse" as const,
      parentBundleHash: options.reparseBaselineBundleHash,
      runId: options.reparseRunId,
    },
  };
}

async function runWorldReconciliationPass(input: {
  root: string;
  sourceId: string;
  branchId: string;
  configPath: string;
  iteration: number;
  mode: "bounded" | "reparse-finalization" | "graph-adjudication";
  inspection: PreparationInspection;
  options: PrepareAllCommandOptions;
  dependencies: PrepareAllDependencies;
  report: (message: string) => void;
}): Promise<void> {
  const audit = input.inspection.audit;
  if (!audit) throw new Error("Cannot reconcile a world without an audit report.");
  const namespace = input.options.reparseRunId
    ? ` Every proposal envelope ID in this pass must end with -${input.options.reparseRunId}.`
    : "";
  await input.dependencies.compileInitialWorld({
    root: input.root,
    configPath: input.configPath,
    allowMissingConfig: true,
    ...(input.options.model ? { model: input.options.model } : {}),
    saveSession: false,
    prompt: `${await buildWorldReconciliationPrompt(
      input.root,
      input.sourceId,
      audit,
      input.iteration,
      { mode: input.mode },
    )}${namespace}`,
    compilerBatchId: `reconcile-${input.sourceId}-${input.mode}-${input.options.reparseRunId ?? "v3"}-${input.iteration}`,
    sourceId: input.sourceId,
    includeLocalTools: false,
    disabledProposalTools: [
      "propose_state_delta",
      ...SOURCE_ANNOTATION_PROPOSAL_TOOL_NAMES,
      ...ENTITY_RESOLUTION_PROPOSAL_TOOL_NAMES,
      ...EVENT_RESOLUTION_PROPOSAL_TOOL_NAMES,
      ...SOURCE_ACCOUNTING_TOOL_NAMES,
    ],
    acquireLock: false,
    signal: input.options.signal,
    onProgress: input.report,
    onStatus: input.options.onStatus,
    onModelText: input.options.onModelText,
    onModelThinking: input.options.onModelThinking,
    onModelToolCall: input.options.onModelToolCall,
    onModelToolResult: input.options.onModelToolResult,
    onModelEvent: input.options.onModelEvent,
  });
  await convergeForPreparation(input.root, input.sourceId, input.dependencies.converge, input.report);
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

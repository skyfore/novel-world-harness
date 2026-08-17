import path from "node:path";
import { auditCompiler, type CompilerAuditReport } from "../compiler/audit.js";
import { CompilerBatchStore, prepareCompilerBatches, selectOpeningCompilerBatch } from "../compiler/batches.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { CanonicalModelStore, ProposalStore, type ProposalSummary } from "../world/canonical-model.js";
import { InitialWorldStore, type InitialWorld } from "../world/initial.js";
import { openWorkspaceWorld } from "../world/workspace-runtime.js";
import { BranchStore } from "../world/store.js";

export type PreparationStage =
  | "needs-source"
  | "choose-source"
  | "compile"
  | "review"
  | "repair"
  | "needs-initial-world"
  | "create-branch"
  | "ready";

export type PreparationInspection = {
  stage: PreparationStage;
  branchId: string;
  source?: SourceDocument;
  sources: SourceDocument[];
  pending: ProposalSummary[];
  completedBatches: number;
  totalBatches: number;
  audit?: CompilerAuditReport;
  repairReasons?: string[];
  next: string;
};

export async function resolvePreparationBranchId(
  workspaceRoot: string,
  source: SourceDocument,
  requestedBranchId?: string,
  options: { preferNew?: boolean } = {},
): Promise<string> {
  if (requestedBranchId) return requestedBranchId;
  const branches = new BranchStore(workspaceRoot);
  const ids = await branches.listIds();
  if (!ids.includes("main")) return "main";
  if (!options.preferNew && await preparationBranchMatchesSource(workspaceRoot, branches, "main", source.id)) return "main";

  const sourceStem = path.basename(source.sourcePath, path.extname(source.sourcePath))
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = `${sourceStem || "novel"}-${source.id.slice(0, 8)}`;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    if (!ids.includes(candidate)) return candidate;
    if (!options.preferNew && await preparationBranchMatchesSource(workspaceRoot, branches, candidate, source.id)) return candidate;
  }
}

async function preparationBranchMatchesSource(
  workspaceRoot: string,
  branches: BranchStore,
  branchId: string,
  sourceId: string,
): Promise<boolean> {
  const branch = await branches.read(branchId);
  if (branch.sourceId) return branch.sourceId === sourceId;
  return branchGenesisHasPlayableCharacter(workspaceRoot, branchId, sourceId);
}

export async function inspectPreparation(
  workspaceRoot: string,
  options: { sourceId?: string; branchId?: string } = {},
): Promise<PreparationInspection> {
  const branchId = options.branchId ?? "main";
  const workspace = await WorkspaceStore.create(workspaceRoot);
  const sources = await workspace.listSources();
  const base = { branchId, sources, pending: [], completedBatches: 0, totalBatches: 0 };
  if (!sources.length) {
    return { ...base, stage: "needs-source", next: "nwh prepare <novel-path>" };
  }

  const source = options.sourceId
    ? sources.find((candidate) => candidate.id === options.sourceId)
    : sources.length === 1 ? sources[0] : undefined;
  if (!source) {
    if (options.sourceId) throw new Error(`Unknown source id: ${options.sourceId}`);
    return {
      ...base,
      stage: "choose-source",
      next: `nwh prepare --source <id>  # ${sources.map((candidate) => candidate.id).join(", ")}`,
    };
  }

  const pending = await new ProposalStore(workspaceRoot).list("pending", source.id);
  // Preparation is source-local. A stale or invalid second novel must not
  // prevent this source from compiling or becoming playable.
  const earlyAudit = await auditCompiler(workspaceRoot, { sourceId: source.id });
  if (earlyAudit.sources.changedSinceIngest.length > 0) {
    return {
      branchId,
      sources,
      source,
      pending,
      completedBatches: 0,
      totalBatches: 0,
      audit: earlyAudit,
      repairReasons: preparationRepairReasons(earlyAudit),
      stage: "repair",
      next: `nwh audit --source ${source.id}`,
    };
  }

  const batches = await prepareCompilerBatches(workspaceRoot, source);
  const progress = await new CompilerBatchStore(workspaceRoot).read(source.id);
  const batchIds = new Set(batches.map((batch) => batch.id));
  const completedBatches = progress.completedBatchIds.filter((id) => batchIds.has(id)).length;
  const shared = { branchId, sources, source, pending, completedBatches, totalBatches: batches.length };
  if (completedBatches < batches.length) {
    return {
      ...shared,
      stage: "compile",
      next: `nwh prepare --source ${source.id}`,
    };
  }
  if (pending.length) {
    return {
      ...shared,
      stage: "review",
      next: `nwh proposals show ${pending[0]!.id}`,
    };
  }

  const audit = earlyAudit;
  if (
    audit.sources.changedSinceIngest.length > 0
    || audit.evidence.invalidReferences > 0
    || audit.consistency.causalGraphValid === false
    || audit.consistency.narrativeGraphNavigable === false
    || audit.consistency.semanticReady === false
  ) {
    return {
      ...shared,
      audit,
      repairReasons: preparationRepairReasons(audit),
      stage: "repair",
      next: `nwh audit --source ${source.id}`,
    };
  }
  const initialWorld = await new InitialWorldStore(workspaceRoot).get();
  if (!initialWorld || !initialWorld.evidence.some((reference) => reference.span.sourceId === source.id)) {
    return {
      ...shared,
      audit,
      stage: "needs-initial-world",
      next: "nwh compile \"Propose an evidence-backed initial world for the opening state\"",
    };
  }
  const openingBatch = selectOpeningCompilerBatch(batches);
  if (openingBatch && !initialWorld.evidence.some((reference) =>
    openingBatch.evidence.some((opening) => evidenceSpansOverlap(reference, opening)))) {
    return {
      ...shared,
      audit,
      stage: "needs-initial-world",
      repairReasons: [
        `The accepted initial world for source ${source.id} is grounded outside the selected narrative opening (lines ${openingBatch.startLine}-${openingBatch.endLine}); replace it before creating another branch.`,
      ],
      next: "nwh compile \"Propose an evidence-backed replacement initial world for the opening state\"",
    };
  }

  const sourceCharacters = (await new CanonicalModelStore(workspaceRoot).listEntities())
    .filter((entity) => entity.kind === "character")
    .filter((entity) => entity.evidence.some((reference) => reference.span.sourceId === source.id));
  if (!sourceCharacters.length) {
    return {
      ...shared,
      audit,
      stage: "repair",
      repairReasons: [
        `No committed character entities from source ${source.id} are available for player selection; a playable branch cannot be created. Reparse the source so at least one evidence-backed character is accepted.`,
      ],
      next: `nwh reparse --source ${source.id} --all`,
    };
  }
  if (!sourceCharacters.some((character) => characterPlayableAtGenesis(initialWorld, character.id))) {
    return {
      ...shared,
      audit,
      stage: "repair",
      repairReasons: [
        `The accepted initial world for source ${source.id} does not represent any living opening character in committed state or knowledge; a playable branch cannot be created. Rebuild the opening state before preparing a branch.`,
      ],
      next: `nwh reparse --source ${source.id} --all`,
    };
  }

  const branches = new BranchStore(workspaceRoot);
  if (!(await branchExists(branches, branchId))) {
    return { ...shared, audit, stage: "create-branch", next: `nwh prepare --source ${source.id} --branch ${branchId}` };
  }
  const branch = await branches.read(branchId);
  if (branch.sourceId && branch.sourceId !== source.id) {
    return {
      ...shared,
      audit,
      stage: "repair",
      repairReasons: [
        `Branch '${branchId}' belongs to source ${branch.sourceId}, not ${source.id}; prepare this novel on a different branch instead of mixing source timelines.`,
      ],
      next: `nwh prepare --source ${source.id} --branch <new-branch-id>`,
    };
  }
  if (!(await branchGenesisHasPlayableCharacter(workspaceRoot, branchId, source.id))) {
    return {
      ...shared,
      audit,
      stage: "repair",
      repairReasons: [
        `Branch '${branchId}' was created without a living committed character from source ${source.id}. Its pinned genesis snapshot is immutable; prepare a new branch after repairing the source/opening state instead of treating this branch as playable.`,
      ],
      next: `nwh prepare --source ${source.id} --branch <new-branch-id>`,
    };
  }
  return { ...shared, audit, stage: "ready", next: `nwh characters --branch ${branchId}` };
}

function evidenceSpansOverlap(left: InitialWorld["evidence"][number], right: InitialWorld["evidence"][number]): boolean {
  return left.span.sourceId === right.span.sourceId
    && left.span.startLine <= right.span.endLine
    && left.span.endLine >= right.span.startLine;
}

function preparationRepairReasons(audit: CompilerAuditReport): string[] {
  return [
    ...audit.sources.changedSinceIngest.map((sourceId) =>
      `Archived source material for ${sourceId} is missing or failed integrity verification; re-ingest the exact source bytes before preparing it.`),
    ...audit.evidence.errors.map((error) =>
      `Evidence ${error.artifact} failed ${error.code}: ${error.message}`),
    ...audit.consistency.causalCycles.map((cycle) =>
      `Causal cycle detected: ${cycle.join(" -> ")}`),
    ...audit.consistency.missingCausalParents.map(({ eventId, parentId }) =>
      `Event ${eventId} references missing causal parent ${parentId}.`),
    ...audit.consistency.temporalRegressions.map(({ eventId, parentId }) =>
      `Event ${eventId} is temporally earlier than its causal parent ${parentId}.`),
    ...(audit.consistency.narrativeGraphNavigable === false
      ? [`The event graph has ${audit.consistency.unconditionalRootEvents.length} unconditional roots across ${audit.consistency.causalComponents} causal components; reparse with phase gates and evidence-backed causal links so later canon cannot all activate at the opening.`]
      : []),
    ...audit.consistency.semanticIssues,
  ];
}

function characterPlayableAtGenesis(initialWorld: InitialWorld, characterId: string): boolean {
  let alive: boolean | undefined;
  let represented = false;
  for (const operation of initialWorld.delta.operations) {
    if (!("entityId" in operation) || !("field" in operation)) continue;
    if (operation.entityId === characterId) represented = true;
    if (operation.entityId !== characterId || operation.field !== "character.alive") continue;
    if (operation.op === "unset") alive = undefined;
    else if (operation.op === "set" && typeof operation.value === "boolean") alive = operation.value;
  }
  if (initialWorld.knowledge?.operations.some((operation) =>
    operation.actorId === characterId || (operation.op === "learn" && operation.sourceActorId === characterId))) represented = true;
  return represented && alive !== false;
}

async function branchGenesisHasPlayableCharacter(
  workspaceRoot: string,
  branchId: string,
  sourceId: string,
): Promise<boolean> {
  const { engine } = await openWorkspaceWorld(workspaceRoot);
  let genesisId = await engine.branches.readHead(branchId);
  for (;;) {
    const commit = await engine.objects.getCommit(genesisId);
    if (!commit.parentCommitId) break;
    genesisId = commit.parentCommitId;
  }
  const [context, state, genesis] = await Promise.all([
    engine.contextForCommit(genesisId),
    engine.projector.project(genesisId),
    engine.objects.getCommit(genesisId),
  ]);
  const participants = new Set<string>();
  for (const eventHash of genesis.eventHashes) {
    const event = await engine.objects.getEvent(eventHash);
    for (const participant of event.participants) participants.add(participant);
  }
  return [...context.entities.values()].some((entity) =>
    entity.kind === "character"
    && entity.evidence.some((reference) => reference.span.sourceId === sourceId)
    && participants.has(entity.id)
    && state.values[entity.id]?.["character.alive"] !== false);
}

async function branchExists(branches: BranchStore, branchId: string): Promise<boolean> {
  try {
    await branches.read(branchId);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

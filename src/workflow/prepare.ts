import { auditCompiler, type CompilerAuditReport } from "../compiler/audit.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../compiler/batches.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { ProposalStore, type ProposalSummary } from "../world/canonical-model.js";
import { InitialWorldStore } from "../world/initial.js";
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
  next: string;
};

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

  const pending = await new ProposalStore(workspaceRoot).list("pending");
  const earlyAudit = await auditCompiler(workspaceRoot);
  if (earlyAudit.sources.changedSinceIngest.length > 0) {
    return {
      branchId,
      sources,
      source,
      pending,
      completedBatches: 0,
      totalBatches: 0,
      audit: earlyAudit,
      stage: "repair",
      next: "nwh audit",
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
  ) {
    return { ...shared, audit, stage: "repair", next: "nwh audit" };
  }
  if (!(await new InitialWorldStore(workspaceRoot).get())) {
    return {
      ...shared,
      audit,
      stage: "needs-initial-world",
      next: "nwh compile \"Propose an evidence-backed initial world for the opening state\"",
    };
  }
  if (!(await branchExists(new BranchStore(workspaceRoot), branchId))) {
    return { ...shared, audit, stage: "create-branch", next: `nwh prepare --source ${source.id} --branch ${branchId}` };
  }
  return { ...shared, audit, stage: "ready", next: `nwh play-world --branch ${branchId} --list-characters` };
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

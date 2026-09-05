import { ProposalStore } from "../world/canonical-model.js";
import type { ValidationIssue } from "../world/model.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { CompilerCommitService, type BatchAcceptResult } from "./validator.js";
import { PossibilityCommitService, type PossibilityValidation } from "./possibility-commit.js";
import { EntityResolutionStore, inspectEntityResolutionCoverage } from "./entity-resolution.js";
import { EventResolutionStore, inspectEventResolutionCoverage } from "./event-resolution.js";

export type WorldProposalConvergence = {
  sourceId?: string;
  canonical: BatchAcceptResult;
  possibilities: {
    accepted: string[];
    blocked: Array<{ id: string; errors: PossibilityValidation["errors"] }>;
  };
  staging: Array<{ id: string; kind: string }>;
};

export type QuarantinedProposal = { id: string; kind: string };
export type WorldConvergenceProgress = {
  phase: "canonical" | "possibilities" | "complete";
  processed: number;
  total: number;
  accepted: number;
  blocked: number;
};

export async function convergeWorldProposals(
  workspaceRoot: string,
  sourceId?: string,
  options: { onProgress?: (progress: WorldConvergenceProgress) => void } = {},
): Promise<WorldProposalConvergence> {
  const canonical = await new CompilerCommitService(workspaceRoot).acceptAllValid(sourceId, (progress) => {
    options.onProgress?.({
      phase: "canonical",
      processed: progress.processed,
      total: progress.total,
      accepted: progress.accepted,
      blocked: progress.blocked,
    });
  });
  const proposals = new ProposalStore(workspaceRoot);
  const possibilityService = new PossibilityCommitService(workspaceRoot);
  const accepted: string[] = [];
  const blocked: Array<{ id: string; errors: PossibilityValidation["errors"] }> = [];

  const pending = await proposals.list("pending", sourceId);
  const possibilityProposals = pending.filter((item) => item.kind === "possibility");
  let processed = 0;
  for (const proposal of possibilityProposals) {
    const validation = await possibilityService.accept(proposal.id);
    if (validation.accepted) accepted.push(proposal.id);
    else blocked.push({ id: proposal.id, errors: validation.errors });
    processed += 1;
    options.onProgress?.({ phase: "possibilities", processed, total: possibilityProposals.length, accepted: accepted.length, blocked: blocked.length });
  }

  const remaining = await proposals.list("pending", sourceId);
  const blockedCanonicalIds = new Set(canonical.blocked.map((item) => item.id));
  const result = {
    ...(sourceId ? { sourceId } : {}),
    canonical,
    possibilities: { accepted, blocked },
    staging: remaining
      .filter((item) => item.kind !== "possibility" && !blockedCanonicalIds.has(item.id))
      .map((item) => ({ id: item.id, kind: item.kind })),
  };
  options.onProgress?.({
    phase: "complete",
    processed: canonical.accepted.length + canonical.blocked.length + possibilityProposals.length,
    total: canonical.accepted.length + canonical.blocked.length + possibilityProposals.length,
    accepted: canonical.accepted.length + accepted.length,
    blocked: canonical.blocked.length + blocked.length,
  });
  return result;
}

export async function quarantineUncommittableProposals(
  workspaceRoot: string,
  result: WorldProposalConvergence,
): Promise<QuarantinedProposal[]> {
  const proposals = new ProposalStore(workspaceRoot);
  const items = [
    ...result.canonical.blocked.map(({ id, kind }) => ({ id, kind })),
    ...result.possibilities.blocked.map(({ id }) => ({ id, kind: "possibility" })),
    ...result.staging,
  ];
  const unique = new Map(items.map((item) => [item.id, item]));
  const errorsById = new Map<string, ValidationIssue[]>([
    ...result.canonical.blocked.map((item): [string, ValidationIssue[]] => [item.id, item.errors]),
    ...result.possibilities.blocked.map((item): [string, ValidationIssue[]] => [item.id, item.errors]),
    ...result.staging.map((item): [string, ValidationIssue[]] => [item.id, [{
      code: "UNSUPPORTED_STAGING_PROPOSAL",
      message: `Proposal kind ${item.kind} has no canonical convergence handler.`,
    }]]),
  ]);
  const pendingIds = new Set((await proposals.list("pending")).map((item) => item.id));
  const moved: QuarantinedProposal[] = [];
  for (const item of unique.values()) {
    if (!pendingIds.has(item.id)) continue;
    await proposals.reject(item.id, errorsById.get(item.id) ?? [{
      code: "UNSPECIFIED_REJECTION",
      message: "Proposal was quarantined during convergence without a supplied validation diagnostic.",
    }]);
    moved.push(item);
  }
  moved.push(...await quarantineInvalidResolutionBindings(workspaceRoot, result.sourceId));
  return moved;
}

/**
 * Resolution refs are derived compiler metadata, not permission to retain a
 * dangling canonical identity. Quarantine accepted resolution proposals whose
 * selected/candidate artifacts did not survive deterministic convergence.
 */
export async function quarantineInvalidResolutionBindings(
  workspaceRoot: string,
  sourceId?: string,
): Promise<QuarantinedProposal[]> {
  const workspace = await WorkspaceStore.create(workspaceRoot);
  const selectedSource = sourceId ? await workspace.getSource(sourceId) : null;
  const sources = sourceId ? (selectedSource ? [selectedSource] : []) : await workspace.listSources();
  const quarantined: QuarantinedProposal[] = [];
  for (const source of sources) {
    const [entityCoverage, eventCoverage] = await Promise.all([
      inspectEntityResolutionCoverage(workspaceRoot, source.id),
      inspectEventResolutionCoverage(workspaceRoot, source.id),
    ]);
    const [entityProposalIds, eventProposalIds] = await Promise.all([
      new EntityResolutionStore(workspaceRoot).rejectAcceptedResolutionIds(
        source.id,
        entityCoverage.invalidResolutionIds,
      ),
      new EventResolutionStore(workspaceRoot).rejectAcceptedResolutionIds(
        source.id,
        eventCoverage.invalidResolutionIds,
      ),
    ]);
    quarantined.push(
      ...entityProposalIds.map((id) => ({ id, kind: "entity-resolution" })),
      ...eventProposalIds.map((id) => ({ id, kind: "event-resolution" })),
    );
  }
  return quarantined;
}

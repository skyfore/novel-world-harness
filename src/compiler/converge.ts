import { ProposalStore } from "../world/canonical-model.js";
import { CompilerCommitService, type BatchAcceptResult } from "./validator.js";
import { PossibilityCommitService, type PossibilityValidation } from "./possibility-commit.js";

export type WorldProposalConvergence = {
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
  const pendingIds = new Set((await proposals.list("pending")).map((item) => item.id));
  const moved: QuarantinedProposal[] = [];
  for (const item of unique.values()) {
    if (!pendingIds.has(item.id)) continue;
    await proposals.transition(item.id, "pending", "rejected");
    moved.push(item);
  }
  return moved;
}

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

export async function convergeWorldProposals(workspaceRoot: string, sourceId?: string): Promise<WorldProposalConvergence> {
  const canonical = await new CompilerCommitService(workspaceRoot).acceptAllValid(sourceId);
  const proposals = new ProposalStore(workspaceRoot);
  const possibilityService = new PossibilityCommitService(workspaceRoot);
  const accepted: string[] = [];
  const blocked: Array<{ id: string; errors: PossibilityValidation["errors"] }> = [];

  const pending = await proposals.list("pending", sourceId);
  for (const proposal of pending.filter((item) => item.kind === "possibility")) {
    const validation = await possibilityService.accept(proposal.id);
    if (validation.accepted) accepted.push(proposal.id);
    else blocked.push({ id: proposal.id, errors: validation.errors });
  }

  const remaining = await proposals.list("pending", sourceId);
  const blockedCanonicalIds = new Set(canonical.blocked.map((item) => item.id));
  return {
    canonical,
    possibilities: { accepted, blocked },
    staging: remaining
      .filter((item) => item.kind !== "possibility" && !blockedCanonicalIds.has(item.id))
      .map((item) => ({ id: item.id, kind: item.kind })),
  };
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
  for (const item of unique.values()) await proposals.transition(item.id, "pending", "rejected");
  return [...unique.values()];
}

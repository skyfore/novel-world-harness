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

export async function convergeWorldProposals(workspaceRoot: string): Promise<WorldProposalConvergence> {
  const canonical = await new CompilerCommitService(workspaceRoot).acceptAllValid();
  const proposals = new ProposalStore(workspaceRoot);
  const possibilityService = new PossibilityCommitService(workspaceRoot);
  const accepted: string[] = [];
  const blocked: Array<{ id: string; errors: PossibilityValidation["errors"] }> = [];

  const pending = await proposals.list("pending");
  for (const proposal of pending.filter((item) => item.kind === "possibility")) {
    const validation = await possibilityService.accept(proposal.id);
    if (validation.accepted) accepted.push(proposal.id);
    else blocked.push({ id: proposal.id, errors: validation.errors });
  }

  const remaining = await proposals.list("pending");
  return {
    canonical,
    possibilities: { accepted, blocked },
    staging: remaining
      .filter((item) => item.kind !== "possibility")
      .map((item) => ({ id: item.id, kind: item.kind })),
  };
}

import { stdout } from "node:process";
import { CompilerCommitService, type CanonicalProposalKind } from "../compiler/validator.js";
import { ProposalStore, type ProposalStatus } from "../world/canonical-model.js";

const canonicalKinds = new Set<CanonicalProposalKind>(["entity", "claim", "canonical-event", "world-rule"]);

export async function listProposalsCommand(root: string, status: ProposalStatus = "pending"): Promise<void> {
  const proposals = await new ProposalStore(root).list(status);
  if (!proposals.length) {
    stdout.write(`No ${status} proposals.\n`);
    return;
  }
  for (const proposal of proposals) {
    stdout.write(`${proposal.id}\t${proposal.kind}\t${proposal.worker}\t${proposal.createdAt}\n`);
  }
}

export async function acceptProposalCommand(root: string, kind: string, id: string): Promise<void> {
  if (!canonicalKinds.has(kind as CanonicalProposalKind)) {
    throw new Error(`Proposal kind '${kind}' is staging-only or unknown. Canonical acceptance supports: ${[...canonicalKinds].join(", ")}.`);
  }
  const service = new CompilerCommitService(root);
  const validation = await service.accept(kind as CanonicalProposalKind, id);
  if (!validation.accepted) {
    stdout.write(`Rejected by validation; proposal remains pending.\n`);
    for (const issue of validation.errors) stdout.write(`- ${issue.code}: ${issue.message}\n`);
    process.exitCode = 2;
    return;
  }
  stdout.write(`Accepted ${kind} proposal ${id} into canonical model.\n`);
  for (const warning of validation.warnings) stdout.write(`warning ${warning.code}: ${warning.message}\n`);
}

export async function rejectProposalCommand(root: string, id: string): Promise<void> {
  await new ProposalStore(root).transition(id, "pending", "rejected");
  stdout.write(`Rejected proposal ${id}.\n`);
}

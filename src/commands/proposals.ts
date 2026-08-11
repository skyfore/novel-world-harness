import { stdout } from "node:process";
import { CompilerCommitService, type CanonicalProposalKind } from "../compiler/validator.js";
import { ProposalStore, type ProposalStatus } from "../world/canonical-model.js";

const canonicalKinds = new Set<CanonicalProposalKind>([
  "entity",
  "claim",
  "canonical-event",
  "world-rule",
  "initial-world",
  "character-goal",
  "character-model",
]);

export async function listProposalsCommand(root: string, status: ProposalStatus = "pending"): Promise<void> {
  const proposals = await new ProposalStore(root).list(status);
  if (!proposals.length) { stdout.write(`No ${status} proposals.\n`); return; }
  for (const proposal of proposals) stdout.write(`${proposal.id}\t${proposal.kind}\t${proposal.worker}\t${proposal.createdAt}\n`);
}

export async function acceptProposalCommand(root: string, kind: string, id: string): Promise<void> {
  if (!canonicalKinds.has(kind as CanonicalProposalKind)) throw new Error(`Proposal kind '${kind}' is staging-only or unknown. Canonical acceptance supports: ${[...canonicalKinds].join(", ")}.`);
  const validation = await new CompilerCommitService(root).accept(kind as CanonicalProposalKind, id);
  if (!validation.accepted) {
    stdout.write(`Rejected by validation; proposal remains pending.\n`);
    for (const issue of validation.errors) stdout.write(`- ${issue.code}: ${issue.message}\n`);
    process.exitCode = 2;
    return;
  }
  stdout.write(`Accepted ${kind} proposal ${id} into canonical model.\n`);
  for (const warning of validation.warnings) stdout.write(`warning ${warning.code}: ${warning.message}\n`);
}

export async function acceptAllValidProposalsCommand(root: string): Promise<void> {
  const result = await new CompilerCommitService(root).acceptAllValid();
  for (const item of result.accepted) stdout.write(`accepted\t${item.kind}\t${item.id}\n`);
  for (const item of result.blocked) {
    stdout.write(`blocked\t${item.kind}\t${item.id}\n`);
    for (const error of item.errors) stdout.write(`  - ${error.code}: ${error.message}\n`);
  }
  for (const item of result.staging) stdout.write(`staging\t${item.kind}\t${item.id}\n`);
  if (!result.accepted.length && !result.blocked.length && !result.staging.length) stdout.write("No pending proposals.\n");
}

export async function rejectProposalCommand(root: string, id: string): Promise<void> {
  await new ProposalStore(root).transition(id, "pending", "rejected");
  stdout.write(`Rejected proposal ${id}.\n`);
}

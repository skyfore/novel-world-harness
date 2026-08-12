import { stdout } from "node:process";
import { convergeWorldProposals } from "../compiler/converge.js";
import { PossibilityCommitService } from "../compiler/possibility-commit.js";
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

export async function showProposalCommand(root: string, id: string, status: ProposalStatus = "pending"): Promise<void> {
  const proposal = await new ProposalStore(root).readEnvelope(status, id);
  stdout.write(`${JSON.stringify(proposal, null, 2)}\n`);
}

export async function acceptProposalCommand(root: string, kind: string, id: string): Promise<void> {
  if (kind === "possibility") {
    const validation = await new PossibilityCommitService(root).accept(id);
    if (!validation.accepted) {
      stdout.write("Rejected by validation; proposal remains pending.\n");
      for (const issue of validation.errors) stdout.write(`- ${issue.code}: ${issue.message}\n`);
      process.exitCode = 2;
      return;
    }
    stdout.write(`Accepted possibility proposal ${id} into the possibility template store.\n`);
    return;
  }
  if (!canonicalKinds.has(kind as CanonicalProposalKind)) throw new Error(`Proposal kind '${kind}' is staging-only or unknown. Acceptable kinds: ${[...canonicalKinds, "possibility"].join(", ")}.`);
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
  const result = await convergeWorldProposals(root);
  for (const item of result.canonical.accepted) stdout.write(`accepted\t${item.kind}\t${item.id}\n`);
  for (const id of result.possibilities.accepted) stdout.write(`accepted\tpossibility\t${id}\n`);
  for (const item of result.canonical.blocked) {
    stdout.write(`blocked\t${item.kind}\t${item.id}\n`);
    for (const error of item.errors) stdout.write(`  - ${error.code}: ${error.message}\n`);
  }
  for (const item of result.possibilities.blocked) {
    stdout.write(`blocked\tpossibility\t${item.id}\n`);
    for (const error of item.errors) stdout.write(`  - ${error.code}: ${error.message}\n`);
  }
  for (const item of result.staging) stdout.write(`staging\t${item.kind}\t${item.id}\n`);
  if (!result.canonical.accepted.length && !result.possibilities.accepted.length && !result.canonical.blocked.length && !result.possibilities.blocked.length && !result.staging.length) stdout.write("No pending proposals.\n");
}

export async function rejectProposalCommand(root: string, id: string): Promise<void> {
  await new ProposalStore(root).transition(id, "pending", "rejected");
  stdout.write(`Rejected proposal ${id}.\n`);
}

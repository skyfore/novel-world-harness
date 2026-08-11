import { z } from "zod";
import type { WorldEngine } from "./engine.js";
import { KnowledgeProjector } from "./knowledge.js";
import { eventProposalSchema, type CommitId, type EventProposal, type ValidationIssue } from "./model.js";

export const knowledgeAwareActionSchema = z
  .object({
    proposal: eventProposalSchema,
    requiresKnowledge: z.array(z.string().min(1)).default([]),
    forbidsKnowledge: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type KnowledgeAwareAction = z.infer<typeof knowledgeAwareActionSchema>;

export type ActionGateReport = {
  accepted: boolean;
  errors: ValidationIssue[];
  evaluatedAtCommit: CommitId;
};

export async function validateActionKnowledge(engine: WorldEngine, input: KnowledgeAwareAction): Promise<ActionGateReport> {
  const action = knowledgeAwareActionSchema.parse(input);
  const proposal = action.proposal;
  const head = await engine.branches.readHead(proposal.branchId);
  const errors: ValidationIssue[] = [];
  if (proposal.expectedParentCommit !== head) {
    errors.push({ code: "STALE_PARENT", message: `Expected ${proposal.expectedParentCommit}, current head is ${head}` });
  }
  if ((action.requiresKnowledge.length || action.forbidsKnowledge.length) && !proposal.actorId) {
    errors.push({ code: "KNOWLEDGE_ACTOR_REQUIRED", message: "Knowledge-gated actions require actorId" });
    return { accepted: false, errors, evaluatedAtCommit: head };
  }
  if (proposal.actorId) {
    const view = await new KnowledgeProjector(engine).view(proposal.actorId, head);
    const known = new Set(view.knowledge.filter((entry) => entry.fact.status !== "disbelieves").map((entry) => entry.fact.claimId));
    for (const claimId of action.requiresKnowledge) {
      if (!known.has(claimId)) errors.push({ code: "REQUIRED_KNOWLEDGE_MISSING", message: `${proposal.actorId} does not know ${claimId}` });
    }
    for (const claimId of action.forbidsKnowledge) {
      if (known.has(claimId)) errors.push({ code: "FORBIDDEN_KNOWLEDGE_PRESENT", message: `${proposal.actorId} already knows ${claimId}` });
    }
  }
  return { accepted: errors.length === 0, errors, evaluatedAtCommit: head };
}

export async function commitKnowledgeAwareAction(engine: WorldEngine, input: KnowledgeAwareAction): Promise<{
  gate: ActionGateReport;
  result?: Awaited<ReturnType<WorldEngine["commitProposal"]>>;
}> {
  const action = knowledgeAwareActionSchema.parse(input);
  const gate = await validateActionKnowledge(engine, action);
  if (!gate.accepted) return { gate };
  const proposal: EventProposal = { ...action.proposal, expectedParentCommit: gate.evaluatedAtCommit };
  return { gate, result: await engine.commitProposal(proposal) };
}

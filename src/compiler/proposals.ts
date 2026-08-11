import type { z } from "zod";
import { characterGoalSchema, characterModelSchema } from "../world/actors.js";
import { ProposalStore } from "../world/canonical-model.js";
import { initialWorldSchema } from "../world/initial.js";
import {
  canonicalEventSchema,
  claimSchema,
  entitySchema,
  evidenceRefSchema,
  possibilitySchema,
  stateDeltaSchema,
  worldRuleSchema,
  type ArtifactProposal,
  type EvidenceRef,
} from "../world/model.js";

export const possibilityTemplateSchema = possibilitySchema.omit({ branchId: true, evaluatedAtCommit: true });
export type CompilerProposalKind = "entity" | "claim" | "canonical-event" | "world-rule" | "initial-world" | "character-goal" | "character-model" | "state-delta" | "possibility";

const schemas = {
  entity: entitySchema,
  claim: claimSchema,
  "canonical-event": canonicalEventSchema,
  "world-rule": worldRuleSchema,
  "initial-world": initialWorldSchema,
  "character-goal": characterGoalSchema,
  "character-model": characterModelSchema,
  "state-delta": stateDeltaSchema,
  possibility: possibilityTemplateSchema,
} satisfies Record<CompilerProposalKind, z.ZodTypeAny>;

export class CompilerProposalService {
  readonly store: ProposalStore;
  constructor(workspaceRoot: string) { this.store = new ProposalStore(workspaceRoot); }
  async submit(kind: CompilerProposalKind, input: { proposalId: string; payload: unknown; evidence?: unknown; generatedBy: { worker: string; provider?: string; model?: string; promptHash?: string } }): Promise<{ proposalId: string; kind: CompilerProposalKind }> {
    const schema = schemas[kind];
    const payload = schema.parse(input.payload);
    const evidence = input.evidence === undefined ? [] : evidenceRefSchema.array().parse(input.evidence);
    const proposal: ArtifactProposal<unknown> = {
      id: input.proposalId,
      kind,
      schemaVersion: 1,
      payload,
      evidence: evidence as EvidenceRef[],
      generatedBy: input.generatedBy,
      createdAt: new Date().toISOString(),
    };
    await this.store.writePending(proposal, schema);
    return { proposalId: input.proposalId, kind };
  }
}

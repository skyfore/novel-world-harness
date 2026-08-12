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
import { DEFAULT_STATE_FIELDS } from "../world/state.js";

const possibilityTemplateSchema = possibilitySchema.omit({ branchId: true, evaluatedAtCommit: true });
export type CompilerProposalKind = "entity" | "claim" | "canonical-event" | "world-rule" | "initial-world" | "character-goal" | "character-model" | "state-delta" | "possibility";
export const COMPILER_STATE_FIELDS = DEFAULT_STATE_FIELDS.map((field) => field.key);
const compilerStateFieldSet = new Set(COMPILER_STATE_FIELDS);
const stateFieldOperations = new Set(["set", "unset", "add-member", "remove-member", "fact-equals", "fact-exists", "entity-in"]);

export const compilerProposalSchemas = {
  entity: entitySchema.extend({ evidence: evidenceRefSchema.array().min(1) }),
  claim: claimSchema.extend({ evidence: evidenceRefSchema.array().min(1) }),
  "canonical-event": canonicalEventSchema.extend({ evidence: evidenceRefSchema.array().min(1) }),
  "world-rule": worldRuleSchema.extend({ evidence: evidenceRefSchema.array().min(1) }),
  "initial-world": initialWorldSchema,
  "character-goal": characterGoalSchema,
  "character-model": characterModelSchema,
  "state-delta": stateDeltaSchema,
  possibility: possibilityTemplateSchema.extend({ evidence: evidenceRefSchema.array().min(1) }),
} satisfies Record<CompilerProposalKind, z.ZodTypeAny>;

export class CompilerProposalService {
  readonly store: ProposalStore;
  constructor(workspaceRoot: string) { this.store = new ProposalStore(workspaceRoot); }
  async submit(kind: CompilerProposalKind, input: { proposalId: string; payload: unknown; evidence?: unknown; generatedBy: { worker: string; provider?: string; model?: string; promptHash?: string } }): Promise<{ proposalId: string; kind: CompilerProposalKind }> {
    const schema = compilerProposalSchemas[kind];
    const payload = schema.parse(input.payload);
    if (kind !== "entity" && kind !== "claim" && kind !== "character-model") assertCompilerStateFields(payload);
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

function assertCompilerStateFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertCompilerStateFields(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.op === "string" && stateFieldOperations.has(record.op) && typeof record.field === "string" && !compilerStateFieldSet.has(record.field)) {
    throw new Error(`Unsupported compiler state field '${record.field}'. Allowed fields: ${COMPILER_STATE_FIELDS.join(", ")}.`);
  }
  for (const nested of Object.values(record)) assertCompilerStateFields(nested);
}

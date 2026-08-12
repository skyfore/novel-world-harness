import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { z } from "zod";
import { evidenceRefSchema, idSchema } from "../world/model.js";
import {
  compilerProposalSchemas,
  COMPILER_STATE_FIELDS,
  CompilerProposalService,
  validateCompilerProposalClosure,
  type CompilerProposalKind,
} from "./proposals.js";

function proposalResult(text: string, details: { proposalId: string; kind: CompilerProposalKind }) {
  return { content: [{ type: "text" as const, text }], details };
}

const labels: Record<CompilerProposalKind, { name: string; label: string; description: string }> = {
  entity: { name: "propose_entity", label: "Propose entity", description: "Submit a typed entity candidate backed by source evidence. This creates a pending proposal only." },
  claim: { name: "propose_claim", label: "Propose claim", description: "Submit an evidence-backed claim candidate. This does not commit canonical truth." },
  "canonical-event": { name: "propose_canonical_event", label: "Propose canonical event", description: "Submit an explicitly narrated canonical event with preconditions, deterministic state outcome, and any observed character-knowledge change. Later canon remains a candidate until runtime commitment." },
  "world-rule": { name: "propose_world_rule", label: "Propose world rule", description: "Submit a temporal in-world rule candidate. Engine invariants cannot be modified through this tool." },
  "initial-world": { name: "propose_initial_world", label: "Propose initial world", description: "Submit the evidence-backed canonical seed StateDelta used to create a runtime genesis branch." },
  "character-goal": { name: "propose_character_goal", label: "Propose character goal", description: "Submit an evidence-backed actor goal and optional candidate action. Goals are policy inputs, not world facts." },
  "character-model": { name: "propose_character_model", label: "Propose character model", description: "Submit evidence-backed traits and decision biases for one actor. The model never grants omniscient knowledge." },
  "state-delta": { name: "propose_state_delta", label: "Propose state delta", description: "Submit a deterministic state-delta candidate for later validation. This never moves a branch head." },
  possibility: { name: "propose_possibility", label: "Propose possibility", description: "Submit an uncommitted future possibility. canon-analogue is reserved for a real canonicalEventId; a choice only the player may make must use player-choice. Do not submit actor-plan templates; actor intent belongs in character goals." },
};

type ProposalToolInput = {
  proposal_id: string;
  payload: unknown;
  evidence?: unknown[];
};

function parseJsonArgument(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${field} must be a JSON value, not an invalid JSON string.`);
  }
}

export function prepareProposalToolArguments(args: unknown): ProposalToolInput {
  const parsed = parseJsonArgument(args, "Tool arguments");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed as ProposalToolInput;
  const normalized = { ...(parsed as Record<string, unknown>) };
  if ("payload" in normalized) normalized.payload = parseJsonArgument(normalized.payload, "payload");
  if ("evidence" in normalized) normalized.evidence = parseJsonArgument(normalized.evidence, "evidence");
  return normalized as ProposalToolInput;
}

function proposalToolParameters(kind: CompilerProposalKind) {
  const inputSchema = z.object({
    proposal_id: idSchema,
    payload: compilerProposalSchemas[kind],
    evidence: z.array(evidenceRefSchema).optional(),
  }).strict();
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(inputSchema);
  constrainCompilerStateFields(jsonSchema);
  return Type.Unsafe<ProposalToolInput>(jsonSchema as TSchema);
}

function constrainCompilerStateFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) constrainCompilerStateFields(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const properties = record.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const propertyRecord = properties as Record<string, unknown>;
    const op = propertyRecord.op;
    const operation = op && typeof op === "object" && !Array.isArray(op)
      ? (op as Record<string, unknown>).const
      : undefined;
    if (
      typeof operation === "string" &&
      ["set", "unset", "add-member", "remove-member", "fact-equals", "fact-exists", "entity-in"].includes(operation) &&
      propertyRecord.field
    ) {
      propertyRecord.field = {
        type: "string",
        enum: COMPILER_STATE_FIELDS,
        description: "A registered deterministic world-state field. character.* applies only to characters; artifact.owner only to artifacts; location.open only to locations; faction.leader only to factions.",
      };
    }
  }
  for (const nested of Object.values(record)) constrainCompilerStateFields(nested);
}

export type CompilerProposalToolset = {
  tools: ToolDefinition[];
  beginBatch(segmentIds?: readonly string[]): void;
};

const MAX_CONSECUTIVE_FINISH_FAILURES = 3;
const MAX_IDENTICAL_FINISH_FAILURES = 2;
const MAX_TOTAL_FINISH_FAILURES = 5;

type CompilerFinishDetails =
  | { compilerBatchBlocked: true; reason: string; finishFailureCount: number }
  | { compilerBatchFinished: true; outcome: "complete" | "no-artifacts"; proposalIds: string[]; reviewedSegmentIds: string[] };

export function createCompilerProposalToolset(
  workspaceRoot: string,
  generatedBy: { provider?: string; model?: string } = {},
): CompilerProposalToolset {
  const service = new CompilerProposalService(workspaceRoot);
  const successfulProposalIds = new Set<string>();
  let expectedSegmentIds: string[] = [];
  let finished = false;
  let circuitBreak: { reason: string; failureCount: number } | undefined;
  let totalFinishFailures = 0;
  let consecutiveFinishFailures = 0;
  const finishFailureCounts = new Map<string, number>();

  const circuitBreakResult = (reason: string, failureCount: number) => ({
    content: [{
      type: "text" as const,
      text: `Compiler batch stopped by its finish circuit breaker after ${failureCount} failed finish attempt(s). The batch was not checkpointed. Last error: ${reason}`,
    }],
    details: { compilerBatchBlocked: true as const, reason, finishFailureCount: failureCount },
    terminate: true,
  });
  const failFinish = (reason: string) => {
    totalFinishFailures += 1;
    consecutiveFinishFailures += 1;
    const identicalFailures = (finishFailureCounts.get(reason) ?? 0) + 1;
    finishFailureCounts.set(reason, identicalFailures);
    if (
      consecutiveFinishFailures >= MAX_CONSECUTIVE_FINISH_FAILURES
      || identicalFailures >= MAX_IDENTICAL_FINISH_FAILURES
      || totalFinishFailures >= MAX_TOTAL_FINISH_FAILURES
    ) {
      circuitBreak = { reason, failureCount: totalFinishFailures };
      return circuitBreakResult(reason, totalFinishFailures);
    }
    throw new Error(reason);
  };
  const recordProposalProgress = () => {
    consecutiveFinishFailures = 0;
  };
  const assertBatchWritable = () => {
    if (finished) throw new Error("Compiler batch was already finished; no more proposals may be submitted in this turn.");
    if (circuitBreak) throw new Error("Compiler batch was stopped by its finish circuit breaker; start a new batch turn to retry.");
  };

  const proposalTools = (Object.keys(labels) as CompilerProposalKind[]).map((kind) => {
    const metadata = labels[kind];
    return defineTool({
      name: metadata.name,
      label: metadata.label,
      description: metadata.description,
      promptSnippet: metadata.description,
      promptGuidelines: ["Search/read source evidence before proposing.", "Never claim a proposal is committed world truth.", "Use stable logical IDs and include precise evidence in the payload where the schema requires it.", "Use ASCII logical entity IDs, never display names or descriptions, in state entity-reference values such as character.inventory."],
      parameters: proposalToolParameters(kind),
      prepareArguments: prepareProposalToolArguments,
      async execute(_id, input, signal) {
        signal?.throwIfAborted();
        assertBatchWritable();
        const accepted = await service.submit(kind, { proposalId: input.proposal_id, payload: input.payload, evidence: input.evidence, generatedBy: { worker: metadata.name, ...generatedBy } });
        successfulProposalIds.add(accepted.proposalId);
        recordProposalProgress();
        return proposalResult(
          `Pending ${accepted.kind} proposal ${accepted.proposalId} recorded. It is not committed truth.`,
          accepted,
        );
      },
    });
  });
  const withdrawParameters = Type.Object({
    proposal_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  }, { additionalProperties: false });
  const withdrawTool = defineTool({
    name: "withdraw_compiler_proposal",
    label: "Withdraw compiler proposal",
    description: "Withdraw an invalid proposal successfully submitted in the current compiler batch. The immutable candidate moves to rejected history and is removed from the finish handshake; submit any corrected replacement under a new proposal ID first.",
    promptSnippet: "Withdraw an invalid current-batch proposal before finishing",
    promptGuidelines: [
      "Use this only for a proposal successfully submitted in the current compiler batch.",
      "Explain the concrete defect, and submit an evidence-backed corrected replacement under a new proposal ID when the evidence still supports the artifact.",
    ],
    executionMode: "sequential",
    parameters: withdrawParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      assertBatchWritable();
      if (!successfulProposalIds.has(input.proposal_id)) {
        throw new Error(`Cannot withdraw ${input.proposal_id}: it is not an active successful submission in this compiler batch.`);
      }
      await service.withdraw(input.proposal_id);
      successfulProposalIds.delete(input.proposal_id);
      recordProposalProgress();
      return {
        content: [{ type: "text" as const, text: `Compiler proposal ${input.proposal_id} withdrawn to rejected history: ${input.reason}` }],
        details: { compilerProposalWithdrawn: true, proposalId: input.proposal_id, reason: input.reason },
      };
    },
  });
  const finishParameters = Type.Object({
    outcome: Type.Union([Type.Literal("complete"), Type.Literal("no-artifacts")]),
    proposal_ids: Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }), { uniqueItems: true }),
    reviewed_segments: Type.Array(Type.Object({
      segment_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
      disposition: Type.Union([Type.Literal("proposed"), Type.Literal("no-artifacts")]),
      summary: Type.String({ minLength: 1, maxLength: 500 }),
    }, { additionalProperties: false })),
    summary: Type.String({ minLength: 1, maxLength: 2_000 }),
  }, { additionalProperties: false });
  const finishTool = defineTool<typeof finishParameters, CompilerFinishDetails>({
    name: "finish_compiler_batch",
    label: "Finish compiler batch",
    description: "Explicitly finish this evidence batch after its active proposal graph is valid. This is required before NWH checkpoints the batch.",
    promptSnippet: "Finish the compiler batch only after proposal work is complete",
    promptGuidelines: [
      "Call this after all propose_* calls and after withdrawing any invalid successful draft.",
      "Use outcome=complete with every active successfully submitted proposal_id, or no-artifacts only when the evidence supports no active proposals.",
      "After a failed finish, correct the reported issue or proposal ID set before trying again; never repeat an identical failing call.",
    ],
    executionMode: "sequential",
    parameters: finishParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      if (finished) throw new Error("Compiler batch was already finished.");
      if (circuitBreak) return circuitBreakResult(circuitBreak.reason, circuitBreak.failureCount);
      const supplied = new Set(input.proposal_ids);
      const expected = [...successfulProposalIds].sort();
      const listed = [...supplied].sort();
      if (input.outcome === "no-artifacts" && expected.length > 0) {
        return failFinish("no-artifacts cannot be used after active successful proposal submissions.");
      }
      if (input.outcome === "complete" && expected.length === 0) {
        return failFinish("complete requires at least one active successful proposal submission.");
      }
      if (expected.length !== listed.length || expected.some((id, index) => id !== listed[index])) {
        return failFinish(`proposal_ids must exactly match active successful submissions: ${expected.join(", ") || "(none)"}`);
      }
      const reviewedIds = input.reviewed_segments.map((review) => review.segment_id).sort();
      const uniqueReviewedIds = [...new Set(reviewedIds)];
      if (
        uniqueReviewedIds.length !== expectedSegmentIds.length
        || expectedSegmentIds.some((id, index) => id !== uniqueReviewedIds[index])
        || reviewedIds.length !== uniqueReviewedIds.length
      ) {
        return failFinish(`reviewed_segments must account exactly once for: ${expectedSegmentIds.join(", ") || "(none)"}`);
      }
      const closureIssues = await validateCompilerProposalClosure(workspaceRoot, listed);
      if (closureIssues.length) {
        return failFinish(`Compiler batch proposal graph is incomplete:\n- ${closureIssues.join("\n- ")}`);
      }
      finished = true;
      return {
        content: [{ type: "text" as const, text: `Compiler batch explicitly finished (${input.outcome}).` }],
        details: { compilerBatchFinished: true, outcome: input.outcome, proposalIds: listed, reviewedSegmentIds: reviewedIds },
      };
    },
  });
  return {
    tools: [...proposalTools, withdrawTool, finishTool],
    beginBatch(segmentIds = []) {
      successfulProposalIds.clear();
      expectedSegmentIds = [...new Set(segmentIds)].sort();
      finished = false;
      circuitBreak = undefined;
      totalFinishFailures = 0;
      consecutiveFinishFailures = 0;
      finishFailureCounts.clear();
    },
  };
}

export function createCompilerProposalTools(
  workspaceRoot: string,
  generatedBy: { provider?: string; model?: string } = {},
): ToolDefinition[] {
  return createCompilerProposalToolset(workspaceRoot, generatedBy).tools;
}

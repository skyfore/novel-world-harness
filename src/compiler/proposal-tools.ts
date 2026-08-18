import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";
import { Type, type TSchema } from "typebox";
import { z } from "zod";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { evidenceRefSchema, idSchema, type EvidenceRef } from "../world/model.js";
import {
  compilerProposalLogicalIdentity,
  compilerProposalSchemas,
  COMPILER_STATE_FIELDS,
  CompilerProposalService,
  validateCompilerProposalClosure,
  type CompilerProposalKind,
} from "./proposals.js";
import { createCompilerArtifactRetrievalTools } from "./artifact-retrieval.js";
import { createCompilerSourceEvidenceTools, SOURCE_EVIDENCE_TOOL_NAMES } from "./source-evidence-retrieval.js";
import { readSegmentText, segmentSource, SegmentStore, type SourceSegment } from "./segments.js";
import { BoundaryCalibrationStore, type BoundaryCalibrationRequest } from "./boundary-calibration.js";
import { promptJson } from "../util/prompt-data.js";
import { safeTextPrefix } from "../util/text-pages.js";
import {
  CHAPTER_SPLIT_DISCOVERY_VERSION,
  ChapterSplitPlanStore,
  evaluateChapterSplitPlan,
  type ChapterSplitPlan,
} from "./chapter-split.js";

function proposalResult(text: string, details: CompilerProposalRecordedDetails) {
  return { content: [{ type: "text" as const, text }], details };
}

const labels: Record<CompilerProposalKind, { name: string; label: string; description: string }> = {
  entity: { name: "propose_entity", label: "Propose entity", description: "Submit a typed entity candidate backed by source evidence. This creates a pending proposal only." },
  claim: { name: "propose_claim", label: "Propose claim", description: "Submit an evidence-backed base-world claim candidate. Character knowledge or ignorance is never a claim predicate; represent learning only in a KnowledgeDelta. This does not commit canonical truth." },
  "canonical-event": { name: "propose_canonical_event", label: "Propose canonical event", description: "Submit an explicitly narrated canonical event with preconditions, deterministic state outcome, and any observed character-knowledge change. Later canon remains a candidate until runtime commitment." },
  "world-rule": { name: "propose_world_rule", label: "Propose world rule", description: "Submit a temporal in-world rule candidate. Engine invariants cannot be modified through this tool." },
  "initial-world": { name: "propose_initial_world", label: "Propose initial world", description: "Submit the evidence-backed canonical seed StateDelta used to create a runtime genesis branch." },
  "character-goal": { name: "propose_character_goal", label: "Propose character goal", description: "Submit an evidence-backed actor goal and optional candidate action. Goals are policy inputs, not world facts." },
  "character-model": { name: "propose_character_model", label: "Propose character model", description: "Submit an evidence-backed baseline plus event/knowledge/state/time-activated development phases for one actor. The model never grants omniscient knowledge." },
  "state-delta": { name: "propose_state_delta", label: "Propose state delta", description: "Submit a deterministic state-delta candidate for later validation. This never moves a branch head." },
  possibility: { name: "propose_possibility", label: "Propose possibility", description: "Submit an uncommitted future possibility. canon-analogue is reserved for a real canonicalEventId; a choice only the player may make must use player-choice. Do not submit actor-plan templates; actor intent belongs in character goals." },
};

/** Exact model-tool authority owned by the compiler embedding. */
export const COMPILER_TOOL_NAMES: readonly string[] = Object.freeze([
  "configure_chapter_split",
  "find_compiler_artifacts",
  "read_compiler_artifact",
  ...SOURCE_EVIDENCE_TOOL_NAMES,
  "peek_adjacent_evidence",
  "defer_boundary_artifact",
  ...Object.values(labels).map(({ name }) => name),
  "withdraw_compiler_proposal",
  "replace_boundary_proposal",
  "finish_compiler_batch",
]);

export const BOUNDARY_CALIBRATION_TOOL_NAMES = [
  "peek_adjacent_evidence",
  "defer_boundary_artifact",
  "replace_boundary_proposal",
] as const;

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

export function prepareProposalToolArguments(
  args: unknown,
  kind?: CompilerProposalKind,
): ProposalToolInput {
  const parsed = parseJsonArgument(args, "Tool arguments");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed as ProposalToolInput;
  const normalized = { ...(parsed as Record<string, unknown>) };
  if ("payload" in normalized) normalized.payload = parseJsonArgument(normalized.payload, "payload");
  if ("evidence" in normalized) normalized.evidence = parseJsonArgument(normalized.evidence, "evidence");
  if (
    kind !== "state-delta"
    && Array.isArray(normalized.evidence)
    && normalized.payload
    && typeof normalized.payload === "object"
    && !Array.isArray(normalized.payload)
    && !("evidence" in normalized.payload)
  ) {
    normalized.payload = { ...(normalized.payload as Record<string, unknown>), evidence: normalized.evidence };
  }
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
      ["set", "unset", "add-member", "remove-member", "adjust-number", "fact-equals", "fact-gte", "fact-lte", "fact-exists", "entity-in"].includes(operation) &&
      propertyRecord.field
    ) {
      propertyRecord.field = {
        type: "string",
        enum: COMPILER_STATE_FIELDS,
        description: "A registered deterministic world-state field whose entity-kind and value constraints are validated by the host.",
      };
    }
  }
  for (const nested of Object.values(record)) constrainCompilerStateFields(nested);
}

export type CompilerProposalToolset = {
  tools: ToolDefinition[];
  beginBatch(segmentIds?: readonly string[], compilerBatchId?: string, sourceId?: string): Promise<void>;
};

const MAX_CONSECUTIVE_FINISH_FAILURES = 3;
const MAX_IDENTICAL_FINISH_FAILURES = 2;
const MAX_TOTAL_FINISH_FAILURES = 5;
const MAX_COMPILER_TOOL_CALLS = 40;
const MAX_ACTIVE_COMPILER_PROPOSALS = 24;
const MAX_FINISH_GRACE_CALLS = 1;

type CompilerBatchBlockedDetails = {
  compilerBatchBlocked: true;
  reason: string;
  finishFailureCount: number;
  toolCallCount: number;
};

type CompilerFinishDetails =
  | CompilerBatchBlockedDetails
  | { compilerBatchFinished: true; outcome: "complete" | "no-artifacts"; proposalIds: string[]; reviewedSegmentIds: string[] };

type CompilerProposalRecordedDetails = {
  proposalId: string;
  kind: CompilerProposalKind;
  activeProposalCount: number;
  toolCallCount: number;
  remainingToolCalls: number;
};

type CompilerProposalDetails =
  | CompilerBatchBlockedDetails
  | CompilerProposalRecordedDetails;

type CompilerWithdrawDetails =
  | CompilerBatchBlockedDetails
  | { compilerProposalWithdrawn: true; proposalId: string; reason: string };

type BoundaryCalibrationDetails =
  | CompilerBatchBlockedDetails
  | { compilerBoundaryCalibrationRequested: true; calibrationBatchId: string; direction: "previous" | "next" };

type AdjacentEvidencePeekDetails =
  | CompilerBatchBlockedDetails
  | { compilerAdjacentEvidencePeek: true; direction: "previous" | "next"; adjacentSegmentId: string };

type BoundaryReplacementDetails =
  | CompilerBatchBlockedDetails
  | { compilerBoundaryProposalReplaced: true; proposalId: string; replacementProposalId: string; reason: string };

type ChapterSplitDetails =
  | CompilerBatchBlockedDetails
  | { compilerChapterSplitConfigured: true; mode: "builtin" | "custom"; headingCount: number };

function safeTextSuffix(text: string, maxChars: number): string {
  let start = Math.max(0, text.length - maxChars);
  if (start > 0 && start < text.length
    && text.charCodeAt(start - 1) >= 0xD800 && text.charCodeAt(start - 1) <= 0xDBFF
    && text.charCodeAt(start) >= 0xDC00 && text.charCodeAt(start) <= 0xDFFF) {
    start += 1;
  }
  return text.slice(start);
}

export function createCompilerProposalToolset(
  workspaceRoot: string,
  generatedBy: { provider?: string; model?: string } = {},
): CompilerProposalToolset {
  const service = new CompilerProposalService(workspaceRoot);
  const boundaryCalibrations = new BoundaryCalibrationStore(workspaceRoot);
  const successfulProposalIds = new Set<string>();
  const peekedDirections = new Set<"previous" | "next">();
  let expectedSegmentIds: string[] = [];
  let boundedSliceSegments: SourceSegment[] = [];
  let validatedSourceSegments: SourceSegment[] = [];
  let compilerBatchId: string | undefined;
  let activeSourceId: string | undefined;
  let activeBoundaryCalibration: BoundaryCalibrationRequest | undefined;
  let pendingChapterSplitPlan: ChapterSplitPlan | undefined;
  let finished = false;
  let circuitBreak: { reason: string; failureCount: number } | undefined;
  let totalFinishFailures = 0;
  let consecutiveFinishFailures = 0;
  let totalToolCalls = 0;
  let finishGraceCalls = 0;
  const finishFailureCounts = new Map<string, number>();
  const circuitBreakResult = (reason: string, failureCount: number) => ({
    content: [{
      type: "text" as const,
      text: `Compiler batch stopped by its circuit breaker after ${totalToolCalls} compiler tool call(s) and ${failureCount} failed finish attempt(s). The batch was not checkpointed. Reason: ${reason}`,
    }],
    details: { compilerBatchBlocked: true as const, reason, finishFailureCount: failureCount, toolCallCount: totalToolCalls },
    terminate: true,
  });
  const beginToolCall = (kind: "retrieval" | "mutation" | "finish") => {
    if (circuitBreak) return circuitBreakResult(circuitBreak.reason, circuitBreak.failureCount);
    totalToolCalls += 1;
    if (totalToolCalls <= MAX_COMPILER_TOOL_CALLS) return undefined;
    if (kind === "finish" && finishGraceCalls < MAX_FINISH_GRACE_CALLS) {
      finishGraceCalls += 1;
      return undefined;
    }
    const reason = `compiler tool-call budget exceeded its ${MAX_COMPILER_TOOL_CALLS}-call limit`;
    circuitBreak = { reason, failureCount: totalFinishFailures };
    return circuitBreakResult(reason, totalFinishFailures);
  };
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
    if (circuitBreak) throw new Error("Compiler batch was stopped by its compiler circuit breaker; start a new batch turn to retry.");
  };
  const isStructureDiscoveryBatch = () => Boolean(
    activeSourceId
    && compilerBatchId === `structure-${activeSourceId}-v${CHAPTER_SPLIT_DISCOVERY_VERSION}`,
  );
  const assertEvidenceWithinBoundedSlice = async (payload: unknown, envelopeEvidence: unknown): Promise<void> => {
    if (expectedSegmentIds.length === 0) return;
    if (!activeSourceId || boundedSliceSegments.length !== expectedSegmentIds.length) {
      throw new Error("Bounded compiler evidence is unavailable for this batch.");
    }
    const payloadEvidence = payload && typeof payload === "object" && !Array.isArray(payload)
      && Array.isArray((payload as { evidence?: unknown }).evidence)
      ? evidenceRefSchema.array().parse((payload as { evidence: unknown[] }).evidence)
      : [];
    const references = [
      ...payloadEvidence,
      ...(envelopeEvidence === undefined ? [] : evidenceRefSchema.array().parse(envelopeEvidence)),
    ];
    const allowedIds = new Set(expectedSegmentIds);
    const contains = (reference: EvidenceRef, segment: SourceSegment): boolean => {
      if (reference.span.sourceId !== activeSourceId) return false;
      if (reference.span.startByte !== undefined || reference.span.endByte !== undefined) {
        if (reference.span.startByte === undefined || reference.span.endByte === undefined) return false;
        return reference.span.startByte >= segment.startByte && reference.span.endByte <= segment.endByte;
      }
      if (reference.span.startLine < segment.startLine || reference.span.endLine > segment.endLine) return false;
      // Long physical lines can be split into multiple byte segments carrying
      // the same line number. Line-only evidence is ambiguous in that case.
      return !validatedSourceSegments.some((other) => !allowedIds.has(other.id)
        && other.startLine <= reference.span.endLine
        && other.endLine >= reference.span.startLine);
    };
    for (const reference of references) {
      if (!boundedSliceSegments.some((segment) => contains(reference, segment))) {
        throw new Error(
          `Proposal evidence ${reference.span.sourceId}:${reference.span.startLine}-${reference.span.endLine} is outside the host-supplied compiler segment slice (${expectedSegmentIds.join(", ")}).`,
        );
      }
    }
  };
  const adjacentSegment = (direction: "previous" | "next") => {
    if (!activeSourceId || expectedSegmentIds.length === 0 || boundedSliceSegments.length !== expectedSegmentIds.length) {
      throw new Error("Adjacent evidence requires a non-empty, source-scoped compiler batch.");
    }
    if (!compilerBatchId?.startsWith(`batch-${activeSourceId}-`)) {
      throw new Error("Adjacent evidence is unavailable outside an ordinary source-review batch.");
    }
    const ordered = [...boundedSliceSegments].sort((left, right) => left.ordinal - right.ordinal);
    const focus = direction === "previous" ? ordered[0]! : ordered.at(-1)!;
    const focusIndex = validatedSourceSegments.findIndex((segment) => segment.id === focus.id);
    const adjacentIndex = focusIndex + (direction === "previous" ? -1 : 1);
    const adjacent = validatedSourceSegments[adjacentIndex];
    if (!adjacent) throw new Error(`The active segment has no ${direction} neighbor.`);
    return {
      focus,
      adjacent,
      left: direction === "previous" ? adjacent : focus,
      right: direction === "previous" ? focus : adjacent,
    };
  };

  const configureChapterSplitParameters = Type.Object({
    mode: Type.Union([Type.Literal("builtin"), Type.Literal("custom")]),
    rule: Type.Optional(Type.Object({
      prefix: Type.String({ maxLength: 80 }),
      number_style: Type.Union([
        Type.Literal("arabic"),
        Type.Literal("chinese"),
        Type.Literal("roman"),
        Type.Literal("english"),
        Type.Literal("mixed"),
      ]),
      suffix: Type.String({ maxLength: 40 }),
      case_sensitive: Type.Boolean(),
      allow_leading_whitespace: Type.Boolean(),
      allow_trailing_text: Type.Boolean(),
    }, { additionalProperties: false })),
    examples: Type.Optional(Type.Array(Type.Object({
      line: Type.Integer({ minimum: 1 }),
      text: Type.String({ minLength: 1, maxLength: 240 }),
    }, { additionalProperties: false }), { minItems: 2, maxItems: 12 })),
    reason: Type.String({ minLength: 1, maxLength: 1_000 }),
  }, { additionalProperties: false });
  const configureChapterSplitTool = defineTool<typeof configureChapterSplitParameters, ChapterSplitDetails>({
    name: "configure_chapter_split",
    label: "Configure chapter split",
    description: "Propose one safe declarative chapter-heading rule from the supplied structural sample, or explicitly retain builtin bounded splitting. The host validates the entire immutable source and commits workflow metadata only during a successful finish handshake.",
    promptSnippet: "Configure one validated chapter split before source-review batches begin",
    promptGuidelines: [
      "Use this only in the preliminary structure-discovery batch.",
      "Never submit executable code or regex syntax; prefix and suffix are literal author text.",
      "For a custom rule, copy at least two exact untruncated sampled heading lines and their line numbers.",
      "Choose builtin when the sample does not demonstrate one reliable repeated heading form.",
    ],
    executionMode: "sequential",
    parameters: configureChapterSplitParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beginToolCall("mutation");
      if (blocked) return blocked;
      assertBatchWritable();
      if (!isStructureDiscoveryBatch() || !activeSourceId || !compilerBatchId) {
        throw new Error("Chapter split configuration is available only in the preliminary structure-discovery batch.");
      }
      if (pendingChapterSplitPlan) throw new Error("This structure-discovery batch already has a validated chapter split configuration.");
      if (input.mode === "builtin" && (input.rule || input.examples)) {
        throw new Error("mode=builtin must omit rule and examples.");
      }
      if (input.mode === "custom" && (!input.rule || !input.examples)) {
        throw new Error("mode=custom requires a rule and at least two exact sampled examples.");
      }
      const source = await (await WorkspaceStore.create(workspaceRoot)).getSource(activeSourceId);
      if (!source) throw new Error(`Unknown active compiler source: ${activeSourceId}`);
      const evaluation = await evaluateChapterSplitPlan(workspaceRoot, source, {
        mode: input.mode,
        ...(input.rule ? {
          rule: {
            prefix: input.rule.prefix,
            numberStyle: input.rule.number_style,
            suffix: input.rule.suffix,
            caseSensitive: input.rule.case_sensitive,
            allowLeadingWhitespace: input.rule.allow_leading_whitespace,
            allowTrailingText: input.rule.allow_trailing_text,
          },
        } : {}),
        ...(input.examples ? { examples: input.examples } : {}),
        reason: input.reason,
      }, {
        compilerBatchId,
        ...generatedBy,
      });
      pendingChapterSplitPlan = evaluation.plan;
      recordProposalProgress();
      return {
        content: [{
          type: "text" as const,
          text: evaluation.plan.mode === "custom"
            ? `Validated a declarative chapter rule against the immutable source: ${evaluation.headingLines.length} heading(s) matched. Preview titles (untrusted structural data): ${promptJson(evaluation.headingTitles)}. The plan will be committed only by finish_compiler_batch.`
            : "Validated the decision to retain builtin bounded splitting. The plan will be committed only by finish_compiler_batch.",
        }],
        details: {
          compilerChapterSplitConfigured: true,
          mode: evaluation.plan.mode,
          headingCount: evaluation.headingLines.length,
        },
      };
    },
  });

  const peekAdjacentParameters = Type.Object({
    direction: Type.Union([Type.Literal("previous"), Type.Literal("next")]),
    max_chars: Type.Optional(Type.Integer({ minimum: 500, maximum: 4_000 })),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  }, { additionalProperties: false });
  const peekAdjacentTool = defineTool<typeof peekAdjacentParameters, AdjacentEvidencePeekDetails>({
    name: "peek_adjacent_evidence",
    label: "Peek adjacent evidence",
    description: "Read one bounded context-only preview from the immediate previous or next source segment when the current slice appears to cut through a semantic unit. The preview has no EvidenceRef and cannot ground a proposal.",
    promptSnippet: "Peek at one immediate neighboring boundary when continuity is genuinely uncertain",
    promptGuidelines: [
      "Analyze the supplied segment first and call this only for a concrete unresolved opening or closing boundary.",
      "The returned preview is context-only: never cite it or copy it as proposal evidence.",
      "Each direction may be peeked at most once per batch.",
    ],
    executionMode: "sequential" as const,
    parameters: peekAdjacentParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beginToolCall("retrieval");
      if (blocked) return blocked;
      assertBatchWritable();
      if (peekedDirections.has(input.direction)) {
        throw new Error(`The ${input.direction} adjacent preview has already been read in this batch.`);
      }
      const { focus, adjacent } = adjacentSegment(input.direction);
      const text = await readSegmentText(workspaceRoot, adjacent);
      const maxChars = input.max_chars ?? 4_000;
      const chunk = input.direction === "previous"
        ? safeTextSuffix(text, maxChars)
        : safeTextPrefix(text, maxChars);
      peekedDirections.add(input.direction);
      return {
        content: [{
          type: "text" as const,
          text: promptJson({
            type: "adjacent-context-preview",
            sourceId: activeSourceId,
            direction: input.direction,
            relativeToSegmentId: focus.id,
            adjacentSegmentId: adjacent.id,
            adjacentLines: [adjacent.startLine, adjacent.endLine],
            ...(adjacent.title ? { adjacentTitle: adjacent.title } : {}),
            excerptPosition: input.direction === "previous" ? "tail" : "head",
            totalCharacters: text.length,
            truncated: chunk.length < text.length,
            chunk,
            citationPolicy: "context-only; this preview supplies no EvidenceRef and cannot ground a proposal",
          }),
        }],
        details: {
          compilerAdjacentEvidencePeek: true as const,
          direction: input.direction,
          adjacentSegmentId: adjacent.id,
        },
      };
    },
  });

  const deferBoundaryParameters = Type.Object({
    direction: Type.Union([Type.Literal("previous"), Type.Literal("next")]),
    reason: Type.String({ minLength: 1, maxLength: 1_000 }),
    artifact_ids: Type.Optional(Type.Array(
      Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
      { maxItems: 12, uniqueItems: true },
    )),
  }, { additionalProperties: false });
  const deferBoundaryTool = defineTool<typeof deferBoundaryParameters, BoundaryCalibrationDetails>({
    name: "defer_boundary_artifact",
    label: "Defer boundary artifact",
    description: "Request a fresh isolated two-segment calibration batch for an artifact whose meaning crosses the current deterministic split. This records workflow state only, never world truth.",
    promptSnippet: "Defer a genuinely cross-boundary artifact to a citable two-segment pass",
    promptGuidelines: [
      "Peek in the same direction first and defer only when the preview confirms that a semantic unit crosses the split.",
      "Do not submit a knowingly partial artifact; withdraw a defective current-batch draft before finishing.",
      "Name any existing artifact or pending proposal IDs likely to need boundary review.",
    ],
    executionMode: "sequential",
    parameters: deferBoundaryParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beginToolCall("mutation");
      if (blocked) return blocked;
      assertBatchWritable();
      if (!peekedDirections.has(input.direction)) {
        throw new Error(`Call peek_adjacent_evidence with direction=${input.direction} before deferring a boundary artifact.`);
      }
      if (!activeSourceId || !compilerBatchId) throw new Error("Boundary deferral requires an active source batch.");
      const { focus, left, right } = adjacentSegment(input.direction);
      const request = await boundaryCalibrations.request({
        sourceId: activeSourceId,
        leftSegmentId: left.id,
        rightSegmentId: right.id,
        requestedByBatchId: compilerBatchId,
        requestedBySegmentId: focus.id,
        direction: input.direction,
        reason: input.reason,
        artifactIds: input.artifact_ids ?? [],
      });
      recordProposalProgress();
      return {
        content: [{
          type: "text" as const,
          text: `Boundary calibration ${request.id} queued for ${left.id} + ${right.id}. It will run in a fresh isolated session with both full segments as citable evidence after ordinary source batches finish.`,
        }],
        details: {
          compilerBoundaryCalibrationRequested: true,
          calibrationBatchId: request.id,
          direction: input.direction,
        },
      };
    },
  });
  const retrievalTools = [
    ...createCompilerArtifactRetrievalTools(workspaceRoot, () => activeSourceId, () => beginToolCall("retrieval")),
    ...createCompilerSourceEvidenceTools(workspaceRoot, () => activeSourceId, () => beginToolCall("retrieval")),
  ];

  const proposalTools = (Object.keys(labels) as CompilerProposalKind[]).map((kind) => {
    const metadata = labels[kind];
    const parameters = proposalToolParameters(kind);
    return defineTool<typeof parameters, CompilerProposalDetails>({
      name: metadata.name,
      label: metadata.label,
      description: metadata.description,
      promptSnippet: metadata.description,
      promptGuidelines: ["Search/read source evidence before proposing.", "Never claim a proposal is committed world truth.", "Use stable logical IDs and include precise evidence in the payload where the schema requires it.", "Entity canonical names and aliases must occur in their supplied evidence; empty aliases are valid.", "Use ASCII logical entity IDs, never display names or descriptions, in state entity-reference values such as character.inventory."],
      executionMode: "sequential",
      parameters,
      prepareArguments: (args) => prepareProposalToolArguments(args, kind),
      async execute(_id, input, signal) {
        signal?.throwIfAborted();
        const blocked = beginToolCall("mutation");
        if (blocked) return blocked;
        assertBatchWritable();
        if (isStructureDiscoveryBatch()) {
          throw new Error("World-artifact proposals are unavailable during chapter structure discovery.");
        }
        await assertEvidenceWithinBoundedSlice(input.payload, input.evidence);
        await assertStableLogicalRevision(service, kind, input.payload, compilerBatchId);
        if (!successfulProposalIds.has(input.proposal_id) && successfulProposalIds.size >= MAX_ACTIVE_COMPILER_PROPOSALS) {
          throw new Error(`The compiler batch already has ${MAX_ACTIVE_COMPILER_PROPOSALS} active proposals. Stop adding candidates, withdraw a genuinely defective successful draft only when necessary, and call finish_compiler_batch.`);
        }
        const accepted = await service.submit(kind, {
          proposalId: input.proposal_id,
          payload: input.payload,
          evidence: input.evidence,
          generatedBy: {
            worker: metadata.name,
            ...generatedBy,
            ...(compilerBatchId ? { compilerBatchId } : {}),
          },
        });
        successfulProposalIds.add(accepted.proposalId);
        recordProposalProgress();
        return proposalResult(
          `Pending ${accepted.kind} proposal ${accepted.proposalId} recorded. It is not committed truth. Active proposals: ${successfulProposalIds.size}/${MAX_ACTIVE_COMPILER_PROPOSALS}. General compiler calls remaining: ${Math.max(0, MAX_COMPILER_TOOL_CALLS - totalToolCalls)}; one final finish call remains reserved after that budget.`,
          {
            ...accepted,
            activeProposalCount: successfulProposalIds.size,
            toolCallCount: totalToolCalls,
            remainingToolCalls: Math.max(0, MAX_COMPILER_TOOL_CALLS - totalToolCalls),
          },
        );
      },
    });
  });
  const withdrawParameters = Type.Object({
    proposal_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  }, { additionalProperties: false });
  const withdrawTool = defineTool<typeof withdrawParameters, CompilerWithdrawDetails>({
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
      const blocked = beginToolCall("mutation");
      if (blocked) return blocked;
      assertBatchWritable();
      if (!successfulProposalIds.has(input.proposal_id)) {
        throw new Error(`Cannot withdraw ${input.proposal_id}: it is not an active successful submission in this compiler batch.`);
      }
      await service.withdraw(input.proposal_id);
      successfulProposalIds.delete(input.proposal_id);
      recordProposalProgress();
      return {
        content: [{ type: "text" as const, text: `Compiler proposal ${input.proposal_id} withdrawn to rejected history: ${input.reason}` }],
        details: { compilerProposalWithdrawn: true as const, proposalId: input.proposal_id, reason: input.reason },
      };
    },
  });
  const replaceBoundaryParameters = Type.Object({
    proposal_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
    replacement_proposal_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  }, { additionalProperties: false });
  const replaceBoundaryTool = defineTool<typeof replaceBoundaryParameters, BoundaryReplacementDetails>({
    name: "replace_boundary_proposal",
    label: "Replace boundary proposal",
    description: "During a queued two-segment calibration pass, move one incomplete adjacent source-batch proposal to rejected history after an active same-identity replacement has been recorded in this calibration batch.",
    promptSnippet: "Replace a prior partial boundary proposal only after recording its corrected candidate",
    promptGuidelines: [
      "Retrieve and inspect the exact prior payload first.",
      "Submit the corrected replacement under a new proposal_id while preserving the same stable logical artifact identity.",
      "This tool cannot replace canonical truth, unrelated evidence, or a proposal with a different logical identity.",
    ],
    executionMode: "sequential",
    parameters: replaceBoundaryParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beginToolCall("mutation");
      if (blocked) return blocked;
      assertBatchWritable();
      if (!activeBoundaryCalibration || !activeSourceId || !compilerBatchId) {
        throw new Error("Boundary proposal replacement is available only inside a queued two-segment calibration batch.");
      }
      if (input.proposal_id === input.replacement_proposal_id) {
        throw new Error("A boundary replacement must use a new proposal_id.");
      }
      if (!successfulProposalIds.has(input.replacement_proposal_id)) {
        throw new Error(`Replacement ${input.replacement_proposal_id} is not an active successful submission in this calibration batch.`);
      }
      let prior: Record<string, unknown>;
      let replacement: Record<string, unknown>;
      try {
        [prior, replacement] = await Promise.all([
          service.store.readEnvelope("pending", input.proposal_id),
          service.store.readEnvelope("pending", input.replacement_proposal_id),
        ]);
      } catch {
        throw new Error("Both the prior proposal and its replacement must still be pending.");
      }
      const priorKind = prior.kind;
      const replacementKind = replacement.kind;
      if (typeof priorKind !== "string" || !(priorKind in compilerProposalSchemas)
        || replacementKind !== priorKind) {
        throw new Error("A boundary replacement must have the same compiler proposal kind as the prior proposal.");
      }
      const kind = priorKind as CompilerProposalKind;
      const priorPayload = compilerProposalSchemas[kind].parse(prior.payload);
      const replacementPayload = compilerProposalSchemas[kind].parse(replacement.payload);
      const priorIdentity = compilerProposalLogicalIdentity(kind, priorPayload);
      const replacementIdentity = compilerProposalLogicalIdentity(kind, replacementPayload);
      if (!priorIdentity || priorIdentity !== replacementIdentity) {
        throw new Error("A boundary replacement must preserve the prior proposal's stable logical artifact identity.");
      }
      const generatedBy = prior.generatedBy;
      const priorBatchId = generatedBy && typeof generatedBy === "object" && !Array.isArray(generatedBy)
        ? (generatedBy as Record<string, unknown>).compilerBatchId
        : undefined;
      if (typeof priorBatchId !== "string" || !priorBatchId.startsWith(`batch-${activeSourceId}-`)) {
        throw new Error("Only a pending proposal from an ordinary source-review batch may be replaced here.");
      }
      await assertEvidenceWithinBoundedSlice(priorPayload, prior.evidence);
      await service.withdraw(input.proposal_id);
      recordProposalProgress();
      return {
        content: [{
          type: "text" as const,
          text: `Boundary proposal ${input.proposal_id} moved to rejected history after recording same-identity replacement ${input.replacement_proposal_id}: ${input.reason}`,
        }],
        details: {
          compilerBoundaryProposalReplaced: true,
          proposalId: input.proposal_id,
          replacementProposalId: input.replacement_proposal_id,
          reason: input.reason,
        },
      };
    },
  });
  const finishParameters = Type.Object({
    outcome: Type.Union([Type.Literal("complete"), Type.Literal("no-artifacts")]),
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
      "Use outcome=complete when the batch has active proposals, or no-artifacts only when it has none. The host automatically includes every active proposal; do not enumerate proposal_ids.",
      "After a failed finish, correct the reported proposal or segment-review issue before trying again; never repeat an identical failing call.",
    ],
    executionMode: "sequential",
    parameters: finishParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      if (finished) throw new Error("Compiler batch was already finished.");
      const blocked = beginToolCall("finish");
      if (blocked) return blocked;
      const expected = [...successfulProposalIds].sort();
      const listed = expected;
      if (isStructureDiscoveryBatch() && !pendingChapterSplitPlan) {
        return failFinish("Structure discovery requires one successful configure_chapter_split call before finish.");
      }
      if (input.outcome === "no-artifacts" && expected.length > 0) {
        return failFinish("no-artifacts cannot be used after active successful proposal submissions.");
      }
      if (input.outcome === "complete" && expected.length === 0) {
        return failFinish("complete requires at least one active successful proposal submission.");
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
      const closureIssues = await validateCompilerProposalClosure(workspaceRoot, listed, activeSourceId);
      if (closureIssues.length) {
        return failFinish(`Compiler batch proposal graph is incomplete:\n- ${closureIssues.join("\n- ")}`);
      }
      if (pendingChapterSplitPlan) {
        if (!activeSourceId) return failFinish("Structure discovery lost its active source identity.");
        const source = await (await WorkspaceStore.create(workspaceRoot)).getSource(activeSourceId);
        if (!source) return failFinish(`Unknown active compiler source: ${activeSourceId}`);
        // Write the derived manifest first. If the final atomic plan write
        // fails, ordinary preparation will repair this provisional manifest
        // from the still-authoritative prior plan on retry.
        const manifest = await segmentSource(workspaceRoot, source, { chapterSplitPlan: pendingChapterSplitPlan });
        await new SegmentStore(workspaceRoot).write(manifest);
        await new ChapterSplitPlanStore(workspaceRoot).write(pendingChapterSplitPlan);
      }
      finished = true;
      return {
        content: [{ type: "text" as const, text: `Compiler batch explicitly finished (${input.outcome}).` }],
        details: { compilerBatchFinished: true, outcome: input.outcome, proposalIds: listed, reviewedSegmentIds: reviewedIds },
      };
    },
  });
  return {
    tools: [
      configureChapterSplitTool,
      ...retrievalTools,
      peekAdjacentTool,
      deferBoundaryTool,
      ...proposalTools,
      withdrawTool,
      replaceBoundaryTool,
      finishTool,
    ],
    async beginBatch(segmentIds = [], nextCompilerBatchId?: string, sourceId?: string) {
      successfulProposalIds.clear();
      peekedDirections.clear();
      expectedSegmentIds = [...new Set(segmentIds)].sort();
      boundedSliceSegments = [];
      validatedSourceSegments = [];
      compilerBatchId = nextCompilerBatchId;
      activeSourceId = sourceId;
      activeBoundaryCalibration = undefined;
      pendingChapterSplitPlan = undefined;
      finished = false;
      circuitBreak = undefined;
      totalFinishFailures = 0;
      consecutiveFinishFailures = 0;
      totalToolCalls = 0;
      finishGraceCalls = 0;
      finishFailureCounts.clear();
      if (isStructureDiscoveryBatch() && activeSourceId && compilerBatchId) {
        const existingPlan = await new ChapterSplitPlanStore(workspaceRoot).read(activeSourceId);
        if (existingPlan?.generatedBy.compilerBatchId === compilerBatchId) {
          pendingChapterSplitPlan = existingPlan;
        }
      }
      if (expectedSegmentIds.length && !activeSourceId) {
        throw new Error("A bounded compiler batch requires an active sourceId.");
      }
      if (expectedSegmentIds.length) {
        const source = await (await WorkspaceStore.create(workspaceRoot)).getSource(activeSourceId!);
        if (!source) throw new Error(`Unknown active compiler source: ${activeSourceId}`);
        const [persistedManifest, derivedManifest] = await Promise.all([
          new SegmentStore(workspaceRoot).readManifest(activeSourceId!),
          segmentSource(workspaceRoot, source),
        ]);
        if (!persistedManifest || !isDeepStrictEqual(persistedManifest, derivedManifest)) {
          throw new Error(`Source evidence index for ${activeSourceId} is missing or stale; re-ingest/reparse before compilation.`);
        }
        const byId = new Map(derivedManifest.segments.map((segment) => [segment.id, segment]));
        const missing = expectedSegmentIds.filter((id) => !byId.has(id));
        if (missing.length) throw new Error(`Active compiler slice references unknown segment(s): ${missing.join(", ")}.`);
        validatedSourceSegments = structuredClone(derivedManifest.segments);
        boundedSliceSegments = expectedSegmentIds.map((id) => structuredClone(byId.get(id)!));
      }
      if (compilerBatchId && activeSourceId) {
        activeBoundaryCalibration = await boundaryCalibrations.get(activeSourceId, compilerBatchId);
        if (activeBoundaryCalibration) {
          const calibrationSegmentIds = [
            activeBoundaryCalibration.leftSegmentId,
            activeBoundaryCalibration.rightSegmentId,
          ].sort();
          if (calibrationSegmentIds.length !== expectedSegmentIds.length
            || calibrationSegmentIds.some((id, index) => id !== expectedSegmentIds[index])) {
            throw new Error(`Boundary calibration ${compilerBatchId} requires exactly: ${calibrationSegmentIds.join(", ")}.`);
          }
        }
        if (!activeBoundaryCalibration && compilerBatchId.startsWith(`batch-${activeSourceId}-`)) {
          // A retry must not inherit a request made by an attempt that never
          // reached the finish/checkpoint handshake. The model decides again
          // from the frozen evidence slice in this fresh turn.
          await boundaryCalibrations.removeRequestedByBatch(activeSourceId, compilerBatchId);
        }
      }
      if (!compilerBatchId) return;
      for (const summary of await service.store.list("pending")) {
        const envelope = await service.store.readEnvelope("pending", summary.id);
        const origin = envelope.generatedBy;
        if (
          origin
          && typeof origin === "object"
          && !Array.isArray(origin)
          && (origin as Record<string, unknown>).compilerBatchId === compilerBatchId
        ) {
          successfulProposalIds.add(summary.id);
        }
      }
    },
  };
}

async function assertStableLogicalRevision(
  service: CompilerProposalService,
  kind: CompilerProposalKind,
  payload: unknown,
  compilerBatchId?: string,
): Promise<void> {
  if (!compilerBatchId || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const logicalId = (payload as Record<string, unknown>).id;
  if (typeof logicalId !== "string") return;
  const baseId = logicalRevisionBase(logicalId);
  if (!baseId) return;
  for (const status of ["pending", "rejected"] as const) {
    for (const summary of await service.store.list(status)) {
      if (summary.kind !== kind) continue;
      const envelope = await service.store.readEnvelope(status, summary.id);
      const origin = envelope.generatedBy;
      const priorPayload = envelope.payload;
      const priorLogicalId = priorPayload && typeof priorPayload === "object" && !Array.isArray(priorPayload)
        ? (priorPayload as Record<string, unknown>).id
        : undefined;
      if (
        origin
        && typeof origin === "object"
        && !Array.isArray(origin)
        && (origin as Record<string, unknown>).compilerBatchId === compilerBatchId
        && typeof priorLogicalId === "string"
        && priorLogicalId !== logicalId
        && (logicalRevisionBase(priorLogicalId) ?? priorLogicalId) === baseId
      ) {
        throw new Error(
          `Correction payload id '${logicalId}' versions the existing logical id '${priorLogicalId}'. Keep payload.id='${priorLogicalId}' and version only proposal_id so existing logical references remain valid.`,
        );
      }
    }
  }
}

function logicalRevisionBase(id: string): string | undefined {
  return id.match(/^(.*)-v[1-9]\d*$/i)?.[1];
}

export function createCompilerProposalTools(
  workspaceRoot: string,
  generatedBy: { provider?: string; model?: string } = {},
): ToolDefinition[] {
  return createCompilerProposalToolset(workspaceRoot, generatedBy).tools;
}

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Type, type TSchema } from "typebox";
import { z } from "zod";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import {
  inferredTitleOccursInEvidence,
  normalizeModelInferredNovelTitle,
  sourceTitleProposalSchema,
  type SourceTitleProposal,
} from "../storage/novel-title.js";
import {
  evidenceAssertionSchema,
  evidenceRefSchema,
  idSchema,
  type EvidenceAssertion,
  type EvidenceRef,
} from "../world/model.js";
import {
  compilerProposalLogicalIdentity,
  compilerProposalArtifactId,
  compilerProposalSchemas,
  COMPILER_STATE_FIELDS,
  CompilerProposalService,
  validateCompilerProposalClosure,
  type CompilerProposalKind,
} from "./proposals.js";
import { createCompilerArtifactRetrievalTools } from "./artifact-retrieval.js";
import { createCompilerSourceEvidenceTools, SOURCE_EVIDENCE_TOOL_NAMES } from "./source-evidence-retrieval.js";
import { readSegmentText, segmentEvidenceRef, segmentSource, SegmentStore, type SourceSegment } from "./segments.js";
import { BoundaryCalibrationStore, type BoundaryCalibrationRequest } from "./boundary-calibration.js";
import { promptJson } from "../util/prompt-data.js";
import { safeTextPrefix } from "../util/text-pages.js";
import {
  CHAPTER_SPLIT_DISCOVERY_VERSION,
  ChapterSplitPlanStore,
  evaluateChapterSplitPlan,
  type ChapterSplitPlan,
} from "./chapter-split.js";
import { EvidenceVerifier } from "./evidence.js";
import {
  jsonPointerExists,
  modelEvidenceSelectorsSchema,
  resolveTextAnchor,
  resolveTextSelectorAnchor,
  type ModelEvidenceSelector,
  type ModelTextSelector,
} from "./text-anchors.js";
import { baseStructuralUnits, ensureSourceStructure } from "./structure.js";
import {
  SourceAccountingStore,
  sourceUnitReviewRange,
  sourceUnitAccountingDecisionSchema,
  type SourceAccountingProposal,
  type SourceUnitAccountingDecision,
} from "./source-accounting.js";
import {
  SOURCE_ANNOTATION_ONTOLOGY_VERSION,
  SourceAnnotationStore,
  annotationAnchors,
  eventMentionSchema,
  entityMentionSchema,
  quotationSchema,
  discourseObservationSchema,
  validateSourceAnnotationClosure,
  type SourceAnnotation,
  type SourceAnnotationType,
} from "./annotations.js";
import {
  SOURCE_ANNOTATION_TOOL_NAMES,
  createSourceAnnotationRetrievalTools,
} from "./annotation-retrieval.js";
import {
  ENTITY_RESOLUTION_ONTOLOGY_VERSION,
  EntityResolutionStore,
  identityResolutionSchema,
  validateEntityProposalResolutionTrace,
  validateIdentityResolutionClosure,
  type IdentityResolution,
} from "./entity-resolution.js";
import {
  ENTITY_RESOLUTION_RETRIEVAL_TOOL_NAMES,
  createEntityResolutionRetrievalTools,
} from "./entity-resolution-retrieval.js";
import {
  EVENT_RESOLUTION_ONTOLOGY_VERSION,
  EventResolutionStore,
  eventResolutionSchema,
  validateEventProposalResolutionTrace,
  validateEventResolutionClosure,
  type EventResolution,
} from "./event-resolution.js";
import {
  EVENT_RESOLUTION_RETRIEVAL_TOOL_NAMES,
  createEventResolutionRetrievalTools,
} from "./event-resolution-retrieval.js";
import {
  validateAttributionProposalTrace,
  validateKnowledgeAcquisitionProposalTrace,
} from "./attribution-trace.js";
import { CompilerCommitService } from "./validator.js";
import {
  COMPILER_ACTIVE_PROPOSAL_SAFETY_FUSE,
  COMPILER_FINISH_GRACE_CALLS,
  COMPILER_TOOL_CALL_SAFETY_FUSE,
} from "./limits.js";
import {
  graphAdjudicationIterationFromBatchId,
  validateGraphAdjudicationProposalScope,
} from "./reconcile-world.js";

function proposalResult(
  text: string,
  details: CompilerProposalRecordedDetails
    | SourceAnnotationProposalRecordedDetails
    | IdentityResolutionProposalRecordedDetails
    | EventResolutionProposalRecordedDetails
    | SourceAccountingProposalRecordedDetails,
) {
  return { content: [{ type: "text" as const, text }], details };
}

const labels: Record<CompilerProposalKind, { name: string; label: string; description: string }> = {
  entity: { name: "propose_entity", label: "Propose entity", description: "Submit a typed entity candidate backed by source evidence. This creates a pending proposal only." },
  proposition: { name: "propose_proposition", label: "Propose proposition", description: "Submit evidence-backed semantic content. Acceptance records the content but never makes it world truth; events, state deltas, and rules retain that authority." },
  attribution: { name: "propose_attribution", label: "Propose attribution", description: "Submit who asserts, believes, reports, denies, or questions a proposition, citing quotation IDs when discourse supplies it. Holder identity must trace through quotation-speaker resolution. The attitude remains separate from content and world truth." },
  claim: { name: "propose_claim", label: "Propose claim", description: "Submit an evidence-backed base-world claim candidate. Character knowledge or ignorance is never a claim predicate; represent learning only in a KnowledgeDelta. This does not commit canonical truth." },
  "canonical-event": { name: "propose_canonical_event", label: "Propose canonical event", description: "Submit an explicitly narrated canonical event with preconditions, deterministic state outcome, and any observed character-knowledge change. Later canon remains a candidate until runtime commitment." },
  "event-participation": { name: "propose_event_participation", label: "Propose event participation", description: "Submit one evidence-backed semantic role for an entity in a canonical event as part of a complete same-finish inventory. Role and character scene-presence are independent; accepting this record does not create or execute the event." },
  "event-relation": { name: "propose_event_relation", label: "Propose event relation", description: "Submit one independently evidenced temporal, causal, explanatory, subevent, coreference, or narrative-continuation relation. Typed operationality is authoritative at runtime; narrative sequence and legacy causalParents never imply causation." },
  "scene-occurrence": { name: "propose_scene_occurrence", label: "Propose scene occurrence", description: "Submit one evidence-backed canonical scene occurrence with discourse segments, event membership, location, viewpoint, physical presence, story interval, and entry/exit conditions. It describes source canon and never activates a future runtime scene." },
  "event-frame": { name: "propose_event_frame", label: "Propose event frame", description: "Submit one reusable evidence-backed event frame with typed semantic roles, kind/cardinality constraints, and temporal shape. A frame classifies occurrences; it is not itself an event or world change." },
  "action-schema": { name: "propose_action_schema", label: "Propose action schema", description: "Submit a source-induced reusable action schema only when at least two canonical events support the pattern. Declare role and parameter binding, preconditions, typed effects, and a strict effect envelope; a single occurrence must remain ad hoc, and domain modules are host-managed." },
  "action-constraint": { name: "propose_action_constraint", label: "Propose action constraint", description: "Submit a source-induced capability or action restriction with explicit before/after clauses, exceptions, priority, visibility, and override edges. It constrains matching actions only after validation; domain constraints are host-managed." },
  "norm-template": { name: "propose_norm_template", label: "Propose norm template", description: "Submit an evidence-backed obligation, prohibition, or permission template with authority, applicability, exceptions, deadlines, reparations, visibility, and defeasible overrides. A template does not instantiate a branch norm by itself." },
  "process-template": { name: "propose_process_template", label: "Propose process template", description: "Submit an evidence-backed multi-phase process pattern with owner roles, legal transitions, cadence, outcomes, visibility, and supporting canonical events. A template does not start a branch process by itself." },
  "spatial-relation": { name: "propose_spatial_relation", label: "Propose spatial relation", description: "Submit one exact-evidence-backed contains, adjacency, or traversable-route relation. Adjacency never implies passage; route activation, visibility, direction, and duration remain explicit." },
  "world-rule": { name: "propose_world_rule", label: "Propose world rule", description: "Submit a world-rule-v2 candidate with typed kind/scope, explicit authority and jurisdiction, per-clause modality/evidence, exceptions, visibility, defeasibility, and explicit priority overrides. Engine invariants cannot be modified through this tool." },
  "initial-world": { name: "propose_initial_world", label: "Propose initial world", description: "Submit the evidence-backed canonical seed plus structured unread-reader context and physically present actors' direct Genesis observations." },
  "character-goal": { name: "propose_character_goal", label: "Propose character goal", description: "Submit an evidence-backed actor goal and optional candidate action. Goals are policy inputs, not world facts." },
  "character-model": { name: "propose_character_model", label: "Propose character model", description: "Submit an evidence-backed actor policy with registered dispositions, appraisals, development, directed relationship stances, typed obligations, and relationship changes. It never grants omniscient knowledge or makes policy world truth." },
  "state-delta": { name: "propose_state_delta", label: "Propose state delta", description: "Submit a deterministic state-delta candidate for later validation. This never moves a branch head." },
  possibility: { name: "propose_possibility", label: "Propose possibility", description: "Submit an uncommitted future possibility. canon-analogue is reserved for a real canonicalEventId; an optional canonicalScaffold may expose only source-grounded functional roles for bounded post-divergence rebinding. A choice only the player may make must use player-choice. Do not submit actor-plan templates; actor intent belongs in character goals." },
};

/** Exact model-tool authority owned by the compiler embedding. */
export const COMPILER_TOOL_NAMES: readonly string[] = Object.freeze([
  "configure_chapter_split",
  "propose_novel_title",
  "find_compiler_artifacts",
  "read_compiler_artifact",
  ...SOURCE_ANNOTATION_TOOL_NAMES,
  ...ENTITY_RESOLUTION_RETRIEVAL_TOOL_NAMES,
  ...EVENT_RESOLUTION_RETRIEVAL_TOOL_NAMES,
  ...SOURCE_EVIDENCE_TOOL_NAMES,
  "peek_adjacent_evidence",
  "defer_boundary_artifact",
  ...Object.values(labels).map(({ name }) => name),
  "propose_entity_mention",
  "propose_event_mention",
  "propose_quotation",
  "propose_discourse_segment",
  "propose_entity_resolution",
  "propose_event_resolution",
  "find_source_accounting_units",
  "account_source_units",
  "withdraw_compiler_proposal",
  "replace_boundary_proposal",
  "finish_compiler_batch",
]);

export const BOUNDARY_CALIBRATION_TOOL_NAMES = [
  "peek_adjacent_evidence",
  "defer_boundary_artifact",
  "replace_boundary_proposal",
] as const;

export const SOURCE_ANNOTATION_PROPOSAL_TOOL_NAMES = [
  "propose_entity_mention",
  "propose_event_mention",
  "propose_quotation",
  "propose_discourse_segment",
] as const;

/**
 * A semantic pass normally consumes the committed observation inventory. It
 * may, however, discover that a canonical entity or event cannot satisfy its
 * deterministic trace contract because the observation pass missed the exact
 * prerequisite mention. Keep that repair surface deliberately narrower than
 * the full observation toolset: quotations and discourse segmentation remain
 * owned by the observation pass.
 */
export const SEMANTIC_SOURCE_REPAIR_PROPOSAL_TOOL_NAMES = [
  "propose_entity_mention",
  "propose_event_mention",
] as const;

export const ENTITY_RESOLUTION_PROPOSAL_TOOL_NAMES = ["propose_entity_resolution"] as const;
export const EVENT_RESOLUTION_PROPOSAL_TOOL_NAMES = ["propose_event_resolution"] as const;

export const SOURCE_ACCOUNTING_TOOL_NAMES = [
  "find_source_accounting_units",
  "account_source_units",
] as const;

export const SOURCE_ACCOUNTING_PROPOSAL_TOOL_NAMES = ["account_source_units"] as const;

export type CompilerSemanticStage = "observation" | "semantic" | "executable";

const SEMANTIC_STAGE_PROPOSAL_TOOLS: Record<CompilerSemanticStage, ReadonlySet<string>> = {
  observation: new Set([
    "propose_novel_title",
    ...SOURCE_ANNOTATION_PROPOSAL_TOOL_NAMES,
  ]),
  semantic: new Set([
    ...SEMANTIC_SOURCE_REPAIR_PROPOSAL_TOOL_NAMES,
    "propose_entity_resolution",
    "propose_event_resolution",
    "propose_entity",
    "propose_proposition",
    "propose_attribution",
    "propose_claim",
    "propose_canonical_event",
    "propose_event_participation",
    "propose_event_relation",
    "propose_scene_occurrence",
    "propose_event_frame",
  ]),
  executable: new Set([
    "propose_action_schema",
    "propose_action_constraint",
    "propose_norm_template",
    "propose_process_template",
    "propose_spatial_relation",
    "propose_world_rule",
    "propose_character_goal",
    "propose_character_model",
    "propose_state_delta",
    "propose_possibility",
    ...SOURCE_ACCOUNTING_TOOL_NAMES,
  ]),
};

const ALL_SEMANTIC_STAGE_RESTRICTED_TOOLS = new Set([
  "propose_novel_title",
  ...SOURCE_ANNOTATION_PROPOSAL_TOOL_NAMES,
  ...ENTITY_RESOLUTION_PROPOSAL_TOOL_NAMES,
  ...EVENT_RESOLUTION_PROPOSAL_TOOL_NAMES,
  ...SOURCE_ACCOUNTING_TOOL_NAMES,
  ...Object.values(labels).map(({ name }) => name),
]);

/** Restrict stage-owned tools while keeping general recovery and artifact reads usable. */
export function compilerToolAllowedInSemanticStage(name: string, stage: CompilerSemanticStage): boolean {
  return !ALL_SEMANTIC_STAGE_RESTRICTED_TOOLS.has(name) || SEMANTIC_STAGE_PROPOSAL_TOOLS[stage].has(name);
}

export function semanticStageFromCompilerBatchId(
  compilerBatchId: string | undefined,
  sourceId: string | undefined,
): CompilerSemanticStage | undefined {
  if (!compilerBatchId || !sourceId) return undefined;
  const prefix = `batch-${sourceId}-`;
  if (!compilerBatchId.startsWith(prefix)) return undefined;
  const suffix = compilerBatchId.slice(prefix.length);
  const match = /^\d{5}-(observation|semantic|executable)-/u.exec(suffix);
  return match?.[1] as CompilerSemanticStage | undefined;
}

function legacyExecutableSceneBatchId(
  compilerBatchId: string | undefined,
  sourceId: string | undefined,
): string | undefined {
  if (!compilerBatchId || !sourceId || semanticStageFromCompilerBatchId(compilerBatchId, sourceId) !== "semantic") {
    return undefined;
  }
  return compilerBatchId.replace("-semantic-", "-executable-");
}

/**
 * Small fixtures remain ergonomic; novel-scale batches must explicitly
 * disposition every semantic base unit that exact evidence did not represent.
 */
export const EXPLICIT_SOURCE_ACCOUNTING_MIN_SOURCE_BYTES = 24 * 1_024;

type ProposalToolInput = {
  proposal_id: string;
  payload: unknown;
  evidence_segment_ids?: string[];
  evidence_selectors?: ModelEvidenceSelector[];
  /** Internal compatibility only; absent from the model-facing schema. */
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
  if ("evidence_segment_ids" in normalized) {
    normalized.evidence_segment_ids = parseJsonArgument(normalized.evidence_segment_ids, "evidence_segment_ids");
  }
  if ("evidence_selectors" in normalized) {
    normalized.evidence_selectors = parseJsonArgument(normalized.evidence_selectors, "evidence_selectors");
  }
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
  }).strict();
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(inputSchema);
  removeModelWritableEvidence(jsonSchema);
  const properties = jsonSchema.properties as Record<string, unknown>;
  properties.evidence_segment_ids = {
    type: "array",
    items: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
    },
    minItems: 1,
    maxItems: 16,
    uniqueItems: true,
    description: "Host-issued immutable source segment IDs. The host injects exact EvidenceRefs; never include payload.evidence or raw hashes.",
  };
  const { $schema: _selectorDialect, ...selectorJsonSchema } = z.toJSONSchema(modelEvidenceSelectorsSchema);
  properties.evidence_selectors = {
    ...selectorJsonSchema,
    description: "Optional field/relation-level exact quote selectors. Supply source text and a payload JSON Pointer; the host resolves trusted byte offsets and hashes. Never submit hashes or offsets.",
  };
  jsonSchema.required = [...new Set([...(jsonSchema.required ?? []), "evidence_segment_ids"])];
  constrainCompilerStateFields(jsonSchema);
  return Type.Unsafe<ProposalToolInput>(jsonSchema as TSchema);
}

function removeModelWritableEvidence(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) removeModelWritableEvidence(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const properties = record.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    delete (properties as Record<string, unknown>).evidence;
    delete (properties as Record<string, unknown>).counterEvidence;
    delete (properties as Record<string, unknown>).evidenceAssertions;
  }
  if (Array.isArray(record.required)) {
    record.required = record.required.filter((name) => name !== "evidence" && name !== "counterEvidence" && name !== "evidenceAssertions");
  }
  for (const nested of Object.values(record)) removeModelWritableEvidence(nested);
}

const evidenceSegmentIdsSchema = z.array(idSchema)
  .min(1)
  .max(16)
  .refine((ids) => new Set(ids).size === ids.length, "evidence_segment_ids must be unique");

function containsEvidenceField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsEvidenceField);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, "evidence")
    || Object.hasOwn(record, "counterEvidence")
    || Object.hasOwn(record, "evidenceAssertions")
    || Object.values(record).some(containsEvidenceField);
}

function evidencePointerTargetsEvidence(pointer: string): boolean {
  return pointer.slice(1).split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"))
    .some((token) => token === "evidence" || token === "counterEvidence" || token === "evidenceAssertions");
}

function injectHostEvidence(
  kind: CompilerProposalKind,
  payload: unknown,
  evidence: readonly EvidenceRef[],
): unknown {
  if (kind === "state-delta") return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const enriched: Record<string, unknown> = {
    ...(payload as Record<string, unknown>),
    evidence: structuredClone(evidence),
  };
  if (kind === "character-model") {
    for (const field of ["developmentPhases"] as const) {
      if (!Array.isArray(enriched[field])) continue;
      enriched[field] = enriched[field].map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? { ...(item as Record<string, unknown>), evidence: structuredClone(evidence) }
          : item);
    }
  }
  return enriched;
}

type LocatedSemanticEvidence = { targetPath: string; reference: EvidenceRef };

function characterSemanticTarget(targetPath: string): { field: string; index: number } | null {
  const tokens = targetPath.slice(1).split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  const [field, indexToken] = tokens;
  if (!field || !new Set([
    "dispositions",
    "appraisalEpisodes",
    "developmentEpisodes",
    "relationshipStances",
    "relationshipObligations",
    "relationshipChanges",
  ]).has(field)
    || !indexToken || !/^(0|[1-9]\d*)$/.test(indexToken)) return null;
  return { field, index: Number(indexToken) };
}

function injectHostSemanticEvidence(
  payload: unknown,
  supporting: readonly LocatedSemanticEvidence[],
  contradicting: readonly LocatedSemanticEvidence[],
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const enriched = structuredClone(payload) as Record<string, unknown>;
  for (const field of [
    "dispositions",
    "appraisalEpisodes",
    "developmentEpisodes",
    "relationshipStances",
    "relationshipObligations",
    "relationshipChanges",
  ] as const) {
    const collection = enriched[field];
    if (!Array.isArray(collection)) continue;
    for (let index = 0; index < collection.length; index += 1) {
      const candidate = collection[index];
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const semantic = candidate as Record<string, unknown>;
      semantic.evidence = supporting
        .filter((item) => {
          const target = characterSemanticTarget(item.targetPath);
          return target?.field === field && target.index === index;
        })
        .map((item) => structuredClone(item.reference));
      const counterEvidence = contradicting
        .filter((item) => {
          const target = characterSemanticTarget(item.targetPath);
          return target?.field === field && target.index === index;
        })
        .map((item) => structuredClone(item.reference));
      if (counterEvidence.length) semantic.counterEvidence = counterEvidence;
      else delete semantic.counterEvidence;
    }
  }
  return enriched;
}

function worldRuleSemanticTarget(targetPath: string): { field: "clauses" | "exceptions"; index: number } | null {
  const tokens = targetPath.slice(1).split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  const [field, indexToken] = tokens;
  if ((field !== "clauses" && field !== "exceptions")
    || !indexToken || !/^(0|[1-9]\d*)$/.test(indexToken)) return null;
  return { field, index: Number(indexToken) };
}

function injectHostWorldRuleEvidence(
  payload: unknown,
  supporting: readonly LocatedSemanticEvidence[],
  contradicting: readonly LocatedSemanticEvidence[],
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const enriched = structuredClone(payload) as Record<string, unknown>;
  if (enriched.ontologyVersion !== "world-rule-v2") return enriched;
  const topSupporting = supporting.filter((item) => !worldRuleSemanticTarget(item.targetPath));
  const topContradicting = contradicting.filter((item) => !worldRuleSemanticTarget(item.targetPath));
  enriched.evidence = topSupporting.map((item) => structuredClone(item.reference));
  if (topContradicting.length) enriched.counterEvidence = topContradicting.map((item) => structuredClone(item.reference));
  else delete enriched.counterEvidence;
  for (const field of ["clauses", "exceptions"] as const) {
    const collection = enriched[field];
    if (!Array.isArray(collection)) continue;
    for (let index = 0; index < collection.length; index += 1) {
      const item = collection[index];
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const semantic = item as Record<string, unknown>;
      semantic.evidence = supporting
        .filter((candidate) => {
          const target = worldRuleSemanticTarget(candidate.targetPath);
          return target?.field === field && target.index === index;
        })
        .map((candidate) => structuredClone(candidate.reference));
      const counterEvidence = contradicting
        .filter((candidate) => {
          const target = worldRuleSemanticTarget(candidate.targetPath);
          return target?.field === field && target.index === index;
        })
        .map((candidate) => structuredClone(candidate.reference));
      if (counterEvidence.length) semantic.counterEvidence = counterEvidence;
      else delete semantic.counterEvidence;
    }
  }
  return enriched;
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

type ActiveSourceAccountingProposal = {
  proposal: SourceAccountingProposal;
  proposalStatus: "pending" | "accepted";
};

const MAX_CONSECUTIVE_FINISH_FAILURES = 3;
const MAX_IDENTICAL_FINISH_FAILURES = 2;

function finishIssueSection(label: string, issues: readonly string[]): string[] {
  return issues.length ? [`${label} is incomplete:\n- ${issues.join("\n- ")}`] : [];
}

/**
 * Source accounting can legitimately surface hundreds of independent missing
 * units in a long-form batch. Returning every unit from the finish tool
 * crowds the next tool turn out of the provider context and prevents the
 * model from using the paged, exact-ID discovery tool that is the recovery
 * path. Keep the diagnostic actionable but bounded; `find_source_accounting_units`
 * remains the sole authority for the complete set and its opaque page tokens.
 */
function finishAccountingIssueSection(issues: readonly string[]): string[] {
  if (!issues.length) return [];
  const limit = 20;
  const displayed = issues.slice(0, limit);
  const remainder = issues.length - displayed.length;
  return [
    `Source-unit accounting is incomplete (${issues.length} issue(s)):\n- ${displayed.join("\n- ")}`
      + (remainder > 0
        ? `\n- ${remainder} additional issue(s) omitted. Call find_source_accounting_units with status=unresolved, offset=0, and max_results up to 20; copy the returned pageToken into one account_source_units call, then refetch unresolved at offset=0. Do not guess unit IDs or retry this finish unchanged.`
        : ""),
  ];
}

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
};

type SourceAnnotationProposalRecordedDetails = {
  proposalId: string;
  kind: SourceAnnotationType;
  annotationId: string;
};

type IdentityResolutionProposalRecordedDetails = {
  proposalId: string;
  kind: "entity-resolution";
  resolutionId: string;
  mentionId: string;
  status: IdentityResolution["status"];
};

type EventResolutionProposalRecordedDetails = {
  proposalId: string;
  kind: "event-resolution";
  resolutionId: string;
  eventMentionIds: string[];
  status: EventResolution["status"];
};

type SourceAccountingProposalRecordedDetails = {
  proposalId: string;
  kind: "source-accounting";
  unitIds: string[];
  pageToken?: string;
};

type CompilerProposalDetails =
  | CompilerBatchBlockedDetails
  | CompilerProposalRecordedDetails
  | SourceAnnotationProposalRecordedDetails
  | IdentityResolutionProposalRecordedDetails
  | EventResolutionProposalRecordedDetails
  | SourceAccountingProposalRecordedDetails;

type NovelTitleProposalDetails =
  | CompilerBatchBlockedDetails
  | { proposalId: string; kind: "novel-title" };

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

const modelTextSelectorParameters = Type.Object({
  segment_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  exact: Type.String({ minLength: 1, maxLength: 4_000 }),
  prefix: Type.Optional(Type.String({ maxLength: 500 })),
  suffix: Type.Optional(Type.String({ maxLength: 500 })),
  occurrence: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

const annotationIdentityParameters = {
  proposal_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  annotation_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
};

const entityKindCandidateParameters = Type.Union([
  Type.Literal("character"),
  Type.Literal("location"),
  Type.Literal("faction"),
  Type.Literal("artifact"),
  Type.Literal("institution"),
  Type.Literal("relationship"),
  Type.Literal("concept"),
  Type.Literal("other"),
]);

const entityMentionParameters = Type.Object({
  ...annotationIdentityParameters,
  selector: modelTextSelectorParameters,
  surface: Type.String({ maxLength: 4_000 }),
  form: Type.Union([
    Type.Literal("proper"),
    Type.Literal("nominal"),
    Type.Literal("pronoun"),
    Type.Literal("title"),
    Type.Literal("kinship"),
    Type.Literal("collective"),
    Type.Literal("zero-anaphora"),
  ]),
  kind_candidates: Type.Array(entityKindCandidateParameters, { minItems: 1, maxItems: 8, uniqueItems: true }),
  scene_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" })),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  interpretation: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
}, { additionalProperties: false });

const eventMentionTypeParameters = Type.Union([
  Type.Literal("communication"),
  Type.Literal("movement"),
  Type.Literal("transfer"),
  Type.Literal("conflict"),
  Type.Literal("perception"),
  Type.Literal("cognition"),
  Type.Literal("decision"),
  Type.Literal("social-interaction"),
  Type.Literal("state-change"),
  Type.Literal("creation"),
  Type.Literal("destruction"),
  Type.Literal("natural-process"),
  Type.Literal("institutional-action"),
  Type.Literal("other"),
]);

const eventMentionParameters = Type.Object({
  ...annotationIdentityParameters,
  trigger_selector: modelTextSelectorParameters,
  trigger: Type.String({ minLength: 1, maxLength: 4_000 }),
  extent_selectors: Type.Array(modelTextSelectorParameters, { minItems: 1, maxItems: 32 }),
  event_type_candidates: Type.Array(eventMentionTypeParameters, { minItems: 1, maxItems: 16, uniqueItems: true }),
  participant_mention_ids: Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }), {
    maxItems: 64,
    uniqueItems: true,
  }),
  scene_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" })),
  discourse_segment_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" })),
  salience: Type.Union([Type.Literal("major"), Type.Literal("supporting"), Type.Literal("minor")]),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  interpretation: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
}, { additionalProperties: false });

const quotationParameters = Type.Object({
  ...annotationIdentityParameters,
  selector: modelTextSelectorParameters,
  mode: Type.Union([Type.Literal("direct"), Type.Literal("indirect"), Type.Literal("free-indirect")]),
  speaker_mention_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" })),
  addressee_mention_ids: Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }), { maxItems: 32, uniqueItems: true }),
  cue_selector: Type.Optional(modelTextSelectorParameters),
  scene_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" })),
  attribution_confidence: Type.Number({ minimum: 0, maximum: 1 }),
  interpretation: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
}, { additionalProperties: false });

const discourseObservationParameters = Type.Object({
  ...annotationIdentityParameters,
  kind: Type.Union([
    Type.Literal("scene"),
    Type.Literal("summary"),
    Type.Literal("flashback"),
    Type.Literal("flashforward"),
    Type.Literal("frame"),
    Type.Literal("recollection"),
    Type.Literal("hypothetical"),
    Type.Literal("dream"),
    Type.Literal("embedded-document"),
    Type.Literal("narrator-commentary"),
  ]),
  selectors: Type.Array(modelTextSelectorParameters, { minItems: 1, maxItems: 32 }),
  viewpoint_mention_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" })),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  interpretation: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
}, { additionalProperties: false });

const identityResolutionCandidateParameters = Type.Object({
  entity_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  basis_mention_ids: Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }), {
    minItems: 1,
    maxItems: 32,
    uniqueItems: true,
  }),
  evidence_assertion_ids: Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }), {
    maxItems: 32,
    uniqueItems: true,
  }),
  rationale: Type.String({ minLength: 1, maxLength: 1_000 }),
}, { additionalProperties: false });

const resolutionStoryTimeParameters = Type.Union([
  Type.Object({
    kind: Type.Literal("exact"),
    value: Type.String({ minLength: 1 }),
    precision: Type.Union([
      Type.Literal("second"), Type.Literal("minute"), Type.Literal("hour"),
      Type.Literal("day"), Type.Literal("month"), Type.Literal("year"),
    ]),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("range"),
    earliest: Type.String({ minLength: 1 }),
    latest: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("relative"),
    anchorEventId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
    relation: Type.Union([Type.Literal("before"), Type.Literal("after"), Type.Literal("during")]),
    offset: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("ordinal"),
    label: Type.String({ minLength: 1 }),
    orderHint: Type.Optional(Type.Number()),
  }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("unknown") }, { additionalProperties: false }),
]);

const identityResolutionParameters = Type.Object({
  proposal_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  resolution_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  mention_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  status: Type.Union([
    Type.Literal("resolved"),
    Type.Literal("ambiguous"),
    Type.Literal("new-entity"),
    Type.Literal("unresolved"),
    Type.Literal("non-referential"),
    Type.Literal("misidentified"),
  ]),
  entity_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" })),
  intended_entity_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" })),
  candidates: Type.Array(identityResolutionCandidateParameters, { maxItems: 32 }),
  alias_type: Type.Optional(Type.Union([
    Type.Literal("name"), Type.Literal("title"), Type.Literal("office"),
    Type.Literal("kinship"), Type.Literal("nickname"), Type.Literal("other"),
  ])),
  valid_story_time: Type.Optional(resolutionStoryTimeParameters),
  supersedes_resolution_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" })),
  rationale: Type.String({ minLength: 1, maxLength: 2_000 }),
}, { additionalProperties: false });

const eventResolutionRelationParameters = Type.Union([
  Type.Literal("coreference"),
  Type.Literal("subevent"),
]);

const eventResolutionCandidateParameters = Type.Object({
  canonical_event_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  relation: eventResolutionRelationParameters,
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  basis_event_mention_ids: Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }), {
    minItems: 1,
    maxItems: 64,
    uniqueItems: true,
  }),
  evidence_assertion_ids: Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }), {
    maxItems: 64,
    uniqueItems: true,
  }),
  rationale: Type.String({ minLength: 1, maxLength: 1_000 }),
}, { additionalProperties: false });

const eventResolutionParameters = Type.Object({
  proposal_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  resolution_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  event_mention_ids: Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }), {
    minItems: 1,
    maxItems: 64,
    uniqueItems: true,
  }),
  status: Type.Union([
    Type.Literal("resolved"),
    Type.Literal("new-event"),
    Type.Literal("ambiguous"),
    Type.Literal("unresolved"),
    Type.Literal("non-referential"),
  ]),
  canonical_event_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" })),
  relation: Type.Optional(eventResolutionRelationParameters),
  candidates: Type.Array(eventResolutionCandidateParameters, { maxItems: 64 }),
  supersedes_resolution_ids: Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }), {
    maxItems: 64,
    uniqueItems: true,
  }),
  rationale: Type.String({ minLength: 1, maxLength: 2_000 }),
}, { additionalProperties: false });

const sourceAccountingFindParameters = Type.Object({
  segment_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" })),
  status: Type.Optional(Type.Union([
    Type.Literal("all"),
    Type.Literal("unresolved"),
    Type.Literal("pending"),
  ])),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
}, { additionalProperties: false });

const sourceAccountingDecisionParameters = Type.Object({
  unit_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  status: Type.Union([
    Type.Literal("background-only"),
    Type.Literal("paratext"),
    Type.Literal("duplicate-description"),
    Type.Literal("unresolved"),
    Type.Literal("intentionally-deferred"),
  ]),
  reason: Type.String({ minLength: 1, maxLength: 1_000 }),
}, { additionalProperties: false });

const sourceAccountingDispositionParameters = Type.Object({
  status: Type.Union([
    Type.Literal("background-only"),
    Type.Literal("paratext"),
    Type.Literal("duplicate-description"),
    Type.Literal("unresolved"),
    Type.Literal("intentionally-deferred"),
  ]),
  reason: Type.String({ minLength: 1, maxLength: 1_000 }),
}, { additionalProperties: false });

const sourceAccountingPageOverrideParameters = Type.Object({
  unit_index: Type.Integer({ minimum: 1, maximum: 200 }),
  status: Type.Union([
    Type.Literal("background-only"),
    Type.Literal("paratext"),
    Type.Literal("duplicate-description"),
    Type.Literal("unresolved"),
    Type.Literal("intentionally-deferred"),
  ]),
  reason: Type.String({ minLength: 1, maxLength: 1_000 }),
}, { additionalProperties: false });

const sourceAccountingParameters = Type.Object({
  proposal_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  decisions: Type.Optional(Type.Array(sourceAccountingDecisionParameters, { minItems: 1, maxItems: 512 })),
  page_token: Type.Optional(Type.String({ pattern: "^acctpg-[a-f0-9]{16}$" })),
  page_default: Type.Optional(sourceAccountingDispositionParameters),
  page_overrides: Type.Optional(Type.Array(sourceAccountingPageOverrideParameters, {
    maxItems: 200,
  })),
}, { additionalProperties: false });

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
  const annotationStore = new SourceAnnotationStore(workspaceRoot);
  const entityResolutionStore = new EntityResolutionStore(workspaceRoot);
  const eventResolutionStore = new EventResolutionStore(workspaceRoot);
  const accountingStore = new SourceAccountingStore(workspaceRoot);
  const evidenceVerifier = new EvidenceVerifier(workspaceRoot);
  const boundaryCalibrations = new BoundaryCalibrationStore(workspaceRoot);
  const successfulProposalIds = new Set<string>();
  const successfulAnnotationProposalIds = new Set<string>();
  const successfulEntityResolutionProposalIds = new Set<string>();
  const successfulEventResolutionProposalIds = new Set<string>();
  const successfulAccountingProposalIds = new Set<string>();
  const issuedAccountingPages = new Map<string, {
    sourceId: string;
    compilerBatchId: string;
    unitIds: string[];
  }>();
  const peekedDirections = new Set<"previous" | "next">();
  let expectedSegmentIds: string[] = [];
  let boundedSliceSegments: SourceSegment[] = [];
  let validatedSourceSegments: SourceSegment[] = [];
  let compilerBatchId: string | undefined;
  let activeSourceId: string | undefined;
  let activeBoundaryCalibration: BoundaryCalibrationRequest | undefined;
  let pendingChapterSplitPlan: ChapterSplitPlan | undefined;
  let pendingNovelTitleProposal: SourceTitleProposal | undefined;
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
    if (totalToolCalls <= COMPILER_TOOL_CALL_SAFETY_FUSE) return undefined;
    if (kind === "finish" && finishGraceCalls < COMPILER_FINISH_GRACE_CALLS) {
      finishGraceCalls += 1;
      return undefined;
    }
    const reason = `compiler tool-call safety fuse tripped after ${COMPILER_TOOL_CALL_SAFETY_FUSE} calls`;
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
  const activeProposalCount = () => successfulProposalIds.size
    + successfulAnnotationProposalIds.size
    + successfulEntityResolutionProposalIds.size
    + successfulEventResolutionProposalIds.size
    + successfulAccountingProposalIds.size
    + (pendingNovelTitleProposal ? 1 : 0);
  const isStructureDiscoveryBatch = () => Boolean(
    activeSourceId
    && compilerBatchId === `structure-${activeSourceId}-v${CHAPTER_SPLIT_DISCOVERY_VERSION}`,
  );
  const activeSemanticStage = () => semanticStageFromCompilerBatchId(compilerBatchId, activeSourceId);
  const assertSemanticStageAuthority = (toolName: string) => {
    const stage = activeSemanticStage();
    if (stage && !compilerToolAllowedInSemanticStage(toolName, stage)) {
      throw new Error(`Compiler stage '${stage}' does not authorize ${toolName}; finish this stage and use the host-scheduled next stage instead.`);
    }
  };
  const isWholeSourceEvidencePass = () => Boolean(
    compilerBatchId?.startsWith("opening-batch-")
    || compilerBatchId?.startsWith("reconcile-"),
  );
  const assertEvidenceWithinBoundedSlice = async (payload: unknown, envelopeEvidence: unknown): Promise<void> => {
    if (expectedSegmentIds.length === 0 || isWholeSourceEvidencePass()) return;
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
  const resolveEvidenceSegmentIds = (value: unknown): { segments: SourceSegment[]; evidence: EvidenceRef[] } => {
    const segmentIds = evidenceSegmentIdsSchema.parse(value);
    if (!activeSourceId || validatedSourceSegments.length === 0) {
      throw new Error("evidence_segment_ids require an active source-scoped compiler batch with a validated evidence manifest.");
    }
    const byId = new Map(validatedSourceSegments.map((segment) => [segment.id, segment]));
    const unknown = segmentIds.filter((id) => !byId.has(id));
    if (unknown.length) {
      throw new Error(`Unknown evidence_segment_ids for active source '${activeSourceId}': ${unknown.join(", ")}.`);
    }
    if (expectedSegmentIds.length && !isWholeSourceEvidencePass()) {
      const allowed = new Set(expectedSegmentIds);
      const outside = segmentIds.filter((id) => !allowed.has(id));
      if (outside.length) {
        throw new Error(
          `Evidence segment handle(s) ${outside.join(", ")} are outside the host-supplied compiler segment slice (${expectedSegmentIds.join(", ")}).`,
        );
      }
    }
    const segments = segmentIds
      .map((id) => byId.get(id)!)
      .sort((left, right) => left.ordinal - right.ordinal);
    return {
      segments: structuredClone(segments),
      evidence: segments.map(segmentEvidenceRef),
    };
  };
  const resolveObservationSelector = async (selector: ModelTextSelector) => {
    if (!activeSourceId || validatedSourceSegments.length === 0) {
      throw new Error("Source annotations require an active source-scoped compiler batch.");
    }
    const segment = validatedSourceSegments.find((candidate) => candidate.id === selector.segment_id);
    if (!segment) throw new Error(`Unknown annotation selector segment ${selector.segment_id} for source ${activeSourceId}.`);
    if (expectedSegmentIds.length && !expectedSegmentIds.includes(segment.id)) {
      throw new Error(
        `Annotation selector ${segment.id} is outside the host-supplied compiler segment slice (${expectedSegmentIds.join(", ")}).`,
      );
    }
    return resolveTextSelectorAnchor(workspaceRoot, segment, selector);
  };
  const annotationDerivation = (worker: string, proposalId: string) => ({
    runId: compilerBatchId ?? proposalId,
    worker,
    ...(compilerBatchId ? { compilerBatchId } : {}),
    ...generatedBy,
    ontologyVersion: SOURCE_ANNOTATION_ONTOLOGY_VERSION,
  });
  const assertAnnotationProposalSlot = (proposalId: string) => {
    if (successfulProposalIds.has(proposalId)) {
      throw new Error(`Proposal ID ${proposalId} is already used by a world-artifact proposal in this batch.`);
    }
    if (successfulEntityResolutionProposalIds.has(proposalId)) {
      throw new Error(`Proposal ID ${proposalId} is already used by an entity-resolution proposal in this batch.`);
    }
    if (successfulEventResolutionProposalIds.has(proposalId)) {
      throw new Error(`Proposal ID ${proposalId} is already used by an event-resolution proposal in this batch.`);
    }
    if (successfulAccountingProposalIds.has(proposalId)) {
      throw new Error(`Proposal ID ${proposalId} is already used by a source-accounting proposal in this batch.`);
    }
    if (!successfulAnnotationProposalIds.has(proposalId) && activeProposalCount() >= COMPILER_ACTIVE_PROPOSAL_SAFETY_FUSE) {
      throw new Error(`The compiler batch reached its ${COMPILER_ACTIVE_PROPOSAL_SAFETY_FUSE}-proposal safety fuse. Do not withdraw semantically valid work to make room; stop this turn and preserve the exact drafts for diagnosis.`);
    }
  };
  const stageAnnotation = async (
    proposalId: string,
    annotation: SourceAnnotation,
    worker: string,
  ): Promise<void> => {
    assertSemanticStageAuthority(worker);
    if (!activeSourceId) throw new Error("Source annotations require an active source-scoped compiler batch.");
    assertAnnotationProposalSlot(proposalId);
    await annotationStore.stage(activeSourceId, {
      version: 1,
      id: proposalId,
      annotationType: annotation.annotationType,
      payload: annotation,
      generatedBy: {
        worker,
        ...(compilerBatchId ? { compilerBatchId } : {}),
        ...generatedBy,
      },
      createdAt: new Date().toISOString(),
    });
    successfulAnnotationProposalIds.add(proposalId);
    recordProposalProgress();
  };
  const normalizeProposalEvidence = async (
    kind: CompilerProposalKind,
    input: ProposalToolInput,
  ): Promise<{ payload: unknown; evidence?: unknown[]; evidenceAssertions: EvidenceAssertion[] }> => {
    if (input.evidence_segment_ids === undefined) {
      if (input.evidence_selectors !== undefined) {
        throw new Error("evidence_selectors require evidence_segment_ids in an active source-scoped compiler batch.");
      }
      if (activeSourceId || compilerBatchId) {
        throw new Error(
          "Source-scoped compiler proposals require evidence_segment_ids; raw EvidenceRef input is available only to the unscoped internal compatibility API.",
        );
      }
      return {
        payload: input.payload,
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        evidenceAssertions: [],
      };
    }
    if (input.evidence !== undefined || containsEvidenceField(input.payload)) {
      throw new Error(
        "Model proposals using evidence_segment_ids must omit payload.evidence, payload.counterEvidence, nested evidence fields, and top-level evidence; the host owns EvidenceRef construction.",
      );
    }
    const { segments, evidence } = resolveEvidenceSegmentIds(input.evidence_segment_ids);
    let payload = kind === "state-delta"
      ? input.payload
      : injectHostEvidence(kind, input.payload, evidence);
    const selectors = input.evidence_selectors === undefined
      ? []
      : modelEvidenceSelectorsSchema.parse(input.evidence_selectors);
    const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
    const artifactId = compilerProposalArtifactId(kind, payload, input.proposal_id);
    const evidenceAssertions: EvidenceAssertion[] = [];
    const supportingSemanticEvidence: LocatedSemanticEvidence[] = [];
    const counterEvidence: LocatedSemanticEvidence[] = [];
    for (let index = 0; index < selectors.length; index += 1) {
      const selector = selectors[index]!;
      const segment = segmentById.get(selector.segment_id);
      if (!segment) {
        throw new Error(
          `Evidence selector ${index + 1} references ${selector.segment_id}, which is not present in evidence_segment_ids.`,
        );
      }
      if (evidencePointerTargetsEvidence(selector.target_path)) {
        throw new Error(`Evidence selector target_path '${selector.target_path}' cannot target host-owned evidence fields.`);
      }
      if (!jsonPointerExists(input.payload, selector.target_path)) {
        throw new Error(`Evidence selector target_path '${selector.target_path}' does not exist in the proposal payload.`);
      }
      let anchor: Awaited<ReturnType<typeof resolveTextAnchor>>;
      try {
        anchor = await resolveTextAnchor(workspaceRoot, segment, selector);
      } catch (error) {
        throw new Error(
          `Evidence selector ${index + 1} for target_path '${selector.target_path}' failed: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? { cause: error } : undefined,
        );
      }
      const exactReference = evidenceRefSchema.parse({
          span: {
            sourceId: anchor.sourceId,
            startByte: anchor.startByte,
            endByte: anchor.endByte,
            startLine: anchor.startLine,
            endLine: anchor.endLine,
            quoteHash: anchor.exactHash,
          },
          strength: selector.strength,
        });
      if ((kind === "character-model" || kind === "spatial-relation" || kind === "world-rule") && selector.relation === "supports") {
        supportingSemanticEvidence.push({ targetPath: selector.target_path, reference: exactReference });
      }
      if ((kind === "event-relation" || kind === "character-model" || kind === "spatial-relation" || kind === "world-rule") && selector.relation === "contradicts") {
        if (kind === "character-model" && !characterSemanticTarget(selector.target_path)) {
          throw new Error(
            `Character counter-evidence selector '${selector.target_path}' must target one disposition, appraisal, development, relationship stance, obligation, or relationship change item.`,
          );
        }
        counterEvidence.push({ targetPath: selector.target_path, reference: exactReference });
      }
      const assertionId = `evidence-${crypto.createHash("sha256").update([
        input.proposal_id,
        String(index),
        selector.target_path,
        selector.relation,
        selector.strength,
        selector.segment_id,
        anchor.exactHash,
      ].join("\u0000")).digest("hex").slice(0, 32)}`;
      evidenceAssertions.push(evidenceAssertionSchema.parse({
        version: 1,
        id: assertionId,
        target: {
          artifactKind: kind,
          artifactId,
          jsonPointer: selector.target_path,
        },
        anchors: [anchor],
        relation: selector.relation,
        strength: selector.strength,
        ...(selector.interpretation ? { interpretation: selector.interpretation } : {}),
        derivation: {
          runId: compilerBatchId ?? input.proposal_id,
          worker: labels[kind].name,
          ...(compilerBatchId ? { compilerBatchId } : {}),
          ...generatedBy,
          ontologyVersion: "evidence-v1",
        },
      }));
    }
    if (kind === "event-relation" && counterEvidence.length) {
      payload = {
        ...(payload as Record<string, unknown>),
        counterEvidence: counterEvidence.map((item) => structuredClone(item.reference)),
      };
    }
    if (kind === "spatial-relation") {
      payload = {
        ...(payload as Record<string, unknown>),
        evidence: supportingSemanticEvidence.map((item) => structuredClone(item.reference)),
        ...(counterEvidence.length
          ? { counterEvidence: counterEvidence.map((item) => structuredClone(item.reference)) }
          : {}),
      };
    }
    if (kind === "character-model") {
      payload = injectHostSemanticEvidence(payload, supportingSemanticEvidence, counterEvidence);
    }
    if (kind === "world-rule") {
      payload = injectHostWorldRuleEvidence(payload, supportingSemanticEvidence, counterEvidence);
    }
    return kind === "state-delta"
      ? { payload, evidence, evidenceAssertions }
      : { payload, evidenceAssertions };
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

  const novelTitleInputSchema = z.object({
    proposal_id: idSchema,
    title: z.string().min(1).max(200),
    evidence_segment_id: idSchema,
    reason: z.string().min(1).max(500),
  }).strict();
  const { $schema: _titleDialect, ...novelTitleJsonSchema } = z.toJSONSchema(novelTitleInputSchema);
  const novelTitleParameters = Type.Unsafe<z.infer<typeof novelTitleInputSchema>>(novelTitleJsonSchema as TSchema);
  const novelTitleTool = defineTool<typeof novelTitleParameters, NovelTitleProposalDetails>({
    name: "propose_novel_title",
    label: "Propose novel title",
    description: "Infer the work's actual title semantically from the opening source evidence. This stages display metadata only; the filename is not evidence of the title, and the title becomes active only through finish_compiler_batch.",
    promptSnippet: "Propose the actual novel title only when the opening evidence establishes it",
    promptGuidelines: [
      "Use semantic judgment over the opening/title-page evidence; never derive the title from sourcePath or a filename.",
      "Cite one exact supplied opening evidence_segment_id containing the selected title text; the host constructs its EvidenceRef.",
      "Omit edition, site, file-extension, author, and chapter-label text unless it is genuinely part of the work title.",
      "Do not call this tool when the work title is ambiguous or the source already has an accepted model-inferred title.",
    ],
    executionMode: "sequential",
    parameters: novelTitleParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beginToolCall("mutation");
      if (blocked) return blocked;
      assertBatchWritable();
      assertSemanticStageAuthority("propose_novel_title");
      if (!activeSourceId || !compilerBatchId?.startsWith(`batch-${activeSourceId}-`)) {
        throw new Error("Novel-title inference is available only in an ordinary source-review batch.");
      }
      if (!boundedSliceSegments.some((segment) => segment.ordinal === 0)) {
        throw new Error("Novel-title inference is restricted to the source-opening evidence slice.");
      }
      const { segments: [evidenceSegment], evidence: [evidence] } = resolveEvidenceSegmentIds([input.evidence_segment_id]);
      if (!evidenceSegment || evidenceSegment.ordinal !== 0 || !evidence) {
        throw new Error("Novel-title evidence_segment_id must identify the exact source-opening segment supplied by the host.");
      }
      await assertEvidenceWithinBoundedSlice({ evidence: [evidence] }, undefined);
      const inspected = await evidenceVerifier.inspect(evidence);
      if (!inspected.valid || inspected.excerpt === undefined) {
        throw new Error(`Novel-title evidence failed verification: ${inspected.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`);
      }
      const title = normalizeModelInferredNovelTitle(input.title);
      if (!inferredTitleOccursInEvidence(title, inspected.excerpt)) {
        throw new Error("The model-inferred novel title must occur in its verified opening evidence.");
      }
      const source = await (await WorkspaceStore.create(workspaceRoot)).getSource(activeSourceId);
      if (!source) throw new Error(`Unknown active compiler source: ${activeSourceId}`);
      if (source.titleInference) throw new Error(`Source ${activeSourceId} already has an accepted model-inferred title '${source.title}'.`);
      if (!pendingNovelTitleProposal && activeProposalCount() >= COMPILER_ACTIVE_PROPOSAL_SAFETY_FUSE) {
        throw new Error(`The compiler batch reached its ${COMPILER_ACTIVE_PROPOSAL_SAFETY_FUSE}-proposal safety fuse.`);
      }
      const proposal = sourceTitleProposalSchema.parse({
        version: 1,
        proposalId: input.proposal_id,
        sourceId: activeSourceId,
        title,
        evidence,
        generatedBy: {
          worker: "propose_novel_title",
          ...generatedBy,
          compilerBatchId,
        },
        createdAt: new Date().toISOString(),
      });
      pendingNovelTitleProposal = await (await WorkspaceStore.create(workspaceRoot))
        .stageSourceTitleProposal(activeSourceId, proposal);
      recordProposalProgress();
      return {
        content: [{
          type: "text" as const,
          text: `Pending novel-title proposal ${proposal.proposalId} recorded as ${promptJson(title)}. It remains inactive until finish_compiler_batch succeeds.`,
        }],
        details: {
          proposalId: proposal.proposalId,
          kind: "novel-title",
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
    description: "Read one bounded context-only preview from the immediate previous or next source segment when the current slice appears to cut through a semantic unit. The preview has no citable evidence segment ID and cannot ground a proposal.",
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
            citationPolicy: "context-only; this preview supplies no evidence segment ID and cannot ground a proposal",
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

  const readActiveAccountingProposals = async (): Promise<ActiveSourceAccountingProposal[]> => {
    if (!activeSourceId) return [];
    const proposals: ActiveSourceAccountingProposal[] = [];
    for (const proposalId of [...successfulAccountingProposalIds].sort()) {
      try {
        proposals.push({
          proposal: await accountingStore.readProposal(activeSourceId, "pending", proposalId),
          proposalStatus: "pending",
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        proposals.push({
          proposal: await accountingStore.readProposal(activeSourceId, "accepted", proposalId),
          proposalStatus: "accepted",
        });
      }
    }
    return proposals;
  };

  const projectActiveAccountingDecisions = (
    activeProposals: readonly ActiveSourceAccountingProposal[],
    structure: Awaited<ReturnType<typeof ensureSourceStructure>>,
    semanticCoverage: Awaited<ReturnType<typeof readProspectiveSemanticCoverage>>,
  ): SourceUnitAccountingDecision[] => {
    const units = new Map(baseStructuralUnits(structure).map((unit) => [unit.id, unit]));
    const semanticSpans = [
      ...semanticCoverage.assertions.flatMap((assertion) => assertion.anchors),
      ...semanticCoverage.annotations.flatMap((annotation) => annotation.anchors),
    ];
    return activeProposals.flatMap(({ proposal, proposalStatus }) =>
      proposal.decisions.flatMap((decision) => {
        const unit = units.get(decision.unitId);
        const nowRepresented = unit !== undefined && unit.kind !== "non-scene" && semanticSpans.some((span) =>
          span.sourceId === structure.sourceId
          && byteRangesOverlap(unit.anchor.startByte, unit.anchor.endByte, span.startByte, span.endByte));
        // Accepted dispositions were valid under their original finish. On a
        // later recovery, newly available exact semantics deterministically
        // supersede only the overlapping decisions; the immutable proposal
        // remains history and every still-unrepresented decision is replayed.
        if (proposalStatus === "accepted" && nowRepresented) return [];
        return [{ ...decision, proposalId: proposal.id }];
      }));
  };

  const readActiveAnnotationInventory = async (): Promise<Array<{
    proposalId: string;
    annotationType: SourceAnnotationType;
    annotationId: string;
    annotation: SourceAnnotation;
  }>> => {
    if (!activeSourceId) return [];
    const inventory: Array<{
      proposalId: string;
      annotationType: SourceAnnotationType;
      annotationId: string;
      annotation: SourceAnnotation;
    }> = [];
    for (const proposalId of [...successfulAnnotationProposalIds].sort()) {
      let proposal;
      try {
        proposal = await annotationStore.readProposal(activeSourceId, "pending", proposalId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        proposal = await annotationStore.readProposal(activeSourceId, "accepted", proposalId);
      }
      inventory.push({
        proposalId,
        annotationType: proposal.annotationType,
        annotationId: proposal.payload.id,
        annotation: proposal.payload,
      });
    }
    return inventory;
  };

  const readProspectiveSemanticCoverage = async (): Promise<{
    assertions: EvidenceAssertion[];
    annotations: Array<{ id: string; anchors: ReturnType<typeof annotationAnchors> }>;
  }> => {
    const assertions: EvidenceAssertion[] = [];
    for (const proposalId of [...successfulProposalIds].sort()) {
      const envelope = await service.store.readEnvelope("pending", proposalId);
      assertions.push(...evidenceAssertionSchema.array().parse(envelope.evidenceAssertions ?? []));
    }
    const annotations = (await readActiveAnnotationInventory()).map(({ annotationId, annotation }) => ({
      id: annotationId,
      anchors: annotationAnchors(annotation),
    }));
    return { assertions, annotations };
  };

  const assertOrdinaryAccountingBatch = () => {
    if (!activeSourceId || !compilerBatchId || !expectedSegmentIds.length) {
      throw new Error("Source-unit accounting requires an ordinary bounded source-review batch.");
    }
    if (isStructureDiscoveryBatch() || activeBoundaryCalibration || !compilerBatchId.startsWith(`batch-${activeSourceId}-`)) {
      throw new Error("Source-unit accounting is unavailable in discovery, boundary-calibration, and reconciliation batches.");
    }
  };

  const findSourceAccountingUnitsTool = defineTool<typeof sourceAccountingFindParameters, CompilerProposalDetails>({
    name: "find_source_accounting_units",
    label: "Find source accounting units",
    description: "Page through deterministic sentence-level source units in the active bounded batch, including exact text and their current or pending accounting status. This is read-only.",
    promptSnippet: "Inspect every unrepresented source unit before finishing a novel-scale batch",
    promptGuidelines: [
      "For read-only inspection, page only through exact returned nextOffset values until null; never estimate an offset.",
      "Units marked represented are host-derived from exact evidence or annotations and must not be dispositioned by the model.",
      "A prior field reports the materialized parent/current manifest only as review context; it never satisfies this active batch's fresh accounting requirement.",
      "A non-empty status=unresolved result returns a pageToken and one-based unit indexes. Review every unit, then pass that token to account_source_units with one page_default plus only genuinely different page_overrides.",
      "After a successful page accounting proposal, the unresolved result set shrinks: refetch status=unresolved at offset=0 instead of following the old nextOffset. Repeat until the returned units are empty.",
      "A page token is bound to this active batch and exact returned page. Refetch after new semantic proposals change represented coverage; never guess or reuse a stale token.",
      "Classify every remaining unit in a proposal-bearing segment; use unresolved or intentionally-deferred honestly when semantics remain open.",
    ],
    executionMode: "sequential",
    parameters: sourceAccountingFindParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beginToolCall("retrieval");
      if (blocked) return blocked;
      assertBatchWritable();
      assertSemanticStageAuthority("find_source_accounting_units");
      assertOrdinaryAccountingBatch();
      if (input.segment_id && !expectedSegmentIds.includes(input.segment_id)) {
        throw new Error(`Accounting segment ${input.segment_id} is outside the active compiler slice (${expectedSegmentIds.join(", ")}).`);
      }
      const workspace = await WorkspaceStore.create(workspaceRoot);
      const source = await workspace.getSource(activeSourceId!);
      if (!source) throw new Error(`Unknown active compiler source: ${activeSourceId}`);
      const [structure, bytes, manifest, activeAccounting, semanticCoverage] = await Promise.all([
        ensureSourceStructure(workspaceRoot, source),
        readSourceMaterial(workspaceRoot, source),
        accountingStore.read(source.id),
        readActiveAccountingProposals(),
        readProspectiveSemanticCoverage(),
      ]);
      const targetSegments = input.segment_id
        ? boundedSliceSegments.filter((segment) => segment.id === input.segment_id)
        : boundedSliceSegments;
      const currentByUnit = new Map((manifest?.records ?? []).map((record) => [record.unitId, record]));
      const pendingByUnit = new Map(projectActiveAccountingDecisions(activeAccounting, structure, semanticCoverage).map((decision) => [
        decision.unitId,
        { proposalId: decision.proposalId!, status: decision.status, reason: decision.reason },
      ] as const));
      const semanticSpans = [
        ...semanticCoverage.assertions.flatMap((assertion) => assertion.anchors),
        ...semanticCoverage.annotations.flatMap((annotation) => annotation.anchors),
      ];
      const statusFilter = input.status ?? "all";
      const candidates = baseStructuralUnits(structure)
        .filter((unit) => {
          const range = sourceUnitReviewRange(bytes, unit);
          return byteRangeCoveredBySegments(range.startByte, range.endByte, targetSegments);
        })
        .map((unit) => {
          const represented = unit.kind !== "non-scene" && semanticSpans.some((span) =>
            span.sourceId === source.id
            && byteRangesOverlap(unit.anchor.startByte, unit.anchor.endByte, span.startByte, span.endByte));
          const pending = pendingByUnit.get(unit.id);
          const current = currentByUnit.get(unit.id);
          const status = unit.kind === "non-scene"
            ? "background-only"
            : represented
              ? "represented"
              : pending?.status ?? "unresolved";
          return {
            unitId: unit.id,
            kind: unit.kind,
            lines: [unit.anchor.startLine, unit.anchor.endLine],
            bytes: [unit.anchor.startByte, unit.anchor.endByte],
            status,
            ...(pending ? { pending } : {}),
            ...(current ? {
              prior: {
                status: current.status,
                ...(current.reason ? { reason: current.reason } : {}),
              },
            } : {}),
            text: bytes.subarray(unit.anchor.startByte, unit.anchor.endByte).toString("utf8"),
          };
        })
        .filter((unit) => statusFilter === "all"
          || (statusFilter === "pending" ? Boolean(unit.pending) : unit.status === "unresolved"));
      const offset = input.offset ?? 0;
      // Sentence payloads are source text, not a compact index. Bound one
      // page so a novel-scale slice cannot crowd out the model's proposal and
      // finish context; exact nextOffset/pageToken preserve full coverage.
      const maxResults = input.max_results ?? 20;
      const page = candidates.slice(offset, offset + maxResults);
      const nextOffset = offset + page.length < candidates.length ? offset + page.length : null;
      const pageToken = statusFilter === "unresolved" && page.length
        ? `acctpg-${crypto.randomBytes(8).toString("hex")}`
        : undefined;
      if (pageToken) {
        issuedAccountingPages.set(pageToken, {
          sourceId: source.id,
          compilerBatchId: compilerBatchId!,
          unitIds: page.map((unit) => unit.unitId),
        });
      }
      return {
        content: [{ type: "text" as const, text: promptJson({
          type: "source-accounting-units",
          sourceId: source.id,
          compilerBatchId,
          total: candidates.length,
          offset,
          nextOffset,
          ...(pageToken ? { pageToken, indexBase: 1 } : {}),
          units: page.map((unit, index) => ({ unitIndex: index + 1, ...unit })),
          policy: "represented is host-derived and non-scene is deterministic. prior is materialized parent/current context only and never satisfies this active batch. For a status=unresolved page, review each unit and use pageToken + page_default + page_overrides; the host expands indexes to exact unit IDs. After recording it, refetch unresolved at offset 0 because the result set shrinks.",
        }) }],
        details: {
          proposalId: `accounting-page-${offset}`,
          kind: "source-accounting",
          unitIds: page.map((unit) => unit.unitId),
          ...(pageToken ? { pageToken } : {}),
        },
      };
    },
  });

  const accountSourceUnitsTool = defineTool<typeof sourceAccountingParameters, CompilerProposalDetails>({
    name: "account_source_units",
    label: "Account source units",
    description: "Stage typed review dispositions for exact deterministic source-unit IDs. It cannot assert represented coverage and does not create world truth.",
    promptSnippet: "Disposition every unrepresented semantic unit in a proposal-bearing source segment",
    promptGuidelines: [
      "Prefer page_token + page_default for one freshly returned status=unresolved page; use page_overrides only for indexes whose honest status/reason differs.",
      "page_default expands to a separate typed decision for every unit in that exact page; review every unit before choosing it. It is never permission to blanket-label an unread segment.",
      "Alternatively use decisions with exact unit IDs returned by find_source_accounting_units; never mix the two input modes.",
      "Do not classify a represented or deterministic non-scene unit.",
      "Use background-only only for non-material narration; use duplicate-description only when semantics are already represented elsewhere; unresolved and intentionally-deferred remain preparation blockers.",
    ],
    executionMode: "sequential",
    parameters: sourceAccountingParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beginToolCall("mutation");
      if (blocked) return blocked;
      assertBatchWritable();
      assertSemanticStageAuthority("account_source_units");
      assertOrdinaryAccountingBatch();
      if (successfulProposalIds.has(input.proposal_id)
        || successfulAnnotationProposalIds.has(input.proposal_id)
        || successfulEntityResolutionProposalIds.has(input.proposal_id)
        || successfulEventResolutionProposalIds.has(input.proposal_id)
        || pendingNovelTitleProposal?.proposalId === input.proposal_id) {
        throw new Error(`Proposal ID ${input.proposal_id} is already used by another proposal store in this batch.`);
      }
      if (!successfulAccountingProposalIds.has(input.proposal_id)
        && activeProposalCount() >= COMPILER_ACTIVE_PROPOSAL_SAFETY_FUSE) {
        throw new Error(`The compiler batch reached its ${COMPILER_ACTIVE_PROPOSAL_SAFETY_FUSE}-proposal safety fuse.`);
      }
      const workspace = await WorkspaceStore.create(workspaceRoot);
      const source = await workspace.getSource(activeSourceId!);
      if (!source) throw new Error(`Unknown active compiler source: ${activeSourceId}`);
      const [structure, bytes, activeProposals, semanticCoverage] = await Promise.all([
        ensureSourceStructure(workspaceRoot, source),
        readSourceMaterial(workspaceRoot, source),
        readActiveAccountingProposals(),
        readProspectiveSemanticCoverage(),
      ]);
      const byId = new Map(baseStructuralUnits(structure).map((unit) => [unit.id, unit]));
      const alreadyDecided = new Map(projectActiveAccountingDecisions(activeProposals, structure, semanticCoverage).map((decision) => [
        decision.unitId,
        decision.proposalId!,
      ] as const));
      const exactMode = Boolean(input.decisions?.length);
      const pageMode = Boolean(input.page_token || input.page_default || input.page_overrides?.length);
      if (exactMode === pageMode) {
        throw new Error(
          "account_source_units requires exactly one input mode: decisions with exact unit IDs, or page_token + page_default with optional page_overrides.",
        );
      }
      let decisionInputs: Array<{ unitId: string; status: string; reason: string }>;
      if (exactMode) {
        decisionInputs = input.decisions!.map((decision) => ({
          unitId: decision.unit_id,
          status: decision.status,
          reason: decision.reason,
        }));
      } else {
        if (!input.page_token || !input.page_default) {
          throw new Error(
            "Page accounting requires both page_token and page_default. Call find_source_accounting_units with status=unresolved and copy its exact pageToken; do not guess.",
          );
        }
        const issued = issuedAccountingPages.get(input.page_token);
        if (!issued || issued.sourceId !== source.id || issued.compilerBatchId !== compilerBatchId) {
          throw new Error(
            `Unknown or stale accounting page token ${input.page_token}. Call find_source_accounting_units with status=unresolved in this same active batch, copy the exact returned pageToken, and retry once; do not guess or reuse an earlier token.`,
          );
        }
        const overrides = new Map<number, { status: string; reason: string }>();
        for (const override of input.page_overrides ?? []) {
          if (override.unit_index > issued.unitIds.length) {
            throw new Error(
              `Accounting page index ${override.unit_index} is outside page token ${input.page_token} (1-${issued.unitIds.length}). Refetch the page and retry once with an exact returned unitIndex; do not guess.`,
            );
          }
          if (overrides.has(override.unit_index)) {
            throw new Error(`Accounting page index ${override.unit_index} has more than one override.`);
          }
          overrides.set(override.unit_index, { status: override.status, reason: override.reason });
        }
        decisionInputs = issued.unitIds.map((unitId, index) => ({
          unitId,
          ...(overrides.get(index + 1) ?? input.page_default!),
        }));
      }
      const decisions = decisionInputs.map((decision) => sourceUnitAccountingDecisionSchema.omit({ proposalId: true }).parse(decision));
      if (new Set(decisions.map((decision) => decision.unitId)).size !== decisions.length) {
        throw new Error("account_source_units decisions must use unique unit IDs.");
      }
      const semanticSpans = [
        ...semanticCoverage.assertions.flatMap((assertion) => assertion.anchors),
        ...semanticCoverage.annotations.flatMap((annotation) => annotation.anchors),
      ];
      for (const decision of decisions) {
        const unit = byId.get(decision.unitId);
        if (!unit) throw new Error(`Unknown deterministic source unit ${decision.unitId}; call find_source_accounting_units and copy unitId exactly.`);
        const reviewRange = sourceUnitReviewRange(bytes, unit);
        if (!byteRangeCoveredBySegments(reviewRange.startByte, reviewRange.endByte, boundedSliceSegments)) {
          throw new Error(`Source unit ${decision.unitId} is outside the active bounded compiler slice.`);
        }
        if (unit.kind === "non-scene") {
          throw new Error(`Source unit ${decision.unitId} is deterministic non-scene content and cannot receive a model disposition.`);
        }
        if (semanticSpans.some((span) => span.sourceId === source.id
          && byteRangesOverlap(unit.anchor.startByte, unit.anchor.endByte, span.startByte, span.endByte))) {
          throw new Error(`Source unit ${decision.unitId} is represented by exact current-batch semantics and cannot receive a model disposition.`);
        }
        const priorProposalId = alreadyDecided.get(decision.unitId);
        if (priorProposalId && priorProposalId !== input.proposal_id) {
          throw new Error(`Source unit ${decision.unitId} is already dispositioned by active proposal ${priorProposalId}; withdraw it before replacing the decision.`);
        }
      }
      const proposal: SourceAccountingProposal = {
        version: 1,
        id: input.proposal_id,
        sourceId: source.id,
        compilerBatchId: compilerBatchId!,
        decisions,
        generatedBy: { worker: "account_source_units", ...generatedBy },
        createdAt: new Date().toISOString(),
      };
      await accountingStore.stageProposal(proposal);
      successfulAccountingProposalIds.add(proposal.id);
      if (input.page_token) issuedAccountingPages.delete(input.page_token);
      recordProposalProgress();
      return proposalResult(
        `Pending source-accounting proposal ${proposal.id} recorded for ${decisions.length} unit(s). These review dispositions do not create world truth.`,
        { proposalId: proposal.id, kind: "source-accounting", unitIds: decisions.map((decision) => decision.unitId) },
      );
    },
  });

  const retrievalTools = [
    ...createCompilerArtifactRetrievalTools(workspaceRoot, () => activeSourceId, () => beginToolCall("retrieval")),
    ...createSourceAnnotationRetrievalTools(workspaceRoot, () => activeSourceId, () => beginToolCall("retrieval")),
    ...createEntityResolutionRetrievalTools(
      workspaceRoot,
      () => activeSourceId,
      () => compilerBatchId,
      () => beginToolCall("retrieval"),
    ),
    ...createEventResolutionRetrievalTools(
      workspaceRoot,
      () => activeSourceId,
      () => compilerBatchId,
      () => beginToolCall("retrieval"),
    ),
    ...createCompilerSourceEvidenceTools(workspaceRoot, () => activeSourceId, () => beginToolCall("retrieval")),
    findSourceAccountingUnitsTool,
  ];

  const proposalTools = (Object.keys(labels) as CompilerProposalKind[]).map((kind) => {
    const metadata = labels[kind];
    const parameters = proposalToolParameters(kind);
    return defineTool<typeof parameters, CompilerProposalDetails>({
      name: metadata.name,
      label: metadata.label,
      description: metadata.description,
      promptSnippet: metadata.description,
      promptGuidelines: ["Search/read source evidence before proposing.", "Never claim a proposal is committed world truth.", "Use stable logical IDs and cite precise host-issued segment IDs only through evidence_segment_ids; the host injects schema-required evidence.", "For each material field or relation, add an evidence_selector with an exact source quote, its payload JSON Pointer, relation, and independently judged strength. Never submit offsets or hashes.", "Entity canonical names and aliases must occur in their supplied evidence; empty aliases are valid.", "Use ASCII logical entity IDs, never display names or descriptions, in state entity-reference values such as character.inventory."],
      executionMode: "sequential",
      parameters,
      prepareArguments: (args) => prepareProposalToolArguments(args, kind),
      async execute(_id, input, signal) {
        signal?.throwIfAborted();
        const blocked = beginToolCall("mutation");
        if (blocked) return blocked;
        assertBatchWritable();
        assertSemanticStageAuthority(metadata.name);
        if (isStructureDiscoveryBatch()) {
          throw new Error("World-artifact proposals are unavailable during chapter structure discovery.");
        }
        const normalized = await normalizeProposalEvidence(kind, input);
        await assertEvidenceWithinBoundedSlice(normalized.payload, normalized.evidence);
        await assertStableLogicalRevision(service, kind, normalized.payload, compilerBatchId);
        if (successfulAnnotationProposalIds.has(input.proposal_id)) {
          throw new Error(`Proposal ID ${input.proposal_id} is already used by a source-annotation proposal in this batch.`);
        }
        if (successfulEntityResolutionProposalIds.has(input.proposal_id)) {
          throw new Error(`Proposal ID ${input.proposal_id} is already used by an entity-resolution proposal in this batch.`);
        }
        if (successfulEventResolutionProposalIds.has(input.proposal_id)) {
          throw new Error(`Proposal ID ${input.proposal_id} is already used by an event-resolution proposal in this batch.`);
        }
        if (successfulAccountingProposalIds.has(input.proposal_id)) {
          throw new Error(`Proposal ID ${input.proposal_id} is already used by a source-accounting proposal in this batch.`);
        }
        if (!successfulProposalIds.has(input.proposal_id) && activeProposalCount() >= COMPILER_ACTIVE_PROPOSAL_SAFETY_FUSE) {
          throw new Error(`The compiler batch reached its ${COMPILER_ACTIVE_PROPOSAL_SAFETY_FUSE}-proposal safety fuse. Do not withdraw semantically valid work to make room; stop this turn and preserve the exact drafts for diagnosis.`);
        }
        const accepted = await service.submit(kind, {
          proposalId: input.proposal_id,
          payload: normalized.payload,
          evidence: normalized.evidence,
          evidenceAssertions: normalized.evidenceAssertions,
          generatedBy: {
            worker: metadata.name,
            ...generatedBy,
            ...(compilerBatchId ? { compilerBatchId } : {}),
          },
        });
        successfulProposalIds.add(accepted.proposalId);
        recordProposalProgress();
        return proposalResult(
          `Pending ${accepted.kind} proposal ${accepted.proposalId} recorded. It is not committed truth. Continue until every material evidence-backed unit and required closure record in the supplied scope has been handled; never omit or withdraw valid work merely to conserve execution capacity.`,
          {
            ...accepted,
          },
        );
      },
    });
  });
  const annotationResult = (
    proposalId: string,
    annotation: SourceAnnotation,
  ) => proposalResult(
    `Pending ${annotation.annotationType} observation ${proposalId} recorded for annotation ${annotation.id}. It records source semantics only and does not create canonical world truth. Continue with all material evidence-backed observations and their required resolution/closure records.`,
    {
      proposalId,
      kind: annotation.annotationType,
      annotationId: annotation.id,
    },
  );
  const entityMentionTool = defineTool<typeof entityMentionParameters, CompilerProposalDetails>({
    name: "propose_entity_mention",
    label: "Propose entity mention",
    description: "Stage an exact source mention with candidate entity kinds. This never creates, resolves, or aliases a canonical entity.",
    promptSnippet: "Record a source mention before making any identity-resolution claim",
    promptGuidelines: [
      "Copy non-zero surface text exactly from selector.exact.",
      "Use zero-anaphora only when the actor/object is grammatically omitted; anchor the exact predicate or cue and explain the inference.",
      "Do not put a canonical entity ID in this observation. Identity resolution is a separate validated stage.",
    ],
    executionMode: "sequential",
    parameters: entityMentionParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beginToolCall("mutation");
      if (blocked) return blocked;
      assertBatchWritable();
      if (isStructureDiscoveryBatch()) throw new Error("Source annotations are unavailable during chapter structure discovery.");
      if (input.form !== "zero-anaphora" && input.surface !== input.selector.exact) {
        throw new Error("A non-zero entity mention surface must exactly equal selector.exact.");
      }
      const anchor = await resolveObservationSelector(input.selector);
      const annotation = entityMentionSchema.parse({
        version: 1,
        annotationType: "entity-mention",
        id: input.annotation_id,
        sourceId: activeSourceId,
        anchor,
        surface: input.surface,
        form: input.form,
        kindCandidates: input.kind_candidates,
        ...(input.scene_id ? { sceneId: input.scene_id } : {}),
        confidence: input.confidence,
        ...(input.interpretation ? { interpretation: input.interpretation } : {}),
        derivation: annotationDerivation("propose_entity_mention", input.proposal_id),
      });
      await stageAnnotation(input.proposal_id, annotation, "propose_entity_mention");
      return annotationResult(input.proposal_id, annotation);
    },
  });
  const eventMentionTool = defineTool<typeof eventMentionParameters, CompilerProposalDetails>({
    name: "propose_event_mention",
    label: "Propose event mention",
    description: "Stage an exact textual event occurrence with trigger, extent, participant mentions, and discourse context. This never asserts that the event happened or creates a canonical event.",
    promptSnippet: "Record a source event mention before proposing event identity or world effects",
    promptGuidelines: [
      "Copy trigger exactly from trigger_selector.exact and make sure one extent selector contains it.",
      "Reference participant mention IDs, never canonical entity IDs.",
      "Salience describes compilation importance, not factuality. Hypothetical, remembered, dreamed, denied, or narrated events remain observations until later adjudication.",
      "Use scene_id for an enclosing scene and discourse_segment_id for the most relevant flashback, dream, document, summary, or other discourse layer.",
    ],
    executionMode: "sequential",
    parameters: eventMentionParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beginToolCall("mutation");
      if (blocked) return blocked;
      assertBatchWritable();
      if (isStructureDiscoveryBatch()) throw new Error("Source annotations are unavailable during chapter structure discovery.");
      if (input.trigger !== input.trigger_selector.exact) {
        throw new Error("An event mention trigger must exactly equal trigger_selector.exact.");
      }
      const [triggerAnchor, extentAnchors] = await Promise.all([
        resolveObservationSelector(input.trigger_selector),
        Promise.all(input.extent_selectors.map(resolveObservationSelector)),
      ]);
      const annotation = eventMentionSchema.parse({
        version: 1,
        annotationType: "event-mention",
        id: input.annotation_id,
        sourceId: activeSourceId,
        triggerAnchor,
        trigger: input.trigger,
        extentAnchors: extentAnchors
          .sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte),
        eventTypeCandidates: input.event_type_candidates,
        participantMentionIds: input.participant_mention_ids,
        ...(input.scene_id ? { sceneId: input.scene_id } : {}),
        ...(input.discourse_segment_id ? { discourseSegmentId: input.discourse_segment_id } : {}),
        salience: input.salience,
        confidence: input.confidence,
        ...(input.interpretation ? { interpretation: input.interpretation } : {}),
        derivation: annotationDerivation("propose_event_mention", input.proposal_id),
      });
      await stageAnnotation(input.proposal_id, annotation, "propose_event_mention");
      return annotationResult(input.proposal_id, annotation);
    },
  });
  const quotationTool = defineTool<typeof quotationParameters, CompilerProposalDetails>({
    name: "propose_quotation",
    label: "Propose quotation",
    description: "Stage an exact direct, indirect, or free-indirect discourse observation with mention-based attribution.",
    promptSnippet: "Record quoted or represented speech without collapsing speaker mentions into canonical identity",
    promptGuidelines: [
      "Reference speaker/addressee mention IDs, not canonical character IDs.",
      "Use a cue selector when an attribution phrase sits outside the quoted span.",
      "Explain indirect and free-indirect readings; the source span alone may not determine their discourse mode.",
    ],
    executionMode: "sequential",
    parameters: quotationParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beginToolCall("mutation");
      if (blocked) return blocked;
      assertBatchWritable();
      if (isStructureDiscoveryBatch()) throw new Error("Source annotations are unavailable during chapter structure discovery.");
      const [anchor, cueAnchor] = await Promise.all([
        resolveObservationSelector(input.selector),
        input.cue_selector ? resolveObservationSelector(input.cue_selector) : Promise.resolve(undefined),
      ]);
      const annotation = quotationSchema.parse({
        version: 1,
        annotationType: "quotation",
        id: input.annotation_id,
        sourceId: activeSourceId,
        anchor,
        mode: input.mode,
        ...(input.speaker_mention_id ? { speakerMentionId: input.speaker_mention_id } : {}),
        addresseeMentionIds: input.addressee_mention_ids,
        ...(cueAnchor ? { cueAnchor } : {}),
        ...(input.scene_id ? { sceneId: input.scene_id } : {}),
        attributionConfidence: input.attribution_confidence,
        ...(input.interpretation ? { interpretation: input.interpretation } : {}),
        derivation: annotationDerivation("propose_quotation", input.proposal_id),
      });
      await stageAnnotation(input.proposal_id, annotation, "propose_quotation");
      return annotationResult(input.proposal_id, annotation);
    },
  });
  const discourseObservationTool = defineTool<typeof discourseObservationParameters, CompilerProposalDetails>({
    name: "propose_discourse_segment",
    label: "Propose discourse segment",
    description: "Stage an overlapping scene, summary, temporal displacement, frame, document, dream, or commentary span without changing source order or world time.",
    promptSnippet: "Record discourse organization independently from chronological world events",
    promptGuidelines: [
      "Overlapping observations are allowed; use multiple exact selectors for a discontinuous span.",
      "A viewpoint reference is a mention ID. Do not infer a canonical actor identity here.",
      "Flashback/flashforward describes discourse presentation only and never commits chronological world truth.",
    ],
    executionMode: "sequential",
    parameters: discourseObservationParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beginToolCall("mutation");
      if (blocked) return blocked;
      assertBatchWritable();
      if (isStructureDiscoveryBatch()) throw new Error("Source annotations are unavailable during chapter structure discovery.");
      const anchors = (await Promise.all(input.selectors.map(resolveObservationSelector)))
        .sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte);
      const annotation = discourseObservationSchema.parse({
        version: 1,
        annotationType: "discourse-segment",
        id: input.annotation_id,
        sourceId: activeSourceId,
        kind: input.kind,
        anchors,
        ...(input.viewpoint_mention_id ? { viewpointMentionId: input.viewpoint_mention_id } : {}),
        confidence: input.confidence,
        ...(input.interpretation ? { interpretation: input.interpretation } : {}),
        derivation: annotationDerivation("propose_discourse_segment", input.proposal_id),
      });
      await stageAnnotation(input.proposal_id, annotation, "propose_discourse_segment");
      return annotationResult(input.proposal_id, annotation);
    },
  });
  const annotationProposalTools = [entityMentionTool, eventMentionTool, quotationTool, discourseObservationTool];
  const identityResolutionTool = defineTool<typeof identityResolutionParameters, CompilerProposalDetails>({
    name: "propose_entity_resolution",
    label: "Propose entity resolution",
    description: "Stage an explicit resolved, new-entity, ambiguous, unresolved, non-referential, or misidentified decision for one entity mention. This never creates canonical identity by itself.",
    promptSnippet: "Resolve or deliberately leave open one source mention after deterministic candidate lookup",
    promptGuidelines: [
      "Call find_entity_resolution_candidates first unless the mention is an explicit new identity or has no lexical surface.",
      "Use the candidate's resolutionMode: resolved may reuse a canonical entity or an active entity proposal from a previously checkpointed source batch; new-entity requires a same-finish propose_entity candidate.",
      "Ambiguous and unresolved are valid outcomes. Never select a candidate merely to eliminate an uncertainty count.",
      "Use non-referential only when exact context proves the retained annotation is not an independent entity reference, such as a false-positive subspan inside a compound name. It requires no entity_id, alias_type, or candidates and must not hide uncertainty.",
      "Use misidentified only when the source determinately distinguishes the actual referent from the speaker's mistaken intended identity. entity_id is the actual referent, intended_entity_id is the mistaken intended identity, both must be existing candidates, and the wrong surface never becomes an alias.",
      "Every candidate basis must include the primary mention ID. evidence_assertion_ids may be empty when the exact mention anchors are the complete basis.",
      "To revise a current decision, use a new resolution_id and set supersedes_resolution_id to the exact current resolution ID.",
    ],
    executionMode: "sequential",
    parameters: identityResolutionParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beginToolCall("mutation");
      if (blocked) return blocked;
      assertBatchWritable();
      assertSemanticStageAuthority("propose_entity_resolution");
      if (isStructureDiscoveryBatch()) throw new Error("Identity resolution is unavailable during chapter structure discovery.");
      if (!activeSourceId) throw new Error("Identity resolution requires an active source-scoped compiler batch.");
      if (successfulProposalIds.has(input.proposal_id)
        || successfulAnnotationProposalIds.has(input.proposal_id)
        || successfulEventResolutionProposalIds.has(input.proposal_id)
        || successfulAccountingProposalIds.has(input.proposal_id)) {
        throw new Error(`Proposal ID ${input.proposal_id} is already used by another compiler proposal in this batch.`);
      }
      if (!successfulEntityResolutionProposalIds.has(input.proposal_id) && activeProposalCount() >= COMPILER_ACTIVE_PROPOSAL_SAFETY_FUSE) {
        throw new Error(`The compiler batch reached its ${COMPILER_ACTIVE_PROPOSAL_SAFETY_FUSE}-proposal safety fuse. Do not withdraw semantically valid work to make room; stop this turn and preserve the exact drafts for diagnosis.`);
      }
      const resolution = identityResolutionSchema.parse({
        version: 1,
        id: input.resolution_id,
        sourceId: activeSourceId,
        mentionId: input.mention_id,
        status: input.status,
        ...(input.entity_id ? { entityId: input.entity_id } : {}),
        ...(input.intended_entity_id ? { intendedEntityId: input.intended_entity_id } : {}),
        candidates: input.candidates.map((candidate) => ({
          entityId: candidate.entity_id,
          confidence: candidate.confidence,
          basisMentionIds: candidate.basis_mention_ids,
          evidenceAssertionIds: candidate.evidence_assertion_ids,
          rationale: candidate.rationale,
        })),
        ...(input.alias_type ? { aliasType: input.alias_type } : {}),
        ...(input.valid_story_time ? { validStoryTime: input.valid_story_time } : {}),
        ...(input.supersedes_resolution_id ? { supersedesResolutionId: input.supersedes_resolution_id } : {}),
        rationale: input.rationale,
        derivation: {
          runId: compilerBatchId ?? input.proposal_id,
          worker: "propose_entity_resolution",
          ...(compilerBatchId ? { compilerBatchId } : {}),
          ...generatedBy,
          ontologyVersion: ENTITY_RESOLUTION_ONTOLOGY_VERSION,
        },
      });
      await entityResolutionStore.stage(activeSourceId, {
        version: 1,
        id: input.proposal_id,
        payload: resolution,
        generatedBy: {
          worker: "propose_entity_resolution",
          ...(compilerBatchId ? { compilerBatchId } : {}),
          ...generatedBy,
        },
        createdAt: new Date().toISOString(),
      });
      successfulEntityResolutionProposalIds.add(input.proposal_id);
      recordProposalProgress();
      return proposalResult(
        `Pending entity-resolution proposal ${input.proposal_id} recorded for mention ${resolution.mentionId} with status ${resolution.status}. It is a source-to-identity decision, not canonical world truth.`,
        {
          proposalId: input.proposal_id,
          kind: "entity-resolution",
          resolutionId: resolution.id,
          mentionId: resolution.mentionId,
          status: resolution.status,
        },
      );
    },
  });
  const eventResolutionTool = defineTool<typeof eventResolutionParameters, CompilerProposalDetails>({
    name: "propose_event_resolution",
    label: "Propose event resolution",
    description: "Stage an explicit event-mention cluster as resolved, new-event, ambiguous, unresolved, or non-referential, with coreference/subevent semantics. This never commits occurrence or world effects by itself.",
    promptSnippet: "Resolve, cluster, or deliberately leave open source event mentions after deterministic candidate lookup",
    promptGuidelines: [
      "Call find_event_resolution_candidates for each cluster member before selecting an event.",
      "Use resolved only for an existing canonical event and new-event only for a same-finish propose_canonical_event candidate.",
      "Coreference means the mention describes the canonical event itself; subevent means it describes a proper component and cannot alone ground that canonical event.",
      "Ambiguous and unresolved are valid outcomes. Narrative adjacency, evidence overlap, or a shared participant never proves coreference.",
      "Use non-referential only when exact discourse context proves the annotation is a diffuse summary or false-positive event phrase with no single occurrence referent. It requires no canonical_event_id, relation, or candidates and must not hide uncertainty.",
      "Every candidate basis must include every event_mention_id in the proposed cluster.",
      "A merge or split uses a new resolution_id and supersedes_resolution_ids naming the exact current cluster revisions it replaces.",
    ],
    executionMode: "sequential",
    parameters: eventResolutionParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beginToolCall("mutation");
      if (blocked) return blocked;
      assertBatchWritable();
      assertSemanticStageAuthority("propose_event_resolution");
      if (isStructureDiscoveryBatch()) throw new Error("Event resolution is unavailable during chapter structure discovery.");
      if (!activeSourceId) throw new Error("Event resolution requires an active source-scoped compiler batch.");
      if (successfulProposalIds.has(input.proposal_id)
        || successfulAnnotationProposalIds.has(input.proposal_id)
        || successfulEntityResolutionProposalIds.has(input.proposal_id)
        || successfulAccountingProposalIds.has(input.proposal_id)) {
        throw new Error(`Proposal ID ${input.proposal_id} is already used by another compiler proposal in this batch.`);
      }
      if (!successfulEventResolutionProposalIds.has(input.proposal_id)
        && activeProposalCount() >= COMPILER_ACTIVE_PROPOSAL_SAFETY_FUSE) {
        throw new Error(`The compiler batch reached its ${COMPILER_ACTIVE_PROPOSAL_SAFETY_FUSE}-proposal safety fuse. Do not withdraw semantically valid work to make room; stop this turn and preserve the exact drafts for diagnosis.`);
      }
      const resolution = eventResolutionSchema.parse({
        version: 1,
        id: input.resolution_id,
        sourceId: activeSourceId,
        eventMentionIds: [...input.event_mention_ids].sort(),
        status: input.status,
        ...(input.canonical_event_id ? { canonicalEventId: input.canonical_event_id } : {}),
        ...(input.relation ? { relation: input.relation } : {}),
        candidates: input.candidates.map((candidate) => ({
          canonicalEventId: candidate.canonical_event_id,
          relation: candidate.relation,
          confidence: candidate.confidence,
          basisEventMentionIds: [...candidate.basis_event_mention_ids].sort(),
          evidenceAssertionIds: candidate.evidence_assertion_ids,
          rationale: candidate.rationale,
        })),
        supersedesResolutionIds: [...input.supersedes_resolution_ids].sort(),
        rationale: input.rationale,
        derivation: {
          runId: compilerBatchId ?? input.proposal_id,
          worker: "propose_event_resolution",
          ...(compilerBatchId ? { compilerBatchId } : {}),
          ...generatedBy,
          ontologyVersion: EVENT_RESOLUTION_ONTOLOGY_VERSION,
        },
      });
      await eventResolutionStore.stage(activeSourceId, {
        version: 1,
        id: input.proposal_id,
        payload: resolution,
        generatedBy: {
          worker: "propose_event_resolution",
          ...(compilerBatchId ? { compilerBatchId } : {}),
          ...generatedBy,
        },
        createdAt: new Date().toISOString(),
      });
      successfulEventResolutionProposalIds.add(input.proposal_id);
      recordProposalProgress();
      return proposalResult(
        `Pending event-resolution proposal ${input.proposal_id} recorded for ${resolution.eventMentionIds.length} event mention(s) with status ${resolution.status}. It is an identity decision, not committed occurrence or world truth.`,
        {
          proposalId: input.proposal_id,
          kind: "event-resolution",
          resolutionId: resolution.id,
          eventMentionIds: resolution.eventMentionIds,
          status: resolution.status,
        },
      );
    },
  });
  const withdrawParameters = Type.Object({
    proposal_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  }, { additionalProperties: false });
  const withdrawTool = defineTool<typeof withdrawParameters, CompilerWithdrawDetails>({
    name: "withdraw_compiler_proposal",
    label: "Withdraw compiler proposal",
    description: "Withdraw an invalid proposal successfully submitted in the current compiler batch and remove it from the finish handshake. For ordinary world artifacts, submit a corrected replacement under a new proposal ID first; novel-title metadata is a singleton and must be withdrawn before its corrected replacement can be staged.",
    promptSnippet: "Withdraw an invalid current-batch proposal before finishing",
    promptGuidelines: [
      "Use this only for a proposal successfully submitted in the current compiler batch.",
      "Explain the concrete defect, and submit an evidence-backed corrected replacement under a new proposal ID when the evidence still supports the artifact.",
      "For a defective novel-title proposal, withdraw it first and then call propose_novel_title with a new proposal ID; only one title candidate may be staged at a time.",
    ],
    executionMode: "sequential",
    parameters: withdrawParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beginToolCall("mutation");
      if (blocked) return blocked;
      assertBatchWritable();
      if (pendingNovelTitleProposal?.proposalId === input.proposal_id) {
        if (!activeSourceId) throw new Error("Novel-title proposal lost its active source identity.");
        await (await WorkspaceStore.create(workspaceRoot)).withdrawSourceTitleProposal(activeSourceId, input.proposal_id);
        pendingNovelTitleProposal = undefined;
        recordProposalProgress();
        return {
          content: [{ type: "text" as const, text: `Novel-title proposal ${input.proposal_id} withdrawn: ${input.reason}` }],
          details: { compilerProposalWithdrawn: true as const, proposalId: input.proposal_id, reason: input.reason },
        };
      }
      if (successfulAccountingProposalIds.has(input.proposal_id)) {
        if (!activeSourceId) throw new Error("Source-accounting proposal lost its active source identity.");
        let alreadyAccepted = false;
        try {
          await accountingStore.withdrawProposal(activeSourceId, input.proposal_id);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await accountingStore.readProposal(activeSourceId, "accepted", input.proposal_id);
          alreadyAccepted = true;
        }
        successfulAccountingProposalIds.delete(input.proposal_id);
        recordProposalProgress();
        return {
          content: [{
            type: "text" as const,
            text: alreadyAccepted
              ? `Previously accepted source-accounting proposal ${input.proposal_id} released from this finish handshake: ${input.reason}`
              : `Source-accounting proposal ${input.proposal_id} withdrawn to rejected history: ${input.reason}`,
          }],
          details: { compilerProposalWithdrawn: true as const, proposalId: input.proposal_id, reason: input.reason },
        };
      }
      if (successfulEventResolutionProposalIds.has(input.proposal_id)) {
        if (!activeSourceId) throw new Error("Event-resolution proposal lost its active source identity.");
        let alreadyCommitted = false;
        try {
          await eventResolutionStore.withdraw(activeSourceId, input.proposal_id);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await eventResolutionStore.readProposal(activeSourceId, "accepted", input.proposal_id);
          alreadyCommitted = true;
        }
        successfulEventResolutionProposalIds.delete(input.proposal_id);
        recordProposalProgress();
        return {
          content: [{
            type: "text" as const,
            text: alreadyCommitted
              ? `Previously committed recovery event resolution ${input.proposal_id} released from this finish handshake; immutable history remains available for a merge/split revision: ${input.reason}`
              : `Event-resolution proposal ${input.proposal_id} withdrawn to rejected history: ${input.reason}`,
          }],
          details: { compilerProposalWithdrawn: true as const, proposalId: input.proposal_id, reason: input.reason },
        };
      }
      if (successfulEntityResolutionProposalIds.has(input.proposal_id)) {
        if (!activeSourceId) throw new Error("Identity-resolution proposal lost its active source identity.");
        let alreadyCommitted = false;
        try {
          await entityResolutionStore.withdraw(activeSourceId, input.proposal_id);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await entityResolutionStore.readProposal(activeSourceId, "accepted", input.proposal_id);
          alreadyCommitted = true;
        }
        successfulEntityResolutionProposalIds.delete(input.proposal_id);
        recordProposalProgress();
        return {
          content: [{
            type: "text" as const,
            text: alreadyCommitted
              ? `Previously committed recovery resolution ${input.proposal_id} released from this finish handshake; immutable history remains available for a superseding correction: ${input.reason}`
              : `Identity-resolution proposal ${input.proposal_id} withdrawn to rejected history: ${input.reason}`,
          }],
          details: { compilerProposalWithdrawn: true as const, proposalId: input.proposal_id, reason: input.reason },
        };
      }
      if (successfulAnnotationProposalIds.has(input.proposal_id)) {
        if (!activeSourceId) throw new Error("Source-annotation proposal lost its active source identity.");
        let alreadyCommitted = false;
        try {
          await annotationStore.withdraw(activeSourceId, input.proposal_id);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await annotationStore.readProposal(activeSourceId, "accepted", input.proposal_id);
          alreadyCommitted = true;
        }
        successfulAnnotationProposalIds.delete(input.proposal_id);
        recordProposalProgress();
        return {
          content: [{
            type: "text" as const,
            text: alreadyCommitted
              ? `Previously committed recovery annotation ${input.proposal_id} released from this finish handshake; its immutable history remains available until a corrected same-identity revision is committed: ${input.reason}`
              : `Source-annotation proposal ${input.proposal_id} withdrawn to rejected history: ${input.reason}`,
          }],
          details: { compilerProposalWithdrawn: true as const, proposalId: input.proposal_id, reason: input.reason },
        };
      }
      if (!successfulProposalIds.has(input.proposal_id)) {
        throw new Error(`Cannot withdraw ${input.proposal_id}: it is not an active successful submission in this compiler batch.`);
      }
      await service.withdraw(input.proposal_id, input.reason);
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
      await service.withdraw(input.proposal_id, `Replaced by ${input.replacement_proposal_id}: ${input.reason}`);
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
      "Annotation reference fields take the referenced payload's exact annotation_id, never its proposal_id/ref or a guessed prefix variant.",
      "After a failed finish, repair or withdraw only the proposals named by the complete diagnostic and preserve every unrelated valid active draft; use outcome=complete whenever any draft remains.",
      "Never repeat an identical failing finish or switch to no-artifacts merely to escape a diagnostic.",
    ],
    executionMode: "sequential",
    parameters: finishParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      if (finished) throw new Error("Compiler batch was already finished.");
      const blocked = beginToolCall("finish");
      if (blocked) return blocked;
      const listed = [...successfulProposalIds].sort();
      const listedAnnotations = [...successfulAnnotationProposalIds].sort();
      const listedEntityResolutions = [...successfulEntityResolutionProposalIds].sort();
      const listedEventResolutions = [...successfulEventResolutionProposalIds].sort();
      const listedAccounting = [...successfulAccountingProposalIds].sort();
      const expected = [
        ...listed,
        ...listedAnnotations,
        ...listedEntityResolutions,
        ...listedEventResolutions,
        ...listedAccounting,
        ...(pendingNovelTitleProposal ? [pendingNovelTitleProposal.proposalId] : []),
      ].sort();
      if (new Set(expected).size !== expected.length) {
        return failFinish("World, annotation, and metadata proposals must use distinct proposal IDs.");
      }
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
      let accountingIssues: string[] = [];
      let prospectiveCoverage: Awaited<ReturnType<typeof readProspectiveSemanticCoverage>> = {
        assertions: [],
        annotations: [],
      };
      let activeAccountingProposals: ActiveSourceAccountingProposal[] = [];
      let activeAccountingDecisions: SourceUnitAccountingDecision[] = [];
      let accountingSource: Awaited<ReturnType<WorkspaceStore["getSource"]>> | undefined;
      let accountingStructure: Awaited<ReturnType<typeof ensureSourceStructure>> | undefined;
      let accountingBytes: Buffer | undefined;
      const stage = activeSemanticStage();
      const recordsSourceAccounting = !stage || stage === "executable";
      const graphAdjudicationIteration = graphAdjudicationIterationFromBatchId(compilerBatchId, activeSourceId);
      if (recordsSourceAccounting && activeSourceId && compilerBatchId && input.reviewed_segments.length) {
        const workspace = await WorkspaceStore.create(workspaceRoot);
        accountingSource = await workspace.getSource(activeSourceId) ?? undefined;
        if (!accountingSource) return failFinish(`Unknown active compiler source: ${activeSourceId}`);
        [accountingStructure, accountingBytes] = await Promise.all([
          ensureSourceStructure(workspaceRoot, accountingSource),
          readSourceMaterial(workspaceRoot, accountingSource),
        ]);
        prospectiveCoverage = await readProspectiveSemanticCoverage();
        activeAccountingProposals = await readActiveAccountingProposals();
        activeAccountingDecisions = projectActiveAccountingDecisions(
          activeAccountingProposals,
          accountingStructure,
          prospectiveCoverage,
        );
        const segmentsById = new Map(validatedSourceSegments.map((segment) => [segment.id, segment]));
        const prospectiveReviews = input.reviewed_segments.map((review) => {
          const segment = segmentsById.get(review.segment_id);
          if (!segment) throw new Error(`Reviewed segment ${review.segment_id} is not in the validated source manifest.`);
          return {
            startByte: segment.startByte,
            endByte: segment.endByte,
            disposition: review.disposition,
          };
        });
        accountingIssues = accountingStore.validateBatchReview({
          structure: accountingStructure,
          sourceBytes: accountingBytes,
          reviews: prospectiveReviews,
          evidenceAssertions: prospectiveCoverage.assertions,
          annotations: prospectiveCoverage.annotations,
          unitDecisions: activeAccountingDecisions,
          requireExplicitSemanticDisposition: accountingSource.bytes >= EXPLICIT_SOURCE_ACCOUNTING_MIN_SOURCE_BYTES
            && compilerBatchId.startsWith(`batch-${activeSourceId}-`)
            && !activeBoundaryCalibration,
        });
      }
      const [
        closureIssues,
        annotationClosureIssues,
        resolutionClosureIssues,
        entityTraceIssues,
        attributionTraceIssues,
        acquisitionTraceIssues,
        eventResolutionClosureIssues,
        eventTraceIssues,
        graphAdjudicationIssues,
        canonicalStructureIssues,
      ] = await Promise.all([
        validateCompilerProposalClosure(workspaceRoot, listed, activeSourceId),
        activeSourceId
          ? validateSourceAnnotationClosure(workspaceRoot, activeSourceId, listedAnnotations)
          : Promise.resolve([]),
        activeSourceId
          ? validateIdentityResolutionClosure(
            workspaceRoot,
            activeSourceId,
            listedEntityResolutions,
            listedAnnotations,
            listed,
          )
          : Promise.resolve([]),
        activeSourceId
          ? validateEntityProposalResolutionTrace(
            workspaceRoot,
            activeSourceId,
            listed,
            listedAnnotations,
            listedEntityResolutions,
          )
          : Promise.resolve([]),
        activeSourceId
          ? validateAttributionProposalTrace(
            workspaceRoot,
            activeSourceId,
            listed,
            listedAnnotations,
            listedEntityResolutions,
          )
          : Promise.resolve([]),
        activeSourceId
          ? validateKnowledgeAcquisitionProposalTrace(
            workspaceRoot,
            activeSourceId,
            listed,
            listedAnnotations,
            listedEntityResolutions,
          )
          : Promise.resolve([]),
        activeSourceId
          ? validateEventResolutionClosure(
            workspaceRoot,
            activeSourceId,
            listedEventResolutions,
            listedAnnotations,
            listedEntityResolutions,
            listed,
          )
          : Promise.resolve([]),
        activeSourceId
          ? validateEventProposalResolutionTrace(
            workspaceRoot,
            activeSourceId,
            listed,
            listedAnnotations,
            listedEntityResolutions,
            listedEventResolutions,
          )
          : Promise.resolve([]),
        activeSourceId && graphAdjudicationIteration !== undefined
          ? validateGraphAdjudicationProposalScope(
            workspaceRoot,
            activeSourceId,
            graphAdjudicationIteration,
            listed,
          )
          : Promise.resolve([]),
        new CompilerCommitService(workspaceRoot).validatePendingStructure(activeSourceId),
      ]);
      const annotationReferenceInventory = annotationClosureIssues.some((issue) =>
        issue.includes("references unknown annotation"))
        ? await readActiveAnnotationInventory()
        : [];
      const annotationReferenceInventorySection = annotationReferenceInventory.length
        ? [
            "Active source annotation IDs available for exact reference repair "
              + "(copy annotation_id values; proposal IDs and refs are envelope/discovery handles only):\n"
              + (["entity-mention", "event-mention", "quotation", "discourse-segment"] as const)
                .map((annotationType) => {
                  const annotationIds = annotationReferenceInventory
                    .filter((item) => item.annotationType === annotationType)
                    .map((item) => item.annotationId)
                    .sort();
                  return `- ${annotationType} annotation_id values: ${annotationIds.length ? annotationIds.join(", ") : "(none active in this batch)"}`;
                })
                .join("\n"),
          ]
        : [];
      const currentWorldProposalIds = new Set(listed);
      const ordinaryBatchOrdinal = (batchId: string | undefined): number | undefined => {
        if (!batchId || !activeSourceId) return undefined;
        const prefix = `batch-${activeSourceId}-`;
        if (!batchId.startsWith(prefix)) return undefined;
        const suffix = batchId.slice(prefix.length);
        const match = /^(\d{5})-(?:observation|semantic|executable)-/u.exec(suffix);
        return match ? Number.parseInt(match[1]!, 10) : undefined;
      };
      const currentBatchOrdinal = ordinaryBatchOrdinal(compilerBatchId);
      const crossBatchLifecycleIssues = (await Promise.all(canonicalStructureIssues.map(async (candidate) => {
        if (currentWorldProposalIds.has(candidate.id)) return [];
        return (await Promise.all(candidate.errors.map(async (error) => {
          if (error.code !== "SUPERSEDED_LOGICAL_PROPOSAL") return undefined;
          const replacementProposalId = /newer active proposal '([A-Za-z0-9][A-Za-z0-9._-]*)'/u.exec(error.message)?.[1];
          if (!replacementProposalId || !currentWorldProposalIds.has(replacementProposalId)) return undefined;
          const prior = await service.store.readEnvelope("pending", candidate.id);
          const generatedBy = prior.generatedBy;
          const priorBatchId = generatedBy && typeof generatedBy === "object" && !Array.isArray(generatedBy)
            && typeof (generatedBy as Record<string, unknown>).compilerBatchId === "string"
            ? (generatedBy as Record<string, unknown>).compilerBatchId as string
            : undefined;
          if (!priorBatchId || priorBatchId === compilerBatchId) return undefined;
          const priorBatchOrdinal = ordinaryBatchOrdinal(priorBatchId);
          const direction = currentBatchOrdinal !== undefined && priorBatchOrdinal === currentBatchOrdinal - 1
            ? "previous"
            : currentBatchOrdinal !== undefined && priorBatchOrdinal === currentBatchOrdinal + 1
              ? "next"
              : "unknown";
          return `CROSS_BATCH_LOGICAL_SUPERSESSION direction=${direction} prior='${candidate.id}' current='${replacementProposalId}' kind='${candidate.kind}': the prior proposal belongs to checkpointed batch '${priorBatchId}' and cannot be withdrawn from '${compilerBatchId}'. Withdraw the current-batch replacement, not the prior proposal. ${direction === "unknown"
            ? "Read the prior payload and decide whether this is accidental identity reuse or a genuine adjacent-boundary artifact before making one corrected retry."
            : `Repair or withdraw current-batch drafts that would leave one-sided links, call peek_adjacent_evidence with direction=${direction}, then call defer_boundary_artifact with the prior and dependent artifact IDs so the queued two-segment calibration pass can replace them.`}`;
        }))).filter((issue): issue is string => issue !== undefined);
      }))).flat();
      const validationSections = [
        ...(listedAnnotations.length && !activeSourceId
          ? ["Source annotations require an active source-scoped compiler batch."]
          : []),
        ...finishIssueSection("Compiler batch proposal graph", closureIssues),
        ...finishIssueSection("Source annotation graph", annotationClosureIssues),
        ...annotationReferenceInventorySection,
        ...finishIssueSection("Entity-resolution graph", resolutionClosureIssues),
        ...finishIssueSection("Canonical entity proposal trace", entityTraceIssues),
        ...finishIssueSection("Attribution quotation trace", attributionTraceIssues),
        ...finishIssueSection("Knowledge acquisition trace", acquisitionTraceIssues),
        ...finishIssueSection("Event-resolution graph", eventResolutionClosureIssues),
        ...finishIssueSection("Canonical event proposal trace", eventTraceIssues),
        ...finishIssueSection("Graph-adjudication mutation scope", graphAdjudicationIssues),
        ...finishAccountingIssueSection(accountingIssues),
        ...finishIssueSection("Cross-batch proposal lifecycle", crossBatchLifecycleIssues),
        ...finishIssueSection(
          "Deterministic canonical commit preview",
          canonicalStructureIssues.flatMap((candidate) => candidate.errors.map((error) =>
            `${candidate.id}: ${error.code}${error.path ? ` at ${error.path}` : ""}: ${error.message}`)),
        ),
      ];
      if (validationSections.length) return failFinish(validationSections.join("\n\n"));
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
      if (pendingNovelTitleProposal) {
        if (!activeSourceId) return failFinish("Novel-title proposal lost its active source identity.");
        await (await WorkspaceStore.create(workspaceRoot))
          .commitSourceTitleProposal(activeSourceId, pendingNovelTitleProposal.proposalId);
      }
      if (activeSourceId && listedAnnotations.length) {
        await annotationStore.commitProposals(activeSourceId, listedAnnotations);
      }
      if (activeSourceId && listedEntityResolutions.length) {
        await entityResolutionStore.commitProposals(activeSourceId, listedEntityResolutions);
      }
      if (activeSourceId && listedEventResolutions.length) {
        await eventResolutionStore.commitProposals(activeSourceId, listedEventResolutions);
      }
      if (recordsSourceAccounting && activeSourceId && compilerBatchId && input.reviewed_segments.length) {
        const source = accountingSource;
        if (!source || !accountingStructure || !accountingBytes) {
          return failFinish(`Source-accounting validation state was unavailable for ${activeSourceId}.`);
        }
        // Accepted proposal files are prerequisites; the manifest review is
        // the final durable marker. Both operations are idempotent, so a retry
        // repairs either side of an older half-finished ordering without a
        // special recovery branch.
        await accountingStore.acceptProposals(activeSourceId, listedAccounting);
        const segmentsById = new Map(validatedSourceSegments.map((segment) => [segment.id, segment]));
        await accountingStore.recordBatchReview({
          source,
          structure: accountingStructure,
          batchId: compilerBatchId,
          reviews: input.reviewed_segments.map((review) => {
            const segment = segmentsById.get(review.segment_id);
            if (!segment) throw new Error(`Reviewed segment ${review.segment_id} is not in the validated source manifest.`);
            return { segment, disposition: review.disposition, summary: review.summary };
          }),
          evidenceAssertions: prospectiveCoverage.assertions,
          annotations: prospectiveCoverage.annotations,
          unitDecisions: activeAccountingDecisions,
          sourceBytes: accountingBytes,
        });
      }
      finished = true;
      return {
        content: [{ type: "text" as const, text: `Compiler batch explicitly finished (${input.outcome}).` }],
        details: { compilerBatchFinished: true, outcome: input.outcome, proposalIds: expected, reviewedSegmentIds: reviewedIds },
        terminate: true,
      };
    },
  });
  return {
    tools: [
      configureChapterSplitTool,
      novelTitleTool,
      ...retrievalTools,
      peekAdjacentTool,
      deferBoundaryTool,
      ...proposalTools,
      ...annotationProposalTools,
      identityResolutionTool,
      eventResolutionTool,
      accountSourceUnitsTool,
      withdrawTool,
      replaceBoundaryTool,
      finishTool,
    ],
    async beginBatch(segmentIds = [], nextCompilerBatchId?: string, sourceId?: string) {
      successfulProposalIds.clear();
      successfulAnnotationProposalIds.clear();
      successfulEntityResolutionProposalIds.clear();
      successfulEventResolutionProposalIds.clear();
      successfulAccountingProposalIds.clear();
      issuedAccountingPages.clear();
      peekedDirections.clear();
      expectedSegmentIds = [...new Set(segmentIds)].sort();
      boundedSliceSegments = [];
      validatedSourceSegments = [];
      compilerBatchId = nextCompilerBatchId;
      activeSourceId = sourceId;
      activeBoundaryCalibration = undefined;
      pendingChapterSplitPlan = undefined;
      pendingNovelTitleProposal = undefined;
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
      if (activeSourceId) {
        const source = await (await WorkspaceStore.create(workspaceRoot)).getSource(activeSourceId);
        if (!source) throw new Error(`Unknown active compiler source: ${activeSourceId}`);
        const [persistedManifest, derivedManifest] = await Promise.all([
          new SegmentStore(workspaceRoot).readManifest(activeSourceId),
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
        const source = await (await WorkspaceStore.create(workspaceRoot)).getSource(activeSourceId);
        const pendingTitle = sourceTitleProposalSchema.safeParse(source?.pendingTitleProposal);
        if (pendingTitle.success && pendingTitle.data.generatedBy.compilerBatchId === compilerBatchId) {
          pendingNovelTitleProposal = pendingTitle.data;
        }
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
      const migratedSceneBatchId = legacyExecutableSceneBatchId(compilerBatchId, activeSourceId);
      for (const summary of await service.store.list("pending")) {
        const envelope = await service.store.readEnvelope("pending", summary.id);
        const origin = envelope.generatedBy;
        const originBatchId = origin && typeof origin === "object" && !Array.isArray(origin)
          && typeof (origin as Record<string, unknown>).compilerBatchId === "string"
          ? (origin as Record<string, unknown>).compilerBatchId as string
          : undefined;
        if (originBatchId === compilerBatchId
          || (summary.kind === "scene-occurrence" && originBatchId === migratedSceneBatchId)) {
          successfulProposalIds.add(summary.id);
        }
      }
      if (activeSourceId) {
        for (const summary of await annotationStore.listBatchProposals(activeSourceId, compilerBatchId)) {
          if (successfulProposalIds.has(summary.id)) {
            throw new Error(`Compiler batch ${compilerBatchId} reuses proposal ID ${summary.id} across world and annotation stores.`);
          }
          successfulAnnotationProposalIds.add(summary.id);
        }
        for (const summary of await entityResolutionStore.listRecoverableBatchProposals(activeSourceId, compilerBatchId)) {
          if (successfulProposalIds.has(summary.id) || successfulAnnotationProposalIds.has(summary.id)) {
            throw new Error(`Compiler batch ${compilerBatchId} reuses proposal ID ${summary.id} across proposal stores.`);
          }
          successfulEntityResolutionProposalIds.add(summary.id);
        }
        for (const summary of await eventResolutionStore.listRecoverableBatchProposals(activeSourceId, compilerBatchId)) {
          if (successfulProposalIds.has(summary.id)
            || successfulAnnotationProposalIds.has(summary.id)
            || successfulEntityResolutionProposalIds.has(summary.id)) {
            throw new Error(`Compiler batch ${compilerBatchId} reuses proposal ID ${summary.id} across proposal stores.`);
          }
          successfulEventResolutionProposalIds.add(summary.id);
        }
        for (const summary of await accountingStore.listBatchProposals(activeSourceId, compilerBatchId)) {
          if (successfulProposalIds.has(summary.id)
            || successfulAnnotationProposalIds.has(summary.id)
            || successfulEntityResolutionProposalIds.has(summary.id)
            || successfulEventResolutionProposalIds.has(summary.id)) {
            throw new Error(`Compiler batch ${compilerBatchId} reuses proposal ID ${summary.id} across proposal stores.`);
          }
          successfulAccountingProposalIds.add(summary.id);
        }
      }
    },
  };
}

function byteRangeCoveredBySegments(
  startByte: number,
  endByte: number,
  segments: ReadonlyArray<Pick<SourceSegment, "startByte" | "endByte">>,
): boolean {
  const ranges = segments
    .map((segment) => ({
      startByte: Math.max(startByte, segment.startByte),
      endByte: Math.min(endByte, segment.endByte),
    }))
    .filter((range) => range.endByte > range.startByte)
    .sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte);
  let cursor = startByte;
  for (const range of ranges) {
    if (range.startByte > cursor) return false;
    cursor = Math.max(cursor, range.endByte);
    if (cursor >= endByte) return true;
  }
  return false;
}

function byteRangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
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

import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import type {
  ExtensionFactory,
  ToolDefinition,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

export const NWH_TOOL_RECOVERY_VERSION = 1;
export const NWH_TOOL_RECOVERY_MARKER = "<nwh-tool-recovery>";
const NWH_TOOL_RECOVERY_END_MARKER = "</nwh-tool-recovery>";

export type NwhToolRecoveryCategory =
  | "lookup-miss"
  | "invalid-arguments"
  | "invalid-offset"
  | "duplicate-submission"
  | "scope-or-lifecycle"
  | "budget-or-circuit-breaker"
  | "host-repair-required"
  | "unexpected-failure";

export type NwhToolRecoveryAdvice = {
  version: typeof NWH_TOOL_RECOVERY_VERSION;
  failedTool: string;
  category: NwhToolRecoveryCategory;
  retryable: boolean;
  retryCondition: string;
  steps: string[];
  suggestedCall?: {
    tool: string;
    arguments: Record<string, unknown>;
  };
};

export type NwhToolRecoveryScope = {
  activeToolNames: readonly string[];
};

type NwhToolResultRecovery = {
  content?: ToolResultEvent["content"];
  details?: unknown;
  isError?: boolean;
};

type LookupRecovery = {
  finder: string;
  arguments: Record<string, unknown>;
  resultField: "path" | "ref" | "unitId" | "pageToken";
};

const LOOKUP_RECOVERY: Readonly<Record<string, LookupRecovery>> = Object.freeze({
  read_file: {
    finder: "list_files",
    arguments: { pattern: "<distinctive path fragment>" },
    resultField: "path",
  },
  read_actor_context: {
    finder: "find_actor_context",
    arguments: { query: "*", max_results: 20 },
    resultField: "ref",
  },
  read_related_message: {
    finder: "find_related_messages",
    arguments: { query: "*", max_results: 20 },
    resultField: "ref",
  },
  read_compiler_artifact: {
    finder: "find_compiler_artifacts",
    arguments: { query: "*", max_results: 20 },
    resultField: "ref",
  },
  read_source_evidence: {
    finder: "find_source_evidence",
    arguments: { query: "*", max_results: 20 },
    resultField: "ref",
  },
  read_runtime_source_evidence: {
    finder: "find_runtime_source_evidence",
    arguments: { query: "*", max_results: 20 },
    resultField: "ref",
  },
  read_source_annotation: {
    finder: "find_source_annotations",
    arguments: { query: "*", max_results: 20 },
    resultField: "ref",
  },
  read_identity_resolution: {
    finder: "find_identity_resolutions",
    arguments: { query: "*", max_results: 20 },
    resultField: "ref",
  },
  read_event_resolution: {
    finder: "find_event_resolutions",
    arguments: { query: "*", max_results: 20 },
    resultField: "ref",
  },
  account_source_units: {
    finder: "find_source_accounting_units",
    arguments: { status: "unresolved", offset: 0, max_results: 20 },
    resultField: "pageToken",
  },
});

const CAPTURE_ONLY_TOOLS = new Set([
  "attach_canonical_scaffold",
  "propose_actor_action",
  "propose_literary_style_analysis",
  "propose_npc_reaction",
  "propose_player_action",
  "propose_player_choices",
  "propose_player_world_resolution",
  "propose_runtime_context_supplement",
  "request_player_context",
  "propose_scene_dramaturgy",
  "select_player_world_response",
]);

const COMPILER_PROPOSAL_TOOLS = new Set([
  "account_source_units",
  "configure_chapter_split",
  "defer_boundary_artifact",
  "finish_compiler_batch",
  "propose_attribution",
  "propose_canonical_event",
  "propose_character_goal",
  "propose_character_model",
  "propose_claim",
  "propose_discourse_segment",
  "propose_entity",
  "propose_entity_mention",
  "propose_entity_resolution",
  "propose_event_mention",
  "propose_event_participation",
  "propose_event_relation",
  "propose_scene_occurrence",
  "propose_event_frame",
  "propose_action_schema",
  "propose_event_execution",
  "propose_event_resolution",
  "propose_initial_world",
  "propose_novel_title",
  "propose_possibility",
  "propose_proposition",
  "propose_quotation",
  "propose_spatial_relation",
  "propose_state_delta",
  "propose_world_rule",
  "replace_boundary_proposal",
  "withdraw_compiler_proposal",
]);

const WRAPPED_TOOL = Symbol.for("novel-world-harness.tool-recovery-wrapped");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasNwhToolRecovery(value: string): boolean {
  return value.includes(`\n${NWH_TOOL_RECOVERY_MARKER}\n`)
    && value.trimEnd().endsWith(NWH_TOOL_RECOVERY_END_MARKER);
}

function lookupMiss(lower: string): boolean {
  return /\b(?:unknown|missing|stale)\b/u.test(lower)
    || /\bnot found\b|\bdoes not exist\b|\bno longer exists\b|\bno such file\b|\benoent\b/u.test(lower)
    || /\bnot (?:available|discoverable|registered)\b/u.test(lower);
}

function lookupAdvice(toolName: string, lower: string): NwhToolRecoveryAdvice | undefined {
  const direct = LOOKUP_RECOVERY[toolName];
  if (direct) {
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "lookup-miss",
      retryable: true,
      retryCondition: `Retry only after ${direct.finder} returns a current result in the same active scope.`,
      steps: [
        `Call ${direct.finder} with a distinctive query, or use the bounded '*' index shown in suggestedCall.`,
        `Copy the exact ${direct.resultField} from that result; do not guess, normalize, or reuse a stale opaque identifier.`,
        `Retry ${toolName} once with the refreshed ${direct.resultField}.`,
        "If discovery returns no match, stop and report the missing record; never invent an identifier or broaden the trust scope.",
      ],
      suggestedCall: { tool: direct.finder, arguments: direct.arguments },
    };
  }

  if (toolName === "find_entity_resolution_candidates") {
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "lookup-miss",
      retryable: true,
      retryCondition: "Retry only after refreshing the active source's entity-mention IDs.",
      steps: [
        "Call find_source_annotations for entity mentions in the same active source.",
        "Copy the exact annotationId into mention_id; a source-annotation ref and a mention ID are not interchangeable.",
        `Retry ${toolName} once. If the mention is absent, stop and do not invent it.`,
      ],
      suggestedCall: {
        tool: "find_source_annotations",
        arguments: { query: "*", annotation_type: "entity-mention", max_results: 20 },
      },
    };
  }

  if (toolName === "find_event_resolution_candidates") {
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "lookup-miss",
      retryable: true,
      retryCondition: "Retry only after refreshing the active source's event-mention IDs.",
      steps: [
        "Call find_source_annotations for event mentions in the same active source.",
        "Copy the exact annotationId into event_mention_id; a source-annotation ref and an event-mention ID are not interchangeable.",
        `Retry ${toolName} once. If the mention is absent, stop and do not invent it.`,
      ],
      suggestedCall: {
        tool: "find_source_annotations",
        arguments: { query: "*", annotation_type: "event-mention", max_results: 20 },
      },
    };
  }

  if (CAPTURE_ONLY_TOOLS.has(toolName)) {
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "lookup-miss",
      retryable: true,
      retryCondition: "Retry only when the exact opaque handle is present in the current isolated prompt or supplied context.",
      steps: [
        "Re-read the current request's offered options and actor-visible handles; do not search outside this isolated context.",
        "Copy the exact offered ID into the matching field without translating or normalizing it.",
        `Retry ${toolName} once. If no matching option was supplied, choose the tool's explicit none/unresolved form when available or stop.`,
      ],
    };
  }

  if (COMPILER_PROPOSAL_TOOLS.has(toolName)) {
    if (/evidence[_ -]?segment/u.test(lower)) {
      return {
        version: NWH_TOOL_RECOVERY_VERSION,
        failedTool: toolName,
        category: "lookup-miss",
        retryable: true,
        retryCondition: "Retry only with a host-issued evidence segment ID from the current bounded compiler slice.",
        steps: [
          "Re-read the current <source-segment id=...> blocks or the evidence retrieval result in this compiler turn.",
          "Copy the exact segment ID into evidence_segment_ids; do not submit a source path, hash, raw EvidenceRef, or an ID from another batch.",
          `Retry ${toolName} once. If the needed segment is outside the supplied slice, defer/report the boundary instead of widening scope.`,
        ],
      };
    }
    if (/mention/u.test(lower) && toolName === "propose_entity_resolution") {
      return {
        version: NWH_TOOL_RECOVERY_VERSION,
        failedTool: toolName,
        category: "lookup-miss",
        retryable: true,
        retryCondition: "Retry only after the entity mention is found in the active source and its lexical candidates are refreshed.",
        steps: [
          "Use find_source_annotations to refresh the entity-mention ID, then call find_entity_resolution_candidates with that exact ID.",
          "Copy only IDs returned in the same active source; do not infer identity from spelling alone.",
          `Retry ${toolName} once, or preserve unresolved/ambiguous status when evidence does not decide identity.`,
        ],
        suggestedCall: {
          tool: "find_source_annotations",
          arguments: { query: "*", annotation_type: "entity-mention", max_results: 20 },
        },
      };
    }
    if (/mention/u.test(lower) && toolName === "propose_event_resolution") {
      return {
        version: NWH_TOOL_RECOVERY_VERSION,
        failedTool: toolName,
        category: "lookup-miss",
        retryable: true,
        retryCondition: "Retry only after the event mention is found in the active source and its candidates are refreshed.",
        steps: [
          "Use find_source_annotations to refresh the event-mention ID, then call find_event_resolution_candidates with that exact ID.",
          "Copy only IDs returned in the same active source; similar wording is not proof of event coreference.",
          `Retry ${toolName} once, or preserve unresolved/ambiguous status when evidence does not decide identity.`,
        ],
        suggestedCall: {
          tool: "find_source_annotations",
          arguments: { query: "*", annotation_type: "event-mention", max_results: 20 },
        },
      };
    }
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "lookup-miss",
      retryable: true,
      retryCondition: "Retry only after refreshing the referenced source-scoped artifact or active proposal ID.",
      steps: [
        "Call find_compiler_artifacts with the missing logical name/ID and the narrowest known kind/status.",
        "Read the selected artifact when its exact payload matters, then copy the returned logicalId/proposalId into the matching payload field; do not use the read ref as a domain ID.",
        "If the dependency is genuinely new in this batch, submit that dependency first with a unique proposal_id.",
        `Retry ${toolName} once. If no source-scoped dependency exists, stop or preserve unresolved semantics rather than inventing one.`,
      ],
      suggestedCall: {
        tool: "find_compiler_artifacts",
        arguments: { query: "*", max_results: 20 },
      },
    };
  }

  return undefined;
}

export function buildNwhToolRecoveryAdvice(
  toolName: string,
  errorText: string,
  scope?: NwhToolRecoveryScope,
): NwhToolRecoveryAdvice {
  // Thrown tool errors may already contain host recovery instructions. Classify
  // only the original diagnostic, never words such as "offset" in that SOP.
  errorText = errorText.split(NWH_TOOL_RECOVERY_MARKER, 1)[0]!;
  // Pi schema errors echo model arguments after the diagnostic. Those values
  // can contain arbitrary novel wording, including "unknown" or "offset".
  errorText = errorText.split(/\r?\n\r?\nReceived arguments:\r?\n/u, 1)[0]!;
  const lower = errorText.normalize("NFKC").toLocaleLowerCase();

  if (lower.startsWith("compiler proposal obligation requires host review")) {
    return {
      version: NWH_TOOL_RECOVERY_VERSION, failedTool: toolName, category: "host-repair-required", retryable: false,
      retryCondition: "Do not retry in this or a fresh session until host adjudication.",
      steps: ["Stop and retain the exact diagnostic and all valid drafts. The host must inspect the persisted attempt and its evidence before adjudicating; changing IDs, withdrawing unrelated work, or restarting cannot resolve it."],
    };
  }

  if (toolName === "finish_compiler_batch" && lower.startsWith("unresolved compiler proposal obligations")) {
    return {
      version: NWH_TOOL_RECOVERY_VERSION, failedTool: toolName, category: "scope-or-lifecycle",
      retryable: true,
      retryCondition: "Retry finish only after every named durable obligation is resolved; unchanged finish and fresh sessions cannot clear failures.",
      steps: [
        "Copy each exact tool and proposal_id from the diagnostic. Recheck all selectors against the supplied citable segments, then make at most one corrected proposal retry under that same identity.",
        "If an ID is missing, use the same-scope discovery tool and copy its exact ref; never construct refs from logicalId or guess IDs. Do not widen the evidence scope.",
        "If evidence is absent, a call was interrupted, or the corrected attempt fails, stop for host review. Do not add unrelated proposals, withdraw accounting, or restart to erase the obligation.",
        "Preserve every valid draft. Retry finish once only after actual resolution; if it still fails with the same diagnostic, stop.",
      ],
    };
  }

  if (/tool-call budget|tool call budget|tool-call safety fuse|circuit breaker|circuit-breaker/u.test(lower)) {
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "budget-or-circuit-breaker",
      retryable: false,
      retryCondition: "Do not issue another tool call in this turn.",
      steps: [
        "Stop the current tool loop; do not probe the circuit breaker with a different call.",
        "Summarize the last validated progress and the exact unresolved item without claiming a checkpoint that did not occur.",
        "Resume in a fresh host-started batch/turn, then rediscover current IDs before continuing.",
      ],
    };
  }

  if (/only one .+ may be captured|already (?:finished|captured)|call this tool exactly once/u.test(lower)) {
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "scope-or-lifecycle",
      retryable: false,
      retryCondition: "The single-use sink or batch has already accepted its terminal call; do not call it again in this turn.",
      steps: [
        "Stop calling this tool in the current turn.",
        "Use the previously captured result and end the isolated call, or let the host start a fresh turn if a new capture is genuinely required.",
        "Do not try a new ID to bypass a single-use or finished-state guard.",
      ],
    };
  }

  if (/not an active successful submission|lost its active .+ identity/u.test(lower)) {
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "lookup-miss",
      retryable: true,
      retryCondition: "Retry only with the exact ID of a successful proposal that is still active in this compiler batch.",
      steps: [
        "Re-read successful proposal results and the current pending catalogs for the relevant proposal kind.",
        "Copy the exact proposal_id; do not substitute a logical artifact ID, retrieval ref, rejected proposal, or ID from another batch.",
        `Retry ${toolName} once. If the proposal is no longer active, stop instead of recreating it merely to satisfy this operation.`,
      ],
    };
  }

  if (/already used|duplicate .*(?:id|proposal)|reuses proposal id|already has .*active proposals/u.test(lower)) {
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "duplicate-submission",
      retryable: true,
      retryCondition: "Retry only after deciding whether to keep the existing successful draft or replace a genuinely defective one through the supported workflow.",
      steps: [
        "Do not resubmit the same proposal unchanged under another ID merely to bypass deduplication.",
        "If the existing draft is correct, keep it and continue/finish. If it is defective, withdraw or replace the exact active proposal through the narrow supported tool.",
        "Use a new unique proposal_id only for the corrected replacement, then retry once.",
      ],
    };
  }

  if (toolName === "finish_compiler_batch" && /source-accounting review disposition conflicts|inside a no-artifacts segment/u.test(lower)) {
    return { version: NWH_TOOL_RECOVERY_VERSION, failedTool: toolName, category: "invalid-arguments", retryable: true,
      retryCondition: "Retry finish once after correcting the review disposition; preserve all valid drafts.",
      steps: [
        "Set the named reviewed_segments.disposition fields to proposed. Existing exact source coverage and accounting decisions remain artifacts even when no new executable mechanism was induced.",
        "Retain the accounting pages and their per-unit decisions; do not mass-withdraw or reclassify the source as background to make finish pass.",
        "Retry finish_compiler_batch once with the corrected review fields. If the same diagnostic repeats, stop and report it. finish_compiler_batch has no offset argument.",
      ],
    };
  }

  const conflictingAccountingProposalIds = [...errorText.matchAll(
    /withdraw source-accounting proposal '([A-Za-z0-9][A-Za-z0-9._-]*)'/giu,
  )].map((match) => match[1]!);
  if (toolName === "finish_compiler_batch" && conflictingAccountingProposalIds.length) {
    const proposalIds = [...new Set(conflictingAccountingProposalIds)];
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "invalid-arguments",
      retryable: true,
      retryCondition: "Retry once only after withdrawing every exact conflicting accounting proposal named by the host and re-accounting any units that become unresolved.",
      steps: [
        `Call withdraw_compiler_proposal once for each exact proposal_id named in the diagnostic: ${proposalIds.join(", ")}. Do not guess a unit-to-proposal mapping.`,
        "Call find_source_accounting_units with status=unresolved, offset=0, and max_results=20; review and account each returned page, refetching from offset=0 after every successful proposal.",
        "Do not disposition represented units or units in no-artifacts segments; their host-derived states already account for them.",
        `Retry ${toolName} once after concrete withdrawal/accounting progress. If the same full diagnostic repeats, stop instead of looping.`,
      ],
      suggestedCall: {
        tool: "withdraw_compiler_proposal",
        arguments: {
          proposal_id: proposalIds[0]!,
          reason: "Recovered accounting dispositions conflict with host-derived source-unit states.",
        },
      },
    };
  }

  if (toolName === "finish_compiler_batch" && /source-unit accounting is incomplete/u.test(lower)) {
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "invalid-arguments",
      retryable: true,
      retryCondition: "Retry once only after every reported source unit has exact semantic coverage or a successful typed accounting proposal.",
      steps: [
        "Call find_source_accounting_units with status=unresolved, offset=0, and max_results=20 in the same active batch.",
        "Review every returned unit, then copy its exact pageToken into account_source_units with one page_default and only genuinely different page_overrides by exact returned unitIndex; never guess a token/index or label represented/non-scene units yourself.",
        "After each successful accounting proposal, refetch status=unresolved at offset=0 because the result set shrinks; repeat until units is empty instead of following a stale nextOffset.",
        "Keep unresolved or intentionally-deferred when the source cannot be decided honestly; those statuses remain publication blockers.",
        `Retry ${toolName} once after concrete accounting progress. If the same full diagnostic repeats, stop instead of looping.`,
      ],
      suggestedCall: {
        tool: "find_source_accounting_units",
        arguments: { status: "unresolved", offset: 0, max_results: 20 },
      },
    };
  }

  if (/offset|surrogate pair|unicode boundary|utf-?8 boundary/u.test(lower)) {
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "invalid-offset",
      retryable: true,
      retryCondition: "Retry only with offset=0 or the exact nextOffset returned by the immediately preceding page.",
      steps: [
        "Do not estimate character or byte offsets and do not increment them manually.",
        `Restart ${toolName} at offset 0 when the prior page token is unavailable; otherwise copy its exact nextOffset.`,
        "Retry once and continue paging only through returned nextOffset values.",
      ],
    };
  }

  if (/missing or stale|corrupt|collision|cycle detected|safety limit|source changed since ingest|re-ingest|reparse before|permission denied|eacces|unknown active (?:novel|compiler) source|exceed(?:s|ing) the .+ limit/u.test(lower)) {
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "host-repair-required",
      retryable: false,
      retryCondition: "Retry only after the host repairs or refreshes the underlying workspace state and starts a new turn.",
      steps: [
        "Stop model-side retries; changing an opaque ID cannot repair stale, corrupt, unsafe, or inaccessible host state.",
        "Report the exact diagnostic and follow any re-ingest/reparse/repair action already named in it.",
        "After host repair, rerun the paired discovery tool before reusing any prior ref or ID.",
      ],
    };
  }

  if (/outside (?:the )?active|outside an explicit|requires an active|unavailable (?:during|outside)|not permitted|tool .+ not found|tool execution was blocked/u.test(lower)) {
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "scope-or-lifecycle",
      retryable: false,
      retryCondition: "Do not retry this call in the current scope.",
      steps: [
        "Stop repeating the blocked tool name and inspect the tools explicitly active for this turn.",
        "Continue with the supplied evidence/context and an in-scope tool, or let the host open the required compiler/player phase.",
        "Never widen source, actor, or future-canon scope to make the call succeed.",
      ],
    };
  }

  const crossBatchSupersessions = [...errorText.matchAll(
    /CROSS_BATCH_LOGICAL_SUPERSESSION direction=(previous|next|unknown) prior='([A-Za-z0-9][A-Za-z0-9._-]*)' current='([A-Za-z0-9][A-Za-z0-9._-]*)'/gu,
  )].map((match) => ({
    direction: match[1] as "previous" | "next" | "unknown",
    priorProposalId: match[2]!,
    currentProposalId: match[3]!,
  }));
  if (toolName === "finish_compiler_batch" && crossBatchSupersessions.length) {
    const currentProposalIds = [...new Set(crossBatchSupersessions.map((item) => item.currentProposalId))];
    const priorProposalIds = [...new Set(crossBatchSupersessions.map((item) => item.priorProposalId))];
    const adjacentDirections = [...new Set(crossBatchSupersessions
      .map((item) => item.direction)
      .filter((direction): direction is "previous" | "next" => direction !== "unknown"))];
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "invalid-arguments",
      retryable: true,
      retryCondition: "Retry finish once only after removing the named current-batch replacements, repairing every one-sided current dependency, and queuing any confirmed adjacent artifact for the existing two-segment calibration workflow.",
      steps: [
        `Call withdraw_compiler_proposal for each named current-batch replacement: ${currentProposalIds.join(", ")}. Never try to withdraw the checkpointed prior proposal(s): ${priorProposalIds.join(", ")}.`,
        adjacentDirections.length
          ? `For each confirmed direction (${adjacentDirections.join(", ")}), call peek_adjacent_evidence once, then call defer_boundary_artifact in that direction with the exact prior proposal and dependent current artifact IDs. Only the queued boundary-calibration batch may call replace_boundary_proposal.`
          : "Read the prior proposal payloads and distinguish accidental logical-ID reuse from a genuinely adjacent semantic unit; use a distinct stable logical ID for a distinct artifact, or the peek/defer workflow when it crosses an immediate split.",
        "Before retrying finish, repair or withdraw every current-batch draft named by the full graph diagnostic that would otherwise leave a one-sided scene/event or other reciprocal link. Preserve unrelated valid drafts.",
        `Retry ${toolName} once after that concrete progress. If the same full diagnostic repeats, stop instead of attempting the prior proposal ID or looping.`,
      ],
      suggestedCall: {
        tool: "withdraw_compiler_proposal",
        arguments: {
          proposal_id: currentProposalIds[0]!,
          reason: "Ordinary source batches cannot replace a checkpointed cross-boundary proposal; defer it to boundary calibration.",
        },
      },
    };
  }

  const unknownAnnotationReferences = [...errorText.matchAll(
    /^-\s+([A-Za-z0-9][A-Za-z0-9._-]*):\s+([A-Za-z][A-Za-z0-9]*) references unknown annotation '([A-Za-z0-9][A-Za-z0-9._-]*)'/gmu,
  )].map((match) => ({
    proposalId: match[1]!,
    field: match[2]!,
    unknownAnnotationId: match[3]!,
  }));
  if (toolName === "finish_compiler_batch" && unknownAnnotationReferences.length) {
    const proposalIds = [...new Set(unknownAnnotationReferences.map((item) => item.proposalId))];
    const diagnosedReferences = unknownAnnotationReferences
      .map((item) => `${item.proposalId}.${item.field} -> ${item.unknownAnnotationId}`)
      .join(", ");
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "invalid-arguments",
      retryable: true,
      retryCondition: "Retry finish once only after correcting or withdrawing each specifically named dangling-reference proposal while preserving every unlisted active draft.",
      steps: [
        `Repair only the diagnosed proposals (${proposalIds.join(", ")}); the invalid references are ${diagnosedReferences}. Preserve every unlisted active proposal exactly as recorded.`,
        "Use the active-ID inventory in the finish diagnostic, or call find_source_annotations as suggested. Copy the exact returned annotationId into the failing reference field; never copy ref/proposalId or invent a prefix variant. For a dependency recorded in this turn, use the exact annotation_id from its successful proposal payload.",
        "Because active proposals are immutable, submit each corrected annotation under a new unique envelope proposal_id while preserving its stable annotation_id and evidence anchor, then withdraw only its exact defective proposal_id. If the optional relation is unsupported, omit it in the replacement or withdraw only that named invalid proposal.",
        `Retry ${toolName} once after concrete repair. Use outcome=complete whenever any active proposal remains; never mass-withdraw valid drafts or use no-artifacts to escape validation. If the same full diagnostic repeats, stop instead of looping.`,
      ],
      suggestedCall: {
        tool: "find_source_annotations",
        arguments: { query: "*", status: "pending", offset: 0, max_results: 200 },
      },
    };
  }

  const missingEntityNames = [...errorText.matchAll(
    /^-\s+Entity ([A-Za-z0-9][A-Za-z0-9._-]*) canonicalName '([^\r\n]*)' has no resolved source mention\.$/gmu,
  )].map((match) => ({ entityId: match[1]!, canonicalName: match[2]! }));
  if (toolName === "finish_compiler_batch" && missingEntityNames.length) {
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "invalid-arguments",
      retryable: true,
      retryCondition: "Retry finish once only after repairing every reported graph/trace section, including an exact-name identity resolution for each diagnosed entity.",
      steps: [
        `Repair these entity/name pairs: ${missingEntityNames.map((item) => `${item.entityId} -> ${JSON.stringify(item.canonicalName)}`).join(", ")}. Preserve unrelated valid drafts.`,
        "For each name, call find_source_annotations with annotation_type=entity-mention and query equal to that name (use * if the name exceeds the 500-character query limit). Omit status to search both committed and pending mentions; follow exact returned nextOffset values when paging. Copy the returned ref to read_source_annotation and inspect payload.surface, kindCandidates, and the source context. Copy annotationId, never ref/proposalId, as the mention_id; do not guess IDs.",
        "The trace requires surface === canonicalName, a compatible entity kind, and a selected resolution to the diagnosed entity. A substring or similar wording is insufficient: resolving a longer surface containing the name does not establish the exact canonicalName. An existing exact-name mention still needs identity resolution; creating another mention alone cannot repair this error.",
        "For a context-supported exact-name mention, call find_entity_resolution_candidates with its mention_id, inspect the returned mention.surface, and then call propose_entity_resolution, copying the source-supported candidate.entityId into entity_id and its resolutionMode into status. For a same-finish new entity use new-entity; resolved is for canonical/checkpointed identity. Lexical matches alone do not prove identity; do not force an unsupported link.",
        "If no suitable mention exists, inspect the immutable evidence before proposing an exact anchored mention. If the entity name itself is defective, submit a source-supported corrected entity proposal under a fresh envelope proposal_id while preserving its logical entity id, then withdraw only the defective current-batch proposal. Never alter mention text without a matching source anchor, duplicate an entity to bypass the guard, or withdraw checkpointed work.",
        "Include every successful repair in the finish handshake. Retry finish_compiler_batch once only after concrete proposal progress and all reported sections are repaired; do not use no-artifacts to escape validation. If the same full diagnostic repeats, stop instead of looping.",
      ],
      suggestedCall: {
        tool: "find_source_annotations",
        arguments: { query: missingEntityNames[0]!.canonicalName.length <= 500 ? missingEntityNames[0]!.canonicalName || "*" : "*", annotation_type: "entity-mention", offset: 0, max_results: 20 },
      },
    };
  }

  const unresolvedEventParticipants = [...errorText.matchAll(
    /Canonical event ([A-Za-z0-9][A-Za-z0-9._-]*) participant '([A-Za-z0-9][A-Za-z0-9._-]*)' at participants\.\d+ has no resolved participant mention in its event trace\./gu,
  )].map((match) => ({ eventId: match[1]!, entityId: match[2]! }));
  if (toolName === "finish_compiler_batch" && unresolvedEventParticipants.length) {
    const pairs = unresolvedEventParticipants.map((item) => `${item.eventId} -> ${item.entityId}`);
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "invalid-arguments",
      retryable: true,
      retryCondition: "Retry finish once only after every named canonical participant has a source mention in that event trace and that mention has a successful selected identity resolution.",
      steps: [
        `Repair each exact event/participant pair named by the host: ${pairs.join(", ")}. Preserve unrelated active proposals.`,
        "Call find_source_annotations for the affected event and participant surfaces and inspect every active event resolution's eventMentionIds plus each event mention's participantMentionIds. Reuse an exact existing entity mention ID when present; otherwise propose one exact evidence-backed entity mention in the event extent.",
        "If none of the resolved event mention(s) includes that entity mention ID, submit a corrected event-mention revision under a new envelope proposal_id while preserving its stable annotation_id, trigger, anchors, and other participants, and add the missing mention ID to participant_mention_ids. Creating an unreferenced entity mention alone cannot change the event trace.",
        "For every affected mention, call find_entity_resolution_candidates with that exact mention ID, then complete the sequence by calling propose_entity_resolution. Merely creating the mention or merely calling the finder does not select an identity and cannot close the event trace.",
        "The successful resolution must select the named canonical participant through the finder-authorized resolutionMode. If the finder does not authorize that identity, correct the canonical event participant or preserve the ambiguity; never guess or force the link.",
        `Only after all ${unresolvedEventParticipants.length} selected resolution(s) succeed, retry ${toolName} once. If the same diagnostic repeats, stop instead of looping.`,
      ],
      suggestedCall: {
        tool: "find_source_annotations",
        arguments: { query: "*", status: "pending", offset: 0, max_results: 200 },
      },
    };
  }

  if (toolName === "finish_compiler_batch" && /(?:graph|trace) is incomplete/u.test(lower)) {
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "invalid-arguments",
      retryable: true,
      retryCondition: "Retry once only after correcting every reported graph/trace section through successful propose, withdraw, or replace calls.",
      steps: [
        "Treat the complete finish diagnostic as one validation report; preserve valid drafts and correct each listed logical dependency or trace.",
        "For entity identity, call find_entity_resolution_candidates and follow its resolutionMode: resolved reuses canonical/checkpointed identity, while new-entity requires a same-finish entity proposal.",
        "Use source-scoped finder results only when an exact existing ID is genuinely missing; do not re-propose a checkpointed pending identity or guess a replacement ID.",
        `Retry ${toolName} once after concrete proposal progress. If the same full diagnostic repeats, stop instead of looping.`,
      ],
    };
  }

  const ambiguousQuoteSegment = /exact evidence quote is ambiguous in segment ([a-z0-9][a-z0-9._-]*): \d+ occurrences match\./iu.exec(errorText)?.[1];
  if (COMPILER_PROPOSAL_TOOLS.has(toolName) && ambiguousQuoteSegment) {
    const sourceRead = exactSourceRecovery(ambiguousQuoteSegment, scope);
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "invalid-arguments",
      retryable: true,
      retryCondition: "Retry once only after locating the intended occurrence in the named active-source segment.",
      steps: [
        ...sourceRead.steps,
        "Keep the intended exact quote and disambiguate it with verbatim surrounding prefix/suffix, or a one-based occurrence counted from the complete segment, never from an individual page. Do not guess which occurrence supports this annotation.",
        "This failed selector did not create the proposed annotation. Correct the selector and retain the intended logical annotation ID; do not create new logical IDs or withdraw dependent supported annotations to bypass ambiguity.",
        `Retry ${toolName} once after that correction. If the intended occurrence cannot be identified or the same diagnostic repeats, stop and report the unresolved selector.`,
      ],
      ...(sourceRead.suggestedCall ? { suggestedCall: sourceRead.suggestedCall } : {}),
    };
  }

  const exactQuoteSegment = /exact evidence quote was not found in segment ([a-z0-9][a-z0-9._-]*?)(?: with the supplied context)?\./iu.exec(errorText)?.[1];
  if (COMPILER_PROPOSAL_TOOLS.has(toolName) && exactQuoteSegment) {
    const sourceRead = exactSourceRecovery(exactQuoteSegment, scope);
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "lookup-miss",
      retryable: true,
      retryCondition: "Retry once only after reading the named active-source segment and copying the selector text verbatim.",
      steps: [
        ...sourceRead.steps,
        "Repair every reported selector in the complete diagnostic, not just the first. Copy the intended non-empty substring verbatim into the failing evidence selector's exact field; do not copy JSON escaping from the prompt or normalize punctuation/whitespace.",
        `Retry ${toolName} once after changing that selector. If the intended wording is absent after reading the complete segment, remove/reframe the unsupported field or stop; never guess another quote.`,
      ],
      ...(sourceRead.suggestedCall ? { suggestedCall: sourceRead.suggestedCall } : {}),
    };
  }

  if (toolName === "propose_event_execution" && /validation|schema-bound|compiled mechanism|evidence_segment_ids|additional propert/u.test(lower)) {
    if (scope && (!scope.activeToolNames.includes("find_compiler_artifacts") || !scope.activeToolNames.includes("read_compiler_artifact"))) {
      return { version: NWH_TOOL_RECOVERY_VERSION, failedTool: toolName, category: "scope-or-lifecycle", retryable: false,
        retryCondition: "Mechanism discovery is unavailable in this scope. Resume only in a host-started compiler turn with the required source-scoped discovery tools.",
        steps: ["Preserve the original validation diagnostic and valid drafts. Do not guess a schema ID, call unavailable tools, or relabel an ad-hoc action to bypass the contract."] };
    }
    return {
      version: NWH_TOOL_RECOVERY_VERSION, failedTool: toolName, category: "invalid-arguments", retryable: true,
      retryCondition: "One corrected retry only after fixing the envelope and using a source-supported compiled mechanism or complete entry checkpoint.",
      steps: [
        "Place proposal_id, payload, evidence_segment_ids and evidence_selectors beside each other in the outer argument object; never nest evidence_segment_ids/evidence_selectors inside payload.",
        "An action binding requires action.lane=schema-bound; never copy an event's ad-hoc action or relabel it without a real mechanism.",
        "Call find_compiler_artifacts with kind=action-schema in the same active source. Copy its returned ref into read_compiler_artifact, then copy the read payload.id into action.schemaId and use its exact role IDs. A retrieval ref is not a schema ID.",
        "If no supported schema exists, propose one only when source evidence satisfies the induction contract; otherwise preserve the occurrence without an action binding. Use entryCheckpoint only for a separately supported complete embodied entry, never to bypass a missing mechanism.",
        "Retry once after concrete correction. If the same diagnostic repeats, stop and report it; never guess schema IDs or submit unchanged proposals.",
      ],
      suggestedCall: { tool: "find_compiler_artifacts", arguments: { kind: "action-schema", query: "*", max_results: 20 } },
    };
  }

  if (lookupMiss(lower)) {
    const advice = lookupAdvice(toolName, lower);
    if (advice) return advice;
  }

  if (/valid json|invalid json|validation failed|invalid argument|unsupported|incomplete|failed .+ validation|must (?:be|contain|equal|match|omit|target|use)|requires? /u.test(lower)) {
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "invalid-arguments",
      retryable: true,
      retryCondition: "Retry only after correcting the named field/path against the current tool schema.",
      steps: [
        "Read the first validation path and constraint in the error; change the smallest responsible field instead of rewriting unrelated valid data.",
        "Submit one JSON object with the documented field names and enum values; do not wrap the entire argument object or nested payload in an invalid JSON string.",
        `Retry ${toolName} once with corrected arguments. If the same diagnostic repeats, stop and report the path plus attempted correction.`,
      ],
    };
  }

  return {
    version: NWH_TOOL_RECOVERY_VERSION,
    failedTool: toolName,
    category: "unexpected-failure",
    retryable: true,
    retryCondition: "Retry only when the original diagnostic identifies a concrete argument or current-state correction.",
    steps: [
      "Do not repeat the same call unchanged.",
      "Use an available read-only discovery tool to verify relevant paths, refs, IDs, and active scope before changing arguments.",
      `Retry ${toolName} at most once after a concrete correction; if none is possible or the same failure repeats, stop and surface the exact blocker.`,
    ],
  };
}

function exactSourceRecovery(segmentId: string, scope: NwhToolRecoveryScope | undefined): Pick<NwhToolRecoveryAdvice, "steps" | "suggestedCall"> {
  if (scope?.activeToolNames.includes("read_source_evidence")) {
    return {
      steps: [
        `Call read_source_evidence with ref source-segment:${segmentId}, offset=0, and max_chars=120000. Continue pages only with the exact returned nextOffset.`,
        "Use the returned chunk as verbatim source text and copy its evidence_segment_id into segment_id.",
      ],
      suggestedCall: {
        tool: "read_source_evidence",
        arguments: { ref: `source-segment:${segmentId}`, offset: 0, max_chars: 120_000 },
      },
    };
  }
  return {
    steps: [
      `Re-read the complete host-supplied <source-segment id="${segmentId}"> block in the current prompt and copy that exact id into segment_id.`,
      "Use only the supplied segment text. If the complete named segment is unavailable, stop and report the missing evidence to the host; do not call unavailable retrieval tools or widen the source slice.",
    ],
  };
}

export function formatNwhToolError(toolName: string, error: unknown, scope?: NwhToolRecoveryScope): string {
  const message = errorMessage(error);
  if (hasNwhToolRecovery(message)) return message;
  const advice = buildNwhToolRecoveryAdvice(toolName, message, scope);
  return `${message}\n\n${NWH_TOOL_RECOVERY_MARKER}\n${JSON.stringify(advice, null, 2)}\n${NWH_TOOL_RECOVERY_END_MARKER}`;
}

export function actionableToolError(toolName: string, error: unknown, scope?: NwhToolRecoveryScope): Error {
  const original = error instanceof Error ? error : undefined;
  if (original && hasNwhToolRecovery(original.message)) return original;
  const wrapped = new Error(formatNwhToolError(toolName, error, scope), original ? { cause: original } : undefined);
  wrapped.name = "NwhActionableToolError";
  return wrapped;
}

function toolResultWasBlocked(details: unknown): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  return Object.entries(details).some(([key, value]) => value === true && /blocked$/iu.test(key));
}

function toolResultErrorText(event: ToolResultEvent): string {
  const text = event.content
    .flatMap((item) => item.type === "text" ? [item.text] : [])
    .join("\n")
    .trim();
  return text || `Tool '${event.toolName}' reported a failure without a textual diagnostic.`;
}

/** Add recovery metadata to both thrown failures and terminate=true blocked results. */
export function recoverNwhToolResult(event: ToolResultEvent, scope?: NwhToolRecoveryScope): NwhToolResultRecovery | undefined {
  const blocked = toolResultWasBlocked(event.details);
  if (!event.isError && !blocked) return undefined;
  const message = toolResultErrorText(event);
  const advice = buildNwhToolRecoveryAdvice(event.toolName, message, scope);
  const content = hasNwhToolRecovery(message)
    ? event.content
    : [
        ...event.content,
        {
          type: "text" as const,
          text: `${NWH_TOOL_RECOVERY_MARKER}\n${JSON.stringify(advice, null, 2)}\n${NWH_TOOL_RECOVERY_END_MARKER}`,
        },
      ];
  const existingDetails = event.details && typeof event.details === "object" && !Array.isArray(event.details)
    ? event.details as Record<string, unknown>
    : {};
  return {
    content,
    details: { ...existingDetails, nwhToolRecovery: advice },
    isError: true,
  };
}

/** Always-on adapter, including isolated sessions that disable the main NWH extension. */
export function createNwhToolRecoveryExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("tool_result", (event) => recoverNwhToolResult(event, { activeToolNames: pi.getActiveTools() }));
  };
}

function isAbortFailure(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /\b(?:aborted|cancelled)\b/iu.test(error.message);
}

/**
 * Preserve Pi's error status while ensuring every NWH model-facing tool failure
 * carries bounded, actionable recovery guidance. Validation is performed here
 * as a preflight so schema failures receive the same guidance as execute-time
 * failures; Pi still performs its authoritative validation afterwards.
 */
export function withNwhToolRecovery(tool: ToolDefinition, getScope?: () => NwhToolRecoveryScope): ToolDefinition {
  if ((tool as unknown as { [WRAPPED_TOOL]?: boolean })[WRAPPED_TOOL]) return tool;
  const originalPrepare = tool.prepareArguments;
  const prepareArguments: NonNullable<ToolDefinition["prepareArguments"]> = (raw: unknown) => {
    try {
      const prepared = originalPrepare ? originalPrepare(raw) : raw;
      return validateToolArguments(tool, {
        type: "toolCall",
        id: "nwh-tool-recovery-preflight",
        name: tool.name,
        arguments: prepared as Record<string, unknown>,
      } satisfies ToolCall) as never;
    } catch (error) {
      throw actionableToolError(tool.name, error, getScope?.());
    }
  };
  const execute: ToolDefinition["execute"] = async (toolCallId, params, signal, onUpdate, context) => {
    try {
      return await tool.execute(toolCallId, params, signal, onUpdate, context);
    } catch (error) {
      if (isAbortFailure(error, signal)) throw error;
      throw actionableToolError(tool.name, error, getScope?.());
    }
  };
  const wrapped: ToolDefinition = {
    ...tool,
    prepareArguments,
    execute,
  };
  Object.defineProperty(wrapped, WRAPPED_TOOL, { value: true });
  return wrapped;
}

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
    arguments: { status: "unresolved", offset: 0, max_results: 200 },
    resultField: "pageToken",
  },
});

const CAPTURE_ONLY_TOOLS = new Set([
  "attach_canonical_scaffold",
  "propose_literary_style_analysis",
  "propose_npc_reaction",
  "propose_player_action",
  "propose_player_choices",
  "propose_player_world_resolution",
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
): NwhToolRecoveryAdvice {
  const lower = errorText.normalize("NFKC").toLocaleLowerCase();

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

  if (toolName === "finish_compiler_batch" && /source-unit accounting is incomplete/u.test(lower)) {
    return {
      version: NWH_TOOL_RECOVERY_VERSION,
      failedTool: toolName,
      category: "invalid-arguments",
      retryable: true,
      retryCondition: "Retry once only after every reported source unit has exact semantic coverage or a successful typed accounting proposal.",
      steps: [
        "Call find_source_accounting_units with status=unresolved, offset=0, and max_results=200 in the same active batch.",
        "Review every returned unit, then copy its exact pageToken into account_source_units with one page_default and only genuinely different page_overrides by exact returned unitIndex; never guess a token/index or label represented/non-scene units yourself.",
        "After each successful accounting proposal, refetch status=unresolved at offset=0 because the result set shrinks; repeat until units is empty instead of following a stale nextOffset.",
        "Keep unresolved or intentionally-deferred when the source cannot be decided honestly; those statuses remain publication blockers.",
        `Retry ${toolName} once after concrete accounting progress. If the same full diagnostic repeats, stop instead of looping.`,
      ],
      suggestedCall: {
        tool: "find_source_accounting_units",
        arguments: { status: "unresolved", offset: 0, max_results: 200 },
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

export function formatNwhToolError(toolName: string, error: unknown): string {
  const message = errorMessage(error);
  if (hasNwhToolRecovery(message)) return message;
  const advice = buildNwhToolRecoveryAdvice(toolName, message);
  return `${message}\n\n${NWH_TOOL_RECOVERY_MARKER}\n${JSON.stringify(advice, null, 2)}\n${NWH_TOOL_RECOVERY_END_MARKER}`;
}

export function actionableToolError(toolName: string, error: unknown): Error {
  const original = error instanceof Error ? error : undefined;
  if (original && hasNwhToolRecovery(original.message)) return original;
  const wrapped = new Error(formatNwhToolError(toolName, error), original ? { cause: original } : undefined);
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
export function recoverNwhToolResult(event: ToolResultEvent): NwhToolResultRecovery | undefined {
  const blocked = toolResultWasBlocked(event.details);
  if (!event.isError && !blocked) return undefined;
  const message = toolResultErrorText(event);
  const advice = buildNwhToolRecoveryAdvice(event.toolName, message);
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
    pi.on("tool_result", (event) => recoverNwhToolResult(event));
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
export function withNwhToolRecovery(tool: ToolDefinition): ToolDefinition {
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
      throw actionableToolError(tool.name, error);
    }
  };
  const execute: ToolDefinition["execute"] = async (toolCallId, params, signal, onUpdate, context) => {
    try {
      return await tool.execute(toolCallId, params, signal, onUpdate, context);
    } catch (error) {
      if (isAbortFailure(error, signal)) throw error;
      throw actionableToolError(tool.name, error);
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

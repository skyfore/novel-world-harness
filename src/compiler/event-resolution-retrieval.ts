import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { promptJson } from "../util/prompt-data.js";
import { assertSafeTextOffset, safeTextPageEnd } from "../util/text-pages.js";
import {
  EventResolutionStore,
  generateEventResolutionCandidates,
  type EventResolution,
} from "./event-resolution.js";
import type { CompilerToolCallGate } from "./tool-call-gate.js";
import {
  COMPILER_RETRIEVAL_MAX_FIND_RESULTS as MAX_FIND_RESULTS,
  COMPILER_RETRIEVAL_MAX_READ_CHARS as MAX_READ_CHARS,
} from "./limits.js";

export const EVENT_RESOLUTION_RETRIEVAL_TOOL_NAMES = [
  "find_event_resolution_candidates",
  "find_event_resolutions",
  "read_event_resolution",
] as const;

type EventResolutionRecord = {
  ref: string;
  status: "current" | "pending";
  resolutionId: string;
  eventMentionIds: string[];
  resolutionStatus: EventResolution["status"];
  proposalId?: string;
  payload: EventResolution;
};

const MAX_RESOLUTION_RECORDS = 100_000;

export async function loadEventResolutionRecords(
  workspaceRoot: string,
  sourceId: string,
): Promise<EventResolutionRecord[]> {
  const store = new EventResolutionStore(workspaceRoot);
  const [current, pending] = await Promise.all([
    store.list(sourceId),
    store.listProposals(sourceId, "pending"),
  ]);
  const records: EventResolutionRecord[] = current.map((resolution) => ({
    ref: `current:${resolution.id}`,
    status: "current",
    resolutionId: resolution.id,
    eventMentionIds: structuredClone(resolution.eventMentionIds),
    resolutionStatus: resolution.status,
    payload: resolution,
  }));
  for (const summary of pending) {
    const proposal = await store.readProposal(sourceId, "pending", summary.id);
    records.push({
      ref: `pending:${proposal.id}`,
      status: "pending",
      resolutionId: proposal.payload.id,
      eventMentionIds: structuredClone(proposal.payload.eventMentionIds),
      resolutionStatus: proposal.payload.status,
      proposalId: proposal.id,
      payload: proposal.payload,
    });
  }
  if (records.length > MAX_RESOLUTION_RECORDS) {
    throw new Error(`Source ${sourceId} has ${records.length} event resolutions, exceeding the ${MAX_RESOLUTION_RECORDS}-record safety limit.`);
  }
  return records.sort((left, right) => left.eventMentionIds[0]!.localeCompare(right.eventMentionIds[0]!)
    || left.status.localeCompare(right.status)
    || left.resolutionId.localeCompare(right.resolutionId));
}

export function createEventResolutionRetrievalTools(
  workspaceRoot: string,
  getSourceId: () => string | undefined,
  getCompilerBatchId: () => string | undefined,
  beforeCall?: CompilerToolCallGate,
): ToolDefinition[] {
  const candidateParameters = Type.Object({
    event_mention_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  }, { additionalProperties: false });
  const candidates = defineTool({
    name: "find_event_resolution_candidates",
    label: "Find event resolution candidates",
    description: "Generate deterministic source-scoped event candidates from exact evidence overlap, title/trigger text, and resolved participant overlap.",
    promptSnippet: "Generate host-ranked candidates before proposing event identity",
    promptGuidelines: [
      "Candidate signals are retrieval aids, not proof of event coreference or occurrence.",
      "Distinguish a repeated description of the same event from a subevent, summary, recollection, hypothetical, or merely similar event.",
      "An empty result is valid and may require new-event, unresolved, or exact-context non-referential status.",
    ],
    executionMode: "sequential" as const,
    parameters: candidateParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beforeCall?.();
      if (blocked) return blocked;
      const sourceId = requireSourceId(getSourceId);
      const result = await generateEventResolutionCandidates(
        workspaceRoot,
        sourceId,
        input.event_mention_id,
        getCompilerBatchId(),
      );
      return textResult(promptJson({
        sourceId,
        mention: {
          id: result.mention.id,
          trigger: result.mention.trigger,
          eventTypeCandidates: result.mention.eventTypeCandidates,
          participantMentionIds: result.mention.participantMentionIds,
          sceneId: result.mention.sceneId,
          discourseSegmentId: result.mention.discourseSegmentId,
          salience: result.mention.salience,
        },
        candidates: result.candidates,
        message: result.candidates.length
          ? "Candidate signals are deterministic retrieval features only; preserve coreference/subevent uncertainty explicitly."
          : "No candidate signal matched. Propose a new event only when the source supports a canonical occurrence; preserve unresolved uncertainty, or use non-referential only for a proven diffuse/false-positive event phrase.",
      }));
    },
  });

  const findParameters = Type.Object({
    query: Type.String({ minLength: 1, maxLength: 500, description: "Literal case-insensitive mention/resolution/event ID text, or * for all." }),
    status: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("pending")])),
    resolution_status: Type.Optional(Type.Union([
      Type.Literal("resolved"),
      Type.Literal("new-event"),
      Type.Literal("ambiguous"),
      Type.Literal("unresolved"),
      Type.Literal("non-referential"),
    ])),
    relation: Type.Optional(Type.Union([Type.Literal("coreference"), Type.Literal("subevent")])),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_RESOLUTION_RECORDS })),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_FIND_RESULTS })),
  }, { additionalProperties: false });
  const find = defineTool({
    name: "find_event_resolutions",
    label: "Find event resolutions",
    description: "Search current and pending source-scoped event clusters, including ambiguous, unresolved, and non-referential adjudications.",
    promptSnippet: "Find current event identity decisions before merging, splitting, or revising clusters",
    promptGuidelines: ["Read the exact payload before superseding a cluster."],
    executionMode: "sequential" as const,
    parameters: findParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beforeCall?.();
      if (blocked) return blocked;
      const sourceId = requireSourceId(getSourceId);
      const needle = input.query.normalize("NFKC").toLocaleLowerCase();
      const matches = (await loadEventResolutionRecords(workspaceRoot, sourceId))
        .filter((record) => !input.status || record.status === input.status)
        .filter((record) => !input.resolution_status || record.resolutionStatus === input.resolution_status)
        .filter((record) => !input.relation || record.payload.relation === input.relation
          || record.payload.candidates.some((candidate) => candidate.relation === input.relation))
        .filter((record) => needle === "*" || `${record.ref}\n${record.resolutionId}\n${record.eventMentionIds.join("\n")}\n${canonicalJson(record.payload)}`
          .normalize("NFKC").toLocaleLowerCase().includes(needle));
      const offset = input.offset ?? 0;
      const limit = input.max_results ?? 20;
      const results = matches.slice(offset, offset + limit).map((record) => ({
        ref: record.ref,
        status: record.status,
        resolutionId: record.resolutionId,
        eventMentionIds: record.eventMentionIds,
        resolutionStatus: record.resolutionStatus,
        canonicalEventId: record.payload.canonicalEventId,
        relation: record.payload.relation,
        candidateEventIds: [...new Set(record.payload.candidates.map((candidate) => candidate.canonicalEventId))].sort(),
        ...(record.proposalId ? { proposalId: record.proposalId } : {}),
        semanticHash: contentHash(record.payload),
      }));
      return textResult(promptJson({
        sourceId,
        query: input.query,
        offset,
        returned: results.length,
        totalMatches: matches.length,
        ...(offset + results.length < matches.length ? { nextOffset: offset + results.length } : {}),
        results,
      }));
    },
  });

  const readParameters = Type.Object({
    ref: Type.String({ minLength: 1, maxLength: 500 }),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    max_chars: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_READ_CHARS })),
  }, { additionalProperties: false });
  const read = defineTool({
    name: "read_event_resolution",
    label: "Read event resolution",
    description: "Read one exact source-scoped event cluster decision by ref. Large records are losslessly paged.",
    promptSnippet: "Read the exact current or pending event resolution",
    promptGuidelines: ["Continue from nextOffset until complete before proposing a merge, split, or revision."],
    executionMode: "sequential" as const,
    parameters: readParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beforeCall?.();
      if (blocked) return blocked;
      const sourceId = requireSourceId(getSourceId);
      const record = (await loadEventResolutionRecords(workspaceRoot, sourceId))
        .find((candidate) => candidate.ref === input.ref);
      if (!record) throw new Error(`Event-resolution ref '${input.ref}' was not found in active source '${sourceId}'.`);
      const serialized = canonicalJson({
        ref: record.ref,
        status: record.status,
        ...(record.proposalId ? { proposalId: record.proposalId } : {}),
        semanticHash: contentHash(record.payload),
        payload: record.payload,
      });
      const offset = input.offset ?? 0;
      if (offset > serialized.length) throw new Error(`offset ${offset} exceeds event-resolution length ${serialized.length}.`);
      assertSafeTextOffset(serialized, offset);
      const end = safeTextPageEnd(serialized, offset, offset + (input.max_chars ?? MAX_READ_CHARS));
      return textResult(promptJson({
        type: "event-resolution-chunk",
        sourceId,
        ref: record.ref,
        offset,
        end,
        total: serialized.length,
        ...(end < serialized.length ? { nextOffset: end } : {}),
        chunk: serialized.slice(offset, end),
      }));
    },
  });
  return [candidates, find, read];
}

function requireSourceId(getSourceId: () => string | undefined): string {
  const sourceId = getSourceId();
  if (!sourceId) throw new Error("Event-resolution retrieval requires an active source-scoped batch.");
  return sourceId;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: { eventResolutionRetrieval: true } };
}

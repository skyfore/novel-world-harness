import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { promptJson } from "../util/prompt-data.js";
import { assertSafeTextOffset, safeTextPageEnd } from "../util/text-pages.js";
import {
  EntityResolutionStore,
  generateEntityResolutionCandidates,
  type IdentityResolution,
} from "./entity-resolution.js";
import type { CompilerToolCallGate } from "./tool-call-gate.js";
import {
  COMPILER_RETRIEVAL_MAX_FIND_RESULTS as MAX_FIND_RESULTS,
  COMPILER_RETRIEVAL_MAX_READ_CHARS as MAX_READ_CHARS,
} from "./limits.js";

export const ENTITY_RESOLUTION_RETRIEVAL_TOOL_NAMES = [
  "find_entity_resolution_candidates",
  "find_identity_resolutions",
  "read_identity_resolution",
] as const;

type ResolutionRecord = {
  ref: string;
  status: "current" | "pending";
  resolutionId: string;
  mentionId: string;
  resolutionStatus: IdentityResolution["status"];
  proposalId?: string;
  payload: IdentityResolution;
};

const MAX_RESOLUTION_RECORDS = 100_000;

export async function loadIdentityResolutionRecords(
  workspaceRoot: string,
  sourceId: string,
): Promise<ResolutionRecord[]> {
  const store = new EntityResolutionStore(workspaceRoot);
  const [current, pending] = await Promise.all([
    store.list(sourceId),
    store.listProposals(sourceId, "pending"),
  ]);
  const records: ResolutionRecord[] = current.map((resolution) => ({
    ref: `current:${resolution.mentionId}`,
    status: "current",
    resolutionId: resolution.id,
    mentionId: resolution.mentionId,
    resolutionStatus: resolution.status,
    payload: resolution,
  }));
  for (const summary of pending) {
    const proposal = await store.readProposal(sourceId, "pending", summary.id);
    records.push({
      ref: `pending:${proposal.id}`,
      status: "pending",
      resolutionId: proposal.payload.id,
      mentionId: proposal.payload.mentionId,
      resolutionStatus: proposal.payload.status,
      proposalId: proposal.id,
      payload: proposal.payload,
    });
  }
  if (records.length > MAX_RESOLUTION_RECORDS) {
    throw new Error(`Source ${sourceId} has ${records.length} identity resolutions, exceeding the ${MAX_RESOLUTION_RECORDS}-record safety limit.`);
  }
  return records.sort((left, right) => left.mentionId.localeCompare(right.mentionId)
    || left.status.localeCompare(right.status)
    || left.resolutionId.localeCompare(right.resolutionId));
}

export function createEntityResolutionRetrievalTools(
  workspaceRoot: string,
  getSourceId: () => string | undefined,
  getCompilerBatchId: () => string | undefined,
  beforeCall?: CompilerToolCallGate,
): ToolDefinition[] {
  const candidatesParameters = Type.Object({
    mention_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  }, { additionalProperties: false });
  const candidates = defineTool({
    name: "find_entity_resolution_candidates",
    label: "Find entity resolution candidates",
    description: "Generate deterministic source-scoped lexical identity candidates from canonical entities, this batch's entity drafts, and active entity proposals from previously checkpointed batches.",
    promptSnippet: "Generate host-ranked lexical candidates before proposing an identity decision",
    promptGuidelines: [
      "An empty result is valid and may require new-entity or unresolved status.",
      "Lexical equality is candidate generation, not proof of identity; use source context and preserve ambiguity.",
      "Copy each candidate's resolutionMode: resolved reuses canonical/checkpointed identity, while new-entity requires the current-batch entity proposal.",
    ],
    executionMode: "sequential" as const,
    parameters: candidatesParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beforeCall?.();
      if (blocked) return blocked;
      const sourceId = requireSourceId(getSourceId);
      const result = await generateEntityResolutionCandidates(
        workspaceRoot,
        sourceId,
        input.mention_id,
        getCompilerBatchId(),
      );
      return textResult(promptJson({
        sourceId,
        mention: {
          id: result.mention.id,
          surface: result.mention.surface,
          form: result.mention.form,
          kindCandidates: result.mention.kindCandidates,
          sceneId: result.mention.sceneId,
        },
        candidates: result.candidates,
        message: result.candidates.length
          ? "Candidates are deterministic lexical matches only; the identity decision remains a proposal. Use each candidate's resolutionMode instead of guessing from pending status."
          : "No compatible lexical candidate matched. Preserve unresolved ambiguity or propose a new entity only when source context supports it.",
      }));
    },
  });

  const findParameters = Type.Object({
    query: Type.String({ minLength: 1, maxLength: 500, description: "Literal case-insensitive mention/resolution/entity ID text, or * for all." }),
    status: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("pending")])),
    resolution_status: Type.Optional(Type.Union([
      Type.Literal("resolved"),
      Type.Literal("ambiguous"),
      Type.Literal("new-entity"),
      Type.Literal("unresolved"),
    ])),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_RESOLUTION_RECORDS })),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_FIND_RESULTS })),
  }, { additionalProperties: false });
  const find = defineTool({
    name: "find_identity_resolutions",
    label: "Find identity resolutions",
    description: "Search current and pending source-scoped mention-to-entity decisions, including ambiguous and unresolved queues.",
    promptSnippet: "Find current identity decisions before merging, splitting, or revising mentions",
    promptGuidelines: ["Read an exact resolution payload before superseding it."],
    executionMode: "sequential" as const,
    parameters: findParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beforeCall?.();
      if (blocked) return blocked;
      const sourceId = requireSourceId(getSourceId);
      const needle = input.query.normalize("NFKC").toLocaleLowerCase();
      const matches = (await loadIdentityResolutionRecords(workspaceRoot, sourceId))
        .filter((record) => !input.status || record.status === input.status)
        .filter((record) => !input.resolution_status || record.resolutionStatus === input.resolution_status)
        .filter((record) => needle === "*" || `${record.ref}\n${record.resolutionId}\n${record.mentionId}\n${canonicalJson(record.payload)}`
          .normalize("NFKC").toLocaleLowerCase().includes(needle));
      const offset = input.offset ?? 0;
      const limit = input.max_results ?? 20;
      const results = matches.slice(offset, offset + limit).map((record) => ({
        ref: record.ref,
        status: record.status,
        resolutionId: record.resolutionId,
        mentionId: record.mentionId,
        resolutionStatus: record.resolutionStatus,
        entityId: record.payload.entityId,
        candidateEntityIds: record.payload.candidates.map((candidate) => candidate.entityId),
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
    name: "read_identity_resolution",
    label: "Read identity resolution",
    description: "Read one exact source-scoped identity resolution by ref. Large records are losslessly paged.",
    promptSnippet: "Read the exact current or pending identity decision",
    promptGuidelines: ["Continue from nextOffset until complete before proposing a superseding resolution."],
    executionMode: "sequential" as const,
    parameters: readParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beforeCall?.();
      if (blocked) return blocked;
      const sourceId = requireSourceId(getSourceId);
      const record = (await loadIdentityResolutionRecords(workspaceRoot, sourceId))
        .find((candidate) => candidate.ref === input.ref);
      if (!record) throw new Error(`Identity-resolution ref '${input.ref}' was not found in active source '${sourceId}'.`);
      const serialized = canonicalJson({
        ref: record.ref,
        status: record.status,
        ...(record.proposalId ? { proposalId: record.proposalId } : {}),
        semanticHash: contentHash(record.payload),
        payload: record.payload,
      });
      const offset = input.offset ?? 0;
      if (offset > serialized.length) throw new Error(`offset ${offset} exceeds identity-resolution length ${serialized.length}.`);
      assertSafeTextOffset(serialized, offset);
      const end = safeTextPageEnd(serialized, offset, offset + (input.max_chars ?? MAX_READ_CHARS));
      return textResult(promptJson({
        type: "identity-resolution-chunk",
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
  if (!sourceId) throw new Error("Identity-resolution retrieval requires an active source-scoped batch.");
  return sourceId;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: { identityResolutionRetrieval: true } };
}

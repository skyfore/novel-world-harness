import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { promptJson } from "../util/prompt-data.js";
import { assertSafeTextOffset, safeTextPageEnd } from "../util/text-pages.js";
import {
  SourceAnnotationStore,
  annotationAnchors,
  sourceAnnotationTypeSchema,
  type SourceAnnotation,
  type SourceAnnotationType,
} from "./annotations.js";
import type { CompilerToolCallGate } from "./tool-call-gate.js";
import {
  COMPILER_RETRIEVAL_MAX_FIND_RESULTS as MAX_FIND_RESULTS,
  COMPILER_RETRIEVAL_MAX_READ_CHARS as MAX_READ_CHARS,
} from "./limits.js";

export const SOURCE_ANNOTATION_TOOL_NAMES = [
  "find_source_annotations",
  "read_source_annotation",
] as const;

type AnnotationRecord = {
  ref: string;
  status: "committed" | "pending";
  annotationType: SourceAnnotationType;
  annotationId: string;
  proposalId?: string;
  label: string;
  payload: SourceAnnotation;
};

const MAX_ANNOTATION_RECORDS = 100_000;

export async function loadSourceAnnotationRecords(
  workspaceRoot: string,
  sourceId: string,
): Promise<AnnotationRecord[]> {
  const store = new SourceAnnotationStore(workspaceRoot);
  const [committed, pending] = await Promise.all([
    store.list(sourceId),
    store.listProposals(sourceId, "pending"),
  ]);
  const records: AnnotationRecord[] = committed.map((annotation) => ({
    ref: `committed:${annotation.id}`,
    status: "committed",
    annotationType: annotation.annotationType,
    annotationId: annotation.id,
    label: annotationLabel(annotation),
    payload: annotation,
  }));
  for (const summary of pending) {
    const proposal = await store.readProposal(sourceId, "pending", summary.id);
    records.push({
      ref: `pending:${proposal.id}`,
      status: "pending",
      annotationType: proposal.annotationType,
      annotationId: proposal.payload.id,
      proposalId: proposal.id,
      label: annotationLabel(proposal.payload),
      payload: proposal.payload,
    });
  }
  if (records.length > MAX_ANNOTATION_RECORDS) {
    throw new Error(`Source ${sourceId} has ${records.length} observations, exceeding the ${MAX_ANNOTATION_RECORDS}-record safety limit.`);
  }
  return records.sort((left, right) => firstStartByte(left.payload) - firstStartByte(right.payload)
    || left.annotationType.localeCompare(right.annotationType)
    || left.annotationId.localeCompare(right.annotationId)
    || left.ref.localeCompare(right.ref));
}

export function createSourceAnnotationRetrievalTools(
  workspaceRoot: string,
  getSourceId: () => string | undefined,
  beforeCall?: CompilerToolCallGate,
): ToolDefinition[] {
  const findParameters = Type.Object({
    query: Type.String({ minLength: 1, maxLength: 500, description: "Literal case-insensitive observation text/ID, or * for all." }),
    annotation_type: Type.Optional(Type.Union([
      Type.Literal("entity-mention"),
      Type.Literal("event-mention"),
      Type.Literal("quotation"),
      Type.Literal("discourse-segment"),
    ])),
    status: Type.Optional(Type.Union([Type.Literal("committed"), Type.Literal("pending")])),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_ANNOTATION_RECORDS })),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_FIND_RESULTS })),
  }, { additionalProperties: false });
  const find = defineTool({
    name: "find_source_annotations",
    label: "Find source annotations",
    description: "Search committed and current pending source observations without treating mentions as canonical identities or events.",
    promptSnippet: "Find prior entity/event mentions, quotations, and discourse spans before proposing duplicates",
    promptGuidelines: [
      "Use observation refs only inside the active source.",
      "An entity mention is source evidence awaiting identity resolution, not a canonical entity.",
      "An event mention records textual presentation, not a committed occurrence.",
    ],
    executionMode: "sequential" as const,
    parameters: findParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beforeCall?.();
      if (blocked) return blocked;
      const sourceId = requireSourceId(getSourceId);
      const annotationType = input.annotation_type === undefined
        ? undefined
        : sourceAnnotationTypeSchema.parse(input.annotation_type);
      const needle = input.query.normalize("NFKC").toLocaleLowerCase();
      const matches = (await loadSourceAnnotationRecords(workspaceRoot, sourceId))
        .filter((record) => !annotationType || record.annotationType === annotationType)
        .filter((record) => !input.status || record.status === input.status)
        .filter((record) => needle === "*" || `${record.ref}\n${record.annotationId}\n${record.label}\n${canonicalJson(record.payload)}`
          .normalize("NFKC").toLocaleLowerCase().includes(needle));
      const offset = input.offset ?? 0;
      const limit = input.max_results ?? 20;
      const results = matches.slice(offset, offset + limit).map((record) => ({
        ref: record.ref,
        status: record.status,
        annotationType: record.annotationType,
        annotationId: record.annotationId,
        ...(record.proposalId ? { proposalId: record.proposalId } : {}),
        label: record.label,
        semanticHash: contentHash(record.payload),
        anchors: annotationAnchors(record.payload).map((anchor) => ({
          startByte: anchor.startByte,
          endByte: anchor.endByte,
          startLine: anchor.startLine,
          endLine: anchor.endLine,
        })),
      }));
      return textResult(promptJson({
        sourceId,
        query: input.query,
        ...(annotationType ? { annotationType } : {}),
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
    name: "read_source_annotation",
    label: "Read source annotation",
    description: "Read one exact source-scoped observation by stable ref. Large records are losslessly paged.",
    promptSnippet: "Read an exact entity/event mention, quotation, or discourse observation",
    promptGuidelines: ["Continue from nextOffset until complete before revising a paged observation."],
    executionMode: "sequential" as const,
    parameters: readParameters,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const blocked = beforeCall?.();
      if (blocked) return blocked;
      const sourceId = requireSourceId(getSourceId);
      const record = (await loadSourceAnnotationRecords(workspaceRoot, sourceId))
        .find((candidate) => candidate.ref === input.ref);
      if (!record) throw new Error(`Source annotation ref '${input.ref}' was not found in active source '${sourceId}'.`);
      const serialized = canonicalJson({
        ref: record.ref,
        status: record.status,
        annotationType: record.annotationType,
        annotationId: record.annotationId,
        ...(record.proposalId ? { proposalId: record.proposalId } : {}),
        semanticHash: contentHash(record.payload),
        payload: record.payload,
      });
      const offset = input.offset ?? 0;
      if (offset > serialized.length) throw new Error(`offset ${offset} exceeds annotation length ${serialized.length}.`);
      assertSafeTextOffset(serialized, offset);
      const end = safeTextPageEnd(serialized, offset, offset + (input.max_chars ?? MAX_READ_CHARS));
      return textResult(promptJson({
        type: "source-annotation-chunk",
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
  return [find, read];
}

function annotationLabel(annotation: SourceAnnotation): string {
  if (annotation.annotationType === "entity-mention") {
    return annotation.surface || `[zero anaphora: ${annotation.interpretation ?? annotation.id}]`;
  }
  if (annotation.annotationType === "event-mention") return `${annotation.trigger} (${annotation.salience} event mention)`;
  if (annotation.annotationType === "quotation") return `${annotation.mode} quotation ${annotation.id}`;
  return `${annotation.kind} discourse ${annotation.id}`;
}

function firstStartByte(annotation: SourceAnnotation): number {
  if (annotation.annotationType === "discourse-segment") return annotation.anchors[0]!.startByte;
  if (annotation.annotationType === "event-mention") return annotation.extentAnchors[0]!.startByte;
  return annotation.anchor.startByte;
}

function requireSourceId(getSourceId: () => string | undefined): string {
  const sourceId = getSourceId();
  if (!sourceId) throw new Error("Source annotation retrieval requires an active source-scoped batch.");
  return sourceId;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: { sourceAnnotationRetrieval: true } };
}

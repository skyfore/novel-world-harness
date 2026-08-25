import crypto from "node:crypto";
import { z } from "zod";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { idSchema, textAnchorSchema, type TextAnchor } from "../world/model.js";
import { readSegmentText, type SourceSegment } from "./segments.js";

const modelEvidenceSelectorBase = {
  segment_id: idSchema,
  exact: z.string().min(1).max(4_000),
  prefix: z.string().max(500).optional(),
  suffix: z.string().max(500).optional(),
  occurrence: z.number().int().positive().optional(),
  target_path: z.string().min(1).refine(
    (value) => /^(?:\/(?:[^~/]|~[01])*)*$/.test(value),
    "target_path must be an RFC 6901 JSON Pointer",
  ),
  relation: z.enum(["supports", "contradicts", "contextualizes"]),
};

export const modelEvidenceSelectorSchema = z.discriminatedUnion("strength", [
  z.object({
    ...modelEvidenceSelectorBase,
    strength: z.literal("explicit"),
    interpretation: z.string().trim().min(1).max(1_000).optional(),
  }).strict(),
  z.object({
    ...modelEvidenceSelectorBase,
    strength: z.literal("strong-inference"),
    interpretation: z.string().trim().min(1).max(1_000),
  }).strict(),
  z.object({
    ...modelEvidenceSelectorBase,
    strength: z.literal("weak-inference"),
    interpretation: z.string().trim().min(1).max(1_000),
  }).strict(),
]);
export type ModelEvidenceSelector = z.infer<typeof modelEvidenceSelectorSchema>;

export const modelEvidenceSelectorsSchema = z.array(modelEvidenceSelectorSchema)
  .min(1)
  .max(64);

const CONTEXT_BYTES = 64;

/**
 * Resolve a model-readable exact quote inside one host-validated source
 * segment. The model never supplies trusted offsets or hashes.
 */
export async function resolveTextAnchor(
  workspaceRoot: string,
  segment: SourceSegment,
  selectorInput: unknown,
): Promise<TextAnchor> {
  const selector = modelEvidenceSelectorSchema.parse(selectorInput);
  if (selector.segment_id !== segment.id) {
    throw new Error(`Evidence selector references segment ${selector.segment_id}, not ${segment.id}.`);
  }
  const text = await readSegmentText(workspaceRoot, segment);
  const matches = matchingOffsets(text, selector);
  if (!matches.length) {
    throw new Error(
      `Exact evidence quote was not found in segment ${segment.id}${selector.prefix || selector.suffix ? " with the supplied context" : ""}.`,
    );
  }
  let characterOffset: number;
  if (selector.occurrence !== undefined) {
    const selected = matches[selector.occurrence - 1];
    if (selected === undefined) {
      throw new Error(
        `Evidence selector occurrence ${selector.occurrence} exceeds ${matches.length} matching occurrence(s) in segment ${segment.id}.`,
      );
    }
    characterOffset = selected;
  } else {
    if (matches.length !== 1) {
      throw new Error(
        `Exact evidence quote is ambiguous in segment ${segment.id}: ${matches.length} occurrences match. Supply prefix/suffix or a one-based occurrence.`,
      );
    }
    characterOffset = matches[0]!;
  }

  const before = text.slice(0, characterOffset);
  const exact = text.slice(characterOffset, characterOffset + selector.exact.length);
  const localStartByte = Buffer.byteLength(before, "utf8");
  const exactBytes = Buffer.from(exact, "utf8");
  const localEndByte = localStartByte + exactBytes.byteLength;
  const startByte = segment.startByte + localStartByte;
  const endByte = segment.startByte + localEndByte;
  const source = await (await WorkspaceStore.create(workspaceRoot)).getSource(segment.sourceId);
  if (!source) throw new Error(`Unknown evidence source ${segment.sourceId}.`);
  const sourceBytes = await readSourceMaterial(workspaceRoot, source);
  return textAnchorForByteRange(segment.sourceId, sourceBytes, startByte, endByte);
}

/** Build a trusted anchor for a host-selected, non-empty UTF-8 source range. */
export function textAnchorForByteRange(
  sourceId: string,
  sourceBytesInput: Uint8Array,
  startByte: number,
  endByte: number,
): TextAnchor {
  idSchema.parse(sourceId);
  const sourceBytes = Buffer.from(sourceBytesInput);
  if (!Number.isInteger(startByte) || !Number.isInteger(endByte)
    || startByte < 0 || endByte <= startByte || endByte > sourceBytes.byteLength) {
    throw new Error(`Invalid text-anchor byte range ${startByte}-${endByte} for ${sourceBytes.byteLength} source bytes.`);
  }
  const exactBytes = sourceBytes.subarray(startByte, endByte);
  const exact = exactBytes.toString("utf8");
  if (!Buffer.from(exact, "utf8").equals(exactBytes)) {
    throw new Error(`Text-anchor byte range ${startByte}-${endByte} splits an invalid UTF-8 boundary.`);
  }
  const before = sourceBytes.subarray(0, startByte).toString("utf8");
  if (Buffer.byteLength(before, "utf8") !== startByte) {
    throw new Error(`Text-anchor start byte ${startByte} splits an invalid UTF-8 boundary.`);
  }
  const startLine = 1 + newlineCount(before);
  // endByte is exclusive. The final anchored byte belongs to the line reached
  // immediately before that byte, including when the byte itself is an EOL.
  const beforeFinalByte = sourceBytes.subarray(0, endByte - 1).toString("utf8");
  const endLine = 1 + newlineCount(beforeFinalByte);
  return textAnchorSchema.parse({
    version: 1,
    sourceId,
    startByte,
    endByte,
    startLine,
    endLine,
    exactHash: sha256(exactBytes),
    prefixHash: sha256(sourceBytes.subarray(Math.max(0, startByte - CONTEXT_BYTES), startByte)),
    suffixHash: sha256(sourceBytes.subarray(endByte, Math.min(sourceBytes.byteLength, endByte + CONTEXT_BYTES))),
    contextBytes: CONTEXT_BYTES,
    normalization: "source-bytes-v1",
  });
}

export function jsonPointerExists(value: unknown, pointer: string): boolean {
  if (pointer === "") return true;
  if (!/^(?:\/(?:[^~/]|~[01])*)*$/.test(pointer)) return false;
  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const token = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return false;
      const index = Number(token);
      if (index >= current.length) return false;
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object" || !Object.hasOwn(current, token)) return false;
    current = (current as Record<string, unknown>)[token];
  }
  return true;
}

function matchingOffsets(text: string, selector: ModelEvidenceSelector): number[] {
  const offsets: number[] = [];
  let from = 0;
  for (;;) {
    const offset = text.indexOf(selector.exact, from);
    if (offset < 0) break;
    const prefixMatches = selector.prefix === undefined
      || text.slice(Math.max(0, offset - selector.prefix.length), offset) === selector.prefix;
    const suffixStart = offset + selector.exact.length;
    const suffixMatches = selector.suffix === undefined
      || text.slice(suffixStart, suffixStart + selector.suffix.length) === selector.suffix;
    if (prefixMatches && suffixMatches) offsets.push(offset);
    // Count overlapping matches too; "aaa" contains two exact occurrences of
    // "aa" and must not silently select the first as if it were unique.
    from = offset + 1;
  }
  return offsets;
}

function newlineCount(value: string): number {
  return value.match(/\r\n|\r|\n/g)?.length ?? 0;
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

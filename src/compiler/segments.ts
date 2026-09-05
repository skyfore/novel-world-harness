import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { worldStorageRoot } from "../world/paths.js";
import { readSourceMaterial, SourceMaterialStore } from "../storage/source-material-store.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { promptJson } from "../util/prompt-data.js";
import { z } from "zod";
import { idSchema, type EvidenceRef } from "../world/model.js";
import {
  ChapterSplitPlanStore,
  customChapterBoundaries,
  type ChapterSplitPlan,
} from "./chapter-split.js";

export type SourceSegment = {
  version: 1;
  id: string;
  sourceId: string;
  sourcePath: string;
  ordinal: number;
  kind: "section" | "block";
  title?: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  textSha256: string;
  bytes: number;
  promptCharacters: number;
};

export type SegmentManifest = {
  version: 1;
  sourceId: string;
  sourcePath: string;
  sourceSha256: string;
  segmenterVersion: number;
  segments: SourceSegment[];
};

type LineRecord = { text: string; eol: string; startByte: number; endByte: number; promptChars: number };
type Span = {
  start: number;
  end: number;
  kind: "section" | "block";
  title?: string;
  startByte?: number;
  endByte?: number;
};

const HEADING_PATTERNS = [
  /^\s{0,3}#{1,6}\s+\S/,
  /^\s*第[零〇一二三四五六七八九十百千万两\d]+[章节卷回部篇幕](?:\s|$|[：:])/u,
  /^\s*(?:prologue|preface|序章|序幕|序言|前言|楔子|引子)(?:\s|$|[：:])/iu,
  /^\s*(?:chapter|book|part|volume)\s+[\divxlcdm]+\b/i,
];
// Segments remain finite evidence units, but modern model contexts do not need
// the old ~24 KiB / 160-line cut. Chapters are now preserved up to a much wider
// safety boundary; batching may join continuation pieces from the same chapter.
// Keep an observation batch well below the host's 800-proposal runaway fuse.
// Byte/prompt bounds do the primary work for prose; the line bound remains a
// fallback for unusually short-line sources.
const MAX_BLOCK_LINES = 1_000;
const MAX_BLOCK_BYTES = 48 * 1024;
const MAX_BLOCK_PROMPT_CHARS = 48 * 1024;
export const SEGMENTER_VERSION = 7 as const;

const sourceSegmentSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  sourceId: idSchema,
  sourcePath: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  kind: z.enum(["section", "block"]),
  title: z.string().optional(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().nonnegative(),
  textSha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
  // Default only permits older on-disk manifests to be parsed and repaired by
  // the mandatory fresh derivation/deep comparison before compiler use.
  promptCharacters: z.number().int().nonnegative().default(0),
}).strict().superRefine((segment, ctx) => {
  if (segment.endLine < segment.startLine) ctx.addIssue({ code: "custom", path: ["endLine"], message: "endLine must be >= startLine" });
  if (segment.endByte < segment.startByte) ctx.addIssue({ code: "custom", path: ["endByte"], message: "endByte must be >= startByte" });
  if (segment.bytes !== segment.endByte - segment.startByte) ctx.addIssue({ code: "custom", path: ["bytes"], message: "bytes must equal endByte-startByte" });
});

const segmentManifestSchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  sourcePath: z.string().min(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  segmenterVersion: z.number().int().positive(),
  segments: z.array(sourceSegmentSchema),
}).strict().superRefine((manifest, ctx) => {
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  let previous: SourceSegment | undefined;
  for (let index = 0; index < manifest.segments.length; index += 1) {
    const segment = manifest.segments[index]!;
    if (segment.sourceId !== manifest.sourceId) {
      ctx.addIssue({ code: "custom", path: ["segments", index, "sourceId"], message: "segment sourceId must equal manifest sourceId" });
    }
    if (segment.sourcePath !== manifest.sourcePath) {
      ctx.addIssue({ code: "custom", path: ["segments", index, "sourcePath"], message: "segment sourcePath must equal manifest sourcePath" });
    }
    if (ids.has(segment.id)) ctx.addIssue({ code: "custom", path: ["segments", index, "id"], message: "segment IDs must be unique" });
    if (ordinals.has(segment.ordinal)) ctx.addIssue({ code: "custom", path: ["segments", index, "ordinal"], message: "segment ordinals must be unique" });
    if (segment.ordinal !== index) {
      ctx.addIssue({ code: "custom", path: ["segments", index, "ordinal"], message: "segment ordinal must match its manifest position" });
    }
    if (previous && segment.startByte < previous.endByte) {
      ctx.addIssue({ code: "custom", path: ["segments", index, "startByte"], message: "segment byte ranges must be monotonic and non-overlapping" });
    }
    if (previous && segment.startLine < previous.startLine) {
      ctx.addIssue({ code: "custom", path: ["segments", index, "startLine"], message: "segment line ranges must be monotonic" });
    }
    ids.add(segment.id);
    ordinals.add(segment.ordinal);
    previous = segment as SourceSegment;
  }
});

function parseSegmentManifest(value: unknown, expectedSourceId?: string): SegmentManifest {
  const manifest = segmentManifestSchema.parse(value) as SegmentManifest;
  if (expectedSourceId && manifest.sourceId !== expectedSourceId) {
    throw new Error(`Segment manifest source '${manifest.sourceId}' does not match requested source '${expectedSourceId}'.`);
  }
  return manifest;
}

export class SegmentStore {
  readonly root: string;
  constructor(workspaceRoot: string) {
    this.root = path.join(worldStorageRoot(workspaceRoot), "evidence", "segments");
  }

  async write(manifest: SegmentManifest): Promise<void> {
    const validated = parseSegmentManifest(manifest);
    const directory = path.join(this.root, safeId(validated.sourceId));
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const expected = new Set<string>();
    for (const segment of validated.segments) {
      const name = `${safeId(segment.id)}.json`;
      expected.add(name);
      await atomicJson(path.join(directory, name), segment);
    }
    for (const name of await fs.readdir(directory)) {
      if (name.endsWith(".json") && name !== "manifest.json" && !expected.has(name)) {
        await fs.rm(path.join(directory, name), { force: true });
      }
    }
    await atomicJson(path.join(directory, "manifest.json"), validated);
  }

  async readManifest(sourceId: string): Promise<SegmentManifest | null> {
    try {
      return parseSegmentManifest(
        JSON.parse(await fs.readFile(path.join(this.root, safeId(sourceId), "manifest.json"), "utf8")),
        sourceId,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(sourceId: string): Promise<SourceSegment[]> {
    return (await this.readManifest(sourceId))?.segments ?? [];
  }

  async remove(sourceId: string): Promise<void> {
    await fs.rm(path.join(this.root, safeId(sourceId)), { recursive: true, force: true });
  }
}

export async function segmentSource(
  workspaceRoot: string,
  source: SourceDocument,
  options: { chapterSplitPlan?: ChapterSplitPlan | null } = {},
): Promise<SegmentManifest> {
  const buffer = await readSourceMaterial(workspaceRoot, source);
  const sourceSha256 = sha256(buffer);
  if (sourceSha256 !== source.contentSha256) {
    throw new Error(`Source changed since ingest: ${source.sourcePath}; expected ${source.contentSha256}, found ${sourceSha256}`);
  }
  if (buffer.byteLength === 0) throw new Error(`Source must not be empty: ${source.sourcePath}`);
  if (buffer.subarray(0, 8_000).includes(0)) throw new Error(`Source must be UTF-8 text: ${source.sourcePath}`);

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`Source must be valid UTF-8 text: ${source.sourcePath}`);
  }
  const text = buffer.toString("utf8");
  const records = parseLines(text);
  const lines = records.map((record) => record.text);
  const chapterSplitPlan = Object.hasOwn(options, "chapterSplitPlan")
    ? options.chapterSplitPlan ?? null
    : await new ChapterSplitPlanStore(workspaceRoot).read(source.id);
  if (chapterSplitPlan && chapterSplitPlan.sourceSha256 !== sourceSha256) {
    throw new Error(`Chapter split plan for ${source.id} targets different source bytes.`);
  }
  const customBoundaries = customChapterBoundaries(lines, chapterSplitPlan);
  if (chapterSplitPlan?.mode === "custom" && customBoundaries.length < 2) {
    throw new Error(`Custom chapter split plan for ${source.id} no longer identifies at least two headings.`);
  }
  const boundaries = withPreambleBoundary(
    lines,
    customBoundaries.length ? customBoundaries : findBoundaries(lines),
  );
  const spans = boundaries.length > 1 ? sectionSpans(lines, records, boundaries) : blockSpans(lines, records);
  const segments = spans.map((span, ordinal) => materializeSegment(source, buffer, records, span, ordinal));
  return {
    version: 1,
    sourceId: source.id,
    sourcePath: source.sourcePath,
    sourceSha256,
    segmenterVersion: SEGMENTER_VERSION,
    segments,
  };
}

export async function readSegmentText(workspaceRoot: string, segment: SourceSegment): Promise<string> {
  const source = await (await WorkspaceStore.create(workspaceRoot)).getSource(segment.sourceId);
  const buffer = source
    ? await readSourceMaterial(workspaceRoot, source)
    : await new SourceMaterialStore().readBySourceId(segment.sourceId);
  if (!buffer) throw new Error(`Unknown segment source: ${segment.sourceId}`);
  if (segment.startByte < 0 || segment.endByte > buffer.byteLength || segment.endByte <= segment.startByte) {
    throw new Error(`Segment ${segment.id} byte range ${segment.startByte}-${segment.endByte} is outside source length ${buffer.byteLength}.`);
  }
  const slice = buffer.subarray(segment.startByte, segment.endByte);
  if (sha256(slice) !== segment.textSha256) throw new Error(`Segment source changed: ${segment.id}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    throw new Error(`Segment ${segment.id} does not align to valid UTF-8 source boundaries.`);
  }
}

/**
 * Materialize the immutable evidence identity owned by a validated source
 * segment. Model tools cite only the segment id; the host is the sole writer
 * of byte ranges, line ranges, and content hashes.
 */
export function segmentEvidenceRef(segment: SourceSegment): EvidenceRef {
  return {
    span: {
      sourceId: segment.sourceId,
      startByte: segment.startByte,
      endByte: segment.endByte,
      startLine: segment.startLine,
      endLine: segment.endLine,
      quoteHash: segment.textSha256,
    },
    strength: "explicit",
  };
}

function parseLines(text: string): LineRecord[] {
  const records: LineRecord[] = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  let match: RegExpExecArray | null;
  let byteOffset = 0;
  while ((match = pattern.exec(text)) !== null) {
    const line = match[1] ?? "";
    const eol = match[2] ?? "";
    if (!line && !eol && match.index === text.length) break;
    const bytes = Buffer.byteLength(line + eol, "utf8");
    records.push({
      text: line,
      eol,
      startByte: byteOffset,
      endByte: byteOffset + bytes,
      promptChars: promptJson(line + eol).length - 2,
    });
    byteOffset += bytes;
    if (!eol) break;
  }
  if (!records.length) records.push({ text: "", eol: "", startByte: 0, endByte: 0, promptChars: 0 });
  return records;
}

function findBoundaries(lines: string[]): number[] {
  const boundaries: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (HEADING_PATTERNS.some((pattern) => pattern.test(line))) boundaries.push(index);
  }
  return boundaries;
}

function withPreambleBoundary(lines: string[], boundaries: number[]): number[] {
  const result = [...boundaries];
  if (result.length && result[0] !== 0 && lines.slice(0, result[0]).some((line) => line.trim())) result.unshift(0);
  return result;
}

function sectionSpans(lines: string[], records: LineRecord[], boundaries: number[]): Span[] {
  const spans: Span[] = [];
  for (let index = 0; index < boundaries.length; index += 1) {
    const start = boundaries[index]!;
    const end = (boundaries[index + 1] ?? lines.length) - 1;
    const pieces = splitOversized(lines, records, start, end);
    for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
      const block = pieces[pieceIndex]!;
      const heading = (lines[start] ?? "").trim();
      const title = pieceIndex === 0 && heading ? heading.slice(0, 200) : heading ? `${heading.slice(0, 180)} [${pieceIndex + 1}]` : undefined;
      spans.push({ ...block, kind: "section", ...(title ? { title } : {}) });
    }
  }
  return spans.filter((span) => span.end >= span.start && lines.slice(span.start, span.end + 1).some((line) => line.trim()));
}

function blockSpans(lines: string[], records: LineRecord[]): Span[] {
  return splitOversized(lines, records, 0, Math.max(0, lines.length - 1))
    .map((span) => ({ ...span, kind: "block" as const }))
    .filter((span) => lines.slice(span.start, span.end + 1).some((line) => line.trim()));
}

function splitOversized(
  lines: string[],
  records: LineRecord[],
  start: number,
  end: number,
): Array<{ start: number; end: number; startByte?: number; endByte?: number }> {
  const spans: Array<{ start: number; end: number; startByte?: number; endByte?: number }> = [];
  let cursor = start;
  while (cursor <= end) {
    const first = records[cursor]!;
    if (first.endByte - first.startByte > MAX_BLOCK_BYTES || first.promptChars > MAX_BLOCK_PROMPT_CHARS) {
      spans.push(...splitLongLine(first, cursor));
      cursor += 1;
      continue;
    }
    let blockEnd = cursor;
    let bytes = 0;
    let promptChars = 0;
    let lastBlank = -1;
    while (blockEnd <= end && blockEnd - cursor < MAX_BLOCK_LINES) {
      const record = records[blockEnd]!;
      const nextBytes = record.endByte - record.startByte;
      if (blockEnd > cursor && (bytes + nextBytes > MAX_BLOCK_BYTES
        || promptChars + record.promptChars > MAX_BLOCK_PROMPT_CHARS)) break;
      bytes += nextBytes;
      promptChars += record.promptChars;
      if (!(lines[blockEnd] ?? "").trim()) lastBlank = blockEnd;
      blockEnd += 1;
    }
    if (blockEnd <= end && lastBlank >= cursor + 1) blockEnd = lastBlank + 1;
    if (blockEnd <= cursor) blockEnd = cursor + 1;
    spans.push({ start: cursor, end: Math.min(end, blockEnd - 1) });
    cursor = blockEnd;
    while (cursor <= end && !(lines[cursor] ?? "").trim()) cursor += 1;
  }
  return spans;
}

function splitLongLine(
  record: LineRecord,
  lineIndex: number,
): Array<{ start: number; end: number; startByte: number; endByte: number }> {
  const chunks: Array<{ start: number; end: number; startByte: number; endByte: number }> = [];
  let chunkStart = record.startByte;
  let byteOffset = record.startByte;
  let bytes = 0;
  let promptChars = 0;
  for (const character of record.text + record.eol) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    const characterPromptChars = promptJson(character).length - 2;
    if (bytes > 0 && (bytes + characterBytes > MAX_BLOCK_BYTES
      || promptChars + characterPromptChars > MAX_BLOCK_PROMPT_CHARS)) {
      chunks.push({ start: lineIndex, end: lineIndex, startByte: chunkStart, endByte: byteOffset });
      chunkStart = byteOffset;
      bytes = 0;
      promptChars = 0;
    }
    bytes += characterBytes;
    promptChars += characterPromptChars;
    byteOffset += characterBytes;
  }
  if (byteOffset > chunkStart || chunks.length === 0) {
    chunks.push({ start: lineIndex, end: lineIndex, startByte: chunkStart, endByte: byteOffset });
  }
  return chunks;
}

function materializeSegment(
  source: SourceDocument,
  buffer: Buffer,
  records: LineRecord[],
  span: Span,
  ordinal: number,
): SourceSegment {
  const startByte = span.startByte ?? records[span.start]?.startByte ?? 0;
  const endByte = span.endByte ?? records[span.end]?.endByte ?? startByte;
  const slice = buffer.subarray(startByte, endByte);
  const textSha256 = sha256(slice);
  const id = `${source.id}-${String(ordinal + 1).padStart(5, "0")}-${textSha256.slice(0, 12)}`;
  return {
    version: 1,
    id,
    sourceId: source.id,
    sourcePath: source.sourcePath,
    ordinal,
    kind: span.kind,
    ...(span.title ? { title: span.title } : {}),
    startLine: span.start + 1,
    endLine: span.end + 1,
    startByte,
    endByte,
    textSha256,
    bytes: slice.byteLength,
    promptCharacters: promptJson(slice.toString("utf8")).length,
  };
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`Unsafe source id: ${value}`);
  return value;
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SourceDocument } from "../storage/workspace-store.js";

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
};

export type SegmentManifest = {
  version: 1;
  sourceId: string;
  sourcePath: string;
  sourceSha256: string;
  segmenterVersion: 1;
  segments: SourceSegment[];
};

type LineRecord = { text: string; eol: string; startByte: number; endByte: number };
type Span = { start: number; end: number; kind: "section" | "block"; title?: string };

const HEADING_PATTERNS = [
  /^\s{0,3}#{1,6}\s+\S/,
  /^\s*第[零〇一二三四五六七八九十百千万两\d]+[章节卷回部篇](?:\s|$)/u,
  /^\s*(?:chapter|book|part|volume)\s+[\divxlcdm]+\b/i,
];
const MAX_BLOCK_LINES = 160;
const MAX_BLOCK_BYTES = 24 * 1024;

export class SegmentStore {
  readonly root: string;
  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceRoot, ".novel-harness", "world", "v1", "evidence", "segments");
  }

  async write(manifest: SegmentManifest): Promise<void> {
    const directory = path.join(this.root, safeId(manifest.sourceId));
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const expected = new Set<string>();
    for (const segment of manifest.segments) {
      const name = `${safeId(segment.id)}.json`;
      expected.add(name);
      await atomicJson(path.join(directory, name), segment);
    }
    for (const name of await fs.readdir(directory)) {
      if (name.endsWith(".json") && name !== "manifest.json" && !expected.has(name)) {
        await fs.rm(path.join(directory, name), { force: true });
      }
    }
    await atomicJson(path.join(directory, "manifest.json"), manifest);
  }

  async readManifest(sourceId: string): Promise<SegmentManifest | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.root, safeId(sourceId), "manifest.json"), "utf8")) as SegmentManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(sourceId: string): Promise<SourceSegment[]> {
    return (await this.readManifest(sourceId))?.segments ?? [];
  }
}

export async function segmentSource(workspaceRoot: string, source: SourceDocument): Promise<SegmentManifest> {
  const absolute = path.resolve(workspaceRoot, source.sourcePath);
  const relative = path.relative(workspaceRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Source escapes workspace: ${source.sourcePath}`);
  const buffer = await fs.readFile(absolute);
  const sourceSha256 = sha256(buffer);
  if (sourceSha256 !== source.contentSha256) {
    throw new Error(`Source changed since ingest: ${source.sourcePath}; expected ${source.contentSha256}, found ${sourceSha256}`);
  }
  if (buffer.subarray(0, 8_000).includes(0)) throw new Error(`Source must be UTF-8 text: ${source.sourcePath}`);

  const records = parseLines(buffer.toString("utf8"));
  const lines = records.map((record) => record.text);
  const boundaries = findBoundaries(lines);
  const spans = boundaries.length > 1 ? sectionSpans(lines, records, boundaries) : blockSpans(lines, records);
  const segments = spans.map((span, ordinal) => materializeSegment(source, buffer, records, span, ordinal));
  return {
    version: 1,
    sourceId: source.id,
    sourcePath: source.sourcePath,
    sourceSha256,
    segmenterVersion: 1,
    segments,
  };
}

export async function readSegmentText(workspaceRoot: string, segment: SourceSegment): Promise<string> {
  const absolute = path.resolve(workspaceRoot, segment.sourcePath);
  const relative = path.relative(workspaceRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Segment source escapes workspace: ${segment.sourcePath}`);
  const buffer = await fs.readFile(absolute);
  const slice = buffer.subarray(segment.startByte, segment.endByte);
  if (sha256(slice) !== segment.textSha256) throw new Error(`Segment source changed: ${segment.id}`);
  return slice.toString("utf8");
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
    records.push({ text: line, eol, startByte: byteOffset, endByte: byteOffset + bytes });
    byteOffset += bytes;
    if (!eol) break;
  }
  if (!records.length) records.push({ text: "", eol: "", startByte: 0, endByte: 0 });
  return records;
}

function findBoundaries(lines: string[]): number[] {
  const boundaries: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (HEADING_PATTERNS.some((pattern) => pattern.test(line))) boundaries.push(index);
  }
  if (boundaries.length && boundaries[0] !== 0 && lines.slice(0, boundaries[0]).some((line) => line.trim())) boundaries.unshift(0);
  return boundaries;
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

function splitOversized(lines: string[], records: LineRecord[], start: number, end: number): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = start;
  while (cursor <= end) {
    let blockEnd = cursor;
    let bytes = 0;
    let lastBlank = -1;
    while (blockEnd <= end && blockEnd - cursor < MAX_BLOCK_LINES) {
      const record = records[blockEnd]!;
      const nextBytes = record.endByte - record.startByte;
      if (blockEnd > cursor && bytes + nextBytes > MAX_BLOCK_BYTES) break;
      bytes += nextBytes;
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

function materializeSegment(
  source: SourceDocument,
  buffer: Buffer,
  records: LineRecord[],
  span: Span,
  ordinal: number,
): SourceSegment {
  const startByte = records[span.start]?.startByte ?? 0;
  const endByte = records[span.end]?.endByte ?? startByte;
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


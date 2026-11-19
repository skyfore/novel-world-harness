import crypto from "node:crypto";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import type { EvidenceRef } from "./model.js";
import { rangeWithinHorizon, type ReadHorizon } from "./read-horizon.js";

export const MAX_REFERENCE_CHARACTERS = 1_800;
export const MAX_TOTAL_REFERENCE_CHARACTERS = 6_000;
export const MAX_REFERENCES = 4;

export type NarrativeEvidenceCandidate = {
  evidence: readonly EvidenceRef[];
  relevance: readonly string[];
  anchors: readonly string[];
  /** Exact text already admitted to this actor; nearby source prose is not implied. */
  admittedTexts?: readonly string[];
  occurrenceId?: string;
};

/** Exact source prose admitted only as non-authoritative literary evidence. */
export type NarrativeSourceReference = {
  ref: string;
  occurrenceId?: string;
  sourceId: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  text: string;
  relevance: string[];
  /** style-only: committed actor-visible evidence; presentation-only: lead-in prose before the read horizon. */
  authority: "style-only" | "presentation-only";
  safety: "actor-visible-committed-evidence" | "read-horizon-prior-text";
};

/**
 * Build a small exact-prose corpus from evidence already attached to
 * actor-visible committed events AND exact already-visible text. Long admitted
 * texts may be cropped, but anchors never authorize neighboring prose. Any excerpt naming an unavailable entity
 * fails closed. This is deliberately separate from compiler full-source
 * retrieval: a narrator never receives arbitrary future canon.
 */
export async function buildNarrativeSourceReferences(input: {
  workspaceRoot: string;
  sourceId?: string;
  candidates: readonly NarrativeEvidenceCandidate[];
  forbiddenNames?: readonly string[];
}): Promise<NarrativeSourceReference[]> {
  if (!input.sourceId || !input.candidates.length) return [];
  const source = await (await WorkspaceStore.create(input.workspaceRoot)).getSource(input.sourceId);
  if (!source) return [];
  const buffer = await readSourceMaterial(input.workspaceRoot, source);
  const lines = lineRanges(buffer);
  const forbiddenNames = [...new Set((input.forbiddenNames ?? [])
    .map((value) => value.normalize("NFKC").trim())
    .filter((value) => Array.from(value).length >= 2))];
  const references: NarrativeSourceReference[] = [];
  const seen = new Set<string>();
  let totalCharacters = 0;

  for (const candidate of input.candidates) {
    for (const reference of candidate.evidence) {
      if (references.length >= MAX_REFERENCES || totalCharacters >= MAX_TOTAL_REFERENCE_CHARACTERS) return references;
      const span = reference.span;
      if (span.sourceId !== input.sourceId) continue;
      const bounds = evidenceBounds(span, lines, buffer.byteLength);
      if (!bounds) continue;
      const fullSlice = buffer.subarray(bounds.startByte, bounds.endByte);
      if (sha256(fullSlice) !== span.quoteHash) continue;
      const fullText = fullSlice.toString("utf8");
      if (!Buffer.from(fullText, "utf8").equals(fullSlice)) continue;
      for (const admitted of [...new Set(candidate.admittedTexts ?? [])]) {
        if (!admitted) continue;
        // Ambiguous repeated wording needs a narrower occurrence-specific span.
        const admittedStart = fullText.indexOf(admitted);
        if (admittedStart < 0 || fullText.indexOf(admitted, admittedStart + 1) >= 0) continue;
        const slice = boundedAnchoredExcerpt(admitted, candidate.anchors, MAX_REFERENCE_CHARACTERS);
        if (!slice) continue;
        const excerpt = { text: slice.text, start: admittedStart + slice.start, end: admittedStart + slice.end };
        if (containsForbiddenName(excerpt.text, forbiddenNames)) continue;
        const startByte = bounds.startByte + Buffer.byteLength(fullText.slice(0, excerpt.start), "utf8");
        const endByte = bounds.startByte + Buffer.byteLength(fullText.slice(0, excerpt.end), "utf8");
        const startLine = span.startLine + newlineCount(fullText.slice(0, excerpt.start));
        const endLine = startLine + newlineCount(excerpt.text);
        const identity = `${input.sourceId}:${startByte}:${endByte}:${candidate.occurrenceId ?? ""}`;
        if (seen.has(identity)) continue;
        const characters = Array.from(excerpt.text).length;
        if (references.length >= MAX_REFERENCES || totalCharacters + characters > MAX_TOTAL_REFERENCE_CHARACTERS) continue;
        seen.add(identity);
        totalCharacters += characters;
        references.push({
          ref: `source-style-${sha256(Buffer.from(identity)).slice(0, 24)}`,
          ...(candidate.occurrenceId ? { occurrenceId: candidate.occurrenceId } : {}),
          sourceId: input.sourceId,
          startByte, endByte, startLine, endLine,
          text: excerpt.text,
          relevance: [...new Set(candidate.relevance)].slice(0, 8),
          authority: "style-only",
          safety: "actor-visible-committed-evidence",
        });
      }
    }
  }
  return references;
}

/** A heading that starts a new chapter; lead-in prose never crosses it. */
const CHAPTER_HEADING = /^\s*(?:第[一二三四五六七八九十百千零〇两0-9]+[章节回幕卷部]|chapter\s+[0-9ivxlc]+\b|序章|楔子|尾声|终章)/iu;

/**
 * Lead-in prose for a scene entry: whole paragraphs that end before the read
 * horizon, nearest first, inside the same chapter, avoiding unresolved
 * events' mentions and any unavailable name. Fills only the budget left after
 * committed actor-visible references (D5); presentation-only authority.
 */
export async function buildLeadInReferences(input: {
  workspaceRoot: string;
  sourceId?: string;
  horizon: ReadHorizon;
  forbiddenNames?: readonly string[];
  used?: { references: number; characters: number };
}): Promise<NarrativeSourceReference[]> {
  const remainingReferences = MAX_REFERENCES - (input.used?.references ?? 0);
  const remainingCharacters = MAX_TOTAL_REFERENCE_CHARACTERS - (input.used?.characters ?? 0);
  if (!input.sourceId || remainingReferences <= 0 || remainingCharacters <= 0 || input.horizon.horizonByte <= 0) return [];
  const source = await (await WorkspaceStore.create(input.workspaceRoot)).getSource(input.sourceId);
  if (!source) return [];
  const buffer = await readSourceMaterial(input.workspaceRoot, source);
  const forbiddenNames = [...new Set((input.forbiddenNames ?? []).map((value) => value.normalize("NFKC").trim()).filter((value) => Array.from(value).length >= 2))];
  const lines = lineRanges(buffer);
  const paragraphs = lines.map((range, index) => ({ ...range, line: index + 1, text: buffer.subarray(range.startByte, range.endByte).toString("utf8").replace(/\r?\n$/u, "") }))
    .filter((paragraph) => paragraph.text.trim().length > 0 && Math.min(paragraph.endByte, input.horizon.horizonByte) === paragraph.endByte);
  const selected: Array<(typeof paragraphs)[number]> = [];
  let budget = Math.min(remainingCharacters, remainingReferences * MAX_REFERENCE_CHARACTERS);
  for (let index = paragraphs.length - 1; index >= 0 && budget > 0; index--) {
    const paragraph = paragraphs[index]!;
    if (CHAPTER_HEADING.test(paragraph.text)) break;
    if (!rangeWithinHorizon(input.horizon, paragraph.startByte, paragraph.endByte)) continue;
    const characters = Array.from(paragraph.text).length;
    if (characters > MAX_REFERENCE_CHARACTERS || characters > budget) break;
    if (containsForbiddenName(paragraph.text, forbiddenNames)) break;
    selected.unshift(paragraph);
    budget -= characters;
  }
  // Group adjacent paragraphs, nearest first, into at most the remaining number of references.
  const groups: Array<typeof selected> = [];
  for (let index = selected.length - 1; index >= 0; index--) {
    const paragraph = selected[index]!, current = groups.at(-1);
    const fits = current && current[0]!.line === paragraph.line + 1
      && Array.from([paragraph, ...current].map((item) => item.text).join("\n")).length <= MAX_REFERENCE_CHARACTERS;
    if (fits) current.unshift(paragraph);
    else if (groups.length < remainingReferences) groups.push([paragraph]);
    else break;
  }
  const references: NarrativeSourceReference[] = groups.reverse().map((group) => {
    const first = group[0]!, last = group.at(-1)!;
    const identity = `${input.sourceId}:${first.startByte}:${last.endByte}:lead-in`;
    return { ref: `source-lead-in-${sha256(Buffer.from(identity)).slice(0, 24)}`, sourceId: input.sourceId!, startByte: first.startByte, endByte: last.endByte,
      startLine: first.line, endLine: last.line, text: group.map((paragraph) => paragraph.text).join("\n"),
      relevance: ["scene lead-in before the read horizon"], authority: "presentation-only" as const, safety: "read-horizon-prior-text" as const };
  });
  return references.slice(0, remainingReferences);
}

function evidenceBounds(
  span: EvidenceRef["span"],
  lines: readonly { startByte: number; endByte: number }[],
  totalBytes: number,
): { startByte: number; endByte: number } | undefined {
  if (span.startLine > lines.length || span.endLine > lines.length) return undefined;
  const lineStart = lines[span.startLine - 1]?.startByte ?? 0;
  const lineEnd = lines[span.endLine - 1]?.endByte ?? lineStart;
  const startByte = span.startByte ?? lineStart;
  const endByte = span.endByte ?? lineEnd;
  if (startByte < lineStart || endByte > lineEnd || endByte <= startByte || endByte > totalBytes) return undefined;
  return { startByte, endByte };
}

function boundedAnchoredExcerpt(
  text: string,
  anchors: readonly string[],
  maxCharacters: number,
): { text: string; start: number; end: number } | undefined {
  if (Array.from(text).length <= maxCharacters) return { text, start: 0, end: text.length };
  const folded = text.normalize("NFKC").toLocaleLowerCase();
  const anchor = [...new Set(anchors
    .map((value) => value.normalize("NFKC").trim())
    .filter((value) => Array.from(value).length >= 2))]
    .sort((left, right) => Array.from(right).length - Array.from(left).length)
    .find((value) => folded.includes(value.toLocaleLowerCase()));
  if (!anchor) return undefined;
  // Direct source names and ordinary prose retain their UTF-16 offsets under
  // case folding. If normalization changed an offset, fall back to the direct
  // source spelling and otherwise omit rather than crop the wrong passage.
  let anchorIndex = text.toLocaleLowerCase().indexOf(anchor.toLocaleLowerCase());
  if (anchorIndex < 0) anchorIndex = text.indexOf(anchor);
  if (anchorIndex < 0) return undefined;
  const characters = Array.from(text);
  const prefixCharacters = Array.from(text.slice(0, anchorIndex)).length;
  const anchorCharacters = Array.from(text.slice(anchorIndex, anchorIndex + anchor.length)).length;
  const before = Math.max(0, Math.floor((maxCharacters - anchorCharacters) * 0.45));
  const startCharacter = Math.max(0, prefixCharacters - before);
  const endCharacter = Math.min(characters.length, startCharacter + maxCharacters);
  const adjustedStart = Math.max(0, endCharacter - maxCharacters);
  const excerptText = characters.slice(adjustedStart, endCharacter).join("");
  const start = characters.slice(0, adjustedStart).join("").length;
  return { text: excerptText, start, end: start + excerptText.length };
}

function containsForbiddenName(text: string, forbiddenNames: readonly string[]): boolean {
  const folded = text.normalize("NFKC").toLocaleLowerCase();
  return forbiddenNames.some((name) => folded.includes(name.toLocaleLowerCase()));
}

function newlineCount(value: string): number {
  return value.match(/\r\n|\r|\n/gu)?.length ?? 0;
}

function lineRanges(buffer: Buffer): Array<{ startByte: number; endByte: number }> {
  const text = buffer.toString("utf8");
  const ranges: Array<{ startByte: number; endByte: number }> = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  let match: RegExpExecArray | null;
  let byteOffset = 0;
  while ((match = pattern.exec(text)) !== null) {
    const body = match[1] ?? "";
    const eol = match[2] ?? "";
    if (!body && !eol && match.index === text.length) break;
    const bytes = Buffer.byteLength(body + eol, "utf8");
    ranges.push({ startByte: byteOffset, endByte: byteOffset + bytes });
    byteOffset += bytes;
    if (!eol) break;
  }
  if (!ranges.length) ranges.push({ startByte: 0, endByte: 0 });
  return ranges;
}

function sha256(value: Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

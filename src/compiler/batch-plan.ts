import crypto from "node:crypto";
import type { SourceDocument } from "../storage/workspace-store.js";
import type { SourceSegment } from "./segments.js";
import type { BoundaryCalibrationRequest } from "./boundary-calibration.js";
import { CHAPTER_SPLIT_DISCOVERY_VERSION } from "./chapter-split.js";
import { COMPILER_MAX_SEGMENTS_PER_BATCH } from "./limits.js";

export const COMPILER_SEMANTIC_STAGES = ["observation", "semantic", "executable"] as const;
export type CompilerSemanticStage = typeof COMPILER_SEMANTIC_STAGES[number];
export type CompilerPlanStage = CompilerSemanticStage | "structure" | "boundary";
export type CompilerBatchScope = { id: string; ordinal: number; stage: CompilerPlanStage; segmentIds: string[] };

export function chapterMetadataForSegments(segments: readonly SourceSegment[]): Map<string, { ordinal: number; title?: string }> {
  const result = new Map<string, { ordinal: number; title?: string }>();
  let ordinal = 0;
  for (const segment of segments) {
    const continuation = segment.kind === "section" && / \[\d+\]$/.test(segment.title ?? "");
    if (!continuation || ordinal === 0) ordinal += 1;
    const title = segment.title?.replace(/ \[\d+\]$/, "");
    result.set(segment.id, { ordinal, ...(title ? { title } : {}) });
  }
  return result;
}

export function groupCompilerSegments(segments: readonly SourceSegment[]): SourceSegment[][] {
  const chapters = chapterMetadataForSegments(segments);
  const groups: SourceSegment[][] = [];
  let current: SourceSegment[] = [], promptCharacters = 0, sourceBytes = 0;
  let currentChapter: number | undefined;
  for (const segment of segments) {
    const chapter = chapters.get(segment.id)!.ordinal;
    if (current.length && (chapter !== currentChapter || current.length >= COMPILER_MAX_SEGMENTS_PER_BATCH
      || promptCharacters + segment.promptCharacters > 48 * 1024 || sourceBytes + segment.bytes > 48 * 1024)) {
      groups.push(current); current = []; promptCharacters = 0; sourceBytes = 0;
    }
    current.push(segment); promptCharacters += segment.promptCharacters; sourceBytes += segment.bytes; currentChapter = chapter;
  }
  if (current.length) groups.push(current);
  return groups;
}

export function requiresStructureDiscovery(source: Pick<SourceDocument, "bytes">, segments: readonly SourceSegment[], hasChapterPlan: boolean) {
  return hasChapterPlan || (segments.length > 0 && segments.every((segment) => segment.kind === "block")
    && (segments.length > 1 || source.bytes >= 24 * 1024));
}
export function sourceBatchId(sourceId: string, groupOrdinal: number, stage: CompilerSemanticStage, segmentIds: readonly string[]) {
  const digest = crypto.createHash("sha256").update(segmentIds.join("\n")).digest("hex").slice(0, 12);
  return `batch-${sourceId}-${String(groupOrdinal + 1).padStart(5, "0")}-${stage}-${digest}`;
}

/** The status reader and compiler share grouping, identity and stage ordering. */
export function compilerScopePlan(source: SourceDocument, segments: readonly SourceSegment[], hasChapterPlan: boolean, boundaries: readonly BoundaryCalibrationRequest[]): CompilerBatchScope[] {
  const plan: CompilerBatchScope[] = [];
  if (requiresStructureDiscovery(source, segments, hasChapterPlan)) plan.push({ id: `structure-${source.id}-v${CHAPTER_SPLIT_DISCOVERY_VERSION}`, ordinal: 0, stage: "structure", segmentIds: [] });
  const groups = groupCompilerSegments(segments);
  for (const stage of COMPILER_SEMANTIC_STAGES) groups.forEach((group, index) => {
    const segmentIds = group.map((segment) => segment.id);
    plan.push({ id: sourceBatchId(source.id, index, stage, segmentIds), ordinal: plan.length, stage, segmentIds });
  });
  for (const boundary of boundaries) {
    const left = segments.find((segment) => segment.id === boundary.leftSegmentId);
    const right = segments.find((segment) => segment.id === boundary.rightSegmentId);
    if (left && right && right.ordinal === left.ordinal + 1) plan.push({ id: boundary.id, ordinal: plan.length, stage: "boundary", segmentIds: [left.id, right.id] });
  }
  return plan;
}

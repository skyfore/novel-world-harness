import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import type { SourceDocument } from "../storage/workspace-store.js";
import { canonicalJson } from "../world/canonical.js";
import { idSchema, type EvidenceAssertion, type TextAnchor } from "../world/model.js";
import type { SourceSegment } from "./segments.js";
import { baseStructuralUnits, type SourceStructureManifest } from "./structure.js";

export const sourceAccountingStatusSchema = z.enum([
  "represented",
  "background-only",
  "paratext",
  "duplicate-description",
  "unresolved",
  "intentionally-deferred",
]);
export type SourceAccountingStatus = z.infer<typeof sourceAccountingStatusSchema>;

export const sourceAccountingRecordSchema = z.object({
  version: z.literal(1),
  unitId: idSchema,
  status: sourceAccountingStatusSchema,
  annotationIds: z.array(idSchema),
  evidenceAssertionIds: z.array(idSchema),
  reason: z.string().min(1).max(1_000).optional(),
  reviewedBy: z.enum(["deterministic", "model", "human"]),
  reviewedAt: z.string().min(1),
  batchIds: z.array(idSchema),
}).strict();
export type SourceAccountingRecord = z.infer<typeof sourceAccountingRecordSchema>;

const semanticSpanSchema = z.object({
  id: idSchema,
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().positive(),
}).strict().refine((value) => value.endByte > value.startByte, "semantic span must be non-empty");

const batchReviewSchema = z.object({
  batchId: idSchema,
  reviewedAt: z.string().min(1),
  segments: z.array(z.object({
    segmentId: idSchema,
    startByte: z.number().int().nonnegative(),
    endByte: z.number().int().positive(),
    disposition: z.enum(["proposed", "no-artifacts"]),
    summary: z.string().min(1).max(500),
  }).strict()).min(1),
  evidenceSpans: z.array(semanticSpanSchema),
  annotationSpans: z.array(semanticSpanSchema),
}).strict();
type BatchReview = z.infer<typeof batchReviewSchema>;

const sourceAccountingManifestSchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  structureVersion: z.number().int().positive(),
  batchReviews: z.array(batchReviewSchema),
  records: z.array(sourceAccountingRecordSchema),
  updatedAt: z.string().min(1),
}).strict();
export type SourceAccountingManifest = z.infer<typeof sourceAccountingManifestSchema>;

export type SourceAccountingSummary = {
  sourceId: string;
  totalUnits: number;
  accountedUnits: number;
  unaccountedUnits: number;
  blockingUnits: number;
  accountedBytes: number;
  totalBytes: number;
  unitCoverage: number;
  byteCoverage: number;
  statusCounts: Record<SourceAccountingStatus, number>;
  missingUnitIds: string[];
  blockingUnitIds: string[];
};

export class SourceAccountingStore {
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceStateDir(workspaceRoot), "world", "v1", "compiler", "observations", "v1", "accounting");
  }

  async read(sourceId: string): Promise<SourceAccountingManifest | null> {
    idSchema.parse(sourceId);
    try {
      return sourceAccountingManifestSchema.parse(JSON.parse(await fs.readFile(this.filePath(sourceId), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async recordBatchReview(input: {
    source: SourceDocument;
    structure: SourceStructureManifest;
    batchId: string;
    reviews: Array<{ segment: SourceSegment; disposition: "proposed" | "no-artifacts"; summary: string }>;
    evidenceAssertions?: readonly EvidenceAssertion[];
    annotations?: ReadonlyArray<{ id: string; anchors: readonly TextAnchor[] }>;
  }): Promise<SourceAccountingManifest> {
    idSchema.parse(input.batchId);
    if (input.structure.sourceId !== input.source.id || input.structure.sourceSha256 !== input.source.contentSha256) {
      throw new Error(`Source accounting structure does not match source ${input.source.id}.`);
    }
    const reviewedAt = new Date().toISOString();
    const segments = input.reviews.map(({ segment, disposition, summary }) => {
      if (segment.sourceId !== input.source.id) {
        throw new Error(`Accounting review segment ${segment.id} belongs to ${segment.sourceId}, not ${input.source.id}.`);
      }
      return {
        segmentId: segment.id,
        startByte: segment.startByte,
        endByte: segment.endByte,
        disposition,
        summary,
      };
    });
    if (new Set(segments.map((segment) => segment.segmentId)).size !== segments.length) {
      throw new Error(`Accounting review ${input.batchId} contains duplicate source segments.`);
    }
    const evidenceSpans = uniqueSemanticSpans((input.evidenceAssertions ?? []).flatMap((assertion) =>
      assertion.anchors
        .filter((anchor) => anchor.sourceId === input.source.id)
        .map((anchor) => ({ id: assertion.id, startByte: anchor.startByte, endByte: anchor.endByte }))));
    const annotationSpans = uniqueSemanticSpans((input.annotations ?? []).flatMap((annotation) =>
      annotation.anchors
        .filter((anchor) => anchor.sourceId === input.source.id)
        .map((anchor) => ({ id: annotation.id, startByte: anchor.startByte, endByte: anchor.endByte }))));
    for (const span of [...evidenceSpans, ...annotationSpans]) {
      if (span.endByte > input.structure.sourceBytes) {
        throw new Error(`Accounting semantic span ${span.id} exceeds source ${input.source.id}.`);
      }
    }
    const review = batchReviewSchema.parse({
      batchId: input.batchId,
      reviewedAt,
      segments,
      evidenceSpans,
      annotationSpans,
    });
    const current = await this.read(input.source.id);
    const priorReviews = current
      && current.sourceSha256 === input.source.contentSha256
      && current.structureVersion === input.structure.structureVersion
      ? current.batchReviews.filter((candidate) => candidate.batchId !== input.batchId)
      : [];
    const batchReviews = [...priorReviews, review]
      .sort((left, right) => left.reviewedAt.localeCompare(right.reviewedAt) || left.batchId.localeCompare(right.batchId));
    const manifest = sourceAccountingManifestSchema.parse({
      version: 1,
      sourceId: input.source.id,
      sourceSha256: input.source.contentSha256,
      structureVersion: input.structure.structureVersion,
      batchReviews,
      records: deriveAccountingRecords(input.structure, batchReviews),
      updatedAt: reviewedAt,
    });
    await atomicJson(this.filePath(input.source.id), manifest);
    return manifest;
  }

  async summarize(structure: SourceStructureManifest): Promise<SourceAccountingSummary> {
    const manifest = await this.read(structure.sourceId);
    const records = manifest
      && manifest.sourceSha256 === structure.sourceSha256
      && manifest.structureVersion === structure.structureVersion
      ? manifest.records
      : [];
    const byUnit = new Map(records.map((record) => [record.unitId, record]));
    const base = baseStructuralUnits(structure);
    const statusCounts = emptyStatusCounts();
    let accountedBytes = 0;
    const missingUnitIds: string[] = [];
    const blockingUnitIds: string[] = [];
    for (const unit of base) {
      const record = byUnit.get(unit.id);
      if (!record) {
        missingUnitIds.push(unit.id);
        continue;
      }
      statusCounts[record.status] += 1;
      accountedBytes += unit.anchor.endByte - unit.anchor.startByte;
      if (record.status === "unresolved" || record.status === "intentionally-deferred") {
        blockingUnitIds.push(unit.id);
      }
    }
    return {
      sourceId: structure.sourceId,
      totalUnits: base.length,
      accountedUnits: base.length - missingUnitIds.length,
      unaccountedUnits: missingUnitIds.length,
      blockingUnits: blockingUnitIds.length,
      accountedBytes,
      totalBytes: structure.sourceBytes,
      unitCoverage: base.length ? (base.length - missingUnitIds.length) / base.length : 1,
      byteCoverage: structure.sourceBytes ? accountedBytes / structure.sourceBytes : 1,
      statusCounts,
      missingUnitIds,
      blockingUnitIds,
    };
  }

  async remove(sourceId: string): Promise<void> {
    idSchema.parse(sourceId);
    await fs.rm(this.filePath(sourceId), { force: true });
  }

  private filePath(sourceId: string): string {
    return path.join(this.root, `${sourceId}.json`);
  }
}

function deriveAccountingRecords(
  structure: SourceStructureManifest,
  reviews: readonly BatchReview[],
): SourceAccountingRecord[] {
  const records: SourceAccountingRecord[] = [];
  const allSegments = reviews.flatMap((review) => review.segments.map((segment) => ({ ...segment, review })));
  const evidenceSpans = reviews.flatMap((review) => review.evidenceSpans);
  const annotationSpans = reviews.flatMap((review) => review.annotationSpans);
  for (const unit of baseStructuralUnits(structure)) {
    if (unit.kind === "non-scene") {
      records.push(sourceAccountingRecordSchema.parse({
        version: 1,
        unitId: unit.id,
        status: "background-only",
        annotationIds: [],
        evidenceAssertionIds: [],
        reason: "Whitespace/non-scene source bytes are classified deterministically.",
        reviewedBy: "deterministic",
        reviewedAt: structure.generatedAt,
        batchIds: [],
      }));
      continue;
    }
    const overlapping = allSegments.filter(({ startByte, endByte }) =>
      rangesOverlap(unit.anchor.startByte, unit.anchor.endByte, startByte, endByte));
    if (!rangeCovered(
      unit.anchor.startByte,
      unit.anchor.endByte,
      overlapping.map(({ startByte, endByte }) => ({ startByte, endByte })),
    )) continue;
    const unitEvidence = uniqueIds(evidenceSpans
      .filter((span) => rangesOverlap(unit.anchor.startByte, unit.anchor.endByte, span.startByte, span.endByte))
      .map((span) => span.id));
    const unitAnnotations = uniqueIds(annotationSpans
      .filter((span) => rangesOverlap(unit.anchor.startByte, unit.anchor.endByte, span.startByte, span.endByte))
      .map((span) => span.id));
    const represented = unitEvidence.length > 0 || unitAnnotations.length > 0;
    const allBackground = overlapping.every(({ disposition }) => disposition === "no-artifacts");
    const status: SourceAccountingStatus = represented
      ? "represented"
      : allBackground
        ? "background-only"
        : "unresolved";
    const latestReview = [...new Set(overlapping.map(({ review }) => review))]
      .sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt))[0]!;
    records.push(sourceAccountingRecordSchema.parse({
      version: 1,
      unitId: unit.id,
      status,
      annotationIds: unitAnnotations,
      evidenceAssertionIds: unitEvidence,
      reason: status === "represented"
        ? "The unit overlaps an exact semantic assertion or committed source annotation."
        : status === "background-only"
          ? boundedReason(overlapping.map(({ summary }) => summary).join(" | "))
          : "The unit was reviewed in a proposal-bearing segment, but no exact assertion or source annotation covers it.",
      reviewedBy: "model",
      reviewedAt: latestReview.reviewedAt,
      batchIds: uniqueIds(overlapping.map(({ review }) => review.batchId)),
    }));
  }
  return records.sort((left, right) => left.unitId.localeCompare(right.unitId));
}

function rangeCovered(
  startByte: number,
  endByte: number,
  ranges: ReadonlyArray<{ startByte: number; endByte: number }>,
): boolean {
  const clipped = ranges
    .map((range) => ({ startByte: Math.max(startByte, range.startByte), endByte: Math.min(endByte, range.endByte) }))
    .filter((range) => range.endByte > range.startByte)
    .sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte);
  let cursor = startByte;
  for (const range of clipped) {
    if (range.startByte > cursor) return false;
    cursor = Math.max(cursor, range.endByte);
    if (cursor >= endByte) return true;
  }
  return cursor >= endByte;
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function uniqueSemanticSpans<T extends { id: string; startByte: number; endByte: number }>(values: readonly T[]): T[] {
  const byKey = new Map(values.map((value) => [`${value.id}:${value.startByte}:${value.endByte}`, value]));
  return [...byKey.values()].sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte || left.id.localeCompare(right.id));
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function boundedReason(value: string): string {
  const normalized = value.trim() || "The reviewed source unit yielded no semantic artifact.";
  return normalized.length <= 1_000 ? normalized : `${normalized.slice(0, 999)}…`;
}

function emptyStatusCounts(): Record<SourceAccountingStatus, number> {
  return {
    represented: 0,
    "background-only": 0,
    paratext: 0,
    "duplicate-description": 0,
    unresolved: 0,
    "intentionally-deferred": 0,
  };
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

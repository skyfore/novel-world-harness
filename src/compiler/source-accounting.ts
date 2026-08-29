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

/**
 * `represented` is host-derived from exact assertions/annotations. A model may
 * review every other semantic disposition, but it cannot declare evidence
 * coverage that does not exist.
 */
export const sourceUnitReviewStatusSchema = z.enum([
  "background-only",
  "paratext",
  "duplicate-description",
  "unresolved",
  "intentionally-deferred",
]);
export type SourceUnitReviewStatus = z.infer<typeof sourceUnitReviewStatusSchema>;

export const sourceUnitAccountingDecisionSchema = z.object({
  unitId: idSchema,
  status: sourceUnitReviewStatusSchema,
  reason: z.string().trim().min(1).max(1_000),
  proposalId: idSchema.optional(),
}).strict();
export type SourceUnitAccountingDecision = z.infer<typeof sourceUnitAccountingDecisionSchema>;

export const sourceAccountingProposalSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  sourceId: idSchema,
  compilerBatchId: idSchema,
  decisions: z.array(sourceUnitAccountingDecisionSchema.omit({ proposalId: true }))
    .min(1)
    .max(512)
    .refine((items) => new Set(items.map((item) => item.unitId)).size === items.length, "unit decisions must be unique"),
  generatedBy: z.object({
    worker: z.literal("account_source_units"),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  }).strict(),
  createdAt: z.string().datetime(),
}).strict();
export type SourceAccountingProposal = z.infer<typeof sourceAccountingProposalSchema>;
export type SourceAccountingProposalStatus = "pending" | "accepted" | "rejected";

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
  unitDecisions: z.array(sourceUnitAccountingDecisionSchema).default([]),
}).strict();
type BatchReview = z.infer<typeof batchReviewSchema>;

export const sourceAccountingManifestSchema = z.object({
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
    unitDecisions?: readonly SourceUnitAccountingDecision[];
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
      unitDecisions: input.unitDecisions ?? [],
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

  /**
   * Validate the prospective batch accounting before the finish handshake
   * commits any annotation/resolution state. Long-form source batches use this
   * as a deterministic completeness barrier.
   */
  validateBatchReview(input: {
    structure: SourceStructureManifest;
    reviews: Array<{ startByte: number; endByte: number; disposition: "proposed" | "no-artifacts" }>;
    evidenceAssertions?: readonly EvidenceAssertion[];
    annotations?: ReadonlyArray<{ id: string; anchors: readonly TextAnchor[] }>;
    unitDecisions?: readonly SourceUnitAccountingDecision[];
    requireExplicitSemanticDisposition?: boolean;
  }): string[] {
    const base = baseStructuralUnits(input.structure);
    const byId = new Map(base.map((unit) => [unit.id, unit]));
    const decisions = (input.unitDecisions ?? []).map((decision) => sourceUnitAccountingDecisionSchema.parse(decision));
    const issues: string[] = [];
    const seen = new Set<string>();
    const evidenceSpans = (input.evidenceAssertions ?? []).flatMap((assertion) => assertion.anchors);
    const annotationSpans = (input.annotations ?? []).flatMap((annotation) => annotation.anchors);
    for (const decision of decisions) {
      if (seen.has(decision.unitId)) {
        issues.push(`Source unit ${decision.unitId} has more than one active accounting decision.`);
        continue;
      }
      seen.add(decision.unitId);
      const unit = byId.get(decision.unitId);
      if (!unit) {
        issues.push(`Accounting decision references unknown base unit ${decision.unitId}.`);
        continue;
      }
      if (unit.kind === "non-scene") {
        issues.push(`Non-scene unit ${decision.unitId} is classified deterministically and cannot receive a model decision.`);
      }
      if (!rangeCovered(unit.anchor.startByte, unit.anchor.endByte, input.reviews)) {
        issues.push(`Accounting decision for ${decision.unitId} escapes the reviewed compiler slice.`);
      }
      const overlappingReviews = input.reviews.filter((review) =>
        rangesOverlap(unit.anchor.startByte, unit.anchor.endByte, review.startByte, review.endByte));
      if (overlappingReviews.length > 0
        && overlappingReviews.every((review) => review.disposition === "no-artifacts")) {
        issues.push(`Source unit ${decision.unitId} is inside a no-artifacts segment and is already host-classified as background-only.`);
      }
      const represented = [...evidenceSpans, ...annotationSpans].some((span) =>
        span.sourceId === input.structure.sourceId
        && rangesOverlap(unit.anchor.startByte, unit.anchor.endByte, span.startByte, span.endByte));
      if (represented) {
        issues.push(`Source unit ${decision.unitId} overlaps exact semantic evidence and is host-derived as represented; withdraw its model disposition.`);
      }
    }
    if (!input.requireExplicitSemanticDisposition) return issues;
    for (const unit of base) {
      if (unit.kind === "non-scene") continue;
      const overlappingReviews = input.reviews.filter((review) =>
        rangesOverlap(unit.anchor.startByte, unit.anchor.endByte, review.startByte, review.endByte));
      if (!rangeCovered(unit.anchor.startByte, unit.anchor.endByte, overlappingReviews)) continue;
      const represented = [...evidenceSpans, ...annotationSpans].some((span) =>
        span.sourceId === input.structure.sourceId
        && rangesOverlap(unit.anchor.startByte, unit.anchor.endByte, span.startByte, span.endByte));
      const allBackground = overlappingReviews.length > 0
        && overlappingReviews.every((review) => review.disposition === "no-artifacts");
      if (!represented && !allBackground && !seen.has(unit.id)) {
        issues.push(
          `Source unit ${unit.id} was reviewed inside a proposal-bearing segment but has neither exact semantic coverage nor an explicit account_source_units disposition.`,
        );
      }
    }
    return issues;
  }

  async stageProposal(proposalInput: SourceAccountingProposal): Promise<void> {
    const proposal = sourceAccountingProposalSchema.parse(proposalInput);
    const filePath = this.proposalPath(proposal.sourceId, "pending", proposal.id);
    try {
      const existing = sourceAccountingProposalSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
      if (canonicalJson(proposalIdentity(existing)) === canonicalJson(proposalIdentity(proposal))) return;
      throw new Error(`Pending source-accounting proposal ${proposal.id} already exists with different content; use a new proposal id.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const status of ["accepted", "rejected"] as const) {
      if (await exists(this.proposalPath(proposal.sourceId, status, proposal.id))) {
        throw new Error(`Source-accounting proposal ${proposal.id} already exists in ${status} history; use a new proposal id.`);
      }
    }
    await writeImmutable(filePath, proposal);
  }

  async readProposal(
    sourceIdInput: string,
    status: SourceAccountingProposalStatus,
    proposalIdInput: string,
  ): Promise<SourceAccountingProposal> {
    const sourceId = idSchema.parse(sourceIdInput);
    const proposalId = idSchema.parse(proposalIdInput);
    return sourceAccountingProposalSchema.parse(JSON.parse(
      await fs.readFile(this.proposalPath(sourceId, status, proposalId), "utf8"),
    ));
  }

  async listBatchProposals(
    sourceIdInput: string,
    compilerBatchIdInput: string,
  ): Promise<Array<{ id: string; status: SourceAccountingProposalStatus; createdAt: string }>> {
    const sourceId = idSchema.parse(sourceIdInput);
    const compilerBatchId = idSchema.parse(compilerBatchIdInput);
    const summaries: Array<{ id: string; status: SourceAccountingProposalStatus; createdAt: string }> = [];
    for (const status of ["pending", "accepted"] as const) {
      let names: string[];
      try {
        names = (await fs.readdir(this.proposalDirectory(sourceId, status)))
          .filter((name) => name.endsWith(".json"))
          .sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const name of names) {
        const proposal = await this.readProposal(sourceId, status, name.slice(0, -5));
        if (proposal.compilerBatchId === compilerBatchId) {
          summaries.push({ id: proposal.id, status, createdAt: proposal.createdAt });
        }
      }
    }
    return summaries.sort((left, right) => left.id.localeCompare(right.id));
  }

  async listProposals(
    sourceIdInput: string,
    status: SourceAccountingProposalStatus = "pending",
  ): Promise<SourceAccountingProposal[]> {
    const sourceId = idSchema.parse(sourceIdInput);
    let names: string[];
    try {
      names = (await fs.readdir(this.proposalDirectory(sourceId, status)))
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return Promise.all(names.map((name) => this.readProposal(sourceId, status, name.slice(0, -5))));
  }

  async withdrawProposal(sourceIdInput: string, proposalIdInput: string): Promise<void> {
    await this.transition(idSchema.parse(sourceIdInput), idSchema.parse(proposalIdInput), "pending", "rejected");
  }

  async acceptProposals(sourceIdInput: string, proposalIdsInput: readonly string[]): Promise<void> {
    const sourceId = idSchema.parse(sourceIdInput);
    for (const proposalId of [...new Set(proposalIdsInput.map((id) => idSchema.parse(id)))].sort()) {
      try {
        await this.transition(sourceId, proposalId, "pending", "accepted");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.readProposal(sourceId, "accepted", proposalId);
      }
    }
  }

  async rejectSourceProposals(sourceIdInput: string): Promise<string[]> {
    const sourceId = idSchema.parse(sourceIdInput);
    const rejected: string[] = [];
    let names: string[];
    try {
      names = (await fs.readdir(this.proposalDirectory(sourceId, "pending")))
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    for (const name of names) {
      const proposalId = name.slice(0, -5);
      await this.withdrawProposal(sourceId, proposalId);
      rejected.push(proposalId);
    }
    return rejected;
  }

  async rejectBatchProposals(sourceIdInput: string, compilerBatchIdInput: string): Promise<string[]> {
    const sourceId = idSchema.parse(sourceIdInput);
    const compilerBatchId = idSchema.parse(compilerBatchIdInput);
    const rejected: string[] = [];
    for (const summary of await this.listBatchProposals(sourceId, compilerBatchId)) {
      if (summary.status === "pending") {
        await this.withdrawProposal(sourceId, summary.id);
      } else {
        // A successful finish accepts accounting proposals before the outer
        // compiler loop checkpoints the batch. Reparse/incomplete-batch
        // invalidation must retire that accepted history too; otherwise a
        // later beginBatch would recover decisions from the invalidated run.
        await this.transition(sourceId, summary.id, "accepted", "rejected");
      }
      rejected.push(summary.id);
    }
    return rejected.sort();
  }

  /** Replace only the materialized accounting manifest; proposal history stays immutable. */
  async replace(manifestInput: SourceAccountingManifest | null): Promise<void> {
    if (!manifestInput) return;
    const manifest = sourceAccountingManifestSchema.parse(manifestInput);
    await atomicJson(this.filePath(manifest.sourceId), manifest);
  }

  async replaceCurrent(sourceIdInput: string, manifestInput: SourceAccountingManifest | null): Promise<void> {
    const sourceId = idSchema.parse(sourceIdInput);
    if (!manifestInput) {
      await this.remove(sourceId);
      return;
    }
    const manifest = sourceAccountingManifestSchema.parse(manifestInput);
    if (manifest.sourceId !== sourceId) {
      throw new Error(`Source-accounting snapshot belongs to ${manifest.sourceId}, not ${sourceId}.`);
    }
    await atomicJson(this.filePath(sourceId), manifest);
  }

  async removeBatchReviews(
    sourceIdInput: string,
    compilerBatchIdsInput: readonly string[],
    structure: SourceStructureManifest,
  ): Promise<number> {
    const sourceId = idSchema.parse(sourceIdInput);
    const compilerBatchIds = new Set(compilerBatchIdsInput.map((id) => idSchema.parse(id)));
    const current = await this.read(sourceId);
    if (!current || !compilerBatchIds.size) return 0;
    if (structure.sourceId !== sourceId
      || current.sourceSha256 !== structure.sourceSha256
      || current.structureVersion !== structure.structureVersion) {
      await this.remove(sourceId);
      return current.batchReviews.length;
    }
    const retained = current.batchReviews.filter((review) => !compilerBatchIds.has(review.batchId));
    const removed = current.batchReviews.length - retained.length;
    if (!removed) return 0;
    await atomicJson(this.filePath(sourceId), sourceAccountingManifestSchema.parse({
      ...current,
      batchReviews: retained,
      records: deriveAccountingRecords(structure, retained),
      updatedAt: new Date().toISOString(),
    }));
    return removed;
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

  private proposalDirectory(sourceId: string, status: SourceAccountingProposalStatus): string {
    return path.join(this.root, "proposals", idSchema.parse(sourceId), status);
  }

  private proposalPath(sourceId: string, status: SourceAccountingProposalStatus, proposalId: string): string {
    return path.join(this.proposalDirectory(sourceId, status), `${idSchema.parse(proposalId)}.json`);
  }

  private async transition(
    sourceId: string,
    proposalId: string,
    from: SourceAccountingProposalStatus,
    to: Exclude<SourceAccountingProposalStatus, "pending">,
  ): Promise<void> {
    const source = this.proposalPath(sourceId, from, proposalId);
    const target = this.proposalPath(sourceId, to, proposalId);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      await fs.rename(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw Object.assign(new Error(`Source-accounting proposal not found: ${proposalId}`), { code: "ENOENT" });
      }
      throw error;
    }
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
    const explicitDecision = [...overlapping]
      .sort((left, right) => right.review.reviewedAt.localeCompare(left.review.reviewedAt)
        || right.review.batchId.localeCompare(left.review.batchId))
      .flatMap(({ review }) => review.unitDecisions)
      .find((decision) => decision.unitId === unit.id);
    const status: SourceAccountingStatus = represented
      ? "represented"
      : explicitDecision?.status
        ? explicitDecision.status
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
        : explicitDecision
          ? explicitDecision.reason
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

function proposalIdentity(proposal: SourceAccountingProposal): unknown {
  return {
    version: proposal.version,
    id: proposal.id,
    sourceId: proposal.sourceId,
    compilerBatchId: proposal.compilerBatchId,
    decisions: proposal.decisions,
    generatedBy: proposal.generatedBy,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeImmutable(filePath: string, value: unknown): Promise<void> {
  const serialized = `${canonicalJson(value)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await fs.readFile(filePath, "utf8")) !== serialized) {
      throw new Error(`Source-accounting proposal already exists with different content: ${filePath}`);
    }
  }
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

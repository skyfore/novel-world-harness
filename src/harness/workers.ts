import type { HarnessWorker } from "./types.js";
import { writeMetric } from "./metrics.js";

const segmentSourceWorker: HarnessWorker = {
  type: "segment-source",
  async execute(ctx, job) {
    const input = job.input as { documentId?: string };
    if (!input.documentId) throw new Error("segment-source requires documentId");

    const result = await ctx.db.query(
      `SELECT id, content_sha256, source_path FROM source_documents WHERE id = $1 AND project_id = $2`,
      [input.documentId, ctx.projectId],
    );
    if (!result.rowCount) throw new Error(`Source document not found: ${input.documentId}`);

    // The initial scaffold intentionally does not guess a universal chapter/scene splitter.
    // The first production worker should load the source text and create hierarchical
    // chapter/scene/dialogue segments with offsets and evidence-preserving boundaries.
    await writeMetric(ctx.db, ctx.projectId, "source", 0.01, {
      note: "Document registered. Production segmentation worker is the next implementation milestone.",
    });

    return { registered: true, documentId: input.documentId };
  },
};

const verifyWorker: HarnessWorker = {
  type: "verify-model",
  async execute(ctx) {
    const metrics = await ctx.db.query(
      `SELECT metric, value FROM harness_metrics WHERE project_id = $1 ORDER BY metric`,
      [ctx.projectId],
    );
    return { metrics: metrics.rows };
  },
};

export function initialWorkers(): HarnessWorker[] {
  return [segmentSourceWorker, verifyWorker];
}

import type { HarnessWorker } from "./types.js";
import { writeMetric } from "./metrics.js";

const segmentSourceWorker: HarnessWorker = {
  type: "segment-source",
  async execute(ctx, job) {
    const input = job.input as { documentId?: string };
    if (!input.documentId) throw new Error("segment-source requires documentId");

    const source = await ctx.store.getSource(input.documentId);
    if (!source) throw new Error(`Source document not found: ${input.documentId}`);

    // The initial scaffold intentionally does not guess a universal chapter/scene splitter.
    // The first production worker should load the source text and create hierarchical
    // chapter/scene/dialogue segments with offsets and evidence-preserving boundaries.
    await writeMetric(ctx.store, "source", 0.01, {
      note: "Document registered. Production segmentation worker is the next implementation milestone.",
      sourcePath: source.sourcePath,
    });

    return { registered: true, documentId: input.documentId };
  },
};

const verifyWorker: HarnessWorker = {
  type: "verify-model",
  async execute(ctx) {
    return { metrics: await ctx.store.readMetrics() };
  },
};

export function initialWorkers(): HarnessWorker[] {
  return [segmentSourceWorker, verifyWorker];
}

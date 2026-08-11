import { SegmentStore, segmentSource } from "../compiler/segments.js";
import type { HarnessWorker } from "./types.js";
import { writeMetric } from "./metrics.js";

const segmentSourceWorker: HarnessWorker = {
  type: "segment-source",
  async execute(ctx, job) {
    const input = job.input as { documentId?: string };
    if (!input.documentId) throw new Error("segment-source requires documentId");

    const source = await ctx.store.getSource(input.documentId);
    if (!source) throw new Error(`Source document not found: ${input.documentId}`);

    const manifest = await segmentSource(ctx.store.root, source);
    await new SegmentStore(ctx.store.root).write(manifest);
    const coveredBytes = manifest.segments.reduce((sum, segment) => sum + segment.bytes, 0);
    const coverage = source.bytes === 0 ? 1 : Math.min(1, coveredBytes / source.bytes);
    await writeMetric(ctx.store, "source", coverage, {
      sourcePath: source.sourcePath,
      sourceSha256: source.contentSha256,
      segments: manifest.segments.length,
      coveredBytes,
      sourceBytes: source.bytes,
      segmenterVersion: manifest.segmenterVersion,
      note: "Source segmentation is deterministic evidence indexing only; semantic artifacts still require proposal/validation/commit.",
    });

    return {
      documentId: input.documentId,
      sourcePath: source.sourcePath,
      segments: manifest.segments.length,
      coveredBytes,
      coverage,
    };
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

import { isDeepStrictEqual } from "node:util";
import type { SourceDocument } from "../../storage/workspace-store.js";
import { chapterMetadataForSegments } from "../batch-plan.js";
import { SegmentStore, segmentSource } from "../segments.js";
import { ensureSourceStructure } from "../structure.js";
import type { PipelineRange } from "./store.js";

export type SourceChapter = PipelineRange & { ordinal: number; title?: string };

/**
 * Source stage: deterministic segmentation and structure from the immutable
 * bytes. No model call and no chapter-split discovery; headings the segmenter
 * recognises (第N章/回/幕, 序幕, Chapter N…) delimit chapters.
 */
export async function prepareSourceStage(root: string, source: SourceDocument): Promise<SourceChapter[]> {
  const store = new SegmentStore(root);
  const manifest = await segmentSource(root, source, { chapterSplitPlan: null });
  const persisted = await store.readManifest(source.id);
  if (!persisted || !isDeepStrictEqual(persisted, manifest)) await store.write(manifest);
  await ensureSourceStructure(root, source);
  return sourceChapters(root, source.id);
}

export async function sourceChapters(root: string, sourceId: string): Promise<SourceChapter[]> {
  const segments = await new SegmentStore(root).list(sourceId);
  if (!segments.length) throw new Error(`PIPELINE_SOURCE_STAGE_REQUIRED: run compile-novel source --source ${sourceId} first.`);
  const metadata = chapterMetadataForSegments(segments);
  const chapters: SourceChapter[] = [];
  for (const segment of segments) {
    const chapter = metadata.get(segment.id)!;
    const last = chapters.at(-1);
    if (last && last.ordinal === chapter.ordinal) last.endByte = segment.endByte;
    else chapters.push({ ordinal: chapter.ordinal, ...(chapter.title ? { title: chapter.title } : {}), startByte: segment.startByte, endByte: segment.endByte });
  }
  return chapters;
}

/** Prefix compile: the byte limit for `--through-chapter n` (1-based) or `--through-byte`. */
export function prefixLimit(chapters: readonly SourceChapter[], sourceBytes: number, options: { throughChapter?: number; throughByte?: number }): number {
  if (options.throughChapter !== undefined && options.throughByte !== undefined) throw new Error("Choose --through-chapter or --through-byte, not both.");
  if (options.throughChapter !== undefined) {
    const chapter = chapters.find((item) => item.ordinal === options.throughChapter);
    if (!chapter) throw new Error(`Unknown chapter ${options.throughChapter}; the source has ${chapters.length} chapter(s).`);
    return chapter.endByte;
  }
  if (options.throughByte !== undefined) {
    // Never cut a chapter's last sentence in half: snap to the containing chapter end when the byte falls on its final unit.
    if (options.throughByte <= 0 || options.throughByte > sourceBytes) throw new Error(`--through-byte must be in 1..${sourceBytes}.`);
    return options.throughByte;
  }
  return sourceBytes;
}

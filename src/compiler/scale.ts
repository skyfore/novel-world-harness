/** Event count remains useful after compilation, but cannot detect under-extraction by itself. */
export const NOVEL_SCALE_EVENT_THRESHOLD = 20;

/** Long-form input must receive novel-scale gates even when too few events were extracted. */
export const NOVEL_SCALE_SOURCE_BYTE_THRESHOLD = 24 * 1024;

export function isNovelScaleCompilation(sourceBytes: number, eventCount: number): boolean {
  return sourceBytes >= NOVEL_SCALE_SOURCE_BYTE_THRESHOLD
    || eventCount >= NOVEL_SCALE_EVENT_THRESHOLD;
}

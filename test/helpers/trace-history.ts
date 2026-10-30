import { TraceStore } from "../../src/trace/store.js";

/** Retain real settled runs beyond the recent-discovery limit. These carry no
 * model calls and must never change an older operation's recovery authority. */
export async function appendUnrelatedTraceHistory(store: TraceStore, sourceId: string, count = 1_001) {
  for (let index = 0; index < count; index++) {
    const run = await store.createRun({ kind: "prepare", sourceId, operationId: "unrelated-retained-work" });
    await store.finishRun(run.id, "succeeded");
  }
}

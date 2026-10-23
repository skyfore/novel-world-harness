import { TraceStore } from "../trace/store.js";
import { contentHash } from "../world/canonical.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { representationOutputSchema, type RepresentationRecord } from "./source-representation.js";

/** Verify actual Pi submission provenance, not a caller-provided model label. */
export async function verifyRepresentationTrace(root: string, record: RepresentationRecord) {
  const store = new TraceStore(root), run = await store.peekRun(record.traceRunId), events = await store.peekEvents(record.traceRunId);
  const requests = events.filter(e => e.type === "llm.request.started");
  const submissions = events.filter(e => e.type === "tool.call.completed" && e.data?.toolName === "submit_source_representation");
  const allowed = ["read_representation_source", "read_representation_annotations", "submit_source_representation"];
  const provenance = events.filter(e => e.type === "stage.started" && e.data?.phase === "source-representation-session");
  if (run.status !== "succeeded" || !run.endedAt || run.sourceId !== record.scope.prerequisiteScope.sourceId
    || run.operationId !== `representation-${record.scope.taskId}-${record.phase}` || run.counts.retries
    || !requests.length || requests.some(e => e.data?.providerId !== record.provider || e.data?.modelId !== record.model)
    || submissions.length !== 1 || events.some(e => e.type.startsWith("world.commit.") || e.type === "llm.response.failed"
      || (e.type === "tool.call.started" && !allowed.includes(String(e.data?.toolName))))
    || provenance.length !== 1 || provenance[0]!.data?.sessionId !== record.sessionId
    || provenance[0]!.data?.scopeHash !== contentHash(record.scope) || provenance[0]!.data?.inputHash !== record.inputHash
    || provenance[0]!.data?.subscription !== true) throw prerequisiteStop("Pi prerequisite trace or subscription provenance is incomplete");
  for (const start of events.filter(e => e.type === "tool.call.started")) {
    if (!events.some(e => ["tool.call.completed", "tool.call.failed"].includes(e.type) && e.toolCallId === start.toolCallId && e.seq > start.seq)) throw prerequisiteStop("Unsettled tool call in prerequisite trace");
  }
  const start = events.find(e => e.type === "tool.call.started" && e.toolCallId === submissions[0]!.toolCallId);
  if (!start?.blobRef || contentHash(representationOutputSchema.parse(await store.peekBlob(start.blobRef))) !== contentHash(record.output)) throw prerequisiteStop("Stored proposal is not the actual Pi tool submission");
}

import { TraceStore } from "../trace/store.js";
import { contentHash } from "../world/canonical.js";
import { prerequisiteOutputSchema, prerequisiteStop, type PrerequisiteRecord } from "./role-source-prerequisites.js";

/** Verify actual Pi submission provenance, not a caller-provided model label. */
export async function verifyPrerequisiteTrace(root: string, record: PrerequisiteRecord) {
  const store = new TraceStore(root), run = await store.peekRun(record.traceRunId), events = await store.peekEvents(record.traceRunId);
  const requests = events.filter(e => e.type === "llm.request.started");
  const submissions = events.filter(e => e.type === "tool.call.completed" && e.data?.toolName === "submit_source_prerequisite");
  const allowed = record.phase.startsWith("binding")
    ? ["read_prerequisite_source", "discover_prerequisite_dependencies", "submit_source_prerequisite"]
    : ["read_prerequisite_source", "submit_source_prerequisite"];
  const provenance = events.filter(e => e.type === "stage.started" && e.data?.phase === "source-prerequisite-session");
  if (run.status !== "succeeded" || !run.endedAt || run.sourceId !== record.scope.sourceId
    || run.operationId !== `prerequisite-${record.taskId}-${record.phase}` || run.counts.retries
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
  if (!start?.blobRef || contentHash(prerequisiteOutputSchema.parse(await store.peekBlob(start.blobRef))) !== contentHash(record.output)) throw prerequisiteStop("Stored proposal is not the actual Pi tool submission");
}

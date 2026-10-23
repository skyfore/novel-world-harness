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
  const request = requests.findLast(e => e.seq < start.seq);
  const source = new Set<string>(), findings = new Set<string>(), candidates = new Set<string>();
  let discovered = false;
  // Sibling tool calls in one assistant response cannot read each other's
  // results. Public verification enforces the same boundary as the live tools.
  for (const end of events.filter(e => e.type === "tool.call.completed" && request && e.seq < request.seq)) {
    const begin = events.find(e => e.type === "tool.call.started" && e.toolCallId === end.toolCallId);
    if (!begin?.blobRef) continue;
    const args = await store.peekBlob(begin.blobRef) as { segmentId?: string; findingId?: string; candidateId?: string };
    if (end.data?.toolName === "read_prerequisite_source" && args.segmentId) source.add(args.segmentId);
    if (end.data?.toolName === "discover_prerequisite_dependencies") {
      discovered = true;
      if (args.findingId) findings.add(args.findingId);
      if (args.candidateId) candidates.add(args.candidateId);
    }
  }
  if (record.evidence.some(e => !source.has(e.selector.segment_id))) throw prerequisiteStop("Prerequisite source was not delivered to a model request before submission");
  if (record.phase.startsWith("binding")) {
    const { RequirementLedger } = await import("./requirement-ledger.js");
    const binding = record.phase === "binding" ? record.output
      : (await new RequirementLedger(root, record.scope.sourceId).sourcePrerequisites(record.taskId)).find(r => r.phase === "binding")?.output;
    if (!discovered || binding?.phase !== "binding"
      || binding.bindings.some(b => b.findingIds.some(id => !findings.has(id)) || b.candidateIds.some(id => !candidates.has(id)))) {
      throw prerequisiteStop("Prerequisite dependencies were not delivered to a model request before submission");
    }
  }
}

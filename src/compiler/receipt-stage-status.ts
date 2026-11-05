import { TraceStore } from "../trace/store.js";
import { inspectProcessLiveness, WorkspaceOperationLock, type WorkspaceLockOwner } from "../util/workspace-lock.js";

/** No writes and no inference of liveness from timestamps or a foreign PID. */
export async function inspectReceiptStageActivity(root: string, sourceId: string, operation: string, invocation: Pick<WorkspaceLockOwner, "pid" | "host"> | null) {
  if (!invocation) return undefined;
  const lock = await WorkspaceOperationLock.inspect(root);
  const owner = invocation.host ? invocation : lock.owner?.pid === invocation.pid ? lock.owner : invocation;
  const processLiveness = await inspectProcessLiveness(owner);
  const runs = await new TraceStore(root).peekRunsByOperation(sourceId, operation);
  const run = runs.length === 1 ? runs[0] : undefined;
  const events = run ? await new TraceStore(root).peekEvents(run.id) : [];
  return { processLiveness, traceRunId: run?.id ?? null, lastActivityAt: events.at(-1)?.observedAt ?? run?.startedAt ?? null,
    state: processLiveness === "exited" ? "orphaned" : processLiveness === "alive" ? "RUNNING" : "liveness-unknown" };
}

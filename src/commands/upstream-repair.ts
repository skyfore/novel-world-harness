import { loadConfig, profileForRole } from "../config/load.js";
import { runUpstreamRepairModelSlot, recoverUpstreamRepairModelSession } from "../compiler/pi-upstream-repair.js";
import { upstreamRepairKindSchema } from "../compiler/upstream-repair-plan.js";
import { idSchema } from "../world/model.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";

/** The CLI never creates or expands authority as a side effect of running a slot. */
export async function runUpstreamRepairSlotCommand(root: string, options: {
  source: string; plan: string; kind: string; artifact: string; config?: string; model?: string; timeoutMs?: number;
}, run: typeof runUpstreamRepairModelSlot = runUpstreamRepairModelSlot) {
  const sourceId = idSchema.parse(options.source);
  const target = { kind: upstreamRepairKindSchema.parse(options.kind), id: idSchema.parse(options.artifact) };
  // Explicit configuration errors are host setup failures, before a model reservation.
  const profile = options.config ? profileForRole(await loadConfig(options.config), "extractor").profile : undefined;
  return withWorkspaceOperationLock(root, "compiler", () => run(root, sourceId, options.plan, target, {
    ...(profile ? { profile } : {}), ...(options.model ? { model: options.model } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  }));
}

export async function recoverUpstreamRepairSessionCommand(root: string, sourceId: string, sessionRef: string) {
  idSchema.parse(sourceId);
  return withWorkspaceOperationLock(root, "compiler", () => recoverUpstreamRepairModelSession(root, sourceId, sessionRef));
}

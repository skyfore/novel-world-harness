import fs from "node:fs/promises";
import { UpstreamRepairLedger } from "../compiler/upstream-repair-ledger.js";
import { upstreamRepairPlanSchema } from "../compiler/upstream-repair-plan.js";
import { compilerFinishInputSchema } from "../compiler/finish-input.js";
import { prepareUpstreamRepairFinish, executeUpstreamRepairFinish } from "../compiler/upstream-repair-finish.js";
import { upstreamRepairHostError } from "../compiler/upstream-repair-preflight.js";
import { contentHash } from "../world/canonical.js";
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

export async function stageUpstreamRepairPlanCommand(root: string, options: { source: string; plan: string; config?: string; model?: string; timeoutMs?: number }) {
  const { stageUpstreamRepairPlan } = await import("../compiler/upstream-repair-scheduler.js");
  const sourceId = idSchema.parse(options.source);
  const profile = options.config ? profileForRole(await loadConfig(options.config), "extractor").profile : undefined;
  return withWorkspaceOperationLock(root, "compiler", () => stageUpstreamRepairPlan(root, sourceId, options.plan, {
    ...(profile ? { profile } : {}), ...(options.model ? { model: options.model } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  }));
}

/** Register exact frozen host policy; registration itself grants no write authority. */
export async function registerUpstreamRepairPlanCommand(root: string, sourceId: string, planFile: string, predecessor: string | null = null) {
  idSchema.parse(sourceId);
  const plan = upstreamRepairPlanSchema.parse(JSON.parse(await fs.readFile(planFile, "utf8")));
  if (plan.sourceScope.sourceId !== sourceId) throw upstreamRepairHostError("Plan source differs from --source; preserve the frozen plan and correct the host selection, never rewrite its hash");
  return withWorkspaceOperationLock(root, "compiler", async () => {
    const ledger = new UpstreamRepairLedger(root, sourceId);
    await ledger.register(plan, predecessor);
    return (await ledger.inspect()).plans.find(item => item.plan.planHash === plan.planHash)!;
  });
}

export async function authorizeUpstreamRepairPlanCommand(root: string, sourceId: string, planHash: string) {
  idSchema.parse(sourceId);
  return withWorkspaceOperationLock(root, "compiler", async () => {
    const ledger = new UpstreamRepairLedger(root, sourceId);
    await ledger.authorize(planHash);
    return (await ledger.inspect()).plans.find(item => item.plan.planHash === planHash)!;
  });
}

/** Recovery consumes the original frozen input, even after partially committed output. */
export async function finishUpstreamRepairPlanCommand(root: string, sourceId: string, planHash: string, inputFile?: string) {
  idSchema.parse(sourceId);
  const input = inputFile ? compilerFinishInputSchema.parse(JSON.parse(await fs.readFile(inputFile, "utf8"))) : undefined;
  return withWorkspaceOperationLock(root, "compiler", async () => {
    const ledger = new UpstreamRepairLedger(root, sourceId);
    const current = (await ledger.inspect()).plans.find(item => item.plan.planHash === planHash);
    if (!current) throw upstreamRepairHostError("Plan is missing; inspect-upstream plans[].plan.planHash is the exact selector. Correct once without guessing");
    if (current.finishIntent) {
      if (input && contentHash(input) !== contentHash(current.finishIntent.input)) throw upstreamRepairHostError("Original frozen finish input changed; omit --input to recover the original receipt, never replace the reviewed segments or summary");
    } else {
      if (!input) throw upstreamRepairHostError("First finish requires --input with the original host review; do not fabricate source review or replay model slots");
      await prepareUpstreamRepairFinish(root, sourceId, planHash, input);
    }
    const receipt = await executeUpstreamRepairFinish(root, sourceId, planHash);
    return { planHash, state: (await ledger.inspect()).plans.find(item => item.plan.planHash === planHash)!.state, receipt };
  });
}

export async function stopUpstreamRepairPlanCommand(root: string, sourceId: string, planHash: string, reason: string) {
  idSchema.parse(sourceId);
  if (!reason.trim()) throw upstreamRepairHostError("Stopping a plan requires the original host diagnostic or review reason");
  return withWorkspaceOperationLock(root, "compiler", async () => {
    const ledger = new UpstreamRepairLedger(root, sourceId);
    await ledger.stop(planHash, reason);
    return (await ledger.inspect()).plans.find(item => item.plan.planHash === planHash)!;
  });
}

export async function planUpstreamRepairCommand(root: string, reviewFile: string) {
  const { planUpstreamRepair } = await import("../compiler/upstream-repair-planner.js");
  const review: unknown = JSON.parse(await fs.readFile(reviewFile, "utf8"));
  return withWorkspaceOperationLock(root, "compiler", () => planUpstreamRepair(root, review));
}

import { UpstreamRepairLedger } from "./upstream-repair-ledger.js";
import { runUpstreamRepairModelSlot, recoverUpstreamRepairModelSession, type UpstreamRepairModelOptions } from "./pi-upstream-repair.js";
import { recoverUpstreamRepairStage } from "./upstream-repair-staging.js";
import { upstreamRepairHostError, verifyUpstreamRepairPlan } from "./upstream-repair-preflight.js";
import { upstreamRepairPlanSchema, type UpstreamRepairPlan } from "./upstream-repair-plan.js";

/** Edges point from consumer to prerequisite. Include read-only intermediate nodes. */
export function upstreamRepairSlotOrder(raw: UpstreamRepairPlan) {
  const plan = upstreamRepairPlanSchema.parse(raw);
  const slots = new Map([...plan.allowedWrites, ...plan.allowedCreations].map(slot => [`${slot.kind}:${slot.id}`, { kind: slot.kind, id: slot.id }]));
  const done = new Set<string>(), order: Array<{ kind: (typeof plan.allowedWrites)[number]["kind"]; id: string }> = [];
  const visit = (node: string) => {
    if (done.has(node)) return;
    for (const dependency of plan.dependencyEdges.filter(edge => edge.from === node).map(edge => edge.to).sort()) visit(dependency);
    done.add(node);
    const slot = slots.get(node); if (slot) order.push(slot);
  };
  for (const node of [...slots.keys()].sort()) visit(node);
  return order;
}

/** Caller holds compiler lock. Sequential, no retry loop, no inferred or expanded authority. */
export async function stageUpstreamRepairPlan(root: string, sourceId: string, planHash: string,
  options: UpstreamRepairModelOptions = {}, runSlot: typeof runUpstreamRepairModelSlot = runUpstreamRepairModelSlot) {
  options.signal?.throwIfAborted();
  const ledger = new UpstreamRepairLedger(root, sourceId);
  let state = await ledger.inspect();
  const current = state.plans.find(item => item.plan.planHash === planHash);
  if (!current || !["authorized", "staging"].includes(current.state)) throw upstreamRepairHostError("Scheduler requires an existing authorized or staging plan; inspect-upstream plans[].plan.planHash, and do not replay a stopped or finished plan");
  try { await verifyUpstreamRepairPlan(root, current.plan); }
  catch (error) { await ledger.stop(planHash, String(error)); throw error; }
  // Recover only original validated output. An empty reservation cannot become a new call.
  for (const session of state.modelSessions.filter(item => item.started.planHash === planHash && !item.closed)) {
    await recoverUpstreamRepairModelSession(root, sourceId, session.sessionRef);
  }
  state = await ledger.inspect();
  // Verify all retained successful results before spending another model invocation.
  for (const attempt of state.attempts.filter(item => item.started.planHash === planHash && !item.failed)) {
    await recoverUpstreamRepairStage(root, sourceId, planHash, attempt.attemptRef);
  }
  const results = [];
  for (const target of upstreamRepairSlotOrder(current.plan)) {
    options.signal?.throwIfAborted();
    state = await ledger.inspect();
    const retained = state.attempts.find(item => item.started.planHash === planHash && item.started.artifactKind === target.kind && item.started.artifactId === target.id && item.staged);
    if (retained) {
      results.push({ target, reused: true, ...await recoverUpstreamRepairStage(root, sourceId, planHash, retained.attemptRef) });
    } else {
      await runSlot(root, sourceId, planHash, target, options);
      const actual = (await ledger.inspect()).attempts.find(item => item.started.planHash === planHash && item.started.artifactKind === target.kind && item.started.artifactId === target.id && item.staged);
      if (!actual) throw upstreamRepairHostError("Slot runner returned without a durable staged result; preserve the original plan and stop, never infer success from model text");
      results.push({ target, reused: false, ...await recoverUpstreamRepairStage(root, sourceId, planHash, actual.attemptRef) });
    }
  }
  return { planHash, phase: "staged" as const, results };
}

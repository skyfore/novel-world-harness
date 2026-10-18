import { createHash } from "node:crypto";

/** A hard account quota is different from transient per-minute throttling. */
export function isCompilerUsageLimit(message: string): boolean {
  return /usage[_ -]?limit|usage_limit_reached|insufficient_quota|you(?:'|’)ve hit.*limit|5.?hour.*limit|weekly.*limit|额度.*(?:耗尽|用完)|用量.*上限/i.test(message);
}
export function compilerFailureFingerprint(message: string): string {
  const stable = message
    .replace(/\b(?:run|batch)-[\w-]+/g, "<run-or-batch>")
    .replace(/\b[a-f0-9]{24,64}\b/g, "<hash>")
    .replace(/\s+/g, " ").trim();
  return createHash("sha256").update(stable).digest("hex");
}

/** A flat audit metric or a different target is not proof that a repair failed. */
export function compilerFailureRepeatedAfterRepair(
  currentFingerprint: string,
  repair: { failureFingerprint: string; repairId: string } | undefined,
): boolean {
  return Boolean(repair?.repairId.trim() && repair.failureFingerprint === currentFingerprint);
}
/** User-supplied reset anchor, advanced in five-hour windows; never retry before reset. */
export function nextCompilerReset(now: Date, anchor: Date): Date {
  const period = 5 * 60 * 60 * 1_000;
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(anchor.getTime())) throw new Error("Invalid quota reset time.");
  const windows = Math.max(0, Math.floor((now.getTime() - anchor.getTime()) / period) + 1);
  return new Date(anchor.getTime() + windows * period);
}
/** Kept as an explicit stop for retained external hooks. Compiler observations
 * belong to the serialized supervisor, never an originating-chat wakeup. */
export async function queueCodexCompileCallback(_threadId: string, _message: string): Promise<string> {
  throw new Error("COMPILE_LOOP_DEDICATED_SESSION_REQUIRED: Preserve the passive hook observation. "
    + "Hand the settled incident to the owning supervisor and its registered nwh-rebuild-review UUID; "
    + "do not queue the originating chat, create a replacement task, or restart an active worker.");
}

export type CompilerFailureCause = {
  category: string;
  targetIds: string[];
  dependencyIds: string[];
};
/** Never use a model's prose report or an aggregate coverage number as the root cause. */
export function compilerFailureCauseFingerprint(cause: CompilerFailureCause): string {
  return createHash("sha256").update(JSON.stringify({
    category: cause.category,
    targetIds: [...new Set(cause.targetIds)].sort(),
    dependencyIds: [...new Set(cause.dependencyIds)].sort(),
  })).digest("hex");
}

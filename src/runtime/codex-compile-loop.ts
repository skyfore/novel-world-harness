import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);

/** A hard account quota is different from transient per-minute throttling. */
export function isCompilerUsageLimit(message: string): boolean {
  return /usage[_ -]?limit|usage_limit_reached|insufficient_quota|you(?:'|’)ve hit.*limit|5.?hour.*limit|weekly.*limit|额度.*(?:耗尽|用完)|用量.*上限/i.test(message);
}
export function compilerFailureFingerprint(message: string): string {
  const stable = message
    .replace(/proposal_id=[^\s:]+/g, "proposal_id=<id>")
    .replace(/\b(?:run|batch)-[\w-]+/g, "<run-or-batch>")
    .replace(/\b[a-f0-9]{24,64}\b/g, "<hash>")
    .replace(/\s+/g, " ").trim();
  return createHash("sha256").update(stable).digest("hex");
}
/** User-supplied reset anchor, advanced in five-hour windows; never retry before reset. */
export function nextCompilerReset(now: Date, anchor: Date): Date {
  const period = 5 * 60 * 60 * 1_000;
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(anchor.getTime())) throw new Error("Invalid quota reset time.");
  const windows = Math.max(0, Math.floor((now.getTime() - anchor.getTime()) / period) + 1);
  return new Date(anchor.getTime() + windows * period);
}
/** argv-only transport to the exact existing Codex task. No resume --last or new task. */
export async function queueCodexCompileCallback(threadId: string, message: string): Promise<string> {
  if (!/^[a-f0-9-]{36}$/i.test(threadId)) throw new Error("An exact Codex task UUID is required.");
  const result = await execute("/root/.local/bin/codex", ["queue", "--thread", threadId, "--message", message], { timeout: 20_000, maxBuffer: 128_000 });
  return result.stdout.trim();
}

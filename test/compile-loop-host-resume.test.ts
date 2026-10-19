import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCompileLoop } from "../src/runtime/compile-loop/supervisor.js";
import { inspectCompileLoop } from "../src/runtime/compile-loop/state.js";
import { captureWorkspace, changes, digest } from "../src/runtime/compile-loop/workspace.js";
import type { runLoopChild } from "../src/runtime/compile-loop/process.js";

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
const ok = { code: 0, signal: null, error: null, timedOut: false, cancelled: false };
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-host-patch-")); directories.push(base);
  const root = path.join(base, "checkout"); vi.stubEnv("NWH_HOME", path.join(base, "state"));
  for (const dir of ["src/runtime/compile-loop", "test", "node_modules/typescript/bin"]) await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const file of ["src/runtime/compile-loop/worker.ts", "node_modules/typescript/bin/tsc"]) await fs.writeFile(path.join(root, file), "");
  await fs.writeFile(path.join(root, "src/example.ts"), "existing user change\n");
  let repairedByHost = false, rejectReview = false, failChecks = false;
  const labels: string[] = [];
  const runner: typeof runLoopChild = async input => {
    const label = path.basename(input.prefix).replace(/^\d+-/, ""); labels.push(label); input.onSpawn?.(12345);
    if (input.command === "codex") {
      input.onLine?.(JSON.stringify({ type: "thread.started", thread_id: label === "repair" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002" }));
      const output = input.args[input.args.indexOf("--output-last-message") + 1]!;
      if (label === "repair") {
        await fs.appendFile(path.join(root, "src/example.ts"), "engineering change\n");
        await fs.writeFile(path.join(root, "test/regression.test.ts"), "regression");
        await fs.writeFile(output, JSON.stringify({ action: "repair", reason: "diagnosed", whyRetryDiffers: "concrete source fix", evidence: ["trace"] }));
      } else await fs.writeFile(output, JSON.stringify({ architecturePreserved: true, checksPreserved: !rejectReview, addressesFailure: true, reason: "reviewed" }));
      return ok;
    }
    const output = input.args.at(-1)!;
    if (label === "inspect") await fs.writeFile(output, JSON.stringify({ compilerLock: { present: false },
      sources: [{ sourceId: "source", sourceSha256: "a".repeat(64), sourceIntegrity: "verified" }],
      compilation: [{ run: { history: [{ phase: "roles", status: "blocked", error: "exact host fault" }] } }],
      supervisionTrace: { planHash: "original-plan", workId: "audit-57" } }));
    if (label === "worker") {
      await fs.writeFile(output, JSON.stringify(repairedByHost ? { status: "succeeded", delivery: {
        runId: "original-run", completed: true, candidateBundleHash: "b".repeat(64), branchId: "original-branch" } }
        : { status: "failed", error: "exact host fault" }));
      return { ...ok, code: repairedByHost ? 0 : 1 };
    }
    if (label === "delivery") await fs.writeFile(input.args.at(-2)!, JSON.stringify({ verified: true, reason: "independent delivery" }));
    return { ...ok, code: label === "types" && failChecks ? 1 : 0 };
  };
  const input = { request: { root, sourceId: "source" }, sourceHash: "a".repeat(64), engineerModel: "fixture",
    signal: new AbortController().signal, onProgress() {}, runner };
  const stopped = await runCompileLoop(input);
  expect(stopped.phase).toBe("BREAK"); expect(stopped.repairs).toBe(2);
  const submit = async (mode = "valid") => {
    repairedByHost = true; rejectReview = mode === "reject"; failChecks = mode === "failed-check";
    await fs.appendFile(path.join(root, "src/example.ts"), "host resolves the exact failure\n");
    await fs.writeFile(path.join(root, "test/host-regression.test.ts"), "host fault regression");
    if (mode === "protected") await fs.writeFile(path.join(root, "src/runtime/model-request-budget.ts"), "reset budgets");
    const tree = captureWorkspace(root), changed = changes(stopped.pending!.baseline, tree);
    return runCompileLoop({ ...input, resumeStateHash: inspectCompileLoop(root, "source")!.stateHash,
      resolution: "Host repaired the exact source fault; all original counters remain charged.",
      hostPatchHash: mode === "wrong-hash" ? "f".repeat(64) : digest(changed.map(file => [file, tree[file]])) });
  };
  return { submit, labels, stopped };
}

it("reviews a concrete host repair after engineering exhaustion without resetting or charging another repair round", async () => {
  const f = await fixture(), start = f.labels.length, result = await f.submit();
  expect(result.phase).toBe("DONE"); expect(result.repairs).toBe(f.stopped.repairs);
  expect(result.failures).toEqual(f.stopped.failures); expect(result.workers).toBe(f.stopped.workers + 1);
  expect(f.labels.slice(start)).toEqual(["inspect", "review", "types", "tests", "inspect", "worker", "inspect", "delivery"]);
  expect(result.resolutions[0]!.reason).toContain("Host patch:");
});

it.each(["wrong-hash", "reject", "failed-check", "protected"])("a %s host patch cannot dispatch a compiler or obtain new repair rounds", async mode => {
  const f = await fixture(), start = f.labels.length, result = await f.submit(mode);
  expect(result.phase).toBe("BREAK"); expect(result.repairs).toBe(2);
  expect(result.failures).toEqual(f.stopped.failures);
  expect(f.labels.slice(start)).not.toContain("worker"); expect(f.labels.slice(start)).not.toContain("repair");
});

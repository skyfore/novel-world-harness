import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { runCompileLoop, compileLoopWorkerArgs } from "../src/runtime/compile-loop/supervisor.js";
import { compileLoopDirectory, activeCompileLoopDirectory, inspectCompileLoop } from "../src/runtime/compile-loop/state.js";
import * as loopState from "../src/runtime/compile-loop/state.js";
import type { runLoopChild } from "../src/runtime/compile-loop/process.js";
import { dedicatedRegistryPath } from "../src/runtime/compile-loop/dedicated-session.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
const ok = { code: 0, signal: null, error: null, timedOut: false, cancelled: false };
const engineerId = "00000000-0000-4000-8000-000000000001";
const reviewerId = "00000000-0000-4000-8000-000000000002";

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-loop-lifecycle-")); directories.push(base);
  const root = path.join(base, "checkout"); vi.stubEnv("NWH_HOME", path.join(base, "state"));
  for (const dir of ["src/runtime/compile-loop", "test", "node_modules/typescript/bin"]) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  for (const file of ["src/runtime/compile-loop/worker.ts", "node_modules/typescript/bin/tsc", "src/example.ts"]) {
    await fs.writeFile(path.join(root, file), "");
  }
  const labels: string[] = [], completed = new Set<string>(), blocked = new Set<string>();
  let verification: unknown = { verified: true, reason: "Current certificate and revision binding verified" };
  const input = (sourceId = "source-a") => {
    const runner: typeof runLoopChild = async command => {
      const label = path.basename(command.prefix).replace(/^\d+-/, ""); labels.push(label);
      command.onSpawn?.(12345);
      if (label === "inspect") {
        await fs.writeFile(command.args.at(-1)!, JSON.stringify({ compilerLock: { present: false },
          sources: [{ sourceId, sourceSha256: "a".repeat(64), sourceIntegrity: "verified" }],
          compilation: [{ run: completed.has(sourceId) ? { completed: true, history: [{ phase: "deliver", status: "completed" }] }
            : blocked.has(sourceId) ? { completed: false, history: [{ phase: "roles", status: "blocked", error: "source defect" }] } : null }] }));
      } else if (command.command === "codex") {
        command.onLine?.(JSON.stringify({ type: "thread.started", thread_id: label === "repair" ? engineerId : reviewerId }));
        const output = command.args[command.args.indexOf("--output-last-message") + 1]!;
        if (label === "repair") {
          await fs.appendFile(path.join(root, "src/example.ts"), "source fix\n");
          await fs.writeFile(path.join(root, "test/regression.test.ts"), "regression");
          await fs.writeFile(output, JSON.stringify({ action: "repair", reason: "source defect fixed",
            whyRetryDiffers: "validated implementation correction", evidence: ["original trace"] }));
        } else await fs.writeFile(output, JSON.stringify({ architecturePreserved: true, checksPreserved: true,
          addressesFailure: true, reason: "independent review" }));
      } else if (label === "worker") {
        completed.add(sourceId);
        await fs.writeFile(command.args.at(-1)!, JSON.stringify({ status: "succeeded", delivery: {
          runId: `run-${sourceId}`, completed: true, candidateBundleHash: "b".repeat(64), branchId: `branch-${sourceId}` } }));
      } else if (label === "delivery") await fs.writeFile(command.args.at(-2)!, JSON.stringify(verification));
      return ok;
    };
    return { request: { root, sourceId }, sourceHash: "a".repeat(64), engineerModel: "test-model",
      signal: new AbortController().signal, onProgress() {}, runner };
  };
  return { root, input, labels, blocked, setVerification(value: unknown) { verification = value; },
    stateFile: (sourceId = "source-a") => path.join(compileLoopDirectory(root, sourceId), "state.json") };
}

it("revalidates a completed delivery without reopening compilation or spending another worker", async () => {
  const f = await fixture(), first = await runCompileLoop(f.input()), start = f.labels.length;
  expect(first.phase).toBe("DONE");
  const again = await runCompileLoop(f.input());
  expect(again.phase).toBe("DONE"); expect(again.workers).toBe(first.workers);
  expect(again.repairs).toBe(first.repairs); expect(again.failures).toEqual(first.failures);
  expect(f.labels.slice(start)).toEqual(["inspect", "delivery"]);
});

it("starts one explicit rebuild generation and replays its token without overwriting previous history", async () => {
  const f = await fixture(), initial = f.input();
  await runCompileLoop(initial);
  const originalFile = f.stateFile(), original = await fs.readFile(originalFile, "utf8");
  const key = inspectCompileLoop(f.root, "source-a")!.stateHash;
  const request = { ...initial.request, rebuild: true };
  await expect(runCompileLoop({ ...initial, request })).rejects.toThrow("COMPILE_LOOP_NEW_RUN_REQUIRED");
  const options = { ...initial, request, newRunFromStateHash: key };
  const rebuilt = await runCompileLoop(options);
  expect(rebuilt.phase).toBe("DONE");
  expect(rebuilt.previousGeneration).toEqual({ directory: path.dirname(originalFile), stateHash: key });
  expect(activeCompileLoopDirectory(f.root, "source-a")).toBe(path.join(path.dirname(originalFile), "generations", key));
  expect(await fs.readFile(originalFile, "utf8")).toBe(original);
  const start = f.labels.length;
  await runCompileLoop(options);
  expect(f.labels.slice(start)).toEqual(["inspect", "delivery"]);
  expect(await fs.readFile(originalFile, "utf8")).toBe(original);
  const secondKey = inspectCompileLoop(f.root, "source-a")!.stateHash;
  const second = await runCompileLoop({ ...options, newRunFromStateHash: secondKey });
  expect(second.phase).toBe("DONE");
  expect(second.previousGeneration?.stateHash).toBe(secondKey);
  const saved = await fs.readFile(path.join(activeCompileLoopDirectory(f.root, "source-a"), "state.json"), "utf8");
  await expect(runCompileLoop(options)).rejects.toThrow("COMPILE_LOOP_NEW_RUN_STALE");
  expect(await fs.readFile(path.join(activeCompileLoopDirectory(f.root, "source-a"), "state.json"), "utf8")).toBe(saved);
});

it("does not turn a retained BREAK into a new rebuild allowance", async () => {
  const f = await fixture(), input = f.input();
  const stopped = await runCompileLoop({ ...input, signal: AbortSignal.abort(new Error("original cancellation")) });
  expect(stopped.phase).toBe("BREAK");
  const before = await fs.readFile(f.stateFile(), "utf8"), start = f.labels.length;
  await expect(runCompileLoop({ ...input, request: { ...input.request, rebuild: true },
    newRunFromStateHash: inspectCompileLoop(f.root, "source-a")!.stateHash })).rejects.toThrow("COMPILE_LOOP_NEW_RUN_STALE");
  expect(await fs.readFile(f.stateFile(), "utf8")).toBe(before);
  expect(f.labels).toHaveLength(start);
});

it("recovers a staged rebuild after pointer publication fails without consuming a worker", async () => {
  const f = await fixture(), initial = f.input();
  await runCompileLoop(initial);
  const original = await fs.readFile(f.stateFile(), "utf8"), start = f.labels.length;
  const key = inspectCompileLoop(f.root, "source-a")!.stateHash;
  const options = { ...initial, request: { ...initial.request, rebuild: true }, newRunFromStateHash: key };
  const save = loopState.save;
  const injected = vi.spyOn(loopState, "save").mockImplementation((file, value) => {
    if (path.basename(file) === "current-generation.json") throw new Error("Injected generation pointer failure");
    save(file, value);
  });
  await expect(runCompileLoop(options)).rejects.toThrow("Injected generation pointer failure");
  expect(f.labels).toHaveLength(start);
  expect(await fs.readFile(f.stateFile(), "utf8")).toBe(original);
  expect(inspectCompileLoop(f.root, "source-a")?.stateHash).toBe(key);
  const staged = path.join(path.dirname(f.stateFile()), "generations", key, "state.json");
  expect(JSON.parse(await fs.readFile(staged, "utf8"))).toMatchObject({ phase: "READY", workers: 0 });
  injected.mockRestore();
  expect((await runCompileLoop(options)).phase).toBe("DONE");
  expect(f.labels.slice(start).filter(label => label === "worker")).toHaveLength(1);
  expect(await fs.readFile(f.stateFile(), "utf8")).toBe(original);
});

it("runs the actual TypeScript worker from an external novel workspace without local tooling", async () => {
  const f = await fixture();
  await fs.rm(path.join(f.root, "src"), { recursive: true });
  await fs.rm(path.join(f.root, "node_modules"), { recursive: true });
  const { source } = await createEvidenceFixture(f.root, "Ada waits.");
  const request = path.join(f.root, "request.json"), output = path.join(f.root, "inspection.json");
  await fs.writeFile(request, JSON.stringify({ root: f.root, sourceId: source.id }));
  const child = spawnSync(process.execPath, [...compileLoopWorkerArgs(), "inspect", request, output], {
    cwd: f.root, encoding: "utf8", timeout: 30_000, env: process.env,
  });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(await fs.readFile(output, "utf8")).sources[0].sourceId).toBe(source.id);
}, 35_000);

it("a stale completed delivery remains verification-only even after an exact host resume", async () => {
  const f = await fixture(), first = await runCompileLoop(f.input()), start = f.labels.length;
  f.setVerification({ verified: false, reason: "Candidate inputs changed after certification" });
  const stopped = await runCompileLoop(f.input());
  expect(stopped.phase).toBe("BREAK"); expect(stopped.workers).toBe(first.workers);
  f.setVerification({ verified: true, reason: "Original certified inputs restored" });
  const resumed = await runCompileLoop({ ...f.input(), resumeStateHash: inspectCompileLoop(f.root, "source-a")!.stateHash,
    resolution: "Restored the original certified inputs; reverify the retained delivery." });
  expect(resumed.phase).toBe("DONE"); expect(resumed.workers).toBe(first.workers);
  expect(f.labels.slice(start)).not.toContain("worker"); expect(f.labels.slice(start)).not.toContain("repair");
});

it("adopts a legacy DONE record by verifying its original result without reopening work", async () => {
  const f = await fixture(), first = await runCompileLoop(f.input()), start = f.labels.length;
  const { delivery: _delivery, ...legacy } = first;
  await fs.writeFile(f.stateFile(), JSON.stringify(legacy));
  const again = await runCompileLoop(f.input());
  expect(again.phase).toBe("DONE"); expect(again.workers).toBe(first.workers);
  expect(again.delivery).toMatchObject({ worker: first.workers, resultHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(f.labels.slice(start)).toEqual(["inspect", "delivery"]);
});

it.each(["missing", "changed", "legacy-missing"])("a %s successful receipt cannot reopen compilation on a later resume", async kind => {
  const f = await fixture(), first = await runCompileLoop(f.input()), start = f.labels.length;
  const output = path.join(path.dirname(f.stateFile()), `worker-${first.workers}.json`);
  if (kind === "legacy-missing") {
    const { delivery: _delivery, ...legacy } = first;
    await fs.writeFile(f.stateFile(), JSON.stringify(legacy));
  }
  if (kind === "changed") await fs.appendFile(output, "\n");
  else await fs.rm(output);
  const stopped = await runCompileLoop(f.input());
  expect(stopped.phase).toBe("BREAK"); expect(stopped.reason).toContain("COMPILE_LOOP_DELIVERY_CHANGED");
  const resumed = await runCompileLoop({ ...f.input(), resumeStateHash: inspectCompileLoop(f.root, "source-a")!.stateHash,
    resolution: "Host inspected the missing or altered original receipt; no replacement is authorized." });
  expect(resumed.phase).toBe("BREAK"); expect(resumed.workers).toBe(first.workers);
  expect(f.labels.slice(start)).not.toContain("worker"); expect(f.labels.slice(start)).not.toContain("repair");
});

it.each(["missing-resolution", "wrong-hash", "policy", "in-flight"])("a rejected %s invocation preserves exact durable stop bytes", async kind => {
  const f = await fixture();
  const state = await runCompileLoop({ ...f.input(), signal: AbortSignal.abort(new Error("original cancellation")) });
  const file = f.stateFile();
  if (kind === "in-flight") await fs.writeFile(file, JSON.stringify({ ...state, phase: "WORKER", childPid: 12345 }));
  const before = await fs.readFile(file, "utf8"), start = f.labels.length;
  const input = { ...f.input(), ...(kind === "wrong-hash" ? { resumeStateHash: "f".repeat(64), resolution: "wrong retained hash" } : {}),
    ...(kind === "policy" ? { engineerModel: "changed-model" } : {}) };
  await expect(runCompileLoop(input)).rejects.toThrow(/COMPILE_LOOP_(RETAINED_STOP|POLICY_CHANGED|IN_FLIGHT)/);
  expect(await fs.readFile(file, "utf8")).toBe(before); expect(f.labels).toHaveLength(start);
});

it("a registered engineer for one novel does not block another novel in the same workspace", async () => {
  const f = await fixture(); f.blocked.add("source-a");
  expect((await runCompileLoop(f.input("source-a"))).phase).toBe("DONE");
  const start = f.labels.length, other = await runCompileLoop(f.input("source-b"));
  expect(other.phase).toBe("DONE"); expect(other.repairs).toBe(0);
  expect(f.labels.slice(start)).not.toContain("repair");
  const registry = dedicatedRegistryPath(f.root, "source-a");
  expect(registry.startsWith(compileLoopDirectory(f.root, "source-a") + path.sep)).toBe(true);
  expect(JSON.parse(await fs.readFile(registry, "utf8")).sourceId).toBe("source-a");
});

it.each(["longzu-rebuild-loop", "another-novel-review"])("retains the exact legacy engineer from %s while isolating other sources", async label => {
  const f = await fixture(), registry = path.join(f.root, "run-records", label, "reviewer-session.json");
  const createdAt = new Date(Date.now() - 3600_000).toISOString();
  await fs.mkdir(path.dirname(registry), { recursive: true });
  const retained = { version: 1, purpose: "nwh-rebuild-review", workspace: f.root, sourceId: "source-a",
    model: "test-model", effort: "max", threadId: engineerId, createdAt, lastUsedAt: createdAt };
  await fs.writeFile(registry, JSON.stringify(retained));
  expect((await runCompileLoop(f.input("source-b"))).phase).toBe("DONE");
  expect(JSON.parse(await fs.readFile(registry, "utf8"))).toEqual(retained);
  f.blocked.add("source-a");
  const state = await runCompileLoop(f.input("source-a"));
  expect(state.phase).toBe("DONE"); expect(state.engineerSession).toEqual({ id: engineerId, createdAt: Date.parse(createdAt) });
  expect(JSON.parse(await fs.readFile(registry, "utf8"))).toMatchObject({ threadId: engineerId, createdAt });
});

it("refuses ambiguous legacy ownership without replacing either registry or creating a new one", async () => {
  const f = await fixture(), at = new Date().toISOString();
  const files = ["first-attempt", "later-attempt"].map(label => path.join(f.root, "run-records", label, "reviewer-session.json"));
  const retained = JSON.stringify({ version: 1, purpose: "nwh-rebuild-review", workspace: f.root, sourceId: "source-a",
    model: "test-model", effort: "max", threadId: engineerId, createdAt: at, lastUsedAt: at });
  for (const file of files) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, retained); }
  expect(() => dedicatedRegistryPath(f.root, "source-a")).toThrow("DEDICATED_REGISTRY_CONFLICT");
  for (const file of files) expect(await fs.readFile(file, "utf8")).toBe(retained);
  await expect(fs.stat(path.join(compileLoopDirectory(f.root, "source-a"), "engineering-session"))).rejects.toThrow();
  expect(dedicatedRegistryPath(f.root, "source-b")).toBe(path.join(compileLoopDirectory(f.root, "source-b"), "engineering-session/reviewer-session.json"));
});

it.each(["invalid", "symlink", "dangling"])("refuses a %s legacy registry without silently starting another session", async kind => {
  const f = await fixture(), registry = path.join(f.root, "run-records/other-attempt/reviewer-session.json");
  await fs.mkdir(path.dirname(registry), { recursive: true });
  if (kind === "invalid") await fs.writeFile(registry, "{}");
  else {
    const target = path.join(f.root, "original-registry.json");
    if (kind === "symlink") await fs.writeFile(target, "{}");
    await fs.symlink(target, registry);
  }
  expect(() => dedicatedRegistryPath(f.root, "source-a")).toThrow("DEDICATED_REGISTRY_INVALID");
  await expect(fs.stat(path.join(compileLoopDirectory(f.root, "source-a"), "engineering-session"))).rejects.toThrow();
});

it.each(["true", "false", 1, { accepted: true }])("nonboolean verification %j never certifies delivery", async verified => {
  const f = await fixture(); f.setVerification({ verified, reason: "Untrusted child result" });
  expect((await runCompileLoop(f.input())).phase).toBe("BREAK");
});

it.each(["request.json", "policy.json"])("changed %s cannot replace the admitted worker authority or mutate the stop", async name => {
  const f = await fixture();
  await runCompileLoop({ ...f.input(), signal: AbortSignal.abort(new Error("original stop")) });
  const file = f.stateFile(), before = await fs.readFile(file, "utf8"), start = f.labels.length;
  const authority = path.join(path.dirname(file), name), changed = JSON.parse(await fs.readFile(authority, "utf8"));
  changed.model = "substituted-model";
  await fs.writeFile(authority, JSON.stringify(changed));
  await expect(runCompileLoop({ ...f.input(), resumeStateHash: inspectCompileLoop(f.root, "source-a")!.stateHash,
    resolution: "Inspect retained request" })).rejects.toThrow("COMPILE_LOOP_REQUEST_CHANGED");
  expect(await fs.readFile(file, "utf8")).toBe(before); expect(f.labels).toHaveLength(start);
});

import fs from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCompileLoop } from "../src/runtime/compile-loop/supervisor.js";
import { compileLoopDirectory, inspectCompileLoop } from "../src/runtime/compile-loop/state.js";
import { runLoopChild } from "../src/runtime/compile-loop/process.js";
import { verifyNovelDelivery } from "../src/runtime/compile-loop/delivery.js";

const directories: string[] = [];
const ok = { code: 0, signal: null, error: null, timedOut: false, cancelled: false };
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(options: { blocked?: boolean; checkFailures?: number; repeatFailure?: boolean; invalidReview?: boolean;
  unverifiedDelivery?: boolean; tamperAudit?: boolean; forbiddenPatch?: boolean; signal?: AbortSignal; domainStop?: boolean;
  domainResolved?: boolean; changedDomainHistory?: boolean } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-product-loop-")); directories.push(base);
  const root = path.join(base, "project"); vi.stubEnv("NWH_HOME", path.join(base, "state"));
  for (const dir of ["src/runtime/compile-loop", "test", "node_modules/typescript/bin"]) await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const file of ["src/runtime/compile-loop/worker.ts", "node_modules/typescript/bin/tsc"]) await fs.writeFile(path.join(root, file), "");
  await fs.writeFile(path.join(root, "src/sample.ts"), "existing user edit\n");
  const sourceId = "source-1", sourceHash = "a".repeat(64), labels: string[] = [], prompts: string[] = [];
  let work = 0, repairs = 0, checks = 0;
  const runner: typeof runLoopChild = async command => {
    const label = path.basename(command.prefix).replace(/^\d+-/, ""); labels.push(label);
    command.onSpawn?.(12345);
    if (command.command === "codex") {
      prompts.push(command.stdin!);
      command.onLine?.(JSON.stringify({ type: "thread.started", thread_id: label === "repair" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002" }));
      const output = command.args[command.args.indexOf("--output-last-message") + 1]!;
      if (label === "repair") {
        repairs++;
        await fs.appendFile(path.join(root, "src/sample.ts"), `repair ${repairs}\n`);
        await fs.writeFile(path.join(root, "test/regression.test.ts"), `regression ${repairs}`);
        if (options.forbiddenPatch) await fs.writeFile(path.join(root, "src/runtime/compile-loop/worker.ts"), "weaken supervisor");
        writeFileSync(output, JSON.stringify({ action: "repair", reason: "Exact failure diagnosed", whyRetryDiffers: "Source correction retains original budget", evidence: ["original trace"] }));
      } else writeFileSync(output, JSON.stringify({ architecturePreserved: true, checksPreserved: !options.invalidReview, addressesFailure: true, reason: "Reviewed actual patch" }));
      if (options.tamperAudit) writeFileSync(path.join(path.dirname(command.prefix), "policy.json"), "{}");
      return ok;
    }
    const output = command.args.at(-1)!;
    if (label === "inspect") {
      writeFileSync(output, JSON.stringify({ compilerLock: { present: false },
        sources: [{ sourceId, sourceSha256: sourceHash, sourceIntegrity: "verified" }],
        compilation: [{ sourceId, run: options.blocked === false && work === 0 ? null : { id: options.changedDomainHistory ? "replacement-run" : "original-run", completed: false,
          history: [{ phase: "roles", status: "blocked", error: "Model request budget exhausted: no new validated progress in 12 model calls",
            ...(options.domainStop ? { recovery: { kind: "semantic-repair", sourceId, phase: "roles",
              taskIds: ["identity:original"], action: "inspect-compilation-plan" } } : {}) },
            ...(options.domainResolved ? [{ phase: "roles", status: "completed" }] : [])] } }],
        supervisionTrace: { workId: "audit-29", planHash: "same-plan" } }));
    } else if (label === "worker") {
      work++;
      writeFileSync(output, JSON.stringify(options.repeatFailure ? { status: "failed", error: "same original stop" }
        : { status: "succeeded", delivery: { runId: "original-run", completed: true, candidateBundleHash: "b".repeat(64), branchId: "original-branch" } }));
      return { ...ok, code: options.repeatFailure ? 1 : 0 };
    } else if (label === "delivery") {
      writeFileSync(command.args.at(-2)!, JSON.stringify({ verified: !options.unverifiedDelivery, reason: "Current certificate and branch inspection" }));
    } else if (label === "types" && checks++ < (options.checkFailures ?? 0)) return { ...ok, code: 1 };
    return ok;
  };
  const input = { request: { root, sourceId }, sourceHash, engineerModel: "test-model", signal: options.signal ?? new AbortController().signal,
    onProgress() {}, runner };
  return { root, input, labels, prompts, directory: compileLoopDirectory(root, sourceId) };
}

it("adopts an existing compiler failure before running a worker, reviews and tests its repair, then verifies full delivery", async () => {
  const f = await fixture();
  const state = await runCompileLoop(f.input);
  expect(state.phase).toBe("DONE"); expect(state.repairs).toBe(1); expect(state.workers).toBe(1);
  expect(f.labels.indexOf("repair")).toBeLessThan(f.labels.indexOf("worker"));
  expect(f.labels.indexOf("review")).toBeLessThan(f.labels.indexOf("types"));
  expect(f.labels.indexOf("tests")).toBeLessThan(f.labels.indexOf("worker"));
  expect(f.labels.at(-1)).toBe("delivery");
  expect(await fs.readFile(path.join(f.root, "src/sample.ts"), "utf8")).toBe("existing user edit\nrepair 1\n");
  expect(inspectCompileLoop(f.root, "source-1")?.phase).toBe("DONE");
});

it("normal successful compilation spends no engineering round", async () => {
  const f = await fixture({ blocked: false }); const state = await runCompileLoop(f.input);
  expect(state.phase).toBe("DONE"); expect(state.repairs).toBe(0); expect(f.labels).not.toContain("repair");
});

it("hands a typed semantic dependency stop to its original domain task without engineering or compiler redispatch", async () => {
  const f = await fixture({ domainStop: true });
  const state = await runCompileLoop(f.input);
  expect(state.phase).toBe("BREAK");
  expect(state.reason).toContain("COMPILE_LOOP_DOMAIN_ACTION");
  expect(state.reason).toContain("identity:original");
  expect(state.repairs).toBe(0); expect(state.workers).toBe(0);
  expect(f.labels).not.toContain("repair"); expect(f.labels).not.toContain("worker");
  expect(await fs.readFile(path.join(f.root, "src/sample.ts"), "utf8")).toBe("existing user edit\n");
  const before = await fs.readFile(path.join(f.directory, "state.json"), "utf8");
  await expect(runCompileLoop(f.input)).rejects.toThrow("COMPILE_LOOP_RETAINED_STOP");
  expect(await fs.readFile(path.join(f.directory, "state.json"), "utf8")).toBe(before);
});

it.each([false, true])("resumes a resolved original domain phase only with its retained run history (replacement: %s)", async changedDomainHistory => {
  const options = { domainStop: true, domainResolved: false, changedDomainHistory: false }, f = await fixture(options);
  const stopped = await runCompileLoop(f.input), original = await fs.readFile(stopped.pending!.evidenceFile, "utf8");
  options.domainResolved = true; options.changedDomainHistory = changedDomainHistory;
  const state = await runCompileLoop({ ...f.input, resumeStateHash: inspectCompileLoop(f.root, "source-1")!.stateHash,
    resolution: "Original domain phase completed through its existing typed repair and revalidation" });
  expect(state.phase).toBe(changedDomainHistory ? "BREAK" : "DONE");
  expect(state.repairs).toBe(0); expect(f.labels).not.toContain("repair");
  expect(state.workers).toBe(changedDomainHistory ? 0 : 1);
  expect(await fs.readFile(stopped.pending!.evidenceFile, "utf8")).toBe(original);
});

it("a failed fixed check feeds the cumulative patch back to engineering without dispatching a worker", async () => {
  const f = await fixture({ checkFailures: 1 }); const state = await runCompileLoop(f.input);
  expect(state.phase).toBe("DONE"); expect(state.repairs).toBe(2); expect(state.workers).toBe(1);
  expect(f.prompts.filter(p => p.includes("Host verification failed"))).toHaveLength(2);
  expect(f.labels.filter(x => x === "types")).toHaveLength(2);
});

it("repeated failure retains its identity and exhausted engineering allowance across invocations", async () => {
  const f = await fixture({ repeatFailure: true }); const state = await runCompileLoop(f.input);
  expect(state.phase).toBe("BREAK"); expect(state.reason).toContain("COMPILE_LOOP_NO_PROGRESS");
  expect(state.repairs).toBe(2); expect(state.workers).toBe(2);
  const calls = f.labels.length, before = await fs.readFile(path.join(f.directory, "state.json"), "utf8");
  await expect(runCompileLoop(f.input)).rejects.toThrow("COMPILE_LOOP_RETAINED_STOP");
  expect(f.labels).toHaveLength(calls); expect(await fs.readFile(path.join(f.directory, "state.json"), "utf8")).toBe(before);
  const stateHash = inspectCompileLoop(f.root, "source-1")!.stateHash;
  const reviewed = await runCompileLoop({ ...f.input, resumeStateHash: stateHash, resolution: "Host reviewed the original failure; counters remain binding." });
  expect(reviewed.reason).toContain("COMPILE_LOOP_NO_PROGRESS"); expect(reviewed.repairs).toBe(2);
  expect(reviewed.resolutions).toHaveLength(1); expect(f.labels.filter(label => label === "repair")).toHaveLength(2);
});

it.each(["invalidReview", "forbiddenPatch", "tamperAudit"] as const)("%s stops before a worker and preserves the patch", async failure => {
  const f = await fixture({ [failure]: true }); const state = await runCompileLoop(f.input);
  expect(state.phase).toBe("BREAK"); expect(f.labels).not.toContain("worker");
  expect(await fs.readFile(path.join(f.root, "src/sample.ts"), "utf8")).toContain("existing user edit");
});

it("a zero worker exit without current certified delivery cannot become DONE", async () => {
  const f = await fixture({ blocked: false, unverifiedDelivery: true }); const state = await runCompileLoop(f.input);
  expect(state.phase).toBe("BREAK"); expect(state.reason).toContain("COMPILE_LOOP_DELIVERY_UNPROVEN");
  expect((await verifyNovelDelivery(f.root, "source-1", { runId: "old", completed: true })).verified).toBe(false);
});

it("legacy migration retains counts and the complete old record rather than reopening its budget", async () => {
  const f = await fixture(), legacy = path.join(f.root, "legacy.json");
  const record = { workspace: f.root, sourceId: "source-1", phase: "BREAK", childPid: null, attempts: 10, reviews: 9,
    deadline: 1, consumedCauses: ["old-cause"], reason: "old quota refusal" };
  await fs.writeFile(legacy, JSON.stringify(record));
  const state = await runCompileLoop({ ...f.input, legacyState: legacy, resolution: "User requested product supervision; reviewed latest stopped work without renewing any domain allowance." });
  expect(state.phase).toBe("DONE"); expect(state.workers).toBe(11); expect(state.repairs).toBe(10);
  expect(JSON.parse(readFileSync(path.join(f.directory, "legacy-supervisor.json"), "utf8")).prior).toEqual(record);
  expect(JSON.parse(await fs.readFile(legacy, "utf8"))).toEqual(record);
});

it("pre-cancelled supervision dispatches no process", async () => {
  const controller = new AbortController(); controller.abort(new Error("User cancelled"));
  const f = await fixture({ signal: controller.signal }), state = await runCompileLoop(f.input);
  expect(state.phase).toBe("BREAK"); expect(f.labels).toEqual([]);
});

it("the process runner retains a real failing exit and terminates an owned child on cancellation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-loop-process-")); directories.push(root);
  const failed = await runLoopChild({ command: process.execPath, args: ["-e", "console.log('diagnostic'); process.exitCode=7"], cwd: root,
    prefix: path.join(root, "failure"), timeoutMs: 5000, signal: new AbortController().signal });
  expect(failed.code).toBe(7); expect(await fs.readFile(path.join(root, "failure.stdout.jsonl"), "utf8")).toContain("diagnostic");
  const controller = new AbortController();
  const cancelled = await runLoopChild({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: root,
    prefix: path.join(root, "cancel"), timeoutMs: 5000, signal: controller.signal, onSpawn() { controller.abort(); } });
  expect(cancelled.cancelled).toBe(true); expect(cancelled.signal).toBeTruthy();
});

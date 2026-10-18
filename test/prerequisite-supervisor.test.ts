import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { afterEach, expect, it, vi } from "vitest";
import { dedicatedSessionArgs, dedicatedSessionMode, DEDICATED_SESSION_TTL_MS, acceptDedicatedSession, captureRecordTree, readOnlyNodeArgs, type DedicatedSession } from "../src/runtime/compile-loop/dedicated-session.js";
import { runPrerequisiteLoop, type PrerequisiteLoopSpec } from "../src/runtime/compile-loop/prerequisite-supervisor.js";
import { digest } from "../src/runtime/compile-loop/workspace.js";
import { prerequisiteHandoffPaths } from "../src/runtime/compile-loop/prerequisite-handoff.js";
import { contentHash } from "../src/world/canonical.js";
import { runLoopChild as realRunner, codexGuardCommand } from "../src/runtime/compile-loop/process.js";
import { runCompileLoop } from "../src/runtime/compile-loop/supervisor.js";
import type { runLoopChild } from "../src/runtime/compile-loop/process.js";
import { queueCodexCompileCallback } from "../src/runtime/codex-compile-loop.js";

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });
const engineerId = "00000000-0000-4000-8000-000000000001", reviewerId = "00000000-0000-4000-8000-000000000002";
const scope = { workspace: "/project", sourceId: "source", model: "gpt-5.6-sol", effort: "max" as const };
const now = Date.now();
const session: DedicatedSession = { version: 1, purpose: "nwh-rebuild-review", ...scope, threadId: engineerId,
  createdAt: new Date(now).toISOString(), lastUsedAt: new Date(now).toISOString() };

it("retained current-chat hooks fail closed with the dedicated supervisor recovery instruction", async () => {
  await expect(queueCodexCompileCallback(engineerId, "settled failure")).rejects.toThrow("COMPILE_LOOP_DEDICATED_SESSION_REQUIRED");
});

it("resumes the registered dedicated UUID, and rotates only strictly after 72 hours from creation", () => {
  expect(dedicatedSessionMode(session, scope, now + DEDICATED_SESSION_TTL_MS)).toBe("resume");
  expect(dedicatedSessionMode({ ...session, lastUsedAt: new Date(now + DEDICATED_SESSION_TTL_MS).toISOString() }, scope, now + DEDICATED_SESSION_TTL_MS + 1)).toBe("rotate");
  const args = dedicatedSessionArgs(scope, session, now + 1, "/schema", "/output");
  expect(args.slice(0, 2)).toEqual(["exec", "resume"]); expect(args.slice(-2)).toEqual([engineerId, "-"]);
  expect(args).not.toContain("queue"); expect(args).not.toContain("--last");
  expect(() => dedicatedSessionMode({ ...session, sourceId: "other" }, scope, now)).toThrow("SCOPE_CHANGED");
  expect(() => dedicatedSessionMode(session, scope, now - 1)).toThrow("CLOCK_INVALID");
  expect(() => acceptDedicatedSession(scope, session, engineerId, now + DEDICATED_SESSION_TTL_MS + 1)).toThrow("ID_CHANGED");
  expect(acceptDedicatedSession(scope, session, reviewerId, now + DEDICATED_SESSION_TTL_MS + 1).threadId).toBe(reviewerId);
});

type Failure = "review" | "checks" | "preflight" | "worker" | "verify" | "session" | "history" | "controls" | "registry" | "runHistory" | "missing" | "truthy" | "extra" | "newHistory";
async function fixture(failure?: Failure) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prerequisite-loop-")); dirs.push(base);
  const root = path.join(base, "project"), taskId = "a".repeat(64);
  vi.stubEnv("NWH_HOME", path.join(base, "state"));
  const paths = prerequisiteHandoffPaths(root, scope.sourceId, taskId), directory = paths.directory;
  await fs.mkdir(path.join(root, "src/workflow"), { recursive: true }); await fs.mkdir(path.join(root, "test"));
  await fs.mkdir(path.join(root, "run-records/longzu-rebuild-loop"), { recursive: true });
  await fs.mkdir(path.join(paths.identity, "consumer-review"), { recursive: true });
  const parentStateFile = path.join(paths.parent, "state.json"), incidentFile = path.join(base, "incident.json"), workerRequestFile = path.join(base, "request.json"), authorizationFile = path.join(base, "authorization.json");
  const inherited = { workers: 21, repairs: 20, commands: 83, failures: { original: 2 } };
  const parent = { phase: "BREAK", ...inherited, root, sourceId: scope.sourceId, sourceHash: "b".repeat(64), childPid: null, pending: { key: "original" } };
  const write = async (f: string, x: unknown) => fs.writeFile(f, JSON.stringify(x));
  const sha = async (f: string) => createHash("sha256").update(await fs.readFile(f)).digest("hex");
  await write(parentStateFile, parent); await fs.writeFile(incidentFile, "original failed trace, five calls");
  const auditBudgetFile = path.join(base, "audit-budget.json"), priorBudgetFile = path.join(base, "prior-budget.json");
  const audit = { hash: "c".repeat(64), planHash: "d".repeat(64), state: { usage: { modelCalls: 19, totalPayloadBytes: 100 } } };
  const earlier = { state: { usage: { modelCalls: 124, totalPayloadBytes: 900 } } };
  await write(auditBudgetFile, audit); await write(priorBudgetFile, earlier);
  const intent = { taskId, sourceId: scope.sourceId, sourceHash: parent.sourceHash, parentStateHash: digest(parent), authorizationRef: "original semantic scope",
    originalBudgetHash: audit.hash, originalPlanHash: audit.planHash,
    priorUsage: { modelCalls: 143, totalPayloadBytes: 1000, budgetFilesHash: contentHash({ audit, budgets: [{ file: priorBudgetFile, value: earlier }] }) } };
  await write(path.join(paths.identity, "intent.json"), intent);
  const usage = { modelCalls: 5, payloads: 5, totalPayloadBytes: 100, largestRequestBytes: 30 }, cumulative = { modelCalls: 154, totalPayloadBytes: 1140 };
  const baseBudget = { taskId, intentHash: contentHash(intent), originalBudgetHash: intent.originalBudgetHash, priorUsage: intent.priorUsage,
    limits: { maxModelCalls: 24, maxRequestBytes: 512000, maxTotalPayloadBytes: 12288000 } };
  const budget = { ...baseBudget, phase: "identity-consumers", stage: "identity-consumers-0", state: { usage, blocked: true, failure: { code: "request-size" } }, cumulative };
  await write(path.join(paths.identity, "identity-consumers-0.budget.json"), budget);
  for (const [i, stage] of ["identity-definition", "identity-definition-check"].entries()) {
    await write(path.join(paths.identity, stage + ".budget.json"), { ...baseBudget, phase: stage, stage, state: { usage: { modelCalls: 3, totalPayloadBytes: 20 } }, cumulative: { modelCalls: 146 + i * 3, totalPayloadBytes: 1020 + i * 20 } });
    await write(path.join(paths.identity, stage + ".record.json"), { stage });
  }
  await fs.mkdir(path.join(paths.identity, "host-recovery"));
  const definitionStop = { phase: "BREAK", stage: "identity-definition-check", intentHash: contentHash(intent) };
  await write(path.join(paths.identity, "host-recovery/state.json"), definitionStop);
  const proof = { intentHash: contentHash(intent), stoppedStateHash: digest(definitionStop), stoppedDirectory: "host-recovery", authorizationRef: "original consumer continuation",
    recordHashes: ["identity-definition", "identity-definition-check"].map(stage => contentHash({ stage })),
    retainedFiles: Object.fromEntries(Object.entries(captureRecordTree(paths.identity)).filter(([f]) => !f.startsWith("identity-consumers-0."))),
    host: { hostname: os.hostname(), bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), pidNamespace: await fs.readlink("/proc/self/ns/pid") } };
  await write(path.join(paths.identity, "consumer-review/intent.json"), proof);
  const stop = { phase: "BREAK", stage: "identity-consumers-0", childPid: null, taskId, intentHash: contentHash(intent), traceRunId: "failed-original-trace", continuationHash: contentHash(proof) };
  await write(path.join(paths.identity, "consumer-review/state.json"), stop);
  await write(path.join(paths.identity, "consumer-review/start.json"), { taskId, intentHash: contentHash(intent), pid: 2147483647, continuationHash: contentHash(proof) });
  await write(incidentFile, { readOnly: true, sourceId: scope.sourceId, taskId, intentHash: contentHash(intent), parentStateHash: digest(parent),
    stateHash: digest(stop), continuationHash: contentHash(proof), budget,
    trace: { id: stop.traceRunId, status: "failed", counts: { llmRequests: 5 }, requests: 5, payloadBytes: [20, 20, 20, 20, 20] } });
  await write(authorizationFile, { taskId, originalParentStateHash: digest(parent), latestOriginThreadId: reviewerId, latestUserCorrection: "original user fix-and-continue", budgetIncreaseAuthorized: false, newSemanticGrant: false, originalParentMayResume: false });
  const request = { root, taskId, sourceId: scope.sourceId, identityDirectory: paths.identity, parentStateHash: digest(parent), expectedIntentHash: contentHash(intent),
    originalIncidentHash: await sha(incidentFile), originalIncidentFile: incidentFile, priorUsage: intent.priorUsage, stoppedStateHash: digest(stop), failedTraceRunId: stop.traceRunId,
    authorizationRef: intent.authorizationRef, consumerAuthorizationRef: proof.authorizationRef, auditBudgetFile, priorBudgetFiles: [priorBudgetFile],
    authorization: { originThreadId: reviewerId }, originalBudgetHash: contentHash(budget), originalUsage: usage, cumulativeBeforeRecovery: cumulative };
  await write(workerRequestFile, request);
  await fs.writeFile(path.join(root, "src/example.ts"), "existing user source\n");
  const registryFile = paths.registry;
  await write(registryFile, { ...session, workspace: root });
  const retainedFiles: Record<string, string> = Object.fromEntries(Object.entries(captureRecordTree(paths.identity)).map(([f, h]) => [path.join(paths.identity, f), h]));
  for (const f of [parentStateFile, incidentFile, workerRequestFile, authorizationFile, auditBudgetFile, priorBudgetFile]) retainedFiles[f] = await sha(f);
  const spec: PrerequisiteLoopSpec = { version: 1, root, sourceId: scope.sourceId, taskId, directory, registryFile,
    ownershipLocks: paths.locks, authorizationRef: "original user fix-and-continue", incidentFile,
    incidentHash: await sha(incidentFile), parentStateFile, parentStateHash: digest(parent), retainedFiles,
    authorizationFile, authorizationHash: await sha(authorizationFile),
    inherited, engineerModel: "gpt-5.6-sol", workerEntry: "src/workflow/identity-consumer-context-recovery.ts", workerRequestFile, deadline: now + 3600_000 };
  const labels: string[] = [], args: string[][] = [], ok = { code: 0, signal: null, error: null, timedOut: false, cancelled: false };
  const runner: typeof runLoopChild = async c => {
    const label = path.basename(c.prefix).replace(/^\d+-/, ""); labels.push(label); args.push(c.args); c.onSpawn?.(1000);
    if (c.command !== "/usr/bin/bwrap") {
      expect(c.immutablePaths).toContain(path.join(root, "run-records"));
      expect(c.immutablePaths).toContain(spec.ownershipLocks[0]);
    } else expect(c.args).toContain("--unshare-net");
    if (c.command === "codex") {
      expect(c.codexFilePolicy).toBe(label === "repair" ? "workspace-write" : "read-only");
      const output = c.args[c.args.indexOf("--output-last-message") + 1]!;
      c.onLine?.(JSON.stringify({ type: "thread.started", thread_id: label === "repair" && failure !== "session" ? engineerId : reviewerId }));
      if (label === "repair") {
        await fs.appendFile(path.join(root, "src/example.ts"), "source fix\n"); await fs.writeFile(path.join(root, "test/regression.test.ts"), "regression");
        if (failure !== "missing") await fs.writeFile(path.join(root, spec.workerEntry), "// fixed host adapter under independent review\n");
        if (failure === "registry") await fs.writeFile(registryFile, "{}");
        if (failure === "runHistory") await fs.writeFile(path.join(root, "run-records/old-attempt.json"), "changed");
        if (failure === "history") await fs.appendFile(incidentFile, "changed");
        if (failure === "controls") await fs.writeFile(path.join(root, "test/prerequisite-supervisor.test.ts"), "weaken check");
        await fs.writeFile(output, JSON.stringify({ action: "repair", reason: "fixed source", whyRetryDiffers: "lossless retained context", evidence: [incidentFile] }));
      } else await fs.writeFile(output, JSON.stringify({ architecturePreserved: failure !== "review", checksPreserved: true, addressesFailure: true, reason: "independently checked" }));
    } else if (["preflight", "worker", "verification"].includes(label)) {
      const output = c.args.at(-1)!;
      await fs.writeFile(output, JSON.stringify({ ...(label === "preflight" ? { ready: failure === "truthy" ? "true" : failure !== "preflight" } : { verified: failure !== "verify" }), taskId: spec.taskId, originalIncidentHash: spec.incidentHash, ...(failure === "extra" ? { authorityGranted: true } : {}) }));
      if (label === "worker" && failure === "worker") return { ...ok, code: 1 };
    } else if (["types", "tests"].includes(label)) {
      expect(c.readOnlyRootDirectory).toBe(c.prefix + ".sandbox");
      if (label === "types" && failure === "checks") return { ...ok, code: 1 };
      if (label === "tests" && failure === "newHistory") await fs.writeFile(path.join(paths.identity, "identity-consumers-0.record.json"), "unauthorized new history");
    }
    return ok;
  };
  return { spec, labels, args, runner, parent };
}

it("repairs in the dedicated session then independently reviews, tests, inspects and automatically continues the original task", async () => {
  const f = await fixture(), state = await runPrerequisiteLoop(f.spec, { signal: new AbortController().signal, runner: f.runner });
  expect(state.phase).toBe("DONE"); expect(state.workerDispatches).toBe(1);
  expect(f.labels).toEqual(["repair", "review", "types", "tests", "preflight", "worker", "verification"]);
  expect(f.args[0]!.slice(-2)).toEqual([engineerId, "-"]); expect(f.args[1]).not.toContain("resume");
  expect(f.args.flat()).not.toContain("queue"); expect(state.inherited).toEqual(f.spec.inherited);
  expect(JSON.parse(await fs.readFile(f.spec.parentStateFile, "utf8"))).toEqual(f.parent);
  expect(state.parentCompileResumeAllowed).toBe(false); expect(state.certificationGranted).toBe(false);
  await expect(runPrerequisiteLoop(f.spec, { signal: new AbortController().signal, runner: f.runner })).rejects.toThrow("EEXIST");
  expect(f.labels).toHaveLength(7);
});

it.each(["review", "checks", "preflight", "session", "history", "controls", "registry", "runHistory", "missing", "truthy", "extra", "newHistory"] as const)("%s preserves a stop before any worker", async failure => {
  const f = await fixture(failure), state = await runPrerequisiteLoop(f.spec, { signal: new AbortController().signal, runner: f.runner });
  expect(state.phase).toBe("BREAK"); expect(state.workerDispatches).toBe(0); expect(f.labels).not.toContain("worker");
  if (failure === "checks") { expect(state.engineeringTurns).toBe(2); expect(f.args.filter(a => a[0] === "exec" && a[1] === "resume")).toHaveLength(2); }
});

it.each(["worker", "verify"] as const)("%s never reruns a consumed semantic recovery", async failure => {
  const f = await fixture(failure), state = await runPrerequisiteLoop(f.spec, { signal: new AbortController().signal, runner: f.runner });
  expect(state.phase).toBe("BREAK"); expect(state.workerDispatches).toBe(1); expect(f.labels.filter(x => x === "repair")).toHaveLength(1);
});

it.each(["directory", "locks", "counts", "unpinned", "authorization"] as const)("rejects substituted %s before reserving or invoking any child", async kind => {
  const f = await fixture();
  if (kind === "directory") f.spec.directory += "-new";
  if (kind === "locks") f.spec.ownershipLocks = [f.spec.directory + ".lock"];
  if (kind === "counts") f.spec.inherited.repairs = 0;
  if (kind === "unpinned") delete f.spec.retainedFiles[f.spec.workerRequestFile];
  if (kind === "authorization") f.spec.authorizationHash = "f".repeat(64);
  await expect(runPrerequisiteLoop(f.spec, { signal: new AbortController().signal, runner: f.runner })).rejects.toThrow(/PREREQUISITE_/);
  expect(f.labels).toEqual([]);
});

it.each(["hostAuthorization", "consumerProof", "stageScope", "priorInventory", "redistribution", "currentCharge", "currentBytes"] as const)("rejects %s even when the caller repins its edited request/files", async kind => {
  const f = await fixture(), identity = path.dirname(path.dirname(f.spec.directory));
  const edit = async (file: string, change: (x: any) => void) => {
    const value = JSON.parse(await fs.readFile(file, "utf8")); change(value);
    await fs.writeFile(file, JSON.stringify(value));
    f.spec.retainedFiles[file] = createHash("sha256").update(await fs.readFile(file)).digest("hex");
    return value;
  };
  if (kind === "hostAuthorization") f.spec.authorizationRef = "different authority";
  if (kind === "consumerProof") await edit(path.join(identity, "consumer-review/intent.json"), p => { p.authorizationRef = "substituted"; });
  if (kind === "stageScope") {
    const budget = await edit(path.join(identity, "identity-consumers-0.budget.json"), b => { b.intentHash = "f".repeat(64); });
    await edit(f.spec.workerRequestFile, r => { r.originalBudgetHash = contentHash(budget); });
  }
  if (kind === "priorInventory") await edit(f.spec.workerRequestFile, r => { r.priorBudgetFiles = [r.auditBudgetFile]; });
  if (kind === "redistribution") {
    await edit(path.join(identity, "identity-definition.budget.json"), b => { b.state.usage.modelCalls++; });
    const budget = await edit(path.join(identity, "identity-consumers-0.budget.json"), b => { b.state.usage.modelCalls--; });
    await edit(f.spec.workerRequestFile, r => { r.originalBudgetHash = contentHash(budget); r.originalUsage = budget.state.usage; });
  }
  if (kind === "currentCharge") {
    const budget = await edit(path.join(identity, "identity-consumers-0.budget.json"), b => {
      b.state.usage.modelCalls = 4; b.state.usage.payloads = 4; b.state.usage.totalPayloadBytes = 80;
      b.cumulative.modelCalls = 153; b.cumulative.totalPayloadBytes = 1120;
    });
    await edit(f.spec.workerRequestFile, r => { r.originalBudgetHash = contentHash(budget); r.originalUsage = budget.state.usage; r.cumulativeBeforeRecovery = budget.cumulative; });
  }
  if (kind === "currentBytes") {
    const budget = await edit(path.join(identity, "identity-consumers-0.budget.json"), b => {
      b.state.usage.totalPayloadBytes = 80; b.cumulative.totalPayloadBytes = 1120;
    });
    expect(budget.state.usage.modelCalls).toBe(5); expect(budget.state.usage.payloads).toBe(5);
    expect(budget.cumulative.modelCalls).toBe(154);
    await edit(f.spec.workerRequestFile, r => { r.originalBudgetHash = contentHash(budget); r.originalUsage = budget.state.usage; r.cumulativeBeforeRecovery = budget.cumulative; });
  }
  await expect(runPrerequisiteLoop(f.spec, { signal: new AbortController().signal, runner: f.runner })).rejects.toThrow(
    kind === "currentBytes" ? /PREREQUISITE_FAILED_CHARGE_CHANGED/ : /PREREQUISITE_/);
  expect(f.labels).toEqual([]);
});

it("uses a filesystem-read-only, network-isolated child for preflight and verification", async () => {
  const f = await fixture(); await runPrerequisiteLoop(f.spec, { signal: new AbortController().signal, runner: f.runner });
  for (const label of ["preflight", "verification"]) {
    const args = f.args[f.labels.indexOf(label)]!;
    expect(args).toContain("--unshare-net"); expect(args.slice(args.indexOf("--ro-bind"), args.indexOf("--ro-bind") + 3)).toEqual(["--ro-bind", "/", "/"]);
  }
});

it("the production compile-novel supervisor uses the same registered engineering UUID without renewing its creation time", async () => {
  const f = await fixture(); await fs.rm(f.spec.parentStateFile);
  for (const dir of ["src/runtime/compile-loop", "node_modules/typescript/bin"]) await fs.mkdir(path.join(f.spec.root, dir), { recursive: true });
  for (const file of ["src/runtime/compile-loop/worker.ts", "node_modules/typescript/bin/tsc"]) await fs.writeFile(path.join(f.spec.root, file), "");
  const ok = { code: 0, signal: null, error: null, timedOut: false, cancelled: false };
  const runner: typeof runLoopChild = async c => {
    const label = path.basename(c.prefix).replace(/^\d+-/, "");
    if (["repair", "review", "types", "tests"].includes(label)) return f.runner(c);
    if (label === "inspect") await fs.writeFile(c.args.at(-1)!, JSON.stringify({ compilerLock: { present: false },
      sources: [{ sourceId: f.spec.sourceId, sourceSha256: "b".repeat(64), sourceIntegrity: "verified" }],
      compilation: [{ run: { history: [{ phase: "roles", status: "blocked", error: "original source defect" }] } }] }));
    else if (label === "worker") await fs.writeFile(c.args.at(-1)!, JSON.stringify({ status: "succeeded" }));
    else if (label === "delivery") await fs.writeFile(c.args.at(-2)!, JSON.stringify({ verified: true, reason: "fixture delivery verified" }));
    return ok;
  };
  const state = await runCompileLoop({ request: { root: f.spec.root, sourceId: f.spec.sourceId }, sourceHash: "b".repeat(64),
    engineerModel: "gpt-5.6-sol", signal: new AbortController().signal, onProgress() {}, runner });
  expect(state.phase).toBe("DONE"); expect(f.args[0]!.slice(-2)).toEqual([engineerId, "-"]);
  const registered = JSON.parse(await fs.readFile(f.spec.registryFile, "utf8"));
  expect(registered.purpose).toBe("nwh-rebuild-review"); expect(registered.createdAt).toBe(session.createdAt);
  expect(state.engineerSession?.id).toBe(engineerId);
  // Exercise the retained-state path: a newer private timestamp cannot replace
  // an unexpired canonical UUID or renew that same UUID's creation time.
  for (const id of [reviewerId, engineerId]) {
    await fs.writeFile(f.spec.parentStateFile, JSON.stringify({ ...state, engineerSession: { id, createdAt: now + 1 } }));
    await runCompileLoop({ request: { root: f.spec.root, sourceId: f.spec.sourceId }, sourceHash: "b".repeat(64),
      engineerModel: "gpt-5.6-sol", signal: new AbortController().signal, onProgress() {}, runner });
    expect(JSON.parse(await fs.readFile(f.spec.registryFile, "utf8"))).toMatchObject({ threadId: registered.threadId, createdAt: registered.createdAt, purpose: registered.purpose });
  }
});

it.skipIf(!process.env.NWH_TEST_READONLY_SANDBOX)("OS sandbox actually denies a write outside the result directory", async () => {
  const f = await fixture(), out = path.join(f.spec.directory, "probe"); await fs.mkdir(out, { recursive: true });
  const target = path.join(f.spec.root, "src/example.ts"), result = path.join(out, "result.json");
  const script = "const fs=require('node:fs');try{fs.writeFileSync(process.argv[1],'bad');process.exitCode=9;}catch(e){fs.writeFileSync(process.argv[2],JSON.stringify({code:e.code}));}";
  const outcome = await realRunner({ command: "/usr/bin/bwrap", args: readOnlyNodeArgs(f.spec.root, out, ["-e", script, target, result]),
    cwd: f.spec.root, prefix: path.join(out, "child"), timeoutMs: 30000, signal: new AbortController().signal });
  expect(outcome.code).toBe(0); expect(await fs.readFile(target, "utf8")).toBe("existing user source\n");
  expect(JSON.parse(await fs.readFile(result, "utf8")).code).toBe("EROFS");
});

it.skipIf(!process.env.NWH_TEST_READONLY_SANDBOX)("every real child preserves registry, lock and retained budget bytes under attempted writes/deletions", async () => {
  const f = await fixture(), out = path.join(f.spec.directory, "probe"); await fs.mkdir(out, { recursive: true });
  const lock = f.spec.ownershipLocks[1]; await fs.writeFile(lock, "original owner");
  const budget = path.join(path.dirname(path.dirname(f.spec.directory)), "identity-consumers-0.budget.json");
  const targets = [f.spec.registryFile, lock, budget], before = await Promise.all(targets.map(p => fs.readFile(p, "utf8")));
  const result = path.join(out, "result.json");
  const editable = path.join(f.spec.root, "src/example.ts");
  const script = "const fs=require('node:fs');fs.writeFileSync(process.argv[2],'source edit allowed');const errors=[];for(const p of process.argv.slice(3)){for(const fn of [()=>fs.writeFileSync(p,'bad'),()=>fs.unlinkSync(p)]){try{fn();errors.push('unexpected-write');}catch(e){errors.push(e.code);}}}fs.writeFileSync(process.argv[1],JSON.stringify(errors));";
  for (const nestedCodex of [false, true]) {
    const nodeArgs = ["-e", script, result, editable, ...targets];
    // No model call: exercise the actual Codex workspace sandbox under the
    // immutable mounts, including its nested UID mapping and source edits.
    const args = nestedCodex ? ["sandbox", "-C", f.spec.root, "-P", "nwh_guard_probe", "-c",
      'permissions.nwh_guard_probe.filesystem={":root"="read",":workspace_roots"="write",":slash_tmp"="write"}', "--", process.execPath, ...nodeArgs] : nodeArgs;
    const outcome = await realRunner({ command: nestedCodex ? "codex" : process.execPath, args,
      immutablePaths: [path.join(f.spec.root, "run-records"), budget], cwd: f.spec.root,
      prefix: path.join(out, nestedCodex ? "codex" : "child"), timeoutMs: 30000, signal: new AbortController().signal });
    expect(outcome.code, await fs.readFile(path.join(out, nestedCodex ? "codex.stderr.log" : "child.stderr.log"), "utf8").catch(() => "")).toBe(0);
    expect(await Promise.all(targets.map(p => fs.readFile(p, "utf8")))).toEqual(before);
    const errors: string[] = JSON.parse(await fs.readFile(result, "utf8"));
    expect(errors).toHaveLength(6); expect(errors.every(code => ["EROFS", "EBUSY", "EACCES"].includes(code))).toBe(true);
    expect(await fs.readFile(editable, "utf8")).toBe("source edit allowed");
  }
  await expect(fs.writeFile(lock, "second owner", { flag: "wx" })).rejects.toThrow("EEXIST");
});

it.skipIf(!process.env.NWH_TEST_READONLY_SANDBOX)("native Codex command/exec can edit source but cannot overwrite or unlink guarded history, without a model or thread", async () => {
  const f = await fixture(), lock = f.spec.ownershipLocks[1]; await fs.writeFile(lock, "original owner");
  const budget = path.join(path.dirname(path.dirname(f.spec.directory)), "identity-consumers-0.budget.json");
  const targets = [f.spec.registryFile, lock, budget], before = await Promise.all(targets.map(p => fs.readFile(p, "utf8")));
  const identity = path.dirname(path.dirname(f.spec.directory)), newRecord = path.join(identity, "identity-consumers-0.record.json");
  const invocation = codexGuardCommand("codex", ["app-server"], [path.join(f.spec.root, "run-records"), identity], "workspace-write");
  const child = spawn(invocation.command, invocation.args, { cwd: f.spec.root, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  const waiting = new Map<number, (value: any) => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => { const message = JSON.parse(line); if (message.id !== undefined) waiting.get(message.id)?.(message); });
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
  const request = (id: number, method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Native exec timeout: " + stderr)), 10000);
    waiting.set(id, value => { clearTimeout(timer); resolve(value); }); send({ id, method, params });
  });
  try {
    expect((await request(1, "initialize", { clientInfo: { name: "nwh-no-model-guard-test", version: "1" } })).error).toBeUndefined();
    send({ method: "initialized" });
    const editable = path.join(f.spec.root, "src/example.ts");
    const script = "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'source edit allowed');const codes=[];for(const p of process.argv.slice(3)){for(const op of [()=>fs.writeFileSync(p,'bad'),()=>fs.unlinkSync(p)]){try{op();codes.push('unexpected-write');}catch(e){codes.push(e.code);}}}try{fs.writeFileSync(process.argv[2],'fake new record');codes.push('unexpected-write');}catch(e){codes.push(e.code);}console.log(JSON.stringify(codes));";
    const response = await request(2, "command/exec", { command: [process.execPath, "-e", script, editable, newRecord, ...targets], cwd: f.spec.root, timeoutMs: 5000 });
    expect(response.error, stderr).toBeUndefined(); expect(response.result.exitCode, response.result.stderr).toBe(0);
    const codes: string[] = JSON.parse(response.result.stdout);
    expect(codes).toHaveLength(7); expect(codes.every(c => ["EROFS", "EBUSY", "EACCES", "EPERM"].includes(c))).toBe(true);
    await expect(fs.stat(newRecord)).rejects.toThrow("ENOENT");
    expect(await Promise.all(targets.map(p => fs.readFile(p, "utf8")))).toEqual(before);
    expect(await fs.readFile(editable, "utf8")).toBe("source edit allowed");
    await expect(fs.writeFile(lock, "second owner", { flag: "wx" })).rejects.toThrow("EEXIST");
  } finally {
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    process.kill(-child.pid!, "SIGTERM"); await exited; lines.close();
  }
}, 30000);

it.skipIf(!process.env.NWH_TEST_READONLY_SANDBOX)("host checks cannot create previously absent NWH history artifacts", async () => {
  const f = await fixture(), prefix = path.join(f.spec.directory, "host-check"), scratch = prefix + ".sandbox";
  await fs.mkdir(scratch, { recursive: true });
  const newRecord = path.join(path.dirname(path.dirname(f.spec.directory)), "identity-consumers-0.record.json"), output = path.join(scratch, "result.json");
  const script = "const fs=require('node:fs');try{fs.writeFileSync(process.argv[1],'fake record');process.exitCode=9;}catch(e){fs.writeFileSync(process.argv[2],JSON.stringify({code:e.code}));}";
  const result = await realRunner({ command: process.execPath, args: ["-e", script, newRecord, output], cwd: f.spec.root, prefix,
    readOnlyRootDirectory: scratch, timeoutMs: 30000, signal: new AbortController().signal });
  expect(result.code).toBe(0); expect(JSON.parse(await fs.readFile(output, "utf8")).code).toBe("EROFS");
  await expect(fs.stat(newRecord)).rejects.toThrow("ENOENT");
});

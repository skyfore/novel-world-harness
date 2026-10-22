import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { identityRecoveryFixture } from "./helpers/identity-recovery-fixture.js";
import { withIdentityRecoveryHost, assertIdentityRecoveryPermit, inheritedIdentityEngineering, identityRecoveryTests, verifyIdentityRecoveryHostReceipt } from "../src/runtime/compile-loop/identity-recovery-host.js";
import { runIdentityRequirements } from "../src/workflow/identity-requirements.js";
import { identityConsumerContextRecovery } from "../src/workflow/identity-consumer-context-recovery.js";
import { identityContextRecoveryDirectory } from "../src/compiler/identity-requirements.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { verifyIdentityRecord } from "../src/compiler/identity-requirement-trace.js";
import { captureRecordTree } from "../src/runtime/compile-loop/dedicated-session.js";
import { contentHash as h } from "../src/world/canonical.js";
import { identityEngineeringHistory, identityEngineeringLineage } from "../src/runtime/compile-loop/identity-engineering-accounting.js";

async function consume(f: Awaited<ReturnType<typeof identityRecoveryFixture>>, runner = f.runner) {
  await withIdentityRecoveryHost(f.root, f.p, f.proof, async permit => {
    await runIdentityRequirements({ root: f.root, input: f.request.input, authorizationRef: f.request.authorizationRef,
      priorUsage: f.request.priorUsage, expectedIntentHash: f.request.expectedIntentHash, recoverContext: f.proof,
      recoveryPermit: permit, assertOriginal: async () => {} });
  }, { signal: new AbortController().signal, runner });
  return identityConsumerContextRecovery(f.root, "verify", f.proof);
}

it("binds a completed host receipt to the original deadline even when its gate and state agree on a later one", async () => {
  const f = await identityRecoveryFixture();
  try {
    await consume(f);
    const directory = path.join(identityContextRecoveryDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId), "host");
    const gate = JSON.parse(await fs.readFile(path.join(directory, "gate.json"), "utf8"));
    const state = JSON.parse(await fs.readFile(path.join(directory, "state.json"), "utf8"));
    gate.deadline += 3600_000; state.deadline = gate.deadline;
    await fs.writeFile(path.join(directory, "gate.json"), JSON.stringify(gate));
    await fs.writeFile(path.join(directory, "state.json"), JSON.stringify(state));
    const records = await new RequirementLedger(f.root, f.p.intent.sourceId).identityRequirements(f.p.intent.taskId);
    await expect(verifyIdentityRecoveryHostReceipt(f.root, f.proof, h(gate), records[2]!))
      .rejects.toThrow("no completed repository recovery host");
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
}, 30000);

it("runs repository gates then the actual recovery worker and real verifier, charging the original five calls exactly once", async () => {
  const f = await identityRecoveryFixture(), before = captureRecordTree(f.paths.identity);
  try {
    await expect(consume(f)).resolves.toMatchObject({ verified: true, taskId: f.p.intent.taskId });
    expect(f.calls).toEqual(["review", "types", "tests"]);
    const directory = identityContextRecoveryDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId);
    const budget = JSON.parse(await fs.readFile(path.join(directory, "identity-consumers-0.budget.json"), "utf8"));
    expect(budget.state.usage.modelCalls).toBe(7);
    expect(budget.inheritedUsage).toEqual(f.budget.state.usage);
    expect(budget.historicalFailure).toEqual(f.budget.state.failure);
    expect(budget.cumulative.modelCalls).toBe(143 + 4 + 7);
    const records = await new RequirementLedger(f.root, f.p.intent.sourceId).identityRequirements(f.p.intent.taskId);
    expect(records).toHaveLength(6);
    expect(records.slice(0, 2)).toEqual(f.records);
    for (const [i, record] of records.entries()) await verifyIdentityRecord(f.root, record, records.slice(0, i));
    const state = JSON.parse(await fs.readFile(path.join(directory, "host/state.json"), "utf8"));
    expect(state).toMatchObject({ phase: "DONE", workerDispatches: 1, commands: 5, engineeringTurns: 2, inherited: { commands: 1, engineeringTurns: 1 } });
    for (const [file, hash] of Object.entries(before)) expect(captureRecordTree(f.paths.identity)[file]).toBe(hash);
    await expect(consume(f)).rejects.toThrow(/already|consumed|registered/);
    expect(f.calls).toHaveLength(3);
    await expect(assertIdentityRecoveryPermit({ kind: "identity-recovery-host" }, f.root, f.proof)).rejects.toThrow(/repository host gate/);
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
}, 30000);

it.each(["review", "types", "tests", "source", "receipt", "owner"] as const)("%s failure stops the repository launcher before any recovery provider call", async failure => {
  const f = await identityRecoveryFixture(), count = f.transports.length;
  try {
    const runner: typeof f.runner = async options => {
      const result = await f.runner(options), label = path.basename(options.prefix).replace(/^\d+-/, "");
      if (label === failure) return { ...result, code: 1 };
      if (label === "tests" && failure === "source") await fs.appendFile(path.join(f.root, "novel.txt"), "changed");
      if (label === "tests" && failure === "receipt") {
        const dir = path.dirname(options.prefix);
        const old = (await fs.readdir(dir)).find(file => file.endsWith("review.result.json"))!;
        await fs.writeFile(path.join(dir, old), "{}");
      }
      if (label === "tests" && failure === "owner") await fs.writeFile(f.spec.ownershipLocks[0]!, "{\"token\":\"changed\"}");
      return result;
    };
    await expect(consume(f, runner)).rejects.toThrow();
    expect(f.transports).toHaveLength(count);
    const dir = identityContextRecoveryDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId);
    const state = JSON.parse(await fs.readFile(path.join(dir, "host/state.json"), "utf8"));
    expect(state.phase).toBe("BREAK"); expect(state.workerDispatches).toBe(0);
    await expect(consume(f, runner)).rejects.toThrow();
    expect(f.transports).toHaveLength(count);
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
}, 30000);

it("refuses missing gates, the legacy supervisor request and exhausted imported engineering commands before dispatch", async () => {
  const f = await identityRecoveryFixture();
  try {
    await expect(runIdentityRequirements({ root: f.root, input: f.request.input, authorizationRef: f.request.authorizationRef,
      priorUsage: f.request.priorUsage, expectedIntentHash: f.request.expectedIntentHash, recoverContext: f.proof,
      assertOriginal: async () => {} })).rejects.toThrow(/repository host gate/);
    await expect(identityConsumerContextRecovery(f.root, "run", f.request as any)).rejects.toThrow(/stopped supervisor request/);
    expect(f.calls).toHaveLength(0);
    const imported = path.join(f.root, "old-engineering"); await fs.mkdir(imported);
    const history = identityEngineeringHistory(f.proof, f.paths.directory), total = { commands: 21, engineeringTurns: 1 };
    await fs.writeFile(path.join(imported, "state.json"), JSON.stringify({ phase: "BREAK", childPid: null, workerDispatches: 0, ...total,
      budgetLineage: identityEngineeringLineage(f.proof, history.head, history.usage, total) }));
    const proof = { ...f.proof, version: 2 as const, engineeringHistory: [{ directory: imported, stateFile: "state.json", accounting: "cumulative" as const, files: captureRecordTree(imported) }] };
    expect(inheritedIdentityEngineering(proof, f.paths.directory).commands).toBe(21);
    await expect(withIdentityRecoveryHost(f.root, f.p, proof, async () => { throw Error("must not run"); }, { runner: f.runner, signal: new AbortController().signal })).rejects.toThrow(/budget/);
    expect(f.calls).toHaveLength(0);
    expect(identityRecoveryTests).toContain("test/identity-real-chain.test.ts");
    expect(identityRecoveryTests).toContain("test/compile-loop.test.ts");
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
}, 30000);

it("exhausts exactly the inherited stage allowance and preserves the failed transcript without another recovery", async () => {
  const f = await identityRecoveryFixture(), original = captureRecordTree(f.paths.identity);
  try {
    f.controls.exhaustRecovery = true;
    await expect(consume(f)).rejects.toThrow(/model-call limit/);
    const directory = identityContextRecoveryDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId);
    const budget = JSON.parse(await fs.readFile(path.join(directory, "identity-consumers-0.budget.json"), "utf8"));
    expect(budget.state.usage.modelCalls).toBe(24);
    expect(budget.cumulative.modelCalls).toBe(143 + 4 + 24);
    expect(budget.historicalFailure).toEqual(f.budget.state.failure);
    const checkpoint = JSON.parse(await fs.readFile(path.join(directory, "identity-consumers-0.session-checkpoint.json"), "utf8"));
    expect(checkpoint.status).toBe("failed"); expect(checkpoint.persisted).toBe(true);
    expect(h(await fs.readFile(checkpoint.sessionFile, "utf8"))).toBe(checkpoint.transcriptHash);
    for (const [file, hash] of Object.entries(original)) expect(captureRecordTree(f.paths.identity)[file]).toBe(hash);
    const count = f.transports.length;
    await expect(consume(f)).rejects.toThrow(/already|consumed/);
    expect(f.transports).toHaveLength(count);
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
}, 30000);

it("keeps the original expired deadline and refuses a new host claim without a provider or engineering command", async () => {
  const f = await identityRecoveryFixture(), count = f.transports.length;
  try {
    vi.spyOn(Date, "now").mockReturnValue(f.spec.deadline + 1);
    await expect(consume(f)).rejects.toThrow(/deadline expired/);
    expect(f.calls).toEqual([]); expect(f.transports).toHaveLength(count);
    await expect(fs.stat(path.join(identityContextRecoveryDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId), "host/start.json"))).rejects.toThrow();
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
}, 30000);

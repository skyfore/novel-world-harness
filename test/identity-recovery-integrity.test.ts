import fs from "node:fs/promises";
import path from "node:path";
import { it, expect, vi } from "vitest";
import { identityRecoveryFixture } from "./helpers/identity-recovery-fixture.js";
import { realIdentityFixture } from "./helpers/identity-real-fixture.js";
import { withIdentityRecoveryHost, assertIdentityRecoveryPermit, type IdentityRecoveryPermit } from "../src/runtime/compile-loop/identity-recovery-host.js";
import { identityEngineeringHistory, identityEngineeringLineage } from "../src/runtime/compile-loop/identity-engineering-accounting.js";
import { captureRecordTree } from "../src/runtime/compile-loop/dedicated-session.js";
import { runIdentityRequirements } from "../src/workflow/identity-requirements.js";
import { identityConsumerContextRecovery } from "../src/workflow/identity-consumer-context-recovery.js";
import { identityContextRecoveryDirectory, identityRequirementDirectory } from "../src/compiler/identity-requirements.js";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { verifyIdentityRecord } from "../src/compiler/identity-requirement-trace.js";
import { contentHash } from "../src/world/canonical.js";

type Fixture = Awaited<ReturnType<typeof identityRecoveryFixture>>;
const worker = (f: Fixture, permit: IdentityRecoveryPermit) => runIdentityRequirements({ root: f.root, input: f.request.input,
  authorizationRef: f.request.authorizationRef, priorUsage: f.request.priorUsage, expectedIntentHash: f.request.expectedIntentHash,
  recoverContext: f.proof, recoveryPermit: permit, assertOriginal: async () => {} });

it.each([false, true])("rejects relabeling a local engineering attempt as cumulative before issuing a worker permit (lineage=%s)", async withLineage => {
  const f = await identityRecoveryFixture();
  try {
    const imported = path.join(f.root, "local-engineering-attempt"); await fs.mkdir(imported);
    const history = identityEngineeringHistory(f.proof, f.paths.directory);
    await fs.writeFile(path.join(imported, "state.json"), JSON.stringify({ phase: "BREAK", childPid: null, workerDispatches: 0,
      commands: 20, engineeringTurns: 1, accounting: "local", inherited: { commands: 0, engineeringTurns: 0 },
      ...(withLineage ? { budgetLineage: { ...identityEngineeringLineage(f.proof, history.head, history.usage, { commands: 21, engineeringTurns: 2 }), mode: "local" } } : {}) }));
    const proof = { ...f.proof, version: 2 as const, engineeringHistory: [{ directory: imported, stateFile: "state.json", files: captureRecordTree(imported), accounting: "cumulative" as const }] };
    await expect(withIdentityRecoveryHost(f.root, f.p, proof, async () => ({ workerPermitIssued: true }),
      { runner: f.runner, signal: new AbortController().signal })).rejects.toThrow();
    expect(f.calls).toEqual([]);
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
});

it("rejects public acceptance of a complete worker whose owning host never completed and is now dead and expired", async () => {
  const f = await identityRecoveryFixture();
  try {
    await withIdentityRecoveryHost(f.root, f.p, f.proof, permit => worker(f, permit), { signal: new AbortController().signal, runner: f.runner });
    const file = path.join(identityContextRecoveryDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId), "host/state.json");
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    // Same durable state left by a crash before the host's final checked()/DONE.
    await fs.writeFile(file, JSON.stringify({ ...state, phase: "WORKER", childPid: 2147483647 }));
    vi.spyOn(Date, "now").mockReturnValue(f.spec.deadline + 1);
    await expect(identityConsumerContextRecovery(f.root, "verify", f.proof)).rejects.toThrow();
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
}, 30000);

it("permits only provisional registration while the host is live, and requires a sealed completion for public and idempotent acceptance", async () => {
  const f = await identityRecoveryFixture(); let consumed: IdentityRecoveryPermit | undefined;
  try {
    const ledger = new RequirementLedger(f.root, f.p.intent.sourceId);
    await withIdentityRecoveryHost(f.root, f.p, f.proof, async permit => {
      consumed = permit; await worker(f, permit);
      const records = await ledger.identityRequirements(f.p.intent.taskId), record = records.at(-1)!;
      await expect(identityConsumerContextRecovery(f.root, "verify", f.proof)).rejects.toThrow(/completed repository/);
      await expect(ledger.recordIdentityRequirements(record)).rejects.toThrow(/completed repository/);
      await expect(verifyIdentityRecord(f.root, record, records.slice(0, -1), f.p, { kind: "identity-recovery-host" })).rejects.toThrow(/repository host gate/);
      await expect(ledger.recordIdentityRequirements(record, permit)).resolves.toBeUndefined();
    }, { signal: new AbortController().signal, runner: f.runner });
    await expect(assertIdentityRecoveryPermit(consumed, f.root, f.proof)).rejects.toThrow(/repository host gate/);
    // A genuinely completed historic receipt remains verifiable after its deadline.
    vi.spyOn(Date, "now").mockReturnValue(f.spec.deadline + 1);
    await expect(identityConsumerContextRecovery(f.root, "verify", f.proof)).resolves.toMatchObject({ verified: true });
    const dir = identityContextRecoveryDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId), file = path.join(dir, "host/completion.json");
    const records = await ledger.identityRequirements(f.p.intent.taskId), record = records.at(-1)!, completion = await fs.readFile(file, "utf8");
    for (const corrupted of [JSON.stringify({ ...JSON.parse(completion), recordHashes: [] }), null]) {
      if (corrupted) await fs.writeFile(file, corrupted); else await fs.rm(file);
      await expect(identityConsumerContextRecovery(f.root, "verify", f.proof)).rejects.toThrow();
      await expect(ledger.recordIdentityRequirements(record)).rejects.toThrow();
      await fs.writeFile(file, completion);
    }
    await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ phase: "DONE", childPid: null, contextRecoveryHash: contentHash(f.proof) }));
    await expect(identityConsumerContextRecovery(f.root, "verify", f.proof)).rejects.toThrow(/final host receipt/);
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
}, 30000);

it("never completes a host when the callback returns without the actual worker", async () => {
  const f = await identityRecoveryFixture();
  try {
    await expect(withIdentityRecoveryHost(f.root, f.p, f.proof, async () => ({ verified: true }),
      { signal: new AbortController().signal, runner: f.runner })).rejects.toThrow();
    const dir = identityContextRecoveryDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId);
    expect(JSON.parse(await fs.readFile(path.join(dir, "host/state.json"), "utf8")).phase).toBe("BREAK");
    await expect(fs.stat(path.join(dir, "host/completion.json"))).rejects.toThrow();
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
});

it.each(["deadline", "owner"] as const)("retains provisional worker records without authority when final %s verification fails", async failure => {
  const f = await identityRecoveryFixture(), original = captureRecordTree(f.paths.identity);
  try {
    await expect(withIdentityRecoveryHost(f.root, f.p, f.proof, async permit => {
      await worker(f, permit);
      if (failure === "deadline") vi.spyOn(Date, "now").mockReturnValue(f.spec.deadline + 1);
      else await fs.writeFile(f.spec.ownershipLocks[0]!, JSON.stringify({ token: "foreign owner", pid: process.pid }));
    }, { signal: new AbortController().signal, runner: f.runner })).rejects.toThrow(failure === "deadline" ? /deadline expired/ : /ownership changed/);
    const dir = identityContextRecoveryDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId);
    expect(JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")).phase).toBe("DONE");
    expect(JSON.parse(await fs.readFile(path.join(dir, "host/state.json"), "utf8"))).toMatchObject({ phase: "BREAK", workerDispatches: 1, commands: 5 });
    await expect(fs.stat(path.join(dir, "host/completion.json"))).rejects.toThrow();
    await expect(identityConsumerContextRecovery(f.root, "verify", f.proof)).rejects.toThrow(/completed repository/);
    for (const [file, hash] of Object.entries(original)) expect(captureRecordTree(f.paths.identity)[file]).toBe(hash);
    const calls = f.transports.length;
    await expect(withIdentityRecoveryHost(f.root, f.p, f.proof, permit => worker(f, permit), { signal: new AbortController().signal, runner: f.runner })).rejects.toThrow();
    expect(f.transports).toHaveLength(calls);
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
}, 30000);

it("charges verified imported deltas and rechecks their bytes during final public acceptance", async () => {
  const f = await identityRecoveryFixture();
  try {
    const dir = path.join(f.root, "retained-engineering-check"); await fs.mkdir(dir);
    const history = identityEngineeringHistory(f.proof, f.paths.directory), total = { commands: 2, engineeringTurns: 1 };
    await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ phase: "BREAK", childPid: null, workerDispatches: 0, ...total,
      budgetLineage: identityEngineeringLineage(f.proof, history.head, history.usage, total) }));
    if (f.proof.version !== 2) throw Error("fixture requires v2 proof");
    f.proof.engineeringHistory.push({ directory: dir, stateFile: "state.json", files: captureRecordTree(dir), accounting: "cumulative" });
    await withIdentityRecoveryHost(f.root, f.p, f.proof, permit => worker(f, permit), { signal: new AbortController().signal, runner: f.runner });
    const host = path.join(identityContextRecoveryDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId), "host");
    expect(JSON.parse(await fs.readFile(path.join(host, "state.json"), "utf8"))).toMatchObject({ commands: 6, engineeringTurns: 2, inherited: total });
    await expect(identityConsumerContextRecovery(f.root, "verify", f.proof)).resolves.toMatchObject({ verified: true });
    await fs.appendFile(path.join(dir, "state.json"), " ");
    await expect(identityConsumerContextRecovery(f.root, "verify", f.proof)).rejects.toThrow(/Engineering receipt changed/);
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
}, 30000);

it("requires the provider to receive evidence results before submitting instead of batching reads with its answer", async () => {
  const f = await realIdentityFixture();
  try {
    f.controls.submitWithReads = true;
    await expect(f.run()).rejects.toThrow(/submission must follow a request/);
    expect(await new RequirementLedger(f.root, f.p.intent.sourceId).identityRequirements(f.p.intent.taskId)).toEqual([]);
    const dir = identityRequirementDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId);
    const checkpoint = JSON.parse(await fs.readFile(path.join(dir, "identity-definition.session-checkpoint.json"), "utf8"));
    expect(checkpoint.status).toBe("failed"); expect(checkpoint.usage.modelCalls).toBe(1);
    expect(await fs.readFile(path.join(dir, "identity-definition.messages.jsonl"), "utf8")).toContain("submit-without-seeing-results");
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
});

it.each(["source", "dependency", "first-signature", "last-signature", "terminal-result", "source-and-live"] as const)(
  "rejects %s lost before sealing, even when the settled trace is intact", async corruption => {
  const f = await realIdentityFixture();
  let changed = false;
  const create = vi.mocked(PiAgentSession.create).getMockImplementation()!;
  vi.mocked(PiAgentSession.create).mockImplementation(async options => {
    const session = await create(options), dispose = session.dispose.bind(session);
    session.dispose = async () => {
      await dispose();
      if (!changed && session.sessionFile) {
        const entries = (await fs.readFile(session.sessionFile, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
        const assistants = entries.filter(e => e.type === "message" && e.message.role === "assistant");
        const result = entries.find(e => e.type === "message" && e.message.role === "toolResult"
          && e.message.toolName === (corruption === "dependency" ? "read_identity_dependencies" : "read_identity_source"));
        if (corruption.endsWith("signature")) {
          const entry = corruption === "last-signature" ? assistants.at(-1) : assistants[0];
          entry.message.content.find((b: any) => b.type === "thinking").thinkingSignature = "lost opaque state";
        } else if (corruption === "terminal-result") {
          entries.findLast(e => e.type === "message" && e.message.role === "toolResult").message.content = [{ type: "text", text: JSON.stringify({ retained: true, authorityGranted: true }) }];
        } else {
          result.message.content = [{ type: "text", text: JSON.stringify(corruption === "dependency" ? { items: [] } : { segments: [] }) }];
        }
        if (result) {
          await fs.writeFile(session.sessionFile, entries.map(e => JSON.stringify(e)).join("\n") + "\n"); changed = true;
          if (corruption === "source-and-live") {
            const file = path.join(identityRequirementDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId), "identity-definition.messages.jsonl");
            const journal = (await fs.readFile(file, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
            journal.find(row => row.message.role === "toolResult" && row.message.toolCallId === result.message.toolCallId).message = result.message;
            await fs.writeFile(file, journal.map(row => JSON.stringify(row)).join("\n") + "\n");
          }
        }
      }
    };
    return session;
  });
  try {
    await expect(f.run()).rejects.toThrow(corruption === "source-and-live" ? /complete transcript prefix/ : /live message evidence/);
    expect(await new RequirementLedger(f.root, f.p.intent.sourceId).identityRequirements(f.p.intent.taskId)).toEqual([]);
    const directory = identityRequirementDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId);
    const checkpoint = JSON.parse(await fs.readFile(path.join(directory, "identity-definition.session-checkpoint.json"), "utf8"));
    expect(checkpoint.status).toBe("failed"); expect(checkpoint.usage.modelCalls).toBe(2);
    expect(checkpoint.messagesHash).toBe(contentHash(await fs.readFile(path.join(directory, "identity-definition.messages.jsonl"), "utf8")));
    expect(checkpoint.requestsHash).toBe(contentHash(await fs.readFile(path.join(directory, "identity-definition.requests.jsonl"), "utf8")));
    expect(checkpoint.transcriptHash).toBe(contentHash(await fs.readFile(checkpoint.sessionFile, "utf8")));
  } finally { expect(changed).toBe(true); vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
}, 30000);

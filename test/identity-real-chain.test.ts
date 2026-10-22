import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { contentHash as h } from "../src/world/canonical.js";
import { identityRequirementDirectory, identityRequirementsReady, type IdentityRecord } from "../src/compiler/identity-requirements.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { verifyIdentityRecord } from "../src/compiler/identity-requirement-trace.js";
import { decodeJsonValues, LOSSLESS_CONTEXT_PROTOCOL } from "../src/agent/lossless-json-context.js";
import { realIdentityFixture as fixture } from "./helpers/identity-real-fixture.js";

it("executes real Pi tools, settles/seals sessions before actual ledger verification, and rejects transcript/checkpoint tampering everywhere", async () => {
  const f = await fixture();
  try {
    await f.run();
    const ledger = new RequirementLedger(f.root, f.p.intent.sourceId), records = await ledger.identityRequirements(f.p.intent.taskId);
    expect(records).toHaveLength(6); expect(identityRequirementsReady(records)).toBe(true);
    const dir = identityRequirementDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId);
    for (const [i, record] of records.entries()) {
      await verifyIdentityRecord(f.root, record, records.slice(0, i));
      const checkpoint = JSON.parse(await fs.readFile(path.join(dir, `${record.stage}.session-checkpoint.json`), "utf8"));
      expect(h(checkpoint)).toBe(record.sessionCheckpointHash);
      expect(checkpoint.status).toBe("complete"); expect(checkpoint.transcript.responses).toBe(2);
      const raw = await fs.readFile(checkpoint.sessionFile, "utf8");
      expect(raw).toContain(`opaque-${i}-1`);
    }
    const r = records[0]!, file = path.join(dir, `${r.stage}.session-checkpoint.json`), checkpointText = await fs.readFile(file, "utf8"), c = JSON.parse(checkpointText);
    const raw = await fs.readFile(c.sessionFile, "utf8");
    for (const corrupted of [raw.split("\n")[0] + "\n", raw.slice(0, -15), raw.replace("opaque-0-0", "opaque-X-X")]) {
      await fs.writeFile(c.sessionFile, corrupted);
      await expect(verifyIdentityRecord(f.root, r, [])).rejects.toThrow(/transcript changed/);
      await expect(ledger.recordIdentityRequirements(r)).rejects.toThrow(/transcript changed/);
    }
    await fs.writeFile(c.sessionFile, raw);
    await fs.writeFile(file, JSON.stringify({ ...c, transcriptHash: h("different") }));
    await expect(verifyIdentityRecord(f.root, r, [])).rejects.toThrow(/checkpoint/);
    await fs.writeFile(file, checkpointText);
    await fs.rm(file);
    await expect(verifyIdentityRecord(f.root, r, [])).rejects.toThrow();
    await fs.writeFile(file, checkpointText);
    const changed: IdentityRecord = { ...r, sessionCheckpointHash: undefined };
    await expect(verifyIdentityRecord(f.root, changed, [])).rejects.toThrow(/checkpoint/);
    await expect(f.run()).rejects.toThrow(/already reserved/);
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
});

it("preserves an oversized legal proposal but refuses registration before dispatching its impossible independent check", async () => {
  const f = await fixture(true);
  try {
    f.outputs[2].consumers.forEach((c: any, i: number) => { c.rationale = `${i}:` + String.fromCharCode(0x4e00 + i).repeat(5900); });
    await expect(f.run()).rejects.toThrow(/complete proposal.*independent evidence/);
    const ledger = new RequirementLedger(f.root, f.p.intent.sourceId);
    expect(await ledger.identityRequirements(f.p.intent.taskId)).toHaveLength(2);
    expect(f.transports).toHaveLength(3); expect(f.transports[2]!.contexts).toHaveLength(2);
    const directory = identityRequirementDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId);
    const plan = JSON.parse(await fs.readFile(path.join(directory, "identity-consumers-0.next-context-plan.json"), "utf8"));
    expect(plan.allowed).toBe(false); expect(plan.complete.encodedBytes).toBeGreaterThan(512000);
    const checkpoint = JSON.parse(await fs.readFile(path.join(directory, "identity-consumers-0.session-checkpoint.json"), "utf8"));
    expect(checkpoint.status).toBe("failed");
    const transcript = await fs.readFile(checkpoint.sessionFile, "utf8");
    expect(transcript).toContain(f.outputs[2].consumers[47].rationale);
    await expect(fs.stat(path.join(directory, "identity-consumers-check-0.invocation.json"))).rejects.toThrow();
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
});

it("retains all 536 consumers in their original 12 shards through every independent check", async () => {
  const f = await fixture(true, false, 536), denominator = h(f.p.inventory), shards = structuredClone(f.p.intent.consumerShards);
  try {
    await f.run();
    const records = await new RequirementLedger(f.root, f.p.intent.sourceId).identityRequirements(f.p.intent.taskId);
    expect(records).toHaveLength(26); expect(identityRequirementsReady(records)).toBe(true);
    expect(new Set(records.map(r => r.sessionId)).size).toBe(26);
    const proposals = records.filter(r => r.output.phase === "identity-consumers");
    const checks = records.filter(r => r.output.phase === "identity-consumers-check");
    expect(proposals).toHaveLength(12); expect(checks).toHaveLength(12);
    for (const phases of [proposals, checks]) {
      expect(phases.flatMap(r => "consumers" in r.output ? r.output.consumers.map(c => c.ref) : []))
        .toEqual(shards.flatMap((s: { refs: string[] }) => s.refs));
    }
    expect(h(f.p.inventory)).toBe(denominator); expect(f.p.intent.consumerShards).toEqual(shards);
    const last = records.at(-1)!, directory = identityRequirementDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId);
    const budget = JSON.parse(await fs.readFile(path.join(directory, `${last.stage}.budget.json`), "utf8"));
    expect(budget.cumulative.modelCalls).toBe(143 + 52);
    expect(f.transports.flatMap(t => t.payloads).every(payload => Buffer.byteLength(JSON.stringify(payload)) <= 512000)).toBe(true);
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
}, 60000);

it("independently checks a full 48-consumer shard whose raw evidence exceeds 512000 bytes without losing a value or increasing any limit", async () => {
  const f = await fixture(true);
  try {
    await f.run();
    const ledger = new RequirementLedger(f.root, f.p.intent.sourceId), records = await ledger.identityRequirements(f.p.intent.taskId);
    expect(records).toHaveLength(4); expect(identityRequirementsReady(records)).toBe(true);
    const dir = identityRequirementDirectory(f.root, f.p.intent.sourceId, f.p.intent.taskId);
    const plan = JSON.parse(await fs.readFile(path.join(dir, "identity-consumers-check-0.context-plan.json"), "utf8"));
    expect(plan.complete.originalBytes).toBeGreaterThan(512000); expect(plan.complete.encodedBytes).toBeLessThan(512000);
    const provider = f.transports[3]!;
    expect(provider.contexts).toHaveLength(2);
    const context = provider.contexts[1]!, envelopes = context.messages.flatMap(m => {
      if (m.role !== "user" && m.role !== "toolResult") return [];
      return (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content).flatMap(b => b.type === "text" ? [JSON.parse(b.text)] : []);
    });
    expect(envelopes[0].$nwhContext).toBe(LOSSLESS_CONTEXT_PROTOCOL);
    const decoded = decodeJsonValues(envelopes[0].dictionary, envelopes.map(e => e.value)) as any[];
    expect(decoded[0].proposal).toEqual(f.outputs[2]);
    expect(decoded[0].intent.consumerShards[0].refs).toHaveLength(48);
    expect(decoded.slice(1).flatMap(v => v.items ?? []).filter(c => c.ref.startsWith("event/"))).toEqual(f.p.inventory.consumers);
    expect(decoded.slice(1).flatMap(v => v.segments ?? []).map(s => s.text).join("")).toBe(Buffer.from(f.p.bytes).toString());
    expect(provider.payloads.every(payload => Buffer.byteLength(JSON.stringify(payload)) <= 512000)).toBe(true);
    const budget = JSON.parse(await fs.readFile(path.join(dir, "identity-consumers-check-0.budget.json"), "utf8"));
    expect(budget.limits).toEqual({ maxModelCalls: 24, maxRequestBytes: 512000, maxTotalPayloadBytes: 12288000 });
    expect(budget.cumulative.modelCalls).toBe(143 + 8);
    for (const [i, r] of records.entries()) await verifyIdentityRecord(f.root, r, records.slice(0, i));
  } finally { vi.restoreAllMocks(); await fs.rm(f.root, { recursive: true, force: true }); }
});

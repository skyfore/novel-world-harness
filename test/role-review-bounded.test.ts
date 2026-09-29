import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { ensureSourceStructure } from "../src/compiler/structure.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { loadCurrentRoleRoster } from "../src/compiler/role-roster-tools.js";
import { RoleReviewWorkStore, roleReviewSpans, roleWorkStop } from "../src/compiler/role-review-work.js";
import { runBoundedRoleReview as runReview, type RoleWorkInvocation } from "../src/workflow/role-review-bounded.js";
import { buildNwhToolRecoveryAdvice } from "../src/agent/tool-recovery.js";
import { contentHash } from "../src/world/canonical.js";
import { RoleRosterStore, validateRosterReview } from "../src/compiler/role-roster.js";
const runBoundedRoleReview = (options: Parameters<typeof runReview>[0], runner: NonNullable<Parameters<typeof runReview>[1]>) => runReview(options, runner, async () => {});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function setup(text = "Hero helps Friend.\nFriend thanks Hero.\n") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-role-bounded-")); roots.push(root);
  const f = await createEvidenceFixture(root, text); await ensureSourceStructure(root, f.source);
  for (const name of ["Hero", "Friend"]) await new CanonicalModelStore(root).putEntity({ id: name.toLowerCase(), canonicalName: name,
    kind: "character", aliases: [], evidence: f.evidence(name) });
  const batchId = `role-roster-${f.source.id}-bounded`;
  const options = { root, sourceId: f.source.id, compilerBatchId: batchId, configPath: path.join(root, "absent.yaml") };
  return { root, f, batchId, options };
}
const invoke = (work: RoleWorkInvocation, name: string, input: unknown) => work.tools.find(t => t.name === name)!.execute(name, input as never, undefined, undefined, {} as ExtensionContext);
const packet = (w: RoleWorkInvocation) => JSON.parse(w.prompt.split("\n").at(-1)!);
function entry(candidateId: string, unit: string) { return { candidateId, importance: "major", rationale: "Central exchange", basisUnitIds: [unit],
  developmentExpectation: { kind: "unknown", rationale: "No long-term evidence", basisUnitIds: [unit] } }; }
async function completeFixtureWork(work: RoleWorkInvocation, unit: string) {
  if (work.workId.startsWith("role-source")) {
    const p = packet(work);
    await invoke(work, "propose_role_source_review", { summary: "Reviewed the supplied core", findings: [{ name: "Hero", observation: "Interaction", unitIds: [p.fragments[0].unitId] }], openQuestions: [] });
  } else if (work.workId.startsWith("candidate")) {
    const p = packet(work);
    await invoke(work, "read_role_work_evidence", { unitId: unit });
    await invoke(work, "propose_role_roster_entry", { subjectHash: p.subjectHash, entry: entry(p.candidate.id, unit) });
  } else await invoke(work, "propose_role_review_audit", { rationale: "All people in this core are accounted for", missingMajorCharacters: [], unresolved: [] });
}
it("partitions UTF-8 continuously, including oversized paragraphs", () => {
  const b = Buffer.from("龙".repeat(12000) + "\n\nlast"); const spans = roleReviewSpans(b);
  expect(Buffer.concat(spans.map(s => b.subarray(s.start, s.end)))).toEqual(b);
  for (const [i, s] of spans.entries()) { expect(s.start).toBe(i ? spans[i - 1]!.end : 0); expect(s.end - s.start).toBeLessThanOrEqual(6000); expect(b.subarray(s.start, s.end).toString()).not.toContain("�"); }
});
it("persists source work before candidates; resumes without rereading and retains the ordinary finish gate", async () => {
  const f = await setup(); const { roster } = await loadCurrentRoleRoster(f.root, f.f.source.id); const unit = roster.unitIds[0]!;
  await expect(runBoundedRoleReview(f.options, async work => {
    if (work.workId.startsWith("candidate")) throw new Error("injected outage");
    await completeFixtureWork(work, unit);
  })).rejects.toThrow("injected outage");
  const plans = await RoleReviewWorkStore.plans(f.root, f.f.source.id);
  expect(plans).toHaveLength(1); const store = new RoleReviewWorkStore(f.root, plans[0]!);
  expect(store.sourceComplete()).toBe(true); expect(store.auditComplete()).toBe(false);
  const { inspectCompilerStatus } = await import("../src/compiler/status.js");
  expect((await inspectCompilerStatus(f.root, f.f.source.id)).sources[0]?.roleReviewWork[0]).toMatchObject({ sourceWorks: 1, reviewedSources: 1, auditedSources: 0, stagedCandidates: 0 });
  const toolset = createCompilerProposalToolset(f.root); await toolset.beginBatch([], f.batchId, f.f.source.id);
  const preview = await toolset.tools.find(t => t.name === "preview_role_roster_review")!.execute("p", { subjectHash: roster.subjectHash } as never, undefined, undefined, {} as ExtensionContext);
  expect(JSON.parse((preview.content[0] as {text:string}).text)).toMatchObject({ nextAction: "needs_candidate_work", unreadSourcePages: [], complete: false });
  const workIds: string[] = [];
  await runBoundedRoleReview(f.options, async work => { workIds.push(work.workId); await completeFixtureWork(work, unit); });
  expect(workIds.some(id => id.startsWith("role-source"))).toBe(false);
  expect(store.auditComplete()).toBe(true);
  expect(await new RoleRosterStore(f.root).read(f.f.source.id)).toBeNull(); // Local receipt is not global finish.
  const final = createCompilerProposalToolset(f.root); await final.beginBatch([], f.batchId, f.f.source.id);
  const call = (name:string, args:unknown) => final.tools.find(t => t.name === name)!.execute(name, args as never, undefined, undefined, {} as ExtensionContext);
  await call("propose_role_roster_review", { subjectHash: roster.subjectHash, staged: true });
  await call("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Bounded fixture review" });
  const saved = (await new RoleRosterStore(f.root).read(f.f.source.id))!;
  expect(saved.reviews).toHaveLength(1);
  expect(saved.reviews[0]).toMatchObject({ version: 3, workEvidence: { version: 1 } });
  const downgraded = structuredClone(saved.reviews[0]!); delete downgraded.workEvidence;
  expect(validateRosterReview({ ...saved, reviews: [] }, downgraded).map(x=>x.code)).toContain("ROSTER_WORK_EVIDENCE_REQUIRED");
  const changed = structuredClone(saved.reviews[0]!); changed.entries[0]!.rationale = "Tampered";
  expect(validateRosterReview({ ...saved, reviews: [] }, changed).map(x=>x.code)).toContain("ROSTER_WORK_EVIDENCE_MISMATCH");
});
it("preserves zero-proposal work attempts and stops a third dispatch", async () => {
  const f = await setup(); let count = 0;
  const fail = async () => { count++; throw new Error("injected outage"); };
  await expect(runBoundedRoleReview(f.options, fail)).rejects.toThrow("outage");
  await expect(runBoundedRoleReview(f.options, fail)).rejects.toThrow("outage");
  await expect(runBoundedRoleReview(f.options, fail)).rejects.toThrow("allowance exhausted");
  expect(count).toBe(2); expect(await RoleReviewWorkStore.plans(f.root, f.f.source.id)).toHaveLength(1);
});
it("does not let page reads satisfy bounded review receipts or bypass audit", async () => {
  const f = await setup(); await expect(runBoundedRoleReview(f.options, async () => { throw new Error("stop"); })).rejects.toThrow();
  const { roster } = await loadCurrentRoleRoster(f.root, f.f.source.id);
  const tools = createCompilerProposalToolset(f.root); await tools.beginBatch([], f.batchId, f.f.source.id);
  const call = (name: string, input: unknown) => tools.tools.find(t => t.name === name)!.execute(name, input as never, undefined, undefined, {} as ExtensionContext);
  await call("read_roster_source_page", { page: 0 });
  await expect(call("propose_role_roster_review", { subjectHash: roster.subjectHash, entries: roster.candidates.map(c=>entry(c.id,roster.unitIds[0]!)) })).rejects.toThrow("receipts");
});
it("rejects stale scope and preserves plan and drafts", async () => {
  const f = await setup(); await expect(runBoundedRoleReview(f.options, async () => { throw new Error("stop"); })).rejects.toThrow();
  const before = await RoleReviewWorkStore.plans(f.root, f.f.source.id);
  const canon = new CanonicalModelStore(f.root); const e = (await canon.listEntities())[0]!;
  await canon.putEntity({ ...e, aliases: ["changed"] });
  await expect(runBoundedRoleReview(f.options, async () => {})).rejects.toThrow("revision changed");
  expect(await RoleReviewWorkStore.plans(f.root, f.f.source.id)).toEqual(before);
});
it("keeps source discoveries isolated between independent review batches", async () => {
  const f = await setup(); const { roster } = await loadCurrentRoleRoster(f.root, f.f.source.id);
  await runBoundedRoleReview(f.options, w => completeFixtureWork(w, roster.unitIds[0]!));
  const second = { ...f.options, compilerBatchId: f.batchId + "-second" }; let saw = false;
  await expect(runBoundedRoleReview(second, async work => { saw = true; expect(work.workId.startsWith("role-source")).toBe(true); expect(work.prompt).not.toContain("Central exchange"); throw new Error("stop"); })).rejects.toThrow("stop");
  expect(saw).toBe(true);
});
it("returns actionable recovery but gives host and circuit stops precedence", () => {
  expect(buildNwhToolRecoveryAdvice("propose_role_source_review", roleWorkStop("invalid scope").message)).toMatchObject({ retryable: false, category: "host-repair-required" });
  expect(buildNwhToolRecoveryAdvice("read_role_work_evidence", "Unknown unit")).toMatchObject({ retryable: true });
  expect(buildNwhToolRecoveryAdvice("read_role_work_evidence", "compiler tool-call safety fuse tripped")).toMatchObject({ retryable: false });
});

it("bounds dense identifier overhead while retaining every original byte", async () => {
  const { boundedRoleReviewSpans, roleReviewSourcePacket } = await import("../src/compiler/role-review-context.js");
  const bytes = Buffer.from("x".repeat(6000));
  const units = Array.from({ length: 6000 }, (_, index) => ({ id: `unit-${"a".repeat(80)}-${index}`, anchor: { startByte: index, endByte: index + 1 } }));
  const spans = boundedRoleReviewSpans(bytes, units);
  expect(spans.length).toBeGreaterThan(1);
  const packets = spans.map(s => roleReviewSourcePacket(bytes, units, s));
  expect(packets.map(p => p.fragments.map(f => f.text).join("")).join("")).toBe(bytes.toString());
  expect(packets.every(p => Buffer.byteLength(JSON.stringify(p)) <= 16000)).toBe(true);
});
it("rejects candidate submission based only on note IDs, before it can become a successful draft", async () => {
  const f = await setup(); const { roster } = await loadCurrentRoleRoster(f.root, f.f.source.id);
  await expect(runBoundedRoleReview(f.options, async work => {
    if (!work.workId.startsWith("candidate")) return completeFixtureWork(work, roster.unitIds[0]!);
    const p = packet(work);
    await invoke(work, "propose_role_roster_entry", { subjectHash: p.subjectHash, entry: entry(p.candidate.id, roster.unitIds[0]!) });
  })).rejects.toThrow("Unread role work evidence");
  const store = new RoleReviewWorkStore(f.root, (await RoleReviewWorkStore.plans(f.root, f.f.source.id))[0]!);
  expect(store.journal.latestAttempts("propose_role_roster_entry").filter(a=>a.status==="succeeded")).toHaveLength(0);
});
it("makes budget rejection terminal before a giant payload can be dispatched", async () => {
  const { ModelRequestBudget } = await import("../src/agent/model-request-budget.js");
  const { ROLE_WORK_LIMITS } = await import("../src/workflow/role-review-bounded.js");
  const budget = new ModelRequestBudget(ROLE_WORK_LIMITS);
  expect(() => budget.admitPayload({ history: "原文".repeat(100000) })).toThrow("budget exhausted");
  expect(budget.snapshot().payloads).toBe(0);
  expect(() => budget.admitPayload({ small: true })).toThrow("budget exhausted");
});
it("invalidates audit receipts when a staged entry changes", async () => {
  const f = await setup(); const { roster } = await loadCurrentRoleRoster(f.root, f.f.source.id);
  await runBoundedRoleReview(f.options, w => completeFixtureWork(w, roster.unitIds[0]!));
  const store = new RoleReviewWorkStore(f.root, (await RoleReviewWorkStore.plans(f.root, f.f.source.id))[0]!);
  expect(store.auditComplete()).toBe(true);
  const candidate = store.journal.latestAttempts("propose_role_roster_entry")[0]!;
  const modified = structuredClone(candidate.input) as {entry:{rationale:string}};
  modified.entry.rationale = "New independent finding";
  store.journal.record(candidate.tool, modified, "succeeded");
  expect(() => store.auditComplete()).toThrow("entries changed after audit");
});
it("keeps unresolved audit findings durable and stops global assembly", async () => {
  const f = await setup(); const { roster } = await loadCurrentRoleRoster(f.root, f.f.source.id);
  await expect(runBoundedRoleReview(f.options, async w => {
    if (w.workId.startsWith("role-audit")) await invoke(w,"propose_role_review_audit", { rationale:"Unresolved identity", missingMajorCharacters:[], unresolved:["Possible omitted person"] });
    else await completeFixtureWork(w,roster.unitIds[0]!);
  })).rejects.toThrow("unresolved semantic work");
  const store = new RoleReviewWorkStore(f.root, (await RoleReviewWorkStore.plans(f.root, f.f.source.id))[0]!);
  expect(store.read("audit",0)?.unresolved).toEqual(["Possible omitted person"]);
  expect(store.auditComplete()).toBe(false);
});

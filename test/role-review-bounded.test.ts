import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
    await invoke(work, "propose_role_source_review", { summary: "Reviewed the supplied core", findings: [{ name: "Hero", observation: "Interaction", unitIds: [p.assignedCoreUnitIds?.[0] ?? p.fragments[0].unitId] }], openQuestions: [] });
  } else if (work.workId.startsWith("candidate")) {
    const p = packet(work);
    await invoke(work, "read_role_work_evidence", { unitId: unit });
    await invoke(work, "propose_role_roster_entry", { subjectHash: p.subjectHash, entry: entry(p.candidate.id, unit) });
  } else if (work.workId.startsWith("role-claim")) {
    const p = packet(work);
    for (const unitId of p.requiredEvidenceUnitIds) await invoke(work, "read_role_work_evidence", { unitId });
    await invoke(work, "propose_role_claim_audit", { candidateId: p.candidateId, claimRevision: p.claimRevision, atlasRevision: p.atlasRevision, packetHash:p.packetHash,
      verdict: "supported", rationale: "Matches exchange; development remains unknown", basisUnitIds: [unit], counterevidence: {searchedUnitIds: [unit], rationale: "No contrary passage in this fixture"}, checks: fixtureChecks(unit) });
  } else {
    await invoke(work, "read_role_work_evidence", { unitId: unit });
    await invoke(work, "read_role_audit_inventory", {});
    await invoke(work, "propose_role_review_audit", fixtureAudit(work, unit));
  }
}
function fixtureChecks(unit: string) { return ["importance", "identity", "development"].map(kind => ({kind, verdict:"supported", rationale:"Fixture evidence supports this dimension", basisUnitIds:[unit]})); }
function fixtureAudit(work: RoleWorkInvocation, unit: string) {
  const p = packet(work);
  return { rationale: "All people in this core are accounted for", missingMajorCharacters: [], unresolved: [], atlasRevision: p.atlasRevision,
    questionDispositions: p.expectedQuestions.map((q: {questionId: string}) => ({questionId: q.questionId, status: "resolved", rationale: "Fixture evidence answers it", basisUnitIds: [unit]})),
    discoveryDispositions: p.discoveries.map((d: {findingId: string}) => ({findingId: d.findingId, candidateIds: [p.candidates[0].id], disposition: "mapped", rationale: "Discovered name represented in supplied claim", basisUnitIds: [unit]})) };
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
  expect(saved.reviews[0]).toMatchObject({ version: 4, workEvidence: { version: 2 } });
  const downgraded = structuredClone(saved.reviews[0]!); delete downgraded.workEvidence;
  expect(validateRosterReview({ ...saved, reviews: [] }, downgraded).map(x=>x.code)).toContain("ROSTER_WORK_EVIDENCE_REQUIRED");
  const legacyProof = structuredClone(saved.reviews[0]!); legacyProof.workEvidence!.version = 1;
  expect(validateRosterReview({ ...saved, reviews: [] }, legacyProof).map(x=>x.code)).toContain("ROSTER_WORK_EVIDENCE_REQUIRED");
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
  expect(() => store.auditComplete()).toThrow(/changed after audit/);
});
it("keeps unresolved audit findings durable and stops global assembly", async () => {
  const f = await setup(); const { roster } = await loadCurrentRoleRoster(f.root, f.f.source.id);
  await expect(runBoundedRoleReview(f.options, async w => {
    if (w.workId.startsWith("role-audit")) {
      await invoke(w, "read_role_work_evidence", {unitId: roster.unitIds[0]!});
      await invoke(w, "read_role_audit_inventory", {});
      await invoke(w,"propose_role_review_audit", { ...fixtureAudit(w, roster.unitIds[0]!), rationale:"Unresolved identity", unresolved:["Possible omitted person"] });
    }
    else await completeFixtureWork(w,roster.unitIds[0]!);
  })).rejects.toThrow("unresolved semantic work");
  const store = new RoleReviewWorkStore(f.root, (await RoleReviewWorkStore.plans(f.root, f.f.source.id))[0]!);
  expect(store.read("audit",0)?.unresolved).toEqual(["Possible omitted person"]);
  expect(store.auditComplete()).toBe(false);
});

it("cannot erase a source question with empty audit dispositions", async () => {
  const f = await setup(); const { roster } = await loadCurrentRoleRoster(f.root, f.f.source.id); const unit = roster.unitIds[0]!;
  await expect(runBoundedRoleReview(f.options, async work => {
    if (work.workId.startsWith("role-source")) {
      await invoke(work, "propose_role_source_review", {summary: "Ambiguous reference", findings: [], openQuestions: ["Does Friend refer to Hero?"]});
    } else if (work.workId.startsWith("role-audit")) {
      expect(packet(work).expectedQuestions).toHaveLength(1);
      await invoke(work, "propose_role_review_audit", {...fixtureAudit(work, unit), questionDispositions: []});
    } else await completeFixtureWork(work, unit);
  })).rejects.toThrow("Incomplete audit responsibilities");
  const {RequirementLedger} = await import("../src/compiler/requirement-ledger.js");
  const history = await new RequirementLedger(f.root, f.f.source.id).history();
  expect(history.filter(r => r.payload.kind === "role-review-question")).toHaveLength(1);
  expect(history.filter(r => r.payload.kind === "role-review-question-disposition")).toHaveLength(0);
});
it("requires original evidence AND mapped judgments during source audit", async () => {
  for (const readEvidence of [false, true]) {
    const f = await setup(); const { roster } = await loadCurrentRoleRoster(f.root, f.f.source.id); const unit = roster.unitIds[0]!;
    await expect(runBoundedRoleReview(f.options, async work => {
      if (!work.workId.startsWith("role-audit")) return completeFixtureWork(work, unit);
      if (readEvidence) await invoke(work, "read_role_work_evidence", {unitId: unit});
      else await invoke(work, "read_role_audit_inventory", {});
      await invoke(work, "propose_role_review_audit", fixtureAudit(work, unit));
    })).rejects.toThrow(readEvidence ? "Unread mapped claim" : "Unread role work evidence");
  }
});
it("does not adopt retained drafts without exact-revision verification", async () => {
  const f = await setup(); const {roster} = await loadCurrentRoleRoster(f.root, f.f.source.id); const unit = roster.unitIds[0]!;
  const tools = createCompilerProposalToolset(f.root); await tools.beginBatch([], f.batchId, f.f.source.id);
  await tools.tools.find(t => t.name === "read_roster_source_page")!.execute("page", {page:0} as never, undefined, undefined, {} as ExtensionContext);
  for (const c of roster.candidates) await tools.tools.find(t => t.name === "propose_role_roster_entry")!.execute("old", {subjectHash: roster.subjectHash, entry: entry(c.id, unit)} as never, undefined, undefined, {} as ExtensionContext);
  let audits = 0;
  await runBoundedRoleReview(f.options, async work => {
    expect(work.workId.startsWith("candidate")).toBe(false);
    if (work.workId.startsWith("role-claim")) { audits++; expect(packet(work).entry.rationale).toBe("Central exchange"); }
    await completeFixtureWork(work, unit);
  });
  const store = new RoleReviewWorkStore(f.root, (await RoleReviewWorkStore.plans(f.root, f.f.source.id))[0]!);
  expect(store.plan.legacyDraftHashes).toHaveLength(roster.candidates.length);
  expect(audits).toBe(roster.candidates.length);
  expect(store.journal.latestAttempts("propose_role_roster_entry").every(a => store.journal.history(a.tool, a.proposalId).filter(x => x.status === "succeeded").length === 1)).toBe(true);
});
it("retains a contradicted claim and prevents finish on every resume", async () => {
  const f = await setup(); const {roster} = await loadCurrentRoleRoster(f.root, f.f.source.id); const unit = roster.unitIds[0]!;
  let finalized = false;
  await expect(runReview(f.options, async work => {
    if (!work.workId.startsWith("role-claim")) return completeFixtureWork(work, unit);
    const p = packet(work);
    await invoke(work, "propose_role_claim_audit", {candidateId: p.candidateId, claimRevision: p.claimRevision, atlasRevision: p.atlasRevision, packetHash:p.packetHash,
      verdict: "contradicted", rationale: "Counterevidence contradicts importance", basisUnitIds: [unit], counterevidence: {searchedUnitIds: [unit], rationale: "Counterexample"}, checks: fixtureChecks(unit)});
  }, async () => {finalized = true;})).rejects.toThrow("requires evidence or semantic repair");
  let resumedCalls = 0;
  await expect(runBoundedRoleReview(f.options, async () => {resumedCalls++;})).rejects.toThrow("requires evidence or semantic repair");
  expect(finalized).toBe(false); expect(resumedCalls).toBe(0);
});
it("preserves question provenance and audit dispositions in the existing requirement ledger", async () => {
  const f = await setup(); const {roster} = await loadCurrentRoleRoster(f.root, f.f.source.id); const unit = roster.unitIds[0]!;
  await runBoundedRoleReview(f.options, async work => {
    if (work.workId.startsWith("role-source")) await invoke(work, "propose_role_source_review", {summary: "Identity question", findings: [], openQuestions: ["Who is Friend?"]});
    else await completeFixtureWork(work, unit);
  });
  const {RequirementLedger, requirementJournalSchema} = await import("../src/compiler/requirement-ledger.js");
  const ledger = new RequirementLedger(f.root, f.f.source.id), history = await ledger.history();
  expect(requirementJournalSchema.safeParse(history).success).toBe(true);
  expect(history.filter(r => r.payload.kind === "role-review-question")).toHaveLength(1);
  expect(history.filter(r => r.payload.kind === "role-review-question-disposition")).toHaveLength(1);
  const store = new RoleReviewWorkStore(f.root, (await RoleReviewWorkStore.plans(f.root, f.f.source.id))[0]!);
  await expect(store.assertQuestionLedger()).resolves.toBeUndefined();
  await runBoundedRoleReview(f.options, async () => {throw new Error("completed work must not replay");});
  expect(await ledger.history()).toEqual(history);
});
it("does not silently drop decisive text when an evidence packet is too small", async () => {
  const {roleEvidencePacket} = await import("../src/compiler/role-review-context.js");
  const bytes = Buffer.from("small\n" + "龙".repeat(5000));
  const packet = roleEvidencePacket(bytes, [{id:"short",anchor:{startByte:0,endByte:6}},{id:"long",anchor:{startByte:6,endByte:bytes.length}}], ["long", "short"], ["short"], 1000);
  expect(packet.manifest.requiredButMissing).toEqual(["long"]);
  expect(packet.manifest.omittedRefs).toEqual([{unitId:"long",category:"required",omitReason:"requires-paginated-read"}]);
  expect(packet.evidence).toEqual([{unitId:"short",category:"required",text:"small\n"}]);
});
it("exposes a paginated unfiltered atlas without leaking another review", async () => {
  const f = await setup(); const {roster} = await loadCurrentRoleRoster(f.root, f.f.source.id); const unit = roster.unitIds[0]!;
  let inspected = false;
  await runBoundedRoleReview(f.options, async work => {
    if (work.workId.startsWith("candidate")) {
      const response = await invoke(work, "read_role_review_atlas", {});
      const atlas = JSON.parse((response.content[0] as {text:string}).text);
      expect(atlas.pages[0].summary).toBe("Reviewed the supplied core");
      const detail = await invoke(work, "read_role_review_atlas", {page: atlas.pages[0].page});
      expect(JSON.parse((detail.content[0] as {text:string}).text).notes.findings[0].name).toBe("Hero");
      inspected = true;
    }
    await completeFixtureWork(work, unit);
  });
  expect(inspected).toBe(true);
});

it("supplements evidence once in a fresh context without changing work identity", async () => {
  const f = await setup(); const {roster} = await loadCurrentRoleRoster(f.root, f.f.source.id); const unit = roster.unitIds[0]!;
  let requestedWork: string | undefined; let supplemented = 0;
  await runBoundedRoleReview(f.options, async work => {
    if (!requestedWork && work.workId.startsWith("candidate")) {
      requestedWork = work.workId;
      await invoke(work, "request_role_work_evidence", {question:"What happened?", missing:"Original exchange", decisionImpact:"Changes importance", searchedUnitIds:[], requestedUnitIds:[unit]});
      expect(work.complete()).toBe(true); // Handoff receipt, not candidate completion.
      return;
    }
    if (work.workId === requestedWork) {
      supplemented++;
      expect(packet(work).supplement.manifest.includedRefs).toContain(unit);
      expect(work.tools.some(t => t.name === "request_role_work_evidence")).toBe(false);
    }
    await completeFixtureWork(work, unit);
  });
  expect(supplemented).toBe(1);
  const {RequirementLedger, requirementJournalSchema} = await import("../src/compiler/requirement-ledger.js");
  const ledger = new RequirementLedger(f.root, f.f.source.id), history = await ledger.history();
  expect(requirementJournalSchema.safeParse(history).success).toBe(true);
  expect(history.filter(r => r.payload.kind === "role-review-evidence-need")).toHaveLength(1);
  expect(history.filter(r => r.payload.kind === "role-review-evidence-resolution")).toHaveLength(1);
});
it("rejects a supplement that supplies no new original evidence", async () => {
  const f = await setup(); const {roster} = await loadCurrentRoleRoster(f.root, f.f.source.id); const unit = roster.unitIds[0]!;
  await expect(runBoundedRoleReview(f.options, async work => {
    if (!work.workId.startsWith("candidate")) return completeFixtureWork(work, unit);
    await invoke(work, "read_role_work_evidence", {unitId:unit});
    await invoke(work, "request_role_work_evidence", {question:"Again?", missing:"Nothing", decisionImpact:"None", searchedUnitIds:[unit], requestedUnitIds:[unit]});
  })).rejects.toThrow("adds no new original text");
});
it("retains cumulative model usage and hard stops across replacement sessions", async () => {
  const f = await setup(); const {roleReviewBudget} = await import("../src/compiler/role-review-budget.js");
  const limits = {maxModelCalls:2,maxRequestBytes:1000,maxTotalPayloadBytes:1500}, plan = contentHash("plan"), work = "same-work";
  const first = roleReviewBudget(f.root,plan,work,limits);
  first.beginCall({}); first.admitPayload({text:"first"}); first.close();
  const second = roleReviewBudget(f.root,plan,work,limits);
  expect(second.snapshot().modelCalls).toBe(1);
  second.beginCall({}); second.admitPayload({text:"second"});
  expect(() => second.beginCall({})).toThrow("model-call limit");
  const third = roleReviewBudget(f.root,plan,work,limits);
  expect(third.snapshot().modelCalls).toBe(2);
  expect(() => third.beginCall({})).toThrow("retained hard stop");
});
it("does not assume zero usage when legacy recovery has no retained budget record", async () => {
  const f = await setup(); const {roleReviewBudget} = await import("../src/compiler/role-review-budget.js");
  const limits = {maxModelCalls:2,maxRequestBytes:1000,maxTotalPayloadBytes:1500};
  expect(() => roleReviewBudget(f.root,contentHash("legacy"),"old-work",limits,true)).toThrow("no retained usage record");
});
it("rejects an audit of the wrong packet and permits only a corrected same-work submission", async () => {
  const f = await setup(); const {roster} = await loadCurrentRoleRoster(f.root, f.f.source.id); const unit = roster.unitIds[0]!;
  let checked = false;
  await runBoundedRoleReview(f.options, async work => {
    if (work.workId.startsWith("role-claim") && !checked) {
      const p = packet(work); checked = true;
      await expect(invoke(work, "propose_role_claim_audit", {candidateId:p.candidateId,claimRevision:p.claimRevision,atlasRevision:p.atlasRevision,packetHash:contentHash("different packet"),verdict:"supported",rationale:"Incorrect packet",basisUnitIds:[unit],counterevidence:{searchedUnitIds:[unit],rationale:"Fixture"},checks:fixtureChecks(unit)})).rejects.toThrow("Stale claim audit");
    }
    await completeFixtureWork(work, unit);
  });
  expect(checked).toBe(true);
});
it("cannot support the aggregate claim while a development check is insufficient", async () => {
  const {roleClaimAuditSchema} = await import("../src/compiler/role-review-verification.js");
  const checks = fixtureChecks("unit"); checks.find(c => c.kind === "development")!.verdict = "insufficient";
  expect(roleClaimAuditSchema.safeParse({candidateId:"candidate",claimRevision:contentHash("entry"),atlasRevision:contentHash("atlas"),packetHash:contentHash("packet"),verdict:"supported",rationale:"Everything passed",basisUnitIds:["unit"],counterevidence:{searchedUnitIds:["unit"],rationale:"Checked"},checks}).success).toBe(false);
});

it("returns compact note directories and expands a copied stable note ID", async()=>{
 const f=await setup();const {roster}=await loadCurrentRoleRoster(f.root,f.f.source.id);const unit=roster.unitIds[0]!;
 let checked=false;
 await runBoundedRoleReview(f.options,async work=>{
  if(work.workId.startsWith('role-source'))return invoke(work,'propose_role_source_review',{summary:'Navigation only',findings:[{name:'Hero',observation:'Background. '.repeat(90)+'Important counterevidence at the end.',unitIds:[unit]}],openQuestions:['Is the identity certain?']}).then(()=>{});
  if(work.workId.startsWith('candidate')&&!checked){
   const directory=await invoke(work,'read_role_review_notes',{}),body=JSON.parse((directory.content[0] as {text:string}).text);
   expect(body.mode).toBe('directory');expect(JSON.stringify(body)).not.toContain('Important counterevidence at the end.');
   const detail=await invoke(work,'read_role_review_notes',{noteId:body.records[0].noteId});
   expect((detail.content[0] as {text:string}).text).toContain('Important counterevidence at the end.');checked=true;
  }
  await completeFixtureWork(work,unit);
 });expect(checked).toBe(true);
});
it("repackages the same work with actual originals and avoids duplicating already delivered evidence",async()=>{
 const f=await setup();const {roster}=await loadCurrentRoleRoster(f.root,f.f.source.id);const unit=roster.unitIds[0]!;
 let target:string|undefined,checked=false;
 await runBoundedRoleReview(f.options,async work=>{
  if(work.workId.startsWith('candidate')&&!target){target=work.workId;await invoke(work,'read_role_work_evidence',{unitId:unit});work.contextWindow!.beginCall({content:'x'.repeat(37000)});return;}
  if(work.workId===target&&!checked){
   expect(packet(work).contextHandoff.generation).toBe(1);
   const p=packet(work);
   expect(p.contextEvidence.fragments.some((f:{unitId:string;continued:boolean})=>f.unitId===unit&&!f.continued)).toBe(true);
   expect(p.contextEvidence.fragments.some((f:{unitId:string;text:string})=>f.unitId===unit&&f.text.includes('Hero'))).toBe(true);
   const reply=await invoke(work,'read_role_work_evidence',{unitId:unit});
   expect(JSON.parse((reply.content[0] as {text:string}).text).units[0]).toEqual({unitId:unit,alreadyDeliveredInCurrentContext:true});
   checked=true;
  }
  await completeFixtureWork(work,unit);
 });expect(checked).toBe(true);
});
it("stops repeated repacks that only revisit already recorded evidence",async()=>{
 const f=await setup();const {roster}=await loadCurrentRoleRoster(f.root,f.f.source.id);const unit=roster.unitIds[0]!;
 await expect(runBoundedRoleReview(f.options,async work=>{
  await invoke(work,'read_role_work_evidence',{unitId:unit});work.contextWindow!.beginCall({content:'x'.repeat(37000)});
 })).rejects.toThrow('no new access');
});

it("recovers a trace-proven size stop once, preserving the original blocked record and all charges",async()=>{
 const f=await setup();await expect(runBoundedRoleReview(f.options,async()=>{throw Error('stop before model');})).rejects.toThrow('stop before model');
 const plan=(await RoleReviewWorkStore.plans(f.root,f.f.source.id))[0]!,store=new RoleReviewWorkStore(f.root,plan),workId=store.workId('source',0);
 const {roleReviewBudget,recoverRoleContextBudget}=await import('../src/compiler/role-review-budget.js');
 const {ROLE_WORK_LIMITS}=await import('../src/workflow/role-review-bounded.js');
 const {worldStorageRoot}=await import('../src/world/paths.js');
 const {TraceStore}=await import('../src/trace/store.js');const {TraceRecorder}=await import('../src/trace/recorder.js');
 const budget=roleReviewBudget(f.root,store.planHash,workId,ROLE_WORK_LIMITS);
 for(let i=0;i<6;i++){budget.beginCall({});budget.admitPayload({content:'existing usage'});}
 let failure:unknown;try{budget.beginCall({content:'x'.repeat(49000)});}catch(error){failure=error;}
 const trace=await TraceRecorder.start(new TraceStore(f.root),{kind:'prepare',sourceId:f.f.source.id,operationId:f.batchId});
 await trace.record('validation.completed',{phase:'role-review-work',workId,planHash:store.planHash,limits:ROLE_WORK_LIMITS});
 await trace.finish('failed',{}, {code:'ROLE_REVIEW_WORK_FAILED',message:String(failure),retryable:false});
 const file=path.join(worldStorageRoot(f.root),'compiler','role-review-work','budgets',store.planHash,`${contentHash(workId)}.json`);
 const before=await fs.readFile(file,'utf8'),prior=JSON.parse(before);
 const input={sourceId:f.f.source.id,batchId:f.batchId,workId,expectedBudgetHash:prior.hash,failedRunId:trace.manifest.id,implementationRef:'tested context-window fix'};
 await expect(recoverRoleContextBudget(f.root,{...input,expectedBudgetHash:contentHash('wrong')})).rejects.toThrow('stale or resource-exhausted');
 const grant=await recoverRoleContextBudget(f.root,input);expect(grant.remainingCalls).toBe(6);
 const {roleContextRecoveryTrace}=await import('../src/compiler/role-review-budget.js');
 await expect(roleContextRecoveryTrace(f.root,store.planHash,workId)).resolves.toBe(trace.manifest.id);
 const changedTrace=vi.spyOn(TraceStore.prototype,'peekEvents').mockResolvedValue([]);
 try { await expect(roleContextRecoveryTrace(f.root,store.planHash,workId)).rejects.toThrow('trace changed after authorization'); }
 finally { changedTrace.mockRestore(); }
 expect(await fs.readFile(file,'utf8')).toBe(before);
 const resumed=roleReviewBudget(f.root,store.planHash,workId,ROLE_WORK_LIMITS,true);
 expect(resumed.snapshot()).toEqual(budget.snapshot());expect(resumed.isBlocked()).toBe(false);
 for(let i=0;i<6;i++)resumed.beginCall({});
 expect(()=>resumed.beginCall({})).toThrow('model-call limit');
 expect(roleReviewBudget(f.root,store.planHash,workId,ROLE_WORK_LIMITS,true).isBlocked()).toBe(true);
 await expect(recoverRoleContextBudget(f.root,input)).rejects.toThrow('already granted');
});
it("does not grant context recovery for exhausted call budgets",async()=>{
 const f=await setup();await expect(runBoundedRoleReview(f.options,async()=>{throw Error('stop');})).rejects.toThrow();
 const plan=(await RoleReviewWorkStore.plans(f.root,f.f.source.id))[0]!,store=new RoleReviewWorkStore(f.root,plan),workId=store.workId('source',0);
 const {roleReviewBudget,recoverRoleContextBudget}=await import('../src/compiler/role-review-budget.js');const {worldStorageRoot}=await import('../src/world/paths.js');
 const budget=roleReviewBudget(f.root,store.planHash,workId,{maxModelCalls:1,maxRequestBytes:48000,maxTotalPayloadBytes:48000});budget.beginCall({});expect(()=>budget.beginCall({})).toThrow();
 const prior=JSON.parse(await fs.readFile(path.join(worldStorageRoot(f.root),'compiler','role-review-work','budgets',store.planHash,`${contentHash(workId)}.json`),'utf8'));
 await expect(recoverRoleContextBudget(f.root,{sourceId:f.f.source.id,batchId:f.batchId,workId,expectedBudgetHash:prior.hash,failedRunId:'unrelated-run',implementationRef:'test'})).rejects.toThrow('stale or resource-exhausted');
});

it('continues independent source work while exhausted work still blocks downstream completion', async()=>{
 const f=await setup('Hero helps Friend.\n'+'Other person acts.\n'.repeat(700));
 for(let i=0;i<2;i++)await expect(runBoundedRoleReview(f.options,async()=>{throw Error('fixture outage');})).rejects.toThrow('fixture outage');
 const plan=(await RoleReviewWorkStore.plans(f.root,f.f.source.id))[0]!,store=new RoleReviewWorkStore(f.root,plan);
 expect(plan.spans.length).toBeGreaterThan(1);
 const target=store.workId('source',1),seen:string[]=[];
 await expect(runBoundedRoleReview({...f.options,sourceWorkScope:{planHash:store.planHash,workIds:[target]}},async work=>{
  seen.push(work.workId);
  await invoke(work,'propose_role_source_review',{summary:'Fixture source review',findings:[],openQuestions:['Unresolved fixture question']});
 })).resolves.toBeUndefined();
 expect(seen).toEqual([target]);expect(store.read('source',0)).toBeUndefined();
 expect(store.read('source',1)?.openQuestions).toEqual(['Unresolved fixture question']);
 expect(store.sourceComplete()).toBe(false);expect(store.stagedEntries()).toHaveLength(0);
 await expect(runBoundedRoleReview(f.options,async()=>{throw Error('must not reach model');})).rejects.toThrow('work invocation allowance exhausted');
});
it('rejects stale or foreign host source scopes before model execution',async()=>{
 const f=await setup();await expect(runBoundedRoleReview(f.options,async()=>{throw Error('fixture stop');})).rejects.toThrow('fixture stop');
 const plan=(await RoleReviewWorkStore.plans(f.root,f.f.source.id))[0]!,store=new RoleReviewWorkStore(f.root,plan);
 for(const scope of [{planHash:contentHash('stale'),workIds:[store.workId('source',0)]},{planHash:store.planHash,workIds:['foreign']},{planHash:store.planHash,workIds:[]}]){
  await expect(runBoundedRoleReview({...f.options,sourceWorkScope:scope},async()=>{throw Error('must not reach model');})).rejects.toThrow('invalid source work scope');
 }
});

it('exposes the total UTF-8 output limit and preserves proposal failure when context pressure blocks correction',async()=>{
 const f=await setup();
 await expect(runBoundedRoleReview(f.options,async work=>{
  expect(packet(work).outputConstraints.maxJsonUtf8Bytes).toBe(8000);
  const tool=work.tools.find(t=>t.name==='propose_role_source_review')!;
  expect(JSON.stringify(tool.parameters)).toContain('8000 UTF-8 bytes');
  const raw={summary:'Fixture',findings:[],openQuestions:Array.from({length:6},()=> '龙'.repeat(500))};
  expect(()=>tool.prepareArguments!(raw)).toThrow('8000 UTF-8 bytes');
  work.contextWindow!.beginCall({content:'x'.repeat(37000)});
 })).rejects.toThrow('unresolved proposal plus context pressure');
 const advice=buildNwhToolRecoveryAdvice('propose_role_source_review','Source work notes must fit 8000 UTF-8 bytes');
 expect(advice?.category).toBe('invalid-arguments');
 expect(advice?.steps.join(' ')).toContain('Do not re-read source');
});

it('repairs the exact oversized source proposal with the remaining attempt and retains every question',async()=>{
 const f=await setup();
 const original={summary:'Fixture review',findings:[],openQuestions:Array.from({length:6},(_,i)=>`${i}:`+'龙'.repeat(500))};
 await expect(runBoundedRoleReview(f.options,async work=>{work.tools.find(t=>t.name==='propose_role_source_review')!.prepareArguments!(original);})).rejects.toThrow('8000 UTF-8 bytes');
 const plan=(await RoleReviewWorkStore.plans(f.root,f.f.source.id))[0]!,store=new RoleReviewWorkStore(f.root,plan);
 const failure=store.journal.unresolved()[0]!,workId=store.workId('source',0);
 const recovery={workId,failedInputHash:failure.inputHash};
 const corrected={...original,openQuestions:original.openQuestions.map((_,i)=>`${i}: retained fixture question`)};
 await expect(runBoundedRoleReview({...f.options,sourceWorkScope:{planHash:store.planHash,workIds:[workId]},sourceNotesRecovery:recovery},async work=>{
  expect(work.workId).toBe(workId);expect(work.retainedBudgetRequired).toBe(true);
  expect(packet(work).failedProposal).toEqual(original);
  expect(packet(work).evidence.fragments.length).toBeGreaterThan(0);
  expect(work.tools.map(t=>t.name)).toEqual(['propose_role_source_review']);
  await invoke(work,'propose_role_source_review',corrected);
 })).resolves.toBeUndefined();
 expect(store.journal.unresolved()).toEqual([]);
 expect(store.journal.history(failure.tool,workId)[0]).toEqual(failure);
 expect(store.read('source',0)?.openQuestions).toHaveLength(6);
 await expect(store.beginAttempt(workId)).rejects.toThrow('invocation allowance exhausted');
});
it('rejects stale recovery bindings and deletion of responsibilities',async()=>{
 const {sourceNotesCorrection,assertSourceNotesCorrection}=await import('../src/compiler/role-source-correction.js');
 const f=await setup(),original={summary:'Fixture',findings:[],openQuestions:Array.from({length:6},()=> '龙'.repeat(500))};
 await expect(runBoundedRoleReview(f.options,async work=>{work.tools.find(t=>t.name==='propose_role_source_review')!.prepareArguments!(original);})).rejects.toThrow('8000 UTF-8 bytes');
 const plan=(await RoleReviewWorkStore.plans(f.root,f.f.source.id))[0]!,store=new RoleReviewWorkStore(f.root,plan),failure=store.journal.unresolved()[0]!;
 expect(()=>sourceNotesCorrection([failure],{workId:failure.proposalId,failedInputHash:contentHash('stale')},store.planHash)).toThrow('exact sole unresolved');
 expect(()=>sourceNotesCorrection([failure],{workId:failure.proposalId,failedInputHash:failure.inputHash},contentHash('stale plan'))).toThrow('only handles total output size');
 expect(()=>assertSourceNotesCorrection(original,{...original,openQuestions:[]})).toThrow('every open-question slot');
 const finding={summary:'Fixture',findings:[{name:'Hero',observation:'Acts',unitIds:['unit']}],openQuestions:[]};
 expect(()=>assertSourceNotesCorrection(finding,{...finding,findings:[{...finding.findings[0]!,unitIds:['other']}]})).toThrow('exact name and unitIds');
});

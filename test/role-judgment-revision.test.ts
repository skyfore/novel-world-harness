import { ROLE_CLAIM_CONTRACT, roleContractAuditWorkId, roleAuditContractProofSchema } from "../src/compiler/role-audit-contract.js";
import { inspectRoleAuditContractAuthorization, authorizeRoleAuditContractRevision, assertRoleAuditContractHistory } from "../src/compiler/role-audit-contract-service.js";
import { runWithRoleContextRecovery } from "../src/workflow/role-session-context.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { ensureSourceStructure, baseStructuralUnits } from "../src/compiler/structure.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { contentHash } from "../src/world/canonical.js";
import { worldStorageRoot } from "../src/world/paths.js";
import { loadCurrentRoleRoster } from "../src/compiler/role-roster-tools.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { RoleReviewWorkStore, boundedRoleReviewEvidenceSchema } from "../src/compiler/role-review-work.js";
import { RoleRosterStore, validateRoleDevelopmentExpectations, validateRosterReview } from "../src/compiler/role-roster.js";
import { roleRosterEntrySchema } from "../src/compiler/role-roster-entry.js";
import { roleEvidencePacket } from "../src/compiler/role-review-context.js";
import { RequirementLedger, requirementJournalBindingIssues, requirementJournalSchema } from "../src/compiler/requirement-ledger.js";
import { authorizeRoleJudgmentRepairs, inspectRoleJudgmentRepairAuthorization, ensureRoleJudgmentAuthority, assertRoleJudgmentHistory } from "../src/compiler/role-judgment-repair-service.js";
import { ROLE_JUDGMENT_REVISION_TOOL, roleJudgmentRevisionProofSchema, roleJudgmentWorkId } from "../src/compiler/role-judgment-revision.js";
import { roleReviewBudget, inspectRoleReviewBudget } from "../src/compiler/role-review-budget.js";
import { runBoundedRoleReview, ROLE_WORK_LIMITS, type RoleWorkInvocation } from "../src/workflow/role-review-bounded.js";
import { roleProgressTools } from "../src/workflow/role-validated-progress.js";
import { withWorkspaceOperationLock } from "../src/util/workspace-lock.js";
import { buildNwhToolRecoveryAdvice } from "../src/agent/tool-recovery.js";
import { beginCoreRoleReviewRevision } from "../src/compiler/role-review-revision-service.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const invoke = (work: RoleWorkInvocation, name: string, input: unknown) => work.tools.find(t => t.name === name)!.execute(name, input as never, undefined, undefined, {} as ExtensionContext);
const packet = (w: RoleWorkInvocation) => JSON.parse(w.prompt.split("\n").findLast(line => line.startsWith("{"))!);
const checks = (unit: string, verdict = "supported") => ["importance", "identity", "development"].map(kind => ({ kind,
  verdict: kind === "development" ? verdict : "supported", rationale: "Original evidence evaluated for this dimension", basisUnitIds: [unit] }));
async function fixture(migrate = false, legacy = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-judgment-")); roots.push(root);
  const text = "Voyager shelters a stranger.\nYears later Voyager again shelters a stranger.\n";
  const f = await createEvidenceFixture(root, text); await ensureSourceStructure(root, f.source);
  const canon = new CanonicalModelStore(root);
  await canon.putEntity({ id: "voyager", canonicalName: "Voyager", aliases: [], kind: "character", evidence: f.evidence("Voyager") });
  let current = await loadCurrentRoleRoster(root, f.source.id);
  let store = await RoleReviewWorkStore.open(root, { version: 1, sourceId: f.source.id, sourceHash: f.source.contentSha256,
    batchId: `role-roster-${f.source.id}-revision-test`, subjectHash: current.roster.subjectHash,
    structureHash: contentHash(current.structure), spans: [{ start: 0, end: f.source.bytes }], legacyDraftHashes: [] });
  const candidateId = current.roster.candidates[0]!.id, units = current.roster.unitIds;
  const original = roleRosterEntrySchema.parse({ candidateId, importance: "major", rationale: "Causal protagonist", basisUnitIds: [units[0]],
    developmentExpectation: { kind: "stable", rationale: "An isolated act proves lifelong stability", basisUnitIds: [units[0]] } });
  await store.submit("source", 0, { summary: "Two time-separated actions", findings: [], openQuestions: [] }, () => {});
  store.journal.record("propose_role_roster_entry", { subjectHash: store.plan.subjectHash, entry: original }, "succeeded");
  for (const workId of [`candidate-${candidateId}`, store.claimWorkId(candidateId)]) {
    await store.beginAttempt(workId);
    const budget = roleReviewBudget(root, store.planHash, workId, ROLE_WORK_LIMITS, false, "progress");
    for (let i = 0; i < 3; i++) budget.beginCall({});
    budget.recordValidatedProgress(`receipt:${workId}`); budget.close();
  }
  await store.beginAttempt(`candidate-${candidateId}`); // Both old invocations are retained, not renewed.
  if (migrate) {
    const saved = { ...current.roster, reviews: [{ runId: "prior-independent", subjectHash: store.plan.subjectHash,
      reviewedUnitIds: units, entries: [original], missingMajorCharacters: [] }] };
    await new RoleRosterStore(root).write(saved);
    const entity = await canon.getEntity("voyager"); await canon.putEntity({ ...entity, aliases: ["The Voyager"] });
    const revision = await beginCoreRoleReviewRevision(root, { sourceId: f.source.id, revisionId: "subject-successor",
      priorRosterHash: contentHash(saved), expectedWorkPlanHash: store.planHash, scopeDecisionRef: "fixture-host", reason: "Independent review of the updated alias" });
    store = new RoleReviewWorkStore(root, revision.workMigration!.nextPlan);
    current = await loadCurrentRoleRoster(root, f.source.id);
    const budget = roleReviewBudget(root, store.planHash, store.claimWorkId(candidateId), ROLE_WORK_LIMITS, false, "progress", store.inheritedAllowance(store.claimWorkId(candidateId))?.budget);
    budget.beginCall({}); budget.recordValidatedProgress("receipt:current-audit"); budget.close();
    await store.beginAttempt(store.claimWorkId(candidateId));
  }
  const evidencePacket = roleEvidencePacket(Buffer.from(text), baseStructuralUnits(current.structure), original.basisUnitIds);
  const negative = { candidateId, claimRevision: contentHash(original), atlasRevision: store.atlasRevision(),
    packetHash: contentHash({ claimRevision: contentHash(original), atlasRevision: store.atlasRevision(), evidencePacket }),
    verdict: "insufficient", rationale: "One act does not establish continuity", basisUnitIds: [units[0]],
    counterevidence: { searchedUnitIds: units, rationale: "The later scene must be considered" }, checks: checks(units[0]!, "insufficient") };
  if (legacy) store.journal.record("propose_role_claim_audit", {proposal_id: store.claimWorkId(candidateId), planHash: store.planHash, payload: negative}, "succeeded");
  else await store.submitClaim(negative, candidateId, () => {});
  const authorization = { sourceId: f.source.id, batchId: store.plan.batchId, planHash: store.planHash, authorizationRef: "fixture-explicit-host-decision" };
  const successor = roleRosterEntrySchema.parse({ ...original, developmentExpectation: { kind: "stable",
    rationale: "Repeated protection of strangers in two separated scenes supports continuity of this disposition within this source", basisUnitIds: units } });
  const options = { root, sourceId: f.source.id, compilerBatchId: store.plan.batchId, configPath: path.join(root, "absent.yml") };
  return { root, f, store, original, successor, negative, authorization, units, candidateId, options, roster: current.roster };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const fresh = (f: Fixture) => new RoleReviewWorkStore(f.root, f.store.plan);
async function authorize(f: Fixture) {
  const preview = await inspectRoleJudgmentRepairAuthorization(f.root, f.authorization);
  return withWorkspaceOperationLock(f.root, "compiler", () => authorizeRoleJudgmentRepairs(f.root, f.authorization, preview.authorityHash));
}
async function read(work: RoleWorkInvocation, units: string[]) {
  for (const unitId of [...new Set(units)]) {
    let offset: number | undefined = 0;
    do { const result = await invoke(work, "read_role_work_evidence", { unitId, offset }); offset = JSON.parse((result.content[0] as {text: string}).text).nextOffset; } while (offset !== undefined);
  }
}
async function complete(f: Fixture, work: RoleWorkInvocation, verdict = "supported", successor = f.successor) {
  const p = packet(work);
  if (work.workId.startsWith("role-judgment-revision")) {
    expect(work.tools.some(t => t.name === "propose_role_claim_audit")).toBe(false);
    expect(p.negativeAudit).toEqual(f.negative);
    await read(work, f.units);
    const draft = { revisionId: p.revisionId, entry: successor };
    const preview = await invoke(work, "preview_role_judgment_revision", draft);
    expect(JSON.parse((preview.content[0] as {text: string}).text)).toMatchObject({ valid: true, committed: false, semanticSupport: "not-verified" });
    await invoke(work, ROLE_JUDGMENT_REVISION_TOOL, draft);
  } else if ((work.workId.startsWith("role-claim-successor") || work.workId.startsWith("role-claim-contract"))) {
    expect(work.tools.some(t => t.name === ROLE_JUDGMENT_REVISION_TOOL || t.name === "propose_role_roster_entry")).toBe(false);
    expect(p.claimRevision).toBe(contentHash(successor));
    expect(p.claimRevision).not.toBe(f.negative.claimRevision);
    await read(work, f.units);
    await invoke(work, "propose_role_claim_audit", { candidateId: p.candidateId, claimRevision: p.claimRevision,
      atlasRevision: p.atlasRevision, packetHash: p.packetHash, verdict, rationale: "Independent consideration of the revised scope and both scenes",
      basisUnitIds: f.units, counterevidence: { searchedUnitIds: f.units, rationale: "Both original scenes examined" }, checks: checks(f.units[0]!, verdict) });
  } else if (work.workId.startsWith("role-audit")) {
    await read(work, f.units);
    await invoke(work, "read_role_audit_inventory", { candidateId: f.candidateId });
    await invoke(work, "propose_role_review_audit", { rationale: "Original source and complete candidate inventory independently considered",
      atlasRevision: p.atlasRevision, missingMajorCharacters: [], unresolved: [], questionDispositions: [], discoveryDispositions: [] });
  } else throw Error(`Unexpected repeated original work: ${work.workId}`);
}
async function run(f: Fixture, handler = (work: RoleWorkInvocation) => complete(f, work), onRoleWorkCompleted?: (id: string) => void) {
  return withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview({ ...f.options, onRoleWorkCompleted }, async work => {
    const store = fresh(f);
    const budget = roleReviewBudget(f.root, store.planHash, store.budgetWorkId(work.workId), ROLE_WORK_LIMITS, false, "progress", store.inheritedAllowance(work.workId)?.budget);
    budget.beginCall({});
    try { await handler({ ...work, tools: roleProgressTools(work, budget, () => false) }); } finally { budget.close(); }
  }, async () => {}));
}
async function assemble(f: Fixture) {
  const tools = createCompilerProposalToolset(f.root); await tools.beginBatch([], f.store.plan.batchId, f.f.source.id);
  const call = (name: string, input: unknown) => tools.tools.find(t => t.name === name)!.execute(name, input as never, undefined, undefined, {} as ExtensionContext);
  await call("propose_role_roster_review", { subjectHash: f.store.plan.subjectHash, staged: true, missingMajorCharacters: [] });
  await call("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Versioned judgment independently verified" });
  return (await new RoleRosterStore(f.root).read(f.f.source.id))!;
}

it.each([false, true])("closes a generic negative claim through a distinct successor, independent audit and durable ledger (migrated=%s)", async migrate => {
  const f = await fixture(migrate), before = f.store.journal.history("propose_role_claim_audit", f.store.claimWorkId(f.candidateId));
  const oldBudget = inspectRoleReviewBudget(f.root, f.store.planHash, f.store.claimWorkId(f.candidateId));
  await authorize(f); const seen: string[] = [];
  await run(f, async w => { seen.push(w.workId); await complete(f, w); });
  const current = fresh(f), revision = current.judgmentRevisions()[0]!;
  expect(seen).toHaveLength(3);
  expect(current.originalStagedEntries()).toEqual([f.original]); expect(current.stagedEntries()).toEqual([f.successor]);
  expect(current.journal.history("propose_role_claim_audit", current.originalClaimWorkId(f.candidateId))).toEqual(before);
  expect(current.auditComplete()).toBe(true); await current.assertQuestionLedger();
  await assertRoleJudgmentHistory(current, revision.authority);
  expect(inspectRoleReviewBudget(f.root, current.planHash, current.originalClaimWorkId(f.candidateId))).toEqual(oldBudget);
  const revisedBudget = inspectRoleReviewBudget(f.root, current.planHash, roleJudgmentWorkId(revision.authority.revisionId));
  expect(revisedBudget.state.usage.modelCalls).toBe(oldBudget.state.usage.modelCalls + 2);
  expect(revisedBudget.state.progress!.milestones).toEqual(expect.arrayContaining(oldBudget.state.progress!.milestones));
  expect(current.inheritedAllowance(roleJudgmentWorkId(revision.authority.revisionId))!.attempts).toBe(2);
  const ledger = new RequirementLedger(f.root, f.f.source.id), history = await ledger.history();
  expect(history.filter(r => r.payload.kind === "role-judgment-finding")).toHaveLength(1);
  expect(history.filter(r => r.payload.kind === "role-judgment-resolution")).toHaveLength(1);
  expect(requirementJournalSchema.safeParse(history).success).toBe(true);
  const saved = await assemble(f), review = saved.reviews[0]!;
  expect(review.workEvidence!.judgmentRevisions).toEqual([revision]);
  expect(validateRosterReview({ ...saved, reviews: [] }, review)).toEqual([]);
  const snapshot = { roleRoster: saved, requirementJournal: await ledger.history(), ...(migrate ? {coreRoleReviewRevision: (await ledger.roleReviewRevisions()).at(-1)} : {}) };
  expect(requirementJournalBindingIssues(snapshot, f.f.source.id, f.f.source.contentSha256)).toEqual([]);
  const withoutResolution = { ...snapshot, requirementJournal: [] };
  expect(requirementJournalBindingIssues(withoutResolution, f.f.source.id, f.f.source.contentSha256)).toContain("ROLE_JUDGMENT_RESOLUTION_MISSING");
  expect(requirementJournalBindingIssues({roleRoster:saved}, f.f.source.id, f.f.source.contentSha256)).toContain("REQUIREMENT_JOURNAL_MISSING");
  const forged = structuredClone(review.workEvidence!); forged.claimAudits = [f.negative as never];
  expect(boundedRoleReviewEvidenceSchema.safeParse(forged).success).toBe(false);
});

it("ordinary compilation authorizes the existing single-successor policy for an evidence repair", async () => {
  const f = await fixture(), finalized = vi.fn();
  await withWorkspaceOperationLock(f.root, "compiler", () => runBoundedRoleReview({ ...f.options, automaticRecovery: true },
    work => complete(f, work), finalized));
  const policy = await new RequirementLedger(f.root, f.f.source.id).roleJudgmentRepairPolicy(f.store.planHash);
  expect(policy).toMatchObject({ maxSuccessorsPerCandidate: 1, maxInvocationsPerTask: 1, authorizationRef: `compile-novel:role-review:${f.store.planHash}` });
  expect(fresh(f).auditComplete()).toBe(true);
  expect(finalized).toHaveBeenCalledOnce();
});

it("requires exact locked host authority and cannot rotate its reference or silently repair", async () => {
  const f = await fixture(), runner = vi.fn();
  await expect(run(f, runner)).rejects.toThrow("requires evidence or semantic repair"); expect(runner).not.toHaveBeenCalled();
  const preview = await inspectRoleJudgmentRepairAuthorization(f.root, f.authorization);
  await expect(authorizeRoleJudgmentRepairs(f.root, f.authorization, preview.authorityHash)).rejects.toThrow("owning compiler lock");
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => authorizeRoleJudgmentRepairs(f.root, f.authorization, contentHash("wrong")))).rejects.toThrow("authorization changed");
  await authorize(f); await authorize(f);
  await expect(inspectRoleJudgmentRepairAuthorization(f.root, { ...f.authorization, authorizationRef: "renew" })).rejects.toThrow("already fixed");
  await expect(inspectRoleJudgmentRepairAuthorization(f.root, { ...f.authorization, planHash: contentHash("wrong") })).rejects.toThrow("roleReviewPlans[].planHash");
});

it("retains both negative findings and cannot retry a failed semantic successor", async () => {
  const f = await fixture(); await authorize(f);
  await expect(run(f, w => complete(f, w, "insufficient"))).rejects.toThrow("single correction is consumed");
  const current = fresh(f), history = await new RequirementLedger(f.root, f.f.source.id).history();
  expect(history.filter(r => r.payload.kind === "role-judgment-finding")).toHaveLength(2);
  expect(history.some(r => r.payload.kind === "role-judgment-resolution")).toBe(false);
  expect(current.auditComplete()).toBe(false);
  const runner = vi.fn(); await expect(run(f, runner)).rejects.toThrow("requires evidence or semantic repair"); expect(runner).not.toHaveBeenCalled();
  await expect(current.beginAttempt(current.claimWorkId(f.candidateId))).rejects.toThrow("invocation allowance exhausted");
  await expect(assemble(f)).rejects.toThrow("incomplete");
});

it.each(["role-judgment-revision", "role-claim-successor"])("resumes after durable %s without repeating its model call or dropping the finding", async prefix => {
  const f = await fixture(); await authorize(f);
  await expect(run(f, undefined, id => { if (id.startsWith(prefix)) throw Error("simulated host interruption after receipt"); })).rejects.toThrow("simulated host interruption");
  const seen: string[] = []; await run(f, async w => { seen.push(w.workId); await complete(f, w); });
  expect(seen.some(id => id.startsWith(prefix))).toBe(false);
  expect(fresh(f).auditComplete()).toBe(true); await fresh(f).assertQuestionLedger();
});

it("preserves major unknown as a valid evidence boundary that still fails development certification", async () => {
  const f = await fixture(); await authorize(f);
  const unknown = roleRosterEntrySchema.parse({ ...f.successor, developmentExpectation: { kind: "unknown", rationale: "No sufficient longitudinal evidence", basisUnitIds: f.units } });
  await run(f, async w => {
    if (w.workId.startsWith("role-claim-successor")) {
      expect(w.prompt).toContain("audit verdict evaluates whether that supplied classification faithfully represents the evidence, not whether a later certification gate can pass");
      expect(w.prompt).toContain("Do not mark an otherwise supported unknown entry insufficient merely because unknown cannot certify development");
      expect(w.tools.find(tool => tool.name === "propose_role_claim_audit")?.description).toContain("an honest unknown development boundary can be supported while remaining a separate certification blocker");
    }
    await complete(f, w, "supported", unknown);
  });
  const saved = await assemble(f);
  expect(validateRoleDevelopmentExpectations(saved).map(i => i.code)).toContain("ROSTER_DEVELOPMENT_EXPECTATION_UNKNOWN");
});

it("rejects stale, unchanged, foreign and importance-reducing revisions, with one original correction", async () => {
  const f = await fixture(); const {policy} = await authorize(f);
  const authority = await withWorkspaceOperationLock(f.root, "compiler", () => ensureRoleJudgmentAuthority(f.store, policy, f.candidateId));
  for (const entry of [f.original, {...f.successor,candidateId:"foreign"}, {...f.successor,importance:"incidental"}]) {
    expect(roleJudgmentRevisionProofSchema.safeParse({authority,entry}).success).toBe(false);
  }
  const workId = roleJudgmentWorkId(authority.revisionId);
  await expect(f.store.submitJudgmentRevision({revisionId:contentHash("other"),entry:f.successor},authority.revisionId,()=>{})).rejects.toThrow("foreign semantic revision");
  await f.store.submitJudgmentRevision({revisionId:authority.revisionId,entry:f.successor},authority.revisionId,()=>{});
  expect(f.store.journal.history(ROLE_JUDGMENT_REVISION_TOOL,workId).filter(r=>r.status==="failed")).toHaveLength(1);
  await expect(f.store.submitJudgmentRevision({revisionId:authority.revisionId,entry:f.successor},authority.revisionId,()=>{})).rejects.toThrow("already settled");
  expect(f.store.claimAudit(f.candidateId)).toBeUndefined();
  await expect(f.store.submitClaim(f.negative,f.candidateId,a=>{if(a.claimRevision!==contentHash(f.successor))throw Error("stale predecessor");})).rejects.toThrow("stale predecessor");
});

it.each(["blocked", "exhausted", "context"])("cannot erase a predecessor %s stop", async mode => {
  const f = await fixture(); const {policy} = await authorize(f), workId = f.store.claimWorkId(f.candidateId);
  if (mode === "context") {
    const dir = path.join(worldStorageRoot(f.root),"compiler","role-review-work","context-loops",f.store.planHash,contentHash(workId));
    await fs.mkdir(dir,{recursive:true});
    for(let ordinal=0;ordinal<3;ordinal++){const claim={planHash:f.store.planHash,workId,ordinal};await fs.writeFile(path.join(dir,`${ordinal}.json`),JSON.stringify({claim,hash:contentHash(claim)}));}
  } else {
    const b=roleReviewBudget(f.root,f.store.planHash,workId,ROLE_WORK_LIMITS,true,"progress");
    for(let i=0;i<ROLE_WORK_LIMITS.maxModelCalls;i++)b.beginCall({});
    if(mode==="blocked")expect(()=>b.beginCall({})).toThrow(); b.close();
  }
  await expect(withWorkspaceOperationLock(f.root,"compiler",()=>ensureRoleJudgmentAuthority(f.store,policy,f.candidateId))).rejects.toThrow(/progress window|budget or context stop/);
  expect(fresh(f).judgmentAuthorities()).toEqual([]);
});

it("retains predecessor bytes and refuses semantic revisions after downstream audit", async () => {
  const f=await fixture(); const {policy}=await authorize(f);
  const authority=await withWorkspaceOperationLock(f.root,"compiler",()=>ensureRoleJudgmentAuthority(f.store,policy,f.candidateId));
  const file=authority.retainedFiles.find(r=>r.path.includes("/budgets/"))!;
  await fs.appendFile(path.join(worldStorageRoot(f.root),file.path)," ");
  await expect(assertRoleJudgmentHistory(f.store,authority)).rejects.toThrow("history or budget changed");
  const g=await fixture(); await g.store.submit("audit",0,{rationale:"Retained audit",missingMajorCharacters:[],unresolved:[],atlasRevision:g.store.atlasRevision(),questionDispositions:[],discoveryDispositions:[]},()=>{});
  await expect(authorize(g)).rejects.toThrow("before source audit or finish");
});

it("validates original references before a single corrected submission and prevents native overwrite", async () => {
  const f=await fixture(); await authorize(f);
  await run(f,async work=>{
    if(!work.workId.startsWith("role-judgment-revision")){await complete(f,work);return;}
    const p=packet(work); await read(work,f.units);
    const bad={revisionId:p.revisionId,entry:{...f.successor,basisUnitIds:["foreign-unit"]}};
    const preview=await invoke(work,"preview_role_judgment_revision",bad);
    expect(JSON.parse((preview.content[0] as {text:string}).text)).toMatchObject({valid:false,committed:false});
    expect(fresh(f).stagedEntries()).toEqual([f.original]);
    await expect(invoke(work,ROLE_JUDGMENT_REVISION_TOOL,bad)).rejects.toThrow("ROSTER_UNKNOWN_EVIDENCE_UNIT");
    await invoke(work,ROLE_JUDGMENT_REVISION_TOOL,{revisionId:p.revisionId,entry:f.successor});
  });
  expect(fresh(f).journal.unresolved()).toEqual([]);
  const tools=createCompilerProposalToolset(f.root); await tools.beginBatch([],f.store.plan.batchId,f.f.source.id);
  await expect(tools.tools.find(t=>t.name==="propose_role_roster_entry")!.execute("overwrite",{subjectHash:f.store.plan.subjectHash,entry:f.original} as never,undefined,undefined,{} as ExtensionContext)).rejects.toThrow("immutable semantic revision lineage");
  expect(fresh(f).stagedEntries()).toEqual([f.successor]);
});

it("gives actionable bounded recovery and forbids retry on host stops", () => {
  const advice=buildNwhToolRecoveryAdvice(ROLE_JUDGMENT_REVISION_TOOL,"Unknown evidence reference");
  expect(JSON.stringify(advice)).toContain("read_role_work_evidence"); expect(JSON.stringify(advice)).toContain("units[].unitId");
  expect(buildNwhToolRecoveryAdvice(ROLE_JUDGMENT_REVISION_TOOL,"ROLE_REVIEW_WORK_HOST_REQUIRED: single correction consumed").retryable).toBe(false);
});

async function contextClaim(f: Fixture, workId: string, ordinal: number) {
  const taskHash = contentHash({workId, legacy: true});
  const dir = path.join(worldStorageRoot(f.root), "compiler", "role-review-work", "context-loops", f.store.planHash, contentHash(workId), taskHash);
  const claim = {planHash: f.store.planHash, workId, taskHash, ordinal};
  await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(path.join(dir, `${ordinal}.json`), JSON.stringify({claim, hash: contentHash(claim)}), {flag: "wx"});
}
async function contractFixture(migrate = false) {
  const f = await fixture(migrate, true), originalWork = f.store.claimWorkId(f.candidateId);
  if (!migrate) await f.store.beginAttempt(originalWork);
  await contextClaim(f, originalWork, 0); await contextClaim(f, originalWork, 1);
  await authorize(f);
  f.successor = roleRosterEntrySchema.parse({...f.successor, developmentExpectation: {kind: "unknown", rationale: "Disposition continuity remains unknown despite separated actions", basisUnitIds: f.units}});
  await expect(run(f, undefined, id => {if (id.startsWith("role-judgment-revision")) throw Error("after proposal");})).rejects.toThrow("after proposal");
  const store = fresh(f), workId = store.claimWorkId(f.candidateId);
  expect(await store.beginAttempt(workId)).toBe(3);
  await contextClaim(f, workId, 2);
  const b = roleReviewBudget(f.root, store.planHash, store.budgetWorkId(workId), ROLE_WORK_LIMITS, true, "progress", store.inheritedAllowance(workId)?.budget);
  b.beginCall({}); b.recordValidatedProgress(`receipt:${workId}`); b.close();
  const structure = (await loadCurrentRoleRoster(f.root, f.f.source.id)).structure;
  const evidencePacket = roleEvidencePacket(Buffer.from("Voyager shelters a stranger.\nYears later Voyager again shelters a stranger.\n"), baseStructuralUnits(structure), f.units);
  const oldAudit = {...f.negative, claimRevision: contentHash(f.successor), packetHash: contentHash({claimRevision: contentHash(f.successor), atlasRevision: store.atlasRevision(), evidencePacket}), rationale: "Unknown boundary is honest but cannot certify development"};
  store.journal.record("propose_role_claim_audit", {proposal_id: workId, planHash: store.planHash, payload: oldAudit}, "succeeded");
  await new RequirementLedger(f.root, f.f.source.id).recordRoleJudgmentFinding({planHash: store.planHash, workId, audit: oldAudit as never});
  const input = {sourceId: f.f.source.id, batchId: store.plan.batchId, planHash: store.planHash, candidateId: f.candidateId,
    predecessorReceiptHash: contentHash(store.journal.history("propose_role_claim_audit", workId).at(-1)), authorizationRef: "user-contract-upgrade", diagnosisRef: "retained-contract-ambiguity-diagnosis"};
  return {...f, input, oldAudit, oldWorkId: workId};
}
async function authorizeContract(f: Awaited<ReturnType<typeof contractFixture>>) {
  const preview = await inspectRoleAuditContractAuthorization(f.root, f.input);
  return withWorkspaceOperationLock(f.root, "compiler", () => authorizeRoleAuditContractRevision(f.root, f.input, preview.authorityHash));
}

it.each([false, true])("revalidates a consumed old contract with immutable history, cumulative attempt 4 and session 4 (migrated=%s)", async migrate => {
  const f = await contractFixture(migrate), old = fresh(f), oldReceipt = old.journal.history("propose_role_claim_audit", f.oldWorkId);
  const oldBudget = inspectRoleReviewBudget(f.root, old.planHash, old.budgetWorkId(f.oldWorkId));
  const {authority} = await authorizeContract(f);
  expect(authority.allowance).toMatchObject({attempts: 3, contextSessions: 3, budget: {state: oldBudget.state, limits: oldBudget.limits}});
  const calls: string[] = [];
  await run(f, async work => {
    calls.push(work.workId);
    if (!work.workId.startsWith("role-claim-contract")) return complete(f, work);
    expect(packet(work).contract).toEqual(ROLE_CLAIM_CONTRACT);
    expect(packet(work).packetHash).toBe(f.oldAudit.packetHash);
    await runWithRoleContextRecovery(fresh(f), work, async invocation => {
      expect(invocation.sessionOrdinal).toBe(3);
      expect(invocation.tools.some(t => t.name === "request_role_session_rebuild")).toBe(false);
      await complete(f, invocation);
    });
  });
  expect(calls.filter(id => id.startsWith("role-claim"))).toEqual([roleContractAuditWorkId(authority.revisionId)]);
  const current = fresh(f);
  expect(current.stagedEntries()).toEqual([f.successor]);
  expect(current.journal.history("propose_role_claim_audit", f.oldWorkId)).toEqual(oldReceipt);
  expect(inspectRoleReviewBudget(f.root, old.planHash, old.budgetWorkId(f.oldWorkId))).toEqual(oldBudget);
  expect(inspectRoleReviewBudget(f.root, current.planHash, current.claimWorkId(f.candidateId)).state.usage.modelCalls).toBe(oldBudget.state.usage.modelCalls + 1);
  const attempts = path.join(worldStorageRoot(f.root), "compiler", "role-review-work", "v1", contentHash(f.f.source.id), "attempts", contentHash(current.plan.batchId), contentHash(current.claimWorkId(f.candidateId)));
  expect(await fs.readdir(attempts)).toEqual(["4.json"]);
  await expect(current.beginAttempt(current.claimWorkId(f.candidateId))).rejects.toThrow("invocation allowance exhausted");
  await assertRoleAuditContractHistory(current, authority);
  await current.assertQuestionLedger();
  const history = await new RequirementLedger(f.root, f.f.source.id).history();
  expect(history.filter(r => r.payload.kind === "role-judgment-finding")).toHaveLength(2);
  expect(history.filter(r => r.payload.kind.endsWith("resolution"))).toHaveLength(2);
  expect(requirementJournalSchema.safeParse(history).success).toBe(true);
  const saved = await assemble(f);
  expect(saved.reviews[0]!.workEvidence!.auditContractRevisions).toEqual(current.auditContractProofs());
  expect(validateRoleDevelopmentExpectations(saved).map(i => i.code)).toContain("ROSTER_DEVELOPMENT_EXPECTATION_UNKNOWN");
  const snapshot = {roleRoster: saved, requirementJournal: await new RequirementLedger(f.root, f.f.source.id).history(), ...(migrate ? {coreRoleReviewRevision: (await new RequirementLedger(f.root, f.f.source.id).roleReviewRevisions()).at(-1)} : {})};
  expect(requirementJournalBindingIssues(snapshot, f.f.source.id, f.f.source.contentSha256)).toEqual([]);
  expect(requirementJournalBindingIssues({...snapshot, requirementJournal: []}, f.f.source.id, f.f.source.contentSha256)).toContain("ROLE_AUDIT_CONTRACT_RESOLUTION_MISSING");
  const forged = structuredClone(saved.reviews[0]!.workEvidence!); forged.auditContractRevisions![0]!.authority.sourceHash = contentHash("other-source");
  expect(boundedRoleReviewEvidenceSchema.safeParse(forged).success).toBe(false);
  const proof = current.auditContractProofs()[0]!;
  expect(roleAuditContractProofSchema.safeParse({...proof, audit: {...proof.audit, packetHash: contentHash("changed")}}).success).toBe(false);
});

it("requires exact host contract authorization and never rotates references, receipt identities or contract versions", async () => {
  const f = await contractFixture(), preview = await inspectRoleAuditContractAuthorization(f.root, f.input);
  await expect(authorizeRoleAuditContractRevision(f.root, f.input, preview.authorityHash)).rejects.toThrow("owning compiler lock");
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => authorizeRoleAuditContractRevision(f.root, f.input, contentHash("wrong")))).rejects.toThrow("preview changed");
  for (const change of [{planHash: contentHash("foreign")}, {candidateId: "foreign"}, {predecessorReceiptHash: contentHash("foreign")}]) {
    await expect(inspectRoleAuditContractAuthorization(f.root, {...f.input, ...change})).rejects.toThrow("correct once");
  }
  const authorized = await authorizeContract(f); expect(await authorizeContract(f)).toEqual(authorized);
  await expect(inspectRoleAuditContractAuthorization(f.root, {...f.input, authorizationRef: "more-attempts"})).rejects.toThrow("authority is fixed");
  expect(fresh(f).claimAudit(f.candidateId)).toBeUndefined();
  const g = await fixture();
  const receipt = fresh(g).journal.history("propose_role_claim_audit", g.store.claimWorkId(g.candidateId)).at(-1);
  await expect(inspectRoleAuditContractAuthorization(g.root, {...f.input, sourceId: g.f.source.id, batchId: g.store.plan.batchId, planHash: g.store.planHash, candidateId: g.candidateId, predecessorReceiptHash: contentHash(receipt)})).rejects.toThrow("already uses a versioned contract");
});

it("preserves another negative contract result without granting semantic repair or a repeated audit", async () => {
  const f = await contractFixture(); await authorizeContract(f);
  await expect(run(f, w => complete(f, w, "insufficient"))).rejects.toThrow("requires evidence or semantic repair");
  const runner = vi.fn(); await expect(run(f, runner)).rejects.toThrow("requires evidence or semantic repair"); expect(runner).not.toHaveBeenCalled();
  expect(fresh(f).claimAudit(f.candidateId)?.verdict).toBe("insufficient");
  expect((await new RequirementLedger(f.root, f.f.source.id).history()).filter(r => r.payload.kind === "role-judgment-finding")).toHaveLength(3);
  await expect(assemble(f)).rejects.toThrow("incomplete");
});

it("recovers ledger publication after the durable contract audit without another model call", async () => {
  const f = await contractFixture(); await authorizeContract(f);
  await expect(run(f, undefined, id => {if (id.startsWith("role-claim-contract")) throw Error("after revalidation receipt");})).rejects.toThrow("after revalidation receipt");
  const seen: string[] = []; await run(f, async w => {seen.push(w.workId); await complete(f, w);});
  expect(seen.some(id => id.startsWith("role-claim"))).toBe(false); await fresh(f).assertQuestionLedger();
});

it.each(["blocked", "exhausted", "tampered", "downstream"])("refuses contract revalidation across a %s boundary", async mode => {
  const f = await contractFixture(), store = fresh(f);
  if (mode === "downstream") {
    await store.submit("audit", 0, {rationale: "Already consumed source audit", missingMajorCharacters: [], unresolved: [], atlasRevision: store.atlasRevision(), questionDispositions: [], discoveryDispositions: []}, () => {});
    await expect(authorizeContract(f)).rejects.toThrow("before source audit or finish"); return;
  }
  if (mode === "tampered") {
    const {authority} = await authorizeContract(f), file = authority.retainedFiles.find(r => r.path.includes("/budgets/"))!;
    await fs.appendFile(path.join(worldStorageRoot(f.root), file.path), " ");
    const runner = vi.fn(); await expect(run(f, runner)).rejects.toThrow("predecessor history changed"); expect(runner).not.toHaveBeenCalled(); return;
  }
  const budget = roleReviewBudget(f.root, store.planHash, store.budgetWorkId(f.oldWorkId), ROLE_WORK_LIMITS, true, "progress");
  for (let i = 0; i < ROLE_WORK_LIMITS.maxModelCalls; i++) budget.beginCall({});
  if (mode === "blocked") expect(() => budget.beginCall({})).toThrow(); budget.close();
  await expect(authorizeContract(f)).rejects.toThrow(/progress window|budget or context/);
});

it("consumes a contract invocation with no receipt instead of opening another context or resetting counters", async () => {
  const f = await contractFixture(); await authorizeContract(f);
  await expect(run(f, async work => {
    await runWithRoleContextRecovery(fresh(f), work, async invocation => {
      expect(invocation.sessionOrdinal).toBe(3);
      expect(invocation.tools.some(t => t.name === "request_role_session_rebuild")).toBe(false);
    });
  })).rejects.toThrow("single session without a receipt");
  const runner = vi.fn(); await expect(run(f, runner)).rejects.toThrow("invocation allowance exhausted"); expect(runner).not.toHaveBeenCalled();
});

it("supports an ordinary unversioned audit without requiring a semantic judgment revision", async () => {
  const f = await fixture(false, true), store = fresh(f), receipt = store.journal.history("propose_role_claim_audit", store.claimWorkId(f.candidateId)).at(-1);
  const input = {sourceId: f.f.source.id, batchId: store.plan.batchId, planHash: store.planHash, candidateId: f.candidateId,
    predecessorReceiptHash: contentHash(receipt), authorizationRef: "ordinary-contract-upgrade", diagnosisRef: "old-contract-diagnosis"};
  const preview = await inspectRoleAuditContractAuthorization(f.root, input);
  await withWorkspaceOperationLock(f.root, "compiler", () => authorizeRoleAuditContractRevision(f.root, input, preview.authorityHash));
  await run(f, async work => {
    if (!work.workId.startsWith("role-claim-contract")) return complete(f, work);
    const p = packet(work); expect(p.entry).toEqual(f.original); await read(work, f.units);
    const draft = {...f.negative, claimRevision: p.claimRevision, atlasRevision: p.atlasRevision, packetHash: p.packetHash, verdict: "supported", checks: checks(f.units[0]!)};
    await expect(invoke(work, "propose_role_claim_audit", {...draft, packetHash: contentHash("foreign-packet")})).rejects.toThrow("Stale claim audit");
    await invoke(work, "propose_role_claim_audit", draft);
  });
  const current = fresh(f); expect(current.judgmentRevisions()).toEqual([]); await current.assertQuestionLedger();
  const saved = await assemble(f), ledger = new RequirementLedger(f.root, f.f.source.id);
  expect(requirementJournalBindingIssues({roleRoster: saved, requirementJournal: await ledger.history()}, f.f.source.id, f.f.source.contentSha256)).toEqual([]);
  const guard = await fixture(false, true), g = fresh(guard);
  const guardInput = {...input, sourceId: guard.f.source.id, batchId: g.plan.batchId, planHash: g.planHash, candidateId: guard.candidateId,
    predecessorReceiptHash: contentHash(g.journal.history("propose_role_claim_audit", g.claimWorkId(guard.candidateId)).at(-1))};
  const guardPreview = await inspectRoleAuditContractAuthorization(guard.root, guardInput);
  await withWorkspaceOperationLock(guard.root, "compiler", () => authorizeRoleAuditContractRevision(guard.root, guardInput, guardPreview.authorityHash));
  const tools = createCompilerProposalToolset(guard.root); await tools.beginBatch([], g.plan.batchId, guard.f.source.id);
  await expect(tools.tools.find(t => t.name === "propose_role_roster_entry")!.execute("overwrite", {subjectHash: g.plan.subjectHash, entry: guard.successor} as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("immutable semantic revision lineage");
  const advice = buildNwhToolRecoveryAdvice("propose_role_claim_audit", "Unknown evidence reference");
  expect(JSON.stringify(advice)).toContain("units[].unitId"); expect(JSON.stringify(advice)).toContain("one materially corrected");
  expect(buildNwhToolRecoveryAdvice("propose_role_claim_audit", "ROLE_REVIEW_WORK_HOST_REQUIRED: contract audit consumed").retryable).toBe(false);
});

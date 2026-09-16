import { ActorModelStore, characterGoalSchema } from "../src/world/actors.js";
import { settleCoreRoleRequirements } from "../src/compiler/core-role-requirement-service.js";
import { coreRoleAttemptScope, coreRoleAttemptReports } from "../src/compiler/requirement-attempts.js";
import { compilerFinishReceiptSchema, CompilerFinishReceipts } from "../src/compiler/finish-receipts.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { COMPILER_PIPELINE_VERSION } from "../src/compiler/batch-progress.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { RequirementLedger, requirementJournalSchema, requirementJournalBindingIssues } from "../src/compiler/requirement-ledger.js";
import { buildRoleRoster, RoleRosterStore, roleRosterSchema } from "../src/compiler/role-roster.js";
import { baseStructuralUnits, ensureSourceStructure } from "../src/compiler/structure.js";
import { CanonicalModelStore, ProposalStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { contentHash } from "../src/world/canonical.js";
import { validateAssessmentRevision, preparedSubjectHash } from "../src/compiler/certification.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-core-role-ledger-")); roots.push(root);
  const source = await createEvidenceFixture(root, "Ada waits. Bo watches.");
  const canon = new CanonicalModelStore(root);
  const entities = ["ada", "bo"].map(id => ({ id, kind: "character" as const, canonicalName: id === "ada" ? "Ada" : "Bo", aliases: [], evidence: source.evidence(id === "ada" ? "Ada" : "Bo") }));
  for (const entity of entities) await canon.putEntity(entity);
  const structure = await ensureSourceStructure(root, source.source), units = baseStructuralUnits(structure);
  const roster = buildRoleRoster({ sourceId: source.source.id, sourceSha256: source.source.contentSha256, unitIds: structure.baseUnitIds, entities, annotations: [], resolutions: [] });
  roster.reviews = ["review-one", "review-two"].map(runId => ({ version: 2, runId, subjectHash: roster.subjectHash, reviewedUnitIds: roster.unitIds,
    entries: roster.candidates.map(candidate => ({ candidateId: candidate.id, importance: "major", rationale: "Independent original source review", basisUnitIds: roster.unitIds,
      developmentExpectation: { kind: "unknown", rationale: "Source evidence does not settle continuity", basisUnitIds: roster.unitIds },
    })),
  }));
  const normalized = roleRosterSchema.parse(roster);
  await new RoleRosterStore(root).write(normalized);
  const ledger = new RequirementLedger(root, source.source.id), bytes = Buffer.from("Ada waits. Bo watches.");
  const register = (current = normalized, predecessorRevision?: string, allowScopeReduction = false) => ledger.registerCoreRoles({ roster: current, units,
    predecessorRevision, allowScopeReduction, scopeDecisionRef: "independent-review-audit", scopeChangeReason: "Explicit host source review decision" }, bytes);
  return { root, source, canon, roster: normalized, units, ledger, bytes, register };
}

it("preserves role definitions in the shared hash chain across restart and requires an explicit reviewed scope reduction", async () => {
  const f = await fixture(), first = await f.register();
  expect(await f.register()).toEqual(first);
  expect(await new RequirementLedger(f.root, f.source.source.id).coreRoleDefinitionHistory()).toEqual([first]);
  expect(await f.ledger.definitions()).toEqual([]);
  const revised = structuredClone(f.roster);
  for (const review of revised.reviews) {
    review.runId += "-revision";
    review.entries.find(entry => entry.candidateId === revised.candidates.find(candidate => candidate.entityId === "bo")!.id)!.importance = "supporting";
  }
  await expect(f.register(revised)).rejects.toThrow("predecessor changed");
  await expect(f.register(revised, first.revisionHash)).rejects.toThrow("scope reduction requires host review");
  const second = await f.register(revised, first.revisionHash, true);
  expect(second.removedRequirementIds).toHaveLength(3);
  expect((await f.ledger.coreRoleDefinitionHistory()).map(definition => definition.revisionHash)).toEqual([first.revisionHash, second.revisionHash]);
  const rewritten = structuredClone(revised); rewritten.reviews[0]!.entries[0]!.rationale = "Rewritten old run";
  await expect(f.register(rewritten, second.revisionHash)).rejects.toThrow("review run was rewritten");
});

it("rejects bad original bytes, anchor corruption and incomplete partitions before publishing any role obligation", async () => {
  const f = await fixture();
  const input = { roster: f.roster, units: f.units, scopeDecisionRef: "audit", scopeChangeReason: "review" };
  await expect(f.ledger.registerCoreRoles(input, Buffer.from("different"))).rejects.toThrow("immutable source hash mismatch");
  const broken = structuredClone(input); broken.units[0]!.anchor.exactHash = "0".repeat(64);
  await expect(f.ledger.registerCoreRoles(broken, f.bytes)).rejects.toThrow("source unit evidence is invalid");
  const incomplete = structuredClone(input); incomplete.units.pop(); incomplete.roster.unitIds = incomplete.units.map(unit => unit.id);
  incomplete.roster.reviews.forEach(review => { review.reviewedUnitIds = incomplete.roster.unitIds; review.entries.forEach(entry => {
    entry.basisUnitIds = incomplete.roster.unitIds; entry.developmentExpectation = { kind: "unknown", rationale: "Incomplete", basisUnitIds: incomplete.roster.unitIds };
  }); });
  await expect(f.ledger.registerCoreRoles(incomplete, f.bytes)).rejects.toThrow("omits source bytes");
  expect(await f.ledger.history()).toEqual([]);
});

it("restores complete definition lineage without dropping a newer local obligation", async () => {
  const f = await fixture(), first = await f.register();
  const revised = structuredClone(f.roster); revised.reviews.forEach(review => { review.runId += "-fresh"; });
  await f.register(revised, first.revisionHash);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-core-role-clone-")); roots.push(root);
  const clone = new RequirementLedger(root, f.source.source.id), history = await f.ledger.coreRoleDefinitionHistory();
  await clone.restoreCoreRoles(history, f.bytes);
  await clone.restoreCoreRoles(history, f.bytes);
  expect(await clone.coreRoleDefinitionHistory()).toEqual(history);
  await expect(clone.restoreCoreRoles([first], f.bytes)).rejects.toThrow("forget current obligations");
  await expect(clone.restoreCoreRoles([], f.bytes)).rejects.toThrow("forget current obligations");
  expect((await clone.history()).filter(record => record.payload.kind === "core-role-definition")).toHaveLength(2);
});

it("freezes definitions in real candidates, records exact evaluations idempotently and rejects rollback before materialization", async () => {
  const f = await fixture(); await f.register();
  await new InitialWorldStore(f.root).put({ version: 1, evidence: f.source.evidence("Ada waits."), participantPresence: [{ entityId: "ada", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: true }, { op: "set", entityId: "ada", field: "character.plan", value: "wait" }] } });
  const batches = await prepareCompilerBatches(f.root, f.source.source);
  await new CompilerBatchStore(f.root).replaceCompleted(f.source.source.id, batches.map(batch => batch.id));
  const cache = new PreparedNovelCache(f.root, path.join(f.root, "cache"));
  const candidate = await cache.inspectCandidate(f.source.source);
  expect(candidate.bundle.compilerSnapshot.coreRoleRequirementDefinitions).toEqual(await f.ledger.coreRoleDefinitionHistory());
  expect(candidate.assessment.closure.nodes.some(node => node.kind === "core-role-requirements")).toBe(true);
  expect(candidate.assessment.issues.some(issue => issue.code === "CORE_ROLE_DEFINITION_NOT_CERTIFIED")).toBe(false);
  await f.ledger.recordCoreRoleEvaluation(candidate.bundle, candidate.assessment);
  await f.ledger.recordCoreRoleEvaluation(candidate.bundle, candidate.assessment);
  expect((await f.ledger.history()).filter(record => record.payload.kind === "core-role-evaluation")).toHaveLength(1);
  const afterEvaluation = await cache.candidateSnapshot(f.source.source);
  expect(afterEvaluation.compilerSnapshot.requirementJournal).toEqual(await f.ledger.history());
  expect(contentHash(afterEvaluation)).not.toBe(contentHash(candidate.bundle));
  expect(preparedSubjectHash(afterEvaluation)).toBe(preparedSubjectHash(candidate.bundle));
  const legacy = structuredClone(afterEvaluation); delete legacy.compilerSnapshot.requirementJournal;
  expect(preparedSubjectHash(legacy)).toBe(preparedSubjectHash(afterEvaluation));
  expect(validateAssessmentRevision(legacy, candidate.assessment)).toContain("REQUIREMENT_JOURNAL_MISSING");
  const wrongSource = structuredClone(candidate.bundle); wrongSource.source.contentSha256 = "0".repeat(64);
  await expect(f.ledger.recordCoreRoleEvaluation(wrongSource, candidate.assessment)).rejects.toThrow("current frozen definition");
  const forged = structuredClone(candidate.assessment); forged.coreRoleResult!.requirements.forEach(item => { item.state = "satisfied"; item.diagnostics = []; item.blockedBy = []; });
  await expect(f.ledger.recordCoreRoleEvaluation(candidate.bundle, forged)).rejects.toThrow("differs from its frozen deterministic result");
  const historicalSuccess = structuredClone(afterEvaluation);
  for (const record of historicalSuccess.compilerSnapshot.requirementJournal!) {
    if (record.payload.kind === "core-role-evaluation") record.payload.result.requirements.forEach(item => { item.state = "satisfied"; item.diagnostics = []; item.blockedBy = []; });
    const { hash: _hash, ...identity } = record; record.hash = contentHash(identity);
  }
  expect(requirementJournalBindingIssues(historicalSuccess.compilerSnapshot, f.source.source.id, f.source.source.contentSha256)).toEqual([]);
  expect(validateAssessmentRevision(historicalSuccess, forged)).toContain("CORE_ROLE_REQUIREMENT_RESULT_STALE_OR_MISMATCH");
  const missingDefinition = structuredClone(candidate.bundle); missingDefinition.compilerSnapshot.coreRoleRequirementDefinitions = [];
  expect(validateAssessmentRevision(missingDefinition, candidate.assessment)).toContain("CORE_ROLE_DEFINITION_NOT_REGISTERED");
  const archive = await cache.archiveCandidate(f.source.source);
  const next = structuredClone(f.roster); next.reviews.forEach(review => { review.runId += "-new"; });
  await f.register(next, (await f.ledger.coreRoleDefinitionHistory()).at(-1)!.revisionHash);
  const ada = await f.canon.getEntity("ada"); await f.canon.putEntity({ ...ada, aliases: ["Current live value"] });
  const before = contentHash(await f.canon.listEntities());
  await expect(cache.restoreCompilerCheckpoint(f.source.source, archive.bundleHash!)).rejects.toThrow("forget current obligations");
  expect(contentHash(await f.canon.listEntities())).toBe(before);
});

it("recovers post-convergence settlement without replay and retains invalidation and per-attempt stale revisions", async () => {
  const f = await fixture(), definition = await f.register();
  await new InitialWorldStore(f.root).put({ version: 1, evidence: f.source.evidence("Ada waits."), participantPresence: [{ entityId: "ada", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: true }, { op: "set", entityId: "ada", field: "character.plan", value: "wait" }] } });
  const batches = await prepareCompilerBatches(f.root, f.source.source);
  await new CompilerBatchStore(f.root).replaceCompleted(f.source.source.id, batches.map(batch => batch.id));
  const scope = coreRoleAttemptScope(definition);
  const requirements = [{ id: "character:ada:ontology", target: "character:ada", capability: "ontology" as const }, { id: "character:ada:opening-driver", target: "character:ada", capability: "opening-driver" as const }];
  const reports = [{ target: "character:ada", disposition: "capability-gap" as const, summary: "Both capabilities remain unproven", evidence_segment_ids: [f.source.segmentId], requirement_reviews: requirements.map(item => ({ requirementId: item.id, disposition: "capability-gap" as const, summary: "No supported repair" })) }];
  const identity = { version: 2, pipelineVersion: COMPILER_PIPELINE_VERSION, sourceId: f.source.source.id, sourceSha256: f.source.source.contentSha256, batchId: "historical-repair",
    requirementScope: { planHash: contentHash("original-plan"), requirements, coreRoleScope: scope }, requirementAttempts: coreRoleAttemptReports({ batchId: "historical-repair", scope, requirements, reviews: reports }),
    input: { outcome: "no-artifacts", reviewed_segments: [], summary: "Retained completed source review", target_reviews: reports }, segments: (await new SegmentStore(f.root).readManifest(f.source.source.id))!.segments, dependencies: [], metadata: {},
  };
  const receipt = compilerFinishReceiptSchema.parse({ identity, fingerprint: contentHash(identity), state: "completed", preparedAt: "2026-09-16T00:00:00Z", completedAt: "2026-09-16T00:00:01Z" });
  await CompilerFinishReceipts.retainSnapshot(f.root, f.source.source.id, receipt);
  const interrupted = vi.spyOn(RequirementLedger.prototype as unknown as { settleCoreRoleAttempts(): Promise<void> }, "settleCoreRoleAttempts").mockRejectedValueOnce(new Error("simulated interruption after evaluation"));
  const settle = () => settleCoreRoleRequirements(f.root, f.source.source.id, path.join(f.root, "cache"));
  await expect(settle()).rejects.toThrow("simulated interruption after evaluation");
  expect((await f.ledger.history()).filter(record => record.payload.kind === "core-role-evaluation")).toHaveLength(1);
  expect((await f.ledger.history()).filter(record => record.payload.kind === "core-role-attempt-evaluation")).toHaveLength(0);
  interrupted.mockRestore();
  const first = await settle(); await settle();
  let history = await f.ledger.history();
  expect(history.filter(record => record.payload.kind === "core-role-evaluation")).toHaveLength(1);
  expect(history.filter(record => record.payload.kind === "core-role-attempt-evaluation")).toHaveLength(2);
  const settlements = history.flatMap(record => record.payload.kind === "core-role-attempt-evaluation" ? [record.payload] : []);
  expect(settlements.every(item => item.result.state !== "satisfied" && item.subjectSnapshotHash === first!.assessment.subjectSnapshotHash)).toBe(true);
  const initialStore = new InitialWorldStore(f.root), initial = (await initialStore.get())!;
  await initialStore.put({ ...initial, delta: { version: 1, operations: [...initial.delta.operations.filter(operation => operation.op !== "set" || operation.field !== "character.plan"), { op: "set", entityId: "ada", field: "character.plan", value: "watch" }] } });
  const changed = await settle();
  expect(changed!.assessment.subjectSnapshotHash).not.toBe(first!.assessment.subjectSnapshotHash);
  history = await f.ledger.history();
  expect(history.filter(record => record.payload.kind === "core-role-invalidation")).toHaveLength(1);
  expect(history.filter(record => record.payload.kind === "core-role-attempt-evaluation")).toHaveLength(4);
  const revised = structuredClone(f.roster); revised.reviews.forEach(review => { review.runId += "-new"; });
  await f.register(revised, definition.revisionHash); await new RoleRosterStore(f.root).write(revised);
  const latest = await settle();
  const stale = (await f.ledger.history()).flatMap(record => record.payload.kind === "core-role-attempt-evaluation" && record.payload.subjectSnapshotHash === latest!.assessment.subjectSnapshotHash ? [record.payload.result] : []);
  expect(stale).toHaveLength(2);
  expect(stale.every(result => result.state === "stale" && result.diagnostics.includes("ATTEMPT_REQUIREMENT_REVISION_STALE"))).toBe(true);
  const cache = new PreparedNovelCache(f.root, path.join(f.root, "cache")), archive = await cache.archiveCandidate(f.source.source);
  const frozen = (await cache.loadRevision(f.source.source, archive.bundleHash!))!.bundle;
  const frozenHistory = frozen.compilerSnapshot.requirementJournal!;
  expect(frozenHistory).toEqual(await f.ledger.history());
  expect(requirementJournalBindingIssues(frozen.compilerSnapshot, f.source.source.id, f.source.source.contentSha256, true)).toEqual([]);
  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-journal-materialize-")); roots.push(cloneRoot);
  const clonedSource = await createEvidenceFixture(cloneRoot, "Ada waits. Bo watches.");
  expect(clonedSource.source.id).toBe(f.source.source.id);
  const clonedCache = new PreparedNovelCache(cloneRoot, path.join(f.root, "cache"));
  await clonedCache.restoreCompilerCheckpoint(clonedSource.source, archive.bundleHash!);
  await clonedCache.restoreCompilerCheckpoint(clonedSource.source, archive.bundleHash!);
  expect(await new RequirementLedger(cloneRoot, clonedSource.source.id).history()).toEqual(frozenHistory);
  expect(await new ProposalStore(cloneRoot).list("pending", clonedSource.source.id)).toEqual([]);
  expect(await CompilerFinishReceipts.list(cloneRoot, clonedSource.source.id)).toEqual([]);
  expect((await CompilerFinishReceipts.listRetained(cloneRoot, clonedSource.source.id)).map(item => item.receipt.fingerprint)).toContain(receipt.fingerprint);
  const corrupted = structuredClone(frozenHistory); corrupted.at(-1)!.hash = "0".repeat(64);
  await expect(new RequirementLedger(cloneRoot, clonedSource.source.id).restoreJournal(corrupted, f.bytes)).rejects.toThrow("journal hash mismatch");
  const brokenReference = structuredClone(frozenHistory);
  const invalidation = brokenReference.find(record => record.payload.kind === "core-role-invalidation")!;
  if (invalidation.payload.kind === "core-role-invalidation") invalidation.payload.evaluationRef = "0".repeat(64);
  for (const [index, record] of brokenReference.entries()) {
    record.predecessorHash = brokenReference[index - 1]?.hash ?? null;
    const { hash: _hash, ...identity } = record; record.hash = contentHash(identity);
  }
  expect(() => requirementJournalSchema.parse(brokenReference)).toThrow("no retained evaluation");
  const missingReceipts = structuredClone(frozen.compilerSnapshot); missingReceipts.reconciliationObligations = [];
  expect(requirementJournalBindingIssues(missingReceipts, f.source.source.id, f.source.source.contentSha256)).toContain("REQUIREMENT_JOURNAL_RECEIPT_MISSING");
  const ada = await f.canon.getEntity("ada"); await f.canon.putEntity({ ...ada, aliases: ["Changed source identity inventory"] });
  await expect(settle()).rejects.toThrow("evaluation subject is stale");
  const afterIdentityChange = await f.ledger.history();
  expect(afterIdentityChange.filter(record => record.payload.kind === "core-role-invalidation")).toHaveLength(3);
  expect(afterIdentityChange.filter(record => record.payload.kind === "core-role-evaluation")).toHaveLength(3);
  const beforeRestore = contentHash(await f.canon.listEntities());
  await expect(cache.restoreCompilerCheckpoint(f.source.source, archive.bundleHash!)).rejects.toThrow("discard or rewrite current audit history");
  expect(contentHash(await f.canon.listEntities())).toBe(beforeRestore);
  await expect(settle()).rejects.toThrow("evaluation subject is stale");
  expect((await f.ledger.history()).filter(record => record.payload.kind === "core-role-invalidation")).toHaveLength(3);
});

it("settles only accepted active proposal revisions and marks superseded work stale", async () => {
  const f = await fixture(), definition = await f.register();
  await new InitialWorldStore(f.root).put({ version: 1, evidence: f.source.evidence("Ada waits."), participantPresence: [{ entityId: "ada", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: true }, { op: "set", entityId: "ada", field: "character.plan", value: "wait" }] } });
  const batches = await prepareCompilerBatches(f.root, f.source.source);
  await new CompilerBatchStore(f.root).replaceCompleted(f.source.source.id, batches.map(batch => batch.id));
  const goal = characterGoalSchema.parse({ id: "ada-action", actorId: "ada", description: "Wait", priority: 1, requiresKnowledge: [], evidence: f.source.evidence("Ada waits."), candidateAction: { title: "Wait", preconditions: [], proposedDelta: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.plan", value: "wait longer" }] } } });
  const proposals = new ProposalStore(f.root), actors = new ActorModelStore(f.root);
  await proposals.writePending({ id: "driver-proposal", kind: "character-goal", schemaVersion: 1, payload: goal, evidence: goal.evidence, generatedBy: { worker: "fixture", compilerBatchId: "driver-repair" }, createdAt: "2026-09-16T00:00:00Z" }, characterGoalSchema);
  const ref = { store: "world" as const, proposalId: "driver-proposal", hash: contentHash(await proposals.readEnvelope("pending", "driver-proposal")) };
  const scope = coreRoleAttemptScope(definition), requirements = [{ id: "character:ada:opening-driver", target: "character:ada", capability: "opening-driver" as const }];
  const reviews = [{ target: "character:ada", disposition: "proposed" as const, summary: "Attempted driver", evidence_segment_ids: [f.source.segmentId], requirement_reviews: [{ requirementId: requirements[0]!.id, disposition: "proposed" as const, summary: "Typed action attempt" }] }];
  const identity = { version: 2, pipelineVersion: COMPILER_PIPELINE_VERSION, sourceId: f.source.source.id, sourceSha256: f.source.source.contentSha256, batchId: "driver-repair", requirementScope: { planHash: contentHash("driver-plan"), requirements, coreRoleScope: scope },
    requirementAttempts: coreRoleAttemptReports({ batchId: "driver-repair", scope, requirements, reviews }).map(attempt => ({ ...attempt, proposalRefs: [ref] })), input: { outcome: "complete", reviewed_segments: [], summary: "Driver proposal finish", target_reviews: reviews }, segments: await new SegmentStore(f.root).list(f.source.source.id), dependencies: [ref], metadata: {} };
  const receipt = compilerFinishReceiptSchema.parse({ identity, fingerprint: contentHash(identity), state: "completed", preparedAt: "2026-09-16T00:00:00Z", completedAt: "2026-09-16T00:00:01Z" });
  await CompilerFinishReceipts.retainSnapshot(f.root, f.source.source.id, receipt);
  const settle = () => settleCoreRoleRequirements(f.root, f.source.source.id, path.join(f.root, "cache"));
  await expect(settle()).rejects.toThrow("still pending");
  expect((await f.ledger.history()).filter(record => record.payload.kind === "core-role-evaluation")).toHaveLength(0);
  // Storage-level fixture for the accepted revision; real convergence is covered separately.
  await actors.putGoal(goal); await proposals.transition(ref.proposalId, "pending", "accepted");
  const first = await settle();
  const results = () => f.ledger.history().then(history => history.flatMap(record => record.payload.kind === "core-role-attempt-evaluation" ? [record.payload] : []));
  expect((await results())[0]!.result.state).not.toBe("stale");
  expect((await results())[0]!.result.state).not.toBe("satisfied"); // Focal actor's goal is not an autonomous entry driver.
  await actors.putGoal({ ...goal, description: "Revised current goal" });
  const second = await settle();
  expect(second!.assessment.subjectSnapshotHash).not.toBe(first!.assessment.subjectSnapshotHash);
  expect((await results()).at(-1)!.result).toMatchObject({ state: "stale", diagnostics: ["ATTEMPT_DEPENDENCY_NOT_ACTIVE: driver-proposal"] });
  expect((await results())[0]!.result.state).not.toBe("stale");
});

it("observes changes through convergence, resumes interrupted invalidation and preserves an unfreezable subject", async () => {
  const { convergeWorldProposals } = await import("../src/compiler/converge.js");
  const { observeRequirementValidity } = await import("../src/compiler/requirement-observation.js");
  const { acceptProposalCommand } = await import("../src/commands/proposals.js");
  const f = await fixture(); await f.register();
  const initialStore = new InitialWorldStore(f.root);
  await initialStore.put({ version: 1, evidence: f.source.evidence("Ada waits."), participantPresence: [{ entityId: "ada", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: true }, { op: "set", entityId: "ada", field: "character.plan", value: "wait" }] } });
  const batches = await prepareCompilerBatches(f.root, f.source.source);
  await new CompilerBatchStore(f.root).replaceCompleted(f.source.source.id, batches.map(batch => batch.id));
  const settle = () => settleCoreRoleRequirements(f.root, f.source.source.id, path.join(f.root, "cache"));
  await settle();
  const original = await f.ledger.history();
  await convergeWorldProposals(f.root);
  expect(await f.ledger.history()).toEqual(original);
  const goal = characterGoalSchema.parse({ id: "ada-action", actorId: "ada", description: "Wait", priority: 1, requiresKnowledge: [], evidence: f.source.evidence("Ada waits."), candidateAction: { title: "Wait", preconditions: [], proposedDelta: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.plan", value: "wait longer" }] } } });
  const proposals = new ProposalStore(f.root);
  await proposals.writePending({ id: "observed-goal", kind: "character-goal", schemaVersion: 1, payload: goal, evidence: goal.evidence, generatedBy: { worker: "fixture" }, createdAt: "2026-09-16T00:00:00Z" }, characterGoalSchema);
  const failure = vi.spyOn(RequirementLedger.prototype, "invalidateCoreRoleEvaluation").mockRejectedValueOnce(new Error("simulated journal append failure"));
  await expect(acceptProposalCommand(f.root, "character-goal", "observed-goal")).rejects.toThrow("Committed writes remain committed");
  expect(await proposals.list("pending")).toEqual([]);
  expect((await proposals.list("accepted")).map(item => item.id)).toContain("observed-goal");
  failure.mockRestore();
  await convergeWorldProposals(f.root); await convergeWorldProposals(f.root);
  let history = await f.ledger.history();
  expect(history.filter(record => record.payload.kind === "core-role-invalidation")).toHaveLength(1);
  expect(history.filter(record => record.payload.kind === "core-role-evaluation")).toHaveLength(1);
  await settle();
  const initial = (await initialStore.get())!;
  // An unavailable initial world cannot be encoded as a fabricated subject hash.
  const missing = vi.spyOn(InitialWorldStore.prototype, "get").mockResolvedValue(null);
  const result = await convergeWorldProposals(f.root);
  expect(result.requirementValidityIssues?.[0]).toContain("initial world");
  await observeRequirementValidity(f.root, f.source.source.id);
  history = await f.ledger.history();
  expect(history.filter(record => record.payload.kind === "core-role-invalidation" && record.payload.nextSubjectSnapshotHash === null)).toHaveLength(1);
  missing.mockRestore();
  expect(await initialStore.get()).toEqual(initial);
  await settle(); await settle();
  expect((await f.ledger.history()).filter(record => record.payload.kind === "core-role-evaluation")).toHaveLength(3);
  const invalidGoal = { ...goal, actorId: "missing-actor" };
  await proposals.writePending({ id: "blocked-goal", kind: "character-goal", schemaVersion: 1, payload: invalidGoal, evidence: goal.evidence, generatedBy: { worker: "fixture" }, createdAt: "2026-09-16T00:00:00Z" }, characterGoalSchema);
  const blocked = await convergeWorldProposals(f.root);
  expect(blocked.canonical.blocked.map(item => item.id)).toContain("blocked-goal");
  expect(blocked.requirementValidityIssues?.[0]).toContain("still pending");
  const { quarantineUncommittableProposals } = await import("../src/compiler/converge.js");
  expect((await quarantineUncommittableProposals(f.root, blocked)).map(item => item.id)).toContain("blocked-goal");
  await settle();
  expect((await f.ledger.history()).filter(record => record.payload.kind === "core-role-evaluation")).toHaveLength(4);
  expect((await proposals.list("accepted")).map(item => item.id)).toEqual(["observed-goal"]);
});

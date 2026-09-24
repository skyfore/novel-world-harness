import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CanonicalModelStore, ProposalStore } from "../src/world/canonical-model.js";
import { canonicalEventSchema, type StateDelta } from "../src/world/model.js";
import { contentHash } from "../src/world/canonical.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { ActorModelStore } from "../src/world/actors.js";
import { registerSourceRequirements, settleSourceRequirements, requirementInputs } from "../src/compiler/requirement-service.js";
import { RequirementLedger, requirementResultIssues } from "../src/compiler/requirement-ledger.js";
import { settleCoreRoleRequirements } from "../src/compiler/core-role-requirement-service.js";
import { observeRequirementValidity } from "../src/compiler/requirement-observation.js";
import { buildRoleRoster, RoleRosterStore, roleRosterSchema } from "../src/compiler/role-roster.js";
import { ensureSourceStructure, baseStructuralUnits } from "../src/compiler/structure.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { CompilerFinishReceipts } from "../src/compiler/finish-receipts.js";
import { recoverCompilerFinish } from "../src/compiler/finish-recovery.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { auditCompiler } from "../src/compiler/audit.js";
import { buildWorldReconciliationPrompt } from "../src/compiler/reconcile-world.js";
import { assertReconciliationDeferralsReviewed } from "../src/compiler/reconciliation-review-ledger.js";
import type { ReconciliationRequirement } from "../src/compiler/reconciliation-review.js";
import { invalidatePreparationArtifacts } from "../src/commands/reparse.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

// Original source expectations precede all compiler artifacts. These are different
// semantic cases (no change vs an explicit change of plan), not renamed outputs.
const scenes = [
  { id: "gate", text: "林守在闸口，打算等到信号再开闸。检查结束，林仍维持原来的打算。远处的周在数船。",
    actor: "林", other: "周", occurrence: "检查结束，林仍维持原来的打算。",
    initialPlan: "等到信号再开闸", laterPlan: "继续等候信号", goal: "等到信号再开闸",
    development: "stable" as const, changesPlan: false },
  { id: "pump", text: 'Orr whistles by the pump. "I shall inspect the pump," says Mara. After finding a leak, Mara changes her plan to repairing the pump. Her longer-term convictions are not described.',
    actor: "Mara", other: "Orr", occurrence: "After finding a leak, Mara changes her plan to repairing the pump.",
    initialPlan: "inspect the pump", laterPlan: "repair the pump", goal: "repair the pump",
    development: "unknown" as const, changesPlan: true },
];

it.each(scenes)("retains independent obligations through partial repair and interrupted settlement: $id", async scene => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-p1-exit-")); roots.push(root);
  const source = await createEvidenceFixture(root, scene.text), sourceId = source.source.id;
  const bytes = Buffer.from(scene.text), start = bytes.indexOf(Buffer.from(scene.occurrence));
  const expectedDelta: StateDelta = { version: 1, operations: scene.changesPlan
    ? [{ op: "set", entityId: "actor", field: "character.plan", value: scene.laterPlan }] : [] };
  const independentSpec = {
    version: 1, sourceId, sourceSha256: source.source.contentSha256,
    review: { method: "independent-source-review", reviewer: "original-fixture-author", reviewedAt: "2026-09-22T00:00:00Z", auditRef: `source-expectation-${scene.id}` },
    cases: [{ id: "decision", kind: "event-effects", eventId: "decision", scene: scene.occurrence,
      rationale: "Check only the explicitly stated change or preservation of the plan, not execution of the intended act",
      evidence: [textAnchorForByteRange(sourceId, bytes, start, start + Buffer.byteLength(scene.occurrence))], requiresMechanism: false,
      expectation: scene.changesPlan ? { kind: "delta", delta: expectedDelta } : { kind: "no-change", justification: scene.occurrence } }],
  };
  const sceneDefinition = await registerSourceRequirements(root, { sourceId, id: "source-expectations", spec: independentSpec, scopeDecisionRef: `review-${scene.id}` });
  const ledger = new RequirementLedger(root, sourceId), canon = new CanonicalModelStore(root);
  expect(await canon.listEvents()).toEqual([]);
  const entities = [["actor", scene.actor], ["bystander", scene.other]].map(([id, name]) => ({
    id: id!, kind: "character" as const, canonicalName: name!, aliases: [], evidence: source.evidence(name!),
  }));
  const structure = await ensureSourceStructure(root, source.source);
  const roster = buildRoleRoster({ sourceId, sourceSha256: source.source.contentSha256, unitIds: structure.baseUnitIds, entities, annotations: [], resolutions: [] });
  roster.reviews = ["source-review-one", "source-review-two"].map(runId => ({ version: 2, runId,
    subjectHash: roster.subjectHash, reviewedUnitIds: roster.unitIds, missingMajorCharacters: [],
    entries: roster.candidates.map(role => ({ candidateId: role.id, importance: role.entityId === "actor" ? "major" : "incidental",
      rationale: role.entityId === "actor" ? "The source follows this person's decision" : "An unrelated bystander",
      basisUnitIds: roster.unitIds, developmentExpectation: { kind: scene.development,
        rationale: scene.development === "stable" ? "The source explicitly preserves the intention" : "Changing a plan does not establish long-term character development",
        basisUnitIds: roster.unitIds } })),
  }));
  const normalizedRoster = roleRosterSchema.parse(roster);
  const definition = await ledger.registerCoreRoles({ roster: normalizedRoster, units: baseStructuralUnits(structure),
    scopeDecisionRef: `role-scope-${scene.id}`, scopeChangeReason: "Source expectations declared before candidate models and goals" }, bytes);
  const roleId = normalizedRoster.candidates.find(role => role.entityId === "actor")!.id;
  const frozenDefinitions = await ledger.coreRoleDefinitionHistory();
  for (const entity of entities) await canon.putEntity(entity);
  await new RoleRosterStore(root).write(normalizedRoster);
  await new ActorModelStore(root).putModel({ actorId: "actor", traits: {}, decisionBiases: {}, evidence: source.evidence(scene.actor) });
  const initial = new InitialWorldStore(root);
  await initial.put({ version: 1, evidence: source.evidence(scene.text), participantPresence: [{ entityId: "actor", mode: "physical" }],
    delta: { version: 1, operations: [{ op: "set", entityId: "actor", field: "character.alive", value: true },
      { op: "set", entityId: "actor", field: "character.plan", value: scene.initialPlan }] } });
  const event = canonicalEventSchema.parse({ id: "decision", title: scene.occurrence, participants: ["actor"],
    participantPresence: [{ entityId: "actor", mode: "physical" }], storyTime: { kind: "unknown" }, preconditions: [],
    causalParents: [], confidence: 1, evidence: source.evidence(scene.occurrence), observedOutcome: expectedDelta });
  const wrongEvent = { ...event, observedOutcome: { version: 1 as const, operations: scene.changesPlan ? []
    : [{ op: "set" as const, entityId: "actor", field: "character.plan", value: "open immediately" }] } };
  await canon.putEvent(wrongEvent);
  await new CompilerBatchStore(root).replaceCompleted(sourceId, (await prepareCompilerBatches(root, source.source)).map(batch => batch.id));
  const cacheRoot = path.join(root, "cache"), cache = new PreparedNovelCache(root, cacheRoot);
  // A rollback archive is not a certified active publication. Never manufacture
  // an active pointer or bypass readiness to make the acceptance fixture green.
  const archived = await cache.archiveCandidate(source.source);
  const oldBundle = (await cache.loadRevision(source.source, archived.bundleHash!))!.bundle;
  const oldBundleHash = contentHash(oldBundle);
  expect(await cache.loadFreshActive(source.source)).toBeNull();
  const before = await settleSourceRequirements(root, sourceId);
  expect(before.issues.length).toBeGreaterThan(0);
  const denominator = before.results[0]!.requirements.map(item => item.id);

  const makeTools = async (batchId: string) => {
    const tools = createCompilerProposalToolset(root); await tools.beginBatch([], batchId, sourceId);
    return (name: string, input: unknown) => tools.tools.find(tool => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
  };
  const eventBatch = `effect-repair-${scene.id}`, correct = await makeTools(eventBatch);
  const { evidence: _evidence, ...payload } = event;
  await correct("propose_canonical_event", { proposal_id: "correct-decision", payload, evidence_segment_ids: [source.segmentId] });
  const proposals = new ProposalStore(root), pending = await proposals.readEnvelope("pending", "correct-decision");
  await expect(correct("finish_compiler_batch", { outcome: "no-artifacts", reviewed_segments: [], summary: "Invalidly hides the successful proposal" })).rejects.toThrow("active successful");
  expect(await canon.listEvents()).toEqual([wrongEvent]);
  expect(await proposals.readEnvelope("pending", "correct-decision")).toEqual(pending);
  expect(await new CompilerFinishReceipts(root, sourceId, eventBatch).read()).toBeUndefined();
  expect(await cache.loadFreshActive(source.source)).toBeNull();
  expect(contentHash((await cache.loadRevision(source.source, archived.bundleHash!))!.bundle)).toBe(oldBundleHash);
  await correct("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Repair the explicit event effect only" });
  expect((await settleSourceRequirements(root, sourceId)).issues.length).toBeGreaterThan(0);
  await convergeWorldProposals(root, sourceId);
  const repaired = await settleSourceRequirements(root, sourceId);
  expect(repaired.issues).toEqual([]);
  expect(repaired.results[0]!.requirements.map(item => item.id)).toEqual(denominator);
  expect(await canon.listEvents()).toEqual([{ ...event, evidence: source.evidence(scene.text) }]);

  const audit = await auditCompiler(root, { sourceId });
  const request = { ...audit, coverage: { ...audit.coverage, autonomousDriverCoverage: 0 },
    semanticRepairTargets: { ...audit.semanticRepairTargets, characterIds: ["actor"] } };
  const readPlan = async (namespace: string, current = request) => {
    const prompt = await buildWorldReconciliationPrompt(root, sourceId, current, 1, { proposalIdSuffixTail: namespace });
    return JSON.parse(prompt.match(/<reconciliation-context>\n([\s\S]+)\n<\/reconciliation-context>/u)![1]!).repairPlan as {
      reviewTargets: string[]; requirements: ReconciliationRequirement[];
    };
  };
  const namespace = "partial-goal", plan = await readPlan(namespace);
  const batchId = `reconcile-${sourceId}-bounded-${namespace}-1`, call = await makeTools(batchId);
  await call("propose_character_goal", { proposal_id: "static-goal", payload: { id: "static-goal", actorId: "actor",
    description: scene.goal, priority: 1, requiresKnowledge: [] }, evidence_segment_ids: [source.segmentId] });
  const reports = plan.reviewTargets.map(target => ({ target, disposition: target === "character:actor" ? "proposed" : "capability-gap",
    evidence_segment_ids: [source.segmentId], summary: "Static intention only; no character ontology or independent driver is supplied",
    requirement_reviews: plan.requirements.filter(item => item.target === target).map(item => ({ requirementId: item.id,
      disposition: "capability-gap", summary: "Retain the independently reviewed missing capability" })) }));
  const append = vi.spyOn(RequirementLedger.prototype, "recordCoreRoleAttempts").mockRejectedValueOnce(new Error("interrupted after finish"));
  await expect(call("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], target_reviews: reports, summary: "Partial goal repair" })).rejects.toThrow("interrupted after finish");
  const receipts = new CompilerFinishReceipts(root, sourceId, batchId), receipt = (await receipts.read())!;
  expect(receipt.state).toBe("completed");
  expect(receipt.identity.requirementAttempts!.map(item => item.requirementId)).toEqual(expect.arrayContaining([`${roleId}:ontology`, `${roleId}:opening-driver`]));
  expect(receipt.identity.requirementAttempts!.every(item => item.modelOutcome === "capability-gap" && item.proposalRefs.length === 0)).toBe(true);
  append.mockRestore();
  const goalDraft = await proposals.readEnvelope("pending", "static-goal");
  await recoverCompilerFinish(root, sourceId, batchId);
  await recoverCompilerFinish(root, sourceId, batchId);
  expect(await proposals.readEnvelope("pending", "static-goal")).toEqual(goalDraft);
  expect((await ledger.history()).filter(record => record.payload.kind === "core-role-attempt")).toHaveLength(1);
  await convergeWorldProposals(root, sourceId);
  expect(await proposals.readEnvelope("accepted", "static-goal")).toEqual(goalDraft);

  const interrupted = vi.spyOn(RequirementLedger.prototype as unknown as { settleCoreRoleAttempts(): Promise<void> }, "settleCoreRoleAttempts")
    .mockRejectedValueOnce(new Error("interrupted after evaluation"));
  const settle = () => settleCoreRoleRequirements(root, sourceId, cacheRoot);
  await expect(settle()).rejects.toThrow("interrupted after evaluation");
  const intermediate = await ledger.history();
  expect(intermediate.filter(record => record.payload.kind === "core-role-evaluation")).toHaveLength(1);
  expect(intermediate.filter(record => record.payload.kind === "core-role-attempt-evaluation")).toHaveLength(0);
  interrupted.mockRestore();
  const evaluated = (await settle())!;
  const settledHistory = await ledger.history();
  await settle();
  expect(await new RequirementLedger(root, sourceId).history()).toEqual(settledHistory);
  expect(await proposals.readEnvelope("accepted", "static-goal")).toEqual(goalDraft);
  const roles = evaluated.assessment.coreRoleResult!.requirements;
  for (const capability of ["ontology", "opening-driver"]) expect(roles.find(item => item.id === `${roleId}:${capability}`)!.state).toBe("blocked");
  if (scene.development === "unknown") expect(roles.find(item => item.id === `${roleId}:development`)!.state).toBe("unknown");
  expect(settledHistory.filter(record => record.payload.kind === "core-role-attempt-evaluation")).toHaveLength(receipt.identity.requirementAttempts!.length);
  expect(await ledger.coreRoleDefinitionHistory()).toEqual(frozenDefinitions);
  expect(await ledger.definitions()).toEqual([sceneDefinition]);
  await expect(cache.publish(source.source)).rejects.toThrow();
  expect(await cache.loadFreshActive(source.source)).toBeNull();

  const improved = { ...request, coverage: { ...request.coverage, autonomousDriverCoverage: 1 },
    semanticRepairTargets: { ...request.semanticRepairTargets, characterIds: [] } };
  expect((await readPlan(namespace, improved)).requirements).toEqual(plan.requirements);
  await receipts.archive("Reparse retires a batch, not its obligations");
  expect(await receipts.read()).toBeUndefined();
  await readPlan("new-namespace", improved);
  await expect(assertReconciliationDeferralsReviewed(root, sourceId)).rejects.toThrow("character:actor:ontology");
  expect(await new RequirementLedger(root, sourceId).coreRoleDefinitionHistory()).toEqual(frozenDefinitions);
  expect((await CompilerFinishReceipts.listRetained(root, sourceId)).some(item => item.receipt.fingerprint === receipt.fingerprint)).toBe(true);

  const portable = await cache.archiveCandidate(source.source), frozenHistory = await ledger.history();
  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-p1-exit-restored-")); roots.push(cloneRoot);
  const cloneSource = await createEvidenceFixture(cloneRoot, scene.text);
  const cloneCache = new PreparedNovelCache(cloneRoot, cacheRoot);
  await cloneCache.restoreCompilerCheckpoint(cloneSource.source, portable.bundleHash!);
  await cloneCache.restoreCompilerCheckpoint(cloneSource.source, portable.bundleHash!);
  expect(await new RequirementLedger(cloneRoot, sourceId).history()).toEqual(frozenHistory);
  await expect(assertReconciliationDeferralsReviewed(cloneRoot, sourceId)).rejects.toThrow("character:actor:ontology");
  expect(await new ProposalStore(cloneRoot).list("pending", sourceId)).toEqual([]);
  // Exercise the real reparse invalidation boundary on the restored workspace;
  // do not invoke a provider or replace the independent source denominator.
  await CompilerFinishReceipts.archiveSource(cloneRoot, sourceId, "Whole-source reparse acceptance");
  expect(await invalidatePreparationArtifacts(cloneRoot, sourceId, [], true)).toBeGreaterThan(0);
  expect(await new CanonicalModelStore(cloneRoot).listEvents()).toEqual([]);
  await observeRequirementValidity(cloneRoot, sourceId);
  const cloneLedger = new RequirementLedger(cloneRoot, sourceId);
  expect(await cloneLedger.coreRoleDefinitionHistory()).toEqual(frozenDefinitions);
  expect(await cloneLedger.definitions()).toEqual([sceneDefinition]);
  expect((await cloneLedger.history()).slice(0, frozenHistory.length)).toEqual(frozenHistory);
  await expect(assertReconciliationDeferralsReviewed(cloneRoot, sourceId)).rejects.toThrow("character:actor:ontology");

  // Source correction invalidates the previous result; restoration must not
  // discard the newer audit chain or replay an already accepted model proposal.
  await canon.putEvent(wrongEvent);
  const inputs = await requirementInputs(root, sourceId);
  expect(requirementResultIssues(repaired.sets, repaired.results, inputs.catalog).join()).toContain("REVISION_STALE");
  await expect(settle()).rejects.toThrow("exact-evidence binding canonical-event/decision is stale");
  const validityIssues = await observeRequirementValidity(root, sourceId);
  expect(validityIssues.join()).toContain("exact-evidence binding canonical-event/decision is stale");
  expect((await ledger.history()).some(record => record.payload.kind === "core-role-invalidation"
    && record.payload.nextSubjectSnapshotHash === null)).toBe(true);
  expect((await settleSourceRequirements(root, sourceId)).issues.length).toBeGreaterThan(0);
  const currentEvents = await canon.listEvents(), currentHistory = await ledger.history();
  await expect(cache.restoreCompilerCheckpoint(source.source, archived.bundleHash!)).rejects.toThrow();
  expect(await canon.listEvents()).toEqual(currentEvents);
  expect(await ledger.history()).toEqual(currentHistory);
  expect(contentHash((await cache.loadRevision(source.source, archived.bundleHash!))!.bundle)).toBe(oldBundleHash);
  expect(await cache.loadFreshActive(source.source)).toBeNull();
  expect(definition.revisionHash).toBe(frozenDefinitions[0]!.revisionHash);
}, 20_000);

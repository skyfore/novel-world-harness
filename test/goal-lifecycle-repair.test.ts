import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { ActorModelStore, characterGoalSchema } from "../src/world/actors.js";
import { CanonicalModelStore, ProposalStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { contentHash } from "../src/world/canonical.js";
import { evidenceAssertionSchema, type StateOperation } from "../src/world/model.js";
import { prepareCompilerBatches, CompilerBatchStore } from "../src/compiler/batches.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { registerSourceRequirements, settleSourceRequirements } from "../src/compiler/requirement-service.js";
import { EvidenceAssertionStore } from "../src/compiler/evidence-assertions.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { CompilerCommitService } from "../src/compiler/validator.js";
import { discoverUpstreamRepairCommand, finishUpstreamRepairPlanCommand } from "../src/commands/upstream-repair.js";
import { planUpstreamRepair } from "../src/compiler/upstream-repair-planner.js";
import { UpstreamRepairLedger } from "../src/compiler/upstream-repair-ledger.js";
import { stageUpstreamRepair } from "../src/compiler/upstream-repair-staging.js";
import { verifyUpstreamRepairPlan } from "../src/compiler/upstream-repair-preflight.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { upstreamRepairPlanSchema } from "../src/compiler/upstream-repair-plan.js";
import { settleUpstreamRepairRequirements } from "../src/compiler/upstream-repair-evaluation.js";
import { runUpstreamRepairModelSlot } from "../src/compiler/pi-upstream-repair.js";

const roots: string[] = [];
const passage = "The gate opens. Mira waits for the key. Her task ends when Mira holds the key.";
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-goal-repair-"));
  roots.push(root);
  const bytes = Buffer.from(passage);
  const { source, segmentId, evidence } = await createEvidenceFixture(root, passage);
  const canonical = new CanonicalModelStore(root), actors = new ActorModelStore(root);
  for (const [id, kind, name] of [["mira", "character", "Mira"], ["key", "artifact", "key"], ["gate", "location", "gate"]] as const)
    await canonical.putEntity({ id, kind, canonicalName: name, aliases: [], evidence: evidence(name) });
  await new InitialWorldStore(root).put({ version: 1, evidence: evidence("Mira"), delta: { version: 1,
    operations: [{ op: "set", entityId: "mira", field: "character.alive", value: true }] } });
  const batches = await prepareCompilerBatches(root, source);
  await new CompilerBatchStore(root).replaceCompleted(source.id, batches.map(b => b.id));
  const goal = characterGoalSchema.parse({ id: "receive-key", actorId: "mira", description: "Receive the key", priority: 0.8,
    requiresKnowledge: [], activation: { preconditions: [{ op: "fact-equals", entityId: "gate", field: "location.open", value: true }] },
    completion: [{ op: "fact-exists", entityId: "gate", field: "location.open" }], evidence: evidence("Mira waits for the key.") });
  await actors.putGoal(goal);
  const anchor = (quote: string) => textAnchorForByteRange(source.id, bytes, bytes.indexOf(quote), bytes.indexOf(quote) + Buffer.byteLength(quote));
  const original = evidenceAssertionSchema.parse({ version: 1, id: "description-proof", target: { artifactKind: "character-goal",
    artifactId: goal.id, jsonPointer: "/description" }, relation: "supports", strength: "explicit", anchors: [anchor("Mira waits for the key.")],
    derivation: { runId: "earlier-run", worker: "propose_character_goal", ontologyVersion: "evidence-v1" } });
  const oldCompletion = evidenceAssertionSchema.parse({ ...original, id: "old-completion", target: { ...original.target, jsonPointer: "/completion/0" } });
  const proofs = new EvidenceAssertionStore(root);
  await proofs.replaceForArtifact("character-goal", goal.id, contentHash(goal), [original, oldCompletion]);
  const open: StateOperation = { op: "set", entityId: "gate", field: "location.open", value: true };
  const held: StateOperation = { op: "set", entityId: "key", field: "artifact.owner", value: "mira" };
  const test = { id: "delivery", kind: "goal-lifecycle", goalId: goal.id, scene: "At the gate", rationale: "Opening starts the wait; delivery ends it",
    evidence: [anchor("Her task ends when Mira holds the key.")],
    scenarios: [false, true].map(done => ({ label: done ? "key delivered" : "waiting for key", expectedActive: !done, expectedComplete: done,
      seed: { delta: { version: 1, operations: done ? [open, held] : [open] }, elapsedDays: 0 }, knownClaimIds: [], experiencedEventIds: [], realizedEventIds: [] })) };
  const spec = { version: 1, sourceId: source.id, sourceSha256: source.contentSha256, review: { method: "independent-source-review",
    reviewer: "fixture-author", reviewedAt: "2026-11-11T00:00:00Z", auditRef: "gate-source-review" }, cases: [test] };
  const registration = { sourceId: source.id, id: "gate-goals", scopeDecisionRef: "gate-source-review", spec };
  expect((await discoverUpstreamRepairCommand(root, source.id)).goalLifecycleFindings).toEqual([]);
  const definition = await registerSourceRequirements(root, registration);
  const [finding] = (await discoverUpstreamRepairCommand(root, source.id)).goalLifecycleFindings;
  expect(finding?.requirementSetHash).toBe(definition.revisionHash);
  const review = { version: 1, sourceId: source.id, sourceSha256: source.contentSha256, planId: "repair-delivery", batchId: "repair-delivery",
    requirementSetHash: finding!.requirementSetHash, requirementIds: finding!.requirementIds, segmentIds: finding!.sourceSegmentIds,
    citableEvidenceRefs: [segmentId], predecessorReceiptRefs: [], authorizationRef: "reviewed-goal-only", retryBudgetRef: "gate-budget",
    diagnostics: [finding!.diagnostic] };
  const { plan } = await planUpstreamRepair(root, review);
  if (!plan) throw Error("Expected a completion repair");
  const ledger = new UpstreamRepairLedger(root, source.id);
  await ledger.register(plan); await ledger.authorize(plan.planHash);
  const { evidence: _hostEvidence, ...payload } = goal;
  const candidate = { proposal_id: "delivery-revision", payload: { ...payload, completion: [{ op: "fact-equals", entityId: "key", field: "artifact.owner", value: "mira" }] },
    evidence_segment_ids: [segmentId], evidence_selectors: [{ exact: "Mira holds the key", segment_id: segmentId, target_path: "/completion/0", relation: "supports", strength: "explicit" }] };
  const slot = { kind: "character-goal" as const, id: goal.id };
  const stage = (input: unknown) => stageUpstreamRepair(root, source.id, plan.planHash, slot, input);
  const finishFile = path.join(root, "finish.json");
  await fs.writeFile(finishFile, JSON.stringify({ outcome: "complete", reviewed_segments: [{ segment_id: segmentId, disposition: "proposed", summary: "Reviewed the delivery" }], summary: "Completion is independently checked" }));
  return { root, source, actors, goal, original, proofs, registration, definition, review, plan, ledger, candidate, slot, stage, finishFile,
    cache: new PreparedNovelCache(root, path.join(root, "cache")) };
}

it("repairs a failing strict candidate via independently registered cuts, finish, recoverable commit and canonical re-evaluation", async () => {
  const f = await fixture(), { root, source, goal, plan, candidate } = f;
  await expect(f.cache.candidateSnapshot(source)).rejects.toThrow("GOAL_ACTIVE_AND_COMPLETE");
  expect((await settleSourceRequirements(root, source.id)).results[0]?.requirements[0]?.state).toBe("blocked");
  await f.stage(candidate);
  const service = new CompilerCommitService(root);
  expect(await service.accept("character-goal", candidate.proposal_id)).toMatchObject({ accepted: false, errors: [{ code: "GOAL_REPAIR_FINISH_REQUIRED" }] });
  expect((await service.acceptAllValid(source.id)).staging).toContainEqual({ id: candidate.proposal_id, kind: "character-goal" });
  expect(await f.actors.listGoals()).toEqual([goal]);
  const { receipt } = await finishUpstreamRepairPlanCommand(root, source.id, plan.planHash, f.finishFile);
  const fail = vi.spyOn(EvidenceAssertionStore.prototype, "replaceForArtifact").mockRejectedValueOnce(new Error("simulated interruption after goal ref write"));
  await expect(convergeWorldProposals(root, source.id)).rejects.toThrow("simulated interruption");
  fail.mockRestore();
  expect(await f.actors.listGoals()).toEqual([{ ...goal, completion: candidate.payload.completion }]);
  expect((await f.proofs.bindingForArtifact("character-goal", goal.id))?.artifactHash).toBe(contentHash(goal));
  const outcome = await convergeWorldProposals(root, source.id);
  expect(outcome.canonical.accepted).toEqual([{ id: candidate.proposal_id, kind: "character-goal" }]);
  expect(outcome.upstreamRepairIssues ?? []).toEqual([]);
  const binding = await f.proofs.bindingForArtifact("character-goal", goal.id);
  expect(binding?.assertions).toContainEqual(f.original);
  expect(binding?.assertions.map(a => a.id)).not.toContain("old-completion");
  expect(binding?.assertions).toHaveLength(2);
  const bundle = await f.cache.candidateSnapshot(source);
  expect(bundle.canonical.goals).toEqual([{ ...goal, completion: candidate.payload.completion }]);
  expect((await f.ledger.recordEvaluation(plan.planHash)).result.requirements[0]?.state).toBe("satisfied");
  expect((await discoverUpstreamRepairCommand(root, source.id)).goalLifecycleFindings).toEqual([]);
  expect((await convergeWorldProposals(root, source.id)).canonical.accepted).toEqual([]);
  expect((await f.ledger.inspect()).plans[0]?.finishedReceipt).toBe(receipt.fingerprint);
  const archived = await f.cache.archiveCandidate(source);
  const clone = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-goal-checkpoint-"));
  roots.push(clone);
  const cloneSource = (await createEvidenceFixture(clone, passage)).source;
  await new PreparedNovelCache(clone, path.join(root, "cache")).restoreCompilerCheckpoint(cloneSource, archived.bundleHash!);
  expect(await new ActorModelStore(clone).listGoals()).toEqual(bundle.canonical.goals);
  expect(await new EvidenceAssertionStore(clone).bindingForArtifact("character-goal", goal.id)).toEqual(binding);
  const recovered = await finishUpstreamRepairPlanCommand(clone, cloneSource.id, plan.planHash);
  expect(recovered.receipt.fingerprint).toBe(receipt.fingerprint);
}, 30_000);

it.each([
  ["wrong actor", /outside \/completion/], ["other field", /outside \/completion/],
  ["wrong cut", /failed the independent lifecycle cases/], ["outside anchor", /inside a registered lifecycle case anchor/],
  ["missing selector", /evidence|selector/i], ["unrelated selector", /Unrelated goal evidence changed/],
  ["foreign segment", /segment/i], ["weak evidence", /exact supports evidence/],
] as const)("rejects %s before writing the goal proposal", async (kind, reason) => {
  const f = await fixture();
  const c = structuredClone(f.candidate);
  if (kind === "wrong actor") c.payload.actorId = "other";
  if (kind === "other field") c.payload.priority = 0.1;
  if (kind === "wrong cut") c.payload.completion[0]!.value = "key";
  if (kind === "outside anchor") c.evidence_selectors[0]!.exact = "The gate opens";
  if (kind === "missing selector") c.evidence_selectors = [];
  if (kind === "unrelated selector") c.evidence_selectors.push({ ...c.evidence_selectors[0]!, target_path: "/priority" });
  if (kind === "foreign segment") c.evidence_segment_ids = ["another-source-segment"];
  if (kind === "weak evidence") Object.assign(c.evidence_selectors[0]!, { strength: "weak-inference", interpretation: "The passage might imply completion" });
  await expect(f.stage(c)).rejects.toThrow(reason);
  expect(await new ProposalStore(f.root).list("pending", f.source.id)).toEqual([]);
  expect(await f.actors.listGoals()).toEqual([f.goal]);
});

it("keeps old plan capabilities closed and rejects a changed actor, predecessor or registered specification", async () => {
  const f = await fixture();
  await expect(planUpstreamRepair(f.root, { ...f.review, diagnostics: [{ ...f.review.diagnostics[0], goalId: "other-goal" }] })).rejects.toThrow("single current predecessor");
  await expect(planUpstreamRepair(f.root, { ...f.review, sourceSha256: "0".repeat(64) })).rejects.toThrow("source revision");
  const { goalLifecycle: _scope, planHash: _hash, ...without } = f.plan;
  expect(upstreamRepairPlanSchema.safeParse({ ...without, planHash: contentHash(without) }).success).toBe(false);
  await f.actors.putGoal({ ...f.goal, priority: 0.3 });
  await expect(verifyUpstreamRepairPlan(f.root, f.plan)).rejects.toThrow(/stale exact-evidence binding|Active dependency changed/);
  await f.actors.putGoal(f.goal);
  await f.stage(f.candidate);
  await registerSourceRequirements(f.root, { ...f.registration, predecessorRevision: f.definition.revisionHash, scopeDecisionRef: "revised-evidence",
    spec: { ...f.registration.spec, review: { ...f.registration.spec.review, auditRef: "revised-evidence" } } });
  await expect(finishUpstreamRepairPlanCommand(f.root, f.source.id, f.plan.planHash, f.finishFile)).rejects.toThrow(/no longer active|revision/);
  expect(await f.actors.listGoals()).toEqual([f.goal]);
});

it("settles the repaired goal from an isolated typed slot while a different goal still blocks the strict candidate", async () => {
  const f = await fixture();
  const other = { ...f.goal, id: "other-invalid-goal" };
  await f.actors.putGoal(other);
  await runUpstreamRepairModelSlot(f.root, f.source.id, f.plan.planHash, f.slot, {}, async options => ({
    dispose: async () => {},
    promptWithReport: async prompt => {
      const tools = options.additionalTools!;
      expect(tools.map(t => t.name)).toEqual(["read_upstream_repair_context", "propose_character_goal"]);
      const { context, proposalId } = JSON.parse(prompt);
      expect(context.completionEvidenceRanges).toEqual(f.definition.spec.cases[0]!.evidence);
      const input = { proposal_json: JSON.stringify({ ...f.candidate, proposal_id: proposalId }) };
      const submit = tools[1]!;
      await submit.execute("goal-call", submit.prepareArguments!(input) as never, undefined, undefined, {} as never);
      return {} as never;
    },
  }));
  await finishUpstreamRepairPlanCommand(f.root, f.source.id, f.plan.planHash, f.finishFile);
  await convergeWorldProposals(f.root, f.source.id);
  const { results, issues } = await settleUpstreamRepairRequirements(f.root, f.source.id);
  expect(results[0]?.result.requirements).toMatchObject([{ id: "delivery:case-validation", state: "satisfied" }]);
  expect(issues.some(i => i.includes("GOAL_ACTIVE_AND_COMPLETE") && i.includes(other.id))).toBe(true);
  await expect(f.cache.candidateSnapshot(f.source)).rejects.toThrow(other.id);
  expect((await f.ledger.inspect()).modelSessions).toHaveLength(1);
}, 30_000);

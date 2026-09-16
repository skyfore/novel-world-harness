import { assertReconciliationDeferralsReviewed, reviewReconciliationDeferrals } from "../src/compiler/reconciliation-review-ledger.js";
import { ActorModelStore } from "../src/world/actors.js";
import { InitialWorldStore } from "../src/world/initial.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { reconciliationReviewIssues, reconciliationAuditResults, reconciliationDeferredRequirementIds } from "../src/compiler/reconciliation-review.js";
import { buildWorldReconciliationPrompt, reconciliationReviewTargets } from "../src/compiler/reconcile-world.js";
import { auditCompiler } from "../src/compiler/audit.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { CompilerFinishReceipts } from "../src/compiler/finish-receipts.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { writeKnowledgeRepairPlan } from "../src/compiler/knowledge-repair.js";
import { worldStorageRoot } from "../src/world/paths.js";
import { contentHash } from "../src/world/canonical.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const review = { target: "event:arrival", disposition: "proposed" as const, evidence_segment_ids: ["segment"], summary: "Time repaired; effect remains unsupported." };
it("does not let a goal proposal account for ontology or hide partial repair in a summary", () => {
  const target = "character:hero", requirements = [
    { id: `${target}:ontology`, target, capability: "ontology" as const },
    { id: `${target}:opening-driver`, target, capability: "opening-driver" as const },
  ];
  const proposals = new Map([["goal", { kind: "character-goal", payload: { actorId: "hero", candidateAction: { proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "wait" }] } } } }]]);
  const root = { ...review, target, summary: "Goal proposed; ontology still unsupported" };
  expect(reconciliationReviewIssues([target], [root], proposals, requirements).join()).toContain("Account exactly once for requirement");
  const reports = requirements.map(item => ({ requirementId: item.id, disposition: "proposed" as const, summary: "Attempted repair" }));
  expect(reconciliationReviewIssues([target], [{ ...root, requirement_reviews: reports }], proposals, requirements).join()).toContain(`${target}:ontology: proposed requires`);
  const partial = { ...root, requirement_reviews: [{ ...reports[0]!, disposition: "capability-gap" as const }, reports[1]!] };
  expect(reconciliationReviewIssues([target], [partial], proposals, requirements)).toEqual([]);
  expect(reconciliationDeferredRequirementIds([partial])).toEqual([`${target}:ontology`]);
  expect(reconciliationReviewIssues([target], [{ ...partial, requirement_reviews: [...partial.requirement_reviews, partial.requirement_reviews[0]!] }], proposals, requirements).join()).toContain("exactly once");
  expect(reconciliationReviewIssues([target], [{ ...partial, requirement_reviews: [...partial.requirement_reviews, { requirementId: "another:capability", disposition: "capability-gap", summary: "foreign" }] }], proposals, requirements).join()).toContain("outside this target");
});
it("rejects missing, duplicate, foreign and unbacked target reports", () => {
  const proposals = new Map([["p", { kind: "canonical-event", payload: { id: "arrival" } }]]);
  expect(reconciliationReviewIssues(["event:arrival", "character:hero"], [review], proposals)).toEqual(["Account exactly once for target character:hero."]);
  expect(reconciliationReviewIssues(["event:arrival"], [review, review], proposals)).not.toEqual([]);
  expect(reconciliationReviewIssues(["character:hero"], [{ ...review, target: "character:hero" }], proposals).join()).toContain("requires an active proposal");
  expect(reconciliationReviewIssues(["event:arrival"], [review], new Map()).join()).toContain("requires an active proposal");
  expect(reconciliationReviewIssues(["event:arrival"], [{ ...review, disposition: "unsupported" }], proposals).join()).toContain("active proposals require");
  expect(reconciliationReviewIssues(["event:arrival"], [review], proposals)).toEqual([]);
});

it("requires every planned target at real finish, freezes deferrals in the receipt, and keeps audit gaps unresolved", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-target-review-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero arrives.");
  const canon = new CanonicalModelStore(root);
  await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") });
  await canon.putEvent({ id: "arrival", title: "Hero arrives", participants: ["hero"], participantPresence: [{ entityId: "hero", mode: "physical" }], storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [] }, evidence: fixture.evidence("Hero arrives."), causalParents: [], confidence: 1 });
  await new ActorModelStore(root).putModel({ actorId: "hero", traits: {}, decisionBiases: {}, evidence: fixture.evidence("Hero") });
  await new InitialWorldStore(root).put({ version: 1, delta: { version: 1, operations: [] }, evidence: fixture.evidence("Hero arrives."), checkpoint: { mode: "chronological", storyTime: { kind: "ordinal", label: "Opening", orderHint: 0 }, rationale: "Opening" } });
  const audit = await auditCompiler(root, { sourceId: fixture.source.id });
  const namespace = "target-review-test";
  const prompt = await buildWorldReconciliationPrompt(root, fixture.source.id, { ...audit, coverage: { ...audit.coverage, autonomousDriverCoverage: 0 }, semanticRepairTargets: { ...audit.semanticRepairTargets, characterIds: ["hero"] } }, 1, { proposalIdSuffixTail: namespace });
  const context = JSON.parse(prompt.match(/<reconciliation-context>\n([\s\S]+)\n<\/reconciliation-context>/u)![1]!);
  expect(context.weakCharacterCandidates[0]).toMatchObject({ needsExecutableDriver: true, needsOntologyMigration: true, requiredOntologyVersion: "character-v1" });
  expect(context.openingDriverContext).toMatchObject({ readOnly: true, ref: "canonical:initial-world:singleton", storyTime: { orderHint: 0 }, delta: { operations: [] } });
  const batch = `reconcile-${fixture.source.id}-bounded-${namespace}-1`;
  const targets = (await reconciliationReviewTargets(root, fixture.source.id, batch))!;
  expect(targets).toContain("event:arrival");
  const toolset = createCompilerProposalToolset(root);
  await toolset.beginBatch([], batch, fixture.source.id);
  const finish = toolset.tools.find(tool => tool.name === "finish_compiler_batch")!;
  const call = (input: unknown) => finish.execute("finish", input as never, undefined, undefined, {} as never);
  const input = { outcome: "no-artifacts", reviewed_segments: [], summary: "Insufficient source for typed effects." };
  await expect(call(input)).rejects.toThrow("Account exactly once");
  expect(await new CompilerFinishReceipts(root, fixture.source.id, batch).read()).toBeUndefined();
  const reports = targets.map(target => ({ target, disposition: "capability-gap" as const, evidence_segment_ids: [fixture.segmentId], summary: "The cited arrival text does not name a location; the missing location must be reviewed by the host.",
    requirement_reviews: context.repairPlan.requirements.filter((item: { target: string }) => item.target === target).map((item: { id: string }) => ({ requirementId: item.id, disposition: "capability-gap", summary: "Requires independent source review" })),
  }));
  const result = await call({ ...input, target_reviews: reports });
  expect(JSON.stringify(result)).toContain('"compilerBatchFinished":true');
  const receipt = await new CompilerFinishReceipts(root, fixture.source.id, batch).read();
  expect(receipt?.identity.input.target_reviews).toEqual(reports);
  expect(receipt?.identity.version).toBe(2);
  expect(receipt?.identity.requirementScope?.requirements).toEqual(context.repairPlan.requirements);
  await new CompilerFinishReceipts(root, fixture.source.id, batch).verify(receipt!);
  const supplement = `reconcile-${fixture.source.id}-knowledge-effects-supplement`;
  const plan = { version: 1 as const, sourceId: fixture.source.id, batchId: supplement, predecessorBatchId: batch, predecessorFingerprint: receipt!.fingerprint, reviewRef: "host-test-review", events: await canon.listEvents() };
  await expect(writeKnowledgeRepairPlan(root, { ...plan, predecessorFingerprint: "0".repeat(64) })).rejects.toThrow("original completed receipt");
  await writeKnowledgeRepairPlan(root, plan);
  await expect(writeKnowledgeRepairPlan(root, plan)).rejects.toThrow("EEXIST");
  expect(await reconciliationReviewTargets(root, fixture.source.id, supplement)).toEqual(["event:arrival"]);
  const supplementaryTools = createCompilerProposalToolset(root);
  await supplementaryTools.beginBatch([], supplement, fixture.source.id);
  const invoke = (name: string, input: unknown) => supplementaryTools.tools.find(tool => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
  await invoke("propose_claim", { proposal_id: "orphan", payload: { id: "orphan", subject: "hero", predicate: "arrives", object: true, epistemicType: "explicit-fact" }, evidence_segment_ids: [fixture.segmentId] });
  await expect(invoke("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Unrelated claim", target_reviews: reports.filter(r => r.target === "event:arrival") })).rejects.toThrow("not reachable");
  expect(await new CompilerFinishReceipts(root, fixture.source.id, supplement).read()).toBeUndefined();
  expect((await new CompilerFinishReceipts(root, fixture.source.id, batch).read())?.fingerprint).toBe(receipt!.fingerprint);
  await invoke("propose_proposition", { proposal_id: "arrival-content", payload: { id: "arrival-content", subjectEntityId: "hero", relationId: "arrives", object: { kind: "literal", value: true }, polarity: "positive", modality: "asserted" }, evidence_segment_ids: [fixture.segmentId] });
  const { evidence: _eventEvidence, ...eventPayload } = plan.events[0]!;
  await invoke("propose_canonical_event", { proposal_id: "arrival-knowledge", evidence_segment_ids: [fixture.segmentId], payload: { ...eventPayload, observedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "hero", claimId: "orphan", propositionId: "arrival-content", acquisitionMode: "observed", status: "knows", confidence: 1 }] } } });
  await expect(invoke("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Source-backed acquisition with reachable dependencies", target_reviews: [{ ...review, evidence_segment_ids: [fixture.segmentId] }] })).resolves.toBeDefined();
  expect((await new CompilerFinishReceipts(root, fixture.source.id, supplement).read())?.state).toBe("completed");
  await expect(assertReconciliationDeferralsReviewed(root, fixture.source.id)).rejects.toThrow("host source review");
  const focused = await buildWorldReconciliationPrompt(root, fixture.source.id, { ...audit, coverage: { ...audit.coverage, autonomousDriverCoverage: 0 } }, 1, { proposalIdSuffixTail: "opening-only", focus: "opening-driver" });
  const focusedContext = JSON.parse(focused.match(/<reconciliation-context>\n([\s\S]+)\n<\/reconciliation-context>/u)![1]!);
  expect(focusedContext.repairPlan.reviewTargets).toEqual(["character:hero"]);
  expect(focusedContext).not.toHaveProperty("initialWorld");
  expect(focusedContext.openingDriverContext.readOnly).toBe(true);
  expect(await reconciliationReviewTargets(root, fixture.source.id, batch)).toEqual(targets);
  await expect(assertReconciliationDeferralsReviewed(root, fixture.source.id)).rejects.toThrow("host source review");

  const decision = { sourceId: fixture.source.id, batchId: batch, finishFingerprint: receipt!.fingerprint, reviewedAt: new Date().toISOString(), reviews: reconciliationDeferredRequirementIds(reports).map(target => ({ target, reason: "Host reviewed immutable evidence; no invented effects authorized.", auditRef: "test-audit" })) };
  await expect(reviewReconciliationDeferrals(root, { ...decision, reviews: [] })).rejects.toThrow("every deferred target");
  await reviewReconciliationDeferrals(root, decision);
  await expect(assertReconciliationDeferralsReviewed(root, fixture.source.id)).resolves.toBeUndefined();
  const results = reconciliationAuditResults(targets, reports, audit);
  expect(results.find(result => result.target === "event:arrival")).toMatchObject({ status: "unresolved", hostReviewRequired: true });
  expect(reconciliationAuditResults(targets, [{ ...review, evidence_segment_ids: [fixture.segmentId] }], audit)[0]?.status).toBe("unresolved");
});

it("freezes capability-level partial success through finish, restart, plan reuse and host review", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-partial-capability-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero arrives. Hero waits for a signal.");
  const canon = new CanonicalModelStore(root);
  await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") });
  await canon.putEvent({ id: "arrival", title: "Hero arrives", participants: ["hero"], participantPresence: [{ entityId: "hero", mode: "physical" }], storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [] }, evidence: fixture.evidence("Hero arrives."), causalParents: [], confidence: 1 });
  await new ActorModelStore(root).putModel({ actorId: "hero", traits: {}, decisionBiases: {}, evidence: fixture.evidence("Hero") });
  const audit = await auditCompiler(root, { sourceId: fixture.source.id });
  const request = { ...audit, coverage: { ...audit.coverage, autonomousDriverCoverage: 0 as const }, semanticRepairTargets: { ...audit.semanticRepairTargets, characterIds: ["hero"] } };
  const namespace = "partial";
  const prompt = await buildWorldReconciliationPrompt(root, fixture.source.id, request, 1, { proposalIdSuffixTail: namespace });
  const context = JSON.parse(prompt.match(/<reconciliation-context>\n([\s\S]+)\n<\/reconciliation-context>/u)![1]!);
  const batchId = `reconcile-${fixture.source.id}-bounded-${namespace}-1`;
  const tools = createCompilerProposalToolset(root);
  await tools.beginBatch([], batchId, fixture.source.id);
  const call = (name: string, input: unknown) => tools.tools.find(tool => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
  await call("propose_character_goal", { proposal_id: "wait-for-signal", payload: { id: "wait-for-signal", actorId: "hero", description: "Hero waits for a signal", priority: 1, requiresKnowledge: [] }, evidence_segment_ids: [fixture.segmentId] });
  const reports = context.repairPlan.reviewTargets.map((target: string) => ({ target, disposition: target === "character:hero" ? "proposed" as const : "capability-gap" as const,
    evidence_segment_ids: [fixture.segmentId], summary: "A static goal is proposed; other capabilities need review",
    requirement_reviews: context.repairPlan.requirements.filter((item: { target: string }) => item.target === target).map((item: { id: string }) => ({ requirementId: item.id, disposition: "capability-gap" as const, summary: "No supported migration or executable driver yet" })),
  }));
  const input = { outcome: "complete", reviewed_segments: [], summary: "Partial repair", target_reviews: reports };
  await call("finish_compiler_batch", input);
  const receipts = new CompilerFinishReceipts(root, fixture.source.id, batchId), receipt = (await receipts.read())!;
  expect(receipt.identity.requirementScope?.requirements).toEqual(context.repairPlan.requirements);
  expect(reconciliationDeferredRequirementIds(receipt.identity.input.target_reviews!)).toContain("character:hero:ontology");
  expect(reconciliationDeferredRequirementIds(receipt.identity.input.target_reviews!)).toContain("character:hero:opening-driver");
  await expect(assertReconciliationDeferralsReviewed(root, fixture.source.id)).rejects.toThrow("character:hero:ontology");
  const improved = { ...request, coverage: { ...request.coverage, autonomousDriverCoverage: 1 }, semanticRepairTargets: { ...request.semanticRepairTargets, characterIds: [] } };
  const resumed = await buildWorldReconciliationPrompt(root, fixture.source.id, improved, 1, { proposalIdSuffixTail: namespace });
  const resumedContext = JSON.parse(resumed.match(/<reconciliation-context>\n([\s\S]+)\n<\/reconciliation-context>/u)![1]!);
  expect(resumedContext.repairPlan.requirements).toEqual(context.repairPlan.requirements);
  expect(resumedContext.weakCharacterCandidates[0]).toMatchObject({ needsExecutableDriver: true, needsOntologyMigration: true });
  await receipts.verify(receipt);
  const planPath = path.join(worldStorageRoot(root), "compiler", "reconciliation", `${fixture.source.id}.${contentHash(namespace).slice(0, 24)}.json`);
  const originalPlan = await fs.readFile(planPath, "utf8");
  await fs.writeFile(planPath, JSON.stringify({ ...JSON.parse(originalPlan), createdAt: "2026-01-01T00:00:00Z" }));
  await expect(receipts.verify(receipt)).rejects.toThrow("requirement definition or plan changed");
  await fs.writeFile(planPath, originalPlan);
  const reviewBase = { sourceId: fixture.source.id, batchId, finishFingerprint: receipt.fingerprint, reviewedAt: new Date().toISOString() };
  await expect(reviewReconciliationDeferrals(root, { ...reviewBase, reviews: [{ target: "character:hero", reason: "Whole target reviewed", auditRef: "review" }] })).rejects.toThrow("every deferred target");
  await reviewReconciliationDeferrals(root, { ...reviewBase, reviews: reconciliationDeferredRequirementIds(receipt.identity.input.target_reviews!).map(target => ({ target, reason: "Source does not authorize inventing the missing capability", auditRef: `review:${target}` })) });
  await expect(assertReconciliationDeferralsReviewed(root, fixture.source.id)).resolves.toBeUndefined();
  const status = reconciliationAuditResults(context.repairPlan.reviewTargets, reports, improved).find(item => item.target === "character:hero");
  expect(status?.hostReviewRequired).toBe(true);
});

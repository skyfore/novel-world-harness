import { expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { decodeJsonValues } from "../src/agent/lossless-json-context.js";
import { mockPiProvider } from "./helpers/pi-provider.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { identityRequirementDirectory } from "../src/compiler/identity-requirements.js";
import { consumerRevalidationDirectory } from "../src/compiler/identity-consumer-revalidation-model.js";
import * as revalidation from "../src/compiler/identity-consumer-revalidation.js";
import * as retainedState from "../src/compiler/identity-consumer-repair.js";
import { runIdentityConsumerRevalidation } from "../src/workflow/identity-consumer-revalidation.js";
import { identityFixture } from "./helpers/identity-fixture.js";
import { contentHash as h } from "../src/world/canonical.js";
import { consumerRevalidationScopeSchema, consumerRevalidationId, validateConsumerRevalidationHistory, validateConsumerCorrectionLineage, type ConsumerRevalidationRecord } from "../src/compiler/identity-consumer-revalidation-model.js";
import { assertUpstreamRepairMutation, freezeUpstreamRepairPlan } from "../src/compiler/upstream-repair-plan.js";
import { initialWorldRepairReferences } from "../src/compiler/initial-world-repair.js";
import { identityReviewStatus } from "../src/compiler/identity-review-status.js";
import { identityReviewStatuses, inspectIdentityReviewStatuses } from "../src/compiler/identity-repair-handoff.js";
import { assertConsumerCompilerCorrection, assertConsumerCorrectionSlot, consumerRevalidationLimits, SOURCE_LOCAL_CORRECTION, sourceLocalContractHash } from "../src/compiler/identity-consumer-correction.js";
import { IDENTITY_REQUIREMENT_LIMITS } from "../src/compiler/identity-requirements.js";
import { captureRecordTree } from "../src/runtime/compile-loop/dedicated-session.js";
import { consumerStageRecoveryDirectory } from "../src/compiler/identity-consumer-stage-recovery.js";
import { TraceStore } from "../src/trace/store.js";
import { appendUnrelatedTraceHistory } from "./helpers/trace-history.js";
import { workspaceStateDir } from "../src/agent/runtime-paths.js";
import { inspectConsumerRevalidationAttempts } from "../src/compiler/identity-consumer-attempt-status.js";
import * as revalidationModel from "../src/compiler/identity-consumer-revalidation-model.js";
import { CompilerFinishReceipts } from "../src/compiler/finish-receipts.js";
import { UpstreamRepairLedger } from "../src/compiler/upstream-repair-ledger.js";
import { consumerDependencyCatalog, consumerArtifactPages } from "../src/compiler/identity-consumer-artifacts.js";
import * as readContract from "../src/compiler/identity-consumer-read-contract.js";
import { consumerHostRecoveryDirectory, oldSourceSearchError } from "../src/compiler/identity-consumer-host-recovery.js";
import { assertConsumerRevalidationPrefix } from "../src/compiler/identity-consumer-revalidation-model.js";
import { consumerWorkDirectory } from "../src/compiler/consumer-work-plan.js";
import * as workPlans from "../src/compiler/consumer-work-plan.js";
import { bindingRecoveryDirectory } from "../src/compiler/consumer-review-binding.js";
import { CONSUMER_REVIEW_CORRECTION, deriveConsumerReviewContract } from "../src/compiler/consumer-review-contract.js";
import { canonicalEventSchema } from "../src/world/model.js";
import * as upstreamSession from "../src/compiler/identity-upstream-session.js";
import { prerequisiteStop } from "../src/compiler/role-source-prerequisites.js";
import { verifyIdentitySessionEvidence } from "../src/compiler/identity-session-integrity.js";
import { CONSUMER_EVIDENCE_COVERAGE } from "../src/compiler/consumer-evidence-coverage.js";

it("keeps a stopped review's exact journal prefix across sibling reviews but rejects unrelated changes", () => {
  const { proposal, check } = fixture(), history: any[] = [{ hash: h("original prefix"), payload: { kind: "identity-requirements" } }];
  const scope = { ...proposal.scope, requirementPrefix: { length: 1, head: history[0].hash } };
  expect(() => assertConsumerRevalidationPrefix(history, scope)).not.toThrow();
  for (const record of [proposal, check]) history.push({ hash: h(record), payload: { kind: "identity-consumer-revalidation", record } });
  const before = h(history);
  expect(() => assertConsumerRevalidationPrefix(history, scope)).not.toThrow();
  expect(h(history)).toBe(before);
  for (const mutate of [
    (s: typeof scope, _h: any[]) => { s.requirementPrefix.head = h("different prefix"); },
    (s: typeof scope, _h: any[]) => { s.requirementPrefix.length = 4; },
    (_s: typeof scope, h: any[]) => { h[1].payload.record.scope.taskId = "f".repeat(64); },
    (_s: typeof scope, h: any[]) => { h[1].payload.record.scope.identityIntentHash = "f".repeat(64); },
    (_s: typeof scope, h: any[]) => { h[1].payload.kind = "identity-consumer-repair"; },
  ]) {
    const s = structuredClone(scope), records = structuredClone(history); mutate(s, records);
    expect(() => assertConsumerRevalidationPrefix(records, s)).toThrow(/ledger prefix/);
  }
  expect(() => assertConsumerRevalidationPrefix(history, { ...scope, requirementPrefix: { length: 3, head: history[2].hash } }, 2)).toThrow(/ledger prefix/);
});

it("rejects an invalid prospective review journal before publishing or changing its head", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-consumer-journal-publication-"));
  try {
    const f = fixture(), ledger = new RequirementLedger(root, "src");
    await ledger.registerRoleQuestions([{ questionId: h("question"), planHash: h("plan"), page: 0, text: "Who is Ada?", sourceUnitIds: ["unit"], impact: "critical" }]);
    const history = await ledger.history(), before = captureRecordTree(workspaceStateDir(root));
    f.proposal.scope.requirementPrefix = { length: history.length, head: history.at(-1)!.hash };
    f.proposal.output.scopeHash = h(f.proposal.scope);
    vi.spyOn(RequirementLedger.prototype, "identityRequirements").mockResolvedValue(f.original);
    vi.spyOn(revalidation, "verifyConsumerRevalidationRecord").mockResolvedValue();
    // The proposal/session validator alone cannot establish the journal's
    // independent definition history. The complete prospective chain must pass.
    await expect(ledger.recordIdentityConsumerRevalidation(f.proposal)).rejects.toThrow(/original task/);
    expect(captureRecordTree(workspaceStateDir(root))).toEqual(before);
    expect(await ledger.history()).toEqual(history);
  } finally { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); }
});

it("inherits failed and continued review charges once across a typed successor", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-review-charges-"));
  try {
    const reviews = path.join(root, "reviews"), upstream = path.join(reviews, "corrected", "upstream"), old = path.join(reviews, "old");
    await fs.mkdir(upstream, { recursive: true }); await fs.mkdir(old, { recursive: true });
    const originalBudgetHash = h("original budget"), files: Array<{ path: string; hash: string }> = [];
    const put = async (file: string, calls: number) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const value = { originalBudgetHash, state: { usage: { modelCalls: calls, totalPayloadBytes: calls * 100 } } };
      await fs.writeFile(file, JSON.stringify(value)); return { path: file, hash: h(value) };
    };
    files.push(await put(path.join(old, "consumer-revalidation.budget.json"), 16));
    files.push(await put(path.join(consumerStageRecoveryDirectory(old, "consumer-revalidation"), "consumer-revalidation.budget.json"), 4));
    files.push(await put(path.join(old, "presence-repair", "entry-presence-proposal.budget.json"), 2));
    files.push(await put(path.join(old, "state-repair", "entry-state-proposal.budget.json"), 2));
    files.push(await put(path.join(old, "wording-repair", "entry-state-proposal.budget.json"), 2));
    files.push(await put(path.join(old, "delta-binding-repair", "entry-state-proposal.budget.json"), 2));
    await fs.writeFile(path.join(upstream, "start.json"), JSON.stringify({ origin: { originalBudgetHash, priorUsage: { modelCalls: 216, totalPayloadBytes: 21600 }, budgetFiles: files }, order: [{ id: "entity" }, { id: "singleton" }] }));
    for (const stage of ["entity", "singleton", "acceptance"]) await put(path.join(upstream, `${stage}.budget.json`), 2);
    await put(path.join(reviews, "other", "consumer-revalidation-check.budget.json"), 3);
    await put(path.join(consumerHostRecoveryDirectory(path.join(reviews, "other")), "consumer-revalidation.budget.json"), 2);
    await put(path.join(consumerStageRecoveryDirectory(consumerHostRecoveryDirectory(path.join(reviews, "other")), "consumer-revalidation"), "consumer-revalidation.budget.json"), 3);
    await put(path.join(reviews, "other", "presence-repair", "entry-presence-check.budget.json"), 3);
    await put(path.join(reviews, "other", "state-repair", "entry-state-check.budget.json"), 2);
    await put(path.join(reviews, "other", "wording-repair", "entry-state-check.budget.json"), 2);
    await put(path.join(reviews, "other", "delta-binding-repair", "entry-state-check.budget.json"), 2);
    const result = await revalidation.inheritConsumerRevalidationBudgets(upstream, reviews);
    expect(result.priorUsage).toEqual({ modelCalls: 239, totalPayloadBytes: 23900 });
    expect(result.priorBudgetFiles.filter(f => f.path === files[5]!.path)).toEqual([files[5]]);
    expect(result.priorBudgetFiles.filter(f => f.path === files[4]!.path)).toEqual([files[4]]);
    expect(result.priorBudgetFiles.filter(f => f.path === files[3]!.path)).toEqual([files[3]]);
    expect(result.priorBudgetFiles.filter(f => f.path === files[2]!.path)).toEqual([files[2]]);
    expect(result.priorBudgetFiles.filter(f => f.path === files[1]!.path)).toEqual([files[1]]);
    await put(files[0]!.path, 0);
    await expect(revalidation.inheritConsumerRevalidationBudgets(upstream, reviews)).rejects.toThrow(/Inherited Pi budget changed/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

function fixture() {
  const f = identityFixture(), original = f.records.slice(0, 2);
  f.intent.consumerShards[0]!.refs[0] = "initial/src";
  for (const [i, r] of original.entries()) {
    r.output.intentHash = h(f.intent);
    if ("proposalHash" in r.output) r.output.proposalHash = h(original[0]!.output);
    r.predecessorRecordHash = i ? h(original[i - 1]) : null;
  }
  const scope = consumerRevalidationScopeSchema.parse({ version: 1, sourceId: "src", sourceHash: f.intent.sourceHash, taskId: f.intent.taskId,
    identityIntentHash: h(f.intent), inventoryHash: f.intent.inventoryHash, definitionHash: h(original[0]!.output), requirementIds: f.intent.targets.map(t => t.requirementId),
    ref: "initial/src", originalRevisionHash: h("old"), currentRevisionHash: h("current"), upstreamPlanHash: h("accepted plan"), receiptFingerprint: h("completed receipt"),
    acceptanceHash: h("independent Pi acceptance"), parentStateHash: f.intent.parentStateHash, originalBudgetHash: f.intent.originalBudgetHash,
    authorizationRef: "continue the original task", priorUsage: { modelCalls: 177, totalPayloadBytes: 41204360 }, priorBudgetFiles: [{ path: "/tmp/original-budget", hash: h("original-budget") }],
    requirementPrefix: { length: 20, head: h("original ledger") } });
  const proposal: ConsumerRevalidationRecord = { scope, inputHash: h("input"), predecessorRecordHash: null, sessionId: "new-review", traceRunId: "review-trace", sessionCheckpointHash: h("sealed-review"), evidence: original[0]!.evidence,
    output: { phase: "consumer-revalidation", scopeHash: h(scope), requirementIds: scope.requirementIds, evidence: [{ segment_id: "seg", exact: "Ada waits." }],
      ref: scope.ref, currentRevisionHash: scope.currentRevisionHash, disposition: "repair-required", rationale: "An existing consumer still uses quarantined identity",
      requirements: scope.requirementIds.map(id => ({ id, verdict: "blocked", rationale: "Consumer not yet repaired" })),
      initialWorldRepair: { pointers: ["/delta"], readableRefs: [{ kind: "initial-world", id: "singleton", revisionHash: scope.currentRevisionHash }], segmentIds: ["seg"], requiredAction: "Repair only the original evidence-backed opening" },
      retainedQuestionIds: f.inventory.originalQuestionIds, parentResumeAllowed: false } };
  const check: ConsumerRevalidationRecord = { ...proposal, predecessorRecordHash: h(proposal), sessionId: "independent-check", traceRunId: "check-trace",
    output: { phase: "consumer-revalidation-check", scopeHash: h(scope), requirementIds: scope.requirementIds, evidence: proposal.output.evidence,
      proposalHash: h(proposal.output), verdict: "supported", rationale: "Supported repair scope, not resolved questions or activation" } };
  return { f, original, proposal, check };
}

it("binds a changed-dependency consumer review to the original criteria and distinct independent sessions", () => {
  const { original, proposal, check } = fixture(), before = h(original);
  expect(() => validateConsumerRevalidationHistory([proposal, check], original)).not.toThrow();
  for (const mutate of [
    (r: ConsumerRevalidationRecord[]) => { r[0]!.scope.inventoryHash = h("shrunk denominator"); },
    (r: ConsumerRevalidationRecord[]) => { r[0]!.scope.requirementIds.pop(); },
    (r: ConsumerRevalidationRecord[]) => { r[1]!.sessionId = r[0]!.sessionId; },
    (r: ConsumerRevalidationRecord[]) => { r[0]!.scope.originalBudgetHash = h("reset"); },
    (r: ConsumerRevalidationRecord[]) => { if (r[0]!.output.phase === "consumer-revalidation") r[0]!.output.initialWorldRepair!.pointers = ["/delta/operations/0"]; },
    (r: ConsumerRevalidationRecord[]) => { if (r[0]!.output.phase === "consumer-revalidation") r[0]!.output.disposition = "revalidated"; },
  ]) { const r = structuredClone([proposal, check]); mutate(r); expect(() => validateConsumerRevalidationHistory(r, original)).toThrow(); }
  expect(h(original)).toBe(before);
});

it("reports an independently supported block without replacing original progress or granting source-audit continuation", () => {
  const { original, proposal, check } = fixture();
  if (proposal.output.phase !== "consumer-revalidation" || check.output.phase !== "consumer-revalidation-check") throw Error("fixture");
  proposal.output.disposition = "blocked"; proposal.output.initialWorldRepair = null;
  check.predecessorRecordHash = h(proposal); check.output.proposalHash = h(proposal.output);
  const originalStatus = identityReviewStatus(original), before = h({ original, proposal, check });
  const history = [...original.map(record => ({ payload: { kind: "identity-requirements", record } })),
    ...[proposal, check].map(record => ({ payload: { kind: "identity-consumer-revalidation", record } }))];
  const status = identityReviewStatuses(history as any)[0]!;
  expect(status).toMatchObject({ totalConsumers: originalStatus.totalConsumers, recordedReviewedConsumers: originalStatus.recordedReviewedConsumers,
    recordedGlobalRepairSupport: false, parentResumeAllowed: false,
    consumerRevalidation: { totalConsumers: originalStatus.totalConsumers, recordedReviewedConsumers: 1, recordedClearedConsumers: 0,
      unrecordedConsumers: originalStatus.totalConsumers - 1, blockedRefs: [proposal.scope.ref], sourceAuditResumeAllowed: false,
      reviews: [{ status: "blocked", disposition: "blocked", independentVerdict: "supported", initialWorldRepair: null }] } });
  expect(identityReviewStatus(original, [proposal]).consumerRevalidation).toMatchObject({ recordedReviewedConsumers: 0, recordedClearedConsumers: 0,
    reviews: [{ status: "awaiting-independent-check" }] });
  expect(h({ original, proposal, check })).toBe(before);
});

it("requires a later authorized, one-time scope correction of an exact independently blocked legacy entry", () => {
  const { proposal, check } = fixture();
  if (proposal.output.phase !== "consumer-revalidation" || check.output.phase !== "consumer-revalidation-check") throw Error("fixture");
  proposal.scope.ref = "entry/ada/later"; proposal.scope.executionPolicy = "consumer-work/v1";
  proposal.output.disposition = "blocked"; proposal.output.initialWorldRepair = null;
  const prior = [proposal, check], before = h(prior);
  const scope = { ...proposal.scope, authorizationRef: "User authorized exact review-scope contract correction", reviewContract: {
    version: "consumer-review/v2" as const, ref: proposal.scope.ref, currentRevisionHash: proposal.scope.currentRevisionHash,
    target: { kind: "character-entry" as const, actorId: "ada", beforeEventId: "later", storyTime: { kind: "unknown" as const }, position: "before-event" as const },
    ownerRefs: [], requiredChecks: ["temporal-boundary" as const], originalRequirements: "consumer-dependency-compatibility" as const, globalIdentityQuestions: "retained" as const },
    compilerCorrection: { policy: CONSUMER_REVIEW_CORRECTION, predecessorId: consumerRevalidationId(proposal.scope), predecessorScopeHash: h(proposal.scope),
      predecessorRecordHashes: prior.map(h) as [string, string], contractHash: h("bound implementation") } };
  expect(() => validateConsumerCorrectionLineage(scope, prior)).not.toThrow();
  for (const mutate of [
    (s: typeof scope) => { s.authorizationRef = proposal.scope.authorizationRef; },
    (s: typeof scope) => { s.currentRevisionHash = h("new evidence"); },
    (s: typeof scope) => { s.compilerCorrection.predecessorRecordHashes[0] = h("replacement verdict"); },
    (s: typeof scope) => { s.ref = "initial/src"; },
    (s: typeof scope) => { s.compilerCorrection.predecessorId = consumerRevalidationId(scope); },
  ]) { const invalid = structuredClone(scope); mutate(invalid); expect(() => validateConsumerCorrectionLineage(invalid, prior)).toThrow(/correction/i); }
  const repeated = { ...scope, compilerCorrection: { ...scope.compilerCorrection, predecessorId: consumerRevalidationId(scope) } };
  expect(() => validateConsumerCorrectionLineage(repeated, [{ ...proposal, scope }, { ...check, scope }])).toThrow(/correction/i);
  expect(h(prior)).toBe(before);
});

it("does not substitute a missing or superseded consumer with its frozen original payload", () => {
  const payload = { retained: true }, current = { payloads: new Map([["entity-resolution:old", payload], ["initial-world:singleton", payload]]),
    activeRevisions: new Map([["initial-world:singleton", h(payload)]]) };
  expect(revalidation.currentConsumerPayload({ ref: "initial/src", reason: "typed-consumer", payload: {} }, current)).toBe(payload);
  expect(() => revalidation.currentConsumerPayload({ ref: "entity-resolution/old", reason: "typed-consumer", payload }, current)).toThrow(/retained predecessor/);
  expect(() => revalidation.currentConsumerPayload({ ref: "event/missing", reason: "typed-consumer", payload }, current)).toThrow(/no fallback/);
  expect(() => revalidation.currentConsumerPayload({ ref: "source-review/old", reason: "source-review-coverage", payload }, current)).toThrow(/original owning audit/);
});

it.each([CONSUMER_REVIEW_CORRECTION, CONSUMER_EVIDENCE_COVERAGE])("reserves one predecessor allowance across policies after %s, including unrecorded failures", async policy => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-correction-owner-"));
  try {
    const { proposal, check } = fixture();
    if (proposal.output.phase !== "consumer-revalidation") throw Error("fixture");
    proposal.scope.ref = "entry/ada/later"; proposal.scope.executionPolicy = "consumer-work/v1";
    proposal.output.disposition = "blocked"; proposal.output.initialWorldRepair = null;
    const prior = [proposal, check], correction = { predecessorId: consumerRevalidationId(proposal.scope), predecessorScopeHash: h(proposal.scope),
      predecessorRecordHashes: prior.map(h) as [string, string], contractHash: h("fixed contract") };
    const scopeReview = consumerRevalidationScopeSchema.parse({ ...proposal.scope, authorizationRef: "user:correct-scope", compilerCorrection: { ...correction, policy: CONSUMER_REVIEW_CORRECTION },
      reviewContract: { version: "consumer-review/v2", ref: proposal.scope.ref, currentRevisionHash: proposal.scope.currentRevisionHash,
        target: { kind: "character-entry", actorId: "ada", beforeEventId: "later", storyTime: { kind: "unknown" }, position: "before-event" },
        ownerRefs: [], requiredChecks: ["temporal-boundary"], originalRequirements: "consumer-dependency-compatibility", globalIdentityQuestions: "retained" } });
    const evidenceReview = consumerRevalidationScopeSchema.parse({ ...proposal.scope, authorizationRef: "user:correct-evidence",
      compilerCorrection: { ...correction, policy: CONSUMER_EVIDENCE_COVERAGE, evidenceGapHash: h("omitted reads") } });
    for (const scope of [scopeReview, evidenceReview]) expect(() => validateConsumerCorrectionLineage(scope, prior)).not.toThrow();
    for (const key of ["providerResumptionHash", "bindingRecoveryHash"] as const) {
      const recovered = prior.map(record => ({ ...record, [key]: h("prior recovery") }));
      const attempted = { ...evidenceReview, compilerCorrection: { ...evidenceReview.compilerCorrection!, predecessorRecordHashes: recovered.map(h) as [string, string] } };
      expect(() => validateConsumerCorrectionLineage(attempted, recovered)).toThrow(/already belongs to a recovered execution/);
    }
    const [owner, other] = policy === CONSUMER_REVIEW_CORRECTION ? [scopeReview, evidenceReview] : [evidenceReview, scopeReview];
    const history = [...prior, ...prior.map(record => ({ ...record, scope: owner }))];
    expect(() => validateConsumerCorrectionLineage(owner!, history)).not.toThrow();
    expect(() => validateConsumerCorrectionLineage(other!, history)).toThrow(/allowance already belongs/);
    const directory = consumerRevalidationDirectory(root, owner!);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "scope.json"), JSON.stringify(owner));
    await fs.writeFile(path.join(directory, "state.json"), JSON.stringify({ status: "BREAK", recordedStages: 0 }));
    const before = captureRecordTree(workspaceStateDir(root));
    await expect(assertConsumerCorrectionSlot(root, owner!)).resolves.toBeUndefined();
    await expect(assertConsumerCorrectionSlot(root, other!)).rejects.toThrow(/allowance already belongs/);
    // No original budget is even consulted after another policy reserved it.
    await expect(consumerRevalidationLimits(root, other!, "consumer-revalidation")).rejects.toThrow(/allowance already belongs/);
    expect(captureRecordTree(workspaceStateDir(root))).toEqual(before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("binds evidence delivery correction to the same negative pair and subtracts its settled work budget", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-evidence-correction-budget-"));
  try {
    const { proposal, check } = fixture();
    if (proposal.output.phase !== "consumer-revalidation") throw Error("fixture");
    proposal.scope.executionPolicy = "consumer-work/v1"; proposal.output.disposition = "blocked"; proposal.output.initialWorldRepair = null;
    const prior = [proposal, check];
    const scope = structuredClone({ ...proposal.scope, authorizationRef: "user:fix-evidence-delivery",
      compilerCorrection: { policy: CONSUMER_EVIDENCE_COVERAGE, predecessorId: consumerRevalidationId(proposal.scope),
        predecessorScopeHash: h(proposal.scope), predecessorRecordHashes: prior.map(h) as [string, string],
        evidenceGapHash: h("verified missing original segment"), contractHash: h("fixed coverage implementation") } });
    expect(() => consumerRevalidationScopeSchema.parse(scope)).not.toThrow();
    expect(() => validateConsumerCorrectionLineage(scope, prior)).not.toThrow();
    const renamed = { ...scope, authorizationRef: "another name",
      compilerCorrection: { ...scope.compilerCorrection, evidenceGapHash: h("different gap"), contractHash: h("another code version") } };
    expect(consumerRevalidationId(scope)).toBe(consumerRevalidationId(renamed));
    for (const mutate of [
      (s: typeof scope) => { s.authorizationRef = proposal.scope.authorizationRef; },
      (s: typeof scope) => { s.currentRevisionHash = h("different consumer"); },
      (s: typeof scope) => { s.compilerCorrection.predecessorRecordHashes[1] = h("different independent check"); },
      (s: typeof scope) => { s.compilerCorrection.evidenceGapHash = ""; },
    ]) { const changed = structuredClone(scope); mutate(changed); expect(() => validateConsumerCorrectionLineage(changed, prior)).toThrow(); }
    expect(() => validateConsumerCorrectionLineage(scope, [{ ...proposal, scope }, { ...check, scope }])).toThrow();
    const directory = path.join(consumerRevalidationDirectory(root, proposal.scope), "execution-v1"); await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, "consumer-revalidation.budget.json"), budget = { limits: { maxModelCalls: 12, maxRequestBytes: 512000, maxTotalPayloadBytes: 12288000 },
      originalBudgetHash: scope.originalBudgetHash, state: { blocked: false, usage: { modelCalls: 3, totalPayloadBytes: 800000 } } };
    await fs.writeFile(file, JSON.stringify(budget)); scope.priorBudgetFiles.push({ path: file, hash: h(budget) });
    expect(await consumerRevalidationLimits(root, scope, "consumer-revalidation")).toEqual({ maxModelCalls: 9, maxRequestBytes: 512000, maxTotalPayloadBytes: 11488000 });
    await fs.writeFile(file, JSON.stringify({ ...budget, state: { ...budget.state, usage: { modelCalls: 0, totalPayloadBytes: 0 } } }));
    await expect(consumerRevalidationLimits(root, scope, "consumer-revalidation")).rejects.toThrow(/predecessor allowance/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("discovers exact artifact refs without a whole-catalog scan or guessed identity aliases", () => {
  const target = { kind: "entity", id: "anonymous-local", payload: { name: "A local observer" } };
  const catalog = [...Array.from({ length: 300 }, (_, i) => ({ kind: "entity", id: `other-${i}`, payload: {} })), target];
  expect(revalidation.findConsumerArtifact(catalog, "entity/anonymous-local")).toBe(target);
  expect(revalidation.findConsumerArtifact(catalog, "entity:anonymous-local")).toBe(target);
  expect(revalidation.findConsumerArtifact(catalog, "anonymous-local")).toBeUndefined();
  expect(revalidation.findConsumerArtifact(catalog, "entity/A local observer")).toBeUndefined();
  expect(revalidation.discoverConsumerArtifacts(catalog, "anonymous-local")).toEqual([target]);
  expect(revalidation.discoverConsumerArtifacts(catalog, "missing-id")).toEqual([]);
  expect(catalog).toHaveLength(301);
});

it("exposes a failed compiler correction separately from historical negative judgments without changing progress or charges", async () => {
  const { original, proposal, check } = fixture(), root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-correction-status-"));
  try {
    if (proposal.output.phase !== "consumer-revalidation" || check.output.phase !== "consumer-revalidation-check") throw Error("fixture");
    proposal.output.disposition = "blocked"; proposal.output.initialWorldRepair = null;
    check.predecessorRecordHash = h(proposal); check.output.proposalHash = h(proposal.output);
    const originalDir = consumerRevalidationDirectory(root, proposal.scope); await fs.mkdir(originalDir, { recursive: true });
    await fs.writeFile(path.join(originalDir, "scope.json"), JSON.stringify(proposal.scope));
    const priorBudgetFiles = [...proposal.scope.priorBudgetFiles];
    for (const [i, stage] of ["consumer-revalidation", "consumer-revalidation-check"].entries()) {
      const budget = { scopeHash: h(proposal.scope), stage, originalBudgetHash: proposal.scope.originalBudgetHash,
        limits: IDENTITY_REQUIREMENT_LIMITS, state: { blocked: false, usage: { modelCalls: 7 + i, totalPayloadBytes: 1_000_000 } } };
      const file = path.join(originalDir, `${stage}.budget.json`);
      await fs.writeFile(file, JSON.stringify(budget)); priorBudgetFiles.push({ path: file, hash: h(budget) });
    }
    const scope = { ...proposal.scope, priorBudgetFiles, priorUsage: { modelCalls: 192, totalPayloadBytes: 43_204_360 },
      compilerCorrection: { policy: SOURCE_LOCAL_CORRECTION, predecessorId: consumerRevalidationId(proposal.scope),
        predecessorScopeHash: h(proposal.scope), predecessorRecordHashes: [h(proposal), h(check)] as [string, string], contractHash: h("actual correction") } };
    const directory = consumerRevalidationDirectory(root, scope); await fs.mkdir(directory, { recursive: true });
    const stage = "consumer-revalidation", scopeHash = h(scope), usage = { modelCalls: 16, totalPayloadBytes: 4_000_000 };
    const cumulative = { modelCalls: 208, totalPayloadBytes: 47_204_360 };
    for (const [name, value] of Object.entries({ "scope.json": scope,
      "state.json": { scopeHash, sourceId: scope.sourceId, taskId: scope.taskId, ref: scope.ref, status: "BREAK", cumulative, reason: "No terminal submission after a failed artifact read" },
      [`${stage}.invocation.json`]: { scopeHash, stage, pid: 123 },
      [`${stage}.budget.json`]: { scopeHash, stage, originalBudgetHash: scope.originalBudgetHash,
        limits: await consumerRevalidationLimits(root, scope, stage), state: { blocked: false, usage } },
      [`${stage}.failure.json`]: { reason: "No terminal submission after a failed artifact read" },
    })) await fs.writeFile(path.join(directory, name), JSON.stringify(value));
    const history = [...original.map(record => ({ payload: { kind: "identity-requirements", record } })),
      ...[proposal, check].map(record => ({ payload: { kind: "identity-consumer-revalidation", record } }))] as any;
    const before = captureRecordTree(path.dirname(directory)), old = identityReviewStatuses(history)[0]!;
    const status = (await inspectIdentityReviewStatuses(root, scope.sourceId, history))[0]!;
    expect(status.consumerRevalidation.reviews).toEqual(old.consumerRevalidation.reviews);
    expect(status.recordedReviewedConsumers).toBe(old.recordedReviewedConsumers);
    expect(status.consumerRevalidation.recordedClearedConsumers).toBe(0);
    const attempt = status.consumerRevalidation.attempts.find(a => a.compilerCorrection)!;
    expect(attempt).toMatchObject({ status: "BREAK", recordedStages: 0, semanticJudgmentPending: true, cumulative,
      executionAuthority: false, parentResumeAllowed: false,
      stages: [{ invocationConsumed: true, sealedSubmission: false, remainingAllowance: { modelCalls: 1 } },
        { invocationConsumed: false, sealedSubmission: false, remainingAllowance: { modelCalls: 16 } }] });
    expect(captureRecordTree(path.dirname(directory))).toEqual(before);
    await fs.writeFile(path.join(directory, "scope.json"), JSON.stringify({ ...scope, identityIntentHash: h("different task") }));
    await expect(inspectIdentityReviewStatuses(root, scope.sourceId, history)).rejects.toThrow(/original scope/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("pins one compiler correction to the exact negative judgments and subtracts their original stage allowance", async () => {
  const { proposal, check } = fixture(), root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-consumer-correction-"));
  try {
    if (proposal.output.phase !== "consumer-revalidation" || check.output.phase !== "consumer-revalidation-check") throw Error("fixture");
    proposal.output.disposition = "blocked"; proposal.output.initialWorldRepair = null;
    check.output.proposalHash = h(proposal.output); check.predecessorRecordHash = h(proposal);
    const scope = structuredClone({ ...proposal.scope, compilerCorrection: { policy: SOURCE_LOCAL_CORRECTION,
      predecessorId: consumerRevalidationId(proposal.scope), predecessorScopeHash: h(proposal.scope),
      predecessorRecordHashes: [h(proposal), h(check)] as [string, string], contractHash: h("fixed implementation") } });
    expect(() => validateConsumerCorrectionLineage(scope, [proposal, check])).not.toThrow();
    expect(() => validateConsumerCorrectionLineage(scope, [proposal])).toThrow(/exact independently blocked/);
    expect(() => validateConsumerCorrectionLineage({ ...scope, currentRevisionHash: h("different consumer") }, [proposal, check])).toThrow();
    expect(consumerRevalidationId(scope)).toBe(consumerRevalidationId({ ...scope, compilerCorrection: { ...scope.compilerCorrection, contractHash: h("renamed implementation") } }));
    const directory = consumerRevalidationDirectory(root, proposal.scope); await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, "consumer-revalidation.budget.json"), budget = { limits: IDENTITY_REQUIREMENT_LIMITS,
      originalBudgetHash: scope.originalBudgetHash, state: { blocked: false, usage: { modelCalls: 7, totalPayloadBytes: 1_000_000 } } };
    await fs.writeFile(file, JSON.stringify(budget)); scope.priorBudgetFiles.push({ path: file, hash: h(budget) });
    expect(await consumerRevalidationLimits(root, scope, "consumer-revalidation")).toEqual({ ...IDENTITY_REQUIREMENT_LIMITS,
      maxModelCalls: IDENTITY_REQUIREMENT_LIMITS.maxModelCalls - 7, maxTotalPayloadBytes: IDENTITY_REQUIREMENT_LIMITS.maxTotalPayloadBytes - 1_000_000 });
    await fs.writeFile(file, JSON.stringify({ ...budget, state: { ...budget.state, usage: { modelCalls: 0, totalPayloadBytes: 0 } } }));
    await expect(consumerRevalidationLimits(root, scope, "consumer-revalidation")).rejects.toThrow(/exact original stage budget/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("requires exact initial-world field authority and binds state, observations and checkpoint dependencies", () => {
  const evidence = [{ span: { sourceId: "src", startLine: 1, endLine: 1, quoteHash: h("source") }, strength: "explicit" as const }];
  const baseline = { version: 1 as const, delta: { version: 1 as const, operations: [] }, evidence };
  const refs = [{ kind: "initial-world" as const, id: "singleton", revisionHash: h(baseline) }, { kind: "entity" as const, id: "actor", revisionHash: h("actor") }];
  const identity = { version: 1 as const, planId: "initial", batchId: "initial", requirementSetHash: h("original requirements"), requirementIds: ["original"], predecessorReceiptRefs: [],
    sourceScope: { sourceId: "src", sourceSha256: h("source"), segmentIds: ["seg"] }, baselineRefs: refs, readableRefs: refs.map(({ revisionHash: _, ...r }) => r),
    allowedWrites: [{ kind: "initial-world" as const, id: "singleton", pointers: ["/delta"] }], allowedCreations: [], citableEvidenceRefs: ["seg"], dependencyEdges: [],
    postconditionIds: ["original"], authorizationRef: "existing", retryBudgetRef: "retained" };
  const plan = freezeUpstreamRepairPlan(identity), payload = { ...baseline, delta: { version: 1, operations: [{ op: "set", entityId: "actor", field: "character.alive", value: true }] } };
  const input = { kind: "initial-world" as const, id: "singleton", baseline, payload, activeRevisions: new Map(refs.map(r => [`${r.kind}:${r.id}`, r.revisionHash])),
    sourceSha256: identity.sourceScope.sourceSha256, requirementSetHash: identity.requirementSetHash, citedSegmentIds: ["seg"], hostDerivation: {} };
  expect(() => assertUpstreamRepairMutation(plan, input)).not.toThrow();
  expect(() => assertUpstreamRepairMutation(plan, { ...input, payload: { ...payload, readerSetup: "unapproved" } })).toThrow(/Unauthorized field/);
  expect(() => assertUpstreamRepairMutation(plan, { ...input, payload: { ...payload, delta: { version: 1, operations: [{ op: "set", entityId: "unknown", field: "character.alive", value: true }] } } })).toThrow(/Unfrozen dependency/);
  expect(() => freezeUpstreamRepairPlan({ ...identity, allowedWrites: [{ kind: "initial-world", id: "other", pointers: ["/delta"] }] })).toThrow(/singleton/);
  expect(() => freezeUpstreamRepairPlan({ ...identity, allowedWrites: [], allowedCreations: [{ kind: "initial-world", id: "another", maxCount: 1, dependencyOf: "original" }] })).toThrow(/singleton/);
  expect(initialWorldRepairReferences(payload)).toEqual(["entity:actor"]);
  const seeded = { ...baseline, projectionSeed: { version: 1, elapsedDays: 0, activeRuleIds: ["active-rule"],
    semantics: { version: 1, operations: [
      { op: "record-proposition", proposition: { id: "local-prop", subjectEntityId: "actor", relationId: "at", object: { kind: "entity", entityId: "place" }, polarity: "positive", modality: "asserted" } },
      { op: "record-claim", claim: { id: "local-claim", propositionId: "local-prop", status: "asserted" } },
      { op: "record-acquisition", acquisition: { id: "local-acquisition", ontologyVersion: "branch-acquisition-v1", actorId: "actor", claimId: "local-claim", propositionId: "local-prop",
        basis: { mode: "observed", locationId: "here", entityId: "actor", field: "character.location", value: "place" }, reception: { received: true, understood: true, belief: "accepted" } } },
      { op: "adjust-relationship", relationshipId: "bond", fromActorId: "from", toActorId: "to", dimensionId: "trust", amount: 0.1 },
    ] }, processes: { version: 1, operations: [{ op: "start-process", process: { id: "local-process", templateId: "process-template", ownerBindings: [{ roleId: "owner", entityIds: ["owner"] }], phaseId: "start" } }] },
    norms: { version: 1, operations: [{ op: "instantiate-norm", norm: { id: "local-norm", templateId: "norm-template", subjectActorId: "subject", description: "Original obligation" } },
      { op: "satisfy-norm", normId: "local-norm", byActorId: "performer", acknowledgedByActorId: "witness" }] } },
    knowledge: { version: 1, operations: [{ op: "learn", actorId: "actor", claimId: "local-claim", propositionId: "local-prop", acquisitionId: "local-acquisition", acquisitionMode: "observed", status: "knows", confidence: 1 }] } };
  expect(initialWorldRepairReferences(seeded)).toEqual(["entity:actor", "entity:from", "entity:here", "entity:owner", "entity:performer", "entity:place", "entity:subject", "entity:to", "entity:witness", "norm-template:norm-template", "process-template:process-template", "world-rule:active-rule"]);
});

it.each([{ discoveryOnly: false, work: false }, { discoveryOnly: true, work: false }, { discoveryOnly: false, work: true },
  { discoveryOnly: false, work: true, preflightRemeasure: true },
  { discoveryOnly: false, work: true, stall: true }, { discoveryOnly: false, work: true, previewLoop: true },
  { discoveryOnly: false, work: true, quota: true }, { discoveryOnly: false, work: true, oversized: true },
  { discoveryOnly: false, work: true, transportRecovery: true },
  { discoveryOnly: false, work: true, transportRecovery: true, transportTerminal: true },
  { discoveryOnly: false, work: true, transportRecovery: true, additionalEvidence: true },
  { discoveryOnly: false, work: true, transportTerminal: true },
  ...["proposal", "check", "read", "fail", "changed-draft"].map(providerResume => ({ discoveryOnly: false, work: true, providerResume })),
  { discoveryOnly: false, work: true, providerResume: "proposal", legacyEvidencePlan: true },
  { discoveryOnly: false, work: true, additionalEvidence: true },
  { discoveryOnly: false, work: true, scoped: true }, { discoveryOnly: false, work: true, scoped: true, cleared: true },
  ...["once", "twice", "scope", "terminal"].map(bindingIssue => ({ discoveryOnly: false, work: true, scoped: true, cleared: true, bindingIssue })),
  ...["success", "fail", "interrupt"].map(bindingRecovery => ({ discoveryOnly: false, work: true, scoped: true, cleared: true, bindingRecovery })),
])("runs independent Pi reviews with full reads ($discoveryOnly), work ($work), scoped $scoped, cleared $cleared, stall $stall, preview loop $previewLoop, quota $quota, oversized $oversized, binding $bindingIssue recovery $bindingRecovery, transport $transportRecovery terminal $transportTerminal, extra evidence $additionalEvidence, provider resumption $providerResume legacy evidence $legacyEvidencePlan, preflight remeasurement $preflightRemeasure, and recovers registration without replay", async ({ discoveryOnly, work, stall, previewLoop, quota, oversized, scoped, cleared, bindingIssue, bindingRecovery, transportRecovery, transportTerminal, additionalEvidence, providerResume, preflightRemeasure, legacyEvidencePlan }: { discoveryOnly: boolean; work: boolean; stall?: boolean; previewLoop?: boolean; quota?: boolean; oversized?: boolean; scoped?: boolean; cleared?: boolean; bindingIssue?: string; bindingRecovery?: string; transportRecovery?: boolean; transportTerminal?: boolean; additionalEvidence?: boolean; providerResume?: string; preflightRemeasure?: boolean; legacyEvidencePlan?: boolean }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-revalidation-")), providers: Awaited<ReturnType<typeof mockPiProvider>>[] = [];
  try {
    const text = "Ada waits. 女孩等待。" + (additionalEvidence ? "\n# Later\nAda sees the door." : ""), source = await createEvidenceFixture(root, text), f0 = fixture();
    const f: ReturnType<typeof fixture> = JSON.parse(JSON.stringify(f0).replaceAll("src", source.source.id).replaceAll('"seg"', JSON.stringify(source.segmentId)).replaceAll(f0.f.intent.sourceHash, source.source.contentSha256));
    const scope = f.proposal.scope;
    if (work) scope.executionPolicy = "consumer-work/v1";
    if (scoped) {
      scope.ref = "entry/ada/later"; f.f.intent.consumerShards[0]!.refs[0] = scope.ref;
      for (const [i, record] of f.original.entries()) {
        record.intent = f.f.intent;
        record.output.intentHash = h(f.f.intent);
        if ("proposalHash" in record.output) record.output.proposalHash = h(f.original[0]!.output);
        record.predecessorRecordHash = i ? h(f.original[i - 1]) : null;
      }
    }
    scope.identityIntentHash = h(f.f.intent); scope.definitionHash = h(f.original[0]!.output);
    const originalBudget = path.join(root, "inherited-budget.json"); await fs.writeFile(originalBudget, JSON.stringify({ retainedCalls: 177 }));
    scope.priorBudgetFiles = [{ path: originalBudget, hash: h({ retainedCalls: 177 }) }];
    f.proposal.output.scopeHash = h(scope);
    if (f.proposal.output.phase !== "consumer-revalidation") throw Error("fixture");
    f.proposal.output.initialWorldRepair = null; f.proposal.output.disposition = "blocked";
    const directory = consumerRevalidationDirectory(root, scope), previous: ConsumerRevalidationRecord[] = [];
    const manifest = await new SegmentStore(root).readManifest(source.source.id);
    const p: any = { scope, directory, original: f.original, previous,
      catalog: [{ kind: "entity", id: "ada", revisionHash: h({ id: "ada" }), payload: { id: "ada" }, current: true }],
      consumer: { ref: scope.ref, revisionHash: scope.originalRevisionHash, payload: {} },
      current: { payload: {}, revisionHash: scope.currentRevisionHash }, acceptance: { output: {} }, prepared: { ...f.f.p, intent: f.f.intent, inventory: f.f.inventory,
        bytes: Buffer.from(text), manifest, review: { scope: { questions: [] } } } };
    if (work) p.consumer.dependencies = [{ kind: "entity", id: "ada" }];
    if (additionalEvidence) {
      expect(manifest!.segments).toHaveLength(2);
      const payload = { id: "extra", evidence: source.evidence("Ada sees the door.") };
      p.catalog.push({ kind: "world-rule", id: "extra", payload, revisionHash: h(payload), current: true });
    }
    if (scoped) {
      const payload = { actorId: "ada", readerSetup: "Later entry", actorObservation: "You wait.", participantPresence: [{ entityId: "ada", mode: "physical" }], delta: { version: 1, operations: [] } };
      const event = canonicalEventSchema.parse({ id: "later", title: "Later entry", participants: ["ada"], characterEntryCheckpoints: [payload],
        storyTime: { kind: "ordinal", label: "later afternoon", orderHint: 30 }, preconditions: [], observedOutcome: { version: 1, operations: [] },
        causalParents: [], confidence: 1, evidence: source.evidence("Ada waits.") });
      p.catalog.push({ kind: "canonical-event", id: "later", payload: event, revisionHash: h(event), current: true });
      p.current = { payload, revisionHash: h(payload) }; scope.currentRevisionHash = h(payload);
      scope.reviewContract = deriveConsumerReviewContract({ sourceId: scope.sourceId, ref: scope.ref, current: p.current, catalog: p.catalog });
      Object.assign(f.proposal.output, { ref: scope.ref, currentRevisionHash: scope.currentRevisionHash, scopeHash: h(scope),
        disposition: cleared ? "revalidated" : "blocked", review: { contractHash: h(scope.reviewContract), globalIdentityQuestions: "retained",
          checks: scope.reviewContract.requiredChecks.map(id => ({ id, verdict: !cleared && id === "knowledge-isolation" ? "blocked" : "supported",
            rationale: !cleared && id === "knowledge-isolation" ? "Future knowledge has no acquisition before this later entry." : "Compatible with the exact later entry; global identity remains unresolved." })) } });
      if (cleared) f.proposal.output.requirements.forEach(r => { r.verdict = "supported"; });
      if (f.check.output.phase === "consumer-revalidation-check") f.check.output.reviewContractHash = h(scope.reviewContract);
    }
    if (oversized) {
      p.catalog[0].payload.semanticEvidence = "完整语义原文".repeat(60_000);
      p.catalog[0].revisionHash = h(p.catalog[0].payload);
    }
    const base = identityRequirementDirectory(root, scope.sourceId, scope.taskId); await fs.mkdir(base, { recursive: true });
    await fs.writeFile(path.join(base, "context.json"), JSON.stringify(p.prepared));
    vi.spyOn(revalidation, "prepareConsumerRevalidation").mockResolvedValue(p);
    vi.spyOn(retainedState, "assertConsumerRepairRetainedState").mockResolvedValue();
    vi.spyOn(RequirementLedger.prototype, "identityRequirements").mockResolvedValue(f.original);
    vi.spyOn(RequirementLedger.prototype, "history").mockImplementation(async () => [
      { payload: { kind: "identity-consumer-repair", record: { intent: { taskId: scope.taskId } } } },
      ...previous.map(record => ({ payload: { kind: "identity-consumer-revalidation", record } })),
    ] as any);
    const createPlan = workPlans.createConsumerWorkPlan;
    const legacyPlans = bindingRecovery || legacyEvidencePlan ? vi.spyOn(workPlans, "createConsumerWorkPlan").mockImplementation(args => createPlan({ ...args,
      reviewBinding: bindingRecovery ? undefined : args.reviewBinding,
      evidencePolicy: legacyEvidencePlan && args.stage === "consumer-revalidation" ? undefined : args.evidencePolicy })) : undefined;
    let recovering = false, interruptRecovery = false;
    let interrupt = !transportRecovery && !providerResume;
    let providerRecovering = false;
    // Reproduce the old sealing failure after the real Pi retry and terminal
    // submission. Recovery below uses the real, corrected verifier throughout.
    const legacySeal = transportRecovery ? vi.spyOn(upstreamSession, "sealIdentityUpstreamSession").mockImplementationOnce(async () => {
      throw prerequisiteStop(transportTerminal
        ? "Identity context edit is not one recorded unsubmitted WebSocket retry; preserve its complete history, no redispatch"
        : "Identity transcript is truncated, forked or edited; retain its complete original evidence");
    }) : undefined;
    vi.spyOn(RequirementLedger.prototype, "recordIdentityConsumerRevalidation").mockImplementation(async record => {
      await revalidation.verifyConsumerRevalidationRecord(root, record);
      if (interruptRecovery) { interruptRecovery = false; throw Error("recovery registration interruption"); }
      if (interrupt) { interrupt = false; throw Error("injected registration interruption"); }
      if (!previous.some(r => r.output.phase === record.output.phase)) previous.push(record);
    });
    const realRuntime = ModelRuntime.create.bind(ModelRuntime);
    vi.spyOn(ModelRuntime, "create").mockImplementation(async options => options?.authPath === getAgentDir() + "/auth.json"
      ? { checkAuth: async () => ({ type: "oauth" }), getProvider: () => ({ auth: { oauth: { isSubscription: true } } }), getModel: () => ({}) } as any : realRuntime(options));
    const create = PiAgentSession.create.bind(PiAgentSession);
    const dispatch = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
      const check = path.basename(options.runtimeDir!) === "consumer-revalidation-check";
      const session = await create({ ...options, model: undefined, piAgentDir: path.join(root, "pi") });
      providers.push(await mockPiProvider(session, { provider: "openai-codex", modelId: "gpt-6.1-sol",
        ...(quota || providerResume ? { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } : {}),
        response: (context, index) => {
        if (!bindingIssue && !bindingRecovery && !transportRecovery && !transportTerminal && !additionalEvidence && !stall && !previewLoop && index > (discoveryOnly ? 3 : 1)) throw Error("Unexpected model retry");
        if (work) {
          if (quota) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Codex error: The usage limit has been reached" });
          if (providerResume && (providerResume === "proposal" ? !check : check) && index === 1 && (!providerRecovering || providerResume === "fail"))
            return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Codex error: The usage limit has been reached" });
          if (providerResume === "read" && check && !providerRecovering && index === 0)
            return fauxAssistantMessage([fauxToolCall("read_consumer_revalidation", { collection: "artifacts", refs: ["entity:ada"], offset: 0 }, { id: "read-before-quota" })], { stopReason: "toolUse" });
          if (stall) return fauxAssistantMessage([fauxToolCall("read_consumer_revalidation", { collection: "consumer", refs: [scope.ref], offset: 0 }, { id: `repeated-read-${index}` })], { stopReason: "toolUse" });
          const user = context.messages.find(m => m.role === "user")!;
          const envelope = JSON.parse(typeof user.content === "string" ? user.content : user.content.find(c => c.type === "text")!.text);
          const input = decodeJsonValues(envelope.dictionary, [envelope.value], envelope.dictionaryProfile)[0] as any;
          expect(input.evidencePacket.sources[0].text).toBe(Buffer.from(text).subarray(manifest!.segments[0]!.startByte, manifest!.segments[0]!.endByte).toString("utf8"));
          expect(input.evidencePacket.artifacts.find((a: any) => a.ref === "entity:ada")).toMatchObject({ payload: { id: "ada" } });
          if (scoped) {
            expect(input.reviewContract.target).toMatchObject({ kind: "character-entry", beforeEventId: "later", position: "before-event", storyTime: { orderHint: 30 } });
            expect(input.capability).toMatchObject({ kind: "read-only-consumer", writableFields: [] });
            expect(input.evidencePacket.artifacts.some((a: any) => a.ref === "canonical-event:later")).toBe(true);
          }
          expect(input.denominator.refs).toEqual({ policy: "ordered-inventory/v1", count: f.f.inventory.consumers.length, hash: h(f.f.inventory.consumers.map(c => c.ref)) });
          const output = structuredClone(check ? { ...f.check.output, scopeHash: h(scope), proposalHash: h(previous[0]!.output) } : f.proposal.output);
          if (providerRecovering && providerResume === "changed-draft") output.rationale += "changed after quota";
          if (additionalEvidence) {
            const extraId = manifest!.segments[1]!.id;
            if (check) {
              expect(input.evidencePacket.sources.some((s: any) => s.id === extraId)).toBe(true);
              expect(input.evidencePacket.artifacts.some((a: any) => a.ref === "world-rule:extra")).toBe(true);
            } else {
              if (transportRecovery) {
                output.evidence.push({ segment_id: extraId, exact: "Ada sees the door." });
                if (index === 0) return fauxAssistantMessage([fauxToolCall("read_consumer_revalidation",
                  { collection: "artifacts", refs: ["world-rule:extra"], offset: 0 }, { id: "transport-extra-artifact" })], { stopReason: "toolUse" });
                if (index === 1) return fauxAssistantMessage([fauxToolCall("read_consumer_revalidation",
                  { collection: "source", segmentIds: [extraId], offset: 0 }, { id: "transport-extra-source" })], { stopReason: "toolUse" });
                if (index === 3) return fauxAssistantMessage([fauxToolCall("submit_consumer_revalidation", output, { id: "transport-partial-submit" })],
                  { stopReason: "error", errorMessage: "WebSocket closed 1006" });
                return fauxAssistantMessage([fauxToolCall(index === 2 ? "preview_consumer_revalidation" : "submit_consumer_revalidation", output,
                  { id: `transport-completed-${index}` })], { stopReason: "toolUse" });
              }
              const reads: Array<Record<string, string | number | string[]> | null> = [
                { collection: "artifacts", query: "extra", offset: 0 },
                { collection: "artifacts", refs: ["world-rule:extra"], offset: 0 },
                null, { collection: "source", segmentIds: [extraId], offset: 0 },
              ];
              if (index === 3) {
                const rejected = context.messages.find(m => m.role === "toolResult" && m.toolCallId === "extra-2");
                expect(rejected).toMatchObject({ isError: true });
                expect(JSON.stringify(rejected)).toContain("CONSUMER_EVIDENCE_UNREAD");
              }
              if (index >= 4) output.evidence.push({ segment_id: extraId, exact: "Ada sees the door." });
              if (index > 5) throw Error("Unexpected evidence retry");
              return fauxAssistantMessage([fauxToolCall(index < 4 && reads[index] ? "read_consumer_revalidation"
                : index === 5 ? "submit_consumer_revalidation" : "preview_consumer_revalidation",
                index < 4 && reads[index] ? reads[index]! : output, { id: `extra-${index}` })], { stopReason: "toolUse" });
            }
          }
          if (transportRecovery && !transportTerminal && !check && index === 0)
            return fauxAssistantMessage([fauxToolCall("preview_consumer_revalidation", output, { id: "unexecuted-partial-preview" })],
              { stopReason: "error", errorMessage: "WebSocket closed 1006" });
          if (transportTerminal && !check && index === 1)
            return fauxAssistantMessage([fauxToolCall("submit_consumer_revalidation", output, { id: "unexecuted-partial-submit" })],
              { stopReason: "error", errorMessage: "WebSocket closed 1006" });
          if (check && (bindingIssue || bindingRecovery)) {
            const badHash = { ...output, reviewContractHash: h("prior subject, not the contract") };
            const isBad = bindingRecovery ? !recovering || bindingRecovery === "fail" : bindingIssue === "twice" || index === 0;
            const candidate = isBad ? bindingIssue === "scope" ? { ...output, scopeHash: h("different scope") } : badHash : output;
            const name = bindingIssue === "terminal" ? "submit_consumer_revalidation"
              : isBad || index === (bindingRecovery ? 0 : 1) ? "preview_consumer_revalidation" : "submit_consumer_revalidation";
            return fauxAssistantMessage([fauxToolCall(name, candidate, { id: `binding-${providers.length}-${index}` })], { stopReason: "toolUse" });
          }
          if (previewLoop) return fauxAssistantMessage([fauxToolCall("preview_consumer_revalidation", { ...output, rationale: `${output.rationale} wording ${index}` }, { id: `preview-loop-${index}` })], { stopReason: "toolUse" });
          const turn = index - (transportRecovery && !transportTerminal && !check ? 1 : 0);
          return fauxAssistantMessage([fauxToolCall(turn ? "submit_consumer_revalidation" : "preview_consumer_revalidation", output,
            { id: `work-${check}-${index}` })], { stopReason: "toolUse" });
        }
        if (index === 1) {
          for (const id of [`discovery-${check}`, `artifact-${check}`]) {
            const read = context.messages.find(m => m.role === "toolResult" && m.toolCallId === id);
            expect(read).toMatchObject({ isError: false });
            expect(read?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("entity:ada") })]));
          }
          for (const [name, expected] of [["source-search", { total: 1, items: [{ id: source.segmentId }], nextOffset: null }],
            ["source-missing", { total: 0, items: [], nextOffset: null }]] as const) {
            const read = context.messages.find(m => m.role === "toolResult" && m.toolCallId === `${name}-${check}`);
            expect(read).toMatchObject({ isError: false });
            if (read?.role !== "toolResult") throw Error("Missing source discovery tool result");
            const content = read.content.find(b => b.type === "text");
            if (content?.type !== "text") throw Error("Missing source discovery receipt");
            const wire = JSON.parse(content.text);
            const user = context.messages.find(m => m.role === "user")!;
            const userText = typeof user.content === "string" ? user.content : user.content.find(b => b.type === "text")!.text;
            const envelope = JSON.parse(userText);
            const value = wire.$nwhContext ? decodeJsonValues(envelope.dictionary, [wire.value], envelope.dictionaryProfile)[0] as typeof wire : wire;
            expect(value).toMatchObject(expected);
            expect(value.items.every((item: unknown) => !Object.hasOwn(item as object, "text"))).toBe(true);
          }
        }
        const output = check ? { ...f.check.output, scopeHash: h(scope), proposalHash: h(previous[0]!.output) } : f.proposal.output;
        if (discoveryOnly && index === 2) {
          const rejected = context.messages.find(m => m.role === "toolResult" && m.toolCallId === `submit-${check}-1`);
          expect(rejected).toMatchObject({ isError: true });
          expect(rejected?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("Read every requiredSourceSegmentIds") })]));
          return fauxAssistantMessage([fauxToolCall("read_consumer_revalidation", { collection: "source", segmentIds: [source.segmentId], offset: 0 }, { id: `full-source-${check}` })], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage(index === 0 ? [
          fauxToolCall("read_consumer_revalidation", { collection: "source", query: "女孩", offset: 0 }, { id: `source-search-${check}` }),
          fauxToolCall("read_consumer_revalidation", { collection: "source", query: "not present", offset: 0 }, { id: `source-missing-${check}` }),
          ...(!discoveryOnly ? [fauxToolCall("read_consumer_revalidation", { collection: "source", segmentIds: [source.segmentId], offset: 0 }, { id: `source-${check}` })] : []),
          fauxToolCall("read_consumer_revalidation", { collection: "consumer", refs: [scope.ref], offset: 0 }, { id: `consumer-${check}` }),
          fauxToolCall("read_consumer_revalidation", { collection: "artifacts", query: "ada", offset: 0 }, { id: `discovery-${check}` }),
          fauxToolCall("read_consumer_revalidation", { collection: "artifacts", refs: ["entity/ada"], offset: 0 }, { id: `artifact-${check}` }),
        ] : [fauxToolCall("submit_consumer_revalidation", index === 3 ? { ...output, rationale: `${output.rationale}; now grounded in the complete source read.` } : output,
          { id: `submit-${check}-${index}` })], { stopReason: "toolUse" });
      } }));
      if (transportRecovery || transportTerminal) providers.at(-1)!.host.session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
      return session;
    });
    const args = { root, sourceId: scope.sourceId, taskId: scope.taskId, ref: scope.ref, authorizationRef: scope.authorizationRef };
    const oldPreflight = path.join(consumerWorkDirectory(directory), "consumer-revalidation.preflight.json");
    const oldPreflightBytes = JSON.stringify({ status: "context-blocked", rawMeasurement: true, modelDispatchAllowed: false });
    if (preflightRemeasure) {
      await fs.mkdir(path.dirname(oldPreflight), { recursive: true });
      await fs.writeFile(oldPreflight, oldPreflightBytes);
    }
    if (work) {
      const before = captureRecordTree(workspaceStateDir(root));
      expect(await runIdentityConsumerRevalidation({ ...args, inspectExecution: true })).toMatchObject({ status: oversized ? "context-blocked" : "ready", execution: { minimumModelCalls: 2 } });
      expect(dispatch).not.toHaveBeenCalled(); expect(captureRecordTree(workspaceStateDir(root))).toEqual(before);
    }
    if (oversized) {
      expect(await runIdentityConsumerRevalidation(args)).toMatchObject({ status: "context-blocked", execution: { modelDispatchAllowed: false } });
      expect((await inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, previous))[0]!.stages[0]!.execution)
        .toMatchObject({ status: "context-blocked", invocationConsumed: false, usage: { modelCalls: 0 } });
      expect(dispatch).not.toHaveBeenCalled(); expect(previous).toEqual([]); return;
    }
    if (providerResume) {
      await expect(runIdentityConsumerRevalidation(args)).rejects.toThrow(/usage limit/);
      const stage = providerResume === "proposal" ? "consumer-revalidation" : "consumer-revalidation-check";
      const workDirectory = consumerWorkDirectory(directory), originalTree = captureRecordTree(workDirectory);
      const failedBudget = JSON.parse(await fs.readFile(path.join(workDirectory, `${stage}.budget.json`), "utf8"));
      const attempts = await inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, previous);
      const candidate = attempts[0]!.stages.find(s => s.stage === stage)!.execution!.providerResumptionCandidate!;
      expect(candidate).toMatchObject({ scopeHash: h(scope), stage, inspectionRequired: true });
      await new Promise(resolve => setTimeout(resolve, 5));
      const providerResumption = { scopeHash: candidate.scopeHash, stage, failedTraceRunId: candidate.failedTraceRunId,
        authorizationRef: "user:continue-after-provider-availability-check", authorizedAt: new Date().toISOString() } as const;
      const resume = { ...args, providerResumption };
      const before = captureRecordTree(workspaceStateDir(root));
      expect(await runIdentityConsumerRevalidation({ ...resume, resumeUnsubmitted: "inspect" })).toMatchObject({
        status: "ready", execution: { modelDispatchAllowed: true, ...(!legacyEvidencePlan ? {
          limits: { maxModelCalls: providerResume === "read" ? 10 : 11 }, budgetPolicy: { modelCallsMode: "enforce" } } : {}) } });
      expect(captureRecordTree(workspaceStateDir(root))).toEqual(before);
      for (const patch of [{ scopeHash: h("wrong") }, { failedTraceRunId: "wrong" }, { authorizationRef: scope.authorizationRef }, { authorizedAt: "2000-01-01T00:00:00.000Z" }])
        await expect(runIdentityConsumerRevalidation({ ...args, providerResumption: { ...providerResumption, ...patch }, resumeUnsubmitted: "inspect" })).rejects.toThrow();
      const draftName = (await fs.readdir(workDirectory)).find(n => n.startsWith(stage + ".draft-"));
      const originalDraft = draftName ? JSON.parse(await fs.readFile(path.join(workDirectory, draftName), "utf8")) : undefined;
      providerRecovering = true;
      const resumedDirectory = workPlans.consumerWorkProviderDirectory(workDirectory, stage);
      if (providerResume === "fail" || providerResume === "changed-draft") {
        await expect(runIdentityConsumerRevalidation({ ...resume, resumeUnsubmitted: "run" })).rejects.toThrow(providerResume === "fail" ? /usage limit/ : /changed the original validated draft/);
        const dispatches = dispatch.mock.calls.length;
        await expect(runIdentityConsumerRevalidation({ ...resume, resumeUnsubmitted: "run" })).rejects.toThrow(/stage is consumed/);
        expect(dispatch).toHaveBeenCalledTimes(dispatches);
      } else {
        interruptRecovery = true;
        await expect(runIdentityConsumerRevalidation({ ...resume, resumeUnsubmitted: "run" })).rejects.toThrow("recovery registration interruption");
        const result = await runIdentityConsumerRevalidation({ ...resume, resumeUnsubmitted: "run" });
        expect(result).toMatchObject({ status: "blocked", cumulative: { modelCalls: 183 }, parentResumeAllowed: false });
        const record = previous.find(r => r.output.phase === stage)!;
        expect(record.output).toEqual(originalDraft?.output ?? { ...f.check.output, scopeHash: h(scope), proposalHash: h(previous[0]!.output) });
        expect(record.providerResumptionHash).toMatch(/^[a-f0-9]{64}$/);
        expect(providers.map(p => p.contexts.length)).toEqual([2, 2, 2]);
        const dispatches = dispatch.mock.calls.length;
        expect((await runIdentityConsumerRevalidation({ ...resume, resumeUnsubmitted: "run" })).cumulative).toEqual(result.cumulative);
        expect(dispatch).toHaveBeenCalledTimes(dispatches);
        const attempts = await inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, previous);
        expect(attempts[0]!.cumulative).toEqual(result.cumulative);
        expect(attempts[0]!.stages.find(s => s.stage === stage)!.execution!.providerResumption).toMatchObject({ status: "sealed", usage: { modelCalls: 2 } });
        expect(attempts[0]!.evidenceCorrection).toBeUndefined();
        vi.mocked(revalidation.prepareConsumerRevalidation).mockRejectedValue(new Error("later active dependency changed"));
        await revalidation.verifyConsumerRevalidationRecord(root, record);
        vi.mocked(revalidation.prepareConsumerRevalidation).mockResolvedValue(p);
      }
      const proof = JSON.parse(await fs.readFile(path.join(resumedDirectory, "recovery.json"), "utf8"));
      expect(proof.priorUsage).toEqual(failedBudget.cumulative);
      if (providerResume === "read") expect(proof.requiredArtifactRevisions).toEqual([{ ref: "entity:ada", revisionHash: h({ id: "ada" }) }]);
      expect(proof.limits.maxTotalPayloadBytes).toBe(failedBudget.limits.maxTotalPayloadBytes - failedBudget.state.usage.totalPayloadBytes);
      const after = captureRecordTree(workDirectory);
      for (const [name, hash] of Object.entries(originalTree)) expect(after[name]).toBe(hash);
      if (legacyEvidencePlan) {
        const resumedPlanFile = path.join(resumedDirectory, `${stage}.plan.json`), savedPlan = await fs.readFile(resumedPlanFile, "utf8");
        await fs.writeFile(resumedPlanFile, await fs.readFile(path.join(workDirectory, `${stage}.plan.json`), "utf8"));
        await expect(inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, previous)).rejects.toThrow(/exact sealed plan/);
        await fs.writeFile(resumedPlanFile, savedPlan);
        const beforeInspect = captureRecordTree(workspaceStateDir(root));
        await inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, previous);
        expect(captureRecordTree(workspaceStateDir(root))).toEqual(beforeInspect);
      }
      return;
    }
    if (transportRecovery) {
      await expect(runIdentityConsumerRevalidation(args)).rejects.toThrow(/transcript is truncated|context edit is not/);
      legacySeal!.mockRestore();
      expect(dispatch).toHaveBeenCalledTimes(1); expect(previous).toHaveLength(0);
      const workDirectory = consumerWorkDirectory(directory), failureFile = path.join(workDirectory, "consumer-revalidation.failure.json");
      const originalFailure = await fs.readFile(failureFile, "utf8"), failure = JSON.parse(originalFailure);
      const originalBudget = await fs.readFile(path.join(workDirectory, "consumer-revalidation.budget.json"), "utf8");
      const attempts = await inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, previous);
      const candidate = attempts[0]!.stages[0]!.execution!.transportRecoveryCandidate!;
      await new Promise(resolve => setTimeout(resolve, 5));
      const request = { scopeHash: candidate.scopeHash, stage: "consumer-revalidation" as const,
        failedTraceRunId: candidate.failedTraceRunId, failureHash: candidate.failureHash,
        authorizationRef: "user:retry-after-transport-sealing-failure", authorizedAt: new Date().toISOString() };
      const recovery = { ...args, recoverTransportRetry: request };
      const before = captureRecordTree(workspaceStateDir(root));
      expect(await runIdentityConsumerRevalidation({ ...recovery, inspectExecution: true })).toMatchObject({
        status: "transport-recovery-ready", providerCalls: 0, disposition: "blocked", independentCheckRequired: true });
      expect(captureRecordTree(workspaceStateDir(root))).toEqual(before);
      for (const patch of [{ failureHash: h("wrong") }, { scopeHash: h("wrong") }, { authorizationRef: scope.authorizationRef }, { authorizedAt: "2000-01-01T00:00:00.000Z" }])
        await expect(runIdentityConsumerRevalidation({ ...args, recoverTransportRetry: { ...request, ...patch }, inspectExecution: true })).rejects.toThrow();
      const transcript = await fs.readFile(failure.sessionFile, "utf8"), entries = transcript.trimEnd().split("\n").map(line => JSON.parse(line));
      const rawRequests = await fs.readFile(path.join(workDirectory, "consumer-revalidation.requests.jsonl"), "utf8");
      const rawMessages = await fs.readFile(path.join(workDirectory, "consumer-revalidation.messages.jsonl"), "utf8");
      const input = JSON.parse(await fs.readFile(path.join(workDirectory, "consumer-revalidation.input.json"), "utf8"));
      const submitted = JSON.parse(await fs.readFile(path.join(workDirectory, "consumer-revalidation.proposal.json"), "utf8"));
      const record = { sessionId: failure.sessionId, provider: "openai-codex" as const, model: "gpt-6.1-sol" as const, output: submitted };
      const proposalCalls = additionalEvidence ? 5 : 3;
      expect(verifyIdentitySessionEvidence(transcript, root, record, JSON.stringify(input), rawRequests, rawMessages, workPlans.consumerWorkContract, true).transcript.responses).toBe(proposalCalls);
      expect(() => verifyIdentitySessionEvidence(transcript, root, record, JSON.stringify(input), rawRequests, rawMessages, workPlans.consumerWorkContract)).toThrow(/context edit/);
      for (const patch of [{ replacement: { content: "rewritten" } }, { targetId: entries.find(e => e.message?.role === "user").id }]) {
        const changed = entries.map(e => e.type === "context_edit" ? { ...e, ...patch } : e);
        expect(() => verifyIdentitySessionEvidence(changed.map(e => JSON.stringify(e)).join("\n") + "\n", root, record,
          JSON.stringify(input), rawRequests, rawMessages, workPlans.consumerWorkContract, true)).toThrow(/context edit/);
      }
      const actualEvents = await new TraceStore(root).peekEvents(request.failedTraceRunId);
      const failedResponse = actualEvents.find(e => e.type === "llm.response.failed")!;
      expect(actualEvents.some(e => e.callId === failedResponse.callId && e.type.startsWith("tool."))).toBe(false);
      for (const callId of [failedResponse.callId, "incorrectly-associated-request"]) {
        const startedTool = { ...failedResponse, type: "tool.call.started" as const,
          callId, data: { toolName: "submit_consumer_revalidation" } };
        const executed = vi.spyOn(TraceStore.prototype, "peekEvents").mockResolvedValue([...actualEvents, startedTool]);
        await expect(runIdentityConsumerRevalidation({ ...recovery, inspectExecution: true })).rejects.toThrow(/exact original trace/);
        executed.mockRestore();
      }
      const traceSpy = vi.spyOn(TraceStore.prototype, "peekEvents").mockResolvedValue(actualEvents.filter(e => e.type !== "llm.retry"));
      await expect(runIdentityConsumerRevalidation({ ...recovery, inspectExecution: true })).rejects.toThrow(/exact original trace/);
      traceSpy.mockRestore();
      interruptRecovery = true;
      await expect(runIdentityConsumerRevalidation(recovery)).rejects.toThrow("recovery registration interruption");
      expect(dispatch).toHaveBeenCalledTimes(1);
      const result = await runIdentityConsumerRevalidation(recovery);
      expect(result).toMatchObject({ status: "blocked", cumulative: { modelCalls: 179 + proposalCalls }, parentResumeAllowed: false, certificationGranted: false });
      expect(dispatch).toHaveBeenCalledTimes(2); expect(providers.map(p => p.contexts.length)).toEqual([proposalCalls, 2]);
      expect(previous[0]!.output).toEqual(submitted);
      expect(await fs.readFile(failureFile, "utf8")).toBe(originalFailure);
      expect(await fs.readFile(path.join(workDirectory, "consumer-revalidation.budget.json"), "utf8")).toBe(originalBudget);
      expect((await new TraceStore(root).peekRun(request.failedTraceRunId)).status).toBe("failed");
      const again = await runIdentityConsumerRevalidation(recovery);
      expect(again.cumulative).toEqual(result.cumulative); expect(dispatch).toHaveBeenCalledTimes(2);
      await fs.appendFile(failure.sessionFile, '{"tampered":true}\n');
      await expect(runIdentityConsumerRevalidation(recovery)).rejects.toThrow(/changed|lost/);
      expect(dispatch).toHaveBeenCalledTimes(2); return;
    }
    if (stall || previewLoop || quota) {
      await expect(runIdentityConsumerRevalidation(args)).rejects.toThrow(quota ? /usage limit/ : /no new validated progress/);
      const before = captureRecordTree(workspaceStateDir(root));
      expect(await runIdentityConsumerRevalidation({ ...args, inspectExecution: true })).toMatchObject({ status: quota ? "external-wait" : "no-progress", execution: { modelDispatchAllowed: false, invocationConsumed: true } });
      expect(captureRecordTree(workspaceStateDir(root))).toEqual(before);
      await expect(runIdentityConsumerRevalidation(args)).rejects.toThrow(/stage is consumed/);
      expect(dispatch).toHaveBeenCalledTimes(1); expect(previous).toEqual([]);
      const attempts = await inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, previous);
      expect(attempts[0]!.stages[0]!.execution).toMatchObject({ status: quota ? "external-wait" : "no-progress", usage: { modelCalls: quota ? 1 : previewLoop ? 13 : 12 } });
      expect(attempts[0]!.cumulative.modelCalls).toBe(177 + (quota ? 1 : previewLoop ? 13 : 12)); return;
    }
    await expect(runIdentityConsumerRevalidation(args)).rejects.toThrow("injected registration interruption");
    expect(dispatch).toHaveBeenCalledTimes(1);
    if (bindingIssue && bindingIssue !== "once") {
      await expect(runIdentityConsumerRevalidation(args)).rejects.toThrow(/correction allowance exhausted|changed its original scope|terminal submission failed/);
      expect(previous).toHaveLength(1);
      expect(await runIdentityConsumerRevalidation({ ...args, inspectExecution: true })).toMatchObject({ execution: { invocationConsumed: true, modelDispatchAllowed: false } });
      await expect(runIdentityConsumerRevalidation(args)).rejects.toThrow(/stage is consumed/);
      expect(dispatch).toHaveBeenCalledTimes(2); return;
    }
    if (bindingRecovery) {
      await expect(runIdentityConsumerRevalidation(args)).rejects.toThrow(/lost the exact consumer time\/scope contract/);
      expect(previous).toHaveLength(1);
      legacyPlans!.mockRestore();
      const originalDirectory = consumerWorkDirectory(directory), retained = captureRecordTree(originalDirectory), proposalHash = h(previous[0]);
      const failedBudget = JSON.parse(await fs.readFile(path.join(originalDirectory, "consumer-revalidation-check.budget.json"), "utf8"));
      expect(failedBudget.state.usage.modelCalls).toBe(1);
      const repair = { ...args, recoverContractBinding: true, bindingRecoveryAuthorizationRef: "user:repair-exact-binding" };
      const before = captureRecordTree(workspaceStateDir(root));
      await expect(runIdentityConsumerRevalidation({ ...args, recoverContractBinding: true, inspectExecution: true })).rejects.toThrow(/explicit later repair authorization/);
      expect(await runIdentityConsumerRevalidation({ ...repair, inspectExecution: true })).toMatchObject({ status: "ready", cumulative: { modelCalls: 180 } });
      expect(captureRecordTree(workspaceStateDir(root))).toEqual(before);
      const failurePath = path.join(originalDirectory, "consumer-revalidation-check.failure.json"), oldFailure = await fs.readFile(failurePath, "utf8");
      await fs.writeFile(failurePath, JSON.stringify({ ...JSON.parse(oldFailure), reason: "different failure" }));
      await expect(runIdentityConsumerRevalidation({ ...repair, inspectExecution: true })).rejects.toThrow();
      await fs.writeFile(failurePath, oldFailure);
      const planPath = path.join(originalDirectory, "consumer-revalidation-check.plan.json"), oldPlan = await fs.readFile(planPath, "utf8");
      const plan = JSON.parse(oldPlan); plan.limits.maxModelCalls += 1;
      await fs.writeFile(planPath, JSON.stringify(plan));
      await expect(runIdentityConsumerRevalidation({ ...repair, inspectExecution: true })).rejects.toThrow();
      await fs.writeFile(planPath, oldPlan);
      recovering = true;
      if (bindingRecovery === "fail") {
        await expect(runIdentityConsumerRevalidation(repair)).rejects.toThrow(/correction allowance exhausted/);
        await expect(runIdentityConsumerRevalidation(repair)).rejects.toThrow(/stage is consumed/);
        expect(previous).toHaveLength(1); expect(dispatch).toHaveBeenCalledTimes(3);
      } else {
        interruptRecovery = bindingRecovery === "interrupt";
        if (interruptRecovery) await expect(runIdentityConsumerRevalidation(repair)).rejects.toThrow("recovery registration interruption");
        expect((await runIdentityConsumerRevalidation(repair)).status).toBe("revalidated");
        expect(previous).toHaveLength(2); expect(previous[1]!.bindingRecoveryHash).toMatch(/^[a-f0-9]{64}$/);
        // Historical verification does not consult a later changed world HEAD.
        vi.mocked(revalidation.prepareConsumerRevalidation).mockRejectedValue(new Error("later dependency changed"));
        await revalidation.verifyConsumerRevalidationRecord(root, previous[1]!);
        vi.mocked(revalidation.prepareConsumerRevalidation).mockResolvedValue(p);
        const completed = await runIdentityConsumerRevalidation(args);
        expect(completed.cumulative.modelCalls).toBe(182); expect(dispatch).toHaveBeenCalledTimes(3);
      }
      expect(h(previous[0])).toBe(proposalHash);
      const after = captureRecordTree(originalDirectory);
      for (const [file, hash] of Object.entries(retained)) expect(after[file]).toEqual(hash);
      const recoveryDirectory = bindingRecoveryDirectory(originalDirectory), recovery = JSON.parse(await fs.readFile(path.join(recoveryDirectory, "recovery.json"), "utf8"));
      expect(recovery.limits).toEqual({ ...failedBudget.limits, maxModelCalls: 11, maxTotalPayloadBytes: failedBudget.limits.maxTotalPayloadBytes - failedBudget.state.usage.totalPayloadBytes });
      expect(recovery.priorUsage).toEqual(failedBudget.cumulative);
      const budget = JSON.parse(await fs.readFile(path.join(recoveryDirectory, "consumer-revalidation-check.budget.json"), "utf8"));
      expect(budget.policy).toEqual(workPlans.consumerReviewRecoveryBudgetPolicy); expect(budget.state.progress).toBeUndefined();
      const attempts = await inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, previous);
      expect(attempts[0]!.cumulative.modelCalls).toBe(bindingRecovery === "fail" ? 181 : 182);
      expect(attempts[0]!.stages[1]!.execution!.status).toBe("host-review");
      expect(attempts[0]!.stages[1]!.bindingRecovery!.status).toBe(bindingRecovery === "fail" ? "BREAK" : "sealed");
      return;
    }
    const result = await runIdentityConsumerRevalidation(args);
    expect(result.status).toBe(cleared ? "revalidated" : "blocked"); expect(result.parentResumeAllowed).toBe(false);
    if (scoped) {
      const status = identityReviewStatus(f.original, previous);
      expect(status.consumerRevalidation).toMatchObject({ sourceAuditResumeAllowed: false, recordedClearedConsumers: cleared ? 1 : 0,
        totalConsumers: 2, reviews: [{ retainedQuestionIds: f.f.inventory.originalQuestionIds }] });
      expect(status.parentResumeAllowed).toBe(false);
    }
    expect(result.cumulative.modelCalls).toBe(additionalEvidence ? 185 : bindingIssue === "once" || transportTerminal ? 182 : discoveryOnly ? 185 : 181); expect(dispatch).toHaveBeenCalledTimes(2);
    const again = await runIdentityConsumerRevalidation(args);
    expect(again.cumulative).toEqual(result.cumulative); expect(dispatch).toHaveBeenCalledTimes(2);
    if (preflightRemeasure) {
      expect(await fs.readFile(oldPreflight, "utf8")).toBe(oldPreflightBytes);
      const wire = JSON.parse(await fs.readFile(path.join(consumerWorkDirectory(directory), "consumer-revalidation.preflight-message-v1.json"), "utf8"));
      expect(wire).toMatchObject({ measurementPolicy: "pi-message-context/v1", status: "ready", transport: { dictionaryProfile: "message/v1" } });
      const calls = providers.map(p => p.contexts.length);
      expect(await runIdentityConsumerRevalidation({ ...args, inspectExecution: true })).toMatchObject({ status: result.status });
      expect(providers.map(p => p.contexts.length)).toEqual(calls);
    }
    const oldStates = await fs.readdir(path.join(directory, "history"));
    expect((await Promise.all(oldStates.map(n => fs.readFile(path.join(directory, "history", n), "utf8")))).some(s => s.includes("injected registration interruption"))).toBe(true);
    if (work) {
      const attempts = await inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, previous);
      expect(attempts[0]!.cumulative).toEqual(result.cumulative);
      expect(attempts[0]!.stages[0]!.execution).toMatchObject({ policy: "consumer-work/v1", status: "sealed", draftCount: 1, usage: { modelCalls: additionalEvidence ? 6 : transportTerminal ? 3 : 2 } });
      // A later world repair may make new dispatch preparation unavailable.
      // Already accepted historical reviews still verify from immutable source,
      // their exact ledger record and sealed packet, without consulting HEAD.
      vi.mocked(revalidation.prepareConsumerRevalidation).mockRejectedValue(new Error("later active dependency changed"));
      await revalidation.verifyConsumerRevalidationRecord(root, previous[0]!);
      await revalidation.verifyConsumerRevalidationRecord(root, previous[1]!);
      vi.mocked(revalidation.prepareConsumerRevalidation).mockResolvedValue(p);
    }
    const checkpoint = JSON.parse(await fs.readFile(path.join(work ? consumerWorkDirectory(directory) : directory, "consumer-revalidation.session-checkpoint.json"), "utf8"));
    await fs.appendFile(checkpoint.sessionFile, '{"tampered":true}\n');
    await expect(runIdentityConsumerRevalidation(args)).rejects.toThrow(/transcript|changed/);
    expect(dispatch).toHaveBeenCalledTimes(2);
  } finally { for (const p of providers) await p.host.session.dispose(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); }
});

// The 23-turn case persists real Pi transcripts and repeatedly verifies them;
// allow disk/CPU contention in the full suite without timing out its cleanup.
it.each([{ failedCalls: 2 }, { failedCalls: 3 }, { failedCalls: 23 }, { failedCalls: 2, rejectedRef: true }, { failedCalls: 1, quotaRefusal: true }, { failedCalls: 2, dependencyRefs: true },
  { failedCalls: 2, hostRepair: "source-search-contract" as const }, { failedCalls: 2, hostRepair: "request-size" as const },
  { failedCalls: 2, hostRepair: "source-search-contract" as const, failHost: true },
  { failedCalls: 2, hostRepair: "source-search-contract" as const, hostQuota: true },
  { failedCalls: 2, hostRepair: "request-size" as const, hostQuota: true },
  { failedCalls: 2, hostRepair: "source-search-contract" as const, hostQuota: true, failResumption: true },
  { failedCalls: 24, migrateWork: true }, { failedCalls: 24, migrateWork: true, exhaust: true },
  { failedCalls: 2, dependencyRefs: true, migrateWork: true }, { failedCalls: 1, quotaRefusal: true, migrateWork: true },
])("continues a never-submitted Pi stage with retained charges $failedCalls, ref recovery $rejectedRef, quota refusal $quotaRefusal, dependency handoff $dependencyRefs and host repair $hostRepair (failure $failHost, host quota $hostQuota, resumed failure $failResumption, migration $migrateWork, call stop $exhaust)", async ({ failedCalls, rejectedRef, quotaRefusal, dependencyRefs, hostRepair, failHost, hostQuota, failResumption, migrateWork, exhaust }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-unsubmitted-consumer-")), providers: Awaited<ReturnType<typeof mockPiProvider>>[] = [];
  try {
    const source = await createEvidenceFixture(root, "Ada waits."), f0 = fixture();
    const f: ReturnType<typeof fixture> = JSON.parse(JSON.stringify(f0).replaceAll("src", source.source.id).replaceAll('"seg"', JSON.stringify(source.segmentId)).replaceAll(f0.f.intent.sourceHash, source.source.contentSha256));
    const scope = f.proposal.scope; scope.identityIntentHash = h(f.f.intent); scope.definitionHash = h(f.original[0]!.output);
    const originalBudget = path.join(root, "inherited-budget.json"); await fs.writeFile(originalBudget, JSON.stringify({ retainedCalls: 177 }));
    scope.priorBudgetFiles = [{ path: originalBudget, hash: h({ retainedCalls: 177 }) }];
    f.proposal.output.scopeHash = h(scope);
    if (f.proposal.output.phase !== "consumer-revalidation") throw Error("fixture");
    f.proposal.output.initialWorldRepair = null; f.proposal.output.disposition = "blocked";
    const correctionPredecessor: ConsumerRevalidationRecord[] = [];
    if (rejectedRef) {
      scope.currentRevisionHash = h({}); f.proposal.output.currentRevisionHash = scope.currentRevisionHash; f.proposal.output.scopeHash = h(scope);
      const negative = structuredClone(f.proposal), checked = structuredClone(f.check);
      checked.scope = negative.scope; checked.predecessorRecordHash = h(negative);
      if (checked.output.phase !== "consumer-revalidation-check") throw Error("fixture");
      checked.output.scopeHash = h(negative.scope); checked.output.proposalHash = h(negative.output);
      correctionPredecessor.push(negative, checked);
      const oldDir = consumerRevalidationDirectory(root, negative.scope); await fs.mkdir(oldDir, { recursive: true });
      await fs.writeFile(path.join(oldDir, "scope.json"), JSON.stringify(negative.scope));
      scope.priorBudgetFiles = [...scope.priorBudgetFiles];
      for (const [i, stage] of ["consumer-revalidation", "consumer-revalidation-check"].entries()) {
        const file = path.join(oldDir, `${stage}.budget.json`), budget = { scopeHash: h(negative.scope), stage,
          originalBudgetHash: scope.originalBudgetHash, limits: IDENTITY_REQUIREMENT_LIMITS,
          state: { blocked: false, usage: { modelCalls: 7 + i, totalPayloadBytes: 1_000_000 } } };
        await fs.writeFile(file, JSON.stringify(budget)); scope.priorBudgetFiles.push({ path: file, hash: h(budget) });
      }
      scope.priorUsage = { modelCalls: 192, totalPayloadBytes: scope.priorUsage.totalPayloadBytes + 2_000_000 };
      scope.compilerCorrection = { policy: SOURCE_LOCAL_CORRECTION, predecessorId: consumerRevalidationId(negative.scope), predecessorScopeHash: h(negative.scope),
        predecessorRecordHashes: [h(negative), h(checked)], contractHash: await sourceLocalContractHash() };
      f.proposal.output.scopeHash = h(scope); f.proposal.output.disposition = "repair-required";
      const readableRefs = [{ kind: "entity", id: "ada", revisionHash: h({ id: "ada" }) }, { kind: "initial-world", id: "singleton", revisionHash: h({}) }];
      f.proposal.output.entityRepair = { ref: "entity:ada", revisionHash: h({ id: "ada" }), pointers: ["/identityConsumption"], mode: "source-local", readableRefs,
        segmentIds: [source.segmentId], requiredAction: "Keep identity unresolved, revise only the original local referent capability." };
      f.proposal.output.initialWorldRepair = { pointers: ["/delta"], readableRefs, segmentIds: [source.segmentId], requiredAction: "Repair only the original opening contract." };
    }
    const directory = consumerRevalidationDirectory(root, scope), previous: ConsumerRevalidationRecord[] = [];
    const manifest = await new SegmentStore(root).readManifest(source.source.id);
    const p: any = { scope, directory, original: f.original, previous,
      catalog: [{ kind: "entity", id: "ada", revisionHash: h({ id: "ada" }), payload: { id: "ada" }, current: true }],
      consumer: { ref: scope.ref, revisionHash: scope.originalRevisionHash, payload: {} }, current: { payload: {}, revisionHash: scope.currentRevisionHash },
      correctionPredecessor, acceptance: { output: {} }, prepared: { ...f.f.p, intent: f.f.intent, inventory: f.f.inventory,
        bytes: Buffer.from("Ada waits."), manifest, review: { scope: { questions: [] } } } };
    const failedRefs = dependencyRefs ? ["event/arrival", `initial/${scope.sourceId}`, "norm/rule", `roster/${scope.sourceId}`] : ["entity/ada"];
    let rosterPageCount = 0;
    if (dependencyRefs) {
      const roster = { sourceId: scope.sourceId, sourceSha256: scope.sourceHash,
        unitIds: Array.from({ length: 11000 }, (_, i) => `unit-sentence-${h(i).slice(0, 24)}`), candidates: [{ id: "role-ada" }] };
      p.prepared.review.priorRoster = roster;
      for (const [kind, id] of [["initial-world", "singleton"], ["canonical-event", "arrival"], ["norm-template", "rule"]])
        p.catalog.push({ kind, id, payload: { id }, revisionHash: h({ id }), current: true });
      for (const ref of failedRefs) {
        const payload: any = ref.startsWith("roster/") ? roster : { id: ref };
        f.f.inventory.consumers.push({ ref, payload, revisionHash: h(payload), reason: "typed-consumer", dependencies: [] });
      }
      p.consumer.dependencies = failedRefs.map(ref => { const [kind, id] = ref.split("/"); return { kind, id }; });
      f.f.intent.inventoryHash = h(f.f.inventory);
      for (const [i, record] of f.original.entries()) {
        record.intent = f.f.intent; record.output.intentHash = h(f.f.intent);
        if ("proposalHash" in record.output) record.output.proposalHash = h(f.original[0]!.output);
        record.predecessorRecordHash = i ? h(f.original[i - 1]) : null;
      }
      scope.inventoryHash = h(f.f.inventory); scope.identityIntentHash = h(f.f.intent); scope.definitionHash = h(f.original[0]!.output);
      f.proposal.output.scopeHash = h(scope);
    }
    if (rejectedRef) {
      p.catalog.push({ kind: "initial-world", id: "singleton", revisionHash: h({}), payload: {}, current: true });
      p.receipt = { state: "completed", fingerprint: scope.receiptFingerprint, identity: { upstreamRepairIntent: { proposals: [{ artifactKind: "entity", artifactId: "ada", payloadHash: h({ id: "ada" }) }] } } };
      vi.spyOn(UpstreamRepairLedger.prototype, "inspect").mockResolvedValue({ plans: [{ plan: { planHash: scope.upstreamPlanHash, batchId: "accepted-original" } }] } as any);
      vi.spyOn(CompilerFinishReceipts.prototype, "read").mockImplementation(async () => p.receipt);
    }
    const base = identityRequirementDirectory(root, scope.sourceId, scope.taskId); await fs.mkdir(base, { recursive: true });
    await fs.writeFile(path.join(base, "context.json"), JSON.stringify(p.prepared));
    vi.spyOn(revalidation, "prepareConsumerRevalidation").mockResolvedValue(p);
    const findArtifact = revalidation.findConsumerArtifact;
    const originalReadMode = readContract.assertConsumerReadMode;
    vi.spyOn(readContract, "assertConsumerReadMode").mockImplementation(args => {
      if (hostRepair === "source-search-contract" && providers.length === 1 && args.collection === "source" && args.query) throw Error(oldSourceSearchError);
      return originalReadMode(args);
    });
    vi.spyOn(revalidation, "findConsumerArtifact").mockImplementation((catalog, ref) => providers.length === 1 && ref === "entity/ada"
      ? undefined : findArtifact(catalog, ref));
    vi.spyOn(retainedState, "assertConsumerRepairRetainedState").mockResolvedValue();
    vi.spyOn(RequirementLedger.prototype, "identityRequirements").mockResolvedValue(f.original);
    vi.spyOn(RequirementLedger.prototype, "history").mockImplementation(async () => [
      { payload: { kind: "identity-consumer-repair", record: { intent: { taskId: scope.taskId } } } },
      ...[...correctionPredecessor, ...previous].map(record => ({ payload: { kind: "identity-consumer-revalidation", record } })),
    ] as any);
    let interruptRegistration = true;
    vi.spyOn(RequirementLedger.prototype, "recordIdentityConsumerRevalidation").mockImplementation(async record => {
      await revalidation.verifyConsumerRevalidationRecord(root, record);
      if (interruptRegistration) { interruptRegistration = false; throw Error("interrupted continuation registration"); }
      if (!previous.some(r => r.output.phase === record.output.phase)) previous.push(record);
    });
    const realRuntime = ModelRuntime.create.bind(ModelRuntime);
    vi.spyOn(ModelRuntime, "create").mockImplementation(async options => options?.authPath === getAgentDir() + "/auth.json"
      ? { checkAuth: async () => ({ type: "oauth" }), getProvider: () => ({ auth: { oauth: { isSubscription: true } } }), getModel: () => ({}) } as any : realRuntime(options));
    const create = PiAgentSession.create.bind(PiAgentSession);
    const dispatch = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
      const first = providers.length === 0, check = path.basename(options.runtimeDir!) === "consumer-revalidation-check";
      const hostResume = options.runtimeDir!.includes(`consumer-revalidation.host-recovery${path.sep}consumer-revalidation.continuation`);
      const hostQuotaAttempt = hostQuota && !check && !hostResume && options.runtimeDir!.includes("consumer-revalidation.host-recovery");
      const session = await create({ ...options, model: undefined, piAgentDir: path.join(root, "pi"),
        ...(first && dependencyRefs ? { losslessJsonDictionaryProfile: undefined } : {}) });
      providers.push(await mockPiProvider(session, { provider: "openai-codex", modelId: "gpt-6.1-sol",
        ...((first && quotaRefusal) || hostQuotaAttempt ? { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } : {}), response: (_context, index) => {
        if (first) {
          if (hostRepair === "source-search-contract") return fauxAssistantMessage([
            fauxToolCall("read_consumer_revalidation", { collection: "source", query: index ? "waits" : "Ada", offset: 0 }, { id: `old-source-query-${index}` })
          ], { stopReason: "toolUse" });
          if (quotaRefusal) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Codex error: The usage limit has been reached" });
          if (!exhaust && index === failedCalls - 1) return fauxAssistantMessage([fauxText("The synthetic review has not submitted yet.")], { stopReason: "stop" });
          if (failedCalls === 3 && index === 1) return fauxAssistantMessage([
            fauxToolCall("read_consumer_revalidation", { collection: "source", segmentIds: [source.segmentId], offset: 0 }, { id: "old-source" }),
            fauxToolCall("read_consumer_revalidation", { collection: "consumer", refs: [scope.ref], offset: 0 }, { id: "old-consumer" }),
            fauxToolCall("read_consumer_revalidation", { collection: "artifacts", refs: ["entity:ada"], offset: 0 }, { id: "old-artifact" }),
          ], { stopReason: "toolUse" });
          // Simulate the former slash-ref reader bug. Its failure allowance remains consumed.
          return fauxAssistantMessage([fauxToolCall("read_consumer_revalidation", index === 0
            ? { collection: "artifacts", refs: failedRefs, offset: 0 }
            : { collection: "consumer", refs: [scope.ref], offset: 0 }, { id: `failed-session-read-${index}` })], { stopReason: "toolUse" });
        }
        const output = check ? { ...f.check.output, scopeHash: h(scope), proposalHash: h(previous[0]!.output) } : f.proposal.output;
        if (migrateWork) {
          if (index > 1) throw Error("Work migration unexpectedly rereads or loops");
          return fauxAssistantMessage([fauxToolCall(index ? "submit_consumer_revalidation" : "preview_consumer_revalidation", output,
            { id: `migrated-${check}-${index}` })], { stopReason: "toolUse" });
        }
        if (hostQuotaAttempt) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Codex error: The usage limit has been reached" });
        if (hostResume && failResumption) return fauxAssistantMessage([fauxText("This one-time provider resumption did not submit.")], { stopReason: "stop" });
        if (failHost) return fauxAssistantMessage([fauxText("No submission in this single-use recovery.")], { stopReason: "stop" });
        if (hostRepair === "request-size" && providers.length === 2) return fauxAssistantMessage([
          fauxToolCall("read_consumer_revalidation", { collection: "artifacts", refs: [`entity:large-${index}`], offset: 0 }, { id: `oversized-read-${index}` })
        ], { stopReason: "toolUse" });
        if (dependencyRefs) {
          if (index > rosterPageCount) throw Error("Unexpected dependency continuation retry");
          const calls = index === rosterPageCount ? [fauxToolCall("submit_consumer_revalidation", output, { id: `paged-submit-${check}` })]
            : [fauxToolCall("read_consumer_revalidation", { collection: "artifacts", refs: [`role-roster:${scope.sourceId}`], offset: index }, { id: `roster-page-${index}-${check}` })];
          if (index === 0) calls.unshift(
            fauxToolCall("read_consumer_revalidation", { collection: "source", segmentIds: [source.segmentId], offset: 0 }, { id: `fresh-source-${check}` }),
            fauxToolCall("read_consumer_revalidation", { collection: "consumer", refs: [scope.ref], offset: 0 }, { id: `fresh-consumer-${check}` }),
            fauxToolCall("read_consumer_revalidation", { collection: "artifacts", refs: ["canonical-event:arrival", "initial-world:singleton", "norm-template:rule"], offset: 0 }, { id: `fresh-dependencies-${check}` }));
          return fauxAssistantMessage(calls, { stopReason: "toolUse" });
        }
        if (index > 1) throw Error("Unexpected continuation retry");
        if (failedCalls === 3) return index === 0
          ? fauxAssistantMessage([fauxToolCall("submit_consumer_revalidation", output, { id: "invalid-reuse-of-old-reads" })], { stopReason: "toolUse" })
          : fauxAssistantMessage([fauxText("No valid fresh submission.")], { stopReason: "stop" });
        return fauxAssistantMessage(index === 0 ? [
          ...(hostRepair === "request-size" ? [0, 1, 2, 3].map(i => fauxToolCall("read_consumer_revalidation",
            { collection: "artifacts", refs: [`entity:large-${i}`], offset: 0 }, { id: `recovery-large-${i}-${check}` })) : []),
          fauxToolCall("read_consumer_revalidation", { collection: "source", segmentIds: [source.segmentId], offset: 0 }, { id: `fresh-source-${check}` }),
          fauxToolCall("read_consumer_revalidation", { collection: "consumer", refs: [scope.ref], offset: 0 }, { id: `fresh-consumer-${check}` }),
          fauxToolCall("read_consumer_revalidation", { collection: "artifacts", refs: rejectedRef ? ["entity:ada", "initial-world:singleton"] : ["entity:ada"], offset: 0 }, { id: `fresh-artifact-${check}` }),
        ] : [fauxToolCall("submit_consumer_revalidation", output, { id: `fresh-submit-${check}` })], { stopReason: "toolUse" });
      } })); return session;
    });
    const args: Parameters<typeof runIdentityConsumerRevalidation>[0] = { root, sourceId: scope.sourceId, taskId: scope.taskId, ref: scope.ref, authorizationRef: scope.authorizationRef };
    await expect(runIdentityConsumerRevalidation(args)).rejects.toThrow(hostRepair === "source-search-contract" ? /query is for artifacts discovery only/ : quotaRefusal ? /usage limit/ : exhaust ? /model-call limit/ : /without a revalidation submission/);
    expect(dispatch).toHaveBeenCalledTimes(1);
    if (hostRepair) {
      if (hostRepair === "request-size") {
        for (let i = 0; i < 4; i++) {
          const payload = { id: `large-${i}`, evidence: h(`unique-large-payload-${i}`).repeat(2300) };
          p.catalog.push({ kind: "entity", id: payload.id, revisionHash: h(payload), payload });
        }
        await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" })).rejects.toThrow(/request requires/);
      }
      const failedDirectory = hostRepair === "request-size" ? consumerStageRecoveryDirectory(directory, "consumer-revalidation") : directory;
      const failure = JSON.parse(await fs.readFile(path.join(failedDirectory, "consumer-revalidation.failure.json"), "utf8"));
      const runs = await new TraceStore(root).peekRunsByOperation(scope.sourceId, `receipt-bound-${h(scope)}-consumer-revalidation${hostRepair === "request-size" ? "-continuation" : ""}`);
      await new Promise(resolve => setTimeout(resolve, 2));
      args.hostRecovery = { scopeHash: h(scope), stage: "consumer-revalidation", failedTraceRunId: runs[0]!.id, failureHash: h(failure),
        cause: hostRepair, authorizationRef: "user:repair-original-reader-and-budget", authorizedAt: new Date().toISOString(),
        maxRequestBytes: hostRepair === "request-size" ? 1_024_000 : 512_000 };
      const oldState = captureRecordTree(workspaceStateDir(root)); let oldCalls = dispatch.mock.calls.length;
      const preview = await runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect" });
      expect(preview).toMatchObject({ status: "host-recovery-ready", parentResumeAllowed: false, certificationGranted: false });
      expect(captureRecordTree(workspaceStateDir(root))).toEqual(oldState);
      expect(dispatch).toHaveBeenCalledTimes(oldCalls);
      const plan = (preview as any).recovery;
      expect(plan.proposalLimits.maxModelCalls).toBe(24 - (plan.priorUsage.modelCalls - scope.priorUsage.modelCalls));
      expect(plan.proposalLimits.maxTotalPayloadBytes).toBe(12_288_000 - (plan.priorUsage.totalPayloadBytes - scope.priorUsage.totalPayloadBytes));
      expect(plan.repairedReadFailures).toBe(hostRepair === "source-search-contract" ? 2 : 0);
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect", hostRecovery: { ...args.hostRecovery, failureHash: h("wrong") } })).rejects.toThrow(/exact settled failure/);
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect", hostRecovery: { ...args.hostRecovery, authorizedAt: "2020-01-01T00:00:00.000Z" } })).rejects.toThrow(/later user authorization/);
      if (hostRepair === "request-size") await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect",
        hostRecovery: { ...args.hostRecovery, maxRequestBytes: 512_000 } })).rejects.toThrow(/bounded increase/);
      let quotaPlan: any;
      if (hostQuota) {
        await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" })).rejects.toThrow(/usage limit/);
        expect(dispatch).toHaveBeenCalledTimes(++oldCalls);
        const stopped = captureRecordTree(workspaceStateDir(root));
        await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect" })).rejects.toThrow(/sole host recovery is consumed/);
        const attempts = await inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, previous);
        const failedTraceRunId = attempts[0]!.stages[0]!.hostRecovery!.traceRunId!;
        expect(failedTraceRunId).toBeTruthy();
        await new Promise(resolve => setTimeout(resolve, 2));
        args.providerResumption = { scopeHash: h(scope), stage: "consumer-revalidation", failedTraceRunId,
          authorizationRef: "user:continue-after-host-quota-cleared", authorizedAt: new Date().toISOString() };
        for (const authorizationRef of [scope.authorizationRef, args.hostRecovery.authorizationRef])
          await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect", providerResumption: { ...args.providerResumption, authorizationRef } })).rejects.toThrow(/later.authoriz|later user authorization/);
        await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect", providerResumption: { ...args.providerResumption, failedTraceRunId: "another-failure" } })).rejects.toThrow(/settled trace or later authorization/);
        const preview = await runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect" });
        expect(preview).toMatchObject({ status: "ready", continuation: { remainingAllowance: { maxModelCalls: plan.proposalLimits.maxModelCalls - 1,
          maxRequestBytes: plan.proposalLimits.maxRequestBytes } }, cumulative: { modelCalls: plan.priorUsage.modelCalls + 1 } });
        expect(captureRecordTree(workspaceStateDir(root))).toEqual(stopped);
        if (failResumption) {
          await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" })).rejects.toThrow(/without a revalidation submission/);
          const stoppedAgain = captureRecordTree(workspaceStateDir(root));
          await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect" })).rejects.toThrow(/sole provider resumption is consumed/);
          expect(captureRecordTree(workspaceStateDir(root))).toEqual(stoppedAgain);
          await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" })).rejects.toThrow(/sole provider resumption is consumed/);
          expect(dispatch).toHaveBeenCalledTimes(oldCalls + 1);
          expect(previous).toEqual([]);
          const attempts = await inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, previous);
          expect(attempts[0]!.stages[0]!.hostRecovery!.providerResumption).toMatchObject({ status: "BREAK", usage: { modelCalls: 1 } });
          return;
        }
      }
      // The original proposal seals before ledger registration is interrupted.
      if (failHost) {
        await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" })).rejects.toThrow(/without a revalidation submission/);
        const stopped = captureRecordTree(workspaceStateDir(root));
        await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect" })).rejects.toThrow(/sole host recovery is consumed/);
        expect(captureRecordTree(workspaceStateDir(root))).toEqual(stopped);
        await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" })).rejects.toThrow(/sole host recovery is consumed/);
        expect(dispatch).toHaveBeenCalledTimes(oldCalls + 1);
        for (const file of plan.retainedFiles) expect(h(await fs.readFile(path.join(directory, file.path), "utf8"))).toBe(file.hash);
        return;
      }
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" })).rejects.toThrow("interrupted continuation registration");
      expect(dispatch).toHaveBeenCalledTimes(oldCalls + 1);
      const result = await runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" });
      expect(result).toMatchObject({ status: f.proposal.output.disposition, parentResumeAllowed: false, certificationGranted: false });
      expect(dispatch).toHaveBeenCalledTimes(oldCalls + 2);
      expect(previous).toHaveLength(2);
      expect(previous[0]!.hostRecoveryHash).toBe(previous[1]!.hostRecoveryHash);
      if (hostQuota) {
        const hostDirectory = consumerHostRecoveryDirectory(directory);
        quotaPlan = JSON.parse(await fs.readFile(path.join(consumerStageRecoveryDirectory(hostDirectory, "consumer-revalidation"), "continuation.json"), "utf8"));
        expect(previous[0]!.continuationHash).toBe(h(quotaPlan)); expect(previous[1]!.continuationHash).toBeUndefined();
        expect(quotaPlan.hostRecoveryHash).toBe(previous[0]!.hostRecoveryHash);
        for (const file of quotaPlan.retainedFiles) expect(h(await fs.readFile(path.join(hostDirectory, file.path), "utf8"))).toBe(file.hash);
        await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect", providerResumption: { ...args.providerResumption!, authorizationRef: "replace" } })).rejects.toThrow(/no repinning/);
        delete args.providerResumption;
      }
      for (const file of plan.retainedFiles) expect(h(await fs.readFile(path.join(directory, file.path), "utf8"))).toBe(file.hash);
      await revalidation.verifyConsumerRevalidationRecord(root, previous[0]!);
      await revalidation.verifyConsumerRevalidationRecord(root, previous[1]!);
      const attempts = await inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, previous);
      expect(attempts[0]!.cumulative).toEqual(result.cumulative);
      await runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" });
      expect(dispatch).toHaveBeenCalledTimes(oldCalls + 2);
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run", hostRecovery: { ...args.hostRecovery, authorizationRef: "replace" } })).rejects.toThrow(/replacement grant/);
      const recoveryFile = path.join(consumerHostRecoveryDirectory(directory), "recovery.json"), text = await fs.readFile(recoveryFile, "utf8"), changed = JSON.parse(text);
      changed.proposalLimits.maxModelCalls++;
      await fs.writeFile(recoveryFile, JSON.stringify(changed));
      await expect(revalidation.verifyConsumerRevalidationRecord(root, previous[0]!)).rejects.toThrow(/missing or changed/);
      await fs.writeFile(recoveryFile, text);
      const oldMessages = path.join(failedDirectory, "consumer-revalidation.messages.jsonl");
      await fs.appendFile(oldMessages, '{"tampered":true}\n');
      await expect(revalidation.verifyConsumerRevalidationRecord(root, previous[1]!)).rejects.toThrow();
      expect(dispatch).toHaveBeenCalledTimes(oldCalls + 2);
      return;
    }
    if (dependencyRefs) {
      p.catalog = consumerDependencyCatalog(p.catalog, scope, p.prepared.inventory, p.prepared.review.priorRoster);
      rosterPageCount = consumerArtifactPages(p.catalog.find((c: any) => c.kind === "role-roster")!).length;
      expect(rosterPageCount).toBeGreaterThan(1);
    }
    const stopped = captureRecordTree(directory), allState = captureRecordTree(workspaceStateDir(root));
    if (migrateWork) {
      const migration = { ...args, executionPolicy: "consumer-work/v1" as const, executionAuthorizationRef: "user:upgrade-original-execution-policy" };
      await expect(runIdentityConsumerRevalidation({ ...args, executionPolicy: "consumer-work/v1", inspectExecution: true })).rejects.toThrow(/explicit execution-policy migration authorization/);
      const inspected = await runIdentityConsumerRevalidation({ ...migration, inspectExecution: true });
      expect(inspected).toMatchObject({ status: "ready", migrated: true, cumulative: { modelCalls: 177 + failedCalls } });
      expect(dispatch).toHaveBeenCalledTimes(1); expect(captureRecordTree(workspaceStateDir(root))).toEqual(allState);
      await expect(runIdentityConsumerRevalidation(migration)).rejects.toThrow("interrupted continuation registration");
      expect(dispatch).toHaveBeenCalledTimes(2);
      const beforeInspect = captureRecordTree(workspaceStateDir(root));
      expect(await runIdentityConsumerRevalidation({ ...migration, inspectExecution: true })).toMatchObject({ status: "sealed" });
      expect(captureRecordTree(workspaceStateDir(root))).toEqual(beforeInspect); expect(dispatch).toHaveBeenCalledTimes(2);
      const result = await runIdentityConsumerRevalidation(migration);
      expect(result).toMatchObject({ status: "blocked", cumulative: { modelCalls: 177 + failedCalls + 4 }, parentResumeAllowed: false });
      expect(dispatch).toHaveBeenCalledTimes(3); expect(previous).toHaveLength(2);
      expect(previous.every(r => r.executionPlanHash && h(r.scope) === h(scope))).toBe(true);
      const plan = JSON.parse(await fs.readFile(path.join(consumerWorkDirectory(directory), "consumer-revalidation.plan.json"), "utf8"));
      for (const file of plan.retainedFiles) expect(h(await fs.readFile(file.path, "utf8"))).toBe(file.hash);
      const attempts = await inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, previous);
      expect(attempts[0]!.cumulative).toEqual(result.cumulative);
      const again = await runIdentityConsumerRevalidation(migration);
      expect(again.cumulative).toEqual(result.cumulative); expect(dispatch).toHaveBeenCalledTimes(3);
      await fs.appendFile(path.join(directory, "consumer-revalidation.messages.jsonl"), '{"tampered":true}\n');
      await expect(runIdentityConsumerRevalidation(migration)).rejects.toThrow(); expect(dispatch).toHaveBeenCalledTimes(3);
      return;
    }
    if (quotaRefusal) {
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect" })).rejects.toThrow(/later explicit host authorization/);
      const attempts = await inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, previous);
      const failedTraceRunId = attempts[0]!.stages[0]!.traceRunId!;
      expect(failedTraceRunId).toBeTruthy();
      await new Promise(resolve => setTimeout(resolve, 2));
      args.providerResumption = { scopeHash: h(scope), stage: "consumer-revalidation", failedTraceRunId,
        authorizationRef: "user:resume-after-quota-cleared", authorizedAt: new Date().toISOString() };
      const failure = JSON.parse(await fs.readFile(path.join(directory, "consumer-revalidation.failure.json"), "utf8"));
      const journalFile = path.join(directory, "consumer-revalidation.messages.jsonl");
      const transcriptText = await fs.readFile(failure.sessionFile, "utf8"), journalText = await fs.readFile(journalFile, "utf8");
      // Neither partial output nor a different failure can be relabeled as a
      // zero-output refusal, even if both message observations agree.
      const changes = [
        (m: any) => { m.content = [{ type: "text", text: "partial output" }]; },
        (m: any) => { m.usage.output = 1; },
        (m: any) => { m.errorMessage = "connection failed"; },
        (m: any) => { m.stopReason = "aborted"; },
        (m: any) => { m.content = [fauxToolCall("submit_consumer_revalidation", f.proposal.output)]; },
      ];
      for (const change of changes) {
        const rewrite = (text: string) => text.trimEnd().split("\n").map(line => {
          const row = JSON.parse(line); if (row.message?.role === "assistant") change(row.message); return JSON.stringify(row);
        }).join("\n") + "\n";
        await fs.writeFile(failure.sessionFile, rewrite(transcriptText)); await fs.writeFile(journalFile, rewrite(journalText));
        await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect" })).rejects.toThrow(/Quota continuation requires/);
        await fs.writeFile(failure.sessionFile, transcriptText); await fs.writeFile(journalFile, journalText);
      }
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect",
        providerResumption: { ...args.providerResumption, authorizationRef: scope.authorizationRef } })).rejects.toThrow(/later user authorization/);
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect",
        providerResumption: { ...args.providerResumption, failedTraceRunId: "wrong-trace" } })).rejects.toThrow(/settled trace or later authorization/);
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect",
        providerResumption: { ...args.providerResumption, authorizedAt: "2020-01-01T00:00:00.000Z" } })).rejects.toThrow(/settled trace or later authorization/);
    }
    const inspect = await runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect" });
    expect(captureRecordTree(directory)).toEqual(stopped);
    expect(captureRecordTree(workspaceStateDir(root))).toEqual(allState);
    expect(inspect).toMatchObject({ status: failedCalls === 23 ? "budget-blocked" : "ready",
      continuation: { minimumModelCalls: 2, remainingAllowance: { maxModelCalls: (rejectedRef ? 17 : 24) - failedCalls } }, cumulative: { modelCalls: (rejectedRef ? 192 : 177) + failedCalls } });
    const recovery = consumerStageRecoveryDirectory(directory, "consumer-revalidation");
    if (rejectedRef) {
      // Reproduce the old slash-only guard in an actual persisted Pi session.
      const oldGuard = vi.spyOn(revalidationModel, "consumerEntityRepairId").mockImplementation(ref => ref.startsWith("entity/") ? ref.slice(7) : undefined);
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" })).rejects.toThrow(/Source-local scope changed/);
      oldGuard.mockRestore(); expect(dispatch).toHaveBeenCalledTimes(2); expect(previous).toEqual([]);
      const retained = captureRecordTree(recovery), beforePreview = captureRecordTree(workspaceStateDir(root));
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect" })).rejects.toThrow(/sole unsubmitted continuation/);
      expect(await runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect", recoverSubmittedRef: true })).toMatchObject({ status: "ref-recovery-ready",
        cumulative: { modelCalls: 196 }, recovery: { disposition: "repair-required", providerCalls: 0, independentCheckRequired: true } });
      expect(captureRecordTree(workspaceStateDir(root))).toEqual(beforePreview);
      p.receipt.identity.upstreamRepairIntent.proposals[0].payloadHash = h("wrong accepted revision");
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect", recoverSubmittedRef: true })).rejects.toThrow(/exact original accepted receipt/);
      p.receipt.identity.upstreamRepairIntent.proposals[0].payloadHash = h({ id: "ada" });
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run", recoverSubmittedRef: true })).rejects.toThrow("interrupted continuation registration");
      expect(dispatch).toHaveBeenCalledTimes(2);
      const result = await runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" });
      expect(result.status).toBe("repair-required"); expect(result.cumulative.modelCalls).toBe(198);
      expect(dispatch).toHaveBeenCalledTimes(3); expect(previous).toHaveLength(2);
      expect(previous[0]!.refRecoveryHash).toMatch(/^[a-f0-9]{64}$/); expect(previous[0]!.sessionCheckpointHash).toBeUndefined();
      expect(previous[0]!.output).toEqual(f.proposal.output);
      expect(previous[1]!.sessionId).not.toBe(previous[0]!.sessionId);
      for (const [name, hash] of Object.entries(retained)) expect(captureRecordTree(recovery)[name]).toBe(hash);
      const attempts = await inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, [...correctionPredecessor, ...previous]);
      expect(attempts.find(a => a.compilerCorrection)!.stages[0]!.continuation).toMatchObject({ status: "recovered-submission", recoveredSubmission: true, sealedSubmission: false, usage: { modelCalls: 2 } });
      await runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run", recoverSubmittedRef: true });
      expect(dispatch).toHaveBeenCalledTimes(3);
      // Completed evidence remains verifiable after implementation/test edits.
      // That history does not authorize a new dispatch against changed code.
      const originalRead = fs.readFile.bind(fs);
      const changedCode = vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
        const value = await originalRead(...args);
        return String(args[0]).endsWith("/test/identity-consumption.test.ts") ? `${value}\n// later unrelated test` : value;
      }) as typeof fs.readFile);
      try {
        await expect(assertConsumerCompilerCorrection(previous[0]!.scope)).rejects.toThrow(/implementation changed/);
        await expect(revalidation.verifyConsumerRevalidationRecord(root, previous[0]!)).resolves.toBeUndefined();
        await expect(revalidation.verifyConsumerRevalidationRecord(root, previous[1]!)).resolves.toBeUndefined();
      } finally { changedCode.mockRestore(); }
      await expect(revalidation.verifyConsumerRevalidationRecord(root, { ...previous[0]!, refRecoveryHash: h("changed proof") })).rejects.toThrow(/recovery changed/);
      const messages = path.join(recovery, "consumer-revalidation.messages.jsonl"); await fs.appendFile(messages, '{"truncated":true}\n');
      await expect(revalidation.verifyConsumerRevalidationRecord(root, previous[0]!)).rejects.toThrow();
    } else if (failedCalls === 3) {
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" })).rejects.toThrow(/without a revalidation submission/);
      expect(previous).toEqual([]); expect(dispatch).toHaveBeenCalledTimes(2);
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" })).rejects.toThrow(/sole unsubmitted continuation/);
      expect(dispatch).toHaveBeenCalledTimes(2);
      const state = JSON.parse(await fs.readFile(path.join(directory, "state.json"), "utf8"));
      expect(state.cumulative.modelCalls).toBe(182);
      for (const [name, hash] of Object.entries(stopped).filter(([name]) => name !== "state.json" && !name.startsWith("history/")))
        expect(captureRecordTree(directory)[name]).toBe(hash);
    } else if (failedCalls === 23) {
      const result = await runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" });
      expect(result.status).toBe("budget-blocked"); expect(dispatch).toHaveBeenCalledTimes(1);
      expect(previous).toEqual([]);
      expect(await fs.readdir(recovery)).toEqual(expect.arrayContaining(["preflight.json", "continuation.json"]));
      await expect(fs.stat(path.join(recovery, "consumer-revalidation.invocation.json"))).rejects.toMatchObject({ code: "ENOENT" });
      for (const [name, hash] of Object.entries(stopped).filter(([name]) => name !== "state.json" && !name.startsWith("history/")))
        expect(captureRecordTree(directory)[name]).toBe(hash);
      const file = path.join(directory, "consumer-revalidation.budget.json"), saved = await fs.readFile(file, "utf8"), budget = JSON.parse(saved);
      budget.state.usage.modelCalls = 0; await fs.writeFile(file, JSON.stringify(budget));
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect" })).rejects.toThrow(/failure|charges|budget/);
      expect(dispatch).toHaveBeenCalledTimes(1);
      await fs.writeFile(file, saved);
      const originalPreflight = captureRecordTree(recovery), beforePreview = captureRecordTree(workspaceStateDir(root));
      const plan = JSON.parse(await fs.readFile(path.join(recovery, "continuation.json"), "utf8"));
      const budgetAmendment = { continuationHash: h(plan), stage: "consumer-revalidation" as const,
        additionalCalls: 7, authorizationRef: "user:later-explicit-bounded-call-authorization" };
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect",
        budgetAmendment: { ...budgetAmendment, continuationHash: h("foreign continuation") } })).rejects.toThrow(/exact budget-blocked/);
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect",
        budgetAmendment: { ...budgetAmendment, authorizationRef: scope.authorizationRef } })).rejects.toThrow(/later explicit authorization/);
      expect(await runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect", budgetAmendment })).toMatchObject({ status: "ready",
        continuation: { originalRemainingAllowance: { maxModelCalls: 1 }, remainingAllowance: { maxModelCalls: 8,
          maxRequestBytes: plan.limits.maxRequestBytes, maxTotalPayloadBytes: plan.limits.maxTotalPayloadBytes } } });
      expect(captureRecordTree(workspaceStateDir(root))).toEqual(beforePreview);
      expect(dispatch).toHaveBeenCalledTimes(1);
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run", budgetAmendment })).rejects.toThrow("interrupted continuation registration");
      expect(dispatch).toHaveBeenCalledTimes(2);
      const amended = await runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" });
      expect(amended.status).toBe("blocked"); expect(amended.cumulative.modelCalls).toBe(204);
      expect(dispatch).toHaveBeenCalledTimes(3); expect(previous).toHaveLength(2);
      expect(previous[0]!.budgetAmendmentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(previous[1]!.budgetAmendmentHash).toBeUndefined();
      const checkBudget = JSON.parse(await fs.readFile(path.join(directory, "consumer-revalidation-check.budget.json"), "utf8"));
      expect(checkBudget.limits.maxModelCalls).toBe(24);
      expect(checkBudget.priorUsage.modelCalls).toBe(202);
      const attempts = await inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, previous);
      expect(attempts[0]!.stages[0]).toMatchObject({ remainingAllowance: { modelCalls: 6 },
        continuation: { usage: { modelCalls: 2 }, preflight: { budgetAmendment: { additionalCalls: 7 }, originalRemainingAllowance: { maxModelCalls: 1 } } } });
      for (const [name, hash] of Object.entries(originalPreflight)) expect(captureRecordTree(recovery)[name]).toBe(hash);
      for (const retained of plan.retainedFiles) expect(h(await fs.readFile(path.join(directory, retained.path), "utf8"))).toBe(retained.hash);
      await runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run", budgetAmendment });
      expect(dispatch).toHaveBeenCalledTimes(3);
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect",
        budgetAmendment: { ...budgetAmendment, additionalCalls: 8 } })).rejects.toThrow(/one immutable/);
      const grantFile = path.join(recovery, "budget-amendment.json"), grantText = await fs.readFile(grantFile, "utf8"), grant = JSON.parse(grantText);
      grant.limits.maxTotalPayloadBytes++;
      await fs.writeFile(grantFile, JSON.stringify(grant));
      await expect(revalidation.verifyConsumerRevalidationRecord(root, previous[0]!)).rejects.toThrow(/caps/);
      await fs.writeFile(grantFile, grantText);
      await expect(revalidation.verifyConsumerRevalidationRecord(root, { ...previous[0]!, budgetAmendmentHash: undefined })).rejects.toThrow(/allowance/);
      await fs.unlink(grantFile);
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "inspect", budgetAmendment })).rejects.toThrow(/retroactive grant/);
      expect(dispatch).toHaveBeenCalledTimes(3);
      await fs.writeFile(grantFile, grantText);
      await revalidation.verifyConsumerRevalidationRecord(root, previous[0]!);
    } else {
      await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" })).rejects.toThrow("interrupted continuation registration");
      expect(dispatch).toHaveBeenCalledTimes(2);
      const result = await runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" });
      expect(result.status).toBe("blocked"); expect(result.cumulative.modelCalls).toBe(177 + failedCalls + (dependencyRefs ? (rosterPageCount + 1) * 2 : 4));
      expect(dispatch).toHaveBeenCalledTimes(3); expect(previous).toHaveLength(2);
      expect(previous[0]!.continuationHash).toMatch(/^[a-f0-9]{64}$/);
      expect(previous[1]!.sessionId).not.toBe(previous[0]!.sessionId);
      const plan = JSON.parse(await fs.readFile(path.join(recovery, "continuation.json"), "utf8"));
      expect(plan.priorReadFailures).toBe(quotaRefusal ? 0 : 1);
      expect(plan.pendingArtifactRefs).toEqual(quotaRefusal ? [] : failedRefs.map(ref => ref.replace("/", ":")));
      expect(plan.limits.maxModelCalls).toBe(24 - failedCalls);
      if (quotaRefusal) {
        expect(plan.providerResumption).toEqual(args.providerResumption);
        await expect(runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run",
          providerResumption: { ...args.providerResumption!, authorizationRef: "changed-authorization" } })).rejects.toThrow(/no repinning/);
        delete args.providerResumption;
      }
      for (const file of plan.retainedFiles) expect(h(await fs.readFile(path.join(directory, file.path), "utf8"))).toBe(file.hash);
      await runIdentityConsumerRevalidation({ ...args, resumeUnsubmitted: "run" });
      expect(dispatch).toHaveBeenCalledTimes(3);
      const traces = new TraceStore(root);
      await appendUnrelatedTraceHistory(traces, scope.sourceId);
      expect((await traces.peekRuns({ sourceId: scope.sourceId, limit: 1_000 })).some(run => run.id === plan.originalTraceRunId)).toBe(false);
      await expect(revalidation.verifyConsumerRevalidationRecord(root, previous[0]!)).resolves.toBeUndefined();
      await expect(revalidation.verifyConsumerRevalidationRecord(root, previous[1]!)).resolves.toBeUndefined();
      const originalTrace = await traces.peekRun(plan.originalTraceRunId);
      const duplicate = await traces.createRun({ kind: "prepare", sourceId: scope.sourceId,
        operationId: originalTrace.operationId, startedAt: "2020-01-01T00:00:00.000Z" });
      await traces.finishRun(duplicate.id, "failed");
      await expect(revalidation.verifyConsumerRevalidationRecord(root, previous[0]!)).rejects.toThrow(/trace is missing, ambiguous or unsettled/);
      expect(dispatch).toHaveBeenCalledTimes(3);
      const oldMessages = path.join(directory, "consumer-revalidation.messages.jsonl");
      await fs.appendFile(oldMessages, '{"tampered":true}\n');
      await expect(revalidation.verifyConsumerRevalidationRecord(root, previous[0]!)).rejects.toThrow();
      expect(dispatch).toHaveBeenCalledTimes(3);
    }
  } finally { for (const p of providers) await p.host.session.dispose(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); }
}, 20_000);

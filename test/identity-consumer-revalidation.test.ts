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
import { assertConsumerCompilerCorrection, consumerRevalidationLimits, SOURCE_LOCAL_CORRECTION, sourceLocalContractHash } from "../src/compiler/identity-consumer-correction.js";
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
    await fs.writeFile(path.join(upstream, "start.json"), JSON.stringify({ origin: { originalBudgetHash, priorUsage: { modelCalls: 216, totalPayloadBytes: 21600 }, budgetFiles: files }, order: [{ id: "entity" }, { id: "singleton" }] }));
    for (const stage of ["entity", "singleton", "acceptance"]) await put(path.join(upstream, `${stage}.budget.json`), 2);
    await put(path.join(reviews, "other", "consumer-revalidation-check.budget.json"), 3);
    await put(path.join(consumerHostRecoveryDirectory(path.join(reviews, "other")), "consumer-revalidation.budget.json"), 2);
    await put(path.join(consumerStageRecoveryDirectory(consumerHostRecoveryDirectory(path.join(reviews, "other")), "consumer-revalidation"), "consumer-revalidation.budget.json"), 3);
    const result = await revalidation.inheritConsumerRevalidationBudgets(upstream, reviews);
    expect(result.priorUsage).toEqual({ modelCalls: 230, totalPayloadBytes: 23000 });
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

it("does not substitute a missing or superseded consumer with its frozen original payload", () => {
  const payload = { retained: true }, current = { payloads: new Map([["entity-resolution:old", payload], ["initial-world:singleton", payload]]),
    activeRevisions: new Map([["initial-world:singleton", h(payload)]]) };
  expect(revalidation.currentConsumerPayload({ ref: "initial/src", reason: "typed-consumer", payload: {} }, current)).toBe(payload);
  expect(() => revalidation.currentConsumerPayload({ ref: "entity-resolution/old", reason: "typed-consumer", payload }, current)).toThrow(/retained predecessor/);
  expect(() => revalidation.currentConsumerPayload({ ref: "event/missing", reason: "typed-consumer", payload }, current)).toThrow(/no fallback/);
  expect(() => revalidation.currentConsumerPayload({ ref: "source-review/old", reason: "source-review-coverage", payload }, current)).toThrow(/original owning audit/);
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
  { discoveryOnly: false, work: true, stall: true }, { discoveryOnly: false, work: true, previewLoop: true },
  { discoveryOnly: false, work: true, quota: true }, { discoveryOnly: false, work: true, oversized: true },
])("runs independent Pi reviews with full reads ($discoveryOnly), work ($work), stall $stall, preview loop $previewLoop, quota $quota, oversized $oversized, and recovers registration without replay", async ({ discoveryOnly, work, stall, previewLoop, quota, oversized }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-revalidation-")), providers: Awaited<ReturnType<typeof mockPiProvider>>[] = [];
  try {
    const text = "Ada waits. 女孩等待。", source = await createEvidenceFixture(root, text), f0 = fixture();
    const f: ReturnType<typeof fixture> = JSON.parse(JSON.stringify(f0).replaceAll("src", source.source.id).replaceAll('"seg"', JSON.stringify(source.segmentId)).replaceAll(f0.f.intent.sourceHash, source.source.contentSha256));
    const scope = f.proposal.scope;
    if (work) scope.executionPolicy = "consumer-work/v1";
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
    let interrupt = true;
    vi.spyOn(RequirementLedger.prototype, "recordIdentityConsumerRevalidation").mockImplementation(async record => {
      await revalidation.verifyConsumerRevalidationRecord(root, record);
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
        ...(quota ? { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } : {}),
        response: (context, index) => {
        if (!stall && !previewLoop && index > (discoveryOnly ? 3 : 1)) throw Error("Unexpected model retry");
        if (work) {
          if (quota) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Codex error: The usage limit has been reached" });
          if (stall) return fauxAssistantMessage([fauxToolCall("read_consumer_revalidation", { collection: "consumer", refs: [scope.ref], offset: 0 }, { id: `repeated-read-${index}` })], { stopReason: "toolUse" });
          const user = context.messages.find(m => m.role === "user")!;
          const envelope = JSON.parse(typeof user.content === "string" ? user.content : user.content.find(c => c.type === "text")!.text);
          const input = decodeJsonValues(envelope.dictionary, [envelope.value], envelope.dictionaryProfile)[0] as any;
          expect(input.evidencePacket.sources[0].text).toBe(text);
          expect(input.evidencePacket.artifacts[0]).toMatchObject({ ref: "entity:ada", payload: { id: "ada" } });
          expect(input.denominator.refs).toEqual({ policy: "ordered-inventory/v1", count: f.f.inventory.consumers.length, hash: h(f.f.inventory.consumers.map(c => c.ref)) });
          const output = check ? { ...f.check.output, scopeHash: h(scope), proposalHash: h(previous[0]!.output) } : f.proposal.output;
          if (previewLoop) return fauxAssistantMessage([fauxToolCall("preview_consumer_revalidation", { ...output, rationale: `${output.rationale} wording ${index}` }, { id: `preview-loop-${index}` })], { stopReason: "toolUse" });
          return fauxAssistantMessage([fauxToolCall(index ? "submit_consumer_revalidation" : "preview_consumer_revalidation", output,
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
      } })); return session;
    });
    const args = { root, sourceId: scope.sourceId, taskId: scope.taskId, ref: scope.ref, authorizationRef: scope.authorizationRef };
    if (work) {
      const before = captureRecordTree(workspaceStateDir(root));
      expect(await runIdentityConsumerRevalidation({ ...args, inspectExecution: true })).toMatchObject({ status: oversized ? "context-blocked" : "ready", execution: { minimumModelCalls: 2 } });
      expect(dispatch).not.toHaveBeenCalled(); expect(captureRecordTree(workspaceStateDir(root))).toEqual(before);
    }
    if (oversized) {
      expect(await runIdentityConsumerRevalidation(args)).toMatchObject({ status: "context-blocked", execution: { modelDispatchAllowed: false } });
      expect(dispatch).not.toHaveBeenCalled(); expect(previous).toEqual([]); return;
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
    const result = await runIdentityConsumerRevalidation(args);
    expect(result.status).toBe("blocked"); expect(result.parentResumeAllowed).toBe(false);
    expect(result.cumulative.modelCalls).toBe(discoveryOnly ? 185 : 181); expect(dispatch).toHaveBeenCalledTimes(2);
    const again = await runIdentityConsumerRevalidation(args);
    expect(again.cumulative).toEqual(result.cumulative); expect(dispatch).toHaveBeenCalledTimes(2);
    const oldStates = await fs.readdir(path.join(directory, "history"));
    expect((await Promise.all(oldStates.map(n => fs.readFile(path.join(directory, "history", n), "utf8")))).some(s => s.includes("injected registration interruption"))).toBe(true);
    if (work) {
      const attempts = await inspectConsumerRevalidationAttempts(root, scope.sourceId, f.original, previous);
      expect(attempts[0]!.cumulative).toEqual(result.cumulative);
      expect(attempts[0]!.stages[0]!.execution).toMatchObject({ policy: "consumer-work/v1", status: "sealed", draftCount: 1, usage: { modelCalls: 2 } });
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

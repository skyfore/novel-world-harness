import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareCompilerBatches, CompilerBatchStore } from "../src/compiler/batches.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { CompilerProposalObligations } from "../src/compiler/proposal-obligations.js";
import { CompilerAccountingPages } from "../src/compiler/accounting-pages.js";
import { reviewAccountingObligation, reviewAccountingRefinementObligation } from "../src/compiler/accounting-review.js";
import { SourceAccountingStore } from "../src/compiler/source-accounting.js";
import { ProposalStore } from "../src/world/canonical-model.js";
import { contentHash } from "../src/world/canonical.js";
import { ActorModelStore, characterGoalSchema } from "../src/world/actors.js";
import { worldStorageRoot } from "../src/world/paths.js";
import { TraceStore } from "../src/trace/store.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function setup(successor = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-coverage-review-")); roots.push(root);
  const ruleText = "Entry requires day zero or later.";
  const content = Array.from({ length: 21 }, (_, index) => index === 19 ? ruleText : `Traveler ${index + 1} waits quietly at the gate.`).join("\n");
  const fixture = await createEvidenceFixture(root, content);
  const batch = (await prepareCompilerBatches(root, fixture.source)).find((item) => item.semanticStage === "executable")!;
  const set = createCompilerProposalToolset(root);
  await set.beginBatch(batch.segmentIds, batch.id, fixture.source.id);
  const tool = (name: string) => set.tools.find((candidate) => candidate.name === name)!;
  const call = (name: string, input: unknown) => tool(name).execute(name, input as never, undefined, undefined, {} as never);
  const discover = async () => {
    const result = await call("find_source_accounting_units", { status: "unresolved", offset: 0, max_results: 20 });
    return JSON.parse((result.content[0] as { text: string }).text) as {
      type: string; sourceId: string; compilerBatchId: string; pageToken: string; units: Array<{ unitId: string; status: string; bytes: number[]; text: string }>;
    };
  };
  const oldPage = await discover();
  await call("propose_world_rule", { proposal_id: "new-evidence", payload: {
    ontologyVersion: "world-rule-v2", id: "entry", name: ruleText, kind: "social", scope: "global", visibility: "public",
    priority: 1, defeasible: true, clauses: [{ id: "entry-day", modality: "require", predicate: { op: "elapsed-days-gte", days: 0 },
      basis: "explicit", status: "supported", confidence: 1 }], exceptions: [], basis: "explicit", status: "supported", confidence: 1,
  }, evidence_segment_ids: batch.segmentIds, evidence_selectors: ["/name", "/clauses/0/predicate"].map((target_path) => ({
    segment_id: batch.segmentIds[0], exact: ruleText, target_path, relation: "supports", strength: "explicit",
  })) });
  const originalInput = { proposal_id: "p07", page_token: oldPage.pageToken, page_default: { status: "background-only", reason: "Reviewed descriptive texture." } };
  await expect(call("account_source_units", originalInput)).rejects.toThrow("coverage changed");
  const newPage = await discover();
  if (successor) await call("account_source_units", { ...originalInput, proposal_id: "p07b", page_token: newPage.pageToken });
  expect(() => tool("account_source_units").prepareArguments!({ proposal_id: "p07", decisions: [] })).toThrow();
  const journal = new CompilerProposalObligations(root, fixture.source.id, batch.id);
  const options = { sourceId: fixture.source.id, batchId: batch.id, proposalId: "p07", reason: "Check original page 19+1 coverage", auditRef: "incident:2026-09-08" };
  return { root, fixture, batch, options, journal, call, originalInput, oldPage, newPage };
}

it("settles exactly 19 successor decisions plus one exact evidence unit, preserving failures and checkpoints", async () => {
  const f = await setup();
  expect(() => f.journal.assertModelRecoveryAllowed()).toThrow("host review");
  const before = f.journal.history("account_source_units", "p07");
  const preview = await reviewAccountingObligation(f.root, f.options);
  expect(preview.units).toHaveLength(20);
  expect(preview.units.filter((unit) => unit.kind === "decision")).toHaveLength(19);
  expect(preview.units.filter((unit) => unit.kind === "evidence")).toHaveLength(1);
  expect(f.journal.history("account_source_units", "p07")).toEqual(before);
  expect(() => f.journal.recordCoverageSettlement({ ...preview, units: preview.units.slice(1) }, "Partial proof", "test:partial")).toThrow("every original unit");
  expect(() => f.journal.recordCoverageSettlement({ ...preview, failedInputHashes: preview.failedInputHashes.slice(1) }, "Missing attempt", "test:partial")).toThrow("failed inputs");
  expect(() => f.journal.recordCoverageSettlement({ ...preview, sourceId: "other-source" }, "Wrong source", "test:scope")).toThrow("exact source/batch");
  await reviewAccountingObligation(f.root, f.options, true);
  expect(f.journal.unresolved()).toEqual([]);
  const settledHistory = f.journal.history("account_source_units", "p07");
  await reviewAccountingObligation(f.root, f.options, true);
  expect(f.journal.history("account_source_units", "p07")).toEqual(settledHistory);
  expect(f.journal.history("account_source_units", "p07").slice(0, -1)).toEqual(before);
  expect(f.journal.history("account_source_units", "p07").at(-1)).toMatchObject({ status: "superseded-by-coverage", hostReview: { auditRef: f.options.auditRef } });
  expect((await new CompilerBatchStore(f.root).read(f.fixture.source.id)).completedBatchIds).toEqual([]);
  expect(await new SourceAccountingStore(f.root).listProposals(f.fixture.source.id, "accepted")).toEqual([]);
  // The normal finish remains responsible for graph checks, acceptance and review.
  await expect(f.call("finish_compiler_batch", { outcome: "complete", reviewed_segments: f.batch.segmentIds.map((segment_id) => ({
    segment_id, disposition: "proposed", summary: "Reviewed exact source and every unit." })), summary: "Reviewed source." })).resolves.toMatchObject({ terminate: true });
  expect(f.journal.unresolved()).toEqual([]); // pending -> accepted accounting preserves the proof
});

it.each(["evidence", "successor"])("reopens host review when its %s dependency is withdrawn", async (dependency) => {
  const f = await setup();
  await reviewAccountingObligation(f.root, f.options, true);
  if (dependency === "evidence") await new ProposalStore(f.root).reject("new-evidence", [{ code: "TEST_WITHDRAWAL", message: "Withdrawing the coverage dependency." }]);
  else await new SourceAccountingStore(f.root).withdrawProposal(f.fixture.source.id, "p07b");
  const resumed = new CompilerProposalObligations(f.root, f.fixture.source.id, f.batch.id);
  expect(resumed.unresolved()).toMatchObject([{ proposalId: "p07", diagnostic: expect.stringContaining("Coverage proof invalidated") }]);
  expect(() => resumed.assertFinishable()).toThrow("host review");
  await expect(reviewAccountingObligation(f.root, f.options)).rejects.toThrow("incomplete");
});

it("rejects incomplete coverage, wrong scopes, unrelated successes, and unproven legacy pages", async () => {
  const f = await setup(false);
  f.journal.record("account_source_units", { proposal_id: "unrelated" }, "succeeded");
  await expect(reviewAccountingObligation(f.root, f.options, true)).rejects.toThrow("incomplete");
  await expect(reviewAccountingObligation(f.root, { ...f.options, sourceId: "other-source" })).rejects.toThrow("exact scope");
  await expect(reviewAccountingObligation(f.root, { ...f.options, batchId: "other-batch" })).rejects.toThrow("exact scope");
  await fs.rm(path.join(worldStorageRoot(f.root), "compiler", "accounting-pages"), { recursive: true });
  await expect(reviewAccountingObligation(f.root, f.options)).rejects.toThrow("no durable receipt");
  expect(f.journal.history("account_source_units", "p07").at(-1)?.status).toBe("failed");
});

it("reconstructs a legacy page only from a hash-verified same-session discovery and exact failed call", async () => {
  const f = await setup();
  const traces = new TraceStore(f.root);
  const run = await traces.createRun({ kind: "prepare", sourceId: f.fixture.source.id });
  const discovery = await traces.putBlob({ content: [{ type: "text", text: JSON.stringify(f.oldPage) }] });
  const original = await traces.putBlob(f.originalInput);
  await traces.appendEvent(run.id, { type: "tool.call.completed", spanId: "turn-1", parentSpanId: "same-batch-session", toolCallId: "discovery",
    data: { toolName: "find_source_accounting_units", isError: false }, blobRef: discovery });
  await traces.appendEvent(run.id, { type: "tool.call.started", spanId: "turn-2", parentSpanId: "same-batch-session", toolCallId: "old-call",
    data: { toolName: "account_source_units" }, blobRef: original });
  await traces.appendEvent(run.id, { type: "tool.call.failed", spanId: "turn-2", parentSpanId: "same-batch-session", toolCallId: "old-call",
    data: { toolName: "account_source_units", isError: true } });
  await traces.finishRun(run.id, "failed");
  await fs.rm(path.join(worldStorageRoot(f.root), "compiler", "accounting-pages"), { recursive: true });
  const proof = await reviewAccountingObligation(f.root, { ...f.options, fromRun: run.id });
  expect(proof.units).toHaveLength(20);
  expect(proof.auditRefs).toContainEqual(expect.stringContaining(`${run.id}:discovery=1:failed-call=2`));
  const blobFile = path.join(traces.blobsRoot, discovery.sha256.slice(0, 2), `${discovery.sha256}.json`);
  const originalBlob = await fs.readFile(blobFile, "utf8");
  const raw = JSON.parse(originalBlob); raw.content = {};
  await fs.writeFile(blobFile, JSON.stringify(raw));
  await expect(reviewAccountingObligation(f.root, { ...f.options, fromRun: run.id })).rejects.toThrow("content verification");
  await fs.writeFile(blobFile, originalBlob);
  await reviewAccountingObligation(f.root, { ...f.options, fromRun: run.id }, true);
  expect(f.journal.unresolved()).toEqual([]);
  await new SourceAccountingStore(f.root).withdrawProposal(f.fixture.source.id, "p07b");
  await expect(reviewAccountingObligation(f.root, f.options)).rejects.toThrow("incomplete"); // restored provenance survives the legacy trace reader
});

it.each(["Source accounting coverage changed: no decisions were staged.", "Localized or newer compiler diagnostic."])("refines exhausted accounting from structural evidence independently of diagnostic text: %s", async (oldDiagnostic) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-accounting-refinement-review-"));
  roots.push(root);
  const sourceText = "The team continues along the route.\nThe standing mission remains unchanged.\nThe retained goal already describes the standing mission.";
  const fixture = await createEvidenceFixture(root, sourceText);
  const batch = (await prepareCompilerBatches(root, fixture.source)).find((item) => item.semanticStage === "executable")!;
  const initial = createCompilerProposalToolset(root);
  await initial.beginBatch(batch.segmentIds, batch.id, fixture.source.id);
  const call = (set: ReturnType<typeof createCompilerProposalToolset>, name: string, input: unknown) =>
    set.tools.find((candidate) => candidate.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
  const discover = async () => {
    const result = await call(initial, "find_source_accounting_units", { status: "unresolved", offset: 0, max_results: 20 });
    return JSON.parse((result.content[0] as { text: string }).text) as { pageToken: string; units: Array<{ unitId: string }> };
  };
  const originalPage = await discover();
  await call(initial, "account_source_units", {
    proposal_id: "blocking-page",
    page_token: originalPage.pageToken,
    page_default: { status: "unresolved", reason: "The initial review intentionally leaves executable meaning open." },
  });

  const journal = new CompilerProposalObligations(root, fixture.source.id, batch.id);
  const collisionPage = await discover();
  const collisionInput = {
    proposal_id: "blocking-page",
    page_token: collisionPage.pageToken,
    page_default: { status: "background-only", reason: "The second review found no additional semantic artifact." },
  };
  journal.record("account_source_units", collisionInput, "running", "Tool result not yet verified; interrupted calls require host inspection before retry.");
  journal.record("account_source_units", collisionInput, "failed", "Pending source-accounting proposal blocking-page already exists with different content; use a new proposal id.");

  const firstFailedPage = await discover();
  const firstFailedInput = {
    proposal_id: "refined-page",
    page_token: firstFailedPage.pageToken,
    page_default: { status: "background-only", reason: "Reviewed continuation with no additional semantic artifact." },
  };
  const secondFailedPage = await discover();
  const secondFailedInput = {
    proposal_id: "refined-page",
    page_token: secondFailedPage.pageToken,
    page_default: { status: "background-only", reason: "Reviewed mission context with no additional executable mechanism." },
  };
  for (const input of [firstFailedInput, secondFailedInput]) {
    journal.record("account_source_units", input, "running", "Tool result not yet verified; interrupted calls require host inspection before retry.");
    journal.record("account_source_units", input, "failed", oldDiagnostic);
  }
  const originalRefinementHistory = journal.history("account_source_units", "refined-page");
  const correctedInput = {
    ...secondFailedInput,
    page_default: { status: "background-only" as const, reason: "Reviewed continuation with no additional semantic artifact." },
    page_overrides: [{
      unit_index: 3,
      status: "duplicate-description" as const,
      reason: "This operational rationale is already represented by the retained semantic goal.",
    }],
  };
  const supportText = "The retained goal already describes the standing mission.";
  const sourceBytes = Buffer.from(sourceText);
  const supportStart = sourceBytes.indexOf(Buffer.from(supportText));
  const supportAnchor = textAnchorForByteRange(fixture.source.id, sourceBytes, supportStart, supportStart + Buffer.byteLength(supportText));
  const retainedGoal = characterGoalSchema.parse({
    id: "retained-goal",
    actorId: "team",
    description: "The team continues its standing mission.",
    priority: 0.7,
    requiresKnowledge: [],
    evidence: fixture.evidence(supportText),
  });
  const supportProposalId = "retained-goal-proposal";
  const proposals = new ProposalStore(root);
  await proposals.writePending({
    id: supportProposalId,
    kind: "character-goal",
    schemaVersion: 1,
    payload: retainedGoal,
    evidence: retainedGoal.evidence,
    evidenceAssertions: [{
      version: 1,
      id: "retained-goal-description-evidence",
      target: { artifactKind: "character-goal", artifactId: retainedGoal.id, jsonPointer: "/description" },
      anchors: [supportAnchor],
      relation: "supports",
      strength: "explicit",
      derivation: { runId: "accounting-refinement-test", worker: "fixture", compilerBatchId: batch.id, ontologyVersion: "evidence-v1" },
    }],
    generatedBy: { worker: "fixture", compilerBatchId: batch.id },
    createdAt: "2026-09-26T00:00:00.000Z",
  }, characterGoalSchema);
  const actors = new ActorModelStore(root);
  await actors.putGoal(retainedGoal);
  await proposals.transition(supportProposalId, "pending", "accepted");
  const options = {
    sourceId: fixture.source.id,
    batchId: batch.id,
    proposalId: "refined-page",
    settleProposalIds: ["blocking-page"],
    duplicateSupportProposalIds: [supportProposalId],
    reason: "Host reviewed the retained page and approved only a blocking-to-background accounting refinement.",
    auditRef: "test:accounting-refinement-review",
    correctedInput,
  };
  await expect(reviewAccountingRefinementObligation(root, {
    ...options,
    correctedInput: {
      ...secondFailedInput,
      page_default: { status: "background-only" as const, reason: secondFailedInput.page_default.reason },
    },
    duplicateSupportProposalIds: [],
  })).rejects.toThrow("differs from every exhausted failed input");
  await expect(reviewAccountingRefinementObligation(root, {
    ...options,
    duplicateSupportProposalIds: [],
  })).rejects.toThrow("requires at least one exact accepted semantic support proposal");
  const preview = await reviewAccountingRefinementObligation(root, options);
  expect(preview).toMatchObject({
    status: "verified-preview",
    executableCertification: false,
    input: correctedInput,
    units: expect.arrayContaining([expect.objectContaining({ predecessorProposalId: "blocking-page", predecessorStatus: "unresolved" })]),
  });
  expect(preview.binding.failedInputHashes).toHaveLength(2);
  expect(preview.binding.failedInputHashes).not.toContain(preview.binding.inputHash);
  expect(preview.binding.duplicateSupportDependencies).toEqual([expect.objectContaining({
    proposalId: supportProposalId,
    artifactKind: "character-goal",
    artifactId: retainedGoal.id,
    unitIds: [originalPage.units[2]!.unitId],
    evidenceAssertionIds: ["retained-goal-description-evidence"],
  })]);
  expect(journal.history("account_source_units", "refined-page")).toEqual(originalRefinementHistory);
  await expect(new SourceAccountingStore(root).readProposal(fixture.source.id, "pending", "refined-page"))
    .rejects.toMatchObject({ code: "ENOENT" });

  await expect(reviewAccountingRefinementObligation(root, {
    ...options,
    expectedAuthorityHash: "0".repeat(64),
  }, true)).rejects.toThrow("authority changed after preview");
  await actors.putGoal({ ...retainedGoal, description: "A changed current goal revision." });
  await expect(reviewAccountingRefinementObligation(root, {
    ...options,
    expectedAuthorityHash: preview.authorityHash,
  }, true)).rejects.toThrow("is not the current accepted artifact revision");
  await actors.putGoal(retainedGoal);
  const applied = await reviewAccountingRefinementObligation(root, {
    ...options,
    expectedAuthorityHash: preview.authorityHash,
  }, true);
  expect(applied.status).toBe("staged");
  expect(applied.settlements).toHaveLength(1);
  const accounting = new SourceAccountingStore(root);
  const original = await accounting.readProposal(fixture.source.id, "pending", "blocking-page");
  const successor = await accounting.readProposal(fixture.source.id, "pending", "refined-page");
  expect(original.decisions.every((decision) => decision.status === "unresolved")).toBe(true);
  expect(successor.refinements).toEqual([{
    proposalId: "blocking-page",
    proposalHash: contentHash(original),
    unitIds: originalPage.units.map((unit) => unit.unitId).sort(),
  }]);
  expect(successor.decisions[2]?.status).toBe("duplicate-description");
  expect(new CompilerAccountingPages(root, fixture.source.id, batch.id).read(secondFailedPage.pageToken)?.consumedBy).toBe("refined-page");
  expect(journal.history("account_source_units", "refined-page").slice(0, originalRefinementHistory.length)).toEqual(originalRefinementHistory);
  expect(journal.history("account_source_units", "refined-page").slice(-2).map((attempt) => attempt.status)).toEqual(["running", "succeeded"]);
  expect(journal.history("account_source_units", "blocking-page").at(-1)).toMatchObject({ status: "superseded-by-coverage" });
  expect(journal.unresolved()).toEqual([]);

  await expect(reviewAccountingRefinementObligation(root, {
    ...options,
    expectedAuthorityHash: preview.authorityHash,
  }, true)).rejects.toThrow("already consumed");
  new CompilerAccountingPages(root, fixture.source.id, batch.id).consume(firstFailedPage.pageToken, "unexpected-consumer");
  await expect(reviewAccountingRefinementObligation(root, {
    ...options,
    expectedAuthorityHash: preview.authorityHash,
  }, true)).rejects.toThrow("ambiguous consumption state");

  const resumed = createCompilerProposalToolset(root);
  await resumed.beginBatch(batch.segmentIds, batch.id, fixture.source.id);
  await expect(call(resumed, "finish_compiler_batch", {
    outcome: "complete",
    reviewed_segments: batch.segmentIds.map((segment_id) => ({
      segment_id,
      disposition: "proposed",
      summary: "Every source unit was reviewed through the retained accounting graph.",
    })),
    summary: "Host-reviewed accounting refinement is ready for the normal finish handshake.",
  })).resolves.toMatchObject({ terminate: true });
  await expect(reviewAccountingRefinementObligation(root, {
    ...options,
    expectedAuthorityHash: preview.authorityHash,
  }, true)).rejects.toThrow("checkpoint, or finish baseline changed");
});

it("recovers only the exact durable running accounting-refinement intent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-accounting-refinement-interruption-"));
  roots.push(root);
  const fixture = await createEvidenceFixture(root, "The team continues.\nThe mission remains unchanged.");
  const batch = (await prepareCompilerBatches(root, fixture.source)).find((item) => item.semanticStage === "executable")!;
  const toolset = createCompilerProposalToolset(root);
  await toolset.beginBatch(batch.segmentIds, batch.id, fixture.source.id);
  const call = (name: string, input: unknown) => toolset.tools.find((candidate) => candidate.name === name)!
    .execute(name, input as never, undefined, undefined, {} as never);
  const discover = async () => {
    const result = await call("find_source_accounting_units", { status: "unresolved", offset: 0, max_results: 20 });
    return JSON.parse((result.content[0] as { text: string }).text) as { pageToken: string; units: Array<{ unitId: string }> };
  };
  const blockingPage = await discover();
  await call("account_source_units", {
    proposal_id: "blocking-page",
    page_token: blockingPage.pageToken,
    page_default: { status: "unresolved", reason: "The first review leaves the executable disposition open." },
  });

  const journal = new CompilerProposalObligations(root, fixture.source.id, batch.id);
  const failedInputs: Array<{
    proposal_id: string;
    page_token: string;
    page_default: { status: "background-only"; reason: string };
  }> = [];
  for (const reason of ["First exhausted disposition.", "Second exhausted disposition."]) {
    const page = await discover();
    const input = {
      proposal_id: "refined-page",
      page_token: page.pageToken,
      page_default: { status: "background-only" as const, reason },
    };
    failedInputs.push(input);
    journal.record("account_source_units", input, "running", "Tool result not yet verified; interrupted calls require host inspection before retry.");
    journal.record("account_source_units", input, "failed", "Source accounting coverage changed: no decisions were staged. Represented units cannot receive a model disposition; retain existing valid accounting.");
  }
  const correctedInput = {
    ...failedInputs[1]!,
    page_default: { status: "background-only" as const, reason: "Host reviewed the retained source text as non-executable context." },
  };
  const options = {
    sourceId: fixture.source.id,
    batchId: batch.id,
    proposalId: "refined-page",
    settleProposalIds: [],
    duplicateSupportProposalIds: [],
    correctedInput,
    reason: "Recover one exact interrupted host accounting refinement.",
    auditRef: "test:accounting-refinement-interruption",
  };
  const preview = await reviewAccountingRefinementObligation(root, options);
  const accounting = new SourceAccountingStore(root);
  const predecessor = await accounting.readProposal(fixture.source.id, "pending", "blocking-page");
  const priorFailure = journal.history("account_source_units", "refined-page").at(-1)!;
  const interruptedProposal = {
    version: 1 as const,
    id: "refined-page",
    sourceId: fixture.source.id,
    compilerBatchId: batch.id,
    decisions: blockingPage.units.map(({ unitId }) => ({
      unitId,
      status: "background-only" as const,
      reason: correctedInput.page_default.reason,
    })),
    generatedBy: { worker: "account_source_units" as const },
    refinements: [{
      proposalId: predecessor.id,
      proposalHash: contentHash(predecessor),
      unitIds: blockingPage.units.map(({ unitId }) => unitId).sort(),
    }],
    createdAt: priorFailure.updatedAt,
  };
  await expect(journal.withHostAccountingRefinement(
    correctedInput,
    preview.binding,
    options.reason,
    options.auditRef,
    async () => {
      journal.record("account_source_units", correctedInput, "running", "Tool result not yet verified; interrupted calls require host inspection before retry.");
      await accounting.stageProposal(interruptedProposal);
      throw new Error("simulated interruption after durable output");
    },
  )).rejects.toThrow("simulated interruption");
  expect(journal.history("account_source_units", "refined-page").at(-1)).toMatchObject({
    status: "running",
    hostReview: { accountingRefinementCorrection: { authorityHash: preview.authorityHash } },
  });
  expect(new CompilerAccountingPages(root, fixture.source.id, batch.id).read(correctedInput.page_token)?.consumedBy).toBeUndefined();

  const recovered = await reviewAccountingRefinementObligation(root, {
    ...options,
    expectedAuthorityHash: preview.authorityHash,
  }, true);
  expect(recovered.status).toBe("recovered");
  expect(new CompilerAccountingPages(root, fixture.source.id, batch.id).read(correctedInput.page_token)?.consumedBy).toBe("refined-page");
  expect(journal.history("account_source_units", "refined-page").at(-1)?.status).toBe("succeeded");
  expect(journal.unresolved()).toEqual([]);
  await expect(reviewAccountingRefinementObligation(root, {
    ...options,
    expectedAuthorityHash: preview.authorityHash,
  }, true)).rejects.toThrow("already consumed");
});

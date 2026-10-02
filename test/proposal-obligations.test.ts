import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CompilerProposalObligations } from "../src/compiler/proposal-obligations.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { prepareCompilerBatches, hydrateCompilerBatch } from "../src/compiler/batches.js";
import { SourceAnnotationStore } from "../src/compiler/annotations.js";
import { SourceAccountingStore } from "../src/compiler/source-accounting.js";
import { withNwhToolRecovery } from "../src/agent/tool-recovery.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { worldStorageRoot } from "../src/world/paths.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-obligations-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero waits at the gate.\n");
  const batch = (await prepareCompilerBatches(root, fixture.source)).find((item) => item.semanticStage === "observation")!;
  const create = async () => { const set = createCompilerProposalToolset(root); await set.beginBatch(batch.segmentIds, batch.id, fixture.source.id); return set; };
  const input = (id: string, exact = "Hero") => ({ proposal_id: id, annotation_id: id, selector: { segment_id: batch.segmentIds[0], exact }, surface: exact, form: "proper", kind_candidates: ["character"], confidence: 1 });
  const finish = { outcome: "complete", reviewed_segments: batch.segmentIds.map((segment_id) => ({ segment_id, disposition: "proposed", summary: "Reviewed evidence." })), summary: "Reviewed evidence." };
  return { root, fixture, batch, create, input, finish };
}
const call = (set: ReturnType<typeof createCompilerProposalToolset>, name: string, input: unknown) =>
  set.tools.find((tool) => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as never);

it("blocks finish before side effects across fresh sessions, and clears only a same-identity validated correction", async () => {
  const f = await setup(); const set = await f.create();
  await call(set, "propose_entity_mention", f.input("valid"));
  await expect(call(set, "propose_entity_mention", f.input("broken", "Missing"))).rejects.toThrow("Exact evidence quote");
  const resumed = await f.create();
  expect((await hydrateCompilerBatch(f.root, f.batch)).prompt).toContain('"proposalId":"broken"');
  await expect(call(resumed, "finish_compiler_batch", f.finish)).rejects.toThrow("Unresolved compiler proposal obligations");
  expect(await new SourceAnnotationStore(f.root).list(f.fixture.source.id)).toEqual([]);
  expect(await new SourceAccountingStore(f.root).read(f.fixture.source.id)).toBeNull();
  await call(resumed, "propose_entity_mention", f.input("broken"));
  await expect(call(resumed, "finish_compiler_batch", f.finish)).resolves.toMatchObject({ terminate: true });
  expect(new CompilerProposalObligations(f.root, f.fixture.source.id, f.batch.id).unresolved()).toEqual([]);
});

it("journals Pi argument-preparation failures before execute and preserves host-reviewed history", async () => {
  const f = await setup(); const set = await f.create();
  const tool = withNwhToolRecovery(set.tools.find((tool) => tool.name === "propose_entity_mention")!);
  expect(() => tool.prepareArguments!({ proposal_id: "invalid-input" })).toThrow();
  const ledger = new CompilerProposalObligations(f.root, f.fixture.source.id, f.batch.id);
  expect(ledger.unresolved()).toMatchObject([{ proposalId: "invalid-input", status: "failed" }]);
  await expect(call(await f.create(), "finish_compiler_batch", f.finish)).rejects.toThrow("invalid-input");
  expect(() => ledger.reviewUnsupported("propose_entity_mention", "invalid-input", "", "test:audit")).toThrow();
  ledger.reviewUnsupported("propose_entity_mention", "invalid-input", "Incomplete test input has no supported assertion.", "test:audit");
  expect(ledger.unresolved()).toEqual([]);
  const journals = await fs.readdir(path.join(worldStorageRoot(f.root), "compiler", "proposal-obligations"), { recursive: true });
  const journal = journals.find((file) => file.endsWith(".json"))!;
  const saved = JSON.parse(await fs.readFile(path.join(worldStorageRoot(f.root), "compiler", "proposal-obligations", journal), "utf8"));
  expect(saved.attempts.map((item: { status: string }) => item.status)).toEqual(["failed", "unsupported"]);
  expect(saved.attempts[1].hostReview.auditRef).toBe("test:audit");
  // Host review closes an obligation only; it does not create an annotation or checkpoint.
  expect(await new SourceAnnotationStore(f.root).list(f.fixture.source.id)).toEqual([]);
});

it("keeps schema preflight failures explicit until correction or audited host disposition", async () => {
  const f = await setup();
  const batchId = f.batch.id.replace("-observation-", "-executable-");
  const set = createCompilerProposalToolset(f.root);
  await set.beginBatch(f.batch.segmentIds, batchId, f.fixture.source.id);
  const tool = withNwhToolRecovery(set.tools.find((candidate) => candidate.name === "propose_event_execution")!);
  const input = {
    proposal_id: "ad-hoc-execution",
    payload: {
      id: "ad-hoc-execution",
      canonicalEventId: "canonical-event",
      actorId: "actor",
      action: {
        lane: "ad-hoc",
        actionKindId: "announce",
        description: "Actor announces boarding.",
        footprint: { reads: [], writes: [], resources: [] },
      },
      roleBindings: [],
    },
    evidence_segment_ids: f.batch.segmentIds,
  };

  expect(() => tool.prepareArguments!(input)).toThrow("payload.action.lane");
  const ledger = new CompilerProposalObligations(f.root, f.fixture.source.id, batchId);
  expect(ledger.history("propose_event_execution", input.proposal_id)).toMatchObject([{ status: "failed" }]);
  expect(ledger.unresolved()).toMatchObject([{ proposalId: input.proposal_id, status: "failed" }]);
  expect(() => ledger.assertFinishable()).toThrow("Unresolved compiler proposal obligations");

  const { roleBindings: _misplaced, ...payload } = input.payload;
  expect(() => ledger.assertRetryAllowed("propose_event_execution", {
    ...input,
    payload: {
      ...payload,
      action: { lane: "schema-bound", schemaId: "supported-schema", roleBindings: [], parameters: {} },
    },
  })).not.toThrow();
  expect(ledger.history("propose_event_execution", input.proposal_id)).toHaveLength(1);
});

it("requires explicit host disposition after an exhausted no-write correction", async () => {
  const f = await setup();
  const batchId = f.batch.id.replace("-observation-", "-executable-");
  const proposalId = "empty-execution-correction";
  const original = {
    proposal_id: proposalId,
    payload: {
      id: proposalId,
      canonicalEventId: "canonical-event",
      actorId: "actor",
      action: {
        lane: "ad-hoc",
        actionKindId: "announce",
        description: "Actor announces boarding.",
        footprint: { reads: [], writes: [], resources: [] },
      },
      roleBindings: [],
    },
    evidence_segment_ids: f.batch.segmentIds,
  };
  const correction = {
    proposal_id: proposalId,
    payload: { id: proposalId, canonicalEventId: "canonical-event", actorId: "actor" },
    evidence_segment_ids: f.batch.segmentIds,
    evidence_selectors: [{
      segment_id: f.batch.segmentIds[0]!,
      exact: "Hero",
      target_path: "/payload/canonicalEventId",
      relation: "supports" as const,
      strength: "explicit" as const,
    }],
  };
  const ledger = new CompilerProposalObligations(f.root, f.fixture.source.id, batchId);
  ledger.record("propose_event_execution", original, "failed", 'Validation failed for tool "propose_event_execution":\n  - payload.action.lane: must be equal to constant');
  ledger.record("propose_event_execution", correction, "running", "Tool result not yet verified; interrupted calls require host inspection before retry.");
  ledger.record("propose_event_execution", correction, "failed", "Evidence selector 1 target_path '/payload/canonicalEventId' does not exist in the proposal payload.");

  expect(ledger.history("propose_event_execution", proposalId).map((attempt) => attempt.status))
    .toEqual(["failed", "running", "failed"]);
  expect(ledger.unresolved()).toMatchObject([{ proposalId, status: "failed" }]);
  expect(() => ledger.assertFinishable()).toThrow("requires host review");
  expect(() => ledger.assertRetryAllowed("propose_event_execution", {
    ...correction,
    payload: {
      ...correction.payload,
      action: { lane: "schema-bound", schemaId: "later-schema", roleBindings: [], parameters: {} },
    },
  })).toThrow("original and corrected inputs both failed");
});

it("keeps lookalike IDs-only correction histories blocking when persistence or diagnostics break the no-write proof", async () => {
  const f = await setup();
  const batchId = f.batch.id.replace("-observation-", "-executable-");
  const recordHistory = (proposalId: string, diagnostic: string) => {
    const ledger = new CompilerProposalObligations(f.root, f.fixture.source.id, batchId);
    const original = {
      proposal_id: proposalId,
      payload: {
        id: proposalId, canonicalEventId: "canonical-event", actorId: "actor",
        action: { lane: "ad-hoc", actionKindId: "announce", description: "Actor announces boarding.", footprint: { reads: [], writes: [], resources: [] } },
        roleBindings: [],
      },
      evidence_segment_ids: f.batch.segmentIds,
    };
    const correction = {
      proposal_id: proposalId,
      payload: { id: proposalId, canonicalEventId: "canonical-event", actorId: "actor" },
      evidence_segment_ids: f.batch.segmentIds,
      evidence_selectors: [{ segment_id: f.batch.segmentIds[0]!, exact: "Hero", target_path: "/payload/canonicalEventId", relation: "supports" as const, strength: "explicit" as const }],
    };
    ledger.record("propose_event_execution", original, "failed", 'Validation failed for tool "propose_event_execution":\n  - payload.action.lane: must be equal to constant');
    ledger.record("propose_event_execution", correction, "running", "Tool result not yet verified; interrupted calls require host inspection before retry.");
    ledger.record("propose_event_execution", correction, "failed", diagnostic);
    return ledger;
  };
  const changedDiagnostic = recordHistory("changed-diagnostic", "A different execution failure occurred.");
  expect(changedDiagnostic.unresolved()).toMatchObject([{ proposalId: "changed-diagnostic" }]);

  await new CompilerProposalService(f.root).submit("entity", {
    proposalId: "persisted-empty-correction",
    payload: { id: "persisted-entity", kind: "character", canonicalName: "Hero", aliases: [], evidence: f.fixture.evidence("Hero") },
    generatedBy: { worker: "test", compilerBatchId: batchId },
  });
  const persisted = recordHistory(
    "persisted-empty-correction",
    "Evidence selector 1 target_path '/payload/canonicalEventId' does not exist in the proposal payload.",
  );
  expect(persisted.unresolved().map((attempt) => attempt.proposalId))
    .toContain("persisted-empty-correction");
});

it("keeps ad-hoc event-execution failures blocking when preflight safety proof is incomplete", async () => {
  const f = await setup();
  const batchId = f.batch.id.replace("-observation-", "-executable-");
  const diagnostic = 'Validation failed for tool "propose_event_execution":\n  - payload.action.lane: must be equal to constant';
  const input = (proposal_id: string) => ({
    proposal_id,
    payload: {
      id: proposal_id,
      canonicalEventId: "canonical-event",
      actorId: "actor",
      action: {
        lane: "ad-hoc",
        actionKindId: "announce",
        description: "Actor announces boarding.",
        footprint: { reads: [], writes: [], resources: [] },
      },
      roleBindings: [],
    },
    evidence_segment_ids: f.batch.segmentIds,
  });
  const ledger = new CompilerProposalObligations(f.root, f.fixture.source.id, batchId);

  ledger.record("propose_event_execution", input("started"), "running", "Execution result is unknown.");
  ledger.record("propose_event_execution", input("started"), "failed", diagnostic);
  ledger.record("propose_event_execution", input("repeated"), "failed", "Earlier distinct failure.");
  ledger.record("propose_event_execution", input("repeated"), "failed", diagnostic);
  ledger.record("propose_event_execution", {
    ...input("entry-content"),
    payload: { ...input("entry-content").payload, entryCheckpoint: {} },
  }, "failed", diagnostic);
  ledger.record("propose_event_execution", {
    ...input("malformed-action"),
    payload: { ...input("malformed-action").payload, action: { lane: "ad-hoc" } },
  }, "failed", diagnostic);

  expect(ledger.unresolved().map((attempt) => attempt.proposalId).sort()).toEqual([
    "entry-content",
    "malformed-action",
    "repeated",
    "started",
  ]);
  expect(() => ledger.assertFinishable()).toThrow("Unresolved compiler proposal obligations");
});

it("retains interrupted attempts and cannot clear them with an unrelated proposal or another scope", async () => {
  const f = await setup();
  const ledger = new CompilerProposalObligations(f.root, f.fixture.source.id, f.batch.id);
  ledger.record("propose_action_schema", { proposal_id: "interrupted" }, "running", "Process ended before tool result.");
  ledger.record("propose_action_schema", { proposal_id: "unrelated" }, "succeeded");
  expect(() => ledger.assertRetryAllowed("propose_action_schema", { proposal_id: "interrupted" })).toThrow("Do not retry");
  expect(() => new CompilerProposalObligations(f.root, f.fixture.source.id, f.batch.id).assertFinishable()).toThrow("interrupted");
  expect(new CompilerProposalObligations(f.root, f.fixture.source.id, "another-batch").unresolved()).toEqual([]);
});

it("does not infer settlement from a rejected-ID diagnostic or an earlier successful draft", async () => {
  const f = await setup();
  const service = new CompilerProposalService(f.root);
  const payload = {
    id: "retired-entity",
    kind: "character" as const,
    canonicalName: "Hero",
    aliases: [],
  };
  await service.submit("entity", {
    proposalId: "retired-envelope",
    payload: {
      ...payload,
      evidence: f.fixture.evidence("Hero"),
    },
    generatedBy: { worker: "test", compilerBatchId: f.batch.id },
  });
  await service.withdraw("retired-envelope", "The proposal is intentionally retired.");
  const ledger = new CompilerProposalObligations(f.root, f.fixture.source.id, f.batch.id);
  ledger.record("propose_entity", { proposal_id: "retired-envelope", payload }, "succeeded");
  ledger.record("propose_entity", { proposal_id: "retired-envelope", payload }, "running");
  ledger.record(
    "propose_entity",
    { proposal_id: "retired-envelope", payload },
    "failed",
    "Proposal retired-envelope already exists in rejected history; submit a new proposal id.",
  );

  expect(ledger.history("propose_entity", "retired-envelope").map((attempt) => attempt.status))
    .toEqual(["succeeded", "running", "failed"]);
  expect(ledger.unresolved()).toMatchObject([{ proposalId: "retired-envelope", status: "failed" }]);
  expect(() => ledger.assertFinishable()).toThrow("Unresolved compiler proposal obligations");
});

it("stops after the original and corrected inputs fail, including in a new session", async () => {
  const f = await setup(); const set = await f.create();
  await expect(call(set, "propose_entity_mention", f.input("broken", "Missing"))).rejects.toThrow("Exact evidence quote");
  await expect(call(set, "propose_entity_mention", f.input("broken", "Still missing"))).rejects.toThrow("Exact evidence quote");
  await expect(call(await f.create(), "propose_entity_mention", f.input("broken"))).rejects.toThrow("requires host review");
});

it("reports every missing exact quote before submitting any proposal", async () => {
  const f = await setup(); const set = createCompilerProposalToolset(f.root);
  await set.beginBatch(f.batch.segmentIds, f.batch.id.replace("-observation-", "-semantic-"), f.fixture.source.id);
  await expect(call(set, "propose_entity", {
    proposal_id: "hero", payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [] },
    evidence_segment_ids: f.batch.segmentIds,
    evidence_selectors: ["Hero", "Absent quotation", "Wrong slice"].map((exact) => ({ segment_id: f.batch.segmentIds[0], exact, target_path: "/canonicalName", relation: "supports", strength: "explicit" })),
  })).rejects.toThrow(/Evidence selector 2[\s\S]*Evidence selector 3/);
});

it("host selector correction preserves the failed identity and still uses exact-evidence validation", async () => {
  const f = await setup(), batch = f.batch.id.replace("-observation-", "-semantic-");
  const set = createCompilerProposalToolset(f.root); await set.beginBatch(f.batch.segmentIds, batch, f.fixture.source.id);
  const input = (exact: string) => ({ proposal_id: "host-corrected-entity", payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [] }, evidence_segment_ids: f.batch.segmentIds,
    evidence_selectors: [{ segment_id: f.batch.segmentIds[0], exact, target_path: "/canonicalName", relation: "supports", strength: "explicit" }] });
  for (const exact of ["Missing one", "Missing two"]) await expect(call(set, "propose_entity", input(exact))).rejects.toThrow("Exact evidence quote");
  const ledger = new CompilerProposalObligations(f.root, f.fixture.source.id, batch);
  const hashes = ledger.history("propose_entity", "host-corrected-entity").filter(a => a.status === "failed").map(a => a.inputHash);
  await expect(ledger.withHostSelectorCorrection("propose_entity", input("Hero"), [], "Reviewed source", "test:review", async () => {})).rejects.toThrow("every failed input");
  await expect(ledger.withHostSelectorCorrection("propose_entity", { ...input("Hero"), payload: { ...input("Hero").payload, id: "other" } }, hashes, "Reviewed source", "test:review", async () => {})).rejects.toThrow("cannot change payload");
  await ledger.withHostSelectorCorrection("propose_entity", input("Hero"), hashes, "Reviewed source", "test:review", async () => {
    expect(() => ledger.assertFinishable()).toThrow();
    expect(() => ledger.assertRetryAllowed("propose_entity", input("Not the reviewed quote"))).toThrow("requires host review");
    expect(() => new CompilerProposalObligations(f.root, f.fixture.source.id, batch).assertModelRecoveryAllowed()).toThrow();
    await call(set, "propose_entity", input("Hero"));
  });
  expect(ledger.unresolved()).toEqual([]);
  expect(ledger.history("propose_entity", "host-corrected-entity").filter(a => a.status === "failed")).toHaveLength(2);
  expect(ledger.history("propose_entity", "host-corrected-entity").at(-1)).toMatchObject({ status: "succeeded", hostReview: { auditRef: "test:review" } });
});

it("a failed host selector correction does not grant another retry or clear the obligation", async () => {
  const f = await setup(), batch = f.batch.id.replace("-observation-", "-semantic-");
  const set = createCompilerProposalToolset(f.root); await set.beginBatch(f.batch.segmentIds, batch, f.fixture.source.id);
  const input = (exact: string) => ({ proposal_id: "bad-host-correction", payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [] }, evidence_segment_ids: f.batch.segmentIds,
    evidence_selectors: [{ segment_id: f.batch.segmentIds[0], exact, target_path: "/canonicalName", relation: "supports", strength: "explicit" }] });
  for (const exact of ["Missing one", "Missing two"]) await expect(call(set, "propose_entity", input(exact))).rejects.toThrow("Exact evidence quote");
  const ledger = new CompilerProposalObligations(f.root, f.fixture.source.id, batch);
  const hashes = () => ledger.history("propose_entity", "bad-host-correction").filter(a => a.status === "failed").map(a => a.inputHash);
  await expect(ledger.withHostSelectorCorrection("propose_entity", input("Still missing"), hashes(), "Reviewed source", "test:review", () => call(set, "propose_entity", input("Still missing")))).rejects.toThrow("Exact evidence quote");
  expect(() => ledger.assertFinishable()).toThrow();
  await expect(call(set, "propose_entity", input("Hero"))).rejects.toThrow("requires host review");
  await expect(ledger.withHostSelectorCorrection("propose_entity", input("Hero"), hashes(), "Again", "test:again", async () => {})).rejects.toThrow("reviewed failure must stop");
});

it("derives source-pattern authority from chronological input without treating a valid corrected input as ambiguous", async () => {
  const f = await setup();
  const journal = new CompilerProposalObligations(f.root, f.fixture.source.id, f.batch.id);
  const original = { proposal_id: "pattern", payload: { id: "pattern", induction: { kind: "source-pattern", supportingEventIds: ["original-event"] } }, evidence_segment_ids: f.batch.segmentIds };
  journal.record("propose_action_schema", original, "failed", "Missing supporting occurrence.");
  journal.record("propose_action_schema", { ...original, payload: { ...original.payload, description: "Corrected interpretation" } }, "failed", "Still missing supporting occurrence.");
  const authority = journal.inspectSourcePatternUpstreamAuthority("propose_action_schema", "pattern");
  expect(authority.proposalObligation.originalSupportingEventIds).toEqual(["original-event"]);
  expect(authority.proposalObligation.originalInputHash).toBe(CompilerProposalObligations.identity("propose_action_schema", original).inputHash);
  expect(authority.proposalObligation.failedInputHashes).toHaveLength(2);
});

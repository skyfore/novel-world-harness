import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareCompilerBatches, CompilerBatchStore } from "../src/compiler/batches.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { CompilerProposalObligations } from "../src/compiler/proposal-obligations.js";
import { reviewAccountingObligation } from "../src/compiler/accounting-review.js";
import { SourceAccountingStore } from "../src/compiler/source-accounting.js";
import { ProposalStore } from "../src/world/canonical-model.js";
import { worldStorageRoot } from "../src/world/paths.js";
import { TraceStore } from "../src/trace/store.js";
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

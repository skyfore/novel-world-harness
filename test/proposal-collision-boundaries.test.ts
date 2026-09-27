import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CompilerProposalObligations } from "../src/compiler/proposal-obligations.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { worldStorageRoot } from "../src/world/paths.js";

// Independent host regressions: a no-write refusal cannot settle an earlier
// unresolved mutation or borrow lifecycle evidence from another novel.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function setup(foreignSource = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-collision-boundary-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero waits.\n");
  const proposalId = "retired-hero", batchId = "batch-observation-test";
  const ledger = new CompilerProposalObligations(root, fixture.source.id, batchId);
  const evidence = fixture.evidence("Hero");
  if (foreignSource) evidence[0]!.span.sourceId = "another-source";
  const file = path.join(worldStorageRoot(root), "proposals/rejected", `${proposalId}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 2, id: proposalId, kind: "entity",
    payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence },
    evidence, generatedBy: { worker: "propose_entity", compilerBatchId: batchId }, createdAt: new Date().toISOString() }));
  const report = path.join(worldStorageRoot(root), "proposals/rejection-reports", `${proposalId}.json`);
  await fs.mkdir(path.dirname(report), { recursive: true });
  await fs.writeFile(report, JSON.stringify({ version: 1, proposalId, kind: "entity", rejectedAt: new Date().toISOString(),
    errors: [{ code: "WITHDRAWN_COMPILER_PROPOSAL", message: "Original proposal was withdrawn; preserve history." }] }));
  return { ledger, input: { proposal_id: proposalId }, diagnostic: `Proposal ${proposalId} already exists in rejected history; submit a new proposal id.` };
}
it("a legacy collision does not erase an earlier unresolved real failure", async () => {
  const { ledger, input, diagnostic } = await setup();
  ledger.record("propose_entity", { ...input, correction: 1 }, "failed", "Evidence selector failed; correction has not succeeded.");
  ledger.record("propose_entity", input, "running");
  ledger.record("propose_entity", input, "failed", diagnostic);
  expect(ledger.unresolved().length).toBeGreaterThan(0);
  expect(() => ledger.assertFinishable()).toThrow();
});
it("same batch text in a foreign-source envelope is not a collision settlement proof", async () => {
  const { ledger, input, diagnostic } = await setup(true);
  ledger.record("propose_entity", input, "succeeded");
  ledger.record("propose_entity", input, "running");
  ledger.record("propose_entity", input, "failed", diagnostic);
  expect(ledger.unresolved().length).toBeGreaterThan(0);
});
it("a successful old draft and its rejection do not adjudicate a different failed replacement payload", async () => {
  const { ledger, input, diagnostic } = await setup();
  ledger.record("propose_entity", { ...input, payload: { id: "hero", canonicalName: "Hero" } }, "succeeded");
  const replacement = { ...input, payload: { id: "different-entity", canonicalName: "Someone else" } };
  ledger.record("propose_entity", replacement, "running");
  ledger.record("propose_entity", replacement, "failed", diagnostic);
  expect(ledger.unresolved().length).toBeGreaterThan(0);
  expect(() => ledger.assertFinishable()).toThrow();
});
it("collision recovery cannot hide an earlier interrupted invocation after the last success", async () => {
  const { ledger, input, diagnostic } = await setup();
  const original = { ...input, payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [] } };
  ledger.record("propose_entity", original, "succeeded");
  ledger.record("propose_entity", { ...original, selector: "interrupted-unknown-result" }, "running");
  ledger.record("propose_entity", original, "running");
  ledger.record("propose_entity", original, "failed", diagnostic);
  expect(ledger.unresolved().length).toBeGreaterThan(0);
  expect(() => ledger.assertFinishable()).toThrow();
});
it("a new preflight status must be rejected or retain the earlier unresolved mutation", async () => {
  const { ledger, input, diagnostic } = await setup();
  ledger.record("propose_entity", { ...input, correction: 1 }, "failed", "Real unresolved mutation failure.");
  ledger.record("propose_entity", input, "running");
  try {
    ledger.record("propose_entity", input, "preflight-rejected" as Parameters<CompilerProposalObligations["record"]>[2], diagnostic);
  } catch (error) {
    // Removing the proposed status entirely is also a safe repair.
    expect(error).toHaveProperty("name", "ZodError");
  }
  expect(ledger.unresolved().length).toBeGreaterThan(0);
  expect(() => ledger.assertFinishable()).toThrow();
});

it("model-facing immutable-ID refusal preserves the tool error rather than reporting success", async () => {
  const { createCompilerProposalToolset } = await import("../src/compiler/proposal-tools.js");
  const { withNwhToolRecovery } = await import("../src/agent/tool-recovery.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-collision-tool-")); roots.push(root);
  const f = await createEvidenceFixture(root, "Hero waits.\n");
  const set = createCompilerProposalToolset(root);
  await set.beginBatch([f.segmentId], "batch-semantic-test", f.source.id);
  const tool = withNwhToolRecovery(set.tools.find(t => t.name === "propose_entity")!);
  const input = { proposal_id: "hero-draft", payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [] as string[] },
    evidence_segment_ids: [f.segmentId], evidence_selectors: [{ segment_id: f.segmentId, exact: "Hero", target_path: "/canonicalName", relation: "supports", strength: "explicit" }] };
  await tool.execute("original", input as never, undefined, undefined, {} as never);
  await expect(tool.execute("collision", { ...input, payload: { ...input.payload, aliases: ["Hero"] } } as never,
    undefined, undefined, {} as never)).rejects.toThrow(/already exists|immutable/i);
});

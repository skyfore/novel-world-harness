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

it("retains interrupted attempts and cannot clear them with an unrelated proposal or another scope", async () => {
  const f = await setup();
  const ledger = new CompilerProposalObligations(f.root, f.fixture.source.id, f.batch.id);
  ledger.record("propose_action_schema", { proposal_id: "interrupted" }, "running", "Process ended before tool result.");
  ledger.record("propose_action_schema", { proposal_id: "unrelated" }, "succeeded");
  expect(() => ledger.assertRetryAllowed("propose_action_schema", { proposal_id: "interrupted" })).toThrow("Do not retry");
  expect(() => new CompilerProposalObligations(f.root, f.fixture.source.id, f.batch.id).assertFinishable()).toThrow("interrupted");
  expect(new CompilerProposalObligations(f.root, f.fixture.source.id, "another-batch").unresolved()).toEqual([]);
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

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { CompilerProposalObligations } from "../src/compiler/proposal-obligations.js";
import { RoleRosterStore } from "../src/compiler/role-roster.js";
import { ensureSourceStructure } from "../src/compiler/structure.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { withNwhToolRecovery } from "../src/agent/tool-recovery.js";
import { compilerBatchOutcomeFromMessages } from "../src/compiler/batch-outcome.js";
import { reviewNovelRoles } from "../src/workflow/role-review.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function setup(text = "Hero helps Friend.\nFriend thanks Hero.\n") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-roster-incremental-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, text);
  await ensureSourceStructure(root, fixture.source);
  for (const name of ["Hero", "Friend"]) await new CanonicalModelStore(root).putEntity({
    id: name.toLowerCase(), canonicalName: name, kind: "character", aliases: [], evidence: fixture.evidence(name),
  });
  const batch = `role-roster-${fixture.source.id}-incremental`;
  const open = async (batchId = batch) => {
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([], batchId, fixture.source.id);
    const call = (name: string, input: unknown) => withNwhToolRecovery(toolset.tools.find(tool => tool.name === name)!)
      .execute(name, input as never, undefined, undefined, {} as ExtensionContext);
    const read = async (name: string, input: unknown) => JSON.parse(((await call(name, input)).content[0] as { text: string }).text);
    return { toolset, call, read };
  };
  return { root, fixture, batch, open, journal: new CompilerProposalObligations(root, fixture.source.id, batch) };
}
function entry(candidateId: string, unitId: string) {
  return { candidateId, importance: "major", rationale: "Participates in the central exchange", basisUnitIds: [unitId],
    developmentExpectation: { kind: "unknown", rationale: "One exchange cannot establish development", basisUnitIds: [unitId] } };
}

it("pairs exact source text with IDs across UTF-8 page boundaries without losing whitespace or marking search as full reading", async () => {
  const text = `Hero ${"龙".repeat(9000)}.\n\nFriend waits.\n`;
  const f = await setup(text), { read } = await f.open();
  const roster = await read("read_role_roster", {});
  const found = await read("read_roster_evidence", { query: "龙" });
  expect(found.units[0].text).toContain("龙".repeat(9000));
  expect(found.units[0].sourcePages).toEqual([0, 1]);
  const before = await read("preview_role_roster_review", { subjectHash: roster.subjectHash });
  expect(before.unreadSourcePages).toEqual([0, 1]);
  const pages = await Promise.all([0, 1].map(page => read("read_roster_source_page", { page })));
  expect(pages.flatMap(page => page.units.map((unit: { text: string }) => unit.text)).join("")).toBe(text);
  expect(pages[1].units[0]).toMatchObject({ unitId: found.units[0].unitId, continued: true });
  const exact = await read("read_roster_evidence", { unitIds: [found.units[0].unitId] });
  expect(exact.units).toEqual(found.units);
});

it("previews exact denominator differences and evidence paths without consuming proposal attempts", async () => {
  const f = await setup(), { read } = await f.open();
  const roster = await read("read_role_roster", {});
  const candidate = roster.candidates[0].id;
  const bad = entry(candidate, "unit-guessed");
  const result = await read("preview_role_roster_review", { subjectHash: roster.subjectHash, entries: [bad, bad] });
  expect(result.complete).toBe(false);
  expect(result.semanticSupport).toBe("not-verified");
  expect(result.missingCandidateIds).toEqual([roster.candidates[1].id]);
  expect(result.issues).toContainEqual(expect.objectContaining({ code: "ROSTER_UNKNOWN_EVIDENCE_UNIT", path: "/entries/0/basisUnitIds/0", message: expect.stringContaining("unit-guessed") }));
  expect(result.issues.find((issue: { code: string }) => issue.code === "ROSTER_DENOMINATOR_MISMATCH").message).toContain(`"duplicateCandidateIds":["${candidate}"]`);
  expect(f.journal.latestAttempts("propose_role_roster_entry")).toEqual([]);
  expect(f.journal.history("propose_role_roster_review", "role-roster-review")).toEqual([]);
  expect(result.unreadSourcePages).toEqual([0]);
  const page = await read("read_roster_source_page", { page: 0 });
  const partial = await read("preview_role_roster_review", { subjectHash: roster.subjectHash, entries: [entry(candidate, page.units[0].unitId)], partial: true });
  expect(partial).toMatchObject({ structuralValid: true, complete: false, semanticSupport: "not-verified" });
});

it("restores candidate drafts from the original journal and assembles them only through the complete finish handshake", async () => {
  const f = await setup();
  let session = await f.open();
  const roster = await session.read("read_role_roster", {});
  const page = await session.read("read_roster_source_page", { page: 0 });
  const first = entry(roster.candidates[0].id, page.units[0].unitId);
  await session.call("propose_role_roster_entry", { subjectHash: roster.subjectHash, entry: first });
  expect(await new RoleRosterStore(f.root).read(f.fixture.source.id)).toBeNull();
  session = await f.open();
  const recovered = await session.read("preview_role_roster_review", { subjectHash: roster.subjectHash });
  expect(recovered.stagedCandidateIds).toEqual([first.candidateId]);
  expect(recovered.missingCandidateIds).toEqual([roster.candidates[1].id]);
  expect(recovered.unreadSourcePages).toEqual([0]);
  await session.read("read_roster_source_page", { page: 0 });
  await session.call("propose_role_roster_entry", { subjectHash: roster.subjectHash, entry: entry(roster.candidates[1].id, page.units[0].unitId) });
  expect(await session.read("preview_role_roster_review", { subjectHash: roster.subjectHash })).toMatchObject({ complete: true, missingCandidateIds: [], semanticSupport: "not-verified" });
  await session.call("propose_role_roster_review", { subjectHash: roster.subjectHash, staged: true });
  expect(await new RoleRosterStore(f.root).read(f.fixture.source.id)).toBeNull();
  await session.call("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Independently reviewed all candidates" });
  const saved = await new RoleRosterStore(f.root).read(f.fixture.source.id);
  expect(saved?.reviews[0]?.entries).toHaveLength(2);
  expect(saved?.reviews[0]?.entries).toContainEqual(first);
  expect(f.journal.unresolved()).toEqual([]);
});

it("keeps corrected and exhausted candidate attempts under one identity and gives an unambiguous stop", async () => {
  const f = await setup(), { call, read } = await f.open();
  const roster = await read("read_role_roster", {});
  const page = await read("read_roster_source_page", { page: 0 });
  const candidateId = roster.candidates[0].id;
  await expect(call("propose_role_roster_entry", { subjectHash: roster.subjectHash, entry: entry(candidateId, "bad-1") })).rejects.toThrow("ROSTER_UNKNOWN_EVIDENCE_UNIT");
  const valid = { subjectHash: roster.subjectHash, entry: entry(candidateId, page.units[0].unitId) };
  await call("propose_role_roster_entry", valid);
  expect(f.journal.unresolved()).toEqual([]);
  const second = roster.candidates[1].id;
  await expect(call("propose_role_roster_entry", { subjectHash: roster.subjectHash, entry: entry(second, "bad-1") })).rejects.toThrow("ROSTER_UNKNOWN_EVIDENCE_UNIT");
  const failure = await call("propose_role_roster_entry", { subjectHash: roster.subjectHash, entry: entry(second, "bad-2") }).catch(error => error);
  expect(failure.message).toContain("Stop model submissions");
  expect(failure.message).not.toContain("Recovery SOP:");
  expect(failure.message).not.toContain("before at most one corrected proposal retry");
  expect(f.journal.requiringHostReview()).toHaveLength(1);
  expect(f.journal.latestAttempts("propose_role_roster_entry")).toHaveLength(2);
  // A complete-input submission cannot make a failed staged candidate disappear at finish.
  await expect(call("propose_role_roster_review", { subjectHash: roster.subjectHash, entries: [valid.entry, entry(second, page.units[0].unitId)] })).rejects.toThrow("host review");
  await expect(call("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Attempted bypass" })).rejects.toThrow("host review");
  expect(await new RoleRosterStore(f.root).read(f.fixture.source.id)).toBeNull();
});

it("the message-level outcome also settles a corrected candidate without counting the earlier failure forever", () => {
  const messages = ["bad", "good"].flatMap((unitId, index) => [
    { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `call-${index}`, name: "propose_role_roster_entry", arguments: { subjectHash: "hash", entry: entry("same-candidate", unitId) } }] },
    { role: "toolResult", toolCallId: `call-${index}`, toolName: "propose_role_roster_entry", isError: index === 0 },
  ]);
  expect(compilerBatchOutcomeFromMessages(messages)).toMatchObject({ proposalFailed: 0, proposalSucceeded: 1 });
});

it("the workflow resumes successful drafts in their original scope and starts the second independent review separately", async () => {
  const f = await setup(), first = await f.open();
  const roster = await first.read("read_role_roster", {});
  const page = await first.read("read_roster_source_page", { page: 0 });
  await first.call("propose_role_roster_entry", { subjectHash: roster.subjectHash, entry: entry(roster.candidates[0].id, page.units[0].unitId) });
  const batches: string[] = [];
  await reviewNovelRoles({ root: f.root, configPath: path.join(f.root, "novel.config.yaml"), sourceId: f.fixture.source.id }, async options => {
    batches.push(options.compilerBatchId!);
    const session = await f.open(options.compilerBatchId);
    await session.read("read_roster_source_page", { page: 0 });
    const progress = await session.read("preview_role_roster_review", { subjectHash: roster.subjectHash });
    for (const candidateId of progress.missingCandidateIds) await session.call("propose_role_roster_entry", { subjectHash: roster.subjectHash, entry: entry(candidateId, page.units[0].unitId) });
    await session.call("propose_role_roster_review", { subjectHash: roster.subjectHash, staged: true });
    await session.call("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Independent complete review" });
  });
  expect(batches).toHaveLength(2);
  expect(batches[0]).toBe(f.batch);
  expect(batches[1]).not.toBe(f.batch);
  expect((await new RoleRosterStore(f.root).read(f.fixture.source.id))?.reviews.map(review => review.runId)).toEqual(batches);
});

it("stops stale draft scopes before invoking another model or changing their history", async () => {
  const f = await setup(), session = await f.open();
  const roster = await session.read("read_role_roster", {});
  const page = await session.read("read_roster_source_page", { page: 0 });
  await session.call("propose_role_roster_entry", { subjectHash: roster.subjectHash, entry: entry(roster.candidates[0].id, page.units[0].unitId) });
  const before = f.journal.latestAttempts("propose_role_roster_entry");
  const canon = new CanonicalModelStore(f.root);
  const hero = (await canon.listEntities()).find(entity => entity.id === "hero")!;
  await canon.putEntity({ ...hero, aliases: ["Changed identity input"] });
  let called = false;
  await expect(reviewNovelRoles({ root: f.root, configPath: path.join(f.root, "novel.config.yaml"), sourceId: f.fixture.source.id }, async () => { called = true; }))
    .rejects.toThrow("staged entries");
  expect(called).toBe(false);
  expect(f.journal.latestAttempts("propose_role_roster_entry")).toEqual(before);
});

it("reports all 60 omissions when a 76-candidate roster spans discovery pages", async () => {
  const names = Array.from({ length: 74 }, (_, index) => `Reader${String(index).padStart(2, "0")}`);
  const f = await setup(`Hero helps Friend.\n${names.map(name => `${name} watches.`).join("\n")}\n`);
  const canon = new CanonicalModelStore(f.root);
  for (const name of names) await canon.putEntity({ id: name.toLowerCase(), canonicalName: name, kind: "character", aliases: [], evidence: f.fixture.evidence(name) });
  const { read } = await f.open();
  const first = await read("read_role_roster", { offset: 0 });
  const second = await read("read_role_roster", { offset: first.nextOffset });
  expect(first.totalCandidates).toBe(76);
  expect(first.candidates).toHaveLength(50);
  expect(second.candidates).toHaveLength(26);
  expect(second.nextOffset).toBeUndefined();
  const page = await read("read_roster_source_page", { page: 0 });
  const preview = await read("preview_role_roster_review", { subjectHash: first.subjectHash, entries: first.candidates.slice(0, 16).map((candidate: { id: string }) => entry(candidate.id, page.units[0].unitId)) });
  expect(preview.complete).toBe(false);
  expect(preview.missingCandidateIds).toEqual([...first.candidates.slice(16), ...second.candidates].map(candidate => candidate.id));
  expect(preview.missingCandidateIds).toHaveLength(60);
});

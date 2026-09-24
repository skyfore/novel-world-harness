import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { RoleRosterStore } from "../src/compiler/role-roster.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { withNwhToolRecovery } from "../src/agent/tool-recovery.js";
import { ensureSourceStructure } from "../src/compiler/structure.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { recoverCompilerFinish } from "../src/compiler/finish-recovery.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { validateAssessmentRevision } from "../src/compiler/certification.js";
import { loadCurrentRoleRoster } from "../src/compiler/role-roster-tools.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

it("requires full source reading and the real finish handshake before persisting a role review", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-roster-tools-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero carries a letter.\n");
  await ensureSourceStructure(root, fixture.source);
  await new CanonicalModelStore(root).putEntity({ id: "hero", canonicalName: "Hero", kind: "character", aliases: [], evidence: fixture.evidence("Hero") });
  const toolset = createCompilerProposalToolset(root);
  await toolset.beginBatch([], `role-roster-${fixture.source.id}-review-1`, fixture.source.id);
  const call = async (name: string, input: unknown) => withNwhToolRecovery(toolset.tools.find((x) => x.name === name)!).execute(name, input as never, undefined, undefined, {} as ExtensionContext);
  const catalog = await call("read_role_roster", { offset: 0 });
  const data = JSON.parse((catalog.content[0] as { text: string }).text) as { subjectHash: string; candidates: Array<{ id: string }> };
  const premature = call("propose_role_roster_review", { subjectHash: data.subjectHash, entries: [{ candidateId: data.candidates[0]!.id, importance: "major", rationale: "Central action", basisUnitIds: ["guessed"], developmentExpectation: { kind: "unknown", rationale: "Insufficient evidence", basisUnitIds: ["guessed"] } }] });
  await expect(premature).rejects.toThrow("read_roster_source_page");
  const page = await call("read_roster_source_page", { page: 0 });
  const units = JSON.parse((page.content[0] as { text: string }).text).unitIds as string[];
  await call("propose_role_roster_review", { subjectHash: data.subjectHash, entries: [{ candidateId: data.candidates[0]!.id, importance: "major", rationale: "Central action", basisUnitIds: [units[0]!], developmentExpectation: { kind: "unknown", rationale: "A single act cannot establish development", basisUnitIds: [units[0]!] } }] });
  expect(await new RoleRosterStore(root).read(fixture.source.id)).toBeNull();
  const finished = await call("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Independent whole-source character review complete" });
  expect(finished.isError).not.toBe(true);
  expect((await new RoleRosterStore(root).read(fixture.source.id))?.reviews).toHaveLength(1);
  expect((await new RoleRosterStore(root).read(fixture.source.id))?.reviews[0]).toMatchObject({ version: 2, entries: [{ developmentExpectation: { kind: "unknown" } }] });
  await expect(recoverCompilerFinish(root, fixture.source.id, `role-roster-${fixture.source.id}-review-1`)).resolves.toBe(true);
  expect((await new RoleRosterStore(root).read(fixture.source.id))?.reviews).toHaveLength(1);
  await expect(call("propose_role_roster_review", { subjectHash: data.subjectHash, entries: [] })).rejects.toThrow("freezes this batch");
});


it("freezes independent development expectations and rechecks unknowns despite forged readiness", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-roster-cert-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero carries a letter.\n");
  await new CanonicalModelStore(root).putEntity({ id: "hero", canonicalName: "Hero", kind: "character", aliases: [], evidence: fixture.evidence("Hero") });
  await new InitialWorldStore(root).put({ version: 1, delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] }, evidence: fixture.evidence("Hero") });
  const batches = await prepareCompilerBatches(root, fixture.source);
  await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, batches.map(batch => batch.id));
  const { roster } = await loadCurrentRoleRoster(root, fixture.source.id);
  roster.reviews = ["first-review", "second-review"].map(runId => ({ version: 2, runId, subjectHash: roster.subjectHash,
    reviewedUnitIds: roster.unitIds, missingMajorCharacters: [], entries: roster.candidates.map(candidate => ({ candidateId: candidate.id,
      importance: "major", rationale: "Central actor", basisUnitIds: roster.unitIds,
      developmentExpectation: { kind: "unknown", rationale: "A single act cannot establish development", basisUnitIds: roster.unitIds },
    })),
  }));
  await new RoleRosterStore(root).write(roster);
  const candidate = await new PreparedNovelCache(root, path.join(root, "cache")).inspectCandidate(fixture.source);
  expect(candidate.bundle.compilerSnapshot.roleRoster).toEqual(roster);
  expect(candidate.assessment.issues).toContainEqual(expect.objectContaining({ code: "ROSTER_DEVELOPMENT_EXPECTATION_UNKNOWN" }));
  const forged = { ...candidate.assessment, issues: [], entryReady: true, fullNovelReady: true };
  expect(validateAssessmentRevision(candidate.bundle, forged).join()).toContain("ROSTER_DEVELOPMENT_EXPECTATION_UNKNOWN");
  delete roster.reviews[0]!.version;
  const legacy = structuredClone(candidate.bundle);
  legacy.compilerSnapshot.roleRoster = roster;
  expect(validateAssessmentRevision(legacy, forged).join()).toContain("ROSTER_DEVELOPMENT_EXPECTATION_UNKNOWN");
});


it("recovers role requirement registration after finish persisted the second review but the ledger write failed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-role-ledger-recovery-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero waits.\n");
  await ensureSourceStructure(root, fixture.source);
  await new CanonicalModelStore(root).putEntity({ id: "hero", canonicalName: "Hero", kind: "character", aliases: [], evidence: fixture.evidence("Hero") });
  for (const index of [1, 2]) {
    const batchId = `role-roster-${fixture.source.id}-independent-${index}`;
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([], batchId, fixture.source.id);
    const call = (name: string, input: unknown) => toolset.tools.find(tool => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as ExtensionContext);
    const roster = JSON.parse(((await call("read_role_roster", { offset: 0 })).content[0] as { text: string }).text);
    const page = JSON.parse(((await call("read_roster_source_page", { page: 0 })).content[0] as { text: string }).text);
    await call("propose_role_roster_review", { subjectHash: roster.subjectHash, entries: [{ candidateId: roster.candidates[0].id,
      importance: "major", rationale: "Central actor", basisUnitIds: page.unitIds,
      developmentExpectation: { kind: "unknown", rationale: "Insufficient development evidence", basisUnitIds: page.unitIds },
    }] });
    if (index === 2) vi.spyOn(RequirementLedger.prototype, "registerCoreRoles").mockRejectedValueOnce(new Error("simulated ledger publication interruption"));
    const finish = call("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Independent full source review" });
    if (index === 1) await finish;
    else {
      await expect(finish).rejects.toThrow("simulated ledger publication interruption");
      expect((await new RoleRosterStore(root).read(fixture.source.id))!.reviews).toHaveLength(2);
      expect(await new RequirementLedger(root, fixture.source.id).coreRoleDefinitionHistory()).toEqual([]);
      await expect(recoverCompilerFinish(root, fixture.source.id, batchId)).resolves.toBe(true);
      await expect(recoverCompilerFinish(root, fixture.source.id, batchId)).resolves.toBe(true);
    }
  }
  const history = await new RequirementLedger(root, fixture.source.id).coreRoleDefinitionHistory();
  expect(history).toHaveLength(1);
  expect(history[0]!.roster.reviews).toHaveLength(2);
});

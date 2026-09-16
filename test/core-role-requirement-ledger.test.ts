import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { buildRoleRoster, RoleRosterStore, roleRosterSchema } from "../src/compiler/role-roster.js";
import { baseStructuralUnits, ensureSourceStructure } from "../src/compiler/structure.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { contentHash } from "../src/world/canonical.js";
import { validateAssessmentRevision } from "../src/compiler/certification.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-core-role-ledger-")); roots.push(root);
  const source = await createEvidenceFixture(root, "Ada waits. Bo watches.");
  const canon = new CanonicalModelStore(root);
  const entities = ["ada", "bo"].map(id => ({ id, kind: "character" as const, canonicalName: id === "ada" ? "Ada" : "Bo", aliases: [], evidence: source.evidence(id === "ada" ? "Ada" : "Bo") }));
  for (const entity of entities) await canon.putEntity(entity);
  const structure = await ensureSourceStructure(root, source.source), units = baseStructuralUnits(structure);
  const roster = buildRoleRoster({ sourceId: source.source.id, sourceSha256: source.source.contentSha256, unitIds: structure.baseUnitIds, entities, annotations: [], resolutions: [] });
  roster.reviews = ["review-one", "review-two"].map(runId => ({ version: 2, runId, subjectHash: roster.subjectHash, reviewedUnitIds: roster.unitIds,
    entries: roster.candidates.map(candidate => ({ candidateId: candidate.id, importance: "major", rationale: "Independent original source review", basisUnitIds: roster.unitIds,
      developmentExpectation: { kind: "unknown", rationale: "Source evidence does not settle continuity", basisUnitIds: roster.unitIds },
    })),
  }));
  const normalized = roleRosterSchema.parse(roster);
  await new RoleRosterStore(root).write(normalized);
  const ledger = new RequirementLedger(root, source.source.id), bytes = Buffer.from("Ada waits. Bo watches.");
  const register = (current = normalized, predecessorRevision?: string, allowScopeReduction = false) => ledger.registerCoreRoles({ roster: current, units,
    predecessorRevision, allowScopeReduction, scopeDecisionRef: "independent-review-audit", scopeChangeReason: "Explicit host source review decision" }, bytes);
  return { root, source, canon, roster: normalized, units, ledger, bytes, register };
}

it("preserves role definitions in the shared hash chain across restart and requires an explicit reviewed scope reduction", async () => {
  const f = await fixture(), first = await f.register();
  expect(await f.register()).toEqual(first);
  expect(await new RequirementLedger(f.root, f.source.source.id).coreRoleDefinitionHistory()).toEqual([first]);
  expect(await f.ledger.definitions()).toEqual([]);
  const revised = structuredClone(f.roster);
  for (const review of revised.reviews) {
    review.runId += "-revision";
    review.entries.find(entry => entry.candidateId === revised.candidates.find(candidate => candidate.entityId === "bo")!.id)!.importance = "supporting";
  }
  await expect(f.register(revised)).rejects.toThrow("predecessor changed");
  await expect(f.register(revised, first.revisionHash)).rejects.toThrow("scope reduction requires host review");
  const second = await f.register(revised, first.revisionHash, true);
  expect(second.removedRequirementIds).toHaveLength(3);
  expect((await f.ledger.coreRoleDefinitionHistory()).map(definition => definition.revisionHash)).toEqual([first.revisionHash, second.revisionHash]);
  const rewritten = structuredClone(revised); rewritten.reviews[0]!.entries[0]!.rationale = "Rewritten old run";
  await expect(f.register(rewritten, second.revisionHash)).rejects.toThrow("review run was rewritten");
});

it("rejects bad original bytes, anchor corruption and incomplete partitions before publishing any role obligation", async () => {
  const f = await fixture();
  const input = { roster: f.roster, units: f.units, scopeDecisionRef: "audit", scopeChangeReason: "review" };
  await expect(f.ledger.registerCoreRoles(input, Buffer.from("different"))).rejects.toThrow("immutable source hash mismatch");
  const broken = structuredClone(input); broken.units[0]!.anchor.exactHash = "0".repeat(64);
  await expect(f.ledger.registerCoreRoles(broken, f.bytes)).rejects.toThrow("source unit evidence is invalid");
  const incomplete = structuredClone(input); incomplete.units.pop(); incomplete.roster.unitIds = incomplete.units.map(unit => unit.id);
  incomplete.roster.reviews.forEach(review => { review.reviewedUnitIds = incomplete.roster.unitIds; review.entries.forEach(entry => {
    entry.basisUnitIds = incomplete.roster.unitIds; entry.developmentExpectation = { kind: "unknown", rationale: "Incomplete", basisUnitIds: incomplete.roster.unitIds };
  }); });
  await expect(f.ledger.registerCoreRoles(incomplete, f.bytes)).rejects.toThrow("omits source bytes");
  expect(await f.ledger.history()).toEqual([]);
});

it("restores complete definition lineage without dropping a newer local obligation", async () => {
  const f = await fixture(), first = await f.register();
  const revised = structuredClone(f.roster); revised.reviews.forEach(review => { review.runId += "-fresh"; });
  await f.register(revised, first.revisionHash);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-core-role-clone-")); roots.push(root);
  const clone = new RequirementLedger(root, f.source.source.id), history = await f.ledger.coreRoleDefinitionHistory();
  await clone.restoreCoreRoles(history, f.bytes);
  await clone.restoreCoreRoles(history, f.bytes);
  expect(await clone.coreRoleDefinitionHistory()).toEqual(history);
  await expect(clone.restoreCoreRoles([first], f.bytes)).rejects.toThrow("forget current obligations");
  await expect(clone.restoreCoreRoles([], f.bytes)).rejects.toThrow("forget current obligations");
  expect((await clone.history()).filter(record => record.payload.kind === "core-role-definition")).toHaveLength(2);
});

it("freezes definitions in real candidates, records exact evaluations idempotently and rejects rollback before materialization", async () => {
  const f = await fixture(); await f.register();
  await new InitialWorldStore(f.root).put({ version: 1, evidence: f.source.evidence("Ada waits."), participantPresence: [{ entityId: "ada", mode: "physical" }], delta: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: true }, { op: "set", entityId: "ada", field: "character.plan", value: "wait" }] } });
  const batches = await prepareCompilerBatches(f.root, f.source.source);
  await new CompilerBatchStore(f.root).replaceCompleted(f.source.source.id, batches.map(batch => batch.id));
  const cache = new PreparedNovelCache(f.root, path.join(f.root, "cache"));
  const candidate = await cache.inspectCandidate(f.source.source);
  expect(candidate.bundle.compilerSnapshot.coreRoleRequirementDefinitions).toEqual(await f.ledger.coreRoleDefinitionHistory());
  expect(candidate.assessment.closure.nodes.some(node => node.kind === "core-role-requirements")).toBe(true);
  expect(candidate.assessment.issues.some(issue => issue.code === "CORE_ROLE_DEFINITION_NOT_CERTIFIED")).toBe(false);
  await f.ledger.recordCoreRoleEvaluation(candidate.bundle, candidate.assessment);
  await f.ledger.recordCoreRoleEvaluation(candidate.bundle, candidate.assessment);
  expect((await f.ledger.history()).filter(record => record.payload.kind === "core-role-evaluation")).toHaveLength(1);
  const wrongSource = structuredClone(candidate.bundle); wrongSource.source.contentSha256 = "0".repeat(64);
  await expect(f.ledger.recordCoreRoleEvaluation(wrongSource, candidate.assessment)).rejects.toThrow("current frozen definition");
  const forged = structuredClone(candidate.assessment); forged.coreRoleResult!.requirements.forEach(item => { item.state = "satisfied"; item.diagnostics = []; item.blockedBy = []; });
  await expect(f.ledger.recordCoreRoleEvaluation(candidate.bundle, forged)).rejects.toThrow("differs from its frozen deterministic result");
  const missingDefinition = structuredClone(candidate.bundle); missingDefinition.compilerSnapshot.coreRoleRequirementDefinitions = [];
  expect(validateAssessmentRevision(missingDefinition, candidate.assessment)).toContain("CORE_ROLE_DEFINITION_NOT_REGISTERED");
  const archive = await cache.archiveCandidate(f.source.source);
  const next = structuredClone(f.roster); next.reviews.forEach(review => { review.runId += "-new"; });
  await f.register(next, (await f.ledger.coreRoleDefinitionHistory()).at(-1)!.revisionHash);
  const ada = await f.canon.getEntity("ada"); await f.canon.putEntity({ ...ada, aliases: ["Current live value"] });
  const before = contentHash(await f.canon.listEntities());
  await expect(cache.restoreCompilerCheckpoint(f.source.source, archive.bundleHash!)).rejects.toThrow("forget current obligations");
  expect(contentHash(await f.canon.listEntities())).toBe(before);
});

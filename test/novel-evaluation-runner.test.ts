import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { RoleRosterStore, buildRoleRoster, roleRosterReviewSchema } from "../src/compiler/role-roster.js";
import { NovelEvaluationPlanStore, validateEvaluationPlan } from "../src/eval/novel-evaluation-plan.js";
import { evaluateNovelPlay, materialProjectionHash } from "../src/eval/novel-play-evaluator.js";
import { NovelPlayQualityStore } from "../src/eval/novel-play-quality.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { deriveCharacterEntrySeed } from "../src/world/entry-context.js";
import { WorldEngine } from "../src/world/engine.js";
import { StateSchemaRegistry, DEFAULT_STATE_FIELDS } from "../src/world/state.js";
import { workspaceStateDir } from "../src/agent/runtime-paths.js";
import { worldStorageRoot } from "../src/world/paths.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const evaluations = path.join(worldStorageRoot(root), "compiler", "evaluation-workspaces");
    for (const id of await fs.readdir(evaluations).catch(() => [])) await fs.rm(workspaceStateDir(path.join(evaluations, id)), { recursive: true, force: true });
    await fs.rm(workspaceStateDir(root), { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("freezes complete scenario inputs and records blocked runs as not-run without calling Pi or publishing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-evaluation-runner-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero stands in the hall and plans to wait.\n");
  const canonical = new CanonicalModelStore(root);
  await canonical.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") });
  await canonical.putEntity({ id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: fixture.evidence("hall") });
  await new InitialWorldStore(root).put({ version: 1, evidence: fixture.evidence("Hero stands in the hall and plans to wait."), delta: { version: 1, operations: [
    { op: "set", entityId: "hero", field: "character.alive", value: true }, { op: "set", entityId: "hero", field: "character.location", value: "hall" }, { op: "set", entityId: "hero", field: "character.plan", value: "wait" },
  ] } }); // No full projection seed: deterministic entry must block before any live call.
  const batches = await prepareCompilerBatches(root, fixture.source);
  await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));
  const cache = new PreparedNovelCache(root, path.join(root, "cache"));
  let bundle = await cache.candidateSnapshot(fixture.source);
  const roster = buildRoleRoster({ sourceId: fixture.source.id, sourceSha256: bundle.source.contentSha256, unitIds: bundle.compilerSnapshot.structure.baseUnitIds, entities: bundle.canonical.entities, annotations: [], resolutions: [] });
  roster.reviews = ["fixture-review-a", "fixture-review-b"].map((runId) => roleRosterReviewSchema.parse({ runId, subjectHash: roster.subjectHash, reviewedUnitIds: roster.unitIds, entries: roster.candidates.map((candidate) => ({ candidateId: candidate.id, importance: "major", rationale: "Fixture's sole person", basisUnitIds: roster.unitIds })) }));
  await new RoleRosterStore(root).write(roster);
  bundle = await cache.candidateSnapshot(fixture.source);
  const plans = new NovelEvaluationPlanStore(root);
  const frozen = await plans.freeze({ reviewerRunIds: ["fixture-gold-review"], gold: { version: 2, name: "Unannotated fixture", semantic: {} }, inapplicableLayers: [],
    criticalChecks: [{ id: "hero-identity", jsonPointer: "/canonical/entities/0/id", expected: bundle.canonical.entities[0]!.id }],
    roles: [{ candidateId: roster.candidates[0]!.id, actorId: "hero", entryCutHash: deriveCharacterEntrySeed(bundle, "hero").cut.hash, utterances: ["Wait"], maxTurns: 1,
      tasks: [{ id: "wait", description: "Wait at the hall", conditions: [{ op: "elapsed-days-gte", days: 1 }] }], knowledgeChecks: [{ actorId: "hero", claimId: "future-secret", when: [{ op: "fact-equals", entityId: "hero", field: "character.alive", value: true }] }],
      rejectedProbes: [{ id: "unbound-damage", candidate: { title: "Invent damage", participants: [], preconditions: [], requiresKnowledge: [], forbidsKnowledge: [], proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.health", value: 100 }] } } }],
    }] }, bundle);
  expect((await plans.read(frozen.hash)).roles[0]!.maxTurns).toBe(1);
  expect(() => validateEvaluationPlan({ ...frozen.plan, roles: [] }, bundle)).toThrow("DENOMINATOR");
  const report = await evaluateNovelPlay({ root, planHash: frozen.hash });
  expect(report.runs).toHaveLength(3);
  expect(report.runs.every((run) => run.mode === "not-run" && run.invocationIds.length === 0 && run.status === "failed")).toBe(true);
  expect(report.issues.map((issue) => issue.code)).toContain("NOVEL_LIVE_RUN_FAILED");
  expect((await new NovelPlayQualityStore(root).read(frozen.plan.subjectSnapshotHash))?.runs).toHaveLength(3);
  expect(await cache.loadActive(fixture.source)).toBeNull();
  await fs.chmod(path.join(plans.root, `${frozen.hash}.json`), 0o600);
  await fs.writeFile(path.join(plans.root, `${frozen.hash}.json`), JSON.stringify({ ...frozen.plan, criticalChecks: [{ ...frozen.plan.criticalChecks[0], expected: "tampered" }] }));
  await expect(plans.read(frozen.hash)).rejects.toThrow("EVALUATION_PLAN_INTEGRITY_FAILED");
});

it("excludes time, aging and repeated planning from substantive progress", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-evaluation-material-")); roots.push(root);
  const engine = new WorldEngine(root, { entities: new Map([["hero", { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] }]]), rules: new Map(), stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS) });
  const head = await engine.createBranch("main", "Internal test", { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.ageYears", value: 20 }] });
  const before = await engine.projections.project(head), after = structuredClone(before);
  after.state.values.hero!["character.ageYears"] = 21; after.state.values.hero!["character.plan"] = "A differently worded plan"; after.state.logicalTime.elapsedDays = 365;
  expect(materialProjectionHash(after)).toBe(materialProjectionHash(before));
  after.state.values.hero!["character.wealth"] = 1;
  expect(materialProjectionHash(after)).not.toBe(materialProjectionHash(before));
});

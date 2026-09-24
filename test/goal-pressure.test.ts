import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ActorModelStore, type CharacterGoal } from "../src/world/actors.js";
import { activeGoalPressures } from "../src/world/goal-pressure.js";
import { WorldEngine } from "../src/world/engine.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { buildFrontier } from "../src/world/frontier.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import type { Possibility } from "../src/world/model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it.each([
  { actor: "ada", text: "Ada needs to choose a plan for the letter. Deciding to prepare it completes this decision. Bo's later report is still unknown to her.", done: "prepare the letter" },
  { actor: "neri", text: "Neri needs to choose a plan for the lamp. Deciding to guard it completes this decision. Venn's later report has not reached him.", done: "guard the lamp" },
])("derives goal pressure from this head, preserves fork history, and excludes unknown future motives: $actor", async scene => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-goal-pressure-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, scene.text), evidence = fixture.evidence(scene.text);
  const goal: CharacterGoal = { id: "task", actorId: scene.actor, description: scene.text, priority: 0.6,
    requiresKnowledge: [], activation: { preconditions: [{ op: "fact-equals", entityId: scene.actor, field: "character.alive", value: true }], afterCanonicalEventIds: [] },
    completion: [{ op: "fact-equals", entityId: scene.actor, field: "character.plan", value: scene.done }], evidence };
  const goals: CharacterGoal[] = [goal,
    { ...goal, id: "secret", priority: 1, requiresKnowledge: ["later-report"] },
    { ...goal, id: "unknown", priority: 1, activation: { preconditions: [{ op: "fact-equals", entityId: scene.actor, field: "character.location", value: "unknown-place" }], afterCanonicalEventIds: [] } },
    { ...goal, id: "future", priority: 1, activation: { preconditions: [], afterCanonicalEventIds: ["later-event"] } },
    { ...goal, id: "unexperienced", priority: 1, activation: { preconditions: [], afterCanonicalEventIds: [], afterExperiencedCanonicalEventIds: ["later-event"] } },
    { ...goal, id: "expired", priority: 1, expiry: [{ op: "fact-equals", entityId: scene.actor, field: "character.alive", value: true }] },
  ];
  const engine = new WorldEngine(root, { sourceId: fixture.source.id, actorGoals: goals,
    entities: new Map([[scene.actor, { id: scene.actor, kind: "character", canonicalName: scene.actor, aliases: [], evidence }]]),
    claims: new Map(), rules: new Map(), stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS) });
  const { canonicalSnapshotHash: _hash, ...sameContext } = engine.context;
  const differentGoalEngine = new WorldEngine(root, { ...sameContext, actorGoals: [{ ...goal, priority: 1 }] });
  expect(differentGoalEngine.context.canonicalSnapshotHash).not.toBe(engine.context.canonicalSnapshotHash);
  const reorderedGoalEngine = new WorldEngine(root, { ...sameContext, actorGoals: [...goals].reverse() });
  expect(reorderedGoalEngine.context.canonicalSnapshotHash).toBe(engine.context.canonicalSnapshotHash);
  const head = await engine.createBranch("main", "Original", { version: 1, operations: [
    { op: "set", entityId: scene.actor, field: "character.alive", value: true },
    { op: "set", entityId: scene.actor, field: "character.plan", value: "waiting" },
  ] });
  const candidate: Possibility = { id: "intended", branchId: "main", evaluatedAtCommit: head, kind: "canon-analogue", canonicalEventId: "intended",
    title: scene.text, participants: [scene.actor], sourceActorId: scene.actor, sourceGoalId: "task",
    preconditions: [], blockers: [], causalParents: [], pressure: 1, sourceConfidence: 1, relevance: 1,
    proposedDelta: { version: 1, operations: [] }, evidence };
  const runtime = new WorldRuntime(engine, () => [candidate]);
  const current = await activeGoalPressures(engine, head);
  expect([...current.keys()]).toEqual(["task"]);
  const before = await runtime.refreshFrontier("main");
  expect(before.evaluated[0]!.factors.pressure).toBe(0.6);
  expect(before.evaluated[0]!.trace).toMatchObject({ pressureBasis: "active-goal", pressureGoals: [{ goalId: "task", actorId: scene.actor, pressure: 0.6 }] });
  const state = await engine.projector.project(head);
  const relation = { relationId: "motive", sourceEventId: "past", type: "motivates" as const, operationality: "motivational" as const, goalIds: ["task"], motivatedActorIds: [scene.actor] };
  const linked = { ...candidate, sourceGoalId: undefined, sourceActorId: undefined, causalLinks: [relation, { ...relation, relationId: "duplicate-motive" }] };
  const evaluate = (input: Possibility, realized = true) => buildFrontier("main", head, state, [input], { activeGoalPressures: current, realizedIds: new Set(realized ? ["past"] : []) }).evaluated[0]!;
  expect(evaluate(linked).factors.pressure).toBe(0.6);
  expect(evaluate(linked, false).factors.pressure).toBe(0);
  expect(evaluate({ ...linked, causalLinks: [{ ...relation, motivatedActorIds: ["someone-else"] }] }).factors.pressure).toBe(0);
  expect(evaluate({ ...linked, causalLinks: [{ ...relation, goalIds: ["secret"] }] }).factors.pressure).toBe(0);
  expect(evaluate({ ...candidate, preconditions: [{ op: "fact-equals", entityId: scene.actor, field: "character.alive", value: false }] }).status).toBe("latent");
  await runtime.forkBranch("main", head, "alternate", "Alternate");
  const result = await engine.commitProposal({ proposalId: "finish-task", branchId: "main", expectedParentCommit: head, source: "background", title: scene.done,
    participants: [scene.actor], proposedTime: { kind: "unknown" }, preconditions: [], causalParents: [], evidence,
    proposedDelta: { version: 1, operations: [{ op: "set", entityId: scene.actor, field: "character.plan", value: scene.done }] } });
  expect(result.newHead).toBeDefined();
  expect(result.newHead).not.toBe(head);
  expect((await runtime.refreshFrontier("main")).evaluated[0]!.factors.pressure).toBe(0);
  expect((await runtime.refreshFrontier("alternate")).evaluated[0]!.factors.pressure).toBe(0.6);
  expect((await runtime.refreshFrontier("main", head)).evaluated[0]!.trace).toEqual(before.evaluated[0]!.trace);
  await new ActorModelStore(root).putGoal({ ...goal, priority: 1 });
  expect((await runtime.refreshFrontier("alternate")).evaluated[0]!.factors.pressure).toBe(0.6);
  expect((await engine.projector.project(head)).values[scene.actor]?.["character.plan"]).toBe("waiting");
});

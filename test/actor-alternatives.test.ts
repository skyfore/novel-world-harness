import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ActorModelStore, deterministicActorProposalSource, type CharacterGoal } from "../src/world/actors.js";
import { WorldEngine } from "../src/world/engine.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it.each([
  { actor: "ada", text: "Ada is alive. Her first plan is already in effect; she can instead prepare the letter.", outcome: "prepare the letter" },
  { actor: "neri", text: "Neri still lives. Reaffirming his old plan changes nothing, but guarding the lamp is a new decision.", outcome: "guard the lamp" },
])("finds a legal compiled alternative before deduplicating the actor: $actor", async scene => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-actor-alternatives-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, scene.text), evidence = fixture.evidence(scene.text);
  const engine = new WorldEngine(root, { sourceId: fixture.source.id, entities: new Map([[scene.actor, { id: scene.actor, kind: "character", canonicalName: scene.actor, aliases: [], evidence }]]), claims: new Map(), rules: new Map(), stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS) });
  const head = await engine.createBranch("main", "Original", { version: 1, operations: [
    { op: "set", entityId: scene.actor, field: "character.alive", value: true },
    { op: "set", entityId: scene.actor, field: "character.plan", value: "old plan" },
  ] });
  const store = new ActorModelStore(root);
  const action = (value: string): NonNullable<CharacterGoal["candidateAction"]> => ({ title: value, preconditions: [], proposedDelta: { version: 1, operations: [{ op: "set", entityId: scene.actor, field: "character.plan", value }] } });
  const goal: CharacterGoal = { id: "choice", actorId: scene.actor, description: scene.text, priority: 0.5, requiresKnowledge: [], activation: { preconditions: [], afterCanonicalEventIds: [] }, evidence, candidateAction: action("old plan"), actionPatterns: [action(scene.outcome)] };
  await store.putGoal(goal);
  await store.putGoal({ ...goal, id: "urgent-but-empty", priority: 1, actionPatterns: [] });
  const source = deterministicActorProposalSource(engine, store);
  const selected = await source({ branchId: "main", commitId: head, maxActors: 1 });
  expect(selected).toHaveLength(1);
  expect(selected[0]!.proposal.title).toBe(scene.outcome);
  expect(await source({ branchId: "main", commitId: head, maxActors: 1 })).toEqual(selected);
  expect(await engine.branches.readHead("main")).toBe(head);
  expect((await engine.projector.project(head)).values[scene.actor]?.["character.plan"]).toBe("old plan");
  const moved = await new WorldRuntime(engine, async () => [], undefined, source).move({ branchId: "main", maxActorCandidates: 1, maxBackgroundCandidates: 0 });
  expect(moved.committedEvents).toHaveLength(1);
  expect((await engine.projector.project(moved.newHead)).values[scene.actor]?.["character.plan"]).toBe(scene.outcome);
});

it("reports exhausted alternative search without committing or calling the result absence of a driver", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-actor-alternative-budget-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Ada keeps the unchanged plan. Bo can prepare a letter."), evidence = fixture.evidence("Ada keeps the unchanged plan. Bo can prepare a letter.");
  const engine = new WorldEngine(root, { sourceId: fixture.source.id, entities: new Map([["ada", { id: "ada", kind: "character", canonicalName: "Ada", aliases: [], evidence }], ["bo", { id: "bo", kind: "character", canonicalName: "Bo", aliases: [], evidence }]]), claims: new Map(), rules: new Map(), stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS) });
  const head = await engine.createBranch("main", "Original", { version: 1, operations: [{ op: "set", entityId: "bo", field: "character.alive", value: true }, { op: "set", entityId: "ada", field: "character.alive", value: true }, { op: "set", entityId: "ada", field: "character.plan", value: "unchanged" }] });
  const store = new ActorModelStore(root);
  for (let index = 0; index < 65; index++) await store.putGoal({ id: `goal-${index}`, actorId: "ada", description: "Keep the old plan", priority: 0.5, requiresKnowledge: [], activation: { preconditions: [], afterCanonicalEventIds: [] }, evidence, candidateAction: { title: "Old plan", preconditions: [], proposedDelta: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.plan", value: "unchanged" }] } } });
  const source = deterministicActorProposalSource(engine, store);
  await expect(source({ branchId: "main", commitId: head, maxActors: 1 })).rejects.toThrow("ACTOR_ALTERNATIVE_BUDGET_EXHAUSTED");
  expect(await engine.branches.readHead("main")).toBe(head);
  expect((await engine.projector.project(head)).values.ada?.["character.plan"]).toBe("unchanged");
  expect(await source({ branchId: "main", commitId: head, maxActors: 0 })).toEqual([]);
  await store.putGoal({ id: "bo-prepares", actorId: "bo", description: "Prepare a letter", priority: 1, requiresKnowledge: [], activation: { preconditions: [], afterCanonicalEventIds: [] }, evidence,
    candidateAction: { title: "Prepare a letter", preconditions: [], proposedDelta: { version: 1, operations: [{ op: "set", entityId: "bo", field: "character.plan", value: "prepare a letter" }] } },
  });
  const established = await source({ branchId: "main", commitId: head, maxActors: 32 });
  expect(established).toHaveLength(1);
  expect(established[0]!.proposal.actorId).toBe("bo");
  expect(await engine.branches.readHead("main")).toBe(head);
});

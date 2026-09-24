import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ActorModelStore, deterministicActorProposalSource, type CharacterGoal } from "../src/world/actors.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture(response: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-compiled-outcome-"));
  roots.push(root);
  const goal: CharacterGoal = {
    id: "make-plan", actorId: "alice", description: "Decide what to do next", priority: 1,
    requiresKnowledge: [], evidence: [],
    activation: { preconditions: [{ op: "fact-equals", entityId: "alice", field: "character.alive", value: true }], afterCanonicalEventIds: [] },
    candidateAction: {
      title: "Alice adopts a plan", participants: ["alice", "bob"],
      preconditions: [], proposedDelta: { version: 1, operations: [] },
      proposedSemantics: { version: 1, operations: [{ op: "open-goal", localRef: "local-plan", goal: {
        actorId: "alice", description: "Ask Bob for help", priority: 0.7, targetEntityIds: ["bob"],
      } }] },
    },
  };
  const context: WorldModelContext = {
    entities: new Map([
      ["alice", { id: "alice", kind: "character", canonicalName: "Alice", aliases: [], evidence: [] }],
      ["bob", { id: "bob", kind: "character", canonicalName: "Bob", aliases: [], evidence: [] }],
      ["hall", { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] }],
    ]),
    rules: new Map(), actorGoals: [goal], stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  const engine = new WorldEngine(root, context);
  let head = await engine.createBranch("main", "Main", { version: 1, operations: [
    { op: "set", entityId: "alice", field: "character.alive", value: true },
    { op: "set", entityId: "bob", field: "character.alive", value: true },
    { op: "set", entityId: "alice", field: "character.location", value: "hall" },
    { op: "set", entityId: "bob", field: "character.location", value: "hall" },
  ] });
  if (response) {
    const result = await engine.commitProposal({
      proposalId: "bob-speaks", branchId: "main", expectedParentCommit: head,
      source: "player", actorId: "bob", title: "Bob offers help", participants: ["alice", "bob"],
      spokenUtterances: [{ speakerId: "bob", addresseeIds: ["alice"], content: "Can I help?", channel: "audible" }],
      proposedTime: { kind: "unknown" }, preconditions: [], proposedDelta: { version: 1, operations: [] },
      causalParents: [], evidence: [],
    });
    expect(result.report.accepted, JSON.stringify(result.report.errors)).toBe(true);
    head = result.newHead;
  }
  const source = deterministicActorProposalSource(engine, new ActorModelStore(root));
  return { root, context, engine, goal, source, head };
}

it.each([false, true])("commits and replays a compiled semantic-only action (response=%s)", async response => {
  const { root, context, engine, source, head } = await fixture(response);
  const before = await engine.projections.project(head);
  const reports: unknown[] = [];
  const preview = engine.previewProposal.bind(engine);
  engine.previewProposal = async proposal => {
    const result = await preview(proposal);
    reports.push(result.report.errors);
    return result;
  };
  const candidates = await source({ branchId: "main", commitId: head });
  expect(candidates, JSON.stringify(reports)).toHaveLength(1);
  expect(candidates[0]!.candidateSource).toBe("compiled-action");
  // Read-only selection must not install the proposed goal.
  expect((await engine.branches.read("main")).headCommitId).toBe(head);
  expect(Object.values(before.semantics.goals)).toEqual([]);
  const result = await engine.commitProposal(candidates[0]!.proposal);
  expect(result.report.accepted, JSON.stringify(result.report.errors)).toBe(true);
  const projected = await engine.projections.project(result.newHead);
  expect(Object.values(projected.semantics.goals)).toEqual([expect.objectContaining({ actorId: "alice", description: "Ask Bob for help", status: "open" })]);
  expect(projected.state.values).toEqual(before.state.values);
  const reopened = new WorldEngine(root, context);
  expect((await reopened.projections.project(result.newHead)).semantics).toEqual(projected.semantics);
});

it.each([false, true])("keeps activation and ownership gates for semantic-only actions (response=%s)", async response => {
  const { engine, goal, source, head } = await fixture(response);
  goal.activation!.preconditions = [{ op: "fact-equals", entityId: "alice", field: "character.plan", value: "ready" }];
  expect(await source({ branchId: "main", commitId: head })).toEqual([]);
  goal.activation!.preconditions = [];
  const operation = goal.candidateAction!.proposedSemantics!.operations[0]!;
  if (operation.op !== "open-goal") throw new Error("Expected goal operation");
  operation.goal.actorId = "bob";
  const rejectionCodes: string[] = [];
  const preview = engine.previewProposal.bind(engine);
  engine.previewProposal = async proposal => {
    const result = await preview(proposal);
    rejectionCodes.push(...result.report.errors.map(issue => issue.code));
    return result;
  };
  expect(await source({ branchId: "main", commitId: head })).toEqual([]);
  expect(rejectionCodes).toContain("ACTOR_OUTCOME_AUTHORITY_REQUIRED");
  expect((await engine.branches.read("main")).headCommitId).toBe(head);
  expect(Object.values((await engine.projections.project(head)).semantics.goals)).toEqual([]);
});

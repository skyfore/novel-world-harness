import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorldEngine } from "../src/world/engine.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import type { ActorProposalCandidate } from "../src/world/actors.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it.each([
  { actor: "ada", text: "Ada is alive and chooses to carry the letter. A plan requiring her death cannot guide that choice.", plan: "carry the letter" },
  { actor: "neri", text: "Neri remains alive. He decides to guard the lamp; a funeral plan is inapplicable.", plan: "guard the lamp" },
])("gates illegal high-priority actor proposals before arbitration: $actor", async scene => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-actor-legality-")); roots.push(root);
  const source = await createEvidenceFixture(root, scene.text);
  const evidence = source.evidence(scene.text);
  const engine = new WorldEngine(root, { sourceId: source.source.id,
    entities: new Map([[scene.actor, { id: scene.actor, kind: "character", canonicalName: scene.actor, aliases: [], evidence }]]),
    claims: new Map(), rules: new Map(), stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  });
  const head = await engine.createBranch("main", "Original", { version: 1, operations: [{ op: "set", entityId: scene.actor, field: "character.alive", value: true }] });
  const candidate = (commitId: string, legal: boolean): ActorProposalCandidate => ({
    priority: legal ? 0.1 : 1, goalId: legal ? "possible" : "impossible", candidateSource: "compiled-action",
    proposal: { proposalId: `${legal ? "possible" : "impossible"}-${commitId}`, branchId: "main", expectedParentCommit: commitId, source: "actor", actorId: scene.actor,
      title: legal ? scene.plan : "inapplicable plan", participants: [scene.actor], participantPresence: [{ entityId: scene.actor, mode: "physical" }], proposedTime: { kind: "unknown" },
      preconditions: [{ op: "fact-equals", entityId: scene.actor, field: "character.alive", value: legal }],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: scene.actor, field: "character.plan", value: legal ? scene.plan : "impossible" }] }, causalParents: [], evidence,
    },
  });
  const runtime = new WorldRuntime(engine, async () => [], undefined, ({ commitId }) => {
    const unknown = candidate(commitId, true);
    unknown.priority = 0.9;
    unknown.proposal.proposalId = `unknown-${commitId}`;
    unknown.proposal.preconditions = [{ op: "fact-equals", entityId: scene.actor, field: "character.title", value: "authorized" }];
    return [candidate(commitId, false), unknown, candidate(commitId, true)];
  });
  const result = await runtime.move({ branchId: "main", maxActorCandidates: 1, maxBackgroundCandidates: 0 });
  expect(result.committedEvents).toHaveLength(1);
  expect((await engine.projector.project(result.newHead)).values[scene.actor]?.["character.plan"]).toBe(scene.plan);
  expect(result.rejectedProposals).toContain(`impossible-${head}`);
  expect(result.rejectedProposals).toContain(`unknown-${head}`);
  expect(result.trace.candidates.find(item => item.proposalId === `impossible-${head}`)).toMatchObject({ status: "rejected", commitBoundary: { beforeHead: head, afterHead: head, moved: false }, gates: expect.arrayContaining([expect.objectContaining({ gate: "validation", outcome: "fail" }), expect.objectContaining({ code: "COMMIT_NOT_ATTEMPTED" })]) });
  expect(result.trace.candidates.find(item => item.proposalId === `possible-${head}`)?.status).toBe("accepted");
  expect((await engine.projector.project(head)).values[scene.actor]?.["character.plan"]).toBeUndefined();
  const rejectedOnly = new WorldRuntime(engine, async () => [], undefined, ({ commitId }) => [candidate(commitId, false)]);
  const stopped = await rejectedOnly.move({ branchId: "main", maxActorCandidates: 1, maxBackgroundCandidates: 0 });
  expect(stopped.committedEvents).toEqual([]);
  expect(stopped.newHead).toBe(result.newHead);
  expect(await engine.branches.readHead("main")).toBe(result.newHead);
});

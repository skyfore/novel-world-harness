import { actionSchemaSchema } from "../src/world/action-ontology.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionConstraint } from "../src/world/action-constraint.js";
import type { ActorProposalCandidate, CharacterGoal } from "../src/world/actors.js";
import type { ScopedWorldArtifacts } from "../src/world/context.js";
import { WorldEngine } from "../src/world/engine.js";
import { modelActorProposalSource } from "../src/world/model-actor-policy.js";
import type { Entity, EventProposal, StoryTime } from "../src/world/model.js";
import { adjudicateActorCandidates, WorldRuntime } from "../src/world/runtime.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function actorProposal(id: string, actorId: string, priority: number, input: {
  writes?: Array<{ entityId: string; field: string; value: string | boolean }>;
  preconditions?: EventProposal["preconditions"];
  action?: EventProposal["action"];
  participants?: string[];
  proposedTime?: StoryTime;
  coordination?: ActorProposalCandidate["coordination"];
} = {}): ActorProposalCandidate {
  return {
    goalId: `goal-${id}`,
    priority,
    candidateSource: "injected",
    ...(input.coordination ? { coordination: input.coordination } : {}),
    proposal: {
      proposalId: id,
      branchId: "main",
      expectedParentCommit: "head",
      source: "actor",
      actorId,
      title: id,
      participants: [...new Set([actorId, ...(input.participants ?? [])])],
      proposedTime: input.proposedTime ?? { kind: "unknown" },
      preconditions: input.preconditions ?? [],
      proposedDelta: {
        version: 1,
        operations: (input.writes ?? [{ entityId: actorId, field: "character.plan", value: id }])
          .map((write) => ({ op: "set" as const, ...write })),
      },
      ...(input.action ? { action: input.action } : {}),
      causalParents: [],
      evidence: [],
    },
  };
}

describe("hybrid autonomous actor policy", () => {
  it("uses a valid compiled action before spending a bounded model-call budget", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-hybrid-actor-"));
    roots.push(root);
    const entities: Entity[] = ["a", "b", "c"].map((id) => ({
      id,
      kind: "character",
      canonicalName: id.toUpperCase(),
      aliases: [],
      evidence: [],
    }));
    const room: Entity = { id: "room", kind: "location", canonicalName: "Room", aliases: [], evidence: [] };
    const goals: CharacterGoal[] = entities.map((entity, index) => ({
      id: `goal-${entity.id}`,
      actorId: entity.id,
      description: `Advance ${entity.id}'s current plan`,
      priority: 1 - index * 0.1,
      requiresKnowledge: [],
      activation: { preconditions: [], afterCanonicalEventIds: [] },
      ...(entity.id === "a" ? {
        candidateAction: {
          title: "A follows the compiled plan",
          preconditions: [],
          proposedDelta: { version: 1, operations: [{ op: "set", entityId: "a", field: "character.plan", value: "compiled" }] },
        },
      } : {}),
      evidence: [],
    }));
    const engine = new WorldEngine(root, {
      entities: new Map([...entities, room].map((entity) => [entity.id, entity])),
      rules: new Map(),
      actorGoals: goals,
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    const head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: entities.flatMap((entity) => [
        { op: "set" as const, entityId: entity.id, field: "character.alive", value: true },
        { op: "set" as const, entityId: entity.id, field: "character.location", value: "room" },
      ]),
    });
    let calls = 0;
    const source = modelActorProposalSource(engine, {
      goals: async () => goals,
      modelFor: async () => null,
      maxActorsPerRefresh: 3,
      maxModelCallsPerRefresh: 1,
      reasoner: (input) => {
        calls += 1;
        return {
          title: "A model fallback acts",
          participants: [],
          preconditions: [],
          proposedDelta: {
            version: 1,
            operations: [{ op: "set", entityId: input.actor.actorId, field: "character.plan", value: "model" }],
          },
        };
      },
    });

    const candidates = await source({ branchId: "main", commitId: head, maxActors: 3, maxModelCalls: 1 });
    expect(calls).toBe(1);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.candidateSource)).toEqual(["compiled-action", "model-reasoner"]);
    expect(candidates[0]?.proposal.title).toBe("A follows the compiled plan");
    expect(candidates[0]?.salience).toMatchObject({ tier: 1, goalPriority: 1 });
  });

  it("omits a model decision with no material effect", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-hybrid-noop-"));
    roots.push(root);
    const hero: Entity = { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] };
    const goal: CharacterGoal = {
      id: "wait",
      actorId: hero.id,
      description: "Consider whether to act",
      priority: 1,
      requiresKnowledge: [],
      activation: { preconditions: [], afterCanonicalEventIds: [] },
      evidence: [],
    };
    const engine = new WorldEngine(root, {
      entities: new Map([[hero.id, hero]]),
      rules: new Map(),
      actorGoals: [goal],
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    const head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: hero.id, field: "character.alive", value: true }],
    });
    const source = modelActorProposalSource(engine, {
      goals: async () => [goal],
      modelFor: async () => null,
      reasoner: () => ({
        title: "Generic reaction",
        participants: [],
        preconditions: [],
        proposedDelta: { version: 1, operations: [] },
      }),
    });
    await expect(source({ branchId: "main", commitId: head })).resolves.toEqual([]);
  });

  it("rejects malformed model output without aborting the actor refresh", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-hybrid-invalid-model-"));
    roots.push(root);
    const hero: Entity = { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] };
    const goal: CharacterGoal = {
      id: "act",
      actorId: hero.id,
      description: "Act within current capability",
      priority: 1,
      requiresKnowledge: [],
      activation: { preconditions: [], afterCanonicalEventIds: [] },
      evidence: [],
    };
    const engine = new WorldEngine(root, {
      entities: new Map([[hero.id, hero]]),
      rules: new Map(),
      actorGoals: [goal],
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    const head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: hero.id, field: "character.alive", value: true }],
    });
    const source = modelActorProposalSource(engine, {
      goals: async () => [goal],
      modelFor: async () => null,
      reasoner: () => ({
        title: "Invent an unavailable target",
        participants: ["guessed-hidden-id"],
        preconditions: [],
        proposedDelta: {
          version: 1,
          operations: [{ op: "set", entityId: "actor-self", field: "character.plan", value: "invalid" }],
        },
      }),
    });

    await expect(source({ branchId: "main", commitId: head })).resolves.toEqual([]);
  });

  it("injects the hybrid reasoner through the workspace composition root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-hybrid-workspace-"));
    roots.push(root);
    const sourceId = "novel";
    const evidence = [{
      span: { sourceId, startLine: 1, endLine: 1, quoteHash: "workspace-actor-evidence" },
      strength: "explicit" as const,
    }];
    const hero: Entity = { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence };
    const goal: CharacterGoal = {
      id: "workspace-goal",
      actorId: hero.id,
      description: "Choose the next concrete step",
      priority: 1,
      requiresKnowledge: [],
      activation: { preconditions: [], afterCanonicalEventIds: [] },
      evidence,
    };
    const artifacts: ScopedWorldArtifacts = {
      entities: [hero],
      propositions: [],
      attributions: [],
      claims: [],
      events: [],
      eventParticipations: [],
      eventRelations: [],
      spatialRelations: [],
      sceneOccurrences: [],
      eventFrames: [],
      actionSchemas: [],
      actionConstraints: [],
      normTemplates: [],
      processTemplates: [],
      rules: [],
      goals: [goal],
      models: [],
      possibilities: [],
    };
    let calls = 0;
    const world = await openWorkspaceWorld(root, undefined, {
      sourceId,
      preparedRevisionHash: "a".repeat(64),
      artifacts,
      actorReasoner: (input) => {
        calls += 1;
        return {
          title: "Take the next step",
          participants: [],
          preconditions: [],
          proposedDelta: {
            version: 1,
            operations: [{ op: "set", entityId: input.actor.actorId, field: "character.plan", value: "next-step" }],
          },
        };
      },
      maxActorModelCallsPerRefresh: 1,
    });
    await world.engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: hero.id, field: "character.alive", value: true }],
    });

    const moved = await world.runtime.move({ branchId: "main", maxActorCandidates: 1 });

    expect(calls).toBe(1);
    expect(moved.committedEvents).toHaveLength(1);
    expect(moved.rejectedProposals).toEqual([]);
    const state = await world.engine.projector.project(moved.newHead);
    expect(state.values.hero?.["character.plan"]).toBe("next-step");
  });
});

describe("multi-actor footprint adjudication", () => {
  it("detects read/write, resource, exclusivity, consent, and authority conflicts", () => {
    const readWrite = adjudicateActorCandidates([
      actorProposal("writer", "a", 1, { writes: [{ entityId: "door", field: "location.open", value: false }] }),
      actorProposal("reader", "b", 0.9, {
        preconditions: [{ op: "fact-equals", entityId: "door", field: "location.open", value: true }],
      }),
    ], 2);
    expect(readWrite.conflicts[0]).toMatchObject({ conflictKinds: ["read-write"], keys: ["state:door:location.open"] });

    const resourceAction = (actorId: string): EventProposal["action"] => ({
      lane: "ad-hoc",
      actionKindId: "reserve-water",
      description: "Reserve the same water supply",
      footprint: {
        reads: [{ entityId: "well", field: "resource.amount" }],
        writes: [{ entityId: actorId, field: "character.plan" }],
        resources: [{ entityId: "well", field: "resource.amount", mode: "reserve" }],
      },
    });
    const resource = adjudicateActorCandidates([
      actorProposal("reserve-a", "a", 1, { action: resourceAction("a") }),
      actorProposal("reserve-b", "b", 0.9, { action: resourceAction("b") }),
    ], 2);
    expect(resource.conflicts[0]).toMatchObject({ conflictKinds: ["resource"], keys: ["resource:well:resource.amount"] });

    const coordinated = adjudicateActorCandidates([
      actorProposal("lead", "a", 1, {
        participants: ["shared", "judge"],
        coordination: { exclusiveParticipantIds: ["shared"], consentActorIds: [], authorityEntityIds: [] },
      }),
      actorProposal("follow", "b", 0.9, {
        participants: ["shared", "a", "judge"],
        coordination: {
          exclusiveParticipantIds: ["shared"],
          consentActorIds: ["a"],
          authorityEntityIds: ["judge"],
        },
        writes: [{ entityId: "judge", field: "character.plan", value: "rule" }],
      }),
    ], 2);
    expect(coordinated.conflicts[0]?.conflictKinds).toEqual(expect.arrayContaining(["exclusive-participant", "consent"]));

    const authority = adjudicateActorCandidates([
      actorProposal("judge-acts", "judge", 1),
      actorProposal("needs-judge", "b", 0.9, {
        participants: ["judge"],
        coordination: { exclusiveParticipantIds: [], consentActorIds: [], authorityEntityIds: ["judge"] },
      }),
    ], 2);
    expect(authority.conflicts[0]).toMatchObject({ conflictKinds: ["authority"], keys: ["authority:judge"] });
  });

  it("allows the same write address when story-time windows are definitely disjoint", () => {
    const result = adjudicateActorCandidates([
      actorProposal("first", "a", 1, {
        writes: [{ entityId: "door", field: "location.open", value: true }],
        proposedTime: { kind: "exact", value: "2000", precision: "year" },
      }),
      actorProposal("later", "b", 0.9, {
        writes: [{ entityId: "door", field: "location.open", value: false }],
        proposedTime: { kind: "exact", value: "2001", precision: "year" },
      }),
    ], 2);
    expect(result.selected).toHaveLength(2);
    expect(result.conflicts).toEqual([]);
  });

  it("revalidates each selected action against the new head after the prior commit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-actor-revalidate-"));
    roots.push(root);
    const entities: Entity[] = [
      { id: "a", kind: "character", canonicalName: "A", aliases: [], evidence: [] },
      { id: "b", kind: "character", canonicalName: "B", aliases: [], evidence: [] },
      { id: "door", kind: "location", canonicalName: "Door", aliases: [], evidence: [] },
    ];
    const hiddenConstraint: ActionConstraint = {
      ontologyVersion: "action-constraint-v1",
      id: "door-must-remain-open",
      name: "Crossing requires an open door",
      actionPattern: { kind: "ad-hoc", actionKindId: "cross-door" },
      appliesWhen: [],
      clauses: [{
        id: "open-before",
        timing: "before",
        modality: "require",
        predicate: { op: "fact-equals", entity: { kind: "entity", entityId: "door" }, field: "location.open", value: true },
      }],
      exceptions: [],
      priority: 1,
      defeasible: false,
      overridesConstraintIds: [],
      status: "supported",
      visibility: "engine",
      induction: { kind: "domain-module", moduleId: "doors", moduleVersion: "1" },
      evidence: [],
    };
    const engine = new WorldEngine(root, {
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      rules: new Map(),
      actionConstraints: new Map([[hiddenConstraint.id, hiddenConstraint]]),
      actionSchemas: new Map([["close-door", actionSchemaSchema.parse({ ontologyVersion: "action-schema-v1", id: "close-door", name: "Close a door", initiatorRoleId: "operator", roles: [{ id: "operator", label: "Operator", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }], parameters: [], preconditions: [], stateEffects: [{ op: "set", entity: { kind: "entity", entityId: "door" }, field: "location.open", value: { source: "literal", value: false } }], effectEnvelope: { maxStateOperations: 1, allowedStateFields: ["location.open"], allowsKnowledge: false, allowsTimeAdvance: false, allowsSceneTransition: false }, induction: { kind: "domain-module", moduleId: "test-doors", moduleVersion: "1" }, evidence: [] })]]),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    const head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "a", field: "character.alive", value: true },
        { op: "set", entityId: "b", field: "character.alive", value: true },
        { op: "set", entityId: "door", field: "location.open", value: true },
      ],
    });
    const closesDoor = actorProposal("close-door", "a", 1, {
      writes: [{ entityId: "door", field: "location.open", value: false }],
    });
    const crossesDoor = actorProposal("cross-door", "b", 0.9, {
      action: {
        lane: "ad-hoc",
        actionKindId: "cross-door",
        description: "Cross the door",
        footprint: {
          reads: [],
          writes: [{ entityId: "b", field: "character.plan" }],
          resources: [],
        },
      },
    });
    closesDoor.proposal.action = { lane: "schema-bound", schemaId: "close-door", roleBindings: [{ roleId: "operator", entityIds: ["a"] }], parameters: {} };
    closesDoor.proposal.expectedParentCommit = head;
    crossesDoor.proposal.expectedParentCommit = head;
    const runtime = new WorldRuntime(engine, () => [], undefined, () => [closesDoor, crossesDoor]);

    const result = await runtime.move({ branchId: "main", maxActorCandidates: 2 });
    expect(result.committedEvents).toHaveLength(1);
    expect(result.rejectedProposals).toContain("cross-door");
    expect(result.adjudicationConflicts).toEqual([]);
    const state = await engine.projector.project(result.newHead);
    expect(state.values.door?.["location.open"]).toBe(false);
    expect(state.values.b?.["character.plan"]).toBeUndefined();
  });
});

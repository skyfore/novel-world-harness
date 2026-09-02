import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CharacterGoal, CharacterModel } from "../src/world/actors.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { modelActorProposalSource, type ActorReasoningInput } from "../src/world/model-actor-policy.js";
import type { Claim, Entity } from "../src/world/model.js";
import type { NormTemplate } from "../src/world/norm-ontology.js";
import type { ProcessTemplate } from "../src/world/process-ontology.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("model actor policy", () => {
  it("passes actor-scoped knowledge rather than compiler omniscience to the reasoner", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-model-actor-"));
    roots.push(root);
    const sourceEvidence = [{
      span: { sourceId: "test", startLine: 1, endLine: 1, quoteHash: "model-actor-source" },
      strength: "explicit" as const,
    }];
    const entities: Entity[] = [
      { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: sourceEvidence },
      { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: sourceEvidence },
    ];
    const publicClaim: Claim = { id: "public", subject: "hero", predicate: "invited", object: true, epistemicType: "explicit-fact", evidence: sourceEvidence };
    const secretClaim: Claim = { id: "secret", subject: "hero", predicate: "future-betrayal", object: true, epistemicType: "explicit-fact", evidence: sourceEvidence };
    const context: WorldModelContext = {
      sourceId: "test",
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      claims: new Map([[publicClaim.id, publicClaim], [secretClaim.id, secretClaim]]),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    };
    const engine = new WorldEngine(root, context);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
      ],
    });
    const learned = await engine.commitProposal({
      proposalId: "learn-public",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "Hero learns invitation",
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "hero", claimId: "public", status: "knows", confidence: 1 }] },
      causalParents: [],
      evidence: [],
    });

    const goal: CharacterGoal = {
      id: "respond",
      actorId: "hero",
      description: "Respond to the invitation",
      priority: 1,
      requiresKnowledge: ["public"],
      evidence: [{ span: { sourceId: "test", startLine: 1, endLine: 1, quoteHash: "x" }, strength: "strong-inference" }],
    };
    const model: CharacterModel = {
      actorId: "hero",
      traits: { courage: 0.25 },
      decisionBiases: { caution: 0.5 },
      developmentPhases: [{
        id: "future-phase",
        label: "Future betrayal response",
        activation: {
          preconditions: [],
          afterCanonicalEventIds: ["future-betrayal-event"],
          afterExperiencedCanonicalEventIds: [],
          requiresKnowledge: [],
        },
        traitModifiers: { courage: -1 },
        decisionBiasModifiers: {},
        evidence: [{ span: { sourceId: "test", startLine: 99, endLine: 99, quoteHash: "future-phase-evidence" }, strength: "explicit" }],
      }],
      evidence: [{ span: { sourceId: "test", startLine: 1, endLine: 1, quoteHash: "model-evidence" }, strength: "explicit" }],
    };
    let observed: ActorReasoningInput | undefined;
    const source = modelActorProposalSource(engine, {
      goals: async () => [goal],
      modelFor: async () => model,
      reasoner(input) {
        observed = input;
        return {
          title: "Hero responds",
          participants: [],
          preconditions: [],
          proposedDelta: { version: 1, operations: [{ op: "set", entityId: input.actor.actorId, field: "character.plan", value: "respond" }] },
        };
      },
    });
    const candidates = await source({ branchId: "main", commitId: learned.newHead });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.proposal.title).toBe("Validated actor action by Hero");
    expect(candidates[0]?.proposal.title).not.toBe("Hero responds");
    expect(observed?.actor.actorId).toBe("actor-self");
    expect(observed?.actor.knowledge.map((entry) => entry.claimId)).toEqual(["claim-001"]);
    expect(observed?.model).toEqual({ traits: { courage: 0.25 }, decisionBiases: { caution: 0.5 } });
    const serialized = JSON.stringify(observed);
    expect(serialized).not.toContain("future-betrayal");
    expect(serialized).not.toContain("future-phase");
    expect(serialized).not.toContain("model-evidence");
    expect(serialized).not.toContain("quoteHash");
    expect(serialized).not.toContain('"actorId":"hero"');
    expect(serialized).not.toContain('"claimId":"public"');
    expect(serialized).not.toContain(learned.newHead);
    expect(observed).not.toHaveProperty("worldState");
    expect(observed?.actor).not.toHaveProperty("atCommit");
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed?.actor.knowledge)).toBe(true);
  });

  it("does not invoke model reasoning for a goal whose phase activation is false", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-model-actor-phase-"));
    roots.push(root);
    const hero: Entity = { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] };
    const hall: Entity = { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] };
    const camp: Entity = { id: "camp", kind: "location", canonicalName: "Camp", aliases: [], evidence: [] };
    const engine = new WorldEngine(root, {
      entities: new Map([[hero.id, hero], [hall.id, hall], [camp.id, camp]]),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    const head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
      ],
    });
    const goal: CharacterGoal = {
      id: "camp-only-goal",
      actorId: "hero",
      description: "Act only after reaching camp",
      priority: 1,
      requiresKnowledge: [],
      activation: {
        preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.location", value: "camp" }],
        afterCanonicalEventIds: [],
      },
      evidence: [{ span: { sourceId: "test", startLine: 1, endLine: 1, quoteHash: "x" }, strength: "explicit" }],
    };
    let reasoned = false;
    const source = modelActorProposalSource(engine, {
      goals: async () => [goal],
      modelFor: async () => null,
      reasoner: () => {
        reasoned = true;
        return { title: "Should not run", participants: [], preconditions: [], proposedDelta: { version: 1, operations: [] } };
      },
    });
    await expect(source({ branchId: "main", commitId: head })).resolves.toEqual([]);
    expect(reasoned).toBe(false);
  });

  it("does not expose an untriggered future-only goal to model reasoning", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-model-actor-future-goal-"));
    roots.push(root);
    const hero: Entity = { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] };
    const engine = new WorldEngine(root, {
      entities: new Map([[hero.id, hero]]),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    const head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    }, undefined, undefined, undefined, [{
      span: { sourceId: "test", startLine: 1, endLine: 1, quoteHash: "opening" },
      strength: "explicit",
    }]);
    const futureGoal: CharacterGoal = {
      id: "late-revenge",
      actorId: "hero",
      description: "Seek revenge revealed only much later",
      priority: 1,
      requiresKnowledge: [],
      evidence: [{ span: { sourceId: "test", startLine: 500, endLine: 500, quoteHash: "late" }, strength: "explicit" }],
    };
    let reasoned = false;
    const source = modelActorProposalSource(engine, {
      goals: async () => [futureGoal],
      modelFor: async () => null,
      reasoner: () => {
        reasoned = true;
        return { title: "Should not run", participants: [], preconditions: [], proposedDelta: { version: 1, operations: [] } };
      },
    });
    await expect(source({ branchId: "main", commitId: head })).resolves.toEqual([]);
    expect(reasoned).toBe(false);
  });

  it("drops a model-authored action that exceeds the actor capability boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-model-actor-scope-"));
    roots.push(root);
    const hero: Entity = { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] };
    const hall: Entity = { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] };
    const engine = new WorldEngine(root, {
      entities: new Map([[hero.id, hero], [hall.id, hall]]),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    const head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.location", value: "hall" }],
    });
    const goal: CharacterGoal = {
      id: "unsafe-goal",
      actorId: "hero",
      description: "Change the hall",
      priority: 1,
      requiresKnowledge: [],
      evidence: [{ span: { sourceId: "test", startLine: 1, endLine: 1, quoteHash: "x" }, strength: "explicit" }],
    };
    const source = modelActorProposalSource(engine, {
      goals: async () => [goal],
      modelFor: async () => null,
      reasoner: () => ({
        title: "Rewrite a location",
        participants: [],
        preconditions: [],
        proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hall", field: "location.open", value: false }] },
      }),
    });
    await expect(source({ branchId: "main", commitId: head })).resolves.toEqual([]);
  });

  it("rejects a guessed stable actor ID instead of treating it as an opaque handle", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-model-actor-stable-id-"));
    roots.push(root);
    const hero: Entity = { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] };
    const engine = new WorldEngine(root, {
      entities: new Map([[hero.id, hero]]),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    const head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const goal: CharacterGoal = {
      id: "plan",
      actorId: "hero",
      description: "Make a plan",
      priority: 1,
      requiresKnowledge: [],
      evidence: [],
    };
    const source = modelActorProposalSource(engine, {
      goals: async () => [goal],
      modelFor: async () => null,
      reasoner: () => ({
        title: "Use a guessed host identifier",
        participants: [],
        preconditions: [],
        proposedDelta: {
          version: 1,
          operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "Wait" }],
        },
      }),
    });
    await expect(source({ branchId: "main", commitId: head })).resolves.toEqual([]);
  });

  it("lets committed branch goals and actor-scoped semantic overlays evolve model policy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-model-actor-branch-semantics-"));
    roots.push(root);
    const hero: Entity = { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] };
    const rival: Entity = { id: "rival", kind: "character", canonicalName: "Rival", aliases: [], evidence: [] };
    const hall: Entity = { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] };
    const engine = new WorldEngine(root, {
      entities: new Map([[hero.id, hero], [rival.id, rival], [hall.id, hall]]),
      rules: new Map(),
      actorGoals: [],
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
        { op: "set", entityId: "rival", field: "character.alive", value: true },
        { op: "set", entityId: "rival", field: "character.location", value: "hall" },
      ],
    });
    const changed = await engine.commitProposal({
      proposalId: "branch-policy-change",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "A commitment changes the situation",
      participants: ["hero", "rival"],
      participantPresence: [
        { entityId: "hero", mode: "physical" },
        { entityId: "rival", mode: "physical" },
      ],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedSemantics: {
        version: 1,
        operations: [
          { op: "open-goal", localRef: "local-goal", goal: { actorId: "hero", description: "Seek the offered aid", priority: 1, targetEntityIds: ["rival"] } },
          { op: "record-appraisal", localRef: "local-appraisal", appraisal: { actorId: "hero", target: { kind: "current-event" }, dimensionId: "hope", value: 0.6 } },
          { op: "adjust-relationship", relationshipRef: "local-relation", createIfMissing: true, fromActorId: "hero", toActorId: "rival", dimensionId: "trust", amount: 0.5 },
          { op: "create-obligation", localRef: "local-obligation", obligation: { debtorActorId: "rival", creditorActorId: "hero", kindId: "provide", description: "A favor is owed" } },
        ],
      },
      causalParents: [],
      evidence: [],
    });
    expect(changed.report.accepted).toBe(true);

    let observed: ActorReasoningInput | undefined;
    const source = modelActorProposalSource(engine, {
      goals: async () => [],
      modelFor: async () => null,
      reasoner: (input) => {
        observed = input;
        return {
          title: "Act on the new goal",
          participants: [],
          preconditions: [],
          proposedDelta: { version: 1, operations: [{ op: "set", entityId: input.actor.actorId, field: "character.plan", value: "Ask for aid" }] },
        };
      },
    });
    const candidates = await source({ branchId: "main", commitId: changed.newHead });
    expect(candidates).toHaveLength(1);
    expect(observed?.goal).toMatchObject({ description: "Seek the offered aid", priority: 1 });
    expect(observed?.model?.branchAppraisals).toEqual([{ targetKind: "event", dimensionId: "hope", value: 0.6 }]);
    expect(observed?.model?.branchRelationships).toEqual([expect.objectContaining({ direction: "outgoing", dimensions: { trust: 0.5 } })]);
    expect(observed?.model?.branchObligations).toEqual([expect.objectContaining({ role: "creditor", kindId: "provide", status: "open" })]);
    expect(JSON.stringify(observed)).not.toContain("branch-");
    expect(JSON.stringify(observed)).not.toContain('"hero"');
    expect(JSON.stringify(observed)).not.toContain('"rival"');

    const branchGoalId = Object.keys((await engine.projections.project(changed.newHead)).semantics.goals)[0]!;
    const closed = await engine.commitProposal({
      proposalId: "close-branch-goal",
      branchId: "main",
      expectedParentCommit: changed.newHead,
      source: "background",
      title: "The goal is abandoned",
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedSemantics: { version: 1, operations: [{ op: "close-goal", goalId: branchGoalId, outcome: "abandoned" }] },
      causalParents: [],
      evidence: [],
    });
    expect(closed.report.accepted).toBe(true);
    observed = undefined;
    await expect(source({ branchId: "main", commitId: closed.newHead })).resolves.toEqual([]);
    expect(observed).toBeUndefined();
  });

  it("includes only actor-visible active norms and owned processes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-model-actor-pressure-"));
    roots.push(root);
    const hero: Entity = { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] };
    const publicDuty: NormTemplate = {
      ontologyVersion: "norm-template-v1",
      id: "public-duty",
      name: "Keep the public promise",
      modality: "obligation",
      actionPattern: { kind: "ad-hoc", actionKindId: "keep-promise" },
      appliesWhen: [],
      exceptions: [],
      reparations: [],
      priority: 10,
      defeasible: false,
      overridesTemplateIds: [],
      status: "supported",
      visibility: "public",
      knownByClaimIds: [],
      induction: { kind: "domain-module", moduleId: "social", moduleVersion: "1" },
      evidence: [],
    };
    const hiddenDuty: NormTemplate = {
      ...publicDuty,
      id: "hidden-duty",
      name: "Engine-only hidden duty",
      visibility: "engine",
    };
    const visibleProcess: ProcessTemplate = {
      ontologyVersion: "process-template-v1",
      id: "visible-journey",
      name: "Visible journey",
      ownerRoles: [{ id: "traveler", label: "Traveler", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }],
      phases: [
        { id: "departed", label: "On the road", terminal: false },
        { id: "arrived", label: "Arrived", terminal: true },
      ],
      initialPhaseId: "departed",
      transitions: [{ fromPhaseId: "departed", toPhaseId: "arrived", minimumProgress: 1 }],
      outcomeIds: ["arrival"],
      visibility: "observable",
      induction: { kind: "domain-module", moduleId: "travel", moduleVersion: "1" },
      evidence: [],
    };
    const hiddenProcess: ProcessTemplate = {
      ...visibleProcess,
      id: "hidden-process",
      name: "Engine-only hidden process",
      visibility: "engine",
    };
    const goal: CharacterGoal = {
      id: "answer-pressure",
      actorId: hero.id,
      description: "Respond to current pressure",
      priority: 1,
      requiresKnowledge: [],
      activation: { preconditions: [], afterCanonicalEventIds: [] },
      evidence: [],
    };
    const engine = new WorldEngine(root, {
      entities: new Map([[hero.id, hero]]),
      rules: new Map(),
      actorGoals: [goal],
      normTemplates: new Map([[publicDuty.id, publicDuty], [hiddenDuty.id, hiddenDuty]]),
      processTemplates: new Map([[visibleProcess.id, visibleProcess], [hiddenProcess.id, hiddenProcess]]),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: hero.id, field: "character.alive", value: true }],
    });
    const activated = await engine.commitProposal({
      proposalId: "activate-pressure",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "Current obligations and journeys become active",
      participants: [hero.id],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedNorms: {
        version: 1,
        operations: [publicDuty, hiddenDuty].map((template) => ({
          op: "instantiate-norm" as const,
          localRef: `local-${template.id}`,
          norm: {
            templateId: template.id,
            subjectActorId: hero.id,
            description: template.name,
            dueAtElapsedDays: 0,
          },
        })),
      },
      proposedProcesses: {
        version: 1,
        operations: [visibleProcess, hiddenProcess].map((template) => ({
          op: "start-process" as const,
          localRef: `local-${template.id}`,
          process: {
            templateId: template.id,
            ownerBindings: [{ roleId: "traveler", entityIds: [hero.id] }],
            progress: 0.25,
            dueAtElapsedDays: 0,
          },
        })),
      },
      causalParents: [],
      evidence: [],
    });
    expect(activated.report.accepted).toBe(true);

    let observed: ActorReasoningInput | undefined;
    const source = modelActorProposalSource(engine, {
      goals: async () => [goal],
      modelFor: async () => null,
      reasoner: (input) => {
        observed = input;
        return {
          title: "Act under pressure",
          participants: [],
          preconditions: [],
          proposedDelta: {
            version: 1,
            operations: [{ op: "set", entityId: input.actor.actorId, field: "character.plan", value: "respond" }],
          },
        };
      },
    });
    const candidates = await source({ branchId: "main", commitId: activated.newHead });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.salience).toMatchObject({ tier: 0, dueNormCount: 2, dueProcessCount: 2 });
    expect(observed?.actor.activeNorms).toEqual([{
      name: publicDuty.name,
      modality: "obligation",
      role: "subject",
      status: "active",
      dueInDays: 0,
    }]);
    expect(observed?.actor.activeProcesses).toEqual([{
      name: visibleProcess.name,
      phase: "On the road",
      status: "running",
      progress: 0.25,
      dueInDays: 0,
    }]);
    expect(JSON.stringify(observed)).not.toContain(hiddenDuty.name);
    expect(JSON.stringify(observed)).not.toContain(hiddenProcess.name);
    expect(JSON.stringify(observed)).not.toContain("public-duty");
    expect(JSON.stringify(observed)).not.toContain("visible-journey");
  });
});

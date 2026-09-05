import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalEventToPossibility } from "../src/world/canon-runtime.js";
import {
  instantiateCanonicalScaffold,
  type CanonicalAttachmentResolverInput,
} from "../src/world/canonical-adaptation.js";
import { WorldEngine, validateEventProposal, type WorldModelContext } from "../src/world/engine.js";
import type { CanonicalEvent, Entity, EventProposal } from "../src/world/model.js";
import type { PossibilityTemplate } from "../src/world/possibility-model.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { KnowledgeProjector } from "../src/world/knowledge.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-canon-adaptation-"));
  roots.push(root);
  const entities: Entity[] = [
    { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
    { id: "mo-yan", kind: "character", canonicalName: "Mo Yan", aliases: [], evidence: [] },
    { id: "courier", kind: "character", canonicalName: "The Courier", aliases: [], evidence: [] },
    { id: "future-courier", kind: "character", canonicalName: "A Future Courier", aliases: [], evidence: [] },
    { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] },
    { id: "remote-road", kind: "location", canonicalName: "Remote Road", aliases: [], evidence: [] },
    { id: "silver-key", kind: "artifact", canonicalName: "Silver Key", aliases: [], evidence: [] },
    { id: "order-letter", kind: "artifact", canonicalName: "Order Letter", aliases: [], evidence: [] },
  ];
  const giveKey: CanonicalEvent = {
    id: "give-key",
    title: "Hero gives the silver key to Mo Yan",
    participants: ["hero", "mo-yan", "silver-key"],
    participantPresence: [
      { entityId: "hero", mode: "physical" },
      { entityId: "mo-yan", mode: "physical" },
    ],
    storyTime: { kind: "ordinal", label: "key transfer", orderHint: 1 },
    preconditions: [{ op: "fact-equals", entityId: "silver-key", field: "artifact.owner", value: "hero" }],
    observedOutcome: { version: 1, operations: [{ op: "set", entityId: "silver-key", field: "artifact.owner", value: "mo-yan" }] },
    evidence: [],
    causalParents: [],
    confidence: 1,
  };
  const deliverOrder: CanonicalEvent = {
    id: "deliver-order",
    title: "Mo Yan takes custody of the order letter",
    readerSummary: "After receiving access, Mo Yan becomes the courier responsible for the order letter.",
    participants: ["mo-yan", "order-letter"],
    participantPresence: [{ entityId: "mo-yan", mode: "physical" }],
    storyTime: { kind: "ordinal", label: "order delivery", orderHint: 2 },
    preconditions: [],
    observedOutcome: { version: 1, operations: [{ op: "set", entityId: "order-letter", field: "artifact.owner", value: "mo-yan" }] },
    observedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "mo-yan", claimId: "order-duty", status: "knows", confidence: 1 }] },
    evidence: [],
    causalParents: [],
    confidence: 1,
  };
  const blockedHandoff: CanonicalEvent = {
    id: "blocked-handoff",
    title: "Mo Yan performs the handoff enabled by the key transfer",
    participants: ["mo-yan", "order-letter"],
    participantPresence: [{ entityId: "mo-yan", mode: "physical" }],
    storyTime: { kind: "ordinal", label: "blocked handoff", orderHint: 1.5 },
    preconditions: [],
    observedOutcome: { version: 1, operations: [{ op: "set", entityId: "order-letter", field: "artifact.delivered", value: true }] },
    evidence: [],
    causalParents: ["give-key"],
    confidence: 1,
  };
  const logOrder: CanonicalEvent = {
    id: "log-order",
    title: "The order transfer is entered into the route ledger",
    participants: ["order-letter"],
    storyTime: { kind: "ordinal", label: "route ledger", orderHint: 3 },
    preconditions: [],
    observedOutcome: { version: 1, operations: [{ op: "set", entityId: "order-letter", field: "artifact.delivered", value: true }] },
    evidence: [],
    causalParents: ["deliver-order"],
    confidence: 1,
  };
  const scaffold: PossibilityTemplate = {
    id: "deliver-order-scaffold",
    kind: "canon-analogue",
    title: "A qualified messenger takes custody of the order letter",
    candidateWindow: structuredClone(deliverOrder.storyTime),
    preconditions: structuredClone(deliverOrder.preconditions),
    blockers: [],
    participants: [...deliverOrder.participants],
    participantPresence: structuredClone(deliverOrder.participantPresence),
    causalParents: [],
    canonicalEventId: deliverOrder.id,
    pressure: 1,
    relevance: 1,
    proposedDelta: structuredClone(deliverOrder.observedOutcome),
    proposedKnowledge: structuredClone(deliverOrder.observedKnowledge),
    canonicalScaffold: {
      version: 1,
      mode: "participant-remap",
      roles: [{
        roleId: "messenger",
        canonicalEntityId: "mo-yan",
        description: "the living, physically present messenger who accepts custody of the order letter",
        allowedEntityKinds: ["character"],
        presence: "active-scene",
        requiredState: [{ op: "fact-equals", entityId: "mo-yan", field: "character.plan", value: "accept courier duty" }],
        requiresKnowledge: [],
      }],
    },
    evidence: [],
  };
  const blockedScaffold: PossibilityTemplate = {
    id: "blocked-handoff-scaffold",
    kind: "canon-analogue",
    title: "A qualified messenger performs the key-enabled handoff",
    candidateWindow: structuredClone(blockedHandoff.storyTime),
    preconditions: structuredClone(blockedHandoff.preconditions),
    blockers: [],
    participants: [...blockedHandoff.participants],
    participantPresence: structuredClone(blockedHandoff.participantPresence),
    causalParents: [...blockedHandoff.causalParents],
    canonicalEventId: blockedHandoff.id,
    pressure: 1,
    relevance: 1,
    proposedDelta: structuredClone(blockedHandoff.observedOutcome),
    canonicalScaffold: {
      version: 1,
      mode: "participant-remap",
      roles: [{
        roleId: "messenger",
        canonicalEntityId: "mo-yan",
        description: "the messenger performing the handoff",
        allowedEntityKinds: ["character"],
        presence: "anywhere",
        requiredState: [],
        requiresKnowledge: [],
      }],
    },
    evidence: [],
  };
  const context: WorldModelContext = {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    claims: new Map([["order-duty", {
      id: "order-duty",
      subject: "order-letter",
      predicate: "requires delivery by",
      object: "the current messenger",
      epistemicType: "explicit-fact" as const,
      evidence: [],
    }]]),
    events: new Map([
      [giveKey.id, giveKey],
      [blockedHandoff.id, blockedHandoff],
      [deliverOrder.id, deliverOrder],
      [logOrder.id, logOrder],
    ]),
    rules: new Map(),
    possibilityTemplates: [blockedScaffold, scaffold],
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  const engine = new WorldEngine(root, context);
  const runtime = new WorldRuntime(engine, ({ branchId, commitId }) => [
    canonicalEventToPossibility(giveKey, branchId, commitId),
    canonicalEventToPossibility(blockedHandoff, branchId, commitId),
    canonicalEventToPossibility(deliverOrder, branchId, commitId),
    canonicalEventToPossibility(logOrder, branchId, commitId),
    { ...structuredClone(blockedScaffold), branchId, evaluatedAtCommit: commitId },
    { ...structuredClone(scaffold), branchId, evaluatedAtCommit: commitId },
  ]);
  const genesis = await engine.createBranch(
    "main",
    "Main",
    {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "mo-yan", field: "character.alive", value: true },
        { op: "set", entityId: "courier", field: "character.alive", value: true },
        { op: "set", entityId: "mo-yan", field: "character.plan", value: "unavailable for courier duty" },
        { op: "set", entityId: "courier", field: "character.plan", value: "accept courier duty" },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
        { op: "set", entityId: "mo-yan", field: "character.location", value: "hall" },
        { op: "set", entityId: "courier", field: "character.location", value: "hall" },
        { op: "set", entityId: "silver-key", field: "artifact.owner", value: "hero" },
        { op: "set", entityId: "order-letter", field: "artifact.owner", value: "hero" },
      ],
    },
    undefined,
    undefined,
    undefined,
    [],
    { storyTime: { kind: "ordinal", label: "opening", orderHint: 0 } },
    {
      entryActorId: "hero",
      participantPresence: [
        { entityId: "hero", mode: "physical" },
        { entityId: "mo-yan", mode: "physical" },
        { entityId: "courier", mode: "physical" },
      ],
    },
  );
  return { engine, runtime, scaffold, blockedScaffold, giveKey, blockedHandoff, deliverOrder, logOrder, genesis, context };
}

describe("canonical scaffold adaptation", () => {
  it("fails closed when a locked opaque state value embeds the replaceable identity", async () => {
    const { scaffold, genesis, context } = await fixture();
    const unsafe = {
      ...structuredClone(scaffold),
      branchId: "main",
      evaluatedAtCommit: genesis,
      proposedDelta: {
        version: 1 as const,
        operations: [{
          op: "set" as const,
          entityId: "mo-yan",
          field: "character.plan",
          value: "wait for Mo Yan before delivering the order",
        }],
      },
    };
    expect(() => instantiateCanonicalScaffold(
      unsafe,
      [{ roleId: "messenger", canonicalEntityId: "mo-yan", boundEntityId: "courier" }],
      context,
    )).toThrow("opaque role references");
  });

  it("continues a diverged chain through a qualified role remap without claiming exact canon", async () => {
    const { engine, runtime, genesis } = await fixture();
    const diverged = await engine.commitProposal({
      proposalId: "player-refuses-key",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "player",
      actorId: "hero",
      title: "Hero refuses the canonical key transfer",
      participants: ["hero", "mo-yan"],
      participantPresence: [
        { entityId: "hero", mode: "physical" },
        { entityId: "mo-yan", mode: "physical" },
      ],
      proposedTime: { kind: "ordinal", label: "key transfer refused", orderHint: 1 },
      preconditions: [],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "keep the key" }] },
      causalParents: [],
      supersedesCanonicalEventIds: ["give-key"],
      evidence: [],
    });
    expect(diverged.report.accepted).toBe(true);

    let resolverInput: CanonicalAttachmentResolverInput | undefined;
    const recovered = await runtime.recoverCanonicalTrajectory({
      branchId: "main",
      actorId: "hero",
      expectedHead: diverged.newHead,
      temporalMode: "advance",
      resolver(input) {
        resolverInput = input;
        const courier = input.bindingOptions.find((option) =>
          option.roles.some((role) => role.boundName === "The Courier"));
        expect(courier).toBeDefined();
        expect(courier?.stateEffects).toEqual(["Order Letter.artifact.owner = The Courier"]);
        expect(courier?.knowledgeEffects).toEqual([
          expect.stringContaining("The Courier learns"),
        ]);
        expect(JSON.stringify(input)).not.toContain("mo-yan");
        return {
          decision: "attach",
          bindingOptionId: courier!.bindingOptionId,
          title: "The Courier accepts the order letter after the key transfer fails",
          roleObservations: [{ roleId: "messenger", summary: "The Courier accepts custody of the order letter and its duty." }],
          roleAffects: [{ roleId: "messenger", label: "resolved", intensity: 0.4, expression: "The Courier secures the letter." }],
        };
      },
    });

    expect(resolverInput?.canonicalEvent.title).toBe("Mo Yan takes custody of the order letter");
    expect(recovered.eventHash).toBeDefined();
    expect(recovered.traces[0]).toMatchObject({
      scaffoldPossibilityId: "blocked-handoff-scaffold",
      status: "hard-invalidated",
    });
    expect(recovered.traces.at(-1)).toMatchObject({
      scaffoldPossibilityId: "deliver-order-scaffold",
      canonicalEventId: "deliver-order",
      status: "attached",
    });
    const state = await engine.projector.project(recovered.newHead);
    expect(state.values["order-letter"]?.["artifact.owner"]).toBe("courier");
    const knowledge = await new KnowledgeProjector(engine).project(recovered.newHead);
    expect(knowledge.actors.courier?.["order-duty"]?.status).toBe("knows");
    const event = await engine.objects.getEvent(recovered.eventHash!);
    expect(event.possibilityId).toBe("deliver-order-scaffold");
    expect(event.realizesCanonicalEventIds).toBeUndefined();
    expect(event.canonicalAdaptation).toMatchObject({
      scaffoldPossibilityId: "deliver-order-scaffold",
      adaptedFromCanonicalEventId: "deliver-order",
      roleBindings: [{ roleId: "messenger", canonicalEntityId: "mo-yan", boundEntityId: "courier" }],
    });
    expect(event.actorObservations).toEqual([{ actorId: "courier", summary: "The Courier accepts custody of the order letter and its duty." }]);
    const frontier = await runtime.refreshFrontier("main", recovered.newHead, { temporalMode: "advance" });
    expect(frontier.evaluated.find((entry) => entry.possibility.id === "canon-deliver-order")?.status).toBe("adapted");
    expect(frontier.evaluated.find((entry) => entry.possibility.id === "deliver-order-scaffold")?.status).toBe("realized");
    expect(frontier.evaluated.find((entry) => entry.possibility.id === "canon-log-order")?.status).toBe("eligible");
  });

  it("rejects a forged adaptation that changes the locked core effect", async () => {
    const { engine, scaffold, genesis, context } = await fixture();
    const instantiated = instantiateCanonicalScaffold({
      ...structuredClone(scaffold),
      branchId: "main",
      evaluatedAtCommit: genesis,
    }, [{ roleId: "messenger", canonicalEntityId: "mo-yan", boundEntityId: "courier" }], context);
    const proposal: EventProposal = {
      proposalId: "forged-canon-adaptation",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "canon-candidate",
      title: "A forged adaptation",
      participants: instantiated.possibility.participants,
      participantPresence: instantiated.possibility.participantPresence,
      proposedTime: instantiated.possibility.candidateWindow!,
      preconditions: instantiated.possibility.preconditions,
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "order-letter", field: "artifact.owner", value: "hero" }] },
      proposedKnowledge: instantiated.possibility.proposedKnowledge,
      causalParents: instantiated.possibility.causalParents,
      evidence: instantiated.possibility.evidence,
      possibilityId: scaffold.id,
      canonicalAdaptation: {
        version: 1,
        scaffoldPossibilityId: scaffold.id,
        adaptedFromCanonicalEventId: "deliver-order",
        sceneActorId: "hero",
        roleBindings: instantiated.bindings,
        coreEffectHash: instantiated.coreEffectHash,
      },
    };
    const state = await engine.projector.project(genesis);
    const validation = validateEventProposal(proposal, genesis, state, context);
    expect(validation.report.accepted).toBe(false);
    expect(validation.report.errors).toContainEqual(expect.objectContaining({ code: "CANONICAL_ADAPTATION_EFFECT_CHANGED" }));
  });

  it("does not relabel an all-canonical binding as an adaptation", async () => {
    const { engine, blockedScaffold, genesis, context } = await fixture();
    const instantiated = instantiateCanonicalScaffold({
      ...structuredClone(blockedScaffold),
      branchId: "main",
      evaluatedAtCommit: genesis,
    }, [{ roleId: "messenger", canonicalEntityId: "mo-yan", boundEntityId: "mo-yan" }], context);
    const state = await engine.projector.project(genesis);
    const validation = validateEventProposal({
      proposalId: "all-canonical-adaptation",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "canon-candidate",
      title: "Mo Yan performs the unchanged event",
      participants: instantiated.possibility.participants,
      participantPresence: instantiated.possibility.participantPresence,
      proposedTime: instantiated.possibility.candidateWindow!,
      preconditions: instantiated.possibility.preconditions,
      proposedDelta: instantiated.possibility.proposedDelta!,
      causalParents: instantiated.possibility.causalParents,
      evidence: instantiated.possibility.evidence,
      possibilityId: blockedScaffold.id,
      canonicalAdaptation: {
        version: 1,
        scaffoldPossibilityId: blockedScaffold.id,
        adaptedFromCanonicalEventId: "blocked-handoff",
        sceneActorId: "hero",
        roleBindings: instantiated.bindings,
        coreEffectHash: instantiated.coreEffectHash,
      },
    }, genesis, state, context);
    expect(validation.report.accepted).toBe(false);
    expect(validation.report.errors).toContainEqual(expect.objectContaining({
      code: "CANONICAL_ADAPTATION_REQUIRES_REMAP",
    }));
  });

  it("rechecks scaffold causal dependencies at the final engine boundary", async () => {
    const { engine, blockedScaffold, genesis, context } = await fixture();
    const instantiated = instantiateCanonicalScaffold({
      ...structuredClone(blockedScaffold),
      branchId: "main",
      evaluatedAtCommit: genesis,
    }, [{ roleId: "messenger", canonicalEntityId: "mo-yan", boundEntityId: "courier" }], context);
    const committed = await engine.commitProposal({
      proposalId: "missing-causal-parent-adaptation",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "canon-candidate",
      title: "A handoff without its required key transfer",
      participants: instantiated.possibility.participants,
      participantPresence: instantiated.possibility.participantPresence,
      proposedTime: instantiated.possibility.candidateWindow!,
      preconditions: instantiated.possibility.preconditions,
      proposedDelta: instantiated.possibility.proposedDelta!,
      causalParents: instantiated.possibility.causalParents,
      evidence: instantiated.possibility.evidence,
      possibilityId: blockedScaffold.id,
      canonicalAdaptation: {
        version: 1,
        scaffoldPossibilityId: blockedScaffold.id,
        adaptedFromCanonicalEventId: "blocked-handoff",
        sceneActorId: "hero",
        roleBindings: instantiated.bindings,
        coreEffectHash: instantiated.coreEffectHash,
      },
    });
    expect(committed.report.accepted).toBe(false);
    expect(committed.report.errors).toContainEqual(expect.objectContaining({
      code: "CANONICAL_ADAPTATION_CAUSAL_PARENT_REQUIRED",
    }));
    expect(committed.newHead).toBe(genesis);
  });

  it("does not bind a future-canon entity that has never entered branch history", async () => {
    const { engine, blockedScaffold, giveKey, genesis, context } = await fixture();
    const exactParent = await engine.commitProposal({
      proposalId: "realize-give-key",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "canon-candidate",
      title: giveKey.title,
      participants: giveKey.participants,
      participantPresence: giveKey.participantPresence,
      proposedTime: giveKey.storyTime,
      preconditions: giveKey.preconditions,
      proposedDelta: giveKey.observedOutcome,
      causalParents: giveKey.causalParents,
      evidence: giveKey.evidence,
      possibilityId: "canon-give-key",
    });
    expect(exactParent.report.accepted).toBe(true);
    const instantiated = instantiateCanonicalScaffold({
      ...structuredClone(blockedScaffold),
      branchId: "main",
      evaluatedAtCommit: exactParent.newHead,
    }, [{ roleId: "messenger", canonicalEntityId: "mo-yan", boundEntityId: "future-courier" }], context);
    const committed = await engine.commitProposal({
      proposalId: "future-entity-adaptation",
      branchId: "main",
      expectedParentCommit: exactParent.newHead,
      source: "canon-candidate",
      title: "An unseen future courier performs the handoff",
      participants: instantiated.possibility.participants,
      participantPresence: instantiated.possibility.participantPresence,
      proposedTime: instantiated.possibility.candidateWindow!,
      preconditions: instantiated.possibility.preconditions,
      proposedDelta: instantiated.possibility.proposedDelta!,
      causalParents: instantiated.possibility.causalParents,
      evidence: instantiated.possibility.evidence,
      possibilityId: blockedScaffold.id,
      canonicalAdaptation: {
        version: 1,
        scaffoldPossibilityId: blockedScaffold.id,
        adaptedFromCanonicalEventId: "blocked-handoff",
        sceneActorId: "hero",
        roleBindings: instantiated.bindings,
        coreEffectHash: instantiated.coreEffectHash,
      },
    });
    expect(committed.report.accepted).toBe(false);
    expect(committed.report.errors).toContainEqual(expect.objectContaining({
      code: "CANONICAL_ADAPTATION_ENTITY_UNAVAILABLE",
    }));
    expect(committed.newHead).toBe(exactParent.newHead);
  });

  it("rechecks active-scene role presence at the final engine boundary", async () => {
    const { engine, scaffold, genesis, context } = await fixture();
    const moved = await engine.commitProposal({
      proposalId: "courier-leaves-scene",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "The Courier leaves the hall",
      participants: ["courier", "remote-road"],
      participantPresence: [{ entityId: "courier", mode: "physical" }],
      proposedTime: { kind: "ordinal", label: "departure", orderHint: 1 },
      preconditions: [],
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "courier", field: "character.location", value: "remote-road" }],
      },
      causalParents: [],
      evidence: [],
    });
    expect(moved.report.accepted).toBe(true);
    const instantiated = instantiateCanonicalScaffold({
      ...structuredClone(scaffold),
      branchId: "main",
      evaluatedAtCommit: moved.newHead,
    }, [{ roleId: "messenger", canonicalEntityId: "mo-yan", boundEntityId: "courier" }], context);
    const committed = await engine.commitProposal({
      proposalId: "remote-courier-adaptation",
      branchId: "main",
      expectedParentCommit: moved.newHead,
      source: "canon-candidate",
      title: "The remote Courier somehow accepts a local handoff",
      participants: instantiated.possibility.participants,
      participantPresence: instantiated.possibility.participantPresence,
      proposedTime: instantiated.possibility.candidateWindow!,
      preconditions: instantiated.possibility.preconditions,
      proposedDelta: instantiated.possibility.proposedDelta!,
      proposedKnowledge: instantiated.possibility.proposedKnowledge,
      causalParents: instantiated.possibility.causalParents,
      evidence: instantiated.possibility.evidence,
      possibilityId: scaffold.id,
      canonicalAdaptation: {
        version: 1,
        scaffoldPossibilityId: scaffold.id,
        adaptedFromCanonicalEventId: "deliver-order",
        sceneActorId: "hero",
        roleBindings: instantiated.bindings,
        coreEffectHash: instantiated.coreEffectHash,
      },
    });
    expect(committed.report.accepted).toBe(false);
    expect(committed.report.errors).toContainEqual(expect.objectContaining({
      code: "CANONICAL_ADAPTATION_ENTITY_NOT_PRESENT",
    }));
    expect(committed.newHead).toBe(moved.newHead);
  });
});

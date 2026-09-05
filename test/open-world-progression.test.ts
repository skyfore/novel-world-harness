import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { PossibilityTemplateStore } from "../src/world/possibility-model.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { buildNarrativeDirection } from "../src/world/narrative-director.js";
import { performPlayTurn } from "../src/world/play-experience.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("open-world progression", () => {
  it("recovers a superseded canonical chain by attaching the next viable scaffold to a valid current participant", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-open-world-canon-recovery-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    for (const entity of [
      { id: "hero", kind: "character" as const, canonicalName: "Hero" },
      { id: "mo-yan", kind: "character" as const, canonicalName: "Mo Yan" },
      { id: "courier", kind: "character" as const, canonicalName: "The Courier" },
      { id: "hall", kind: "location" as const, canonicalName: "Hall" },
      { id: "order-letter", kind: "artifact" as const, canonicalName: "Order Letter" },
    ]) {
      await canon.putEntity({ ...entity, aliases: [], evidence: [] });
    }
    await canon.putEvent({
      id: "give-key",
      title: "Hero plans to give the key to Mo Yan",
      participants: ["hero", "mo-yan"],
      participantPresence: [
        { entityId: "hero", mode: "physical" },
        { entityId: "mo-yan", mode: "physical" },
      ],
      storyTime: { kind: "ordinal", label: "key transfer", orderHint: 0 },
      preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.alive", value: true }],
      observedOutcome: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "give the key to Mo Yan" }],
      },
      evidence: [],
      causalParents: [],
      confidence: 1,
    });
    await canon.putEvent({
      id: "deliver-order",
      title: "Mo Yan takes custody of the order letter",
      participants: ["mo-yan", "order-letter"],
      participantPresence: [{ entityId: "mo-yan", mode: "physical" }],
      storyTime: { kind: "ordinal", label: "order delivery", orderHint: 2 },
      preconditions: [],
      observedOutcome: {
        version: 1,
        operations: [{ op: "set", entityId: "order-letter", field: "artifact.owner", value: "mo-yan" }],
      },
      evidence: [],
      causalParents: [],
      confidence: 1,
    });
    await new PossibilityTemplateStore(root).put({
      id: "deliver-order-scaffold",
      kind: "canon-analogue",
      title: "A qualified messenger takes custody of the order letter",
      candidateWindow: { kind: "ordinal", label: "order delivery", orderHint: 2 },
      preconditions: [],
      blockers: [],
      participants: ["mo-yan", "order-letter"],
      participantPresence: [{ entityId: "mo-yan", mode: "physical" }],
      causalParents: [],
      canonicalEventId: "deliver-order",
      pressure: 1,
      relevance: 1,
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "order-letter", field: "artifact.owner", value: "mo-yan" }],
      },
      canonicalScaffold: {
        version: 1,
        mode: "participant-remap",
        roles: [{
          roleId: "messenger",
          canonicalEntityId: "mo-yan",
          description: "the living messenger physically present to accept custody",
          allowedEntityKinds: ["character"],
          presence: "active-scene",
          requiredState: [{ op: "fact-equals", entityId: "mo-yan", field: "character.plan", value: "accept courier duty" }],
          requiresKnowledge: [],
        }],
      },
      evidence: [],
    });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
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
        { op: "set", entityId: "order-letter", field: "artifact.owner", value: "hero" },
      ],
    }, undefined, undefined, undefined, [], {
      storyTime: { kind: "ordinal", label: "opening", orderHint: 0 },
    }, {
      entryActorId: "hero",
      participantPresence: [
        { entityId: "hero", mode: "physical" },
        { entityId: "mo-yan", mode: "physical" },
        { entityId: "courier", mode: "physical" },
      ],
    });

    const outcome = await performPlayTurn({
      root,
      branchId: "main",
      actorId: "hero",
      utterance: "I refuse the planned transfer and keep the key.",
      advanceActors: 0,
      advanceBackground: 0,
      translator: () => ({
        title: "Hero refuses the key transfer",
        participants: [],
        preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.alive", value: true }],
        proposedDelta: {
          version: 1,
          operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "keep the key" }],
        },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      }),
      canonicalAttachmentResolver: (input) => {
        const courier = input.bindingOptions.find((option) =>
          option.roles.some((role) => role.roleId === "messenger" && role.boundName === "The Courier"));
        expect(courier?.stateEffects).toEqual(["Order Letter.artifact.owner = The Courier"]);
        return {
          decision: "attach",
          bindingOptionId: courier!.bindingOptionId,
          title: "The Courier takes custody after Hero refuses the transfer",
          roleObservations: [{ roleId: "messenger", summary: "The Courier accepts the order letter." }],
          roleAffects: [],
        };
      },
    });

    expect(outcome.result.accepted).toBe(true);
    expect(outcome.result.proposal?.supersedesCanonicalEventIds).toEqual(["give-key"]);
    expect(outcome.canonicalRecoveryEvents).toEqual([
      expect.objectContaining({
        title: "The Courier takes custody after Hero refuses the transfer",
        scaffoldPossibilityId: "deliver-order-scaffold",
        canonicalEventId: "deliver-order",
      }),
    ]);
    expect(outcome.canonicalRecoveryTraces.at(-1)).toMatchObject({ status: "attached" });
    expect(outcome.excludedCanonicalPossibilityIds).toEqual(["canon-deliver-order"]);
    expect(outcome.backgroundEvents).toEqual([]);
    const finalState = await engine.projector.project(outcome.finalHead);
    expect(finalState.values.hero?.["character.plan"]).toBe("keep the key");
    expect(finalState.values["order-letter"]?.["artifact.owner"]).toBe("courier");
    const adapted = await engine.objects.getEvent(outcome.canonicalRecoveryEvents[0]!.eventHash);
    expect(adapted.realizesCanonicalEventIds).toBeUndefined();
    expect(adapted.canonicalAdaptation).toMatchObject({
      adaptedFromCanonicalEventId: "deliver-order",
      roleBindings: [{ canonicalEntityId: "mo-yan", boundEntityId: "courier" }],
    });
  });

  it("turns an explicit wait affordance into elapsed time and one autonomous world consequence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-open-world-"));
    roots.push(root);
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: [],
    });
    await new CanonicalModelStore(root).putEntity({
      id: "settlement",
      kind: "location",
      canonicalName: "Settlement",
      aliases: [],
      evidence: [],
    });
    await new CanonicalModelStore(root).putEvent({
      id: "future-canon",
      title: "Canon tries to seize the next beat",
      participants: ["hero"],
      participantPresence: [{ entityId: "hero", mode: "physical" }],
      storyTime: { kind: "ordinal", label: "opening", orderHint: 0 },
      preconditions: [],
      observedOutcome: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.momentum", value: 99 }],
      },
      evidence: [],
      causalParents: [],
      confidence: 1,
    });
    await new PossibilityTemplateStore(root).put({
      id: "approaching-storm",
      kind: "background-pressure",
      title: "The approaching storm reaches the settlement",
      preconditions: [],
      blockers: [],
      participants: ["settlement"],
      causalParents: [],
      pressure: 0.9,
      relevance: 1,
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "settlement", field: "location.condition", value: 0.4 }],
      },
      evidence: [],
    });
    const { engine, runtime } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    }, undefined, undefined, undefined, [], {
      storyTime: { kind: "ordinal", label: "opening", orderHint: 0 },
      elapsedDays: 0,
    });
    const direction = await buildNarrativeDirection(engine, runtime, "hero", genesis);
    const wait = direction.affordances.find((affordance) => affordance.intent === "wait");
    expect(wait).toBeDefined();

    const outcome = await performPlayTurn({
      root,
      branchId: "main",
      actorId: "hero",
      utterance: wait!.action,
      affordanceId: wait!.id,
      advanceActors: 0,
      advanceBackground: 0,
      translator: () => { throw new Error("a resolved host affordance must bypass model translation"); },
    });

    expect(outcome.result.accepted).toBe(true);
    expect(outcome.result.progressCertificate).toMatchObject({
      timeAdvanced: true,
    });
    expect(outcome.result.progressPreview?.materiallyAdvanced).toBe(true);
    expect(outcome.backgroundEvents).toHaveLength(1);
    expect(outcome.backgroundEvents[0]?.title).toBe("The approaching storm reaches the settlement");
    const state = await engine.projector.project(outcome.finalHead);
    expect(state.logicalTime.elapsedDays).toBeCloseTo(5 / (24 * 60));
    expect(state.values.settlement?.["location.condition"]).toBe(0.4);
    expect(state.values.hero?.["character.momentum"]).not.toBe(99);
  });

  it("keeps a material time-advance exit even when no background process is currently eligible", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-open-world-clock-"));
    roots.push(root);
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: [],
    });
    const { engine, runtime } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const direction = await buildNarrativeDirection(engine, runtime, "hero", genesis);
    const wait = direction.affordances.find((affordance) => affordance.intent === "wait");
    expect(wait).toBeDefined();

    const outcome = await performPlayTurn({
      root,
      branchId: "main",
      actorId: "hero",
      utterance: wait!.action,
      affordanceId: wait!.id,
      advanceActors: 0,
      translator: () => { throw new Error("resolved wait must bypass translation"); },
    });

    expect(outcome.result.progressCertificate).toMatchObject({
      timeAdvanced: true,
    });
    expect(outcome.result.progressPreview?.materiallyAdvanced).toBe(true);
    expect(outcome.backgroundEvents).toEqual([]);
    const state = await engine.projector.project(outcome.finalHead);
    expect(state.logicalTime.elapsedDays).toBeCloseTo(5 / (24 * 60));
  });
});

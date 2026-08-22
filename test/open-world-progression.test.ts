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
      materiallyAdvanced: true,
    });
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
      materiallyAdvanced: true,
    });
    expect(outcome.backgroundEvents).toEqual([]);
    const state = await engine.projector.project(outcome.finalHead);
    expect(state.logicalTime.elapsedDays).toBeCloseTo(5 / (24 * 60));
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { experiencedCanonicalEvents, projectActorScene, type CommittedHistoryEntry } from "../src/world/scene.js";
import { characterModelSchema, resolveCharacterModel } from "../src/world/actors.js";
import type { ParticipantPresenceMode } from "../src/world/model.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("participant presence", () => {
  it.each(["unresolved", "mentioned", "represented", "physical", "remote", "dream", "memory"] as ParticipantPresenceMode[])(
    "keeps %s presence from granting unsupported experience or development", mode => {
      const event = { participants: ["visitor"], participantPresence: [{ entityId: "visitor", mode }], realizesCanonicalEventIds: ["encounter"] };
      const history = [{ event }] as unknown as CommittedHistoryEntry[];
      const expected = ["physical", "remote", "dream", "memory"].includes(mode);
      const evidence = [{ span: { sourceId: "source", startByte: 0, endByte: 10, startLine: 1, endLine: 1, quoteHash: "a".repeat(64) }, strength: "explicit" as const }];
      for (const catalog of [undefined, new Map([["encounter", event]])]) {
        const experienced = experiencedCanonicalEvents(history, "visitor", catalog);
        expect(experienced.has("encounter")).toBe(expected);
        const model = characterModelSchema.parse({ actorId: "visitor", traits: {}, decisionBiases: {}, evidence,
          developmentPhases: [{ id: "after-encounter", label: "Changed by the encounter", evidence,
            activation: { preconditions: [], afterCanonicalEventIds: [], afterExperiencedCanonicalEventIds: ["encounter"], requiresKnowledge: [] },
            traitModifiers: {}, decisionBiasModifiers: {} }] });
        const resolved = resolveCharacterModel(model, { state: { atCommit: "head", logicalTime: { step: 1 }, values: {}, activeRuleIds: [] }, knownClaimIds: new Set(),
          realizedCanonicalEventIds: new Set(["encounter"]), experiencedCanonicalEventIds: experienced });
        expect(resolved.activePhaseIds).toEqual(expected ? ["after-encounter"] : []);
      }
    });

  it("uses opening physical presence for co-location without narrating a generic Genesis record", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-opening-presence-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "reader", kind: "character", canonicalName: "Reader", aliases: [], evidence: [] });
    await canon.putEntity({ id: "companion", kind: "character", canonicalName: "Companion", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "reader", field: "character.alive", value: true },
        { op: "set", entityId: "companion", field: "character.alive", value: true },
      ],
    }, undefined, undefined, undefined, [], {}, {
      entryActorId: "reader",
      participantPresence: [
        { entityId: "reader", mode: "physical" },
        { entityId: "companion", mode: "physical" },
      ],
    });

    const scene = await projectActorScene(engine, "reader", genesis);
    expect(scene.presentEntityIds).toEqual(["companion", "reader"]);
    expect(scene.recentEvents).toEqual([]);
  });

  it("does not teleport a represented letter signer into the reader's physical scene", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-presence-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "reader", kind: "character", canonicalName: "Reader", aliases: [], evidence: [] });
    await canon.putEntity({ id: "signer", kind: "character", canonicalName: "Signer", aliases: [], evidence: [] });
    await canon.putEntity({ id: "letter", kind: "artifact", canonicalName: "Letter", aliases: [], evidence: [] });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "reader", field: "character.alive", value: true },
        { op: "set", entityId: "signer", field: "character.alive", value: true },
      ],
    });
    const committed = await engine.commitProposal({
      proposalId: "read-letter",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "Reader sees the signer's name on a letter",
      participants: ["reader", "signer", "letter"],
      participantPresence: [
        { entityId: "reader", mode: "physical" },
        { entityId: "signer", mode: "represented" },
      ],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "letter", field: "artifact.custodian", value: "reader" }],
      },
      causalParents: [],
      evidence: [],
    });
    expect(committed.report.accepted).toBe(true);

    const scene = await projectActorScene(engine, "reader", committed.newHead);
    expect(scene.presentEntityIds).toEqual(["reader"]);
    expect(scene.recentEvents.at(-1)?.participantIds).toEqual(["reader"]);
  });
});

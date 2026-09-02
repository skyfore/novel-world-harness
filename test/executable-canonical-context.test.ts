import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { WorldContextStore } from "../src/world/context.js";
import type { EvidenceRef } from "../src/world/model.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const evidence: EvidenceRef = {
  span: { sourceId: "novel", startLine: 1, endLine: 1, startByte: 0, endByte: 4, quoteHash: "b".repeat(64) },
  strength: "explicit",
};

describe("executable canonical context", () => {
  it("pins reciprocal scene, frame, and action revisions in CanonicalSnapshot V8", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-executable-canon-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    const contexts = new WorldContextStore(root, canon);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [evidence] });
    await canon.putEntity({ id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [evidence] });
    await canon.putEventFrame({
      ontologyVersion: "event-frame-v1",
      id: "arrive-frame",
      name: "Arrive",
      temporalShape: "instant",
      roles: [
        { id: "arriver", label: "Arriver", semanticRole: "agent", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1, presence: "physical" },
        { id: "place", label: "Place", semanticRole: "destination", allowedEntityKinds: ["location"], minCardinality: 1, maxCardinality: 1 },
      ],
      evidence: [evidence],
    });
    await canon.putActionSchema({
      ontologyVersion: "action-schema-v1",
      id: "arrive-action",
      name: "Arrive at a place",
      roles: [
        { id: "arriver", label: "Arriver", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 },
        { id: "place", label: "Place", allowedEntityKinds: ["location"], minCardinality: 1, maxCardinality: 1 },
      ],
      parameters: [],
      preconditions: [],
      stateEffects: [{
        op: "set",
        entity: { kind: "role", roleId: "arriver" },
        field: "character.location",
        value: { source: "role", roleId: "place" },
        required: true,
      }],
      effectEnvelope: {
        maxStateOperations: 1,
        allowedStateFields: ["character.location"],
        allowsKnowledge: false,
        allowsTimeAdvance: false,
        allowsSceneTransition: false,
      },
      induction: { kind: "domain-module", moduleId: "core-movement", moduleVersion: "1" },
      evidence: [],
    });
    await canon.putEvent({
      id: "hero-arrives",
      title: "Hero arrives",
      participants: ["hero", "hall"],
      participantPresence: [{ entityId: "hero", mode: "physical" }],
      storyTime: { kind: "ordinal", label: "opening", orderHint: 1 },
      preconditions: [],
      observedOutcome: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.location", value: "hall" }] },
      sceneOccurrenceIds: ["opening-scene"],
      frameInstance: {
        frameId: "arrive-frame",
        roleBindings: [
          { roleId: "arriver", entityIds: ["hero"] },
          { roleId: "place", entityIds: ["hall"] },
        ],
        parameters: {},
      },
      action: {
        lane: "schema-bound",
        schemaId: "arrive-action",
        roleBindings: [
          { roleId: "arriver", entityIds: ["hero"] },
          { roleId: "place", entityIds: ["hall"] },
        ],
        parameters: {},
      },
      evidence: [evidence],
      causalParents: [],
      confidence: 1,
    });
    await canon.putSceneOccurrence({
      ontologyVersion: "scene-occurrence-v1",
      id: "opening-scene",
      discourseSegmentIds: ["segment-1"],
      eventIds: ["hero-arrives"],
      locationId: "hall",
      viewpointActorIds: ["hero"],
      presentActorIds: ["hero"],
      entryConditions: [],
      exitConditions: [],
      evidence: [evidence],
    });

    const pinned = await contexts.captureCurrent();
    const restored = await contexts.load(pinned.canonicalSnapshotHash!);
    expect(restored.sceneOccurrences?.map((scene) => scene.id)).toEqual(["opening-scene"]);
    expect(restored.eventFrames?.get("arrive-frame")?.name).toBe("Arrive");
    expect(restored.actionSchemas?.get("arrive-action")?.effectEnvelope.allowedStateFields).toEqual(["character.location"]);
    expect(restored.events?.get("hero-arrives")?.action).toMatchObject({ lane: "schema-bound", schemaId: "arrive-action" });
    await expect(canon.listRevisions("scene-occurrences", "opening-scene")).resolves.toHaveLength(1);
    await expect(canon.listRevisions("event-frames", "arrive-frame")).resolves.toHaveLength(1);
    await expect(canon.listRevisions("action-schemas", "arrive-action")).resolves.toHaveLength(1);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash } from "../src/world/canonical.js";
import { WorldContextStore, type ScopedWorldArtifacts } from "../src/world/context.js";
import { WorldEngine } from "../src/world/engine.js";
import { possibilityToProposal } from "../src/world/frontier.js";
import { canonicalEventToPossibility } from "../src/world/canon-runtime.js";
import type { CanonicalEvent, EventProposal } from "../src/world/model.js";
import { WORLD_ENGINE_VERSION, WORLD_SCHEMA_VERSION } from "../src/world/model.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const evidence = [{ span: { sourceId: "src", startLine: 1, endLine: 1, startByte: 0, endByte: 4, quoteHash: "q" }, strength: "explicit" as const }];
const vision: CanonicalEvent = {
  id: "vision", title: "A vision passes before Hero", participants: ["hero"], participantPresence: [{ entityId: "hero", mode: "physical" }],
  storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [] }, evidence, causalParents: [], confidence: 1,
};

async function world() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-canon-occurrence-")); roots.push(root);
  const artifacts: ScopedWorldArtifacts = {
    entities: [{ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence }], propositions: [], attributions: [], claims: [], events: [vision],
    eventParticipations: [], eventRelations: [], spatialRelations: [], sceneOccurrences: [], eventFrames: [], actionSchemas: [], rules: [], goals: [], models: [], possibilities: [],
  };
  const context = await new WorldContextStore(root).capturePrepared("src", contentHash("occurrence"), artifacts);
  const engine = new WorldEngine(root, context);
  const head = await engine.createBranch("main", "Main", { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] }, undefined, "src", contentHash("occurrence"), evidence);
  return { root, context, engine, head };
}

const occurrence = (head: string, proposalId: string): EventProposal => ({
  proposalId, branchId: "main", expectedParentCommit: head, source: "canon-candidate", possibilityId: "canon-vision", title: vision.title,
  participants: ["hero"], participantPresence: [{ entityId: "hero", mode: "physical" }], proposedTime: { kind: "unknown" }, preconditions: [],
  proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence,
});

describe("canonical occurrence materiality", () => {
  it("commits an effectless canonical event once as an occurrence and replays it", async () => {
    expect([WORLD_SCHEMA_VERSION, WORLD_ENGINE_VERSION]).toEqual([4, "0.37.0"]);
    const { root, context, engine, head } = await world();
    const committed = await engine.commitProposal(occurrence(head, "vision-once"));
    expect(committed.report.errors).toEqual([]);
    const event = (await engine.projections.project(committed.newHead)).history.at(-1)!.event;
    expect(event.realizesCanonicalEventIds).toEqual(["vision"]);
    expect(event.progressCertificate).toMatchObject({ canonicalOccurrence: true, channels: ["occurrence"], stateOperations: [] });
    const cold = await new WorldEngine(root, context).projections.project(committed.newHead, { fresh: true, useCheckpoints: false });
    expect(cold.history.at(-1)!.event.eventId).toBe(event.eventId);

    const again = await engine.commitProposal(occurrence(committed.newHead, "vision-twice"));
    expect(again.report.accepted).toBe(false);
    expect(again.report.errors).toContainEqual(expect.objectContaining({ code: "CANONICAL_EVENT_ALREADY_REALIZED" }));
  });

  it("still rejects an effectless event that is not a canonical occurrence", async () => {
    const { engine, head } = await world();
    const { possibilityId: _possibilityId, ...plain } = occurrence(head, "empty-background");
    const rejected = await engine.commitProposal({ ...plain, source: "background" });
    expect(rejected.report.errors).toContainEqual(expect.objectContaining({ code: "EVENT_MATERIALITY_REQUIRED" }));
    const adapted = await engine.commitProposal({ ...occurrence(head, "unknown-canon"), possibilityId: "canon-missing" });
    expect(adapted.report.accepted).toBe(false);
  });

  it("lets the frontier turn an effectless canonical possibility into a proposal", () => {
    const possibility = canonicalEventToPossibility(vision, "main", "head");
    const proposal = possibilityToProposal({ possibility, status: "eligible", trace: { causalLinks: [] } } as never);
    expect(proposal).toMatchObject({ source: "canon-candidate", possibilityId: "canon-vision" });
  });
});

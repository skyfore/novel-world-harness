import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";
import { canonicalEventToPossibility } from "../src/world/canon-runtime.js";
import { canonPositionFor, cutIdFor, deriveBundleCanonTimeline, expandTimelineAliases } from "../src/world/canon-timeline.js";
import { contentHash } from "../src/world/canonical.js";
import { deriveSceneEntrySeed } from "../src/world/entry-context.js";
import { buildFrontier } from "../src/world/frontier.js";
import type { CanonicalEvent, EventRelation } from "../src/world/model.js";
import { emptyWorldState } from "../src/world/state.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { SCENE_OCCURRENCE_ONTOLOGY_VERSION } from "../src/world/scene-occurrence.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const beat = (index: number, sourceId = "source", evidence = [{ span: { sourceId, startByte: 100 * (index + 1), endByte: 100 * (index + 1) + 4, startLine: index + 2, endLine: index + 2, quoteHash: "a".repeat(64) }, strength: "explicit" as const }]): CanonicalEvent => ({
  id: `beat-${index}`, title: `Beat ${index}`, readerSummary: `Beat ${index} happens.`, participants: ["hero"], participantPresence: [{ entityId: "hero", mode: "physical" }],
  storyTime: { kind: "ordinal", label: `batch label ${index}`, orderHint: 100 - index }, narrativeContext: { layerId: "main", discourseOrder: index, mode: "scene" },
  preconditions: [], observedOutcome: { version: 1, operations: [] }, evidence, causalParents: [], confidence: 1,
});
const enables = (from: string, to: string): EventRelation => ({ id: `${from}-enables-${to}`, fromEventId: from, toEventId: to, type: "enables", operationality: "necessary", status: "inferred", confidence: 1, mechanism: "needed", evidence: [] });

describe("canonical position", () => {
  it("expires passed canon, invalidates its necessary successors and orders the rest by timeline index", () => {
    const events = [0, 1, 2, 3].map((index) => beat(index));
    const relations = [enables("beat-1", "beat-3")];
    const possibilities = events.map((event, index) => canonicalEventToPossibility(event, "main", "head", relations, index));
    const frontier = buildFrontier("main", "head", emptyWorldState("head"), possibilities, { canonPosition: 2, realizedIds: new Set(["canon-beat-0", "beat-0"]) });
    const status = Object.fromEntries(frontier.evaluated.map((entry) => [entry.possibility.id, entry.status]));
    // Story-time hints run backwards (100, 99, ...) yet beat-2 is eligible: order comes from the timeline.
    expect(status).toEqual({ "canon-beat-0": "realized", "canon-beat-1": "expired", "canon-beat-2": "eligible", "canon-beat-3": "invalidated" });
    expect(frontier.evaluated.find((entry) => entry.possibility.id === "canon-beat-1")!.reasons[0]).toMatch(/passed/);
  });

  it("counts coreferent aliases as one occurrence", () => {
    const events = [0, 1, 2].map((index) => beat(index));
    const timeline = deriveBundleCanonTimeline({ source: { id: "source" }, canonical: { events, eventRelations: [{ id: "same", fromEventId: "beat-0", toEventId: "beat-1", type: "coreference", operationality: "non-operational", status: "inferred", confidence: 1, evidence: [] }] } });
    expect(expandTimelineAliases(timeline, ["beat-0"])).toEqual(new Set(["beat-0", "beat-1"]));
    expect(canonPositionFor(timeline, ["beat-0"])).toBe(2);
    expect(canonPositionFor(timeline, [], 1)).toBe(1);
  });

  it("materializes a bounded forward window up to the admission horizon and expires skipped canon", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-canon-window-")); roots.push(root);
    const text = Array.from({ length: 12 }, (_, index) => `Line ${index}`).join("\n") + "\n";
    const fixture = await createEvidenceFixture(root, text);
    const sourceId = fixture.source.id;
    const events = Array.from({ length: 10 }, (_, index) => ({ ...beat(index, sourceId, fixture.evidence(`Line ${index + 1}`)), sceneOccurrenceIds: [`scene-${index}`] }));
    const evidence = fixture.evidence("Line 0");
    const bundle = {
      source: { id: sourceId }, compilerSnapshot: { structure: { units: [], baseUnitIds: [], discourseSegments: [] }, annotations: [], eventResolutions: [] },
      canonical: {
        entities: [{ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence }, { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence }],
        propositions: [], attributions: [], claims: [], events, eventParticipations: [], eventRelations: [], spatialRelations: [], eventFrames: [],
        sceneOccurrences: events.map((event, index) => ({ ontologyVersion: SCENE_OCCURRENCE_ONTOLOGY_VERSION, id: `scene-${index}`, discourseSegmentIds: [`segment-${index}`], eventIds: [event.id],
          locationId: "hall", viewpointActorIds: [], presentActorIds: ["hero"], entryConditions: [], exitConditions: [], evidence: event.evidence })),
        actionSchemas: [], actionConstraints: [], normTemplates: [], processTemplates: [], rules: [], goals: [], models: [], possibilities: [],
        initialWorld: { version: 1, evidence, participantPresence: [{ entityId: "hero", mode: "physical" }],
          delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }, { op: "set", entityId: "hero", field: "character.location", value: "hall" }] },
          projectionSeed: { version: 1, semantics: { version: 1, operations: [] }, processes: { version: 1, operations: [] }, norms: { version: 1, operations: [] }, activeRuleIds: [], elapsedDays: 0 } },
      },
    } as unknown as PreparedNovelBundle;
    bundle.canonical.timeline = deriveBundleCanonTimeline(bundle);
    const revision = contentHash("window");
    const { engine, runtime } = await openWorkspaceWorld(root, undefined, { sourceId, preparedRevisionHash: revision, artifacts: { ...bundle.canonical, canonHorizonIndex: 7 } });
    const seed = deriveSceneEntrySeed(bundle, cutIdFor("beat-3", bundle.canonical.timeline.hash), "hero");
    const head = await engine.createBranch("main", "Main", seed.delta, seed.knowledge, sourceId, revision, seed.evidence, { elapsedDays: 0 },
      { entryActorId: "hero", projectionSeed: seed.projectionSeed, realizesCanonicalEventIds: seed.realizesCanonicalEventIds, participantPresence: seed.participantPresence });
    const canonStatus = async (commit: string) => Object.fromEntries((await runtime.refreshFrontier("main", commit)).evaluated
      .filter((entry) => entry.possibility.canonicalEventId).map((entry) => [entry.possibility.canonicalEventId, entry.status]));
    expect(await canonStatus(head)).toEqual({ "beat-3": "eligible", "beat-4": "eligible", "beat-5": "eligible", "beat-6": "eligible" });

    const jump = await engine.commitProposal({ proposalId: "jump", branchId: "main", expectedParentCommit: head, source: "canon-candidate", possibilityId: "canon-beat-5",
      title: "Beat 5", participants: ["hero"], participantPresence: [{ entityId: "hero", mode: "physical" }], proposedTime: { kind: "unknown" }, preconditions: [],
      proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence: events[5]!.evidence });
    expect(jump.report.errors).toEqual([]);
    expect(await canonStatus(jump.newHead)).toEqual({ "beat-3": "expired", "beat-4": "expired", "beat-6": "eligible" });
  });
});

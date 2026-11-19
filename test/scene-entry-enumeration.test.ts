import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { admittedEntries, buildAdmissionManifest } from "../src/compiler/cut-admission.js";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";
import { deriveBundleCanonTimeline } from "../src/world/canon-timeline.js";
import { contentHash } from "../src/world/canonical.js";
import { WorldContextStore } from "../src/world/context.js";
import { WorldEngine } from "../src/world/engine.js";
import type { CanonicalEvent, Entity } from "../src/world/model.js";
import { requireAdmittedSceneEntry } from "../src/world/play-roles.js";
import { SCENE_OCCURRENCE_ONTOLOGY_VERSION } from "../src/world/scene-occurrence.js";
import { selfActionFixture } from "./helpers/entry-action.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const SCENES = 10;
const span = (byte: number) => ({ span: { sourceId: "source", startByte: byte, endByte: byte + 4, startLine: 1 + byte, endLine: 1 + byte, quoteHash: "a".repeat(64) }, strength: "explicit" as const });
const entities: Entity[] = [
  ...["hero", "courier"].map((id): Entity => ({ id, kind: "character", canonicalName: id, aliases: [], evidence: [span(0)] })),
  { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [span(0)] },
];
const goal = (actorId: string, plan: string) => ({ id: `${actorId}-goal`, actorId, description: plan, priority: 1, requiresKnowledge: [], evidence: [span(0)],
  candidateAction: { title: plan, preconditions: [], proposedDelta: { version: 1 as const, operations: [{ op: "set" as const, entityId: actorId, field: "character.plan", value: plan }] } } });

/** A synthetic novel: an opening followed by ten replayable scenes with two present characters. */
function novel(): PreparedNovelBundle {
  const events: CanonicalEvent[] = Array.from({ length: SCENES }, (_, index) => ({
    id: `beat-${index + 1}`, title: `Beat ${index + 1}`, readerSummary: `Beat ${index + 1} happens in the hall.`, participants: ["hero", "courier"],
    participantPresence: [{ entityId: "hero", mode: "physical" }, { entityId: "courier", mode: "physical" }], storyTime: { kind: "unknown" },
    narrativeContext: { layerId: "main", discourseOrder: index, mode: "scene" }, sceneOccurrenceIds: [`scene-${index + 1}`],
    preconditions: [], observedOutcome: { version: 1, operations: [] }, evidence: [span(100 * (index + 1))], causalParents: [], confidence: 1,
  }));
  const bundle = {
    version: 4, segmenterVersion: 1, batchIds: [], readiness: null, admission: null,
    source: { id: "source", contentMd5: "a".repeat(32), contentSha256: "b".repeat(64) },
    compilerSnapshot: { structure: { units: [], baseUnitIds: [], discourseSegments: events.map((_, index) => ({ id: `segment-${index + 1}` })) }, annotations: [], entityResolutions: [], eventResolutions: [], evidenceBindings: [], accounting: null, roleRoster: null },
    canonical: {
      entities, propositions: [], attributions: [], claims: [], events, eventParticipations: [], eventRelations: [], spatialRelations: [], eventFrames: [],
      sceneOccurrences: events.map((event, index) => ({ ontologyVersion: SCENE_OCCURRENCE_ONTOLOGY_VERSION, id: `scene-${index + 1}`, discourseSegmentIds: [`segment-${index + 1}`], eventIds: [event.id],
        locationId: "hall", viewpointActorIds: [], presentActorIds: ["courier", "hero"], entryConditions: [], exitConditions: [], evidence: event.evidence })),
      actionSchemas: [selfActionFixture()], actionConstraints: [], normTemplates: [], processTemplates: [], rules: [], models: [], possibilities: [],
      goals: [goal("courier", "deliver the letter"), goal("hero", "go home")],
      initialWorld: { version: 1, evidence: [span(0)], participantPresence: [{ entityId: "hero", mode: "physical" }, { entityId: "courier", mode: "physical" }],
        delta: { version: 1, operations: ["hero", "courier"].flatMap((id) => [
          { op: "set" as const, entityId: id, field: "character.alive", value: true }, { op: "set" as const, entityId: id, field: "character.location", value: "hall" },
          { op: "set" as const, entityId: id, field: "character.plan", value: "Carry a letter" }]) },
        projectionSeed: { version: 1, semantics: { version: 1, operations: [] }, processes: { version: 1, operations: [] }, norms: { version: 1, operations: [] }, activeRuleIds: [], elapsedDays: 0 } },
    },
  } as unknown as PreparedNovelBundle;
  bundle.canonical.timeline = deriveBundleCanonTimeline(bundle);
  return bundle;
}

it("enumerates every admitted cut x actor, starts each, plays one turn and replays cold to the same projection", async () => {
  const bundle = novel();
  bundle.admission = await buildAdmissionManifest(bundle);
  expect(bundle.admission.horizonIndex).toBe(SCENES);
  const entries = admittedEntries(bundle);
  expect(new Set(entries.map(({ cut }) => cut.cutId)).size).toBe(SCENES);
  expect(entries).toHaveLength(SCENES * 2);
  expect(entries.filter(({ actor }) => actor.entryBasis === "derived")).toHaveLength((SCENES - 1) * 2);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-scene-enumeration-")); roots.push(root);
  const revision = contentHash("synthetic-novel");
  const context = await new WorldContextStore(root).capturePrepared("source", revision, bundle.canonical);
  const engine = new WorldEngine(root, context);
  for (const [index, { cut, actor }] of entries.entries()) {
    const seed = requireAdmittedSceneEntry(bundle, cut.cutId, actor.actorId, actor.entryCutHash);
    expect(seed.cut.completedEventIds).toHaveLength(cut.index);
    const branchId = `entry-${index}`;
    const head = await engine.createBranch(branchId, branchId, seed.delta, seed.knowledge, "source", revision, seed.evidence,
      { ...(seed.storyTime ? { storyTime: seed.storyTime } : {}), elapsedDays: seed.projectionSeed!.elapsedDays },
      { entryActorId: actor.actorId, entryCutId: cut.cutId, projectionSeed: seed.projectionSeed, realizesCanonicalEventIds: seed.realizesCanonicalEventIds,
        ...(seed.participantPresence ? { participantPresence: seed.participantPresence } : {}), ...(seed.actorObservations ? { actorObservations: seed.actorObservations } : {}) });
    const action = { lane: "schema-bound" as const, schemaId: "fixture-self-action", roleBindings: [{ roleId: "actor", entityIds: [actor.actorId] }], parameters: {} };
    const turn = await engine.commitProposal({ proposalId: `turn-${index}`, branchId, expectedParentCommit: head, source: "player", actorId: actor.actorId,
      title: "Read the letter", participants: [actor.actorId], proposedTime: { kind: "unknown" }, preconditions: [],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: actor.actorId, field: "character.plan", value: "Read the letter" }] },
      action, causalParents: [], evidence: [] });
    expect(turn.report.errors).toEqual([]);
    const cached = await engine.projections.project(turn.newHead);
    const cold = await new WorldEngine(root, context).projections.project(turn.newHead, { fresh: true, useCheckpoints: false });
    expect(contentHash(cold)).toBe(contentHash(cached));
    expect(cold.state.values[actor.actorId]?.["character.plan"]).toBe("Read the letter");
    expect((await engine.branches.read(branchId)).entryCutId).toBe(cut.cutId);
  }
}, 180_000);

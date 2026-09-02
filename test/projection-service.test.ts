import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentHash } from "../src/world/canonical.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import {
  WORLD_ENGINE_VERSION,
  WORLD_SCHEMA_VERSION,
  type CommittedEvent,
  type Entity,
  type EventEffectsRef,
} from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-projection-"));
  roots.push(root);
  const entities: Entity[] = [
    { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
    { id: "witness", kind: "character", canonicalName: "Witness", aliases: [], evidence: [] },
    { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] },
  ];
  const context: WorldModelContext = {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    rules: new Map(),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  const engine = new WorldEngine(root, context);
  const genesis = await engine.createBranch("main", "Main", {
    version: 1,
    operations: [
      { op: "set", entityId: "hero", field: "character.alive", value: true },
      { op: "set", entityId: "witness", field: "character.alive", value: true },
    ],
  });
  const genesisCommit = await engine.objects.getCommit(genesis);
  const genesisEvent = await engine.objects.getEvent(genesisCommit.eventHashes[0]!);
  return { root, engine, genesis, genesisEventId: genesisEvent.eventId };
}

async function appendEvent(
  engine: WorldEngine,
  parentCommitId: string,
  branchId: string,
  eventId: string,
  effects: EventEffectsRef,
  causalParents: string[] = [],
): Promise<string> {
  const parent = await engine.objects.getCommit(parentCommitId);
  const logicalTime = { step: parent.logicalTime.step + 1, elapsedDays: parent.logicalTime.elapsedDays ?? 0 };
  const event: CommittedEvent = {
    version: 2,
    eventId,
    branchId,
    logicalTime,
    title: eventId,
    participants: ["hero", "witness"],
    effects,
    evidence: [],
    causalParents,
    progress: {
      version: 1,
      channels: ["scene"],
      threadIds: [],
      noveltyKey: eventId,
      scene: { kind: "stay", beat: logicalTime.step },
    },
  };
  const eventHash = await engine.objects.putEvent(event);
  return engine.objects.putCommit({
    version: 1,
    parentCommitId,
    branchId,
    logicalTime,
    eventHashes: [eventHash],
    canonicalSnapshotHash: engine.context.canonicalSnapshotHash,
    engineVersion: WORLD_ENGINE_VERSION,
    schemaVersion: WORLD_SCHEMA_VERSION,
  });
}

describe("ProjectionService", () => {
  it("reduces every effect channel from one ordered history and resolves same-event semantic references", async () => {
    const { engine, genesis, genesisEventId } = await fixture();
    const semanticDeltaHash = await engine.objects.putSemanticDelta({
      version: 1,
      operations: [
        {
          op: "record-proposition",
          proposition: {
            id: "prop-vow",
            subjectEntityId: "hero",
            relationId: "promised-return",
            object: { kind: "entity", entityId: "witness" },
            polarity: "positive",
            modality: "asserted",
          },
        },
        {
          op: "record-attribution",
          attribution: {
            id: "attr-vow",
            propositionId: "prop-vow",
            holderKind: "character",
            holderEntityId: "hero",
            attitude: "asserts",
            certainty: 1,
          },
        },
        {
          op: "record-claim",
          claim: { id: "claim-vow", propositionId: "prop-vow", attributionId: "attr-vow", status: "asserted" },
        },
        {
          op: "open-goal",
          goal: { id: "goal-return", actorId: "hero", description: "Return to the witness", priority: 0.8, targetEntityIds: ["witness"] },
        },
        {
          op: "adjust-relationship",
          relationshipId: "hero-to-witness",
          fromActorId: "hero",
          toActorId: "witness",
          dimensionId: "trust",
          amount: 0.25,
        },
        {
          op: "create-obligation",
          obligation: {
            id: "obligation-return",
            debtorActorId: "hero",
            creditorActorId: "witness",
            kindId: "promise",
            description: "Return before nightfall",
          },
        },
      ],
    });
    const knowledgeDeltaHash = await engine.objects.putKnowledgeDelta({
      version: 1,
      operations: [{
        op: "learn",
        actorId: "witness",
        claimId: "claim-vow",
        propositionId: "prop-vow",
        attributionId: "attr-vow",
        acquisitionMode: "observed",
        status: "knows",
        confidence: 1,
      }],
    });
    const processDeltaHash = await engine.objects.putProcessDelta({
      version: 1,
      operations: [{
        op: "start-process",
        process: { id: "storm", ownerEntityIds: ["hall"], phaseId: "forming", progress: 0.1, dueAtElapsedDays: 2 },
      }],
    });
    const normDeltaHash = await engine.objects.putNormDelta({
      version: 1,
      operations: [{
        op: "instantiate-norm",
        norm: {
          id: "keep-vow",
          templateId: "promise-duty",
          subjectActorId: "hero",
          beneficiaryActorId: "witness",
          description: "Hero should keep the vow",
        },
      }],
    });
    const head = await appendEvent(engine, genesis, "main", "vow-made", {
      version: 1,
      semanticDeltaHash,
      knowledgeDeltaHash,
      processDeltaHash,
      normDeltaHash,
    }, [genesisEventId]);

    const bundle = await engine.projections.project(head);
    expect(bundle.atCommit).toBe(head);
    expect(bundle.semantics.propositions["prop-vow"]?.introducedBy.eventId).toBe("vow-made");
    expect(bundle.semantics.goals["goal-return"]?.status).toBe("open");
    expect(bundle.semantics.relationships["hero-to-witness"]?.dimensions.trust).toBe(0.25);
    expect(bundle.knowledge.actors.witness?.["claim-vow"]).toMatchObject({ propositionId: "prop-vow", status: "knows" });
    expect(bundle.processes.instances.storm).toMatchObject({ status: "running", progress: 0.1 });
    expect(bundle.norms.instances["keep-vow"]?.status).toBe("active");
    expect(bundle.scenes.transitions.map((entry) => entry.eventId)).toEqual(["vow-made"]);
    expect(bundle.causality.childrenByParent[genesisEventId]).toEqual(["vow-made"]);
    expect(bundle.history.at(-1)).toMatchObject({ semanticDelta: { version: 1 }, knowledgeDelta: { version: 1 } });
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(contentHash(await engine.projections.project(head, { fresh: true }))).toBe(contentHash(bundle));
  });

  it("keeps post-fork effects isolated by commit ancestry", async () => {
    const { engine, genesis } = await fixture();
    await engine.branches.create({
      id: "alternate",
      name: "Alternate",
      parentBranchId: "main",
      forkCommitId: genesis,
      headCommitId: genesis,
    });
    const semanticDeltaHash = await engine.objects.putSemanticDelta({
      version: 1,
      operations: [{
        op: "open-goal",
        goal: { id: "main-only-goal", actorId: "hero", description: "Remain on main", priority: 1, targetEntityIds: [] },
      }],
    });
    const mainHead = await appendEvent(engine, genesis, "main", "main-only-event", { version: 1, semanticDeltaHash });
    await engine.branches.updateHead("main", genesis, mainHead);

    expect((await engine.projections.project(mainHead)).semantics.goals["main-only-goal"]).toBeDefined();
    expect((await engine.projections.project(await engine.branches.readHead("alternate"))).semantics.goals["main-only-goal"]).toBeUndefined();
  });

  it("fails the entire bundle when any referenced effect object is missing", async () => {
    const { engine, genesis } = await fixture();
    const missing = "f".repeat(64);
    const head = await appendEvent(engine, genesis, "main", "dangling-effect", {
      version: 1,
      processDeltaHash: missing,
    });

    await expect(engine.projections.project(head)).rejects.toThrow(/Cannot project event dangling-effect.*ENOENT/s);
    expect(() => engine.projections.clear(head)).not.toThrow();
  });
});

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
  type ProgressCertificate,
} from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { WorldSnapshotStore } from "../src/world/snapshot.js";
import { deriveProgressCertificate } from "../src/world/progress.js";
import type { NormTemplate } from "../src/world/norm-ontology.js";
import type { ProcessTemplate } from "../src/world/process-ontology.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const promiseDuty: NormTemplate = {
  ontologyVersion: "norm-template-v1",
  id: "promise-duty",
  name: "Keep a promise",
  modality: "obligation",
  actionPattern: { kind: "any" },
  appliesWhen: [],
  exceptions: [],
  reparations: [],
  priority: 0,
  defeasible: false,
  overridesTemplateIds: [],
  status: "supported",
  visibility: "public",
  knownByClaimIds: [],
  induction: { kind: "domain-module", moduleId: "test-norms", moduleVersion: "1" },
  evidence: [],
};

const stormProcess: ProcessTemplate = {
  ontologyVersion: "process-template-v1",
  id: "storm-cycle",
  name: "Storm cycle",
  ownerRoles: [{ id: "region", label: "Region", allowedEntityKinds: ["location"], minCardinality: 1, maxCardinality: 1 }],
  phases: [{ id: "forming", label: "Forming", terminal: false }, { id: "spent", label: "Spent", terminal: true }],
  initialPhaseId: "forming",
  transitions: [{ fromPhaseId: "forming", toPhaseId: "spent", minimumProgress: 1 }],
  outcomeIds: ["passed"],
  visibility: "observable",
  induction: { kind: "domain-module", moduleId: "test-weather", moduleVersion: "1" },
  evidence: [],
};

const crossingProcess: ProcessTemplate = {
  ontologyVersion: "process-template-v1",
  id: "crossing-process",
  name: "Crossing",
  ownerRoles: [{ id: "traveler", label: "Traveler", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }],
  phases: [{ id: "started", label: "Started", terminal: false }, { id: "arrived", label: "Arrived", terminal: true }],
  initialPhaseId: "started",
  transitions: [{ fromPhaseId: "started", toPhaseId: "arrived", minimumProgress: 1 }],
  outcomeIds: ["arrived"],
  visibility: "observable",
  induction: { kind: "domain-module", moduleId: "test-travel", moduleVersion: "1" },
  evidence: [],
};

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
    normTemplates: new Map([[promiseDuty.id, promiseDuty]]),
    processTemplates: new Map([[stormProcess.id, stormProcess], [crossingProcess.id, crossingProcess]]),
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
  suppliedCertificate?: ProgressCertificate,
): Promise<string> {
  const parent = await engine.objects.getCommit(parentCommitId);
  const logicalTime = { step: parent.logicalTime.step + 1, elapsedDays: parent.logicalTime.elapsedDays ?? 0 };
  const loaded = suppliedCertificate ? {} : {
    ...(effects.stateDeltaHash ? { stateDelta: await engine.objects.getDelta(effects.stateDeltaHash) } : {}),
    ...(effects.knowledgeDeltaHash ? { knowledgeDelta: await engine.objects.getKnowledgeDelta(effects.knowledgeDeltaHash) } : {}),
    ...(effects.semanticDeltaHash ? { semanticDelta: await engine.objects.getSemanticDelta(effects.semanticDeltaHash) } : {}),
    ...(effects.processDeltaHash ? { processDelta: await engine.objects.getProcessDelta(effects.processDeltaHash) } : {}),
    ...(effects.normDeltaHash ? { normDelta: await engine.objects.getNormDelta(effects.normDeltaHash) } : {}),
  };
  const scene = { kind: "stay" as const, beat: logicalTime.step };
  const event: CommittedEvent = {
    version: 2,
    eventId,
    branchId,
    logicalTime,
    title: eventId,
    participants: ["hero", "witness"],
    effects,
    progressCertificate: suppliedCertificate
      ?? deriveProgressCertificate({ effects, loaded, utteranceCount: 0, timeAdvanced: false, sceneTransition: scene }),
    evidence: [],
    causalParents,
    progress: {
      version: 1,
      channels: ["scene"],
      threadIds: [],
      noveltyKey: eventId,
      scene,
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
            kindId: "provide",
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
        process: {
          id: "storm",
          templateId: "storm-cycle",
          ownerBindings: [{ roleId: "region", entityIds: ["hall"] }],
          phaseId: "forming",
          progress: 0.1,
          dueAtElapsedDays: 2,
        },
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
    }, [], {
      version: 1,
      stateOperations: [],
      knowledgeOperations: [],
      semanticOperations: [],
      processOperations: [{ effectHash: missing, operationIndex: 0 }],
      normOperations: [],
      utteranceCount: 0,
      timeAdvanced: false,
      sceneTransition: { kind: "stay", beat: 1 },
      channels: ["process", "scene", "time-pressure", "consequence"],
    });

    await expect(engine.projections.project(head)).rejects.toThrow(/Cannot project event dangling-effect.*ENOENT/s);
    expect(() => engine.projections.clear(head)).not.toThrow();
  });

  it("rejects a forged progress pointer even when the referenced effect object exists", async () => {
    const { engine, genesis } = await fixture();
    const deltaHash = await engine.objects.putDelta({
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: false }],
    });
    const head = await appendEvent(engine, genesis, "main", "forged-progress", {
      version: 1,
      stateDeltaHash: deltaHash,
    }, [], {
      version: 1,
      stateOperations: [{ effectHash: deltaHash, operationIndex: 99 }],
      knowledgeOperations: [],
      semanticOperations: [],
      processOperations: [],
      normOperations: [],
      utteranceCount: 0,
      timeAdvanced: false,
      sceneTransition: { kind: "stay", beat: 1 },
      channels: ["state", "scene", "consequence"],
    });

    await expect(engine.projections.project(head, { fresh: true, useCheckpoints: false }))
      .rejects.toThrow("state progress pointer 99 is outside the effect delta");
  });

  it("resumes every reducer from the nearest checkpoint and replays only the shared tail", async () => {
    const { root, engine, genesis } = await fixture();
    const semanticStart = await engine.objects.putSemanticDelta({
      version: 1,
      operations: [{
        op: "open-goal",
        goal: { id: "cross-hall", actorId: "hero", description: "Cross the hall", priority: 0.7, targetEntityIds: ["hall"] },
      }],
    });
    const processStart = await engine.objects.putProcessDelta({
      version: 1,
      operations: [{
        op: "start-process",
        process: {
          id: "crossing",
          templateId: "crossing-process",
          ownerBindings: [{ roleId: "traveler", entityIds: ["hero"] }],
          phaseId: "started",
          progress: 0.2,
        },
      }],
    });
    const checkpointCommit = await appendEvent(engine, genesis, "main", "crossing-started", {
      version: 1,
      semanticDeltaHash: semanticStart,
      processDeltaHash: processStart,
    });
    await new WorldSnapshotStore(root).write(await engine.projections.project(checkpointCommit, {
      fresh: true,
      useCheckpoints: false,
    }));

    const semanticFinish = await engine.objects.putSemanticDelta({
      version: 1,
      operations: [{ op: "close-goal", goalId: "cross-hall", outcome: "achieved" }],
    });
    const processFinish = await engine.objects.putProcessDelta({
      version: 1,
      operations: [{ op: "advance-process", processId: "crossing", amount: 0.8, phaseId: "arrived" }],
    });
    const finalCommit = await appendEvent(engine, checkpointCommit, "main", "crossing-finished", {
      version: 1,
      semanticDeltaHash: semanticFinish,
      processDeltaHash: processFinish,
    });
    engine.projections.clear();

    const resumed = await engine.projections.project(finalCommit, { fresh: true });
    const replayed = await engine.projections.project(finalCommit, { fresh: true, useCheckpoints: false });
    expect(resumed.semantics.goals["cross-hall"]?.status).toBe("achieved");
    expect(resumed.processes.instances.crossing).toMatchObject({ phaseId: "arrived", progress: 1 });
    expect(resumed.history.map(({ event }) => event.eventId)).toEqual(replayed.history.map(({ event }) => event.eventId));
    expect(contentHash(resumed)).toBe(contentHash(replayed));
  });
});

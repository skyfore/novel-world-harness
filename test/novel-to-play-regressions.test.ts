import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { actionConstraintSchema } from "../src/world/action-constraint.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { KnowledgeProjector } from "../src/world/knowledge.js";
import type { Entity, EvidenceRef } from "../src/world/model.js";
import {
  buildActorScopedActionContext,
  playerActionToKnowledgeAwareAction,
  validatePlayerActionSpatialScope,
  type PlayerActionCandidate,
} from "../src/world/player-action.js";
import { spatialRelationSchema } from "../src/world/spatial-ontology.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const evidence: EvidenceRef[] = [{
  span: { sourceId: "novel", startByte: 0, endByte: 10, startLine: 1, endLine: 1, quoteHash: "a".repeat(64) },
  strength: "explicit",
}];

async function fixture(extra: Partial<WorldModelContext> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-closure-"));
  roots.push(root);
  const entities: Entity[] = [
    ...["hero", "rival"].map((id): Entity => ({ id, kind: "character", canonicalName: id, aliases: [], evidence })),
    ...["village", "harbor"].map((id): Entity => ({ id, kind: "location", canonicalName: id, aliases: [], evidence })),
  ];
  const engine = new WorldEngine(root, {
    sourceId: "novel",
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    propositions: new Map(), attributions: new Map(), claims: new Map(), events: new Map(), rules: new Map(),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    ...extra,
  });
  const head = await engine.createBranch("main", "Main", {
    version: 1,
    operations: [
      { op: "set", entityId: "hero", field: "character.alive", value: true },
      { op: "set", entityId: "rival", field: "character.alive", value: true },
      { op: "set", entityId: "hero", field: "character.location", value: "village" },
    ],
  }, undefined, "novel", undefined, evidence, {}, {
    entryActorId: "hero", participantPresence: [{ entityId: "hero", mode: "physical" }],
  });
  return { engine, head };
}

describe("novel-to-play review regressions", () => {
  it("F1: ordinary player conversion obeys the same any-action constraint as an explicit invocation", async () => {
    const constraint = actionConstraintSchema.parse({
      ontologyVersion: "action-constraint-v1", id: "no-action", name: "No action while alive",
      actionPattern: { kind: "any" },
      clauses: [{ id: "block", timing: "before", modality: "forbid", predicate: { op: "fact-equals", entity: { kind: "actor" }, field: "character.alive", value: true } }],
      priority: 1, defeasible: false, status: "supported", visibility: "public",
      induction: { kind: "domain-module", moduleId: "test", moduleVersion: "1" }, evidence: [],
    });
    const { engine, head } = await fixture({ actionConstraints: new Map([[constraint.id, constraint]]) });
    const candidate: PlayerActionCandidate = {
      title: "Plan", participants: [], preconditions: [], requiresKnowledge: [], forbidsKnowledge: [],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "leave" }] },
    };
    const { proposal } = playerActionToKnowledgeAwareAction({ branchId: "main", actorId: "hero", expectedParentCommit: head, utterance: "I plan to leave", candidate });
    const explicit = await engine.commitProposal({ ...proposal, proposalId: "explicit", action: {
      lane: "ad-hoc", actionKindId: "plan", description: "Plan to leave",
      footprint: { reads: [], writes: [{ entityId: "hero", field: "character.plan" }], resources: [] },
    } });
    expect(explicit.report.errors).toContainEqual(expect.objectContaining({ code: "ACTION_CONSTRAINT_FORBIDS" }));
    const ordinary = await engine.commitProposal(proposal);
    expect(ordinary.report.accepted).toBe(false);
    expect(ordinary.report.errors).toContainEqual(expect.objectContaining({ code: "ACTION_CONSTRAINT_FORBIDS" }));
    expect((await engine.branches.read("main")).headCommitId).toBe(head);
  });

  it("F2: same-source actor context retains acquired branch knowledge without sharing it with another actor", async () => {
    const { engine, head } = await fixture();
    const result = await engine.commitProposal({
      proposalId: "promise", branchId: "main", expectedParentCommit: head, source: "background",
      title: "Rival promises help", participants: ["hero", "rival"], proposedTime: { kind: "ordinal", orderHint: 1, label: "later" },
      preconditions: [], proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence: [],
      proposedSemantics: { version: 1, operations: [
        { op: "record-proposition", localRef: "local-p", proposition: { subjectEntityId: "rival", relationId: "promised-help", object: { kind: "entity", entityId: "hero" }, polarity: "positive", modality: "asserted" } },
        { op: "record-attribution", localRef: "local-a", attribution: { propositionId: "local-p", holderKind: "character", holderEntityId: "rival", attitude: "asserts", certainty: 1 } },
        { op: "record-claim", localRef: "local-c", claim: { propositionId: "local-p", attributionId: "local-a", status: "asserted" } },
      ] },
      proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "hero", claimId: "local-c", propositionId: "local-p", attributionId: "local-a", acquisitionMode: "told", sourceActorId: "rival", status: "believes", confidence: 0.9 }] },
    });
    expect(result.report.accepted).toBe(true);
    const next = result.newHead!;
    const projected = await new KnowledgeProjector(engine).view("hero", next);
    expect(projected.knowledge).toHaveLength(1);
    expect(projected.knowledge[0]?.claim?.evidence).toEqual([]);
    expect((await buildActorScopedActionContext(engine, "hero", next, undefined, "novel")).knowledge).toHaveLength(1);
    expect((await buildActorScopedActionContext(engine, "rival", next, undefined, "novel")).knowledge).toHaveLength(0);
    expect((await buildActorScopedActionContext(engine, "hero", head, undefined, "novel")).knowledge).toHaveLength(0);
  });

  it("F3: removing an arrive label cannot authorize a too-fast location delta at the engine boundary", async () => {
    const { engine, head } = await fixture({ spatialOntologyVersion: "spatial-v1", spatialRelations: [spatialRelationSchema.parse({
      ontologyVersion: "spatial-v1", id: "road", kind: "route", fromLocationId: "village", toLocationId: "harbor",
      direction: "two-way", modes: ["foot"], duration: { minimum: 2, typical: 2, maximum: 2, unit: "hour" },
      basis: "explicit", visibility: "public", status: "supported", confidence: 1, evidence,
    })] });
    const candidate: PlayerActionCandidate = {
      title: "Travel", participants: [], preconditions: [], requiresKnowledge: [], forbidsKnowledge: [],
      intent: { kind: "act", summary: "Walk to harbor", targets: [], requestedTimeAdvance: { amount: 1, unit: "hour" },
        sceneTransition: { kind: "arrive", destination: { kind: "entity", entityId: "harbor" }, travelMode: "foot" } },
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.location", value: "harbor" }] },
    };
    expect(await validatePlayerActionSpatialScope(engine, candidate, "hero", head, "novel"))
      .toContainEqual(expect.objectContaining({ code: "PLAYER_SPATIAL_TRAVEL_TOO_FAST" }));
    delete candidate.intent!.sceneTransition;
    const { proposal } = playerActionToKnowledgeAwareAction({ branchId: "main", actorId: "hero", expectedParentCommit: head,
      utterance: "Walk to harbor", candidate, timeAdvance: { amount: 1, unit: "hour" } });
    const result = await engine.commitProposal(proposal);
    expect(result.report.accepted).toBe(false);
    expect(result.report.errors.some((error) => error.code.includes("SPATIAL"))).toBe(true);
    expect((await engine.branches.read("main")).headCommitId).toBe(head);
  });
});

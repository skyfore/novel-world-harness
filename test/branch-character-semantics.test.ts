import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { KnowledgeProjector, actionableKnowledgeClaimIds } from "../src/world/knowledge.js";
import type { BranchSemanticProposalDelta, Entity } from "../src/world/model.js";
import { branchSemanticProposalDeltaSchema } from "../src/world/model.js";
import {
  applyBranchSemanticDelta,
  emptyBranchSemanticState,
  materializeBranchSemanticProposal,
  projectActorBranchSemantics,
} from "../src/world/semantic-effects.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const semanticProposal: BranchSemanticProposalDelta = {
  version: 1,
  operations: [
    {
      op: "record-proposition",
      localRef: "local-promise",
      proposition: {
        subjectEntityId: "rival",
        relationId: "promised-help",
        object: { kind: "entity", entityId: "hero" },
        polarity: "positive",
        modality: "asserted",
      },
    },
    {
      op: "record-attribution",
      localRef: "local-rival-says-promise",
      attribution: {
        propositionId: "local-promise",
        holderKind: "character",
        holderEntityId: "rival",
        attitude: "asserts",
        certainty: 1,
      },
    },
    {
      op: "record-claim",
      localRef: "local-promise-claim",
      claim: {
        propositionId: "local-promise",
        attributionId: "local-rival-says-promise",
        status: "asserted",
      },
    },
    {
      op: "open-goal",
      localRef: "local-seek-help",
      goal: { actorId: "hero", description: "Seek the promised help", priority: 0.9, targetEntityIds: ["rival"] },
    },
    {
      op: "record-appraisal",
      localRef: "local-hopeful-appraisal",
      appraisal: { actorId: "hero", target: { kind: "current-event" }, dimensionId: "hope", value: 0.7 },
    },
    {
      op: "adjust-relationship",
      relationshipRef: "local-hero-rival",
      createIfMissing: true,
      fromActorId: "hero",
      toActorId: "rival",
      dimensionId: "trust",
      amount: 0.4,
    },
    {
      op: "create-obligation",
      localRef: "local-help-debt",
      obligation: {
        debtorActorId: "rival",
        creditorActorId: "hero",
        kindId: "provide",
        description: "Rival owes Hero help",
      },
    },
  ],
};

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-branch-semantics-"));
  roots.push(root);
  const entityList: Entity[] = [
    { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
    { id: "rival", kind: "character", canonicalName: "Rival", aliases: [], evidence: [] },
    { id: "observer", kind: "character", canonicalName: "Observer", aliases: [], evidence: [] },
  ];
  const context: WorldModelContext = {
    entities: new Map(entityList.map((entity) => [entity.id, entity])),
    propositions: new Map(),
    attributions: new Map(),
    claims: new Map(),
    rules: new Map(),
    actorGoals: [],
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  const engine = new WorldEngine(root, context);
  const genesis = await engine.createBranch("main", "Main", {
    version: 1,
    operations: [
      { op: "set", entityId: "hero", field: "character.alive", value: true },
      { op: "set", entityId: "rival", field: "character.alive", value: true },
    ],
  });
  await engine.branches.create({
    id: "alternate",
    name: "Alternate",
    parentBranchId: "main",
    forkCommitId: genesis,
    headCommitId: genesis,
  });
  return { engine, context, genesis };
}

describe("branch character semantics", () => {
  it("requires local creation refs and controlled character semantics", () => {
    expect(() => branchSemanticProposalDeltaSchema.parse({
      version: 1,
      operations: [{
        op: "adjust-relationship",
        relationshipRef: "stable-relationship-id",
        createIfMissing: true,
        fromActorId: "hero",
        toActorId: "rival",
        dimensionId: "trust",
        amount: 0.1,
      }],
    })).toThrow(/turn-local semantic ref/);

    const entities = new Map<string, Entity>([
      ["hero", { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] }],
      ["rival", { id: "rival", kind: "character", canonicalName: "Rival", aliases: [], evidence: [] }],
    ]);
    const provenance = { commitId: "a".repeat(64), eventId: "event-1", eventHash: "b".repeat(64) };
    expect(() => applyBranchSemanticDelta(emptyBranchSemanticState(provenance.commitId), {
      version: 1,
      operations: [{
        op: "record-appraisal",
        appraisal: {
          id: "appraisal-1",
          actorId: "hero",
          target: { kind: "current-event" },
          dimensionId: "generic-positive-feeling",
          value: 0.5,
        },
      }],
    }, { entities }, provenance)).toThrow(/Unknown appraisal emotion/);
    expect(() => applyBranchSemanticDelta(emptyBranchSemanticState(provenance.commitId), {
      version: 1,
      operations: [{
        op: "adjust-relationship",
        relationshipId: "relationship-1",
        fromActorId: "hero",
        toActorId: "rival",
        dimensionId: "friendship-score",
        amount: 0.1,
      }],
    }, { entities }, provenance)).toThrow(/Unknown relationship stance dimension/);
  });

  it("derives stable IDs from branch/head/proposal and resolves same-event knowledge refs", async () => {
    const first = materializeBranchSemanticProposal(semanticProposal, {
      branchId: "main",
      parentCommitId: "a".repeat(64),
      proposalHash: "b".repeat(64),
    });
    const repeated = materializeBranchSemanticProposal(semanticProposal, {
      branchId: "main",
      parentCommitId: "a".repeat(64),
      proposalHash: "b".repeat(64),
    });
    const forked = materializeBranchSemanticProposal(semanticProposal, {
      branchId: "alternate",
      parentCommitId: "a".repeat(64),
      proposalHash: "b".repeat(64),
    });
    expect(first.delta).toEqual(repeated.delta);
    expect(first.localBindings.get("local-promise")?.id).not.toBe(forked.localBindings.get("local-promise")?.id);
    expect(JSON.stringify(first.delta)).not.toContain("local-");

    const { engine, context, genesis } = await fixture();
    const committed = await engine.commitProposal({
      proposalId: "rival-promises-help",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "Rival promises to help Hero",
      participants: ["hero", "rival"],
      proposedTime: { kind: "ordinal", label: "after the confrontation", orderHint: 1 },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedSemantics: semanticProposal,
      proposedKnowledge: {
        version: 1,
        operations: [{
          op: "learn",
          actorId: "hero",
          claimId: "local-promise-claim",
          propositionId: "local-promise",
          attributionId: "local-rival-says-promise",
          acquisitionMode: "told",
          sourceActorId: "rival",
          status: "believes",
          confidence: 0.9,
        }],
      },
      causalParents: [],
      evidence: [],
    });
    expect(committed.report.accepted).toBe(true);
    expect(committed.progressCertificate?.channels).toEqual(expect.arrayContaining(["semantic", "knowledge"]));

    const bundle = await engine.projections.project(committed.newHead);
    const proposition = Object.values(bundle.semantics.propositions)[0]!;
    const claim = Object.values(bundle.semantics.claims)[0]!;
    expect(proposition.id).toMatch(/^branch-proposition-/);
    expect(claim.propositionId).toBe(proposition.id);
    expect(bundle.knowledge.actors.hero?.[claim.id]).toMatchObject({ propositionId: proposition.id, status: "believes" });
    expect(Object.values(bundle.semantics.appraisals)[0]?.target).toEqual({ kind: "event", eventId: expect.any(String) });

    const view = await new KnowledgeProjector(engine).view("hero", committed.newHead);
    expect(view.knowledge[0]).toMatchObject({ branchGrounded: true, claim: { id: claim.id }, proposition: { id: proposition.id } });
    expect(actionableKnowledgeClaimIds(view)).toContain(claim.id);

    const heroSemantics = projectActorBranchSemantics(bundle.semantics, "hero");
    expect(heroSemantics.goals).toHaveLength(1);
    expect(heroSemantics.appraisals).toHaveLength(1);
    expect(heroSemantics.relationships).toHaveLength(1);
    expect(heroSemantics.obligations).toHaveLength(1);
    expect(projectActorBranchSemantics(bundle.semantics, "observer")).toEqual({ goals: [], appraisals: [], relationships: [], obligations: [] });
    expect((await engine.projections.project(await engine.branches.readHead("alternate"))).semantics.goals).toEqual({});
    expect(context.propositions?.size).toBe(0);
    expect(context.attributions?.size).toBe(0);
    expect(context.claims?.size).toBe(0);
  });

  it("rejects forward or mistyped local refs without moving branch truth", async () => {
    const { engine, genesis } = await fixture();
    const invalid = await engine.commitProposal({
      proposalId: "bad-local-ref",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "Invalid semantic proposal",
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedSemantics: {
        version: 1,
        operations: [{
          op: "record-claim",
          localRef: "local-claim",
          claim: { propositionId: "local-not-yet-defined", status: "asserted" },
        }],
      },
      causalParents: [],
      evidence: [],
    });
    expect(invalid.report.errors).toContainEqual(expect.objectContaining({ code: "INVALID_SEMANTIC_DELTA" }));
    expect(await engine.branches.readHead("main")).toBe(genesis);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { buildFrontier, possibilityToProposal } from "../src/world/frontier.js";
import type { Entity, EventProposal, Possibility } from "../src/world/model.js";
import type { NormTemplate } from "../src/world/norm-ontology.js";
import type { ProcessTemplate } from "../src/world/process-ontology.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry, emptyWorldState } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function possibility(
  id: string,
  operationality: "necessary" | "contributory" | "blocking" | "motivational" | "explanatory" | "non-operational",
): Possibility {
  const type = operationality === "blocking"
    ? "prevents" as const
    : operationality === "motivational"
      ? "motivates" as const
      : operationality === "explanatory" || operationality === "non-operational"
        ? "explains" as const
        : "causes" as const;
  return {
    id,
    branchId: "main",
    evaluatedAtCommit: "head",
    kind: "canon-analogue",
    title: id,
    preconditions: [],
    blockers: [],
    participants: ["hero"],
    causalLinks: [{
      relationId: `${id}-relation`,
      sourceEventId: "source",
      type,
      operationality,
      ...(operationality === "motivational" ? { motivatedActorIds: ["hero"] } : {}),
    }],
    causalParents: ["source"],
    canonicalEventId: id,
    pressure: 0.25,
    relevance: 0.5,
    proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.plan", value: id }] },
    evidence: [],
  };
}

function proposal(head: string, overrides: Partial<EventProposal>): EventProposal {
  return {
    proposalId: "proposal",
    branchId: "main",
    expectedParentCommit: head,
    source: "background",
    title: "World event",
    participants: ["hero"],
    proposedTime: { kind: "unknown" },
    preconditions: [],
    proposedDelta: { version: 1, operations: [] },
    causalParents: [],
    evidence: [],
    ...overrides,
  };
}

describe("typed causal frontier and scheduler v2", () => {
  it("uses operationality for gates while contribution, motivation, and explanation remain non-blocking", () => {
    const state = emptyWorldState("head");
    const candidates = [
      possibility("necessary", "necessary"),
      possibility("contributory", "contributory"),
      possibility("blocking", "blocking"),
      possibility("motivational", "motivational"),
      possibility("explanatory", "explanatory"),
    ];
    const before = buildFrontier("main", "head", state, candidates);
    expect(before.evaluated.find((item) => item.possibility.id === "necessary")?.status).toBe("latent");
    expect(before.evaluated.find((item) => item.possibility.id === "contributory")?.status).toBe("eligible");
    expect(before.evaluated.find((item) => item.possibility.id === "motivational")?.factors.pressure).toBe(0.25);
    expect(before.evaluated.find((item) => item.possibility.id === "explanatory")?.trace.causalLinks[0]).toMatchObject({ resolution: "ignored" });

    const after = buildFrontier("main", "head", state, candidates, {
      realizedIds: new Set(["source"]),
      realizationEventIds: new Map([["source", "committed-source"]]),
    });
    expect(after.evaluated.find((item) => item.possibility.id === "necessary")).toMatchObject({
      status: "eligible",
      factors: { tier: 1, causalSupport: 1 },
    });
    expect(after.evaluated.find((item) => item.possibility.id === "contributory")?.status).toBe("eligible");
    expect(after.evaluated.find((item) => item.possibility.id === "blocking")?.status).toBe("invalidated");
    expect(after.evaluated.find((item) => item.possibility.id === "motivational")?.factors.pressure).toBe(0.5);
    expect(after.evaluated.find((item) => item.possibility.id === "explanatory")?.status).toBe("eligible");
    expect(possibilityToProposal(after.evaluated.find((item) => item.possibility.id === "motivational")!))
      .toMatchObject({
        causalRelations: [{
          fromEventId: "committed-source",
          type: "motivates",
          operationality: "motivational",
          actorId: "hero",
        }],
      });

    const superseded = buildFrontier("main", "head", state, [possibility("child", "necessary")], {
      supersededIds: new Set(["source"]),
    });
    expect(superseded.evaluated[0]).toMatchObject({ status: "invalidated" });
  });

  it("orders eligible candidates by deterministic tier and tuple, not a multiplicative score", () => {
    const state = { ...emptyWorldState("head"), logicalTime: { step: 0, elapsedDays: 4 } };
    const base = (id: string, kind: Possibility["kind"], extra: Partial<Possibility> = {}): Possibility => ({
      id,
      branchId: "main",
      evaluatedAtCommit: "head",
      kind,
      title: id,
      preconditions: [],
      blockers: [],
      participants: ["hero"],
      causalLinks: [],
      causalParents: [],
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [] },
      evidence: [],
      ...extra,
    });
    const causal = base("causal", "causal-consequence", {
      causalLinks: [{ relationId: "source-causes", sourceEventId: "source", type: "causes", operationality: "necessary" }],
      causalParents: ["source"],
    });
    const frontier = buildFrontier("main", "head", state, [
      base("canon", "canon-analogue", { canonicalEventId: "canon" }),
      base("environment", "environmental"),
      base("actor", "actor-plan"),
      causal,
      base("due-b", "due-process", { dueAtElapsedDays: 4 }),
      base("due-a", "due-process", { dueAtElapsedDays: 4 }),
    ], { realizedIds: new Set(["source"]) });
    expect(frontier.evaluated.filter((item) => item.status === "eligible").map((item) => item.possibility.id)).toEqual([
      "due-a",
      "due-b",
      "causal",
      "actor",
      "environment",
      "canon",
    ]);
    expect(frontier.evaluated.map((item) => item.trace.tuple.tier)).toEqual([0, 0, 1, 2, 3, 4]);
  });

  it("commits only ancestral typed branch relations and replays them into CausalIndex", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-causal-index-"));
    roots.push(root);
    const hero: Entity = { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] };
    const engine = new WorldEngine(root, {
      entities: new Map([[hero.id, hero]]),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const genesisEventId = (await engine.objects.getEvent((await engine.objects.getCommit(genesis)).eventHashes[0]!)).eventId;
    const committed = await engine.commitProposal(proposal(genesis, {
      proposalId: "answer-genesis",
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "continue" }] },
      causalRelations: [{
        fromEventId: genesisEventId,
        type: "causes",
        operationality: "contributory",
        description: "The opening situation contributes to the plan.",
      }],
      causalParents: [genesisEventId],
    }));
    expect(committed.report.accepted).toBe(true);
    const projection = await engine.projections.project(committed.newHead);
    const relation = Object.values(projection.causality.relations)[0]!;
    expect(relation).toMatchObject({
      fromEventId: genesisEventId,
      type: "causes",
      operationality: "contributory",
    });
    expect(relation.id).toMatch(/^branch-relation-/);
    expect(projection.causality.incomingByEvent[relation.toEventId]).toEqual([relation.id]);
    expect(projection.causality.outgoingByEvent[genesisEventId]).toEqual([relation.id]);

    const rejected = await engine.commitProposal(proposal(committed.newHead, {
      proposalId: "dangling-cause",
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "invalid" }] },
      causalRelations: [{ fromEventId: "not-an-ancestor", type: "causes", operationality: "necessary" }],
      causalParents: ["not-an-ancestor"],
    }));
    expect(rejected.report.errors).toContainEqual(expect.objectContaining({ code: "UNKNOWN_CAUSAL_SOURCE_EVENT" }));
  });

  it("surfaces due norm and executable process transitions as Tier 0 committed events", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-due-scheduler-"));
    roots.push(root);
    const hero: Entity = { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] };
    const duty: NormTemplate = {
      ontologyVersion: "norm-template-v1",
      id: "return-home",
      name: "Return home",
      modality: "obligation",
      actionPattern: { kind: "ad-hoc", actionKindId: "return-home" },
      appliesWhen: [],
      exceptions: [],
      defaultDeadlineDays: 1,
      reparations: [],
      priority: 1,
      defeasible: false,
      overridesTemplateIds: [],
      status: "supported",
      visibility: "public",
      knownByClaimIds: [],
      induction: { kind: "domain-module", moduleId: "duty", moduleVersion: "1" },
      evidence: [],
    };
    const timer: ProcessTemplate = {
      ontologyVersion: "process-template-v1",
      id: "storm-arrival",
      name: "Storm arrival",
      ownerRoles: [{ id: "witness", label: "Witness", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }],
      phases: [{ id: "gathering", label: "Gathering", terminal: false }, { id: "arrived", label: "Arrived", terminal: true }],
      initialPhaseId: "gathering",
      transitions: [{
        fromPhaseId: "gathering",
        toPhaseId: "arrived",
        minimumProgress: 1,
        onDue: { advanceBy: 1, outcomeId: "storm-arrived" },
      }],
      cadence: { kind: "elapsed-days", intervalDays: 1 },
      outcomeIds: ["storm-arrived"],
      visibility: "observable",
      induction: { kind: "domain-module", moduleId: "weather", moduleVersion: "1" },
      evidence: [],
    };
    const context: WorldModelContext = {
      entities: new Map([[hero.id, hero]]),
      rules: new Map(),
      normTemplates: new Map([[duty.id, duty]]),
      processTemplates: new Map([[timer.id, timer]]),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    };
    const engine = new WorldEngine(root, context);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const started = await engine.commitProposal(proposal(genesis, {
      proposalId: "start-deadlines",
      proposedNorms: { version: 1, operations: [{
        op: "instantiate-norm",
        localRef: "local-duty",
        norm: { templateId: duty.id, subjectActorId: hero.id, description: "Hero must return home" },
      }] },
      proposedProcesses: { version: 1, operations: [{
        op: "start-process",
        localRef: "local-storm",
        process: { templateId: timer.id, ownerBindings: [{ roleId: "witness", entityIds: [hero.id] }], progress: 0 },
      }] },
    }));
    const clock = await engine.commitProposal(proposal(started.newHead, {
      proposalId: "one-day-passes",
      timeAdvance: { amount: 1, unit: "day" },
    }));
    const runtime = new WorldRuntime(engine, () => []);
    const frontier = await runtime.refreshFrontier("main", clock.newHead);
    const due = frontier.evaluated.filter((item) => item.possibility.kind === "due-process");
    expect(due).toHaveLength(2);
    expect(due.every((item) => item.status === "eligible" && item.trace.tuple.tier === 0)).toBe(true);

    const settled = await runtime.move({ branchId: "main", maxBackgroundCandidates: 2 });
    expect(settled.committedEvents).toHaveLength(2);
    const projection = await engine.projections.project(settled.newHead);
    expect(Object.values(projection.norms.instances)[0]).toMatchObject({ status: "violated", violationReasonId: "deadline-expired" });
    expect(Object.values(projection.processes.instances)[0]).toMatchObject({ status: "finished", phaseId: "arrived", outcomeId: "storm-arrived" });
  });
});

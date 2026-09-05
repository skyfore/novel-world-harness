import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorProposalCandidate } from "../src/world/actors.js";
import { contentHash } from "../src/world/canonical.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { modelActorProposalSource } from "../src/world/model-actor-policy.js";
import type { Entity, EventProposal, Possibility } from "../src/world/model.js";
import type { NormTemplate } from "../src/world/norm-ontology.js";
import type { ProcessTemplate } from "../src/world/process-ontology.js";
import { actorSafeWorldMoveTrace, WorldRuntime } from "../src/world/runtime.js";
import { WorldSnapshotStore } from "../src/world/snapshot.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function proposal(branchId: string, head: string, proposalId: string, overrides: Partial<EventProposal>): EventProposal {
  return {
    proposalId,
    branchId,
    expectedParentCommit: head,
    source: "background",
    title: proposalId,
    participants: ["aria"],
    proposedTime: { kind: "unknown" },
    preconditions: [],
    proposedDelta: { version: 1, operations: [] },
    causalParents: [],
    evidence: [],
    ...overrides,
  };
}

async function commitAccepted(engine: WorldEngine, value: EventProposal): Promise<string> {
  const committed = await engine.commitProposal(value);
  if (!committed.report.accepted) {
    throw new Error(committed.report.errors.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
  }
  return committed.newHead;
}

describe("long-horizon executable world acceptance", () => {
  it("uses one checkpoint plus a bounded tail and produces identical projection hashes", async () => {
    const root = await temporaryRoot("nwh-long-projection-");
    const hero: Entity = { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] };
    const engine = new WorldEngine(root, {
      entities: new Map([[hero.id, hero]]),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    let head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    let checkpointHead = head;
    const checkpointAfter = 40;
    const totalEvents = 52;
    for (let index = 1; index <= totalEvents; index += 1) {
      head = await commitAccepted(engine, {
        proposalId: `long-step-${index}`,
        branchId: "main",
        expectedParentCommit: head,
        source: "background",
        title: `Long-horizon step ${index}`,
        participants: ["hero"],
        proposedTime: { kind: "ordinal", label: `step ${index}`, orderHint: index },
        preconditions: [],
        proposedDelta: {
          version: 1,
          operations: [{ op: "set", entityId: "hero", field: "character.plan", value: `plan-${index}` }],
        },
        causalParents: [],
        evidence: [],
      });
      if (index === checkpointAfter) {
        checkpointHead = head;
        await new WorldSnapshotStore(root).write(await engine.projections.project(head, {
          fresh: true,
          useCheckpoints: false,
        }));
      }
    }
    engine.projections.clear();

    const resumed = await engine.projections.projectWithDiagnostics(head);
    const replayed = await engine.projections.projectWithDiagnostics(head, { useCheckpoints: false });

    expect(resumed.diagnostics).toEqual({
      version: 1,
      requestedCommitId: head,
      ancestryCommitCount: totalEvents + 1,
      checkpointCommitId: checkpointHead,
      checkpointHistoryEventCount: checkpointAfter + 1,
      replayedCommitCount: totalEvents - checkpointAfter,
      replayedEventCount: totalEvents - checkpointAfter,
    });
    expect(replayed.diagnostics).toMatchObject({
      ancestryCommitCount: totalEvents + 1,
      checkpointHistoryEventCount: 0,
      replayedCommitCount: totalEvents + 1,
      replayedEventCount: totalEvents + 1,
    });
    expect(contentHash(resumed.projection)).toBe(contentHash(replayed.projection));
    for (const channel of ["state", "knowledge", "semantics", "processes", "norms", "scenes", "causality", "history"] as const) {
      expect(contentHash(resumed.projection[channel]), channel).toBe(contentHash(replayed.projection[channel]));
    }
    expect(resumed.projection.state.values.hero?.["character.plan"]).toBe(`plan-${totalEvents}`);
  }, 20_000);

  it("isolates every typed channel after a fork and lets belief, relationship, goal, and future diverge", async () => {
    const root = await temporaryRoot("nwh-long-fork-");
    const entities: Entity[] = [
      { id: "aria", kind: "character", canonicalName: "Aria", aliases: [], evidence: [] },
      { id: "borin", kind: "character", canonicalName: "Borin", aliases: [], evidence: [] },
      { id: "cato", kind: "character", canonicalName: "Cato", aliases: [], evidence: [] },
      { id: "vault", kind: "location", canonicalName: "Vault", aliases: [], evidence: [] },
      { id: "relic", kind: "artifact", canonicalName: "Relic", aliases: [], evidence: [] },
    ];
    const allianceDuty: NormTemplate = {
      ontologyVersion: "norm-template-v1",
      id: "alliance-duty",
      name: "Keep the alliance",
      modality: "obligation",
      actionPattern: { kind: "any" },
      appliesWhen: [],
      exceptions: [],
      reparations: [],
      priority: 1,
      defeasible: false,
      overridesTemplateIds: [],
      status: "supported",
      visibility: "public",
      knownByClaimIds: [],
      induction: { kind: "domain-module", moduleId: "acceptance-social", moduleVersion: "1" },
      evidence: [],
    };
    const warningProcess: ProcessTemplate = {
      ontologyVersion: "process-template-v1",
      id: "warning-process",
      name: "Warn the settlement",
      ownerRoles: [{ id: "place", label: "Place", allowedEntityKinds: ["location"], minCardinality: 1, maxCardinality: 1 }],
      phases: [{ id: "pending", label: "Pending", terminal: false }, { id: "warned", label: "Warned", terminal: true }],
      initialPhaseId: "pending",
      transitions: [{ fromPhaseId: "pending", toPhaseId: "warned", minimumProgress: 1 }],
      outcomeIds: ["warned"],
      visibility: "observable",
      induction: { kind: "domain-module", moduleId: "acceptance-process", moduleVersion: "1" },
      evidence: [],
    };
    const context: WorldModelContext = {
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      propositions: new Map(),
      attributions: new Map(),
      claims: new Map(),
      rules: new Map(),
      actorGoals: [],
      normTemplates: new Map([[allianceDuty.id, allianceDuty]]),
      processTemplates: new Map([[warningProcess.id, warningProcess]]),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    };
    const engine = new WorldEngine(root, context);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        ...["aria", "borin", "cato"].flatMap((entityId) => [
          { op: "set" as const, entityId, field: "character.alive", value: true },
          { op: "set" as const, entityId, field: "character.location", value: "vault" },
        ]),
        { op: "set", entityId: "vault", field: "location.open", value: true },
        { op: "set", entityId: "relic", field: "artifact.owner", value: "aria" },
      ],
    });
    const sharedHead = await commitAccepted(engine, proposal("main", genesis, "establish-shared-beliefs", {
      participants: ["aria", "borin", "cato"],
      proposedSemantics: {
        version: 1,
        operations: [
          {
            op: "record-proposition",
            localRef: "local-vault-open",
            proposition: { subjectEntityId: "vault", relationId: "is-open", object: { kind: "literal", value: true }, polarity: "positive", modality: "asserted" },
          },
          {
            op: "record-attribution",
            localRef: "local-borin-observed-open",
            attribution: { propositionId: "local-vault-open", holderKind: "character", holderEntityId: "borin", attitude: "knows", certainty: 1 },
          },
          {
            op: "record-claim",
            localRef: "local-open-claim",
            claim: { propositionId: "local-vault-open", attributionId: "local-borin-observed-open", status: "asserted" },
          },
          {
            op: "record-proposition",
            localRef: "local-vault-closed",
            proposition: { subjectEntityId: "vault", relationId: "is-open", object: { kind: "literal", value: false }, polarity: "positive", modality: "asserted" },
          },
          {
            op: "record-attribution",
            localRef: "local-cato-lied-closed",
            attribution: { propositionId: "local-vault-closed", holderKind: "character", holderEntityId: "cato", attitude: "asserts", certainty: 1 },
          },
          {
            op: "record-claim",
            localRef: "local-closed-claim",
            claim: { propositionId: "local-vault-closed", attributionId: "local-cato-lied-closed", status: "asserted" },
          },
        ],
      },
      proposedKnowledge: {
        version: 1,
        operations: [
          { op: "learn", actorId: "borin", claimId: "local-open-claim", propositionId: "local-vault-open", attributionId: "local-borin-observed-open", acquisitionMode: "observed", status: "knows", confidence: 1 },
          { op: "learn", actorId: "aria", claimId: "local-closed-claim", propositionId: "local-vault-closed", attributionId: "local-cato-lied-closed", acquisitionMode: "deceived-misattributed", sourceActorId: "cato", status: "believes", confidence: 0.9 },
        ],
      },
      proposedNorms: {
        version: 1,
        operations: [{
          op: "instantiate-norm",
          localRef: "local-alliance-duty",
          norm: { templateId: "alliance-duty", subjectActorId: "aria", beneficiaryActorId: "borin", description: "Aria must keep the alliance" },
        }],
      },
      proposedProcesses: {
        version: 1,
        operations: [{
          op: "start-process",
          localRef: "local-warning",
          process: { templateId: "warning-process", ownerBindings: [{ roleId: "place", entityIds: ["vault"] }], progress: 0 },
        }],
      },
    }));
    const shared = await engine.projections.project(sharedHead);
    const normId = Object.keys(shared.norms.instances)[0]!;
    const processId = Object.keys(shared.processes.instances)[0]!;
    expect(shared.state.values.vault?.["location.open"]).toBe(true);
    const ariaFalseClaim = Object.values(shared.semantics.claims)
      .find((claim) => shared.semantics.propositions[claim.propositionId]?.object.kind === "literal"
        && shared.semantics.propositions[claim.propositionId]?.object.value === false)!;
    const borinTrueClaim = Object.values(shared.semantics.claims)
      .find((claim) => shared.semantics.propositions[claim.propositionId]?.object.kind === "literal"
        && shared.semantics.propositions[claim.propositionId]?.object.value === true)!;
    expect(shared.knowledge.actors.aria?.[ariaFalseClaim.id]).toMatchObject({ status: "believes" });
    expect(shared.knowledge.actors.borin?.[borinTrueClaim.id]).toMatchObject({ status: "knows" });
    expect(shared.knowledge.actors.cato).toBeUndefined();

    const runtime = new WorldRuntime(engine, ({ branchId, commitId }): Possibility[] => [
      {
        id: "future-cato-controls-relic",
        branchId,
        evaluatedAtCommit: commitId,
        kind: "background-pressure",
        title: "Cato controls the relic",
        preconditions: [{ op: "fact-equals", entityId: "relic", field: "artifact.owner", value: "cato" }],
        blockers: [],
        participants: ["aria", "cato", "relic"],
        causalLinks: [],
        causalParents: [],
        pressure: 0.6,
        relevance: 0.8,
        proposedDelta: { version: 1, operations: [{ op: "set", entityId: "aria", field: "character.plan", value: "recover-relic" }] },
        evidence: [],
      },
      {
        id: "future-borin-controls-relic",
        branchId,
        evaluatedAtCommit: commitId,
        kind: "background-pressure",
        title: "Borin controls the relic",
        preconditions: [{ op: "fact-equals", entityId: "relic", field: "artifact.owner", value: "borin" }],
        blockers: [],
        participants: ["aria", "borin", "relic"],
        causalLinks: [],
        causalParents: [],
        pressure: 0.6,
        relevance: 0.8,
        proposedDelta: { version: 1, operations: [{ op: "set", entityId: "aria", field: "character.plan", value: "negotiate-return" }] },
        evidence: [],
      },
    ]);
    await runtime.forkBranch("main", sharedHead, "alternate", "Alternate");

    const mainHead = await commitAccepted(engine, proposal("main", sharedHead, "betray-alliance", {
      participants: ["aria", "borin", "cato", "relic"],
      proposedDelta: { version: 1, operations: [
        { op: "set", entityId: "relic", field: "artifact.owner", value: "cato" },
        { op: "set", entityId: "vault", field: "location.open", value: false },
      ] },
      proposedSemantics: { version: 1, operations: [
        { op: "record-proposition", localRef: "local-main-secret", proposition: { subjectEntityId: "relic", relationId: "hidden-by", object: { kind: "entity", entityId: "cato" }, polarity: "positive", modality: "asserted" } },
        { op: "record-attribution", localRef: "local-main-observation", attribution: { propositionId: "local-main-secret", holderKind: "character", holderEntityId: "aria", attitude: "knows", certainty: 1 } },
        { op: "record-claim", localRef: "local-main-secret-claim", claim: { propositionId: "local-main-secret", attributionId: "local-main-observation", status: "asserted" } },
        { op: "open-goal", localRef: "local-main-goal", goal: { actorId: "aria", description: "Conceal the betrayal", priority: 0.9, targetEntityIds: ["cato"] } },
        { op: "adjust-relationship", relationshipRef: "local-main-relationship", createIfMissing: true, fromActorId: "aria", toActorId: "borin", dimensionId: "trust", amount: -0.8 },
        { op: "create-obligation", localRef: "local-main-obligation", obligation: { debtorActorId: "aria", creditorActorId: "borin", kindId: "repay", description: "Repair the broken alliance" } },
      ] },
      proposedKnowledge: { version: 1, operations: [
        { op: "learn", actorId: "aria", claimId: "local-main-secret-claim", propositionId: "local-main-secret", attributionId: "local-main-observation", acquisitionMode: "observed", status: "knows", confidence: 1 },
      ] },
      proposedProcesses: { version: 1, operations: [{ op: "advance-process", processRef: processId, amount: 0.5 }] },
      proposedNorms: { version: 1, operations: [{ op: "violate-norm", normRef: normId, byActorId: "aria", reasonId: "betrayal" }] },
    }));
    const alternateHead = await commitAccepted(engine, proposal("alternate", sharedHead, "keep-alliance", {
      participants: ["aria", "borin", "relic"],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "relic", field: "artifact.owner", value: "borin" }] },
      proposedSemantics: { version: 1, operations: [
        { op: "record-proposition", localRef: "local-alt-transfer", proposition: { subjectEntityId: "relic", relationId: "entrusted-to", object: { kind: "entity", entityId: "borin" }, polarity: "positive", modality: "asserted" } },
        { op: "record-attribution", localRef: "local-alt-observation", attribution: { propositionId: "local-alt-transfer", holderKind: "character", holderEntityId: "borin", attitude: "knows", certainty: 1 } },
        { op: "record-claim", localRef: "local-alt-transfer-claim", claim: { propositionId: "local-alt-transfer", attributionId: "local-alt-observation", status: "asserted" } },
        { op: "open-goal", localRef: "local-alt-goal", goal: { actorId: "aria", description: "Strengthen the alliance", priority: 0.9, targetEntityIds: ["borin"] } },
        { op: "adjust-relationship", relationshipRef: "local-alt-relationship", createIfMissing: true, fromActorId: "aria", toActorId: "borin", dimensionId: "trust", amount: 0.6 },
        { op: "create-obligation", localRef: "local-alt-obligation", obligation: { debtorActorId: "borin", creditorActorId: "aria", kindId: "provide", description: "Return the relic after warning the settlement" } },
      ] },
      proposedKnowledge: { version: 1, operations: [
        { op: "learn", actorId: "borin", claimId: "local-alt-transfer-claim", propositionId: "local-alt-transfer", attributionId: "local-alt-observation", acquisitionMode: "observed", status: "knows", confidence: 1 },
      ] },
      proposedProcesses: { version: 1, operations: [{ op: "pause-process", processRef: processId, reasonId: "coordinate-alliance" }] },
      proposedNorms: { version: 1, operations: [{ op: "satisfy-norm", normRef: normId, byActorId: "aria" }] },
    }));

    const [main, alternate, sharedAgain, mainFrontier, alternateFrontier] = await Promise.all([
      engine.projections.project(mainHead),
      engine.projections.project(alternateHead),
      engine.projections.project(sharedHead, { fresh: true }),
      runtime.refreshFrontier("main", mainHead),
      runtime.refreshFrontier("alternate", alternateHead),
    ]);
    for (const channel of ["state", "knowledge", "semantics", "processes", "norms"] as const) {
      expect(contentHash(main[channel]), channel).not.toBe(contentHash(alternate[channel]));
    }
    expect(contentHash(sharedAgain)).toBe(contentHash(shared));
    expect(sharedAgain.norms.instances[normId]?.status).toBe("active");
    expect(sharedAgain.processes.instances[processId]?.status).toBe("running");
    expect(main.norms.instances[normId]?.status).toBe("violated");
    expect(alternate.norms.instances[normId]?.status).toBe("satisfied");
    expect(main.processes.instances[processId]).toMatchObject({ status: "running", progress: 0.5 });
    expect(alternate.processes.instances[processId]?.status).toBe("paused");
    expect(Object.values(main.semantics.relationships)[0]?.dimensions.trust).toBe(-0.8);
    expect(Object.values(alternate.semantics.relationships)[0]?.dimensions.trust).toBe(0.6);
    expect(Object.values(main.semantics.goals)[0]?.description).toBe("Conceal the betrayal");
    expect(Object.values(alternate.semantics.goals)[0]?.description).toBe("Strengthen the alliance");
    const mainSecret = Object.values(main.semantics.claims).find((claim) =>
      main.semantics.propositions[claim.propositionId]?.relationId === "hidden-by")!;
    expect(main.knowledge.actors.aria?.[mainSecret.id]).toMatchObject({ status: "knows" });
    expect(main.knowledge.actors.borin?.[mainSecret.id]).toBeUndefined();
    expect(main.knowledge.actors.cato?.[mainSecret.id]).toBeUndefined();
    expect(mainFrontier.evaluated.find((entry) => entry.possibility.id === "future-cato-controls-relic")?.status).toBe("eligible");
    expect(mainFrontier.evaluated.find((entry) => entry.possibility.id === "future-borin-controls-relic")?.status).toBe("latent");
    expect(alternateFrontier.evaluated.find((entry) => entry.possibility.id === "future-cato-controls-relic")?.status).toBe("latent");
    expect(alternateFrontier.evaluated.find((entry) => entry.possibility.id === "future-borin-controls-relic")?.status).toBe("eligible");

    const observedChoices: Array<{ goal: string; trust?: number }> = [];
    const actorSource = modelActorProposalSource(engine, {
      goals: async () => [],
      modelFor: async () => null,
      maxActorsPerRefresh: 1,
      maxModelCallsPerRefresh: 1,
      reasoner: (input) => {
        const trust = input.model?.branchRelationships?.[0]?.dimensions.trust;
        observedChoices.push({ goal: input.goal.description, ...(trust !== undefined ? { trust } : {}) });
        return {
          title: (trust ?? 0) < 0 ? "Withhold cooperation" : "Offer cooperation",
          participants: [],
          preconditions: [],
          proposedDelta: { version: 1, operations: [{ op: "set", entityId: input.actor.actorId, field: "character.plan", value: (trust ?? 0) < 0 ? "withhold" : "cooperate" }] },
        };
      },
    });
    const mainChoice = await actorSource({ branchId: "main", commitId: mainHead, maxActors: 1, maxModelCalls: 1 });
    const alternateChoice = await actorSource({ branchId: "alternate", commitId: alternateHead, maxActors: 1, maxModelCalls: 1 });
    expect(mainChoice[0]?.proposal.title).toBe("Validated actor action by Aria");
    expect(alternateChoice[0]?.proposal.title).toBe("Validated actor action by Aria");
    expect(mainChoice[0]?.proposal.proposedDelta.operations).toContainEqual(
      expect.objectContaining({ op: "set", field: "character.plan", value: "withhold" }),
    );
    expect(alternateChoice[0]?.proposal.proposedDelta.operations).toContainEqual(
      expect.objectContaining({ op: "set", field: "character.plan", value: "cooperate" }),
    );
    expect(observedChoices).toEqual([
      { goal: "Conceal the betrayal", trust: -0.8 },
      { goal: "Strengthen the alliance", trust: 0.6 },
    ]);
  });

  it("records bounded actor conflicts, scheduler gates, footprints, effects, and commit boundaries without leaking them to actor-safe traces", async () => {
    const root = await temporaryRoot("nwh-move-trace-");
    const entities: Entity[] = [
      { id: "a", kind: "character", canonicalName: "A", aliases: [], evidence: [] },
      { id: "b", kind: "character", canonicalName: "B", aliases: [], evidence: [] },
      { id: "cell", kind: "artifact", canonicalName: "Cell", aliases: [], evidence: [] },
      { id: "room", kind: "location", canonicalName: "Room", aliases: [], evidence: [] },
    ];
    const engine = new WorldEngine(root, {
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    const head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "a", field: "character.alive", value: true },
        { op: "set", entityId: "b", field: "character.alive", value: true },
        { op: "set", entityId: "cell", field: "artifact.quantity", value: 1 },
        { op: "set", entityId: "room", field: "location.open", value: true },
      ],
    });
    const actorCandidate = (actorId: "a" | "b", priority: number): ActorProposalCandidate => ({
      goalId: `goal-${actorId}`,
      priority,
      candidateSource: "injected",
      proposal: {
        proposalId: `claim-cell-${actorId}`,
        branchId: "main",
        expectedParentCommit: head,
        source: "actor",
        actorId,
        title: `${actorId} claims the cell`,
        participants: [actorId, "cell"],
        proposedTime: { kind: "unknown" },
        preconditions: [{ op: "fact-gte", entityId: "cell", field: "artifact.quantity", value: 1 }],
        proposedDelta: { version: 1, operations: [{ op: "set", entityId: actorId, field: "character.plan", value: "claim-cell" }] },
        action: {
          lane: "ad-hoc",
          actionKindId: "claim-cell",
          description: "Reserve the only cell",
          footprint: {
            reads: [{ entityId: "cell", field: "artifact.quantity" }],
            writes: [{ entityId: actorId, field: "character.plan" }],
            resources: [{ entityId: "cell", field: "artifact.quantity", mode: "reserve" }],
          },
        },
        causalParents: [],
        evidence: [],
      },
    });
    const background: Possibility = {
      id: "close-room-after-allocation",
      branchId: "main",
      evaluatedAtCommit: head,
      kind: "background-pressure",
      title: "The allocation room closes",
      preconditions: [{ op: "fact-equals", entityId: "room", field: "location.open", value: true }],
      blockers: [],
      participants: ["room"],
      causalLinks: [],
      causalParents: [],
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "room", field: "location.open", value: false }] },
      evidence: [],
    };
    const runtime = new WorldRuntime(engine, () => [background], undefined, () => [
      actorCandidate("a", 1),
      actorCandidate("b", 0.9),
    ]);

    const moved = await runtime.move({ branchId: "main", maxActorCandidates: 2, maxBackgroundCandidates: 1 });

    expect(moved.committedEvents).toHaveLength(2);
    expect(moved.rejectedProposals).toContain("claim-cell-b");
    expect(moved.trace).toMatchObject({
      version: 1,
      branchId: "main",
      previousHead: head,
      finalHead: moved.newHead,
      actorBudget: 2,
      backgroundBudget: 1,
    });
    const conflict = moved.trace.candidates.find((candidate) => candidate.status === "conflict")!;
    expect(conflict).toMatchObject({
      proposalId: "claim-cell-b",
      candidateSource: "injected",
      gates: [{ gate: "conflict", outcome: "fail" }],
      footprint: { resources: [{ entityId: "cell", field: "artifact.quantity", mode: "reserve" }] },
      commitBoundary: { beforeHead: head, afterHead: head, moved: false },
    });
    const actorAccepted = moved.trace.candidates.find((candidate) => candidate.proposalId === "claim-cell-a")!;
    expect(actorAccepted.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ gate: "validation", outcome: "pass" }),
      expect.objectContaining({ gate: "commit", outcome: "pass" }),
    ]));
    expect(actorAccepted.effectRefs?.stateDeltaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(actorAccepted.commitBoundary).toMatchObject({ beforeHead: head, moved: true, eventHash: expect.any(String) });
    const scheduled = moved.trace.candidates.find((candidate) => candidate.lane === "background")!;
    expect(scheduled.scheduler).toMatchObject({
      candidateSource: "background-pressure",
      gates: expect.arrayContaining([expect.objectContaining({ gate: "precondition", outcome: "pass" })]),
      tuple: { tier: expect.any(Number), stableId: "close-room-after-allocation" },
    });
    expect(scheduled.footprint.writes).toEqual(["state:room:location.open"]);
    expect(scheduled.effectRefs?.stateDeltaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(scheduled.commitBoundary.beforeHead).toBe(actorAccepted.commitBoundary.afterHead);
    expect(scheduled.commitBoundary.afterHead).toBe(moved.newHead);

    const actorSafe = actorSafeWorldMoveTrace(moved.trace);
    expect(actorSafe).toEqual({
      version: 1,
      advanced: true,
      acceptedCount: 2,
      rejectedCount: 1,
      candidates: [
        { lane: "actor", status: "conflict", committed: false },
        { lane: "actor", status: "accepted", committed: true },
        { lane: "background", status: "accepted", committed: true },
      ],
    });
    const safeJson = JSON.stringify(actorSafe);
    for (const privateTerm of ["claim-cell-a", "claim-cell-b", "cell", "artifact.quantity", "scheduler", "effectRefs", "beforeHead"]) {
      expect(safeJson).not.toContain(privateTerm);
    }
  });
});

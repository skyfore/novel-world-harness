import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveActionConstraints, validateActionConstraintCatalog, type ActionConstraint } from "../src/world/action-constraint.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { WorldContextStore } from "../src/world/context.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { dueNormInstances, nextNormDueAt, resolveEffectiveNormTemplates, validateNormTemplateCatalog, type NormTemplate } from "../src/world/norm-ontology.js";
import { dueProcessInstances, nextProcessDueAt, type ProcessTemplate } from "../src/world/process-ontology.js";
import type { ActionInvocation, Entity, EventProposal, WorldRule, WorldState } from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const entities: Entity[] = [
  { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
  { id: "rival", kind: "character", canonicalName: "Rival", aliases: [], evidence: [] },
  { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] },
];

const journey: ProcessTemplate = {
  ontologyVersion: "process-template-v1",
  id: "journey",
  name: "Journey",
  ownerRoles: [{ id: "traveler", label: "Traveler", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }],
  phases: [
    { id: "departed", label: "Departed", terminal: false },
    { id: "arrived", label: "Arrived", terminal: true },
  ],
  initialPhaseId: "departed",
  transitions: [{ fromPhaseId: "departed", toPhaseId: "arrived", minimumProgress: 1 }],
  cadence: { kind: "elapsed-days", intervalDays: 2 },
  outcomeIds: ["safe-arrival"],
  visibility: "observable",
  induction: { kind: "domain-module", moduleId: "travel", moduleVersion: "1" },
  evidence: [],
};

const repayDebt: NormTemplate = {
  ontologyVersion: "norm-template-v1",
  id: "repay-debt",
  name: "Repay a debt",
  modality: "obligation",
  actionPattern: { kind: "ad-hoc", actionKindId: "repay" },
  appliesWhen: [],
  exceptions: [],
  defaultDeadlineDays: 1,
  reparations: [{
    id: "apologize",
    description: "Acknowledge and repair the missed obligation",
    actionPattern: { kind: "ad-hoc", actionKindId: "apology" },
    requiresAfter: [],
  }],
  priority: 10,
  defeasible: false,
  overridesTemplateIds: [],
  status: "supported",
  visibility: "public",
  knownByClaimIds: [],
  induction: { kind: "domain-module", moduleId: "social-duty", moduleVersion: "1" },
  evidence: [],
};

const doNotSteal: NormTemplate = {
  ...repayDebt,
  id: "do-not-steal",
  name: "Do not steal",
  modality: "prohibition",
  actionPattern: { kind: "ad-hoc", actionKindId: "steal" },
  defaultDeadlineDays: undefined,
  reparations: [],
};

const transferConstraint: ActionConstraint = {
  ontologyVersion: "action-constraint-v1",
  id: "transfer-requires-funds",
  name: "A transfer requires available funds",
  actionPattern: { kind: "ad-hoc", actionKindId: "transfer-money" },
  appliesWhen: [],
  clauses: [{
    id: "funds-at-least-three",
    timing: "before",
    modality: "require",
    predicate: { op: "fact-gte", entity: { kind: "actor" }, field: "character.wealth", value: 3 },
  }],
  exceptions: [],
  priority: 1,
  defeasible: false,
  overridesConstraintIds: [],
  status: "supported",
  visibility: "engine",
  induction: { kind: "domain-module", moduleId: "money", moduleVersion: "1" },
  evidence: [],
};

async function fixture(overrides: Partial<WorldModelContext> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-executable-rules-"));
  roots.push(root);
  const context: WorldModelContext = {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    rules: new Map(),
    actionConstraints: new Map([[transferConstraint.id, transferConstraint]]),
    normTemplates: new Map([[repayDebt.id, repayDebt], [doNotSteal.id, doNotSteal]]),
    processTemplates: new Map([[journey.id, journey]]),
    resourcePolicies: [{
      id: "closed-money",
      mode: "conserved",
      accounts: [
        { entityId: "hero", field: "character.wealth" },
        { entityId: "rival", field: "character.wealth" },
      ],
    }],
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    ...overrides,
  };
  const engine = new WorldEngine(root, context);
  const genesis = await engine.createBranch("main", "Main", {
    version: 1,
    operations: [
      { op: "set", entityId: "hero", field: "character.alive", value: true },
      { op: "set", entityId: "rival", field: "character.alive", value: true },
      { op: "set", entityId: "hero", field: "character.wealth", value: 5 },
      { op: "set", entityId: "rival", field: "character.wealth", value: 5 },
    ],
  });
  return { engine, genesis };
}

function adHoc(
  actionKindId: string,
  writes: Array<{ entityId: string; field: string }> = [],
  resources: Extract<ActionInvocation, { lane: "ad-hoc" }>["footprint"]["resources"] = [],
): Extract<ActionInvocation, { lane: "ad-hoc" }> {
  return {
    lane: "ad-hoc",
    actionKindId,
    description: actionKindId,
    footprint: {
      reads: resources.map(({ entityId, field }) => ({ entityId, field })),
      writes,
      resources,
    },
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

describe("executable state rules, constraints, norms, and processes", () => {
  it("resolves explicit constraint and norm exceptions/overrides and rejects override cycles", () => {
    const state: WorldState = {
      atCommit: "head",
      logicalTime: { step: 0, elapsedDays: 0 },
      activeRuleIds: [],
      values: {
        hero: { "character.wealth": 5, "character.plan": "licensed" },
        rival: { "character.wealth": 5 },
      },
    };
    const defeasibleConstraint: ActionConstraint = {
      ...transferConstraint,
      id: "ordinary-transfer-ban",
      actionPattern: { kind: "ad-hoc", actionKindId: "licensed-transfer" },
      clauses: [{
        id: "ban-transfer",
        timing: "before",
        modality: "forbid",
        predicate: { op: "fact-exists", entity: { kind: "actor" }, field: "character.wealth" },
      }],
      exceptions: [{
        id: "licensed-exception",
        appliesWhen: [{ op: "fact-equals", entity: { kind: "actor" }, field: "character.plan", value: "licensed" }],
      }],
      defeasible: true,
    };
    const overridingConstraint: ActionConstraint = {
      ...defeasibleConstraint,
      id: "emergency-transfer",
      priority: 2,
      overridesConstraintIds: [defeasibleConstraint.id],
      exceptions: [],
      clauses: [{
        id: "require-funds",
        timing: "before",
        modality: "require",
        predicate: { op: "fact-gte", entity: { kind: "actor" }, field: "character.wealth", value: 0 },
      }],
    };
    const invocation = adHoc("licensed-transfer");
    const excepted = resolveActionConstraints([defeasibleConstraint], {
      invocation,
      actorId: "hero",
      before: state,
      after: state,
    });
    expect(excepted.issues).toEqual([]);
    expect(excepted.inactive).toContainEqual(expect.objectContaining({
      constraintId: defeasibleConstraint.id,
      reason: "exception",
      exceptionId: "licensed-exception",
    }));

    const overridden = resolveActionConstraints([
      { ...defeasibleConstraint, exceptions: [] },
      overridingConstraint,
    ], { invocation, actorId: "hero", before: state, after: state });
    expect(overridden.issues).toEqual([]);
    expect(overridden.effective.map((item) => item.id)).toEqual([overridingConstraint.id]);
    expect(overridden.inactive).toContainEqual(expect.objectContaining({
      constraintId: defeasibleConstraint.id,
      reason: "overridden",
      overridingConstraintId: overridingConstraint.id,
    }));

    const prohibition: NormTemplate = { ...doNotSteal, defeasible: true };
    const permission: NormTemplate = {
      ...prohibition,
      id: "licensed-taking",
      name: "Licensed taking is permitted",
      modality: "permission",
      priority: 20,
      overridesTemplateIds: [prohibition.id],
    };
    expect(resolveEffectiveNormTemplates([prohibition, permission], state, "hero")
      .map((item) => item.template.id)).toEqual([permission.id]);

    const constraintCycle = validateActionConstraintCatalog([
      { ...defeasibleConstraint, id: "constraint-a", priority: 2, overridesConstraintIds: ["constraint-b"] },
      { ...defeasibleConstraint, id: "constraint-b", priority: 1, overridesConstraintIds: ["constraint-a"] },
    ], { entities: new Map(entities.map((entity) => [entity.id, entity])), actionSchemas: new Map() });
    expect(constraintCycle).toContainEqual(expect.objectContaining({ code: "ACTION_CONSTRAINT_OVERRIDE_CYCLE" }));

    const normCycle = validateNormTemplateCatalog([
      { ...prohibition, id: "norm-a", priority: 2, overridesTemplateIds: ["norm-b"] },
      { ...prohibition, id: "norm-b", priority: 1, overridesTemplateIds: ["norm-a"] },
    ], { entities: new Map(entities.map((entity) => [entity.id, entity])) });
    expect(normCycle).toContainEqual(expect.objectContaining({ code: "NORM_OVERRIDE_CYCLE" }));
  });

  it("freezes executable policy templates into canonical revisions and snapshots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-policy-context-"));
    roots.push(root);
    const canonical = new CanonicalModelStore(root);
    for (const entity of entities) await canonical.putEntity(entity);
    await canonical.putActionConstraint(transferConstraint);
    await canonical.putNormTemplate(repayDebt);
    await canonical.putProcessTemplate(journey);

    const contexts = new WorldContextStore(root, canonical);
    const captured = await contexts.captureCurrent();
    expect(captured.actionConstraints?.get(transferConstraint.id)).toEqual(transferConstraint);
    expect(captured.normTemplates?.get(repayDebt.id)).toEqual(repayDebt);
    expect(captured.processTemplates?.get(journey.id)).toEqual(journey);
    const restored = await contexts.load(captured.canonicalSnapshotHash!);
    expect(restored.actionConstraints?.get(transferConstraint.id)).toEqual(transferConstraint);
    expect(restored.normTemplates?.get(repayDebt.id)).toEqual(repayDebt);
    expect(restored.processTemplates?.get(journey.id)).toEqual(journey);
  });

  it("rejects an unavailable resource action and enforces configured conservation", async () => {
    const { engine, genesis } = await fixture();
    const transfer = await engine.commitProposal(proposal(genesis, {
      proposalId: "balanced-transfer",
      source: "player",
      actorId: "hero",
      participants: ["hero", "rival"],
      action: adHoc("transfer-money", [
        { entityId: "hero", field: "character.wealth" },
        { entityId: "rival", field: "character.wealth" },
      ], [
        { entityId: "hero", field: "character.wealth", mode: "transfer-out", amount: 3 },
        { entityId: "rival", field: "character.wealth", mode: "transfer-in", amount: 3 },
      ]),
      proposedDelta: { version: 1, operations: [
        { op: "adjust-number", entityId: "hero", field: "character.wealth", amount: -3 },
        { op: "adjust-number", entityId: "rival", field: "character.wealth", amount: 3 },
      ] },
    }));
    expect(transfer.report.accepted).toBe(true);

    const insufficient = await engine.commitProposal(proposal(transfer.newHead, {
      proposalId: "insufficient-transfer",
      source: "player",
      actorId: "hero",
      participants: ["hero", "rival"],
      action: adHoc("transfer-money", [
        { entityId: "hero", field: "character.wealth" },
        { entityId: "rival", field: "character.wealth" },
      ], [
        { entityId: "hero", field: "character.wealth", mode: "transfer-out", amount: 3 },
        { entityId: "rival", field: "character.wealth", mode: "transfer-in", amount: 3 },
      ]),
      proposedDelta: { version: 1, operations: [
        { op: "adjust-number", entityId: "hero", field: "character.wealth", amount: -3 },
        { op: "adjust-number", entityId: "rival", field: "character.wealth", amount: 3 },
      ] },
    }));
    expect(insufficient.report.errors).toContainEqual(expect.objectContaining({ code: "ACTION_CONSTRAINT_REQUIREMENT_FAILED" }));

    const minted = await engine.commitProposal(proposal(transfer.newHead, {
      proposalId: "unmodeled-mint",
      source: "player",
      actorId: "rival",
      action: adHoc("mint-money", [{ entityId: "rival", field: "character.wealth" }], [
        { entityId: "rival", field: "character.wealth", mode: "produce", amount: 2 },
      ]),
      proposedDelta: { version: 1, operations: [
        { op: "adjust-number", entityId: "rival", field: "character.wealth", amount: 2 },
      ] },
    }));
    expect(minted.report.errors).toContainEqual(expect.objectContaining({ code: "RESOURCE_CONSERVATION_FAILED" }));
    expect(await engine.branches.readHead("main")).toBe(transfer.newHead);
  });

  it("materializes and advances a template-bound process with a meaningful due time", async () => {
    const { engine, genesis } = await fixture();
    const started = await engine.commitProposal(proposal(genesis, {
      proposalId: "start-journey",
      proposedProcesses: {
        version: 1,
        operations: [{
          op: "start-process",
          localRef: "local-journey",
          process: {
            templateId: "journey",
            ownerBindings: [{ roleId: "traveler", entityIds: ["hero"] }],
            progress: 0,
          },
        }],
      },
    }));
    expect(started.report.accepted).toBe(true);
    expect(started.progressCertificate?.channels).toContain("process");
    let bundle = await engine.projections.project(started.newHead);
    const instance = Object.values(bundle.processes.instances)[0]!;
    expect(instance).toMatchObject({ templateId: "journey", phaseId: "departed", dueAtElapsedDays: 2, status: "running" });
    expect(instance.id).toMatch(/^branch-process-/);
    expect(nextProcessDueAt(bundle.processes)).toBe(2);
    expect(dueProcessInstances(bundle.processes, 1)).toEqual([]);

    const clock = await engine.commitProposal(proposal(started.newHead, {
      proposalId: "two-days-pass",
      timeAdvance: { amount: 2, unit: "day" },
    }));
    expect(clock.report.accepted).toBe(true);
    bundle = await engine.projections.project(clock.newHead);
    expect(dueProcessInstances(bundle.processes, 2).map((item) => item.id)).toEqual([instance.id]);

    const finished = await engine.commitProposal(proposal(clock.newHead, {
      proposalId: "arrive-and-finish",
      proposedProcesses: { version: 1, operations: [
        { op: "advance-process", processRef: instance.id, amount: 1, phaseId: "arrived" },
        { op: "finish-process", processRef: instance.id, outcomeId: "safe-arrival" },
      ] },
    }));
    expect(finished.report.accepted).toBe(true);
    expect((await engine.projections.project(finished.newHead)).processes.instances[instance.id]?.status).toBe("finished");
  });

  it("turns deadlines and prohibited actions into committed norm outcomes, then validates reparation", async () => {
    const { engine, genesis } = await fixture();
    const instantiated = await engine.commitProposal(proposal(genesis, {
      proposalId: "incur-debt",
      proposedNorms: { version: 1, operations: [{
        op: "instantiate-norm",
        localRef: "local-debt",
        norm: {
          templateId: "repay-debt",
          subjectActorId: "hero",
          beneficiaryActorId: "rival",
          description: "Hero must repay Rival",
        },
      }] },
    }));
    expect(instantiated.report.accepted).toBe(true);
    let bundle = await engine.projections.project(instantiated.newHead);
    const debt = Object.values(bundle.norms.instances)[0]!;
    expect(debt).toMatchObject({ status: "active", dueAtElapsedDays: 1 });
    expect(nextNormDueAt(bundle.norms)).toBe(1);
    expect(dueNormInstances(bundle.norms, 0)).toEqual([]);

    const deadline = await engine.commitProposal(proposal(instantiated.newHead, {
      proposalId: "deadline-arrives",
      timeAdvance: { amount: 1, unit: "day" },
    }));
    expect(deadline.report.accepted).toBe(true);
    expect(deadline.progressCertificate?.channels).toContain("norm");
    bundle = await engine.projections.project(deadline.newHead);
    expect(bundle.norms.instances[debt.id]).toMatchObject({ status: "violated", violationReasonId: "deadline-expired" });

    const repaired = await engine.commitProposal(proposal(deadline.newHead, {
      proposalId: "repair-debt",
      source: "player",
      actorId: "hero",
      action: adHoc("apology"),
      proposedNorms: { version: 1, operations: [{
        op: "repair-norm",
        normRef: debt.id,
        byActorId: "hero",
        reparationId: "apologize",
      }] },
    }));
    expect(repaired.report.accepted).toBe(true);
    expect((await engine.projections.project(repaired.newHead)).norms.instances[debt.id]).toMatchObject({ status: "repaired", reparationId: "apologize" });

    const prohibited = await engine.commitProposal(proposal(repaired.newHead, {
      proposalId: "activate-theft-prohibition",
      proposedNorms: { version: 1, operations: [{
        op: "instantiate-norm",
        localRef: "local-theft-ban",
        norm: { templateId: "do-not-steal", subjectActorId: "hero", description: "Hero must not steal" },
      }] },
    }));
    bundle = await engine.projections.project(prohibited.newHead);
    const theftBan = Object.values(bundle.norms.instances).find((item) => item.templateId === "do-not-steal")!;
    const theft = await engine.commitProposal(proposal(prohibited.newHead, {
      proposalId: "steal-anyway",
      source: "player",
      actorId: "hero",
      action: adHoc("steal"),
    }));
    expect(theft.report.accepted).toBe(true);
    expect(theft.progressCertificate?.channels).toContain("norm");
    expect((await engine.projections.project(theft.newHead)).norms.instances[theftBan.id]).toMatchObject({ status: "violated", violationReasonId: "prohibited-action" });
  });

  it("keeps physical rules hard while committing legal rule violations", async () => {
    const support = [{
      span: { sourceId: "novel", startByte: 0, endByte: 10, startLine: 1, endLine: 1, quoteHash: "a".repeat(64) },
      strength: "explicit" as const,
    }];
    const rule = (id: string, kind: "physical" | "legal"): WorldRule => ({
      ontologyVersion: "world-rule-v2",
      id,
      name: id,
      kind,
      scope: "global",
      ...(kind === "legal" ? { authorityEntityId: "hero" } : {}),
      jurisdictionEntityIds: [],
      appliesWhen: [],
      visibility: "public",
      knownByClaimIds: [],
      priority: 1,
      defeasible: false,
      overridesRuleIds: [],
      clauses: [{
        id: `${id}-clause`,
        modality: "forbid",
        predicate: { op: "fact-equals", entityId: "hero", field: "character.plan", value: "forbidden" },
        basis: "explicit",
        status: "supported",
        confidence: 1,
        evidence: support,
      }],
      exceptions: [],
      basis: "explicit",
      status: "supported",
      confidence: 1,
      evidence: support,
    });

    const physical = rule("physical-limit", "physical");
    let setup = await fixture({ rules: new Map([[physical.id, physical]]) });
    const physicalHead = await setup.engine.commitProposal(proposal(setup.genesis, {
      proposalId: "activate-physical",
      proposedDelta: { version: 1, operations: [{ op: "activate-rule", ruleId: physical.id }] },
    }));
    const rejected = await setup.engine.commitProposal(proposal(physicalHead.newHead, {
      proposalId: "break-physics",
      actorId: "hero",
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "forbidden" }] },
    }));
    expect(rejected.report.errors).toContainEqual(expect.objectContaining({ code: "STATE_RULE_FORBIDS" }));

    const legal = rule("legal-ban", "legal");
    setup = await fixture({ rules: new Map([[legal.id, legal]]) });
    const legalHead = await setup.engine.commitProposal(proposal(setup.genesis, {
      proposalId: "activate-legal",
      proposedDelta: { version: 1, operations: [{ op: "activate-rule", ruleId: legal.id }] },
    }));
    const committed = await setup.engine.commitProposal(proposal(legalHead.newHead, {
      proposalId: "break-law",
      actorId: "hero",
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "forbidden" }] },
    }));
    expect(committed.report.accepted).toBe(true);
    const violations = Object.values((await setup.engine.projections.project(committed.newHead)).norms.instances);
    expect(violations).toContainEqual(expect.objectContaining({ templateId: legal.id, status: "violated" }));
  });
});

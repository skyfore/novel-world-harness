import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { actionConstraintSchema } from "../src/world/action-constraint.js";
import { actionSchemaSchema } from "../src/world/action-ontology.js";
import { buildActorDecisionView, mapActorDecisionView } from "../src/world/actor-decision-view.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { actorKnowledgeBelongsToSource, KnowledgeProjector } from "../src/world/knowledge.js";
import type { Entity, EvidenceRef } from "../src/world/model.js";
import {
  buildActorScopedActionContext,
  createPlayerActionModelBoundary,
  playerActionTranslationContext,
  playerActionToKnowledgeAwareAction,
  validatePlayerActionSpatialScope,
  type PlayerActionCandidate,
  PlayerTurnService,
  validatePlayerActionScope,
} from "../src/world/player-action.js";
import { processTemplateSchema } from "../src/world/process-ontology.js";
import { normTemplateSchema } from "../src/world/norm-ontology.js";
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

function spatialFixture() {
  return fixture({ spatialOntologyVersion: "spatial-v1", spatialRelations: [spatialRelationSchema.parse({
    ontologyVersion: "spatial-v1", id: "road", kind: "route", fromLocationId: "village", toLocationId: "harbor",
    direction: "two-way", modes: ["foot"], duration: { minimum: 2, typical: 2, maximum: 2, unit: "hour" },
    basis: "explicit", visibility: "public", status: "supported", confidence: 1, evidence,
  })] });
}

describe("novel-to-play review regressions", () => {
  it("R2: source-induced public actions work before their first supporting occurrence; knowledge gates stay actor-specific", async () => {
    const schema = actionSchemaSchema.parse({ ontologyVersion: "action-schema-v1", id: "plan", name: "Plan", visibility: "public",
      roles: [{ id: "actor", label: "Actor", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }], initiatorRoleId: "actor", parameters: [], preconditions: [],
      stateEffects: [{ op: "set", entity: { kind: "role", roleId: "actor" }, field: "character.plan", value: { source: "literal", value: "leave" } }],
      effectEnvelope: { maxStateOperations: 1, allowedStateFields: ["character.plan"], allowsKnowledge: false, allowsTimeAdvance: false, allowsSceneTransition: false },
      induction: { kind: "source-pattern", supportingEventIds: ["future-first", "future-second"] }, evidence });
    const secret = actionSchemaSchema.parse({ ...schema, id: "secret", visibility: "knowledge", knownByClaimIds: ["learned-secret"] });
    const hidden = actionSchemaSchema.parse({ ...schema, id: "hidden", visibility: "engine" });
    const { engine, head } = await fixture({ actionSchemas: new Map([schema, secret, hidden].map((item) => [item.id, item])) });
    const context = await buildActorScopedActionContext(engine, "hero", head, undefined, "novel");
    expect(context.decision?.capabilities.actions.map((item) => item.id)).toEqual(["plan"]);
    const informed = await buildActorDecisionView(engine, "hero", head, { visibleEntityIds: new Set(["hero"]), knownClaimIds: new Set(["learned-secret"]), sourceId: "novel" });
    expect(informed.capabilities.actions.map((item) => item.id)).toEqual(["plan", "secret"]);
    expect((await buildActorDecisionView(engine, "rival", head, { visibleEntityIds: new Set(["rival"]), knownClaimIds: new Set(), sourceId: "novel" })).capabilities.actions.map((item) => item.id)).toEqual(["plan"]);
    const candidate: PlayerActionCandidate = { title: "Plan", participants: [], preconditions: [], requiresKnowledge: [], forbidsKnowledge: [],
      action: { lane: "schema-bound", schemaId: schema.id, roleBindings: [{ roleId: "actor", entityIds: ["hero"] }], parameters: {} },
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "leave" }] } };
    expect(validatePlayerActionScope(candidate, context)).toEqual([]);
    const proposal = playerActionToKnowledgeAwareAction({ branchId: "main", actorId: "hero", expectedParentCommit: head, utterance: "Plan", candidate }).proposal;
    expect((await engine.previewProposal(proposal)).report.errors).toEqual([]);
    expect((await engine.previewProposal({ ...proposal, action: { ...candidate.action!, schemaId: "secret" } })).report.errors).toContainEqual(expect.objectContaining({ code: "ACTOR_MECHANISM_UNAVAILABLE" }));
    expect((await engine.commitProposal(proposal)).report.accepted).toBe(true);
  });

  it("R1: actor progress needs action, time and state proof, with atomic rejection and a per-turn limit", async () => {
    const control = { actionPattern: { kind: "ad-hoc", actionKindId: "deliver" }, minimumElapsedDays: 1,
      requiresBefore: [{ op: "fact-equals", entity: { kind: "role", roleId: "courier" }, field: "character.alive", value: true }],
      requiresAfter: [{ op: "fact-equals", entity: { kind: "actor" }, field: "character.plan", value: "delivered" }] };
    const process = processTemplateSchema.parse({ ontologyVersion: "process-template-v1", id: "delivery", name: "Delivery",
      ownerRoles: [{ id: "courier", label: "Courier", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }],
      phases: [{ id: "started", label: "Started", terminal: false }, { id: "delivered", label: "Delivered", terminal: true }], initialPhaseId: "started",
      transitions: [{ fromPhaseId: "started", toPhaseId: "delivered", minimumProgress: 0.5 }], outcomeIds: ["received"], visibility: "public",
      actorControls: [{ ...control, op: "advance-process", maximumAdvance: 0.5, fromPhaseId: "started", toPhaseId: "delivered" }, { ...control, op: "finish-process", fromPhaseId: "delivered", outcomeId: "received" }],
      induction: { kind: "domain-module", moduleId: "test", moduleVersion: "1" }, evidence: [] });
    const { engine, head } = await fixture({ processTemplates: new Map([[process.id, process]]) });
    const base: PlayerActionCandidate = { title: "Take delivery", participants: [], preconditions: [], requiresKnowledge: [], forbidsKnowledge: [], proposedDelta: { version: 1, operations: [] },
      proposedProcesses: { version: 1, operations: [{ op: "start-process", localRef: "local-job", process: { templateId: process.id, ownerBindings: [{ roleId: "courier", entityIds: ["hero"] }], progress: 0 } }] } };
    type TimedCandidate = PlayerActionCandidate & { timeAdvance?: { amount: number; unit: "day" } };
    const convert = ({ timeAdvance, ...candidate }: TimedCandidate, at: string) => playerActionToKnowledgeAwareAction({ branchId: "main", actorId: "hero", expectedParentCommit: at, utterance: "Deliver", candidate, timeAdvance }).proposal;
    const accelerated = structuredClone(base);
    (accelerated.proposedProcesses!.operations[0] as any).process.progress = 0.5;
    expect((await engine.previewProposal(convert(accelerated, head))).report.errors).toContainEqual(expect.objectContaining({ code: "INVALID_PROCESS_DELTA" }));
    const start = await engine.commitProposal(convert(base, head));
    expect(start.report.errors).toEqual([]);
    const id = Object.keys((await engine.projections.project(start.newHead)).processes.instances)[0]!;
    const work: TimedCandidate = { ...base, title: "Deliver", timeAdvance: { amount: 1, unit: "day" },
      action: { lane: "ad-hoc", actionKindId: "deliver", description: "Deliver shipment", footprint: { reads: [{ entityId: "hero", field: "character.alive" }], writes: [{ entityId: "hero", field: "character.plan" }], resources: [] } },
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "delivered" }] },
      proposedProcesses: { version: 1, operations: [{ op: "advance-process", processRef: id, amount: 0.5, phaseId: "delivered" }, { op: "finish-process", processRef: id, outcomeId: "received" }] } };
    const noTime = structuredClone(work); delete noTime.timeAdvance;
    const noState = structuredClone(work); noState.proposedDelta.operations = []; if (noState.action?.lane === "ad-hoc") noState.action.footprint.writes = [];
    const wait = structuredClone(work); (wait.action as any).actionKindId = "wait";
    const split = structuredClone(work); split.proposedProcesses!.operations.splice(1, 0, { op: "advance-process", processRef: id, amount: 0.25, phaseId: "delivered" });
    for (const invalid of [noTime, noState, wait, split]) {
      const rejected = await engine.commitProposal(convert(invalid, start.newHead));
      expect(rejected.report.errors).toContainEqual(expect.objectContaining({ code: "INVALID_PROCESS_DELTA" }));
      expect(rejected.newHead).toBe(start.newHead);
    }
    const accepted = await engine.commitProposal(convert(work, start.newHead));
    expect(accepted.report.errors).toEqual([]);
    const replay = await engine.projections.project(accepted.newHead, { fresh: true });
    expect(replay.processes.instances[id]).toMatchObject({ status: "finished", outcomeId: "received" });
    expect(replay.state.logicalTime.elapsedDays).toBe(1);
  });

  it("R6: beneficiary receipts normalize explicit and implicit identity and replay both identities", async () => {
    const norm = normTemplateSchema.parse({ ontologyVersion: "norm-template-v1", id: "receipt", name: "Delivery receipt", modality: "obligation",
      actionPattern: { kind: "ad-hoc", actionKindId: "deliver" }, priority: 1, defeasible: false, status: "supported", visibility: "public",
      induction: { kind: "domain-module", moduleId: "test", moduleVersion: "1" }, evidence: [] });
    const { engine, head } = await fixture({ normTemplates: new Map([[norm.id, norm]]) });
    const seed = await engine.commitProposal({ proposalId: "seed-receipt", branchId: "main", expectedParentCommit: head, source: "background", title: "Duty accepted",
      participants: ["hero", "rival"], proposedTime: { kind: "ordinal", orderHint: 1, label: "accepted" }, preconditions: [], proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence: [],
      proposedNorms: { version: 1, operations: [{ op: "instantiate-norm", localRef: "local-duty", norm: { templateId: norm.id, subjectActorId: "hero", beneficiaryActorId: "rival", description: "Delivery" } }] } });
    expect(seed.report.errors).toEqual([]);
    const id = Object.keys((await engine.projections.project(seed.newHead)).norms.instances)[0]!;
    const proposal = (actorId: string, explicit: boolean) => playerActionToKnowledgeAwareAction({ branchId: "main", actorId, expectedParentCommit: seed.newHead, utterance: "Received", candidate: {
      title: "Acknowledge delivery", participants: [], preconditions: [], requiresKnowledge: [], forbidsKnowledge: [], proposedDelta: { version: 1, operations: [] },
      proposedNorms: { version: 1, operations: [{ op: "satisfy-norm", normRef: id, ...(explicit ? { byActorId: actorId } : {}) }] },
    } }).proposal;
    for (const explicit of [false, true]) {
      expect((await engine.previewProposal(proposal("hero", explicit))).report.errors).toContainEqual(expect.objectContaining({ code: "ACTOR_OUTCOME_AUTHORITY_REQUIRED" }));
      expect((await engine.previewProposal(proposal("rival", explicit))).report.errors).toEqual([]);
    }
    const committed = await engine.commitProposal(proposal("rival", true));
    expect(committed.report.errors).toEqual([]);
    const replay = await engine.projections.project(committed.newHead);
    expect(replay.norms.instances[id]).toMatchObject({ status: "satisfied", resolvedByActorId: "hero", acknowledgedByActorId: "rival" });
    expect(replay.history.at(-1)?.normDelta?.operations).toContainEqual({ op: "satisfy-norm", normId: id, byActorId: "hero", acknowledgedByActorId: "rival" });
    expect(await engine.branches.readHead("main")).toBe(committed.newHead);
  });

  it("does not expose hidden entity choices in capabilities and encodes custom entity-set literals", async () => {
    const schema = (id: string, value: string[]) => actionSchemaSchema.parse({ ontologyVersion: "action-schema-v1", id, name: id,
      roles: [{ id: "initiator", label: "Initiator", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }], initiatorRoleId: "initiator", parameters: [], preconditions: [],
      stateEffects: [{ op: "set", entity: { kind: "role", roleId: "initiator" }, field: "character.destinations", value: { source: "literal", value } }],
      effectEnvelope: { maxStateOperations: 1, allowedStateFields: ["character.destinations"], allowsKnowledge: false, allowsTimeAdvance: false, allowsSceneTransition: false }, induction: { kind: "domain-module", moduleId: "test", moduleVersion: "1" }, evidence: [] });
    const known = schema("known", ["village"]), hidden = schema("hidden", ["harbor"]), parameter = schema("parameter", ["village"]);
    parameter.parameters = [{ id: "destination", valueType: "entity-ref", required: false, allowedValues: ["harbor"] }];
    const { engine, head } = await fixture({ stateSchema: new StateSchemaRegistry([...DEFAULT_STATE_FIELDS, { key: "character.destinations", appliesTo: ["character"], valueType: "entity-ref-set", cardinality: "many", visibility: "self" }]), actionSchemas: new Map([known, hidden, parameter].map((action) => [action.id, action])) });
    const view = await buildActorDecisionView(engine, "hero", head, { sourceId: "novel", visibleEntityIds: new Set(["hero", "village"]), knownClaimIds: new Set() });
    expect(view.capabilities.actions.map((action) => action.id)).toEqual(["known"]);
    expect(mapActorDecisionView(view, (id) => `handle-${id}`, (id) => `ref-${id}`).capabilities.actions[0]!.stateEffects[0]).toMatchObject({ value: { source: "literal", value: ["handle-village"] } });
  });
  it("does not authorize physical or resource effects from a wait label or a matching ad-hoc footprint", async () => {
    const { engine, head } = await fixture();
    for (const field of ["character.health", "character.wealth"]) {
      const action = playerActionToKnowledgeAwareAction({ branchId: "main", actorId: "hero", expectedParentCommit: head, utterance: "I wait and recover", candidate: {
        title: "Wait", participants: [], preconditions: [], requiresKnowledge: [], forbidsKnowledge: [],
        action: { lane: "ad-hoc", actionKindId: "wait", description: "Wait", footprint: { reads: [], writes: [{ entityId: "hero", field }], resources: [] } },
        proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field, value: 1 }] },
      } });
      const result = await engine.commitProposal(action.proposal);
      expect(result.report.errors).toContainEqual(expect.objectContaining({ code: "ACTOR_EFFECT_REQUIRES_MECHANISM" }));
      expect(await engine.branches.readHead("main")).toBe(head);
    }
  });

  it("S01/S04: the real player turn admits five channels atomically and exposes them on the next decision", async () => {
    const process = processTemplateSchema.parse({
      ontologyVersion: "process-template-v1", id: "delivery", name: "Delivery", ownerRoles: [{ id: "courier", label: "Courier", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }],
      phases: [{ id: "accepted", label: "Accepted", terminal: false }, { id: "delivered", label: "Delivered", terminal: true }],
      initialPhaseId: "accepted", transitions: [{ fromPhaseId: "accepted", toPhaseId: "delivered", minimumProgress: 1 }], outcomeIds: ["delivered"],
      visibility: "public", induction: { kind: "domain-module", moduleId: "delivery", moduleVersion: "1" }, evidence: [],
    });
    const norm = normTemplateSchema.parse({ ontologyVersion: "norm-template-v1", id: "delivery-duty", name: "Deliver accepted letter", modality: "obligation", actionPattern: { kind: "ad-hoc", actionKindId: "deliver" },
      defaultDeadlineDays: 1, priority: 1, defeasible: false, status: "supported", visibility: "public", induction: { kind: "domain-module", moduleId: "delivery", moduleVersion: "1" }, evidence: [] });
    const { engine, head } = await fixture({ processTemplates: new Map([[process.id, process]]), normTemplates: new Map([[norm.id, norm]]) });
    const candidate: PlayerActionCandidate = {
      title: "Accept delivery", participants: [], preconditions: [], requiresKnowledge: [], forbidsKnowledge: [],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "Deliver the letter" }] },
      proposedSemantics: { version: 1, operations: [
        { op: "record-proposition", localRef: "local-p", proposition: { subjectEntityId: "hero", relationId: "intends-delivery", object: { kind: "literal", value: "letter" }, polarity: "positive", modality: "asserted" } },
        { op: "record-attribution", localRef: "local-a", attribution: { propositionId: "local-p", holderKind: "character", holderEntityId: "hero", attitude: "believes", certainty: 1 } },
        { op: "record-claim", localRef: "local-c", claim: { propositionId: "local-p", attributionId: "local-a", status: "asserted" } },
        { op: "open-goal", localRef: "local-g", goal: { actorId: "hero", description: "Deliver letter", priority: 0.8, targetEntityIds: [] } },
        { op: "create-obligation", localRef: "local-o", obligation: { debtorActorId: "hero", kindId: "provide", description: "Accepted delivery" } },
      ] },
      proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "hero", claimId: "local-c", propositionId: "local-p", attributionId: "local-a", acquisitionMode: "inferred", status: "believes", confidence: 1 }] },
      proposedProcesses: { version: 1, operations: [{ op: "start-process", localRef: "local-job", process: { templateId: process.id, ownerBindings: [{ roleId: "courier", entityIds: ["hero"] }], progress: 0 } }] },
      proposedNorms: { version: 1, operations: [{ op: "instantiate-norm", localRef: "local-duty", norm: { templateId: norm.id, subjectActorId: "hero", description: "Deliver before tomorrow" } }] },
    };
    const context = await buildActorScopedActionContext(engine, "hero", head, undefined, "novel");
    const boundary = createPlayerActionModelBoundary(playerActionTranslationContext(context));
    const encoded = boundary.encodeCandidate(candidate);
    expect(JSON.stringify(encoded)).not.toContain('"delivery-duty"');
    const decoded = boundary.decodeCandidate(encoded);
    expect(decoded).toEqual(candidate);
    expect(validatePlayerActionScope(decoded, context)).toEqual([]);
    const proposal = playerActionToKnowledgeAwareAction({ branchId: "main", actorId: "hero", expectedParentCommit: head, utterance: "I accept", candidate }).proposal;
    const preview = await engine.previewProposal(proposal);
    expect(preview.report.errors).toEqual([]);
    expect((await engine.branches.read("main")).headCommitId).toBe(head);
    const invalid = structuredClone(proposal);
    invalid.proposedNorms!.operations.push({ op: "satisfy-norm", normRef: "missing", byActorId: "hero" });
    expect((await engine.commitProposal(invalid)).report.accepted).toBe(false);
    expect((await engine.projections.project(head)).semantics.goals).toEqual({});
    const result = await new PlayerTurnService(engine, () => candidate).turn({ branchId: "main", actorId: "hero", sourceId: "novel", utterance: "I accept delivery" });
    expect(result.issues).toEqual([]);
    expect(result.accepted).toBe(true);
    expect(result.contextAfter.decision?.goals).toHaveLength(1);
    expect(result.contextAfter.decision?.obligations).toHaveLength(1);
    expect(result.contextAfter.decision?.processes).toHaveLength(1);
    expect(result.contextAfter.decision?.norms).toHaveLength(1);
    expect(result.contextAfter.knowledge).toHaveLength(1);
    const dishonestDischarge = playerActionToKnowledgeAwareAction({ branchId: "main", actorId: "hero", expectedParentCommit: result.newHead, utterance: "I declare my duty discharged", candidate: {
      title: "Self-issued receipt", participants: [], preconditions: [], requiresKnowledge: [], forbidsKnowledge: [], proposedDelta: { version: 1, operations: [] },
      proposedNorms: { version: 1, operations: [{ op: "satisfy-norm", normRef: result.contextAfter.decision!.norms[0]!.id, byActorId: "hero" }] },
    } }).proposal;
    expect((await engine.commitProposal(dishonestDischarge)).report.errors).toContainEqual(expect.objectContaining({ code: "ACTOR_OUTCOME_AUTHORITY_REQUIRED" }));
    expect(await engine.branches.readHead("main")).toBe(result.newHead);
    const committed = (await engine.projections.project(result.newHead)).history.at(-1)!;
    const reentry = await engine.createBranch("reentry", "Reentry", { version: 1, operations: [
      { op: "set", entityId: "hero", field: "character.alive", value: true },
      { op: "set", entityId: "hero", field: "character.location", value: "village" },
      ...committed.delta.operations,
    ] }, committed.knowledgeDelta, "novel", undefined, evidence, {}, { entryActorId: "hero", realizesCanonicalEventIds: [],
      projectionSeed: { version: 1, semantics: committed.semanticDelta!, processes: committed.processDelta!, norms: committed.normDelta!, activeRuleIds: [], elapsedDays: 0 } });
    const reentered = await buildActorScopedActionContext(engine, "hero", reentry, undefined, "novel");
    expect(reentered.decision).toEqual(result.contextAfter.decision);
    expect(reentered.knowledge).toEqual(result.contextAfter.knowledge);
    expect((await buildActorScopedActionContext(engine, "rival", result.newHead, undefined, "novel")).decision?.goals).toEqual([]);
  });

  it("S05: a direct actor proposal cannot assign its counterparty a goal or accepted debt", async () => {
    const { engine, head } = await fixture();
    const candidate: PlayerActionCandidate = { title: "Order rival", participants: ["rival"], preconditions: [], requiresKnowledge: [], forbidsKnowledge: [], proposedDelta: { version: 1, operations: [] },
      proposedSemantics: { version: 1, operations: [{ op: "open-goal", localRef: "local-g", goal: { actorId: "rival", description: "Obey me", priority: 1, targetEntityIds: [] } },
        { op: "create-obligation", localRef: "local-o", obligation: { debtorActorId: "rival", creditorActorId: "hero", kindId: "obedience", description: "Obey me" } }] } };
    const proposal = playerActionToKnowledgeAwareAction({ branchId: "main", actorId: "hero", expectedParentCommit: head, utterance: "Obey", candidate }).proposal;
    const result = await engine.commitProposal(proposal);
    expect(result.report.errors.filter((x) => x.code === "ACTOR_OUTCOME_AUTHORITY_REQUIRED")).toHaveLength(2);
    expect(result.newHead).toBe(head);
  });

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
    expect(actorKnowledgeBelongsToSource(projected.knowledge[0]!, "novel")).toBe(true);
    expect(actorKnowledgeBelongsToSource(projected.knowledge[0]!, "another-novel")).toBe(false);
    expect(actorKnowledgeBelongsToSource(structuredClone(projected.knowledge[0]!), "novel")).toBe(false);
    expect((await buildActorScopedActionContext(engine, "hero", next, undefined, "novel")).knowledge).toHaveLength(1);
    expect((await buildActorScopedActionContext(engine, "rival", next, undefined, "novel")).knowledge).toHaveLength(0);
    expect((await buildActorScopedActionContext(engine, "hero", head, undefined, "novel")).knowledge).toHaveLength(0);
  });

  it("F3: removing an arrive label cannot authorize a too-fast location delta at the engine boundary", async () => {
    const { engine, head } = await spatialFixture();
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

  it.each([
    { mode: "foot" as const, hours: 2, accepted: true },
    { mode: "foot" as const, hours: 1, accepted: false },
    { mode: "water" as const, hours: 2, accepted: false },
    { mode: undefined, hours: 2, accepted: false },
  ])("A02/A03: direct engine travel $mode for $hours hours has verdict $accepted", async ({ mode, hours, accepted }) => {
    const { engine, head } = await spatialFixture();
    const result = await engine.commitProposal({
      proposalId: "direct-travel", branchId: "main", expectedParentCommit: head, source: "actor", actorId: "hero",
      title: "Travel", participants: ["hero"], proposedTime: { kind: "unknown" }, timeAdvance: { amount: hours, unit: "hour" },
      preconditions: [], causalParents: [], evidence: [],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.location", value: "harbor" }] },
      action: { lane: "ad-hoc", actionKindId: "travel", description: "Travel", ...(mode ? { travelMode: mode } : {}),
        footprint: { reads: [], writes: [{ entityId: "hero", field: "character.location" }], resources: [] } },
    });
    expect(result.report.accepted).toBe(accepted);
    expect((await engine.projector.project(result.newHead)).values.hero?.["character.location"])
      .toBe(accepted ? "harbor" : "village");
  });

  it("S03/K04: decision views consume branch goals without exposing another actor's private attitudes or persistent IDs", async () => {
    const { engine, head } = await fixture();
    const result = await engine.commitProposal({
      proposalId: "new-goal", branchId: "main", expectedParentCommit: head, source: "background", title: "A decision",
      participants: ["hero", "rival"], proposedTime: { kind: "unknown" }, preconditions: [], causalParents: [], evidence: [],
      proposedDelta: { version: 1, operations: [] },
      proposedSemantics: { version: 1, operations: [
        { op: "open-goal", localRef: "local-goal", goal: { actorId: "hero", description: "Deliver the letter", priority: 0.8, targetEntityIds: [] } },
        { op: "adjust-relationship", relationshipRef: "local-private-attitude", createIfMissing: true, fromActorId: "rival", toActorId: "hero", dimensionId: "trust", amount: -0.5 },
      ] },
    });
    expect(result.report.accepted).toBe(true);
    const hero = await buildActorScopedActionContext(engine, "hero", result.newHead);
    const rival = await buildActorScopedActionContext(engine, "rival", result.newHead);
    expect(hero.decision?.goals).toEqual([expect.objectContaining({ description: "Deliver the letter" })]);
    expect(hero.decision?.relationships).toEqual([]);
    expect(rival.decision?.goals).toEqual([]);
    expect((await buildActorScopedActionContext(engine, "hero", head)).decision?.goals).toEqual([]);
    const model = createPlayerActionModelBoundary(playerActionTranslationContext(hero)).context;
    expect(JSON.stringify(model)).not.toContain(hero.decision!.goals[0]!.id);
    expect(model.decision).toMatchObject({ goals: [{ id: expect.stringMatching(/^semantic-/), description: "Deliver the letter" }] });
  });
});

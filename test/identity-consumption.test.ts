import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { contentHash as h } from "../src/world/canonical.js";
import { entitySchema, entryProjectionSeedSchema, type EventProposal } from "../src/world/model.js";
import { identityResolutionSchema } from "../src/compiler/entity-resolution.js";
import { entityMentionSchema } from "../src/compiler/annotations.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { validateIdentityConsumptionBinding } from "../src/compiler/entity-identity-consumption.js";
import { identityConsumptionIssues, validateSourceLocalIdentityEvidence } from "../src/world/identity-consumption.js";
import { StateSchemaRegistry, DEFAULT_STATE_FIELDS, emptyWorldState } from "../src/world/state.js";
import { WorldEngine } from "../src/world/engine.js";
import { entryAgencyIssues } from "../src/world/entry-agency.js";
import { buildRoleRoster } from "../src/compiler/role-roster.js";
import { characterGoalSchema, evaluateCharacterGoal } from "../src/world/actors.js";

function fixture() {
  const anchor = textAnchorForByteRange("src", Buffer.from("Someone waits."), 0, 7), derivation = { runId: "original", worker: "fixture", ontologyVersion: "entity-resolution-v1" };
  const mention = entityMentionSchema.parse({ version: 1, id: "someone", sourceId: "src", annotationType: "entity-mention", anchor,
    surface: "Someone", form: "nominal", kindCandidates: ["character"], confidence: 1, derivation: { ...derivation, ontologyVersion: "observation-v1" } });
  const prior = identityResolutionSchema.parse({ version: 1, id: "old-creation", sourceId: "src", mentionId: mention.id, status: "new-entity", entityId: "unknown",
    candidates: [{ entityId: "unknown", confidence: 0.99, basisMentionIds: [mention.id], evidenceAssertionIds: [], rationale: "Retained original claim" }], rationale: "Historical creation", derivation });
  const current = identityResolutionSchema.parse({ version: 1, id: "unresolved", sourceId: "src", mentionId: mention.id, status: "unresolved", candidates: [],
    supersedesResolutionId: prior.id, rationale: "Source does not establish stable identity", derivation });
  const entity = entitySchema.parse({ id: "unknown", kind: "character", canonicalName: "Someone", aliases: [], evidence: [{ span: {
    sourceId: anchor.sourceId, startByte: anchor.startByte, endByte: anchor.endByte, startLine: anchor.startLine, endLine: anchor.endLine, quoteHash: anchor.exactHash,
  }, strength: "explicit" }],
    identityConsumption: { version: 1, status: "unresolved", mode: "quarantined", sourceId: "src", mentionId: mention.id, resolutionId: current.id,
      resolutionRevisionHash: h(current), supersedesResolutionIds: [prior.id], rationale: "Retain history without confirmed world identity" } });
  const known = entitySchema.parse({ id: "ada", kind: "character", canonicalName: "Ada", aliases: [], evidence: [] });
  const fields = new Map(DEFAULT_STATE_FIELDS.map(s => [s.key, s]));
  return { entity, known, prior, current, mention, fields, entities: new Map([entity, known].map(e => [e.id, e])), stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS) };
}

it("binds unresolved consumption to the exact current revision and complete historical identity chain", () => {
  const f = fixture(), original = h(f);
  expect(validateIdentityConsumptionBinding(f.entity, [f.current], [f.mention], [f.prior])).toEqual([]);
  for (const current of [{ ...f.current, status: "resolved", entityId: f.entity.id }, { ...f.current, rationale: "changed" }, { ...f.current, mentionId: "another" }])
    expect(validateIdentityConsumptionBinding(f.entity, [current as any], [f.mention], [f.prior])).not.toHaveLength(0);
  expect(validateIdentityConsumptionBinding(f.entity, [f.current], [f.mention], [])).not.toHaveLength(0);
  expect(validateIdentityConsumptionBinding(f.entity, [f.current], [f.mention], [{ ...f.prior, entityId: f.known.id }])).not.toHaveLength(0);
  expect(h(f)).toBe(original);
});

it("blocks typed subject, precondition, state-reference and footprint consumption without treating labels as identity references", () => {
  const f = fixture();
  const payload = { actorId: "unknown", participants: ["unknown"],
    preconditions: [{ op: "fact-exists", entityId: "unknown", field: "character.alive" }],
    delta: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.inventory", value: ["unknown"] }] },
    action: { footprint: { reads: [{ entityId: "unknown", field: "character.alive" }], writes: [] } } };
  expect(identityConsumptionIssues(payload, f.entities, f.fields).map(i => i.path)).toEqual([
    "/actorId", "/participants/0", "/preconditions/0/entityId", "/delta/operations/0/value/0", "/action/footprint/reads/0/entityId",
  ]);
  expect(identityConsumptionIssues({ description: "unknown", object: { entityId: "unknown" }, evidence: [{ entityId: "unknown" }],
    delta: { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.plan", value: "unknown" }] } }, f.entities, f.fields)).toEqual([]);
  expect(() => f.stateSchema.validateOperation({ op: "set", entityId: "ada", field: "character.inventory", value: ["unknown"] }, f.entities)).toThrow("ENTITY_IDENTITY_CONSUMPTION_BLOCKED");
});

it("keeps the original roster candidate and mention while removing confirmed-identity play and goal authority", () => {
  const f = fixture(), { identityConsumption: _, ...original } = f.entity;
  const input = { sourceId: "src", sourceSha256: h("source"), unitIds: ["unit"], annotations: [f.mention] };
  const before = buildRoleRoster({ ...input, entities: [original], resolutions: [f.prior] });
  const after = buildRoleRoster({ ...input, entities: [f.entity], resolutions: [f.current] });
  expect(after.candidates.map(c => c.id)).toEqual(before.candidates.map(c => c.id));
  expect(after.candidates[0]).toMatchObject({ entityId: "unknown", identityStatus: "quarantined", mentionIds: [f.mention.id], resolutionIds: [f.current.id] });
  expect(after.subjectHash).not.toBe(before.subjectHash);
  expect(entryAgencyIssues("unknown", { participantPresence: [{ entityId: "unknown", mode: "physical" }] }, { entities: f.entities, processTemplates: new Map() })).toMatchObject([{ code: "ENTITY_IDENTITY_CONSUMPTION_BLOCKED" }]);
  const goal = characterGoalSchema.parse({ id: "retained-goal", actorId: "unknown", description: "wait", priority: 1, requiresKnowledge: [], evidence: f.entity.evidence,
    activation: { preconditions: [{ op: "fact-exists", entityId: "unknown", field: "character.alive" }], afterCanonicalEventIds: [] } });
  const state = emptyWorldState("head"); state.values.unknown = { "character.alive": true };
  const activation = evaluateCharacterGoal(goal, { state, knownClaimIds: new Set(), entities: f.entities });
  expect(activation.active).toBe(false); expect(activation.reasons.join(" ")).toContain("ENTITY_IDENTITY_CONSUMPTION_BLOCKED");
});

it("checks semantic, norm, spatial and viewpoint references while ignoring untyped literal contents", () => {
  const f = fixture(), id = f.entity.id;
  const value = {
    obligation: { debtorActorId: id, creditorActorId: id }, goal: { actorId: f.known.id, targetEntityIds: [id] },
    norm: { subjectActorId: id, beneficiaryActorId: id, byActorId: id, acknowledgedByActorId: id },
    template: { authorityEntityId: id, jurisdictionEntityIds: [id] },
    space: { fromLocationId: id, toLocationId: id, locationId: id, destinationEntityId: id },
    viewpoint: { focalActorId: id, viewpointActorId: id },
    agency: { peerEntityIds: [id], carrierEntityIds: [id] }, delivery: { recipientId: id }, relationship: { relationshipEntityId: id, targetEntityId: id },
    acquisition: { mode: "observed", field: "character.location", value: id },
  };
  expect(identityConsumptionIssues(value, f.entities, f.fields).map(i => i.path)).toEqual([
    "/obligation/debtorActorId", "/obligation/creditorActorId", "/goal/targetEntityIds/0",
    "/norm/subjectActorId", "/norm/beneficiaryActorId", "/norm/byActorId", "/norm/acknowledgedByActorId",
    "/template/authorityEntityId", "/template/jurisdictionEntityIds/0", "/space/fromLocationId", "/space/toLocationId",
    "/space/locationId", "/space/destinationEntityId", "/viewpoint/focalActorId", "/viewpoint/viewpointActorId",
    "/agency/peerEntityIds/0", "/agency/carrierEntityIds/0", "/delivery/recipientId", "/relationship/relationshipEntityId", "/relationship/targetEntityId", "/acquisition/value",
  ]);
  expect(identityConsumptionIssues({ object: { kind: "literal", value: { debtorActorId: id } },
    value: { actorId: id }, description: id, acquisition: { field: "character.plan", value: id } }, f.entities, f.fields)).toEqual([]);
});

it("follows contextual process/norm templates, source attributions and schema parameter domains", () => {
  const f = fixture(), id = f.entity.id;
  const catalog: any = {
    processTemplates: new Map([["shared", { preconditions: [{ op: "fact-exists", entityId: id, field: "character.alive" }] }]]),
    normTemplates: new Map([["shared", { authorityEntityId: id }]]),
    attributions: new Map([["statement", { holderEntityId: id }]]),
    actionSchemas: new Map([["choose", { parameters: [{ id: "target", valueType: "entity-ref", allowedValues: [id] },
      { id: "text", valueType: "string", allowedValues: [id] }] }]]),
  };
  expect(identityConsumptionIssues({ proposedProcesses: { operations: [{ templateId: "shared" }] },
    proposedNorms: { operations: [{ templateId: "shared" }] }, sourceAttributionId: "statement", schemaId: "choose" }, f.entities, f.fields, catalog)
    .map(i => i.path)).toEqual([
      "/proposedProcesses/operations/0/templateId/@processTemplates:shared/preconditions/0/entityId",
      "/proposedNorms/operations/0/templateId/@normTemplates:shared/authorityEntityId",
      "/sourceAttributionId/@attributions:statement/holderEntityId",
      "/schemaId/@actionSchemas:choose/parameters/0/allowedValues/0",
    ]);
});

it.each(["debtorActorId", "creditorActorId"] as const)("rejects quarantined %s in both genesis semantics and committed event proposals", async field => {
  const f = fixture(), root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-quarantined-semantics-"));
  try {
    const engine = new WorldEngine(root, { entities: f.entities, rules: new Map(), stateSchema: f.stateSchema });
    const obligation = { debtorActorId: f.known.id, creditorActorId: f.known.id, [field]: f.entity.id, kindId: "repay", description: "Repay a debt" };
    const projectionSeed = entryProjectionSeedSchema.parse({ version: 1, activeRuleIds: [], elapsedDays: 0,
      semantics: { version: 1, operations: [{ op: "create-obligation", obligation: { id: "debt", ...obligation } }] },
      processes: { version: 1, operations: [] }, norms: { version: 1, operations: [] } });
    await expect(engine.createBranch("bad-seed", "Bad seed", { version: 1, operations: [] }, undefined, undefined, undefined, [], {},
      { projectionSeed })).rejects.toThrow("ENTITY_IDENTITY_CONSUMPTION_BLOCKED");
    const head = await engine.createBranch("main", "Main");
    const result = await engine.commitProposal({ proposalId: "bad-debt", branchId: "main", expectedParentCommit: head,
      source: "player", actorId: f.known.id, title: "Create debt", proposedTime: { kind: "unknown" }, participants: [f.known.id],
      preconditions: [], proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence: [],
      proposedSemantics: { version: 1, operations: [{ op: "create-obligation", localRef: "local-debt", obligation }] } });
    expect(result.report.errors.some(i => i.code === "ENTITY_IDENTITY_CONSUMPTION_BLOCKED")).toBe(true);
    expect(result.newHead).toBe(head);
    expect((await engine.projections.project(head)).semantics.obligations).toEqual({});
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("blocks transitive event/knowledge dependencies and schema-bound entity parameters without guessing text references", () => {
  const f = fixture();
  const catalog: any = { events: new Map([["opening", { participants: ["unknown"], causalParents: ["later"] }], ["later", { participants: ["ada"], causalParents: ["opening"] }]]),
    claims: new Map([["heard", { propositionId: "content" }]]), propositions: new Map([["content", { subject: "unknown", predicate: "waiting", object: "unknown" }]]),
    actionSchemas: new Map([["speak", { parameters: [{ id: "target", valueType: "entity-ref" }, { id: "text", valueType: "string" }] }]]) };
  expect(identityConsumptionIssues({ causalParents: ["later"] }, f.entities, f.fields, catalog).some(i => i.path?.endsWith("/participants/0"))).toBe(true);
  expect(identityConsumptionIssues({ requiresKnowledge: ["heard"] }, f.entities, f.fields, catalog).some(i => i.path?.endsWith("/subject"))).toBe(true);
  const parameters = (target: string) => ({ action: { schemaId: "speak", parameters: { target, text: "unknown" } } });
  expect(identityConsumptionIssues(parameters("unknown"), f.entities, f.fields, catalog).map(i => i.path)).toEqual(["/action/parameters/target"]);
  expect(identityConsumptionIssues(parameters("ada"), f.entities, f.fields, catalog)).toEqual([]);
  const goal = characterGoalSchema.parse({ id: "dependent", actorId: "ada", description: "wait after opening", priority: 1, requiresKnowledge: [], evidence: f.entity.evidence,
    activation: { preconditions: [], afterCanonicalEventIds: ["opening"] } });
  expect(evaluateCharacterGoal(goal, { state: emptyWorldState("head"), knownClaimIds: new Set(), realizedCanonicalEventIds: new Set(["opening"]),
    entities: f.entities, identityCatalog: catalog }).active).toBe(false);
});

it("rejects initial truth and branch writes involving quarantined identity while keeping the committed head unchanged", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-identity-consumption-")), f = fixture();
  try {
    const engine = new WorldEngine(root, { entities: f.entities, rules: new Map(), stateSchema: f.stateSchema });
    await expect(engine.createBranch("bad", "Bad", { version: 1, operations: [{ op: "set", entityId: "unknown", field: "character.alive", value: true }] })).rejects.toThrow("ENTITY_IDENTITY_CONSUMPTION_BLOCKED");
    const head = await engine.createBranch("main", "Main", { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: true }] });
    const proposal: EventProposal = { proposalId: "quarantined-write", branchId: "main", expectedParentCommit: head, source: "player", actorId: "ada", title: "Unknown subject",
      proposedTime: { kind: "unknown" }, participants: ["ada"], preconditions: [{ op: "fact-exists", entityId: "unknown", field: "character.alive" }],
      proposedDelta: { version: 1, operations: [] }, causalParents: [], evidence: [] };
    const result = await engine.commitProposal(proposal);
    expect(result.report.accepted).toBe(false); expect(result.newHead).toBe(head);
    expect(result.report.errors.some(i => i.code === "ENTITY_IDENTITY_CONSUMPTION_BLOCKED")).toBe(true);
    expect((await engine.projector.project(head)).values.unknown).toBeUndefined();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("distinguishes a grounded anonymous local actor from resolved cross-identity without lifting quarantine implicitly", async () => {
  const f = fixture(), before = h(f.current), root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-local-referent-"));
  try {
    const local = entitySchema.parse({ ...f.entity, identityConsumption: { ...f.entity.identityConsumption, mode: "source-local",
      referentScope: { mentionIds: [f.mention.id], crossIdentity: "unresolved", distinctness: "unasserted" } } });
    expect(validateIdentityConsumptionBinding(local, [f.current], [f.mention], [f.prior])).toEqual([]);
    const entities = new Map([[local.id, local], [f.known.id, f.known]]);
    const entry = { participantPresence: [{ entityId: local.id, mode: "physical" as const }] };
    expect(entryAgencyIssues(local.id, entry, { entities, processTemplates: new Map() })).toEqual([]);
    expect(entryAgencyIssues(local.id, { participantPresence: [{ entityId: local.id, mode: "dream" }] }, { entities })).not.toEqual([]);
    expect(entryAgencyIssues(local.id, entry, { entities: f.entities })).toMatchObject([{ code: "ENTITY_IDENTITY_CONSUMPTION_BLOCKED" }]);
    const engine = new WorldEngine(root, { sourceId: "src", entities, rules: new Map(), stateSchema: f.stateSchema });
    const head = await engine.createBranch("local", "Anonymous viewpoint", { version: 1, operations: [
      { op: "set", entityId: local.id, field: "character.alive", value: true },
      { op: "set", entityId: local.id, field: "character.momentum", value: 0 },
    ] });
    const state = await engine.projector.project(head);
    expect(state.values[local.id]).toMatchObject({ "character.alive": true, "character.momentum": 0 });
    expect(state.values[f.known.id]).toBeUndefined();
    expect(local.identityConsumption).toMatchObject({ status: "unresolved", referentScope: { distinctness: "unasserted" } });
    expect(h(f.current)).toBe(before);
    const roster = buildRoleRoster({ sourceId: "src", sourceSha256: h("source"), unitIds: ["unit"], annotations: [f.mention], entities: [local], resolutions: [f.current] });
    expect(roster.candidates).toHaveLength(1); expect(roster.candidates[0]).toMatchObject({ entityId: local.id, identityStatus: "source-local" });
    const invalid = entitySchema.parse({ ...local, identityConsumption: { ...local.identityConsumption, mode: "source-local",
      referentScope: { mentionIds: [f.mention.id, "dream-role"], crossIdentity: "unresolved", distinctness: "unasserted" } } });
    expect(validateIdentityConsumptionBinding(invalid, [f.current], [f.mention], [f.prior])).toMatchObject([{ code: "ENTITY_IDENTITY_CONSUMPTION_INVALID" }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("requires separate exact source support for local-referent scope and cannot certify it from a presence label", () => {
  const f = fixture(), local = entitySchema.parse({ ...f.entity, identityConsumption: { ...f.entity.identityConsumption, mode: "source-local",
    referentScope: { mentionIds: [f.mention.id], crossIdentity: "unresolved", distinctness: "unasserted" } } });
  expect(validateSourceLocalIdentityEvidence(local, []).map(i => i.path)).toEqual(["/identityConsumption/mode", "/identityConsumption/referentScope"]);
  const assertions: any[] = ["/identityConsumption/mode", "/identityConsumption/referentScope"].map(jsonPointer => ({
    target: { artifactKind: "entity", artifactId: local.id, jsonPointer }, relation: "supports", strength: "explicit", anchors: [f.mention.anchor],
  }));
  expect(validateSourceLocalIdentityEvidence(local, assertions)).toEqual([]);
  expect(validateSourceLocalIdentityEvidence(local, assertions.map(a => ({ ...a, strength: "weak-inference" })))).toHaveLength(2);
  expect(validateSourceLocalIdentityEvidence(local, assertions.map(a => ({ ...a, anchors: [{ ...f.mention.anchor, sourceId: "another" }] })))).toHaveLength(2);
});

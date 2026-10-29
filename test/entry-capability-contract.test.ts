import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { assessEntryState, groundedEntryActorIds } from "../src/world/entry-contract.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry, emptyWorldState, applyStateDelta, evaluatePredicateTruth } from "../src/world/state.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { CompilerCommitService, CompilerValidator } from "../src/compiler/validator.js";
import { WorldEngine } from "../src/world/engine.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { contentHash } from "../src/world/canonical.js";
import { loadWorldContext } from "../src/world/context.js";
import { entryActionDependencyIssues, entryActionWitnessIssues, probeEntryAction } from "../src/compiler/entry-action-probe.js";
import { probeEntryDriver } from "../src/compiler/entry-driver-probe.js";
import { diagnoseEntryRepair } from "../src/compiler/entry-repair-diagnostics.js";
import { projectActorVisibleState } from "../src/world/actor-visible.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { selfActionFixture } from "./helpers/entry-action.js";
import type { Entity, EvidenceAssertion, StateOperation } from "../src/world/model.js";
import { ActorModelStore, deterministicActorProposalSource, type CharacterGoal } from "../src/world/actors.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const entity: Entity = { id: "local-actor", kind: "character", canonicalName: "Unnamed person", aliases: [], evidence: [] };
const catalog = { entities: new Map([[entity.id, entity]]) };
const set = (field: string, value: string | boolean | number | null): StateOperation => ({ op: "set", entityId: entity.id, field, value });
const entry = (operations: StateOperation[]) => ({ participantPresence: [{ entityId: entity.id, mode: "physical" as const }], delta: { version: 1 as const, operations } });

it.each([
  [set("character.plan", null)],
  [set("character.plan", "")],
  [set("character.plan", "wait"), { op: "unset", entityId: entity.id, field: "character.plan" }],
  [set("character.plan", "wait"), set("character.alive", false)],
  [{ op: "adjust-number", entityId: entity.id, field: "character.momentum", amount: 1 }],
  [set("character.posture", "an unsupported posture")],
  [set("character.plan", true)],
] satisfies StateOperation[][])("rejects ungrounded final entry state %#", (...operations) => {
  expect(assessEntryState(entity.id, entry(operations as StateOperation[]), catalog).state).toBe("blocked");
});

it("grounds a local bodily state without inventing identity, location or intention, independent of off-scene characters", () => {
  const value = entry([set("character.posture", "sitting"), set("character.breathing", "labored")]);
  const first = assessEntryState(entity.id, value, catalog);
  const expanded = { entities: new Map([...catalog.entities, ["elsewhere", { ...entity, id: "elsewhere", canonicalName: "Someone else" }]]) };
  expect(assessEntryState(entity.id, value, expanded)).toEqual(first);
  expect(first).toMatchObject({ state: "grounded", actionProof: "required", fields: ["character.breathing", "character.posture"] });
  expect(groundedEntryActorIds({ ...value, participantPresence: [{ entityId: entity.id, mode: "dream" }] }, catalog).size).toBe(0);
  const registry = new StateSchemaRegistry(DEFAULT_STATE_FIELDS);
  const state = applyStateDelta(emptyWorldState("cut"), value.delta, registry, catalog.entities, new Map());
  expect(state.values[entity.id]).toEqual({ "character.posture": "sitting", "character.breathing": "labored" });
  expect(evaluatePredicateTruth(state, { op: "not", item: { op: "fact-equals", entityId: entity.id, field: "character.location", value: "room" } }, registry)).toBe("unknown");
  expect(projectActorVisibleState(state.values[entity.id]!, registry, "self")).toEqual(state.values[entity.id]);
  expect(projectActorVisibleState(state.values[entity.id]!, registry, "public")).toEqual({});
});

it("diagnoses scope conflicts and consumed stages without granting new authority or claiming source impossibility", () => {
  const value = entry([set("character.alive", true)]);
  const input = { sourceId: "source", entry: value, catalog, catalogScope: "frozen-repair-scope" as const };
  const locked = diagnoseEntryRepair({ ...input, writablePointers: ["/evidence"], consumed: true });
  expect(locked).toMatchObject({ executionAuthority: false, certificationGranted: false, dispatch: "blocked", wholeSourceSatisfiability: "not-established" });
  expect(locked.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "scope-conflict", pointer: "/delta", certainty: "proven" }), expect.objectContaining({ kind: "consumed-stage" })]));
  const scoped = diagnoseEntryRepair({ ...input, writablePointers: ["/delta"] });
  expect(scoped.gaps.some(g => g.kind === "scope-conflict")).toBe(false);
  expect(scoped.gaps).toContainEqual(expect.objectContaining({ kind: "source-or-representation-review", certainty: "review-required" }));
  expect(diagnoseEntryRepair({ ...input, writablePointers: ["/evidence"], consumed: true })).toEqual(locked);
});

it("retains local unresolved identity but rejects quarantined consumption", () => {
  const basis = { version: 1 as const, status: "unresolved" as const, sourceId: "source", mentionId: "mention", resolutionId: "local-resolution",
    resolutionRevisionHash: "a".repeat(64), supersedesResolutionIds: ["former-resolution"], rationale: "Only this source referent is established" };
  const local: Entity = { ...entity, identityConsumption: { ...basis, mode: "source-local", referentScope: { mentionIds: ["mention"], crossIdentity: "unresolved", distinctness: "unasserted" } } };
  const value = entry([set("character.breathing", "labored")]);
  expect(assessEntryState(local.id, value, { entities: new Map([[local.id, local]]) }).state).toBe("grounded");
  const quarantined: Entity = { ...entity, identityConsumption: { ...basis, mode: "quarantined" } };
  expect(assessEntryState(local.id, value, { entities: new Map([[local.id, quarantined]]) }).issues).toContainEqual(expect.objectContaining({ code: "ENTITY_IDENTITY_CONSUMPTION_BLOCKED" }));
  expect(local.aliases).toEqual([]);
});

it.each(["candidateAction", "actionPatterns"] as const)("proves an executable %s without an explicit invocation or installed schema", async slot => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-entry-goal-")); roots.push(root);
  const source = await createEvidenceFixture(root, "Hero decides to wait.\n"), canon = new CanonicalModelStore(root);
  const evidence = source.evidence("Hero decides to wait.");
  await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence });
  await canon.putClaim({ id: "old-detail", subject: "hero", predicate: "waits", object: true, epistemicType: "explicit-fact", evidence });
  const action = { title: "Decide to wait", preconditions: [], proposedDelta: { version: 1 as const,
    operations: [{ op: "set" as const, entityId: "hero", field: "character.plan", value: "wait" }] } };
  const goal: CharacterGoal = { id: "wait-goal", actorId: "hero", description: "Wait", priority: 0.5, requiresKnowledge: [], evidence,
    activation: { preconditions: [], afterCanonicalEventIds: [] },
    ...(slot === "candidateAction" ? { candidateAction: action } : { actionPatterns: [action] }) };
  const { context } = await loadWorldContext(root);
  const timedGoal: CharacterGoal = { ...goal, id: "continue-goal", priority: 1, actionPatterns: [],
    candidateAction: { ...action, title: "Continue deciding for a minute", timeAdvance: { amount: 1, unit: "minute" },
      proposedDelta: { version: 1, operations: [] },
      proposedKnowledge: { version: 1, operations: [{ op: "forget", actorId: "hero", claimId: "old-detail" }] } } };
  context.actorGoals = [timedGoal, goal];
  const engine = new WorldEngine(root, context), head = await engine.createBranch("probe", "Probe", { version: 1, operations: [
    { op: "set", entityId: "hero", field: "character.alive", value: true },
    { op: "set", entityId: "hero", field: "character.plan", value: "decide" },
  ] }, undefined, source.source.id, undefined, evidence, {}, { participantPresence: [{ entityId: "hero", mode: "physical" }] });
  const candidates = await deterministicActorProposalSource(engine, new ActorModelStore(root))({ branchId: "probe", commitId: head, maxActors: 1 });
  expect(candidates).toHaveLength(1);
  expect(candidates[0]!.goalId).toBe(timedGoal.id);
  expect(candidates[0]!.proposal.action).toBeUndefined();
  const preview = await engine.previewProposal(candidates[0]!.proposal);
  expect(preview.report.accepted).toBe(true);
  expect(preview.progressCertificate?.channels).toContain("time");
  expect(preview.progressCertificate?.channels).not.toContain("state");
  const scope = { sourceId: source.source.id, subjectSnapshotHash: contentHash(goal), entryCutHash: contentHash(head), actorId: "hero" };
  const witness = await probeEntryAction(engine, root, { ...scope, branchId: "probe", head });
  expect(witness.origin).toMatchObject({ kind: "compiled-goal", id: goal.id, revisionHash: contentHash(goal) });
  expect(witness.event.action).toMatchObject({ lane: "ad-hoc", actionKindId: "act", description: action.title });
  expect(entryActionWitnessIssues(witness, scope)).toEqual([]);
  expect(entryActionDependencyIssues(witness, { goals: [goal], actionSchemas: [] })).toEqual([]);
  expect((await engine.projector.project(witness.resultingHead)).values.hero?.["character.plan"]).toBe("wait");
  const altered = structuredClone(witness);
  altered.event.action = { lane: "ad-hoc", actionKindId: "wait", description: "Wait", footprint: { reads: [], writes: [], resources: [] } };
  expect(entryActionDependencyIssues(altered, { goals: [goal], actionSchemas: [] })).toContain("ENTRY_ACTION_ORIGIN_MISMATCH");
  expect(entryActionDependencyIssues(witness, { goals: [{ ...goal, candidateAction: { ...action, title: "Changed action" } }], actionSchemas: [] })).toContain("ENTRY_ACTION_DEPENDENCY_STALE");
  await expect(probeEntryAction(engine, root, { ...scope, branchId: "probe", head: witness.resultingHead })).rejects.toThrow("ENTRY_ACTION_UNPROVEN");
});

it.each([
  { actorId: "anonymous", text: "An unnamed person lies awake and can sit up.\n", name: "An unnamed person" },
  { actorId: "traveller", text: "旅人清醒地躺着，可以坐起。\n", name: "旅人" },
])("compiles, executes and replays qualitative entry state for $actorId with no location or plan", async ({ actorId, text, name }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-entry-contract-")); roots.push(root);
  const source = await createEvidenceFixture(root, text), canon = new CanonicalModelStore(root);
  const proposals = new CompilerProposalService(root), commits = new CompilerCommitService(root);
  await proposals.submit("entity", { proposalId: "actor", payload: { id: actorId, canonicalName: name, kind: "character", aliases: [], evidence: source.evidence(name) }, generatedBy: { worker: "fixture" } });
  expect((await commits.accept("entity", "actor")).accepted).toBe(true);
  const delta = { version: 1 as const, operations: [
    { op: "set" as const, entityId: actorId, field: "character.alive", value: true },
    { op: "set" as const, entityId: actorId, field: "character.posture", value: "lying" },
  ] };
  const initial = { version: 1 as const, participantPresence: [{ entityId: actorId, mode: "physical" as const }], delta, evidence: source.evidence(text.trim()) };
  const input = { proposalId: "opening", payload: initial, generatedBy: { worker: "fixture" } };
  await expect(proposals.submit("initial-world", input)).rejects.toThrow("BODILY_STATE_EVIDENCE_REQUIRED");
  const assertion: EvidenceAssertion = { version: 1, id: "posture-proof", derivation: { runId: "fixture", worker: "fixture", ontologyVersion: "evidence-v1" }, target: { artifactKind: "initial-world", artifactId: "initial-world", jsonPointer: "/delta/operations/1" },
    relation: "supports", strength: "explicit", anchors: [textAnchorForByteRange(source.source.id, Buffer.from(text), 0, Buffer.byteLength(text.trim()))] };
  await proposals.submit("initial-world", { ...input, evidenceAssertions: [assertion] });
  expect((await commits.accept("initial-world", "opening")).accepted).toBe(true);
  const baseline = await new InitialWorldStore(root).get();
  const validation = new CompilerValidator(canon);
  expect((await validation.validate("initial-world", initial)).accepted).toBe(true);
  await canon.putEntity({ id: "off-scene", kind: "character", canonicalName: "Other", aliases: [], evidence: source.evidence(name) });
  expect((await validation.validate("initial-world", initial)).accepted).toBe(true);
  await canon.putActionSchema(selfActionFixture("character.posture", "lying", "sitting"));
  const { context } = await loadWorldContext(root);
  const engine = new WorldEngine(root, context), head = await engine.createBranch("probe", "Probe", delta, undefined, source.source.id,
    undefined, initial.evidence, {}, { participantPresence: initial.participantPresence });
  const scope = { sourceId: source.source.id, subjectSnapshotHash: contentHash(initial), entryCutHash: contentHash(delta), actorId };
  const objectFiles = () => fs.readdir(path.join(engine.objects.root, "objects"), { recursive: true }).then(files => files.sort());
  const beforeObjects = await objectFiles();
  const preview = await engine.previewProposal({ proposalId: "preview-posture", branchId: "probe", expectedParentCommit: head, actorId, source: "player",
    title: "Sit up", participants: [actorId], proposedTime: { kind: "unknown" }, preconditions: [], causalParents: [], evidence: [],
    proposedDelta: { version: 1, operations: [{ op: "set", entityId: actorId, field: "character.posture", value: "sitting" }] },
    action: { lane: "schema-bound", schemaId: "fixture-self-action", roleBindings: [{ roleId: "actor", entityIds: [actorId] }], parameters: {} } });
  expect(preview.report.accepted).toBe(true);
  expect(preview.progressCertificate?.channels).toContain("state");
  expect(await objectFiles()).toEqual(beforeObjects);
  expect(await engine.branches.readHead("probe")).toBe(head);
  const witness = await probeEntryAction(engine, root, { ...scope, branchId: "probe", head });
  expect(entryActionWitnessIssues(witness, scope)).toEqual([]);
  const mechanisms = { goals: [], actionSchemas: [selfActionFixture("character.posture", "lying", "sitting")] };
  expect(entryActionDependencyIssues(witness, mechanisms)).toEqual([]);
  const wrongOrigin = structuredClone(witness); wrongOrigin.event.action = { lane: "ad-hoc", actionKindId: "wait", description: "Wait", footprint: { reads: [], writes: [], resources: [] } };
  expect(entryActionDependencyIssues(wrongOrigin, mechanisms)).toContain("ENTRY_ACTION_ORIGIN_MISMATCH");
  expect(witness.event.action).toMatchObject({ lane: "schema-bound", schemaId: "fixture-self-action" });
  expect((await engine.projector.project(witness.resultingHead)).values[actorId]).toEqual({ "character.alive": true, "character.posture": "sitting" });
  expect(contentHash(await engine.projections.project(witness.resultingHead))).toBe(contentHash(await new WorldEngine(root, context).projections.project(witness.resultingHead, { fresh: true, useCheckpoints: false })));
  expect(await new InitialWorldStore(root).get()).toEqual(baseline);
  const tampered = structuredClone(witness); tampered.effects.stateDelta!.operations = [];
  expect(entryActionWitnessIssues(tampered, scope)).toContain("ENTRY_ACTION_EFFECT_HASH_MISMATCH");
  expect(entryActionWitnessIssues(witness, { ...scope, entryCutHash: contentHash("changed cut") })).toContain("ENTRY_ACTION_SCOPE_STALE");
  const old = structuredClone(witness); old.contractVersion = "old";
  expect(entryActionWitnessIssues(old, scope)).toContain("ENTRY_ACTION_CONTRACT_STALE");
  // Changed premise remains unknown; the probe must not choose a default posture.
  const unknown = await engine.createBranch("unknown", "Unknown posture", { version: 1, operations: [delta.operations[0]!] }, undefined, source.source.id);
  await expect(probeEntryAction(engine, root, { ...scope, branchId: "unknown", head: unknown })).rejects.toThrow("ENTRY_ACTION_UNPROVEN");
  expect(await engine.branches.readHead("unknown")).toBe(unknown);
  await expect(probeEntryAction(engine, root, { ...scope, branchId: "probe", head: witness.resultingHead })).rejects.toThrow("ENTRY_ACTION_UNPROVEN");
  await expect(probeEntryDriver(engine, root, { ...scope, branchId: "unknown", head: unknown })).rejects.toThrow("ENTRY_DRIVER_UNPROVEN");
  const undisclosed = new WorldEngine(root, { ...context, actionSchemas: new Map([["fixture-self-action", { ...mechanisms.actionSchemas[0]!, visibility: "knowledge", knownByClaimIds: ["unknown-method"] }]]) });
  const hiddenHead = await undisclosed.createBranch("hidden", "Unknown mechanism", delta, undefined, source.source.id);
  await expect(probeEntryAction(undisclosed, root, { ...scope, branchId: "hidden", head: hiddenHead })).rejects.toThrow("ENTRY_ACTION_UNPROVEN");
  expect(await undisclosed.branches.readHead("hidden")).toBe(hiddenHead);
  const goal: CharacterGoal = { id: "later-goal", actorId, description: "Sit up after the later boundary", priority: 1, requiresKnowledge: [], evidence: initial.evidence,
    activation: { preconditions: [{ op: "elapsed-days-gte", days: 1 }], afterCanonicalEventIds: [] },
    candidateAction: { title: "Sit up", preconditions: [], action: witness.event.action!, proposedDelta: witness.effects.stateDelta! } };
  for (const future of [true, false]) {
    const branchId = future ? "future-goal" : "active-goal";
    const goals = [{ ...goal, activation: { ...goal.activation!, preconditions: future ? goal.activation!.preconditions : [] } }];
    const goalEngine = new WorldEngine(root, { ...context, actorGoals: goals });
    const goalHead = await goalEngine.createBranch(branchId, branchId, delta, undefined, source.source.id);
    const proof = await probeEntryAction(goalEngine, root, { ...scope, branchId, head: goalHead });
    expect(proof.origin.kind).toBe(future ? "self-schema" : "compiled-goal");
    expect(entryActionDependencyIssues(proof, { ...mechanisms, goals })).toEqual([]);
  }
});

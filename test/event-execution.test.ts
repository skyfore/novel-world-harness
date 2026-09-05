import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { actionSchemaSchema } from "../src/world/action-ontology.js";
import { eventExecutionSchema, validateEventExecutions } from "../src/world/event-execution.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { WorldContextStore } from "../src/world/context.js";
import { CompilerProposalService, validateCompilerProposalClosure } from "../src/compiler/proposals.js";
import { CompilerValidator } from "../src/compiler/validator.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { canonicalEventSchema } from "../src/world/model.js";
import { compilerToolAllowedInSemanticStage } from "../src/compiler/proposal-tools.js";
import { deriveAdHocAction } from "../src/world/action-invocation.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it("links a later executable proposal to an earlier immutable semantic event and freezes the linkage in replay context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-event-link-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Giver gives Recipient a coin. Giver gives Recipient another coin.\n"), evidence = fixture.evidence("Giver gives Recipient a coin.");
  const canon = new CanonicalModelStore(root);
  for (const id of ["giver", "recipient"]) await canon.putEntity({ id, kind: "character", canonicalName: id === "giver" ? "Giver" : "Recipient", aliases: [], evidence });
  const first = canonicalEventSchema.parse({ id: "first", title: "Giver gives a coin", participants: ["giver", "recipient"], participantPresence: [{ entityId: "giver", mode: "physical" }, { entityId: "recipient", mode: "physical" }], storyTime: { kind: "ordinal", label: "first", orderHint: 1 }, preconditions: [], observedOutcome: { version: 1, operations: [{ op: "adjust-number", entityId: "giver", field: "character.wealth", amount: -1 }, { op: "adjust-number", entityId: "recipient", field: "character.wealth", amount: 1 }] }, evidence, causalParents: [], confidence: 1 });
  await canon.putEvent(first);
  await canon.putEvent({ ...first, id: "second", storyTime: { kind: "ordinal", label: "second", orderHint: 2 } });
  for (const eventId of ["first", "second"]) for (const id of ["giver", "recipient"]) await canon.putEventParticipation({ id: `${eventId}-${id}`, eventId, entityId: id, role: id === "giver" ? "agent" : "beneficiary", presence: "physical", confidence: 1, evidence });
  const action = actionSchemaSchema.parse({ ontologyVersion: "action-schema-v1", id: "give-coin", name: "Give a coin", initiatorRoleId: "giver", roles: ["giver", "recipient"].map((id) => ({ id, label: id, allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 })), parameters: [], preconditions: [], stateEffects: [
    { op: "adjust-number", entity: { kind: "role", roleId: "giver" }, field: "character.wealth", amount: -1 }, { op: "adjust-number", entity: { kind: "role", roleId: "recipient" }, field: "character.wealth", amount: 1 },
  ], effectEnvelope: { maxStateOperations: 2, allowedStateFields: ["character.wealth"], allowsKnowledge: false, allowsTimeAdvance: false, allowsSceneTransition: false }, induction: { kind: "source-pattern", supportingEventIds: ["first", "second"] }, evidence });
  await canon.putActionSchema(action);
  const binding = eventExecutionSchema.parse({ id: "first-execution", canonicalEventId: "first", actorId: "giver", action: { lane: "schema-bound", schemaId: action.id, roleBindings: [{ roleId: "giver", entityIds: ["giver"] }, { roleId: "recipient", entityIds: ["recipient"] }], parameters: {} }, evidence });
  const proposal = await new CompilerProposalService(root).submit("event-execution", { proposalId: "link-first", payload: binding, generatedBy: { worker: "test" } });
  expect(proposal).toBeDefined();
  expect(await validateCompilerProposalClosure(root, ["link-first"], fixture.source.id)).toEqual([]);
  expect((await new CompilerValidator(canon).validate("event-execution", binding)).errors).toEqual([]);
  await canon.putEventExecution(binding);
  const entry = eventExecutionSchema.parse({ id: "recipient-entry", canonicalEventId: "first", actorId: "recipient", evidence, entryCheckpoint: {
    actorId: "recipient", readerSetup: "Recipient is waiting before the first gift.", actorObservation: "Giver is in front of you.", participantPresence: [{ entityId: "recipient", mode: "physical" }],
    delta: { version: 1, operations: [{ op: "set", entityId: "recipient", field: "character.alive", value: true }, { op: "set", entityId: "recipient", field: "character.plan", value: "consider the gift" }] },
    projectionSeed: { version: 1, elapsedDays: 7, activeRuleIds: [], semantics: { version: 1, operations: [] }, processes: { version: 1, operations: [] }, norms: { version: 1, operations: [] } },
  } });
  expect((await new CompilerValidator(canon).validate("event-execution", entry)).errors).toEqual([]);
  await canon.putEventExecution(entry);
  const contexts = new WorldContextStore(root), frozen = await contexts.captureCurrent(fixture.source.id);
  expect(frozen.events!.get("first")!.action).toEqual(binding.action);
  expect((await canon.getEvent("first")).action).toBeUndefined();
  expect((await canon.getEvent("first")).characterEntryCheckpoints).toBeUndefined();
  expect(frozen.events!.get("first")!.characterEntryCheckpoints?.[0]?.projectionSeed?.elapsedDays).toBe(7);
  await canon.removeCurrent("event-executions", binding.id);
  expect((await contexts.load(frozen.canonicalSnapshotHash!)).events!.get("first")!.action).toEqual(binding.action);
  const loaded = await new CompilerValidator(canon).loadCatalog();
  const catalog = { ...loaded, participations: [...loaded.eventParticipations.values()] };
  const adHoc = { ...first, action: deriveAdHocAction({ kind: "give", description: first.title, delta: first.observedOutcome, preconditions: [] }) };
  expect(validateEventExecutions([binding], { ...catalog, events: new Map(catalog.events).set(first.id, adHoc) })).toEqual([]);
  expect(validateEventExecutions([{ ...binding, actorId: "recipient" }], catalog)).toContainEqual(expect.objectContaining({ code: "ACTION_INITIATOR_MISMATCH" }));
  expect(validateEventExecutions([binding, { ...binding, id: "duplicate" }], catalog)).toContainEqual(expect.objectContaining({ code: "EVENT_EXECUTION_DUPLICATED" }));
  expect(validateEventExecutions([entry, { ...entry, id: "duplicate-entry" }], catalog)).toContainEqual(expect.objectContaining({ code: "EVENT_ENTRY_DUPLICATED" }));
  expect(compilerToolAllowedInSemanticStage("propose_event_execution", "executable")).toBe(true);
  expect(compilerToolAllowedInSemanticStage("propose_event_execution", "semantic")).toBe(false);
});

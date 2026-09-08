import crypto from "node:crypto";
import { expect, it } from "vitest";
import { evaluateSceneCapabilities, type SceneReviewCatalog } from "../src/eval/scene-capabilities.js";
import { canonicalEventSchema, entitySchema, eventParticipationSchema, type StateDelta } from "../src/world/model.js";
import { actionSchemaSchema } from "../src/world/action-ontology.js";
import { eventExecutionSchema } from "../src/world/event-execution.js";
import { normTemplateSchema } from "../src/world/norm-ontology.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { giftSchema, giftSilverKey, moneyTransferSchema, transferThree } from "./helpers/actions.js";

const bytes = Buffer.from("Hero gives Mo Yan the key. The gate is open. Permission lasts one day.");
const sourceId = "scene-source", anchor = textAnchorForByteRange(sourceId, bytes, 0, bytes.length);
const evidence = [{ span: { sourceId, startByte: anchor.startByte, endByte: anchor.endByte, startLine: anchor.startLine, endLine: anchor.endLine, quoteHash: anchor.exactHash }, strength: "explicit" as const }];
const empty: StateDelta = { version: 1, operations: [] };
const gift: StateDelta = { version: 1, operations: [{ op: "set", entityId: "silver-key", field: "artifact.owner", value: "mo-yan" }] };
const basis = { id: "case", scene: "A source-reviewed scene", rationale: "Independent expected transition", evidence: [anchor] };
function catalog(): SceneReviewCatalog {
  const entities = ["hero", "mo-yan", "rival", "silver-key", "gate"].map((id) => entitySchema.parse({ id, kind: ["silver-key", "gate"].includes(id) ? "artifact" : "character", canonicalName: id, aliases: [], evidence }));
  return { entities: new Map(entities.map((entity) => [entity.id, entity])), events: new Map(), eventParticipations: new Map(), eventExecutions: new Map(),
    actionSchemas: new Map([[giftSchema.id, giftSchema], [moneyTransferSchema.id, moneyTransferSchema]]), normTemplates: new Map(), rules: new Map(), claims: new Map(), propositions: new Map(), attributions: new Map() };
}
function event(id: string, delta = empty) {
  return canonicalEventSchema.parse({ id, title: id, participants: ["hero", "mo-yan", "silver-key"], storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: delta, evidence, causalParents: [], confidence: 1 });
}
function review(c: SceneReviewCatalog, cases: unknown[]) {
  return evaluateSceneCapabilities({ version: 1, sourceId, sourceSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    review: { method: "independent-source-review", reviewer: "source-fixture-author", reviewedAt: "2026-09-08T00:00:00Z", auditRef: "test-source-spec" }, cases }, bytes, c);
}
const eventCase = { ...basis, kind: "event-effects", eventId: "gift", initiatorId: "hero", requiresMechanism: true, expectation: { kind: "delta", delta: gift } };

it("rejects a formally consistent empty event/schema against an independent nonempty source expectation", () => {
  const c = catalog();
  c.events.set("gift", event("gift"));
  c.actionSchemas.set(giftSchema.id, actionSchemaSchema.parse({ ...giftSchema, stateEffects: [], effectEnvelope: { ...giftSchema.effectEnvelope, allowedStateFields: [], maxStateOperations: 0 } }));
  c.eventParticipations.set("agent", eventParticipationSchema.parse({ id: "agent", eventId: "gift", entityId: "hero", role: "agent", confidence: 1, evidence }));
  c.eventExecutions!.set("exec", eventExecutionSchema.parse({ id: "exec", canonicalEventId: "gift", actorId: "hero", action: giftSilverKey, evidence }));
  const result = review(c, [eventCase]);
  expect(result.cases[0]!.observations.formalBindingIssues).toEqual([]);
  expect(result.verified).toBe(false);
  expect(result.cases[0]!.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["SCENE_SOURCE_OUTCOME_MISSING", "SCENE_SOURCE_EFFECT_UNBOUND"]));
  expect(result.repairTasks.map((task) => task.stage)).toEqual(expect.arrayContaining(["semantic", "executable"]));
  expect(c.events.get("gift")!.observedOutcome).toEqual(empty);
});

it("routes an experiencer/initiator mismatch back to semantic repair, then accepts a supported binding", () => {
  const c = catalog(); c.events.set("gift", event("gift", gift));
  const part = eventParticipationSchema.parse({ id: "role", eventId: "gift", entityId: "hero", role: "experiencer", confidence: 1, evidence });
  c.eventParticipations.set(part.id, part);
  c.eventExecutions!.set("exec", eventExecutionSchema.parse({ id: "exec", canonicalEventId: "gift", actorId: "hero", action: giftSilverKey, evidence }));
  expect(review(c, [eventCase]).repairTasks).toContainEqual(expect.objectContaining({ stage: "semantic", artifactIds: ["gift", "role"] }));
  c.eventParticipations.set(part.id, { ...part, role: "agent" });
  expect(review(c, [eventCase]).verified).toBe(true);
  c.events.set("gift", event("gift", { version: 1, operations: [...gift.operations, { op: "set", entityId: "silver-key", field: "artifact.owner", value: "hero" }] }));
  expect(review(c, [eventCase]).cases[0]!.issues).toContainEqual(expect.objectContaining({ code: "SCENE_SOURCE_OUTCOME_MISMATCH" }));
});

it("allows explicitly reviewed no-change scenes, and keeps unmapped effects unsupported", () => {
  const c = catalog(); c.events.set("gift", event("gift"));
  const noop = { ...eventCase, initiatorId: undefined, requiresMechanism: false, expectation: { kind: "no-change", justification: "Only description in this independently reviewed passage" } };
  expect(review(c, [noop]).verified).toBe(true);
  const result = review(c, [{ ...noop, expectation: { kind: "unmapped", concept: "temporary incapacitation", affectedEntityIds: ["hero"] } }]);
  expect(result.cases[0]!.status).toBe("unsupported");
  expect(result.repairTasks.some((task) => task.stage === "ontology")).toBe(true);
});

it("tests actual norm applicability at explicit time cuts and detects an unbounded permission", () => {
  const c = catalog();
  const norm = normTemplateSchema.parse({ ontologyVersion: "norm-template-v1", id: "permission", name: "One-day permission", modality: "permission", actionPattern: { kind: "any" }, priority: 1, defeasible: true, status: "supported", visibility: "public", induction: { kind: "source-pattern", supportingEventIds: ["gift"] }, evidence });
  c.normTemplates.set(norm.id, norm);
  const cases = [{ ...basis, kind: "norm-scope", normId: norm.id, scenarios: [
    { label: "inside", actorId: "hero", seed: { delta: empty, elapsedDays: 0 }, expectedEffective: true },
    { label: "outside", actorId: "hero", seed: { delta: empty, elapsedDays: 2 }, expectedEffective: false },
  ] }];
  expect(review(c, cases).cases[0]!.issues).toContainEqual(expect.objectContaining({ code: "SCENE_NORM_SCOPE_MISMATCH" }));
  c.normTemplates.set(norm.id, { ...norm, appliesWhen: [{ op: "elapsed-days-lte", days: 1 }] });
  expect(review(c, cases).verified).toBe(true);
});

it("isolates knowledge to the actor and selected history rather than activating future canon", () => {
  const c = catalog();
  c.claims.set("open-claim", { id: "open-claim", subject: "gate", predicate: "open", object: true, epistemicType: "explicit-fact", evidence });
  c.propositions.set("open", { id: "open", subjectEntityId: "gate", relationId: "open", object: { kind: "literal", value: true }, polarity: "positive", modality: "asserted", evidence });
  c.events.set("earlier", event("earlier"));
  const reveal = { ...event("reveal"), observedKnowledge: { version: 1 as const, operations: [{ op: "learn" as const, actorId: "hero", claimId: "open-claim", propositionId: "open", acquisitionMode: "observed" as const, status: "knows" as const, confidence: 1 }] } };
  c.events.set("reveal", reveal);
  const test = { ...basis, kind: "knowledge-cut", actorId: "hero", acquisitionEventId: "reveal", claimId: "open-claim", contentExpectation: "Gate open", beforeEventIds: ["earlier"], afterEventIds: ["earlier", "reveal"], expectedBefore: false, expectedAfter: true };
  expect(review(c, [test]).verified).toBe(true);
  expect(review(c, [test]).cases[0]!.observations).toMatchObject({ beforeKnown: false, afterKnown: true });
  expect(review(c, [{ ...test, afterEventIds: ["reveal", "earlier"] }]).verified).toBe(false);
  c.events.set("reveal", { ...reveal, observedKnowledge: { version: 1, operations: [{ ...reveal.observedKnowledge.operations[0]!, status: "believes" }] } });
  expect(review(c, [test]).verified).toBe(false);
  expect(review(c, [{ ...test, expectedStatus: "believes" }]).verified).toBe(true);
  c.events.set("reveal", { ...reveal, observedKnowledge: { version: 1, operations: [{ ...reveal.observedKnowledge.operations[0]!, actorId: "rival" }] } });
  expect(review(c, [test]).cases[0]!.observations.afterKnown).toBe(false);
  expect(review(c, [{ ...test, claimId: undefined }]).cases[0]!.status).toBe("unknown");
});

it.each([0, undefined, 3])("uses three-valued prerequisite checks and only applies allowed action effects (%s)", (wealth) => {
  const c = catalog(); c.events.set("future-gift", event("future-gift", gift));
  const delta: StateDelta = { version: 1, operations: [{ op: "set", entityId: "rival", field: "character.wealth", value: 0 }, ...(wealth === undefined ? [] : [{ op: "set" as const, entityId: "hero", field: "character.wealth", value: wealth }])] };
  const allowed = wealth === undefined ? "unknown" : wealth === 0 ? "false" : "true";
  const result = review(c, [{ ...basis, kind: "action-probe", actorId: "hero", participants: ["hero", "rival"], action: transferThree, seed: { delta, elapsedDays: 0 }, expectedAllowed: allowed,
    expectedAfter: [{ op: "fact-equals", entityId: "rival", field: "character.wealth", value: wealth === 3 ? 3 : 0 }] }]);
  expect(result.cases[0]!.issues).toEqual([]);
  expect(result.cases[0]!.status).toBe(wealth === undefined ? "unknown" : "verified");
  expect(JSON.stringify(result.cases[0]!.observations.after)).not.toContain("artifact.owner");
});

it("detects a missing action effect using a post-state expectation, and rejects altered exact evidence", () => {
  const c = catalog();
  c.actionSchemas.set(giftSchema.id, actionSchemaSchema.parse({ ...giftSchema, stateEffects: [] }));
  const test = { ...basis, kind: "action-probe", actorId: "hero", participants: ["hero", "mo-yan", "silver-key"], action: giftSilverKey,
    seed: { elapsedDays: 0, delta: { version: 1, operations: [{ op: "set", entityId: "silver-key", field: "artifact.owner", value: "hero" }] } }, expectedAllowed: "true",
    expectedAfter: [{ op: "fact-equals", entityId: "silver-key", field: "artifact.owner", value: "mo-yan" }] };
  expect(review(c, [test]).cases[0]!.issues).toContainEqual(expect.objectContaining({ code: "SCENE_ACTION_OUTCOME_MISMATCH" }));
  expect(() => review(c, [{ ...test, evidence: [{ ...anchor, exactHash: "f".repeat(64) }] }])).toThrow("SCENE_REVIEW_EVIDENCE_INVALID");
});

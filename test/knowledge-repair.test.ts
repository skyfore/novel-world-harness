import { expect, it } from "vitest";
import { knowledgeRepairScopeIssues, type KnowledgeRepairPlan } from "../src/compiler/knowledge-repair.js";
import { canonicalEventSchema } from "../src/world/model.js";

const event = canonicalEventSchema.parse({ id: "briefing", title: "Briefing", participants: ["alice", "bob"], storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [] }, causalParents: [], confidence: 1, evidence: [] });
const plan: KnowledgeRepairPlan = { version: 1, sourceId: "source", batchId: "reconcile-source-knowledge-effects-one", predecessorBatchId: "previous", predecessorFingerprint: "a".repeat(64), reviewRef: "host-review", events: [event] };
const learned = { ...event, observedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "bob", claimId: "c", propositionId: "p", attributionId: "a", sourceActorId: "alice", acquisitionMode: "told", status: "believes", confidence: 0.9 }] } };
const bundle = () => new Map<string, {kind: string; payload: Record<string, unknown>}>([
  ["event-draft", { kind: "canonical-event", payload: learned }],
  ["claim-draft", { kind: "claim", payload: { id: "c" } }],
  ["prop-draft", { kind: "proposition", payload: { id: "p", object: { kind: "literal", value: true } } }],
  ["attr-draft", { kind: "attribution", payload: { id: "a", propositionId: "p" } }],
]);
it("rejects reuse of a later report in a direct observation repair, including relabeling it as observed", () => {
  const scoped = { ...plan, requireDirectObservation: true };
  const existing = new Set(["claim:c", "proposition:p", "attribution:a"]);
  const attempt = (operation: Record<string, unknown>) => new Map([["event", { kind: "canonical-event", payload: { ...event, observedKnowledge: { version: 1, operations: [operation] } } }]]);
  const report = learned.observedKnowledge.operations[0]!;
  expect(knowledgeRepairScopeIssues(scoped, attempt(report), existing).join()).toContain("requires direct observation");
  // The base event schema also rejects an observed operation retaining a speaker.
  expect(knowledgeRepairScopeIssues(scoped, attempt({ ...report, acquisitionMode: "observed" }), existing).length).toBeGreaterThan(0);
  const { attributionId, sourceActorId, ...sensory } = report;
  expect(knowledgeRepairScopeIssues(scoped, attempt({ ...sensory, acquisitionMode: "observed" }), existing)).toEqual([]);
  expect(knowledgeRepairScopeIssues(plan, attempt(report), existing)).toEqual([]);
});
it("allows a typed knowledge dependency closure and rejects orphan artifacts, existing rewrites and unrelated event fields", () => {
  expect(knowledgeRepairScopeIssues(plan, bundle(), new Set())).toEqual([]);
  expect(knowledgeRepairScopeIssues({ ...plan, quotationIds: ["event-utterance"] }, bundle(), new Set()).join()).toContain("host-reviewed event quotationIds");
  const quoted = bundle(); quoted.get("attr-draft")!.payload.quotationIds = ["event-utterance"];
  expect(knowledgeRepairScopeIssues({ ...plan, quotationIds: ["event-utterance"] }, quoted, new Set())).toEqual([]);
  const orphan = bundle(); orphan.set("unrelated", { kind: "claim", payload: { id: "orphan", description: "c" } });
  expect(knowledgeRepairScopeIssues(plan, orphan, new Set()).join()).toContain("not reachable");
  expect(knowledgeRepairScopeIssues(plan, bundle(), new Set(["proposition:p"])).join()).toContain("read-only");
  const outside = bundle(); outside.set("other-event", { kind: "canonical-event", payload: { ...learned, id: "other" } });
  expect(knowledgeRepairScopeIssues(plan, outside, new Set()).join()).toContain("outside");
  const modified = bundle(); modified.set("event-draft", { kind: "canonical-event", payload: { ...learned, title: "Rewritten" } });
  expect(knowledgeRepairScopeIssues(plan, modified, new Set()).join()).toContain("preserve every event field");
});
it("follows nested typed attribution/proposition dependencies but rejects dropping knowledge and duplicate logical IDs", () => {
  const nested = bundle(); nested.set("attr-draft", { kind: "attribution", payload: { id: "a", propositionId: "p", sourceAttributionId: "a2" } });
  nested.set("attr2", { kind: "attribution", payload: { id: "a2", propositionId: "p2" } });
  nested.set("prop2", { kind: "proposition", payload: { id: "p2", object: { kind: "proposition", propositionId: "p3" } } });
  nested.set("prop3", { kind: "proposition", payload: { id: "p3", object: { kind: "literal", value: true } } });
  expect(knowledgeRepairScopeIssues(plan, nested, new Set())).toEqual([]);
  nested.set("duplicate", { kind: "claim", payload: { id: "c" } });
  expect(knowledgeRepairScopeIssues(plan, nested, new Set()).join()).toContain("duplicate logical artifact");
  const baseline = canonicalEventSchema.parse(learned);
  const drop = bundle(); drop.set("event-draft", { kind: "canonical-event", payload: event });
  expect(knowledgeRepairScopeIssues({ ...plan, events: [baseline] }, drop, new Set()).join()).toContain("preserve all established knowledge");
  const noop = new Map([["event", { kind: "canonical-event", payload: event }]]);
  expect(knowledgeRepairScopeIssues(plan, noop, new Set()).join()).toContain("not a no-op");
});

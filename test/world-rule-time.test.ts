import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorldEngine } from "../src/world/engine.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { canonicalEventSchema, controlledWorldRuleSchema, type EventProposal } from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { worldRuleStoryScopeTruth } from "../src/world/policy-time.js";
import { resolveEffectiveWorldRules } from "../src/world/world-rule-ontology.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it.each([
  { actor: "ada", place: "gate", anchor: "date-confirmed", day: "2000-03-04", text: "On March 4, 2000, the gate mechanism prevents opening and Ada must be registered. At first only the year is established; the date is then confirmed as March 4." },
  { actor: "neri", place: "harbor", anchor: "date-confirmed", day: "2000-09-12", text: "On September 12, 2000, the harbor mechanism prevents opening and Neri must be registered. At first only the year is established; the date is then confirmed as September 12." },
])("keeps partially known rule time unresolved until a committed cut establishes it: $actor", async scene => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-rule-time-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, scene.text), evidence = fixture.evidence(scene.text);
  const physical = controlledWorldRuleSchema.parse({ ontologyVersion: "world-rule-v2", id: "after-mechanism", name: "Closure on the specified day", kind: "physical", scope: "global",
    jurisdictionEntityIds: [], appliesWhen: [], validStoryTime: { kind: "exact", value: scene.day, precision: "day" },
    visibility: "public", knownByClaimIds: [], priority: 1, defeasible: false, overridesRuleIds: [],
    clauses: [{ id: "closed", modality: "forbid", predicate: { op: "fact-equals", entityId: scene.place, field: "location.open", value: true }, basis: "explicit", status: "supported", confidence: 1, evidence }],
    exceptions: [], basis: "explicit", status: "supported", confidence: 1, evidence });
  const legal = controlledWorldRuleSchema.parse({ ...physical, id: "after-registration", name: "Registration on the specified day", kind: "legal", authorityEntityId: scene.actor,
    clauses: [{ ...physical.clauses[0]!, id: "registration", modality: "require", predicate: { op: "fact-equals", entityId: scene.actor, field: "character.title", value: "registered" } }] });
  const canonical = canonicalEventSchema.parse({ id: scene.anchor, title: scene.text, participants: [scene.actor], storyTime: { kind: "exact", value: scene.day, precision: "day" }, preconditions: [],
    observedOutcome: { version: 1, operations: [] }, causalParents: [], confidence: 1, evidence });
  const engine = new WorldEngine(root, { sourceId: fixture.source.id,
    entities: new Map([[scene.actor, { id: scene.actor, kind: "character", canonicalName: scene.actor, aliases: [], evidence }],
      [scene.place, { id: scene.place, kind: "location", canonicalName: scene.place, aliases: [], evidence }]]),
    rules: new Map([[physical.id, physical], [legal.id, legal]]), events: new Map([[canonical.id, canonical]]), stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS) });
  const head = await engine.createBranch("main", "Unresolved calendar cut", { version: 1, operations: [
    { op: "set", entityId: scene.actor, field: "character.alive", value: true },
    { op: "set", entityId: scene.actor, field: "character.title", value: "unregistered" },
    { op: "set", entityId: scene.place, field: "location.open", value: false },
    { op: "activate-rule", ruleId: physical.id }, { op: "activate-rule", ruleId: legal.id },
  ] }, undefined, undefined, undefined, [], { storyTime: { kind: "exact", value: "2000", precision: "year" } });
  const proposal = (branchId: string, at: string, extra: Partial<EventProposal>): EventProposal => ({ proposalId: "time-check", branchId, expectedParentCommit: at, source: "background",
    title: "Time-dependent rule", participants: [scene.actor, scene.place], proposedTime: { kind: "unknown" }, preconditions: [], causalParents: [], evidence,
    proposedDelta: { version: 1, operations: [] }, ...extra });
  const open = { version: 1 as const, operations: [{ op: "set" as const, entityId: scene.place, field: "location.open", value: true }] };
  const before = await engine.commitProposal(proposal("main", head, { proposedDelta: open }));
  expect(before.report.errors).toContainEqual(expect.objectContaining({ code: "STATE_RULE_SCOPE_UNKNOWN" }));
  const initial = resolveEffectiveWorldRules(engine.context.rules, await engine.projector.project(head));
  expect(initial.effective).toEqual([]);
  expect(initial.inactive.every(item => item.reason === "unknown-time")).toBe(true);
  const runtime = new WorldRuntime(engine, () => []);
  await runtime.forkBranch("main", head, "without-anchor", "Without anchor");
  const committed = await engine.commitProposal(proposal("main", head, { proposalId: "realize-anchor", source: "canon-candidate", possibilityId: `canon-${scene.anchor}`,
    proposedTime: { kind: "exact", value: scene.day, precision: "day" } }));
  expect(committed.report.errors).toEqual([]);
  expect(committed.report.accepted).toBe(true);
  const projected = await engine.projections.project(committed.newHead);
  const realized = new Set(projected.history.flatMap(entry => entry.event.realizesCanonicalEventIds ?? []));
  expect([...realized]).toEqual([scene.anchor]);
  expect(resolveEffectiveWorldRules(engine.context.rules, projected.state).effective.map(rule => rule.id)).toEqual([physical.id, legal.id].sort());
  const after = await engine.commitProposal(proposal("main", committed.newHead, { proposedDelta: open }));
  expect(after.report.errors).toContainEqual(expect.objectContaining({ code: "STATE_RULE_FORBIDS" }));
  const waiting = await engine.commitProposal(proposal("without-anchor", head, { actorId: scene.actor,
    proposedDelta: { version: 1, operations: [{ op: "set", entityId: scene.actor, field: "character.plan", value: "wait" }] } }));
  expect(waiting.report.accepted).toBe(true);
  expect(Object.values((await engine.projections.project(waiting.newHead)).norms.instances)).toEqual([]);
  const noncompliant = await engine.commitProposal(proposal("main", committed.newHead, { actorId: scene.actor,
    proposedDelta: { version: 1, operations: [{ op: "set", entityId: scene.actor, field: "character.plan", value: "wait" }] } }));
  expect(noncompliant.report.accepted).toBe(true);
  const result = await engine.projections.project(noncompliant.newHead);
  expect(Object.values(result.norms.instances)).toContainEqual(expect.objectContaining({ templateId: legal.id, status: "violated" }));
  expect(await engine.projections.project(noncompliant.newHead, { fresh: true, useCheckpoints: false })).toEqual(result);
  expect((await engine.projections.project(head)).history.flatMap(entry => entry.event.realizesCanonicalEventIds ?? [])).toEqual([]);
  const outsideRule = { ...physical, validStoryTime: { kind: "exact" as const, value: "2001", precision: "year" as const } };
  expect(resolveEffectiveWorldRules(new Map([[outsideRule.id, outsideRule]]), projected.state).inactive).toContainEqual({ ruleId: outsideRule.id, reason: "outside-time" });
  expect(() => controlledWorldRuleSchema.parse({ ...physical, validStoryTime: { kind: "relative", relation: "after", anchorEventId: scene.anchor } })).toThrow("committed activate-rule/deactivate-rule");

});

it("keeps unresolved offsets, during windows and partial calendar overlaps unknown", () => {
  expect(worldRuleStoryScopeTruth(undefined, undefined)).toBe("true");
  expect(worldRuleStoryScopeTruth(undefined, { kind: "unknown" })).toBe("unknown");
  expect(worldRuleStoryScopeTruth(undefined, { kind: "relative", relation: "before", anchorEventId: "bell" })).toBe("unknown");
  
  for (const relation of ["before", "after", "during"] as const) expect(worldRuleStoryScopeTruth(undefined, { kind: "relative", relation, anchorEventId: "bell", offset: "three days" })).toBe("unknown");
  expect(worldRuleStoryScopeTruth(undefined, { kind: "relative", relation: "during", anchorEventId: "bell" })).toBe("unknown");
  const day = { kind: "exact" as const, value: "2000-03-04", precision: "day" as const };
  expect(worldRuleStoryScopeTruth(day, day)).toBe("true");
  expect(worldRuleStoryScopeTruth(day, { kind: "exact", value: "2000", precision: "year" })).toBe("true");
  expect(worldRuleStoryScopeTruth({ kind: "exact", value: "2000", precision: "year" }, day)).toBe("unknown");
  expect(worldRuleStoryScopeTruth({ kind: "exact", value: "2001", precision: "year" }, day)).toBe("false");
  expect(worldRuleStoryScopeTruth({ kind: "ordinal", label: "2000", orderHint: 2000 }, day)).toBe("unknown");
  expect(worldRuleStoryScopeTruth({ kind: "ordinal", label: "winter" }, { kind: "ordinal", label: "winter" })).toBe("unknown");
});

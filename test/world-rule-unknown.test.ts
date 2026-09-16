import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorldEngine } from "../src/world/engine.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { controlledWorldRuleSchema, type ControlledWorldRule, type EventProposal, type Predicate } from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry, emptyWorldState } from "../src/world/state.js";
import { modelVisibleWorldRules, resolveEffectiveWorldRules } from "../src/world/world-rule-ontology.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it.each([
  { actor: "ada", place: "gate", text: "The gate cannot open unless its release key has arrived. Whether the key arrived is unknown. Ada must be registered, but her registration has not been established." },
  { actor: "neri", place: "harbor", text: "The harbor cannot open unless its release key has arrived. The key's arrival is unknown. Neri must be registered, but no registration status is known." },
])("distinguishes unknown rule scope and unknown compliance without inventing truth: $actor", async scene => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-world-rule-unknown-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, scene.text), evidence = fixture.evidence(scene.text);
  const keyArrived: Predicate = { op: "fact-equals", entityId: "key", field: "artifact.delivered", value: true };
  const makeRule = (id: string, kind: "physical" | "legal", modality: "require" | "forbid", predicate: Predicate): ControlledWorldRule => controlledWorldRuleSchema.parse({
    ontologyVersion: "world-rule-v2", id, name: id, kind, scope: "global", jurisdictionEntityIds: [], appliesWhen: [], visibility: "public", knownByClaimIds: [],
    ...(kind === "legal" ? { authorityEntityId: scene.actor } : {}), priority: 1, defeasible: true, overridesRuleIds: [],
    clauses: [{ id: `${id}-clause`, modality, predicate, basis: "explicit", status: "supported", confidence: 1, evidence }],
    exceptions: [], basis: "explicit", status: "supported", confidence: 1, evidence });
  const physical = makeRule("opening-mechanism", "physical", "forbid", { op: "fact-equals", entityId: scene.place, field: "location.open", value: true });
  physical.exceptions = [{ id: "released", appliesWhen: [keyArrived], basis: "explicit", status: "supported", confidence: 1, evidence }];
  const legal = makeRule("registration", "legal", "require", { op: "fact-equals", entityId: scene.actor, field: "character.title", value: "registered" });
  const engine = new WorldEngine(root, { sourceId: fixture.source.id, entities: new Map([
    [scene.actor, { id: scene.actor, kind: "character", canonicalName: scene.actor, aliases: [], evidence }],
    [scene.place, { id: scene.place, kind: "location", canonicalName: scene.place, aliases: [], evidence }],
    ["key", { id: "key", kind: "artifact", canonicalName: "Release key", aliases: [], evidence }],
  ]), rules: new Map([[physical.id, physical], [legal.id, legal]]), stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS) });
  const head = await engine.createBranch("main", "Unknown", { version: 1, operations: [
    { op: "set", entityId: scene.actor, field: "character.alive", value: true },
    { op: "set", entityId: scene.place, field: "location.open", value: false },
    { op: "activate-rule", ruleId: physical.id }, { op: "activate-rule", ruleId: legal.id },
  ] });
  const proposal = (branchId: string, at: string, extra: Partial<EventProposal>): EventProposal => ({ proposalId: "rule-check", branchId, expectedParentCommit: at,
    source: "background", title: "Rule evaluation", participants: [scene.actor, scene.place, "key"], proposedTime: { kind: "unknown" }, preconditions: [], causalParents: [], evidence,
    proposedDelta: { version: 1, operations: [] }, ...extra });
  const open = { version: 1 as const, operations: [{ op: "set" as const, entityId: scene.place, field: "location.open", value: true }] };
  const rejected = await engine.commitProposal(proposal("main", head, { proposedDelta: open }));
  expect(rejected.report.errors).toContainEqual(expect.objectContaining({ code: "STATE_RULE_SCOPE_UNKNOWN" }));
  expect(await engine.branches.readHead("main")).toBe(head);
  const resolution = resolveEffectiveWorldRules(engine.context.rules, await engine.projector.project(head));
  expect(resolution.uncertain.map(rule => rule.id)).toEqual([physical.id]);
  expect(resolution.inactive).toContainEqual({ ruleId: physical.id, reason: "unknown-exception" });
  expect(modelVisibleWorldRules(resolution.effective.filter(rule => rule.id === physical.id), {
    knownClaimIds: new Set(), visibleEntityIds: new Set([scene.actor, scene.place, "key"]), observableEntityIds: new Set([scene.place]), entities: engine.context.entities,
  })).toEqual([]);
  const runtime = new WorldRuntime(engine, () => []);
  for (const delivered of [false, true]) {
    const branch = delivered ? "released" : "unreleased";
    await runtime.forkBranch("main", head, branch, branch);
    const known = await engine.commitProposal(proposal(branch, head, { proposedDelta: { version: 1, operations: [{ op: "set", entityId: "key", field: "artifact.delivered", value: delivered }] } }));
    expect(known.report.accepted).toBe(true);
    const attempted = await engine.commitProposal(proposal(branch, known.newHead, { proposedDelta: open }));
    expect(attempted.report.accepted).toBe(delivered);
    if (!delivered) {
      expect(attempted.report.errors).toContainEqual(expect.objectContaining({ code: "STATE_RULE_FORBIDS" }));
      const eraseCondition = await engine.commitProposal(proposal(branch, known.newHead, {
        proposedDelta: { version: 1, operations: [{ op: "unset", entityId: scene.place, field: "location.open" }] },
      }));
      expect(eraseCondition.report.errors).toContainEqual(expect.objectContaining({ code: "STATE_RULE_CONDITION_UNKNOWN" }));
      expect(await engine.branches.readHead(branch)).toBe(known.newHead);
    }
  }
  // Unknown required facts do not establish a legal violation or compliance.
  const unknown = await engine.commitProposal(proposal("main", head, { actorId: scene.actor, proposedDelta: { version: 1, operations: [{ op: "set", entityId: scene.actor, field: "character.plan", value: "wait for registration" }] } }));
  expect(unknown.report.accepted).toBe(true);
  expect(Object.values((await engine.projections.project(unknown.newHead)).norms.instances)).toEqual([]);
  for (const registered of [false, true]) {
    const branch = registered ? "registered" : "unregistered";
    await runtime.forkBranch("main", unknown.newHead, branch, branch);
    const result = await engine.commitProposal(proposal(branch, unknown.newHead, { actorId: scene.actor,
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: scene.actor, field: "character.title", value: registered ? "registered" : "unregistered" }] } }));
    expect(result.report.accepted).toBe(true);
    const projected = await engine.projections.project(result.newHead);
    expect(Object.values(projected.norms.instances).filter(norm => norm.status === "violated")).toHaveLength(registered ? 0 : 1);
    expect(await engine.projections.project(result.newHead, { fresh: true, useCheckpoints: false })).toEqual(projected);
  }
  expect((await engine.projector.project(head)).values.key?.["artifact.delivered"]).toBeUndefined();
  expect((await engine.projector.project(head)).values[scene.actor]?.["character.title"]).toBeUndefined();

  const base = { ...physical, exceptions: [], appliesWhen: [] }, override = { ...base, id: "possible-override", priority: 2, overridesRuleIds: [base.id], appliesWhen: [keyArrived] };
  const unresolved = emptyWorldState("unit"); unresolved.activeRuleIds = [base.id, override.id];
  const rules = new Map([[base.id, base], [override.id, override]]);
  const uncertain = resolveEffectiveWorldRules(rules, unresolved);
  expect(uncertain.effective).toEqual([]);
  expect(uncertain.uncertain.map(rule => rule.id)).toEqual([base.id, override.id].sort());
  expect(uncertain.inactive).toContainEqual({ ruleId: base.id, reason: "unknown-override", overridingRuleId: override.id });
  unresolved.values.key = { "artifact.delivered": false };
  expect(resolveEffectiveWorldRules(rules, unresolved).effective.map(rule => rule.id)).toEqual([base.id]);
});

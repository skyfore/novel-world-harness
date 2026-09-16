import type { ActionSchema } from "../src/world/action-ontology.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorldEngine } from "../src/world/engine.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { resolveNormTemplateScopes, type NormTemplate } from "../src/world/norm-ontology.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { canonicalEventSchema, type Entity, type EventProposal, type StateDelta } from "../src/world/model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it.each([
  { actor: "ada", place: "gate", text: "Ada must check out within a day while at the gate. Excused staff are exempt; an emergency order overrides this duty. Ada is at the gate, on duty, with routine orders. Checking out can take her home." },
  { actor: "neri", place: "harbor", text: "Neri must check out within a day while at the harbor. Excused staff are exempt; an emergency order overrides this duty. Neri is at the harbor, on duty, with routine orders. Checking out can take him home." },
])("keeps scope, exceptions and overrides consistent across due, commit and replay: $actor", async scene => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-norm-scope-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, scene.text), evidence = fixture.evidence(scene.text);
  const entities: Entity[] = [
    { id: scene.actor, kind: "character", canonicalName: scene.actor, aliases: [], evidence },
    ...[scene.place, "home"].map(id => ({ id, kind: "location" as const, canonicalName: id, aliases: [], evidence })),
  ];
  const checkout: ActionSchema = { ontologyVersion: "action-schema-v1", id: "check-out", name: "Check out and relocate", initiatorRoleId: "actor",
    roles: [{ id: "actor", label: "Actor", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 },
      { id: "destination", label: "Destination", allowedEntityKinds: ["location"], minCardinality: 1, maxCardinality: 1 }],
    parameters: [], preconditions: [], stateEffects: [{ op: "set", entity: { kind: "role", roleId: "actor" }, field: "character.location", value: { source: "role", roleId: "destination" }, required: true }],
    effectEnvelope: { maxStateOperations: 1, allowedStateFields: ["character.location"], allowsKnowledge: false, allowsTimeAdvance: false, allowsSceneTransition: false },
    induction: { kind: "domain-module", moduleId: "checkout-movement", moduleVersion: "1" }, evidence: [] };
  const norm: NormTemplate = { ontologyVersion: "norm-template-v1", id: "checkout", name: "Check out while on site", modality: "obligation",
    actionPattern: { kind: "schema", schemaId: checkout.id },
    appliesWhen: [{ op: "fact-equals", entityId: scene.actor, field: "character.location", value: scene.place }],
    exceptions: [{ id: "excused", appliesWhen: [{ op: "fact-equals", entityId: scene.actor, field: "character.title", value: "excused" }] }],
    defaultDeadlineDays: 1, reparations: [], priority: 1, defeasible: true, overridesTemplateIds: [], status: "supported", visibility: "public", knownByClaimIds: [],
    induction: { kind: "source-pattern", supportingEventIds: ["premise"] }, evidence };
  const permission: NormTemplate = { ...norm, id: "emergency", name: "Emergency exemption", modality: "permission", defaultDeadlineDays: undefined,
    priority: 2, overridesTemplateIds: [norm.id], exceptions: [], appliesWhen: [{ op: "fact-equals", entityId: scene.actor, field: "character.plan", value: "emergency" }] };
  const engine = new WorldEngine(root, { sourceId: fixture.source.id, entities: new Map(entities.map(entity => [entity.id, entity])), rules: new Map(),
    actionSchemas: new Map([[checkout.id, checkout]]), normTemplates: new Map([[norm.id, norm], [permission.id, permission]]), stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    events: new Map([["premise", canonicalEventSchema.parse({ id: "premise", title: scene.text, participants: [scene.actor], storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [] }, causalParents: [], confidence: 1, evidence })]]) });
  const genesis = await engine.createBranch("main", "Original", { version: 1, operations: [
    { op: "set", entityId: scene.actor, field: "character.alive", value: true },
    { op: "set", entityId: scene.actor, field: "character.location", value: scene.place },
    { op: "set", entityId: scene.actor, field: "character.title", value: "on duty" },
    { op: "set", entityId: scene.actor, field: "character.plan", value: "routine" },
  ] });
  const proposal = (branchId: string, head: string, extra: Partial<EventProposal>): EventProposal => ({ proposalId: "scope-test", branchId, expectedParentCommit: head,
    source: "background", title: "Scope event", participants: [scene.actor], proposedTime: { kind: "unknown" }, preconditions: [], causalParents: [], evidence,
    proposedDelta: { version: 1, operations: [] }, ...extra });
  const started = await engine.commitProposal(proposal("main", genesis, { proposedNorms: { version: 1, operations: [{ op: "instantiate-norm", localRef: "local-duty", norm: { templateId: norm.id, subjectActorId: scene.actor, description: scene.text } }] } }));
  expect(started.report.accepted).toBe(true);
  const instance = Object.values((await engine.projections.project(started.newHead)).norms.instances)[0]!;
  const runtime = new WorldRuntime(engine, () => []);
  const violation = { version: 1 as const, operations: [{ op: "violate-norm" as const, normRef: instance.id, byActorId: scene.actor, reasonId: "deadline-expired" }] };
  const premature = await engine.commitProposal(proposal("main", started.newHead, { proposedNorms: violation }));
  expect(premature.report.accepted).toBe(false);
  expect(premature.report.errors.some(error => error.message.includes("NORM_DEADLINE_NOT_DUE"))).toBe(true);
  const cases: Array<{ id: string; operation: StateDelta["operations"][number]; status: string }> = [
    { id: "away", operation: { op: "set", entityId: scene.actor, field: "character.location", value: "home" }, status: "inactive" },
    { id: "excused", operation: { op: "set", entityId: scene.actor, field: "character.title", value: "excused" }, status: "inactive" },
    { id: "override", operation: { op: "set", entityId: scene.actor, field: "character.plan", value: "emergency" }, status: "overridden" },
    { id: "unknown-place", operation: { op: "unset", entityId: scene.actor, field: "character.location" }, status: "unknown" },
    { id: "unknown-exception", operation: { op: "unset", entityId: scene.actor, field: "character.title" }, status: "unknown" },
    { id: "unknown-override", operation: { op: "unset", entityId: scene.actor, field: "character.plan" }, status: "unknown" },
  ];
  for (const variant of cases) {
    await runtime.forkBranch("main", started.newHead, variant.id, variant.id);
    const changed = await engine.commitProposal(proposal(variant.id, started.newHead, { timeAdvance: { amount: 1, unit: "day" }, proposedDelta: { version: 1, operations: [variant.operation] } }));
    expect(changed.report.accepted).toBe(true);
    const current = await engine.projections.project(changed.newHead);
    expect(resolveNormTemplateScopes([norm, permission], current.state).find(item => item.template.id === norm.id)?.status).toBe(variant.status);
    expect((await runtime.refreshFrontier(variant.id)).evaluated).toEqual([]);
    for (const operation of [violation.operations[0]!, { op: "satisfy-norm" as const, normRef: instance.id, byActorId: scene.actor }]) {
      const rejected = await engine.commitProposal(proposal(variant.id, changed.newHead, { proposedNorms: { version: 1, operations: [operation] } }));
      expect(rejected.report.accepted).toBe(false);
      expect(rejected.report.errors.some(error => error.message.includes("NORM_SCOPE_NOT_ACTIVE"))).toBe(true);
      expect(await engine.branches.readHead(variant.id)).toBe(changed.newHead);
    }
    expect((await engine.projections.project(changed.newHead)).norms.instances[instance.id]?.status).toBe("active");
    if (variant.id === "away") {
      const sameEventBypass = await engine.commitProposal(proposal(variant.id, changed.newHead, {
        proposedNorms: violation,
        proposedDelta: { version: 1, operations: [{ op: "set", entityId: scene.actor, field: "character.location", value: scene.place }] },
      }));
      expect(sameEventBypass.report.accepted).toBe(false);
      expect(sameEventBypass.report.errors.some(error => error.message.includes("NORM_SCOPE_NOT_ACTIVE"))).toBe(true);
      expect(await engine.branches.readHead(variant.id)).toBe(changed.newHead);
      expect((await engine.projector.project(changed.newHead)).values[scene.actor]?.["character.location"]).toBe("home");
      const falseAndUnknown = structuredClone(current.state); delete falseAndUnknown.values[scene.actor]!["character.title"];
      expect(resolveNormTemplateScopes([norm, permission], falseAndUnknown).find(item => item.template.id === norm.id)?.status).toBe("inactive");
    }
  }
  const awayHead = await engine.branches.readHead("away");
  const restored = await engine.commitProposal(proposal("away", awayHead, { proposedDelta: { version: 1, operations: [{ op: "set", entityId: scene.actor, field: "character.location", value: scene.place }] } }));
  expect(restored.report.errors).toEqual([]);
  expect(restored.report.accepted).toBe(true);
  expect((await runtime.refreshFrontier("away")).evaluated[0]?.status).toBe("eligible");
  const settled = await runtime.move({ branchId: "away", maxBackgroundCandidates: 1 });
  expect(settled.committedEvents).toHaveLength(1);
  expect((await engine.projections.project(settled.newHead)).norms.instances[instance.id]?.status).toBe("violated");
  // The action's own location effect must not retroactively exempt it from its pre-action duty.
  const performed = await engine.commitProposal(proposal("main", started.newHead, { source: "actor", actorId: scene.actor,
    participants: [scene.actor, "home"],
    action: { lane: "schema-bound", schemaId: checkout.id, roleBindings: [{ roleId: "actor", entityIds: [scene.actor] }, { roleId: "destination", entityIds: ["home"] }], parameters: {} },
    proposedDelta: { version: 1, operations: [{ op: "set", entityId: scene.actor, field: "character.location", value: "home" }] } }));
  expect(performed.report.errors).toEqual([]);
  expect(performed.report.accepted).toBe(true);
  const finished = await engine.projections.project(performed.newHead);
  expect(finished.norms.instances[instance.id]?.status).toBe("satisfied");
  expect(await engine.projections.project(performed.newHead, { fresh: true, useCheckpoints: false })).toEqual(finished);
  expect((await engine.projections.project(started.newHead)).norms.instances[instance.id]?.status).toBe("active");
});

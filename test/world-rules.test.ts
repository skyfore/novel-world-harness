import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import type { Entity, WorldRule } from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("temporal world rules", () => {
  it("blocks an event whose dry-run post-state violates an active rule", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-rules-"));
    roots.push(root);
    const entities: Entity[] = [
      { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
      { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] },
      { id: "forbidden", kind: "location", canonicalName: "Forbidden", aliases: [], evidence: [] },
    ];
    const support = [{
      span: { sourceId: "novel", startByte: 0, endByte: 4, startLine: 1, endLine: 1, quoteHash: "a".repeat(64) },
      strength: "explicit" as const,
    }];
    const rule: WorldRule = {
      ontologyVersion: "world-rule-v2",
      id: "ban-entry",
      name: "Ban entry",
      kind: "physical",
      scope: "global",
      jurisdictionEntityIds: [],
      appliesWhen: [],
      visibility: "public",
      knownByClaimIds: [],
      priority: 0,
      defeasible: false,
      overridesRuleIds: [],
      clauses: [{
        id: "ban-entry-clause",
        modality: "forbid",
        predicate: { op: "fact-equals", entityId: "hero", field: "character.location", value: "forbidden" },
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
    };
    const context: WorldModelContext = {
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      rules: new Map([[rule.id, rule]]),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    };
    const engine = new WorldEngine(root, context);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
        { op: "activate-rule", ruleId: "ban-entry" },
      ],
    });
    const result = await engine.commitProposal({
      proposalId: "enter-forbidden",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "player",
      actorId: "hero",
      title: "Enter forbidden room",
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.location", value: "forbidden" }] },
      causalParents: [],
      evidence: [],
    });
    expect(result.report.accepted).toBe(false);
    expect(result.report.errors.some((error) => error.code === "STATE_RULE_FORBIDS")).toBe(true);
    expect(result.newHead).toBe(genesis);
    expect((await engine.projector.project(genesis)).values.hero?.["character.location"]).toBe("hall");
  });

  it("records social violations without erasing agency and honors supported exceptions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-controlled-rules-"));
    roots.push(root);
    const entities: Entity[] = [
      { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
      { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] },
      { id: "forbidden", kind: "location", canonicalName: "Forbidden", aliases: [], evidence: [] },
    ];
    const evidence = [{
      span: { sourceId: "novel", startByte: 0, endByte: 4, startLine: 1, endLine: 1, quoteHash: "a".repeat(64) },
      strength: "explicit" as const,
    }];
    const rule: WorldRule = {
      ontologyVersion: "world-rule-v2",
      id: "ban-entry-v2",
      name: "Ban entry unless permitted",
      kind: "social",
      scope: "global",
      jurisdictionEntityIds: [],
      appliesWhen: [],
      visibility: "public",
      knownByClaimIds: [],
      priority: 10,
      defeasible: true,
      overridesRuleIds: [],
      clauses: [{
        id: "ban-entry-clause",
        modality: "forbid",
        predicate: { op: "fact-equals", entityId: "hero", field: "character.location", value: "forbidden" },
        basis: "explicit",
        status: "supported",
        confidence: 1,
        evidence,
      }],
      exceptions: [{
        id: "entry-permit",
        appliesWhen: [{ op: "fact-equals", entityId: "hero", field: "character.plan", value: "permit" }],
        basis: "explicit",
        status: "supported",
        confidence: 1,
        evidence,
      }],
      basis: "explicit",
      status: "supported",
      confidence: 1,
      evidence,
    };
    const engine = new WorldEngine(root, {
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      rules: new Map([[rule.id, rule]]),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
        { op: "set", entityId: "hero", field: "character.plan", value: "none" },
        { op: "activate-rule", ruleId: rule.id },
      ],
    });
    const violated = await engine.commitProposal({
      proposalId: "enter-without-permit",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "player",
      actorId: "hero",
      title: "Enter without a permit",
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.location", value: "forbidden" }] },
      causalParents: [],
      evidence: [],
    });
    expect(violated.report.accepted).toBe(true);
    expect(violated.progressCertificate?.channels).toContain("norm");
    expect(Object.values((await engine.projections.project(violated.newHead)).norms.instances)[0]?.status).toBe("violated");

    const permit = await engine.commitProposal({
      proposalId: "receive-permit",
      branchId: "main",
      expectedParentCommit: violated.newHead,
      source: "background",
      title: "Receive a permit",
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [
        { op: "set", entityId: "hero", field: "character.plan", value: "permit" },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
      ] },
      causalParents: [],
      evidence: [],
    });
    expect(permit.report.accepted).toBe(true);
    const allowed = await engine.commitProposal({
      proposalId: "enter-with-permit",
      branchId: "main",
      expectedParentCommit: permit.newHead,
      source: "player",
      actorId: "hero",
      title: "Enter with a permit",
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.location", value: "forbidden" }] },
      causalParents: [],
      evidence: [],
    });
    expect(allowed.report.accepted).toBe(true);
    expect(Object.values((await engine.projections.project(allowed.newHead)).norms.instances)).toHaveLength(1);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import type { Entity, WorldRule } from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("dynamic in-world rules", () => {
  it("changes event legality after a committed rule deactivation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-dynamic-rule-"));
    roots.push(root);
    const entities: Entity[] = [
      { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
      { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] },
      { id: "garden", kind: "location", canonicalName: "Garden", aliases: [], evidence: [] },
    ];
    const evidence = [{
      span: { sourceId: "novel", startByte: 0, endByte: 6, startLine: 1, endLine: 1, quoteHash: "a".repeat(64) },
      strength: "explicit" as const,
    }];
    const rule: WorldRule = {
      ontologyVersion: "world-rule-v2",
      id: "garden-closed",
      name: "Garden is closed",
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
        id: "garden-closed-clause",
        modality: "forbid",
        predicate: { op: "fact-equals", entityId: "hero", field: "character.location", value: "garden" },
        basis: "explicit",
        status: "supported",
        confidence: 1,
        evidence,
      }],
      exceptions: [],
      basis: "explicit",
      status: "supported",
      confidence: 1,
      evidence,
    };
    const engine = new WorldEngine(root, {
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      rules: new Map([[rule.id, rule]]),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    } satisfies WorldModelContext);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
        { op: "activate-rule", ruleId: "garden-closed" },
      ],
    });

    const enterBefore = await engine.commitProposal({
      proposalId: "enter-before",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "player",
      actorId: "hero",
      title: "Enter garden",
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.location", value: "garden" }] },
      causalParents: [],
      evidence: [],
    });
    expect(enterBefore.report.accepted).toBe(false);
    expect(enterBefore.report.errors.some((error) => error.code === "STATE_RULE_FORBIDS")).toBe(true);

    const reopen = await engine.commitProposal({
      proposalId: "reopen-garden",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "Garden reopens",
      participants: [],
      proposedTime: { kind: "unknown" },
      preconditions: [{ op: "rule-active", ruleId: "garden-closed" }],
      proposedDelta: { version: 1, operations: [{ op: "deactivate-rule", ruleId: "garden-closed" }] },
      causalParents: [],
      evidence: [],
    });
    expect(reopen.report.accepted).toBe(true);
    expect((await engine.projector.project(reopen.newHead)).activeRuleIds).not.toContain("garden-closed");

    const enterAfter = await engine.commitProposal({
      proposalId: "enter-after",
      branchId: "main",
      expectedParentCommit: reopen.newHead,
      source: "player",
      actorId: "hero",
      title: "Enter garden",
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.location", value: "garden" }] },
      causalParents: [],
      evidence: [],
    });
    expect(enterAfter.report.accepted).toBe(true);
    expect((await engine.projector.project(enterAfter.newHead)).values.hero?.["character.location"]).toBe("garden");
  });
});

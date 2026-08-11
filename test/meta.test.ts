import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { NarrativeMetaView } from "../src/world/meta.js";
import type { Entity } from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("NarrativeMetaView", () => {
  it("indexes interpretation claims without changing branch state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-meta-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    await canon.putClaim({
      id: "theme-power",
      subject: "hero",
      predicate: "theme",
      object: "Power isolates the protagonist",
      epistemicType: "interpretation",
      evidence: [],
    });
    await canon.putClaim({
      id: "hero-alive",
      subject: "hero",
      predicate: "alive",
      object: true,
      epistemicType: "explicit-fact",
      evidence: [],
    });
    const meta = await new NarrativeMetaView(canon).list();
    expect(meta).toHaveLength(1);
    expect(meta[0]).toMatchObject({ kind: "theme", claimId: "theme-power" });

    const entities: Entity[] = [{ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] }];
    const context: WorldModelContext = {
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      claims: new Map((await canon.listClaims()).map((claim) => [claim.id, claim])),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    };
    const engine = new WorldEngine(root, context);
    const head = await engine.createBranch("main", "Main", { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] });
    const state = await engine.projector.project(head);
    expect(state.values.hero?.["character.alive"]).toBe(true);
    expect(JSON.stringify(state)).not.toContain("Power isolates");
  });
});

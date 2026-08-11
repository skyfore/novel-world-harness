import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { NarrativeRenderer } from "../src/world/narrative.js";
import type { Entity } from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-narrative-"));
  roots.push(root);
  const entities: Entity[] = [
    { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
    { id: "hall", kind: "location", canonicalName: "Hall", aliases: [], evidence: [] },
  ];
  const context: WorldModelContext = {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    rules: new Map(),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  const engine = new WorldEngine(root, context);
  const genesis = await engine.createBranch("main", "Main", {
    version: 1,
    operations: [
      { op: "set", entityId: "hero", field: "character.alive", value: true },
      { op: "set", entityId: "hero", field: "character.location", value: "hall" },
    ],
  });
  const committed = await engine.commitProposal({
    proposalId: "title",
    branchId: "main",
    expectedParentCommit: genesis,
    source: "background",
    title: "Hero receives a title",
    participants: ["hero"],
    proposedTime: { kind: "ordinal", label: "scene 1" },
    preconditions: [],
    proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.title", value: "Commander" }] },
    causalParents: [],
    evidence: [],
  });
  return { engine, head: committed.newHead };
}

describe("NarrativeRenderer", () => {
  it("renders the same committed world in different styles without moving truth", async () => {
    const { engine, head } = await fixture();
    const renderer = new NarrativeRenderer(engine, (frame, style) => `${style.tone ?? "plain"}:${frame.events.map((entry) => entry.event.title).join("|")}`);
    const first = await renderer.render("main", head, { tone: "formal" });
    const second = await renderer.render("main", head, { tone: "colloquial" });
    expect(first).not.toBe(second);
    expect(await engine.branches.readHead("main")).toBe(head);
    expect((await engine.projector.project(head)).values.hero?.["character.title"]).toBe("Commander");
  });

  it("actor POV exposes an actor view instead of compiler omniscience", async () => {
    const { engine, head } = await fixture();
    const renderer = new NarrativeRenderer(engine, (frame) => JSON.stringify(frame.actorView));
    const output = await renderer.render("main", head, { pointOfView: "actor", actorId: "hero" });
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed.actorId).toBe("hero");
    expect(parsed).toHaveProperty("selfState");
    expect(parsed).not.toHaveProperty("worldState");
  });
});


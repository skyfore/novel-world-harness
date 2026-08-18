import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { NarrativeRenderer } from "../src/world/narrative.js";
import type { Entity, EvidenceRef } from "../src/world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import { projectActorScene } from "../src/world/scene.js";

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
    actorObservations: [{ actorId: "hero", summary: "Hero receives a title" }],
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

  it("injects each committed event into the narrative frame exactly once", async () => {
    const { engine, head } = await fixture();
    const renderer = new NarrativeRenderer(engine, (frame) => JSON.stringify(frame.events.map(({ event }) => event.title)));

    const titles = JSON.parse(await renderer.render("main", head)) as string[];

    expect(titles).toEqual(["Genesis", "Hero receives a title"]);
  });

  it("rejects a non-string adapter result at the callback boundary", async () => {
    const { engine, head } = await fixture();
    const invalidAdapter = (() => ({ text: "not a string" })) as unknown as ConstructorParameters<typeof NarrativeRenderer>[1];
    const renderer = new NarrativeRenderer(engine, invalidAdapter);

    await expect(renderer.render("main", head)).rejects.toThrow("Narrative adapter must return a string");
  });

  it("detects an adapter that rewrites branch truth while rendering", async () => {
    const { engine, head } = await fixture();
    const foreignHead = "b".repeat(64);
    const renderer = new NarrativeRenderer(engine, async () => {
      await engine.branches.updateHead("main", head, foreignHead);
      return "Rendered scene";
    });

    await expect(renderer.render("main", head)).rejects.toThrow("Narrative renderer mutated branch truth");
    expect(await engine.branches.readHead("main")).toBe(foreignHead);
    await engine.branches.updateHead("main", foreignHead, head);
  });

  it("actor POV exposes only an actor-scoped frame", async () => {
    const { engine, head } = await fixture();
    const renderer = new NarrativeRenderer(engine, (frame) => JSON.stringify(frame));
    const output = await renderer.render("main", head, { pointOfView: "actor", actorId: "hero" });
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed.pointOfView).toBe("actor");
    expect(parsed).not.toHaveProperty("state");
    expect(parsed).not.toHaveProperty("branchId");
    expect(parsed).not.toHaveProperty("commitId");
    expect(parsed.actorView).toMatchObject({ actor: { name: "Hero" } });
    expect(JSON.stringify(parsed)).not.toContain("scene 1");
    expect(JSON.stringify(parsed)).not.toContain(head);
    expect(parsed.events).toBeInstanceOf(Array);
  });

  it("removes the host actor id from the style passed to an actor adapter", async () => {
    const { engine, head } = await fixture();
    const renderer = new NarrativeRenderer(engine, (_frame, style) => JSON.stringify(style));
    const output = await renderer.render("main", head, { pointOfView: "actor", actorId: "hero", tone: "quiet" });
    expect(JSON.parse(output)).toEqual({ pointOfView: "actor", tone: "quiet" });
  });

  it("requires an actor id for actor point of view", async () => {
    const { engine, head } = await fixture();
    const renderer = new NarrativeRenderer(engine);
    await expect(renderer.render("main", head, { pointOfView: "actor" })).rejects.toThrow("requires actorId");
  });

  it("does not expose a foreign-source historical event through actor narration or scene projection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-narrative-source-"));
    roots.push(root);
    const sourceEvidence = (sourceId: string): EvidenceRef[] => [{
      span: { sourceId, startLine: 1, endLine: 1, quoteHash: `${sourceId}-evidence` },
      strength: "explicit",
    }];
    const hero: Entity = {
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: sourceEvidence("novel-a"),
    };
    const engine = new WorldEngine(root, {
      entities: new Map([[hero.id, hero]]),
      rules: new Map(),
      stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
    });
    const genesis = await engine.createBranch("legacy", "Legacy", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });
    const foreign = await engine.commitProposal({
      proposalId: "foreign-history",
      branchId: "legacy",
      expectedParentCommit: genesis,
      source: "background",
      title: "Foreign canon title",
      actorObservations: [{ actorId: "hero", summary: "Foreign secret observation" }],
      participants: ["hero"],
      proposedTime: { kind: "ordinal", label: "foreign chronology" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      causalParents: [],
      evidence: sourceEvidence("novel-b"),
    });
    expect(foreign.report.accepted).toBe(true);

    const scene = await projectActorScene(engine, "hero", foreign.newHead);
    expect(scene.recentEvents).toEqual([]);
    const rendered = await new NarrativeRenderer(engine, (frame) => JSON.stringify(frame))
      .render("legacy", foreign.newHead, { pointOfView: "actor", actorId: "hero" });
    expect(rendered).not.toContain("Foreign secret observation");
    expect(rendered).not.toContain("Foreign canon title");
    expect(rendered).not.toContain("foreign chronology");
  });
});

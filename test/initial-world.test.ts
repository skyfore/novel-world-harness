import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { CompilerCommitService } from "../src/compiler/validator.js";
import { loadWorldContext } from "../src/world/context.js";
import { WorldEngine } from "../src/world/engine.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { KnowledgeProjector } from "../src/world/knowledge.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { worldCreateCommand } from "../src/commands/world.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("canonical initial world", () => {
  it("does not silently create an empty playable branch without an accepted initial world", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-initial-missing-"));
    roots.push(root);
    await expect(worldCreateCommand(root, "main")).rejects.toThrow("No accepted initial world");
  });

  it("requires canonical entities before accepting the seed and replays it as genesis", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-initial-"));
    roots.push(root);
    const source = await createEvidenceFixture(root, "opening\n");
    const proposals = new CompilerProposalService(root);
    const commits = new CompilerCommitService(root);

    await proposals.submit("initial-world", {
      proposalId: "initial",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
        knowledge: {
          version: 1,
          operations: [{ op: "learn", actorId: "hero", claimId: "opening-claim", status: "knows", confidence: 1 }],
        },
        evidence: source.evidence("opening"),
      },
      generatedBy: { worker: "test" },
    });
    const blocked = await commits.accept("initial-world", "initial");
    expect(blocked.accepted).toBe(false);

    await proposals.submit("entity", {
      proposalId: "hero-entity",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: ["H"], evidence: source.evidence("opening") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "hero-entity")).accepted).toBe(true);
    await proposals.submit("claim", {
      proposalId: "opening-claim-proposal",
      payload: {
        id: "opening-claim",
        subject: "hero",
        predicate: "is present at the opening",
        object: true,
        epistemicType: "explicit-fact",
        evidence: source.evidence("opening"),
      },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("claim", "opening-claim-proposal")).accepted).toBe(true);
    expect((await commits.accept("initial-world", "initial")).accepted).toBe(true);

    const initial = await new InitialWorldStore(root).get();
    expect(initial?.delta.operations).toHaveLength(1);
    const { context } = await loadWorldContext(root);
    const engine = new WorldEngine(root, context);
    const head = await engine.createBranch("main", "Main", initial!.delta, initial!.knowledge);
    expect((await engine.projector.project(head)).values.hero?.["character.alive"]).toBe(true);
    expect((await new KnowledgeProjector(engine).view("hero", head)).knowledge)
      .toMatchObject([{ fact: { claimId: "opening-claim", status: "knows" } }]);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { CompilerCommitService } from "../src/compiler/validator.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("generic possibility templates", () => {
  it("accepts an evidence-backed background pressure and materializes it into the runtime frontier", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-possibility-"));
    roots.push(root);
    const source = await createEvidenceFixture(
      root,
      "Hero is alive in the Hall.\nA storm will close the Hall if Hero remains there.\n",
    );
    const proposals = new CompilerProposalService(root);
    const canonical = new CompilerCommitService(root);

    for (const [id, kind, quote] of [
      ["hero", "character", "Hero is alive in the Hall."],
      ["hall", "location", "Hero is alive in the Hall."],
    ] as const) {
      await proposals.submit("entity", {
        proposalId: `entity-${id}`,
        payload: { id, kind, canonicalName: id === "hero" ? "Hero" : "Hall", aliases: [], evidence: source.evidence(quote) },
        generatedBy: { worker: "test" },
      });
    }
    expect((await canonical.acceptAllValid()).blocked).toEqual([]);

    await proposals.submit("initial-world", {
      proposalId: "initial",
      payload: {
        version: 1,
        delta: {
          version: 1,
          operations: [
            { op: "set", entityId: "hero", field: "character.alive", value: true },
            { op: "set", entityId: "hero", field: "character.location", value: "hall" },
          ],
        },
        evidence: source.evidence("Hero is alive in the Hall."),
      },
      generatedBy: { worker: "test" },
    });
    expect((await canonical.accept("initial-world", "initial")).accepted).toBe(true);

    await proposals.submit("possibility", {
      proposalId: "storm-proposal",
      payload: {
        id: "storm-closes-hall",
        kind: "background-pressure",
        title: "Storm closes the Hall",
        preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.location", value: "hall" }],
        blockers: [],
        participants: ["hero", "hall"],
        causalParents: [],
        pressure: 0.9,
        relevance: 0.8,
        proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.title", value: "Stormbound" }] },
        evidence: source.evidence("A storm will close the Hall if Hero remains there."),
      },
      generatedBy: { worker: "test" },
    });
    expect((await convergeWorldProposals(root)).possibilities.accepted).toEqual(["storm-proposal"]);

    const initial = await new InitialWorldStore(root).get();
    const { engine, runtime } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", initial!.delta);
    const frontier = await runtime.refreshFrontier("main");
    expect(frontier.evaluated.find((entry) => entry.possibility.id === "storm-closes-hall")?.status).toBe("eligible");
    const move = await runtime.move({ branchId: "main", maxActorCandidates: 0, maxBackgroundCandidates: 1 });
    expect((await engine.projector.project(move.newHead)).values.hero?.["character.title"]).toBe("Stormbound");
  });
});

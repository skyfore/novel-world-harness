import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { CompilerCommitService } from "../src/compiler/validator.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { PossibilityTemplateStore } from "../src/world/possibility-model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { ActorModelStore } from "../src/world/actors.js";
import { buildActorScopedActionContext } from "../src/world/player-action.js";

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
        participantPresence: [{ entityId: "hero", mode: "physical" }],
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

  it("fails closed for automatic possibilities when a legacy branch has no unambiguous novel source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-legacy-possibility-scope-"));
    roots.push(root);
    const first = await createEvidenceFixture(root, "First Hero waits.\n", "first.txt");
    const second = await createEvidenceFixture(root, "Second Hero waits.\n", "second.txt");
    const canon = new CanonicalModelStore(root);
    const possibilities = new PossibilityTemplateStore(root);
    const actors = new ActorModelStore(root);
    await canon.putEntity({
      id: "first-hero",
      kind: "character",
      canonicalName: "First Hero",
      aliases: [],
      evidence: first.evidence("First Hero waits."),
    });
    await canon.putEntity({
      id: "second-hero",
      kind: "character",
      canonicalName: "Second Hero",
      aliases: [],
      evidence: second.evidence("Second Hero waits."),
    });
    await possibilities.put({
      id: "first-pressure",
      kind: "background-pressure",
      title: "First pressure",
      preconditions: [],
      blockers: [],
      participants: ["first-hero"],
      causalParents: [],
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [] },
      evidence: first.evidence("First Hero waits."),
    });
    await possibilities.put({
      id: "second-pressure",
      kind: "background-pressure",
      title: "Second pressure",
      preconditions: [],
      blockers: [],
      participants: ["second-hero"],
      causalParents: [],
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [] },
      evidence: second.evidence("Second Hero waits."),
    });
    await actors.putGoal({
      id: "first-goal",
      actorId: "first-hero",
      description: "Act only in the first novel",
      priority: 1,
      requiresKnowledge: [],
      candidateAction: {
        title: "First actor moves",
        preconditions: [],
        proposedDelta: { version: 1, operations: [] },
      },
      evidence: first.evidence("First Hero waits."),
    });
    await actors.putGoal({
      id: "second-goal",
      actorId: "second-hero",
      description: "Act only in the second novel",
      priority: 1,
      requiresKnowledge: [],
      candidateAction: {
        title: "Second actor moves",
        preconditions: [],
        proposedDelta: { version: 1, operations: [] },
      },
      evidence: second.evidence("Second Hero waits."),
    });

    const { engine, runtime } = await openWorkspaceWorld(root);
    const ambiguousHead = await engine.createBranch("ambiguous", "Ambiguous legacy branch");
    expect((await runtime.refreshFrontier("ambiguous")).evaluated).toEqual([]);
    await expect(buildActorScopedActionContext(engine, "first-hero", ambiguousHead))
      .rejects.toThrow("ambiguous legacy multi-source context");
    const automatic = await runtime.move({ branchId: "ambiguous", maxActorCandidates: 1, maxBackgroundCandidates: 0 });
    expect(automatic.newHead).toBe(ambiguousHead);
    expect(automatic.committedEvents).toEqual([]);

    await engine.createBranch(
      "first-owned",
      "First-owned legacy branch",
      { version: 1, operations: [{ op: "set", entityId: "first-hero", field: "character.alive", value: true }] },
      undefined,
      undefined,
      undefined,
      first.evidence("First Hero waits."),
    );
    expect((await runtime.refreshFrontier("first-owned")).evaluated.map((entry) => entry.possibility.id)).toEqual([
      "first-pressure",
    ]);
  });
});

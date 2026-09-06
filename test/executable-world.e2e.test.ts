import { installHallCampRoute, hallCampWalkIntent, hallCampWalkAction } from "./helpers/travel.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { CompilerCommitService } from "../src/compiler/validator.js";
import { canonicalPossibilitySource } from "../src/world/canon-runtime.js";
import { loadWorldContext } from "../src/world/context.js";
import { WorldEngine } from "../src/world/engine.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { runCanonReplay } from "../src/world/replay.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("executable world vertical slice", () => {
  it("compiles canon, replays it, then preserves a durable counterfactual divergence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-e2e-"));
    roots.push(root);
    const source = await createEvidenceFixture(root, "Hero\nHall\nCamp\nHero begins in the hall\nHero is promoted in the hall\nHall and Camp have a one-minute footpath.\n");
    const proposals = new CompilerProposalService(root);
    const commits = new CompilerCommitService(root);

    for (const [id, kind, name] of [
      ["hero", "character", "Hero"],
      ["hall", "location", "Hall"],
      ["camp", "location", "Camp"],
    ] as const) {
      await proposals.submit("entity", {
        proposalId: `entity-${id}`,
        payload: { id, kind, canonicalName: name, aliases: [name.toLowerCase()], evidence: source.evidence(name) },
        generatedBy: { worker: "e2e" },
      });
    }

    await proposals.submit("initial-world", {
      proposalId: "initial-world",
      payload: {
        version: 1,
        participantPresence: [{ entityId: "hero", mode: "physical" }],
        delta: {
          version: 1,
          operations: [
            { op: "set", entityId: "hero", field: "character.alive", value: true },
            { op: "set", entityId: "hero", field: "character.location", value: "hall" },
          ],
        },
        evidence: source.evidence("Hero begins in the hall"),
      },
      generatedBy: { worker: "e2e" },
    });

    await proposals.submit("canonical-event", {
      proposalId: "event-promotion",
      payload: {
        id: "promotion",
        title: "Hero is promoted",
        participants: ["hero"],
        participantPresence: [{ entityId: "hero", mode: "physical" }],
        storyTime: { kind: "ordinal", label: "promotion scene" },
        preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.location", value: "hall" }],
        observedOutcome: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.title", value: "Commander" }] },
        evidence: source.evidence("Hero is promoted in the hall"),
        causalParents: [],
        confidence: 1,
      },
      generatedBy: { worker: "e2e" },
    });

    const accepted = await commits.acceptAllValid();
    expect(accepted.blocked).toEqual([]);
    expect(accepted.accepted.map((item) => item.kind)).toContain("initial-world");
    expect(accepted.accepted.map((item) => item.kind)).toContain("canonical-event");

    await installHallCampRoute(root, source.evidence("Hall and Camp have a one-minute footpath."));
    const { canon, context } = await loadWorldContext(root);
    const initial = await new InitialWorldStore(root).get();
    expect(initial).not.toBeNull();
    const engine = new WorldEngine(root, context);
    const replayGenesis = await engine.createBranch("replay", "Replay", initial!.delta);
    const replayRuntime = new WorldRuntime(engine, canonicalPossibilitySource(canon));
    const replay = await runCanonReplay(replayRuntime, "replay", [
      { id: "promoted", label: "Hero promoted", expected: [{ op: "fact-equals", entityId: "hero", field: "character.title", value: "Commander" }] },
    ]);
    expect(replay.passed).toBe(true);
    expect(replay.startCommit).toBe(replayGenesis);

    const branchGenesis = await engine.createBranch("main", "Main", initial!.delta);
    const runtime = new WorldRuntime(engine, canonicalPossibilitySource(canon));
    await runtime.forkBranch("main", branchGenesis, "alternate", "Alternate");

    const canonicalMove = await runtime.move({ branchId: "main", maxActorCandidates: 0, maxBackgroundCandidates: 1 });
    expect((await engine.projector.project(canonicalMove.newHead)).values.hero?.["character.title"]).toBe("Commander");

    const alternateMove = await runtime.move({
      branchId: "alternate",
      playerProposal: {
        proposalId: "leave-hall",
        action: hallCampWalkAction,
        timeAdvance: { amount: 1, unit: "minute" },
        branchId: "alternate",
        expectedParentCommit: branchGenesis,
        source: "player",
        actorId: "hero",
        title: "Hero leaves before promotion",
        participants: ["hero"],
        proposedTime: { kind: "ordinal", label: "before promotion" },
        preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.location", value: "hall" }],
        proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.location", value: "camp" }] },
        causalParents: [],
        evidence: [],
      },
      maxActorCandidates: 0,
      maxBackgroundCandidates: 1,
    });
    const alternateState = await engine.projector.project(alternateMove.newHead);
    expect(alternateState.values.hero?.["character.location"]).toBe("camp");
    expect(alternateState.values.hero?.["character.title"]).toBeUndefined();
    expect(alternateMove.frontier.evaluated.find((entry) => entry.possibility.id === "canon-promotion")?.status).toBe("latent");
    expect(alternateMove.committedEvents).toHaveLength(1);
  });
});

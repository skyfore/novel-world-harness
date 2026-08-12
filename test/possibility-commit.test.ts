import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PossibilityCommitService } from "../src/compiler/possibility-commit.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-possibility-commit-"));
  roots.push(root);
  const source = await createEvidenceFixture(root, "Hero may refuse the key.\n");
  const service = new PossibilityCommitService(root);
  await service.canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: source.evidence("Hero") });
  await service.canon.putClaim({ id: "known", subject: "hero", predicate: "knows", object: "key", epistemicType: "explicit-fact", evidence: source.evidence("Hero") });
  await service.canon.putEvent({
    id: "give-key",
    title: "Hero gives the key",
    participants: ["hero"],
    storyTime: { kind: "unknown" },
    preconditions: [],
    observedOutcome: { version: 1, operations: [] },
    evidence: source.evidence("Hero"),
    causalParents: [],
    confidence: 1,
  });
  return { service, evidence: source.evidence("Hero") };
}

describe("PossibilityCommitService", () => {
  it("requires canon analogues to identify canon and validates proposed knowledge", async () => {
    const { service, evidence } = await fixture();
    const invalid = await service.validate({
      id: "bad-alternative",
      kind: "canon-analogue",
      title: "Unlinked canon and invented knowledge",
      preconditions: [],
      blockers: [],
      participants: ["hero"],
      causalParents: [],
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [] },
      proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "hero", claimId: "missing", status: "knows", confidence: 1 }] },
      evidence,
    });
    expect(invalid.accepted).toBe(false);
    expect(invalid.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "CANON_ANALOGUE_EVENT_REQUIRED" }),
      expect.objectContaining({ code: "UNKNOWN_KNOWLEDGE_CLAIM" }),
    ]));

    const valid = await service.validate({
      id: "canon-give-key",
      kind: "canon-analogue",
      title: "Hero gives the key",
      preconditions: [],
      blockers: [],
      participants: ["hero"],
      causalParents: [],
      canonicalEventId: "give-key",
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [] },
      proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "hero", claimId: "known", status: "knows", confidence: 1 }] },
      evidence,
    });
    expect(valid.accepted).toBe(true);
  });

  it("rejects actor-plan templates and unknown causal parents", async () => {
    const { service, evidence } = await fixture();
    const validation = await service.validate({
      id: "unwired-plan",
      kind: "actor-plan",
      title: "Hero plans something",
      preconditions: [],
      blockers: [],
      participants: ["hero"],
      causalParents: ["missing-parent"],
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [] },
      evidence,
    });
    expect(validation.accepted).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNSCHEDULABLE_ACTOR_PLAN" }),
      expect.objectContaining({ code: "UNKNOWN_CAUSAL_PARENT" }),
    ]));
  });

  it("rejects an inert player choice that cannot preserve divergence", async () => {
    const { service, evidence } = await fixture();
    const validation = await service.validate({
      id: "refuse-without-effect",
      kind: "player-choice",
      title: "Hero refuses",
      preconditions: [],
      blockers: [],
      participants: ["hero"],
      causalParents: [],
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1, operations: [] },
      evidence,
    });
    expect(validation.accepted).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: "INERT_PLAYER_CHOICE" }));
  });
});

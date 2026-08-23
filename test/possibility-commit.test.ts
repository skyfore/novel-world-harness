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
      id: "alternate-give-key",
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

  it("reserves canon-* ids for canonical-derived possibilities", async () => {
    const { service, evidence } = await fixture();
    const validation = await service.validate({
      id: "canon-manual-shadow",
      kind: "generated",
      title: "Manual shadow",
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
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: "RESERVED_POSSIBILITY_ID" }));
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

  it("accepts only source-event-preserving canonical scaffolds with validated role gates", async () => {
    const { service, evidence } = await fixture();
    const base = {
      id: "give-key-role-scaffold",
      kind: "canon-analogue" as const,
      title: "A qualified holder participates in the key event",
      candidateWindow: { kind: "unknown" as const },
      preconditions: [],
      blockers: [],
      participants: ["hero"],
      causalParents: [],
      canonicalEventId: "give-key",
      pressure: 1,
      relevance: 1,
      proposedDelta: { version: 1 as const, operations: [] },
      canonicalScaffold: {
        version: 1 as const,
        mode: "participant-remap" as const,
        roles: [{
          roleId: "holder",
          canonicalEntityId: "hero",
          description: "the character currently responsible for the key",
          allowedEntityKinds: ["character" as const],
          presence: "active-scene" as const,
          requiredState: [],
          requiresKnowledge: ["known"],
        }],
      },
      evidence,
    };
    const valid = await service.validate(base);
    expect(valid.accepted).toBe(true);

    const invalid = await service.validate({
      ...base,
      id: "forged-give-key-role-scaffold",
      causalParents: ["give-key"],
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.alive", value: false }],
      },
      canonicalScaffold: {
        ...base.canonicalScaffold,
        roles: [{ ...base.canonicalScaffold.roles[0]!, requiresKnowledge: ["missing-claim"] }],
      },
    });
    expect(invalid.accepted).toBe(false);
    expect(invalid.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCAFFOLD_EFFECT_MISMATCH" }),
      expect.objectContaining({ code: "SCAFFOLD_CAUSAL_PARENT_MISMATCH" }),
      expect.objectContaining({ code: "UNKNOWN_SCAFFOLD_ROLE_CLAIM" }),
    ]));
  });

  it("rejects a scaffold whose locked opaque effect still names the replaceable participant", async () => {
    const { service, evidence } = await fixture();
    await service.canon.putEvent({
      id: "named-plan",
      title: "Hero receives a person-specific plan",
      participants: ["hero"],
      storyTime: { kind: "unknown" },
      preconditions: [],
      observedOutcome: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "Hero remains the designated holder" }],
      },
      evidence,
      causalParents: [],
      confidence: 1,
    });
    const validation = await service.validate({
      id: "named-plan-scaffold",
      kind: "canon-analogue",
      title: "A qualified person receives the plan",
      candidateWindow: { kind: "unknown" },
      preconditions: [],
      blockers: [],
      participants: ["hero"],
      causalParents: [],
      canonicalEventId: "named-plan",
      pressure: 1,
      relevance: 1,
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "Hero remains the designated holder" }],
      },
      canonicalScaffold: {
        version: 1,
        mode: "participant-remap",
        roles: [{
          roleId: "holder",
          canonicalEntityId: "hero",
          description: "the designated holder",
          allowedEntityKinds: ["character"],
          presence: "anywhere",
          requiredState: [],
          requiresKnowledge: [],
        }],
      },
      evidence,
    });
    expect(validation.accepted).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: "SCAFFOLD_OPAQUE_ROLE_REFERENCE",
    }));
  });
});

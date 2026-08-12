import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { CompilerCommitService } from "../src/compiler/validator.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-compiler-"));
  roots.push(root);
  const source = await createEvidenceFixture(root, "曹操\nUnknown person appears\n");
  return { proposals: new CompilerProposalService(root), commits: new CompilerCommitService(root), evidence: source.evidence };
}

describe("CompilerCommitService", () => {
  it("commits an evidence-backed entity after deterministic validation", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "entity-cao",
      payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: ["孟德"], evidence: evidence("曹操") },
      generatedBy: { worker: "test" },
    });
    const validation = await commits.accept("entity", "entity-cao");
    expect(validation.accepted).toBe(true);
    await expect(commits.canon.getEntity("cao-cao")).resolves.toMatchObject({ canonicalName: "曹操" });
  });

  it("keeps an invalid event pending when it references an unknown participant", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("canonical-event", {
      proposalId: "bad-event",
      payload: {
        id: "event-1",
        title: "Unknown person appears",
        participants: ["missing-person"],
        storyTime: { kind: "unknown" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        evidence: evidence("Unknown person appears"),
        causalParents: [],
        confidence: 1,
      },
      generatedBy: { worker: "test" },
    });
    const validation = await commits.accept("canonical-event", "bad-event");
    expect(validation.accepted).toBe(false);
    expect(validation.errors.some((error) => error.code === "UNKNOWN_PARTICIPANT")).toBe(true);
    await expect(commits.canon.getEvent("event-1")).rejects.toThrow();
    await expect(commits.proposals.read("pending", "bad-event", (await import("../src/world/model.js")).canonicalEventSchema)).resolves.toMatchObject({ id: "bad-event" });
  });

  it("keeps an event with an unknown observed-knowledge claim pending", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "entity-cao",
      payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: evidence("曹操") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "entity-cao")).accepted).toBe(true);
    await proposals.submit("canonical-event", {
      proposalId: "knowledge-event",
      payload: {
        id: "cao-learns-secret",
        title: "曹操得知秘密",
        participants: ["cao-cao"],
        storyTime: { kind: "unknown" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        observedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "cao-cao", claimId: "missing-claim", status: "knows", confidence: 1 }] },
        evidence: evidence("曹操"),
        causalParents: [],
        confidence: 1,
      },
      generatedBy: { worker: "test" },
    });
    const validation = await commits.accept("canonical-event", "knowledge-event");
    expect(validation.accepted).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: "UNKNOWN_KNOWLEDGE_CLAIM" }));
  });

  it("does not misreport a blocked canonical proposal as staging", async () => {
    const { proposals, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "place",
      payload: { id: "north-gate", kind: "location", canonicalName: "北门", aliases: [], evidence: evidence("曹操") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("world-rule", {
      proposalId: "bad-rule",
      payload: {
        id: "bad-rule",
        name: "Location uses a character-only field",
        scope: "location",
        appliesWhen: [{ op: "fact-exists", entityId: "north-gate", field: "character.alive" }],
        evidence: evidence("曹操"),
      },
      generatedBy: { worker: "test" },
    });

    const result = await convergeWorldProposals(roots.at(-1)!);
    expect(result.canonical.blocked).toMatchObject([{ id: "bad-rule", kind: "world-rule" }]);
    expect(result.canonical.blocked[0]?.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INERT_WORLD_RULE" }),
      expect.objectContaining({ code: "INVALID_PREDICATE_FIELD" }),
    ]));
    expect(result.staging).not.toContainEqual({ id: "bad-rule", kind: "world-rule" });
  });

  it("rejects self-forbidding rules at the deterministic commit boundary", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "gate",
      payload: { id: "north-gate", kind: "location", canonicalName: "北门", aliases: [], evidence: evidence("曹操") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "gate")).accepted).toBe(true);
    const condition = { op: "fact-equals" as const, entityId: "north-gate", field: "location.open", value: true };
    await proposals.submit("world-rule", {
      proposalId: "self-forbidding-rule",
      payload: {
        id: "self-forbidding-rule",
        name: "门开时禁止门开",
        scope: "location",
        appliesWhen: [condition],
        forbids: [condition],
        evidence: evidence("曹操"),
      },
      generatedBy: { worker: "test" },
    });

    const validation = await commits.accept("world-rule", "self-forbidding-rule");
    expect(validation.accepted).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: "SELF_FORBIDDING_WORLD_RULE" }));
  });
});

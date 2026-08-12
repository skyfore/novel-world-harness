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
    expect(result.staging).not.toContainEqual({ id: "bad-rule", kind: "world-rule" });
  });
});

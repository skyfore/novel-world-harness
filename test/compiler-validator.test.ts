import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { CompilerCommitService } from "../src/compiler/validator.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function evidence() {
  return [{ span: { sourceId: "novel", startLine: 1, endLine: 1, quoteHash: crypto.createHash("sha256").update("曹操").digest("hex") }, strength: "explicit" as const }];
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-compiler-"));
  roots.push(root);
  return { proposals: new CompilerProposalService(root), commits: new CompilerCommitService(root) };
}

describe("CompilerCommitService", () => {
  it("commits an evidence-backed entity after deterministic validation", async () => {
    const { proposals, commits } = await fixture();
    await proposals.submit("entity", {
      proposalId: "entity-cao",
      payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: ["孟德"], evidence: evidence() },
      generatedBy: { worker: "test" },
    });
    const validation = await commits.accept("entity", "entity-cao");
    expect(validation.accepted).toBe(true);
    await expect(commits.canon.getEntity("cao-cao")).resolves.toMatchObject({ canonicalName: "曹操" });
  });

  it("keeps an invalid event pending when it references an unknown participant", async () => {
    const { proposals, commits } = await fixture();
    await proposals.submit("canonical-event", {
      proposalId: "bad-event",
      payload: {
        id: "event-1",
        title: "Unknown person appears",
        participants: ["missing-person"],
        storyTime: { kind: "unknown" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        evidence: evidence(),
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
});

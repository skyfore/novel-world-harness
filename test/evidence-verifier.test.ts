import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { CompilerCommitService } from "../src/compiler/validator.js";
import { EvidenceVerifier } from "../src/compiler/evidence.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("compiler evidence verification", () => {
  it("rejects a previously valid proposal after the registered source changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-evidence-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero appears.\n");
    const proposals = new CompilerProposalService(root);
    const commits = new CompilerCommitService(root);
    await proposals.submit("entity", {
      proposalId: "hero",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero appears.") },
      generatedBy: { worker: "test" },
    });
    await fs.writeFile(path.join(root, fixture.source.sourcePath), "Hero disappears.\n", "utf8");
    const result = await commits.accept("entity", "hero");
    expect(result.accepted).toBe(false);
    expect(result.errors.some((error) => error.code === "EVIDENCE_SOURCE_CHANGED")).toBe(true);
  });

  it("does not reuse a stale source buffer across verification calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-evidence-cache-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero appears.\n");
    const evidence = fixture.evidence("Hero appears.")[0]!;
    const verifier = new EvidenceVerifier(root);
    expect((await verifier.verify(evidence)).valid).toBe(true);
    await fs.writeFile(path.join(root, fixture.source.sourcePath), "Hero disappears.\n", "utf8");
    const changed = await verifier.verify(evidence);
    expect(changed.valid).toBe(false);
    expect(changed.issues.some((error) => error.code === "EVIDENCE_SOURCE_CHANGED")).toBe(true);
  });
});

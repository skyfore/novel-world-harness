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
  it("keeps proposals bound to the immutable archived source after the origin file changes", async () => {
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
    expect(result.accepted).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("continues verifying the archived bytes when the disposable origin changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-evidence-cache-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero appears.\n");
    const evidence = fixture.evidence("Hero appears.")[0]!;
    const verifier = new EvidenceVerifier(root);
    expect((await verifier.verify(evidence)).valid).toBe(true);
    await fs.writeFile(path.join(root, fixture.source.sourcePath), "Hero disappears.\n", "utf8");
    const changed = await verifier.verify(evidence);
    expect(changed.valid).toBe(true);
    expect(changed.issues).toEqual([]);
  });

  it("returns only text backed by verified evidence spans", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-evidence-inspection-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "曹操，字孟德。\n");
    const verifier = new EvidenceVerifier(root);

    const inspected = await verifier.inspectAll(fixture.evidence("曹操，字孟德"));

    expect(inspected).toMatchObject({ valid: true, issues: [], excerpts: ["曹操，字孟德"] });
  });
});

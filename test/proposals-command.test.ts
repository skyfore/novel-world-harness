import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdout } from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rejectProposalCommand, showProposalCommand } from "../src/commands/proposals.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { ProposalStore } from "../src/world/canonical-model.js";
import { withWorkspaceOperationLock } from "../src/util/workspace-lock.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("proposal review command", () => {
  it("refuses manual rejection while a compiler owns the workspace, then rejects after release", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-reject-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Ada waits.");
    await new CompilerProposalService(root).submit("entity", {
      proposalId: "pending-ada", payload: { id: "ada", kind: "character", canonicalName: "Ada", aliases: [], evidence: fixture.evidence("Ada") },
      generatedBy: { worker: "test" },
    });
    const proposals = new ProposalStore(root);
    await withWorkspaceOperationLock(root, "compiler", async () => {
      await expect(rejectProposalCommand(root, "pending-ada")).rejects.toThrow("already active");
      expect((await proposals.list("pending", fixture.source.id)).map(p => p.id)).toEqual(["pending-ada"]);
      expect(await proposals.list("rejected", fixture.source.id)).toEqual([]);
    });
    vi.spyOn(stdout, "write").mockReturnValue(true);
    await rejectProposalCommand(root, "pending-ada");
    expect((await proposals.list("rejected", fixture.source.id)).map(p => p.id)).toEqual(["pending-ada"]);
    expect(await proposals.list("pending", fixture.source.id)).toEqual([]);
  });
  it("shows the complete pending payload and evidence needed for informed review", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-proposal-show-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "林岐来到前厅。\n");
    await new CompilerProposalService(root).submit("entity", {
      proposalId: "entity-linqi",
      payload: {
        id: "linqi",
        kind: "character",
        canonicalName: "林岐",
        aliases: [],
        evidence: fixture.evidence("林岐来到前厅。"),
      },
      generatedBy: { worker: "test" },
    });
    let output = "";
    vi.spyOn(stdout, "write").mockImplementation(((value: string | Uint8Array) => {
      output += String(value);
      return true;
    }) as typeof stdout.write);

    await showProposalCommand(root, "entity-linqi");

    expect(output).toContain('"canonicalName": "林岐"');
    expect(output).toContain('"quoteHash"');
    expect(output).toContain('"startLine"');
  });
});

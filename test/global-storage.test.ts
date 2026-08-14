import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceStateDir } from "../src/agent/runtime-paths.js";
import { auditCompiler } from "../src/compiler/audit.js";
import { EvidenceVerifier } from "../src/compiler/evidence.js";
import { readSourceMaterial, SourceMaterialStore } from "../src/storage/source-material-store.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("user-level source and world storage", () => {
  it("keeps source evidence and branch truth usable after the origin and workspace are deleted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-global-world-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero opens the gate.\n", "novel.txt");
    const evidence = fixture.evidence("Hero opens the gate.")[0]!;
    const archived = await readSourceMaterial(root, fixture.source);
    expect(archived.toString("utf8")).toBe("Hero opens the gate.\n");
    const materialStat = await fs.stat(path.join(new SourceMaterialStore().root, fixture.source.contentSha256, "source.utf8"));
    expect(materialStat.mode & 0o222).toBe(0);
    await expect(fs.stat(path.join(root, ".novel-harness"))).rejects.toMatchObject({ code: "ENOENT" });

    const world = await openWorkspaceWorld(root);
    const genesis = await world.engine.createBranch("main", "main");
    await fs.rm(path.join(root, fixture.source.sourcePath));

    await expect(new EvidenceVerifier(root).verify(evidence)).resolves.toMatchObject({ valid: true, issues: [] });
    await expect(auditCompiler(root, { sourceId: fixture.source.id })).resolves.toMatchObject({
      sources: { registered: 1, changedSinceIngest: [] },
      evidence: { invalidReferences: 0 },
    });

    await fs.rm(root, { recursive: true, force: true });
    const reopened = await openWorkspaceWorld(root);
    await expect(reopened.engine.branches.readHead("main")).resolves.toBe(genesis);
    expect(workspaceStateDir(root)).not.toContain(`${path.sep}.novel-harness${path.sep}`);
  });
});

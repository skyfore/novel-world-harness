import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CanonicalCompiler, CanonicalModelStore, ProposalStore } from "../src/world/canonical-model.js";
import { entitySchema, type ArtifactProposal, type Entity } from "../src/world/model.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-canon-"));
  roots.push(root);
  const proposals = new ProposalStore(root);
  const canon = new CanonicalModelStore(root);
  return { root, proposals, canon, compiler: new CanonicalCompiler(proposals, canon) };
}

describe("canonical proposal boundary", () => {
  it("moves a typed proposal into immutable canonical truth only after acceptance", async () => {
    const { proposals, canon, compiler } = await fixture();
    const entity: Entity = { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: ["孟德"], evidence: [] };
    const proposal: ArtifactProposal<Entity> = {
      id: "entity-cao-cao",
      kind: "entity",
      schemaVersion: 1,
      payload: entity,
      evidence: [],
      generatedBy: { worker: "fixture" },
      createdAt: new Date(0).toISOString(),
    };
    await proposals.writePending(proposal, entitySchema);
    await expect(canon.getEntity("cao-cao")).rejects.toThrow();

    await expect(compiler.acceptEntity(proposal.id)).resolves.toEqual(entity);
    await expect(canon.getEntity("cao-cao")).resolves.toEqual(entity);
    await expect(proposals.read("accepted", proposal.id, entitySchema)).resolves.toMatchObject({ id: proposal.id });
  });

  it("refuses to silently overwrite a committed canonical identity", async () => {
    const { canon } = await fixture();
    await canon.putEntity({ id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: [] });
    await expect(
      canon.putEntity({ id: "cao-cao", kind: "character", canonicalName: "另一个人", aliases: [], evidence: [] }),
    ).rejects.toThrow("different content");
  });
});

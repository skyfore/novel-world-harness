import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CanonicalModelStore } from "../src/world/canonical-model.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("CanonicalModelStore revisions", () => {
  it("moves a logical ref to a new immutable revision without deleting history", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-canon-revision-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] });
    const first = await canon.currentRevision("entities", "hero");
    expect(first).not.toBeNull();

    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: ["The Hero"], evidence: [] });
    const second = await canon.currentRevision("entities", "hero");
    expect(second).not.toBeNull();
    expect(second?.hash).not.toBe(first?.hash);
    expect((await canon.getEntity("hero")).aliases).toEqual(["The Hero"]);

    const revisions = await canon.listRevisions("entities", "hero");
    expect(revisions).toHaveLength(2);
    expect(revisions.map((revision) => revision.hash)).toContain(first?.hash);
    expect(revisions.map((revision) => revision.hash)).toContain(second?.hash);
  });
});


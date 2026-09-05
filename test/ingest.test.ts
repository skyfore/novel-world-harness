import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestCommand } from "../src/commands/ingest.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("ingest command", () => {
  it("persists default project state and evidence segments without a config file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-ingest-"));
    roots.push(root);
    const novel = path.join(root, "novel.txt");
    await fs.writeFile(novel, "第一章\n人物进入城池。\n", "utf8");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await ingestCommand(novel, path.join(root, "novel-harness.yaml"), path.join(root, "prepared-cache"));

    const store = await WorkspaceStore.create(root);
    await expect(store.readProject()).resolves.toMatchObject({
      name: path.basename(root),
      language: "zh-CN",
    });
    const [source] = await store.listSources();
    expect(source).toBeDefined();
    await expect(new SegmentStore(root).readManifest(source!.id)).resolves.toMatchObject({ sourceId: source!.id });
  });

  it("rejects one physical file being both trusted guidance and novel evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-ingest-trust-conflict-"));
    roots.push(root);
    const guidance = path.join(root, "NWH.md");
    await fs.writeFile(guidance, "This text cannot change trust roles mid-session.\n", "utf8");
    await fs.writeFile(
      path.join(root, "novel-harness.yaml"),
      "version: 1\nproject:\n  name: trust-conflict\n  instructions:\n    - NWH.md\n",
      "utf8",
    );

    await expect(ingestCommand(guidance, path.join(root, "novel-harness.yaml")))
      .rejects.toThrow("configured as trusted project guidance");
    await expect((await WorkspaceStore.create(root)).listSources()).resolves.toEqual([]);
  });
});

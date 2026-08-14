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
});

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { legacyWorkspaceStateDir, workspaceStateDir } from "../src/agent/runtime-paths.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";
import { SourceMaterialStore } from "../src/storage/source-material-store.js";

const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-store-"));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, "chapters"));
  await fs.writeFile(path.join(root, "chapters", "one.md"), "第一章\n曹操进入大厅。\n", "utf8");
  return { root, store: await WorkspaceStore.create(root) };
}

afterEach(async () => {
  for (const root of temporaryDirectories.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("WorkspaceStore", () => {
  it("can persist provider-neutral default project metadata", async () => {
    const { root, store } = await fixture();

    const project = await store.ensureProject();

    expect(project).toMatchObject({
      id: path.basename(root).toLowerCase(),
      name: path.basename(root),
      language: "zh-CN",
    });
    await expect(store.readProject()).resolves.toMatchObject({ id: project.id, name: project.name });
  });

  it("keeps project and content-addressed source manifests in idempotent user-level files", async () => {
    const { root, store } = await fixture();
    const project = await store.ensureProject({ name: "三国世界", language: "zh-CN" });
    const first = await store.registerSource(path.join(root, "chapters", "one.md"));
    const second = await store.registerSource(path.join(root, "chapters", "one.md"));

    expect(project.id).toBe("三国世界");
    expect(first.id).toBe(second.id);
    expect(await store.listSources()).toHaveLength(1);
    const stat = await fs.stat(path.join(workspaceStateDir(root), "sources", `${first.id}.json`));
    expect(stat.mode & 0o077).toBe(0);
    await expect(fs.stat(legacyWorkspaceStateDir(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies legacy local state into the user store without deleting the original", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-store-migration-"));
    temporaryDirectories.push(root);
    const legacy = legacyWorkspaceStateDir(root);
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, "project.json"), JSON.stringify({
      version: 1,
      id: "legacy",
      name: "Legacy",
      language: "zh-CN",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }), "utf8");
    const sourceContent = Buffer.from("Legacy source.\n", "utf8");
    const sha = crypto.createHash("sha256").update(sourceContent).digest("hex");
    const sourceId = sha.slice(0, 20);
    await fs.writeFile(path.join(root, "legacy.txt"), sourceContent);
    await fs.mkdir(path.join(legacy, "sources"), { recursive: true });
    await fs.writeFile(path.join(legacy, "sources", `${sourceId}.json`), JSON.stringify({
      version: 1,
      id: sourceId,
      title: "legacy.txt",
      sourcePath: "legacy.txt",
      contentSha256: sha,
      bytes: sourceContent.byteLength,
      registeredAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }), "utf8");

    const store = await WorkspaceStore.create(root);

    await expect(store.readProject()).resolves.toMatchObject({ id: "legacy" });
    await expect(fs.stat(path.join(workspaceStateDir(root), "project.json"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(legacy, "project.json"))).resolves.toBeDefined();
    await expect(fs.readFile(path.join(new SourceMaterialStore().root, sha, "source.utf8"))).resolves.toEqual(sourceContent);
  });

  it("requires source material to stay inside the workspace", async () => {
    const { store } = await fixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-outside-source-"));
    temporaryDirectories.push(outside);
    const source = path.join(outside, "novel.md");
    await fs.writeFile(source, "outside", "utf8");
    await expect(store.registerSource(source)).rejects.toThrow("inside the novel workspace");
  });
});

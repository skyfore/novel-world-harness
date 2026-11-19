import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceStateDir } from "../src/agent/runtime-paths.js";
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
    await expect(fs.stat(path.join(root, ".novel-harness"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not guess a novel title from front-matter patterns during ingest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-store-title-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "opaque-upload-name.txt");
    await fs.writeFile(filePath, "《活着》\n作者：余华\n\n第一章\n福贵回到村里。\n", "utf8");

    const source = await (await WorkspaceStore.create(root)).registerSource(filePath);

    expect(source.title).toBe("opaque-upload-name.txt");
    expect(source.titleInference).toBeUndefined();
    expect(source.sourcePath).toBe("opaque-upload-name.txt");
    await expect((await WorkspaceStore.create(root)).getSource(source.id)).resolves.toMatchObject({
      title: "opaque-upload-name.txt",
      sourcePath: "opaque-upload-name.txt",
    });
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

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "../src/storage/workspace-store.js";

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
  it("keeps project, source, jobs and metrics in idempotent local files", async () => {
    const { root, store } = await fixture();
    const project = await store.ensureProject({ name: "三国世界", language: "zh-CN" });
    const first = await store.registerSource(path.join(root, "chapters", "one.md"));
    const second = await store.registerSource(path.join(root, "chapters", "one.md"));
    const firstJob = await store.enqueueJob("segment-source", { documentId: first.id }, 1, "document", first.id);
    const duplicateJob = await store.enqueueJob("segment-source", { documentId: first.id }, 1, "document", first.id);

    expect(project.id).toBe("三国世界");
    expect(first.id).toBe(second.id);
    expect(await store.listSources()).toHaveLength(1);
    expect(firstJob.id).toBe(duplicateJob.id);

    const claimed = await store.claimNextJob();
    expect(claimed?.status).toBe("running");
    await store.finishJob(claimed!.id, { ok: true });
    expect((await store.listJobs())[0]?.status).toBe("done");

    await store.writeMetric("source", 0.25, { source: first.sourcePath });
    expect((await store.readMetrics()).source).toBe(0.25);
    const stat = await fs.stat(path.join(root, ".novel-harness", "metrics.json"));
    expect(stat.mode & 0o077).toBe(0);
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

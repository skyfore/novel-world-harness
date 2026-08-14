import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { legacyWorkspaceStateDir, workspaceStateDir } from "../src/agent/runtime-paths.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";
import { WorkspaceOperationLock, withWorkspaceOperationLock } from "../src/util/workspace-lock.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("workspace operation lock", () => {
  it("rejects concurrent compiler writers and releases after completion", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-workspace-lock-"));
    roots.push(root);
    const first = await WorkspaceOperationLock.acquire(root, "compiler");

    await expect(WorkspaceOperationLock.acquire(root, "compiler"))
      .rejects.toThrow("Another compiler operation is already active");

    await first.release();
    await expect(withWorkspaceOperationLock(root, "compiler", async () => "completed"))
      .resolves.toBe("completed");
  });

  it("recovers a lock owned by a process that no longer exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-workspace-stale-lock-"));
    roots.push(root);
    const lockPath = path.join(workspaceStateDir(root), "locks", "compiler.lock");
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      token: "stale",
      startedAt: new Date(0).toISOString(),
    }));

    const recovered = await WorkspaceOperationLock.acquire(root, "compiler");
    await recovered.release();

    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates legacy state before the first global compiler lock is created", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-workspace-lock-migrate-"));
    roots.push(root);
    const legacy = legacyWorkspaceStateDir(root);
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, "project.json"), JSON.stringify({
      version: 1,
      id: "legacy-lock",
      name: "Legacy Lock",
      language: "zh-CN",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }), "utf8");

    const lock = await WorkspaceOperationLock.acquire(root, "compiler");
    await lock.release();

    await expect((await WorkspaceStore.create(root)).readProject()).resolves.toMatchObject({ id: "legacy-lock" });
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { legacyWorkspaceStateDir, workspaceStateDir } from "../src/agent/runtime-paths.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";
import { WorkspaceOperationLock, withWorkspaceOperationLock } from "../src/util/workspace-lock.js";
import { withCompilerSignals } from "../src/util/compiler-signals.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("workspace operation lock", () => {
  it("unwinds a SIGTERM through lock release and removes signal handlers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-lock-signal-")); roots.push(root);
    const before = process.listenerCount("SIGTERM");
    await expect(withCompilerSignals((signal) => withWorkspaceOperationLock(root, "compiler", async () => {
      process.emit("SIGTERM");
      signal.throwIfAborted();
    }))).rejects.toThrow("interrupted by SIGTERM");
    expect(process.listenerCount("SIGTERM")).toBe(before);
    const replacement = await WorkspaceOperationLock.acquire(root, "compiler");
    await replacement.release();
  });
  it.runIf(process.platform === "linux")("refuses live owners, stale tokens, and unverified legacy PID views", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-lock-recovery-")); roots.push(root);
    const lock = await WorkspaceOperationLock.acquire(root, "compiler");
    const { owner } = await WorkspaceOperationLock.inspect(root);
    await expect(WorkspaceOperationLock.recover(root, "wrong")).rejects.toThrow("owner changed");
    await expect(WorkspaceOperationLock.recover(root, owner!.token)).rejects.toThrow("still alive");
    await lock.release();
    const { lockPath } = await WorkspaceOperationLock.inspect(root);
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ version: 1, pid: 2_147_483_647, token: "legacy", startedAt: new Date(0).toISOString() }));
    await expect(WorkspaceOperationLock.recover(root, "legacy")).rejects.toThrow("Legacy compiler lock");
    const result = await WorkspaceOperationLock.recover(root, "legacy", true);
    expect(JSON.parse(await fs.readFile(path.join(result.archivePath, "owner.json"), "utf8")).token).toBe("legacy");
    expect(JSON.parse(await fs.readFile(path.join(result.archivePath, "recovery.json"), "utf8")).legacyOwnerHostVerified).toBe(true);
    const replacement = await WorkspaceOperationLock.acquire(root, "compiler");
    await expect(WorkspaceOperationLock.recover(root, "legacy", true)).rejects.toThrow("owner changed");
    await replacement.release();
  });

  it.runIf(process.platform === "linux")("serializes racing recoverers and refuses a foreign namespace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-lock-racing-recovery-")); roots.push(root);
    const lock = await WorkspaceOperationLock.acquire(root, "compiler");
    const { lockPath, owner } = await WorkspaceOperationLock.inspect(root);
    await lock.release();
    await fs.mkdir(lockPath);
    const stale = { ...owner!, pid: 2_147_483_647 };
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ ...stale, host: { ...stale.host, pidNamespace: "foreign" } }));
    await expect(WorkspaceOperationLock.recover(root, stale.token)).rejects.toThrow("namespace differs");
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(stale));
    const results = await Promise.allSettled([WorkspaceOperationLock.recover(root, stale.token), WorkspaceOperationLock.recover(root, stale.token)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const replacement = await WorkspaceOperationLock.acquire(root, "compiler");
    await replacement.release();
  });
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

  it("does not automatically steal a lock owned by a process that no longer exists", async () => {
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

    await expect(WorkspaceOperationLock.acquire(root, "compiler"))
      .rejects.toThrow("stale compiler lock");
    await expect(fs.stat(lockPath)).resolves.toBeDefined();
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

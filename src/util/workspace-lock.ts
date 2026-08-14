import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureWorkspaceState, workspaceStateDir } from "../agent/runtime-paths.js";

type WorkspaceLockOwner = {
  version: 1;
  pid: number;
  token: string;
  startedAt: string;
};

const INITIALIZING_GRACE_MS = 30_000;

export class WorkspaceOperationLock {
  private released = false;

  private constructor(
    private readonly lockPath: string,
    private readonly owner: WorkspaceLockOwner,
  ) {}

  static async acquire(workspaceRoot: string, operation: string): Promise<WorkspaceOperationLock> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(operation)) throw new Error(`Unsafe workspace lock name: ${operation}`);
    await ensureWorkspaceState(workspaceRoot);
    const lockPath = path.join(workspaceStateDir(workspaceRoot), "locks", `${operation}.lock`);
    await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

    for (;;) {
      const owner: WorkspaceLockOwner = {
        version: 1,
        pid: process.pid,
        token: crypto.randomUUID(),
        startedAt: new Date().toISOString(),
      };
      try {
        await fs.mkdir(lockPath, { mode: 0o700 });
        await fs.writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        return new WorkspaceOperationLock(lockPath, owner);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const existing = await readOwner(lockPath);
      if (existing && processIsAlive(existing.pid)) {
        throw new Error(
          `Another compiler operation is already active in this workspace (pid ${existing.pid}, started ${existing.startedAt}). Wait for it to finish before retrying.`,
        );
      }
      if (!existing) {
        const stat = await fs.stat(lockPath).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs < INITIALIZING_GRACE_MS) {
          throw new Error("Another compiler operation is initializing in this workspace. Wait briefly before retrying.");
        }
      }

      const stalePath = `${lockPath}.stale-${crypto.randomUUID()}`;
      try {
        await fs.rename(lockPath, stalePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await fs.rm(stalePath, { recursive: true, force: true });
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const current = await readOwner(this.lockPath);
    if (current?.token !== this.owner.token) return;
    await fs.rm(this.lockPath, { recursive: true, force: true });
  }
}

export async function withWorkspaceOperationLock<T>(
  workspaceRoot: string,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  const lock = await WorkspaceOperationLock.acquire(workspaceRoot, operation);
  try {
    return await run();
  } finally {
    await lock.release();
  }
}

async function readOwner(lockPath: string): Promise<WorkspaceLockOwner | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as Partial<WorkspaceLockOwner>;
    if (
      value.version !== 1
      || !Number.isInteger(value.pid)
      || (value.pid ?? 0) <= 0
      || typeof value.token !== "string"
      || typeof value.startedAt !== "string"
    ) return undefined;
    return value as WorkspaceLockOwner;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { ensureWorkspaceState, workspaceStateDir } from "../agent/runtime-paths.js";

export type WorkspaceLockOwner = {
  version: 1;
  pid: number;
  token: string;
  startedAt: string;
  host?: { hostname: string; bootId: string; pidNamespace: string };
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

    const owner: WorkspaceLockOwner = {
      version: 1,
      pid: process.pid,
      token: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      ...(process.platform === "linux" ? { host: await linuxHostIdentity() } : {}),
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

    // Filesystem rename/delete does not provide a portable compare-and-delete primitive.
    // Never steal a lock automatically: a contender that observed a stale owner could
    // otherwise rename a replacement lock created by another process after that read.
    const detail = existing
      ? `pid ${existing.pid}, started ${existing.startedAt}`
      : "owner metadata is missing or invalid";
    throw new Error(
      `Workspace has a stale compiler lock (${detail}). Run nwh compiler-lock inspect on the owning host, then nwh compiler-lock recover --owner-token <exact owner.token>. Do not retry compilation before host recovery.`,
    );
  }

  static async inspect(workspaceRoot: string): Promise<{ lockPath: string; owner: WorkspaceLockOwner | undefined }> {
    const lockPath = path.join(workspaceStateDir(workspaceRoot), "locks", "compiler.lock");
    return { lockPath, owner: await readOwner(lockPath) };
  }

  /** Host-only recovery. Normal acquisition never steals a lock. */
  static async recover(workspaceRoot: string, expectedToken: string, legacyOwnerHostVerified = false): Promise<{ archivePath: string }> {
    if (process.platform !== "linux") throw new Error("Compiler lock recovery requires Linux flock on the owning host. Do not delete the lock or retry from another host.");
    const { lockPath } = await this.inspect(workspaceRoot);
    // Serialize recoverers with a kernel lock, not another reclaimable mkdir
    // lock. The mutex inode must never be removed, even after recovery.
    return withRecoveryMutex(path.join(path.dirname(lockPath), "compiler-recovery.mutex"), async () => {
      const owner = await readOwner(lockPath);
      if (!owner || owner.token !== expectedToken) throw new Error("Compiler lock owner changed or metadata is invalid. Run nwh compiler-lock inspect and copy owner.token; do not guess or reuse an earlier token.");
      const host = await linuxHostIdentity();
      if (owner.host) {
        if (owner.host.hostname !== host.hostname || owner.host.bootId !== host.bootId || owner.host.pidNamespace !== host.pidNamespace) {
          throw new Error("Compiler lock host/boot/PID namespace differs. Recovery must run in the verified owning host context; do not retry in this namespace.");
        }
      } else if (!legacyOwnerHostVerified) {
        throw new Error("Legacy compiler lock has no host identity. Verify the owner PID on its original host, then use --legacy-owner-host-verified there; absence in a sandbox PID view is not proof. Do not delete the lock.");
      }
      if (processIsAlive(owner.pid)) throw new Error(`Compiler lock owner pid ${owner.pid} is still alive. Do not recover or retry until that process has exited.`);
      const archives = path.join(path.dirname(lockPath), "recovered");
      await fs.mkdir(archives, { recursive: true, mode: 0o700 });
      const archivePath = path.join(archives, `compiler-${crypto.randomUUID()}.lock`);
      // Every supported recoverer holds the mutex. The dead owner cannot
      // release, and ordinary acquirers cannot replace an existing directory.
      // Rename is the sole transition: never delete anything at lockPath after
      // it, because a waiting acquirer may already own a replacement lock.
      const current = await readOwner(lockPath);
      if (JSON.stringify(current) !== JSON.stringify(owner) || processIsAlive(owner.pid)) {
        throw new Error("Compiler lock changed during recovery. Stop and inspect the owning host again.");
      }
      await fs.writeFile(path.join(lockPath, "recovery.json"), `${JSON.stringify({
        version: 1, recoveredAt: new Date().toISOString(), recoveredByPid: process.pid,
        host, owner, legacyOwnerHostVerified, archivePath,
      }, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(lockPath, archivePath);
      return { archivePath };
    });
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
      || (value.host !== undefined && (typeof value.host !== "object" || value.host === null
        || typeof value.host.hostname !== "string" || typeof value.host.bootId !== "string" || typeof value.host.pidNamespace !== "string"))
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
    // Unknown/permission errors are not evidence of death.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function linuxHostIdentity(): Promise<NonNullable<WorkspaceLockOwner["host"]>> {
  return { hostname: os.hostname(), bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), pidNamespace: await fs.readlink("/proc/self/ns/pid") };
}

async function withRecoveryMutex<T>(file: string, run: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // EOF releases the kernel lock even if the parent dies without a finally.
  const child = spawn("flock", ["--exclusive", "--wait", "10", "--no-fork", file,
    "/bin/sh", "-c", "printf 'locked\\n'; exec cat >/dev/null"],
  { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  let diagnostic = "";
  child.stderr.on("data", (chunk: Buffer) => { diagnostic += chunk.toString(); });
  const exited = new Promise<void>((resolve) => { child.once("close", () => resolve()); });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", (error) => reject(new Error(`Compiler recovery mutex unavailable: ${error.message}. Install flock on the owning host; do not delete the lock.`)));
      child.once("exit", (code) => reject(new Error(`Compiler recovery mutex failed (${code}): ${diagnostic}. Another recovery may be active; inspect before retrying.`)));
      child.stdout.once("data", () => resolve());
    });
    return await run();
  } finally {
    child.stdin.end();
    await exited;
  }
}

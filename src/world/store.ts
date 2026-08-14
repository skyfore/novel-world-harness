import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { z } from "zod";
import { canonicalJson, assertContentHash, contentHash } from "./canonical.js";
import {
  branchSchema,
  committedEventSchema,
  knowledgeDeltaSchema,
  stateDeltaSchema,
  worldCommitSchema,
  type Branch,
  type BranchId,
  type CommitId,
  type CommittedEvent,
  type KnowledgeDelta,
  type ObjectHash,
  type StateDelta,
  type WorldCommit,
} from "./model.js";

const WORLD_STORAGE_VERSION = "v1";
const BRANCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
type ObjectKind = "deltas" | "knowledge" | "events" | "commits";
type Schema<T> = z.ZodType<T>;
type BranchHead = { version: 1; commitId: CommitId; updatedAt: string };
type BranchLock = { version: 1; pid: number; hostname: string; createdAt: string };
export type BranchLockStatus = { present: boolean; stale: boolean; metadata?: BranchLock };

function assertBranchId(id: string): void {
  if (!BRANCH_ID.test(id)) throw new Error(`Invalid branch id: ${id}`);
}
async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}
async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}
async function writeImmutable(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.readFile(filePath, "utf8");
    if (existing !== content) throw new Error(`Immutable object collision at ${filePath}`);
  }
}

export class WorldObjectStore {
  readonly root: string;
  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceRoot, ".novel-harness", "world", WORLD_STORAGE_VERSION);
  }
  putDelta(delta: StateDelta): Promise<ObjectHash> {
    return this.put("deltas", stateDeltaSchema, delta);
  }
  putKnowledgeDelta(delta: KnowledgeDelta): Promise<ObjectHash> {
    return this.put("knowledge", knowledgeDeltaSchema, delta);
  }
  putEvent(event: CommittedEvent): Promise<ObjectHash> {
    return this.put("events", committedEventSchema, event);
  }
  putCommit(commit: WorldCommit): Promise<CommitId> {
    return this.put("commits", worldCommitSchema, commit);
  }
  getDelta(hash: ObjectHash): Promise<StateDelta> {
    return this.get("deltas", stateDeltaSchema, hash);
  }
  getKnowledgeDelta(hash: ObjectHash): Promise<KnowledgeDelta> {
    return this.get("knowledge", knowledgeDeltaSchema, hash);
  }
  getEvent(hash: ObjectHash): Promise<CommittedEvent> {
    return this.get("events", committedEventSchema, hash);
  }
  getCommit(hash: CommitId): Promise<WorldCommit> {
    return this.get("commits", worldCommitSchema, hash);
  }
  private async put<T>(kind: ObjectKind, schema: Schema<T>, input: T): Promise<ObjectHash> {
    const value = schema.parse(input);
    const hash = contentHash(value);
    await writeImmutable(this.objectPath(kind, hash), `${canonicalJson(value)}\n`);
    return hash;
  }
  private async get<T>(kind: ObjectKind, schema: Schema<T>, hash: ObjectHash): Promise<T> {
    assertContentHash(hash);
    const value = schema.parse(await readJson<unknown>(this.objectPath(kind, hash)));
    if (contentHash(value) !== hash) throw new Error(`Corrupt ${kind} object: ${hash}`);
    return value;
  }
  private objectPath(kind: ObjectKind, hash: ObjectHash): string {
    assertContentHash(hash);
    return path.join(this.root, "objects", kind, `${hash}.json`);
  }
}

export class BranchStore {
  readonly root: string;
  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceRoot, ".novel-harness", "world", WORLD_STORAGE_VERSION, "branches");
  }
  async create(input: Branch): Promise<Branch> {
    const branch = branchSchema.parse(input);
    assertBranchId(branch.id);
    const directory = this.branchDirectory(branch.id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const branchPath = path.join(directory, "branch.json");
    try {
      await fs.writeFile(branchPath, `${JSON.stringify(branch, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error(`Branch already exists: ${branch.id}`);
    }
    await this.writeHead(branch.id, branch.headCommitId);
    return branch;
  }
  async read(id: BranchId): Promise<Branch> {
    assertBranchId(id);
    const branch = branchSchema.parse(await readJson<unknown>(path.join(this.branchDirectory(id), "branch.json")));
    return { ...branch, headCommitId: await this.readHead(id) };
  }
  async listIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && BRANCH_ID.test(entry.name)).map((entry) => entry.name).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  async readHead(id: BranchId): Promise<CommitId> {
    assertBranchId(id);
    const head = await readJson<BranchHead>(path.join(this.branchDirectory(id), "head.json"));
    if (head.version !== 1 || typeof head.commitId !== "string") throw new Error(`Invalid branch head: ${id}`);
    assertContentHash(head.commitId);
    return head.commitId;
  }
  async updateHead(id: BranchId, expected: CommitId, next: CommitId): Promise<void> {
    assertBranchId(id);
    assertContentHash(expected);
    assertContentHash(next);
    await this.withLock(id, async () => {
      const current = await this.readHead(id);
      if (current !== expected) throw new Error(`Stale branch head for ${id}: expected ${expected}, found ${current}`);
      await this.writeHead(id, next);
    });
  }
  async withLock<T>(id: BranchId, fn: () => Promise<T>): Promise<T> {
    assertBranchId(id);
    const directory = this.branchDirectory(id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = path.join(directory, "lock");
    let handle: fs.FileHandle | undefined;
    try {
      handle = await this.acquireLock(id, lockPath);
      return await fn();
    } finally {
      await handle?.close();
      if (handle) await fs.rm(lockPath, { force: true });
    }
  }
  async inspectLock(id: BranchId): Promise<BranchLockStatus> {
    assertBranchId(id);
    const lockPath = path.join(this.branchDirectory(id), "lock");
    try {
      const raw = await fs.readFile(lockPath, "utf8");
      let metadata: BranchLock | undefined;
      try {
        const value = JSON.parse(raw) as BranchLock;
        if (value.version === 1 && Number.isInteger(value.pid) && value.pid > 0 && typeof value.hostname === "string" && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))) metadata = value;
      } catch {
        // A process may be between exclusive create and metadata write.
      }
      return { present: true, stale: await this.isStaleLock(lockPath, metadata), ...(metadata ? { metadata } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false, stale: false };
      throw error;
    }
  }
  private async acquireLock(id: BranchId, lockPath: string): Promise<fs.FileHandle> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(lockPath, "wx", 0o600);
        const metadata: BranchLock = { version: 1, pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() };
        try {
          await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
        } catch (error) {
          await handle.close();
          await fs.rm(lockPath, { force: true });
          throw error;
        }
        return handle;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const status = await this.inspectLock(id);
        if (attempt > 0 || !status.stale) throw new Error(`Branch is locked: ${id}`);
        await fs.rm(lockPath, { force: true });
      }
    }
    throw new Error(`Branch is locked: ${id}`);
  }
  private async isStaleLock(lockPath: string, metadata?: BranchLock): Promise<boolean> {
    if (metadata?.hostname === os.hostname()) {
      try {
        process.kill(metadata.pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
        return false;
      }
    }
    if (metadata) return false;
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > 5 * 60_000;
  }
  private async writeHead(id: BranchId, commitId: CommitId): Promise<void> {
    assertContentHash(commitId);
    const head: BranchHead = { version: 1, commitId, updatedAt: new Date().toISOString() };
    await atomicWrite(path.join(this.branchDirectory(id), "head.json"), `${JSON.stringify(head, null, 2)}\n`);
  }
  private branchDirectory(id: BranchId): string {
    assertBranchId(id);
    return path.join(this.root, id);
  }
}

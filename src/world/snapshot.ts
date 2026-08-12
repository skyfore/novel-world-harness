import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "./canonical.js";
import { WORLD_ENGINE_VERSION, WORLD_SCHEMA_VERSION, worldStateSchema, type CommitId, type WorldState } from "./model.js";

export type WorldSnapshot = {
  version: 1;
  commitId: CommitId;
  engineVersion: string;
  schemaVersion: number;
  stateHash: string;
  state: WorldState;
  createdAt: string;
};

export class WorldSnapshotStore {
  readonly root: string;
  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceRoot, ".novel-harness", "world", "v1", "cache", "snapshots");
  }

  async write(commitId: CommitId, state: WorldState): Promise<WorldSnapshot> {
    if (state.atCommit !== commitId) throw new Error(`Snapshot state ${state.atCommit} does not match commit ${commitId}`);
    const parsed = worldStateSchema.parse(state);
    const snapshot: WorldSnapshot = {
      version: 1,
      commitId,
      engineVersion: WORLD_ENGINE_VERSION,
      schemaVersion: WORLD_SCHEMA_VERSION,
      stateHash: contentHash(parsed),
      state: parsed,
      createdAt: new Date().toISOString(),
    };
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const filePath = this.filePath(commitId);
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
    return snapshot;
  }

  async read(commitId: CommitId): Promise<WorldSnapshot | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath(commitId), "utf8")) as WorldSnapshot;
      if (value.version !== 1 || value.commitId !== commitId) return null;
      if (value.engineVersion !== WORLD_ENGINE_VERSION || value.schemaVersion !== WORLD_SCHEMA_VERSION) return null;
      const state = worldStateSchema.parse(value.state);
      if (state.atCommit !== commitId || contentHash(state) !== value.stateHash) return null;
      return { ...value, state };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  }

  async remove(commitId: CommitId): Promise<void> {
    await fs.rm(this.filePath(commitId), { force: true });
  }

  private filePath(commitId: CommitId): string {
    if (!/^[a-f0-9]{64}$/.test(commitId)) throw new Error(`Invalid commit id: ${commitId}`);
    return path.join(this.root, `${commitId}.json`);
  }
}


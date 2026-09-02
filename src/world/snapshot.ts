import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "./canonical.js";
import {
  WORLD_ENGINE_VERSION,
  WORLD_SCHEMA_VERSION,
  branchSemanticDeltaSchema,
  committedEventSchema,
  knowledgeDeltaSchema,
  normDeltaSchema,
  processDeltaSchema,
  stateDeltaSchema,
  worldStateSchema,
  type CommitId,
} from "./model.js";
import { worldStorageRoot } from "./paths.js";
import type { WorldProjectionBundle } from "./projection-service.js";

export const PROJECTION_REDUCER_VERSIONS = {
  state: 1,
  knowledge: 1,
  semantics: 2,
  processes: 2,
  norms: 2,
  scenes: 1,
  causality: 2,
} as const;

export type ProjectionReducerVersions = typeof PROJECTION_REDUCER_VERSIONS;

export type WorldSnapshot = {
  version: 2;
  commitId: CommitId;
  engineVersion: string;
  schemaVersion: number;
  reducerVersions: ProjectionReducerVersions;
  projectionHash: string;
  projection: WorldProjectionBundle;
  createdAt: string;
};

export type WorldSnapshotInspection =
  | { status: "missing" }
  | { status: "valid"; snapshot: WorldSnapshot }
  | { status: "invalid"; reason: string };

export class WorldSnapshotStore {
  readonly root: string;
  constructor(workspaceRoot: string) {
    this.root = path.join(worldStorageRoot(workspaceRoot), "cache", "projection-checkpoints-v2");
  }

  async write(projectionInput: WorldProjectionBundle): Promise<WorldSnapshot> {
    const projection = validateProjection(structuredClone(projectionInput), projectionInput.atCommit);
    const snapshot: WorldSnapshot = {
      version: 2,
      commitId: projection.atCommit,
      engineVersion: WORLD_ENGINE_VERSION,
      schemaVersion: WORLD_SCHEMA_VERSION,
      reducerVersions: PROJECTION_REDUCER_VERSIONS,
      projectionHash: contentHash(projection),
      projection,
      createdAt: new Date().toISOString(),
    };
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const filePath = this.filePath(projection.atCommit);
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
    return snapshot;
  }

  async read(commitId: CommitId): Promise<WorldSnapshot | null> {
    const inspection = await this.inspect(commitId);
    return inspection.status === "valid" ? inspection.snapshot : null;
  }

  async inspect(commitId: CommitId): Promise<WorldSnapshotInspection> {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath(commitId), "utf8")) as unknown;
      return { status: "valid", snapshot: validateSnapshot(value, commitId) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "invalid", reason: error instanceof Error ? error.message : String(error) };
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

function validateSnapshot(input: unknown, commitId: CommitId): WorldSnapshot {
  if (!isRecord(input)) throw new Error("Projection checkpoint must be an object");
  if (input.version !== 2) throw new Error(`Unsupported projection checkpoint version ${String(input.version)}`);
  if (input.commitId !== commitId) throw new Error(`Projection checkpoint targets ${String(input.commitId)}, expected ${commitId}`);
  if (input.engineVersion !== WORLD_ENGINE_VERSION || input.schemaVersion !== WORLD_SCHEMA_VERSION) {
    throw new Error("Projection checkpoint engine/schema version is stale");
  }
  if (!sameReducerVersions(input.reducerVersions)) throw new Error("Projection checkpoint reducer versions are stale");
  if (typeof input.projectionHash !== "string" || !/^[a-f0-9]{64}$/.test(input.projectionHash)) {
    throw new Error("Projection checkpoint hash is invalid");
  }
  if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error("Projection checkpoint creation time is invalid");
  }
  const projection = validateProjection(input.projection, commitId);
  if (contentHash(projection) !== input.projectionHash) throw new Error("Projection checkpoint content hash does not match payload");
  return {
    version: 2,
    commitId,
    engineVersion: WORLD_ENGINE_VERSION,
    schemaVersion: WORLD_SCHEMA_VERSION,
    reducerVersions: PROJECTION_REDUCER_VERSIONS,
    projectionHash: input.projectionHash,
    projection,
    createdAt: input.createdAt,
  };
}

function validateProjection(input: unknown, commitId: CommitId): WorldProjectionBundle {
  if (!isRecord(input) || input.version !== 1 || input.atCommit !== commitId) {
    throw new Error(`Projection bundle does not target commit ${commitId}`);
  }
  const state = worldStateSchema.parse(input.state);
  if (state.atCommit !== commitId) throw new Error("State reducer checkpoint is at a different commit");
  assertReducerState(input.knowledge, commitId, "knowledge");
  assertReducerState(input.semantics, commitId, "semantics", 1);
  assertReducerState(input.processes, commitId, "processes", 1);
  assertReducerState(input.norms, commitId, "norms", 1);
  assertReducerState(input.scenes, commitId, "scenes", 1);
  assertReducerState(input.causality, commitId, "causality", 2);
  if (!Array.isArray(input.history)) throw new Error("Projection checkpoint history must be an array");
  for (const [index, raw] of input.history.entries()) {
    if (!isRecord(raw) || typeof raw.commitId !== "string" || typeof raw.eventHash !== "string") {
      throw new Error(`Projection history entry ${index} is invalid`);
    }
    committedEventSchema.parse(raw.event);
    stateDeltaSchema.parse(raw.delta);
    if (raw.knowledgeDelta !== undefined) knowledgeDeltaSchema.parse(raw.knowledgeDelta);
    if (raw.semanticDelta !== undefined) branchSemanticDeltaSchema.parse(raw.semanticDelta);
    if (raw.processDelta !== undefined) processDeltaSchema.parse(raw.processDelta);
    if (raw.normDelta !== undefined) normDeltaSchema.parse(raw.normDelta);
  }
  return input as WorldProjectionBundle;
}

function assertReducerState(input: unknown, commitId: CommitId, name: string, expectedVersion?: number): void {
  if (!isRecord(input) || input.atCommit !== commitId) throw new Error(`${name} reducer checkpoint is at a different commit`);
  if (expectedVersion !== undefined && input.version !== expectedVersion) throw new Error(`${name} reducer checkpoint version is unsupported`);
}

function sameReducerVersions(input: unknown): input is ProjectionReducerVersions {
  if (!isRecord(input)) return false;
  return Object.entries(PROJECTION_REDUCER_VERSIONS)
    .every(([key, version]) => input[key] === version)
    && Object.keys(input).length === Object.keys(PROJECTION_REDUCER_VERSIONS).length;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

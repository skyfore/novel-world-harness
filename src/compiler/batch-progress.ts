import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { worldStorageRoot } from "../world/paths.js";

/** Invalidates resumable batch checkpoints when compiler semantics change. */
export const COMPILER_PIPELINE_VERSION = 31;
const SCENE_STAGE_MIGRATION_FROM_PIPELINE_VERSION = 30;

export type BatchProgress = {
  version: 1;
  pipelineVersion: number;
  sourceId: string;
  completedBatchIds: string[];
  updatedAt: string;
};

export type PersistedBatchProgress = Omit<BatchProgress, "pipelineVersion"> & {
  /** Older checkpoints may predate explicit compiler-pipeline versioning. */
  pipelineVersion?: number;
};

/**
 * Durable compiler progress is kept separate from batch construction so
 * proposal stores can consult checkpoints without depending on the prompt
 * hydration module.
 */
export class CompilerBatchStore {
  readonly root: string;
  constructor(workspaceRoot: string) {
    this.root = path.join(worldStorageRoot(workspaceRoot), "compiler", "batches");
  }

  async read(sourceId: string): Promise<BatchProgress> {
    const parsed = await this.readPersisted(sourceId);
    if (!parsed) {
      return { version: 1, pipelineVersion: COMPILER_PIPELINE_VERSION, sourceId, completedBatchIds: [], updatedAt: new Date(0).toISOString() };
    }
    if (parsed.pipelineVersion === SCENE_STAGE_MIGRATION_FROM_PIPELINE_VERSION) {
      // Pipeline 31 moves scene construction beside canonical events and
      // rechecks executable source accounting. Structure discovery and the
      // source-observation inventory are byte-identical in pipeline 30, so
      // preserve only those checkpoints instead of paying to recreate them.
      return {
        ...parsed,
        pipelineVersion: COMPILER_PIPELINE_VERSION,
        completedBatchIds: parsed.completedBatchIds.filter((batchId) =>
          batchId.startsWith(`structure-${sourceId}-`)
          || (batchId.startsWith(`batch-${sourceId}-`) && batchId.includes("-observation-"))),
      };
    }
    if (parsed.pipelineVersion !== COMPILER_PIPELINE_VERSION) {
      return { version: 1, pipelineVersion: COMPILER_PIPELINE_VERSION, sourceId, completedBatchIds: [], updatedAt: new Date(0).toISOString() };
    }
    return parsed as BatchProgress;
  }

  /**
   * Read the on-disk checkpoint without treating an older semantic pipeline as
   * current progress. Reparse uses this only to prove that a complete legacy
   * materialization can be snapshotted as an incompatible rollback baseline.
   */
  async readPersisted(sourceId: string): Promise<PersistedBatchProgress | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath(sourceId), "utf8")) as PersistedBatchProgress;
      if (
        parsed.version !== 1
        || parsed.sourceId !== sourceId
        || !Array.isArray(parsed.completedBatchIds)
        || parsed.completedBatchIds.some((id) => typeof id !== "string" || !id)
        || (parsed.pipelineVersion !== undefined
          && (!Number.isInteger(parsed.pipelineVersion) || parsed.pipelineVersion < 1))
        || typeof parsed.updatedAt !== "string"
      ) {
        throw new Error(`Invalid compiler batch progress for ${sourceId}`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async markComplete(sourceId: string, batchId: string): Promise<void> {
    const current = await this.read(sourceId);
    const completed = new Set(current.completedBatchIds);
    completed.add(batchId);
    await atomicJson(this.filePath(sourceId), {
      version: 1,
      pipelineVersion: COMPILER_PIPELINE_VERSION,
      sourceId,
      completedBatchIds: [...completed].sort(),
      updatedAt: new Date().toISOString(),
    } satisfies BatchProgress);
  }

  async replaceCompleted(sourceId: string, batchIds: readonly string[]): Promise<void> {
    await atomicJson(this.filePath(sourceId), {
      version: 1,
      pipelineVersion: COMPILER_PIPELINE_VERSION,
      sourceId,
      completedBatchIds: [...new Set(batchIds)].sort(),
      updatedAt: new Date().toISOString(),
    } satisfies BatchProgress);
  }

  async markIncomplete(sourceId: string, batchIds: readonly string[]): Promise<void> {
    const selected = new Set(batchIds);
    const current = await this.read(sourceId);
    await this.replaceCompleted(sourceId, current.completedBatchIds.filter((id) => !selected.has(id)));
  }

  async reset(sourceId: string): Promise<void> {
    await fs.rm(this.filePath(sourceId), { force: true });
  }

  private filePath(sourceId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sourceId)) throw new Error(`Unsafe source id: ${sourceId}`);
    return path.join(this.root, `${sourceId}.json`);
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

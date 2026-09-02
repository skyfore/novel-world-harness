import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { worldStorageRoot } from "../world/paths.js";

const sourceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const repairRunSchema = z.object({
  version: z.literal(1),
  sourceId: sourceIdSchema,
  baselineBundleHash: digestSchema,
  runId: z.string().regex(/^repair-\d{14}-[a-f0-9]{8}$/),
  pipelineVersion: z.number().int().positive(),
  batchIds: z.array(z.string().min(1)).min(1),
  phase: z.enum(["compiling", "finalizing"]),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.batchIds).size !== value.batchIds.length) {
    ctx.addIssue({ code: "custom", path: ["batchIds"], message: "Repair run batch IDs must be unique." });
  }
});

export type RepairRun = z.infer<typeof repairRunSchema>;

/** Durable staging marker for repair-in-place work that may span many model calls. */
export class RepairRunStore {
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(worldStorageRoot(workspaceRoot), "compiler", "repair-runs");
  }

  async read(sourceId: string): Promise<RepairRun | null> {
    try {
      return repairRunSchema.parse(JSON.parse(await fs.readFile(this.filePath(sourceId), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(run: RepairRun): Promise<void> {
    const parsed = repairRunSchema.parse(run);
    const filePath = this.filePath(parsed.sourceId);
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, filePath);
  }

  async remove(sourceId: string): Promise<void> {
    await fs.rm(this.filePath(sourceId), { force: true });
  }

  private filePath(sourceId: string): string {
    return path.join(this.root, `${sourceIdSchema.parse(sourceId)}.json`);
  }
}

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { idSchema } from "../world/model.js";
import { worldStorageRoot } from "../world/paths.js";

const boundaryCalibrationRequesterSchema = z.object({
  batchId: idSchema,
  segmentId: idSchema,
  direction: z.enum(["previous", "next"]),
  reason: z.string().min(1).max(1_000),
  artifactIds: z.array(idSchema).max(12),
  requestedAt: z.string().datetime(),
}).strict();

const boundaryCalibrationRequestSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  sourceId: idSchema,
  leftSegmentId: idSchema,
  rightSegmentId: idSchema,
  requestedBy: z.array(boundaryCalibrationRequesterSchema).min(1),
  updatedAt: z.string().datetime(),
}).strict();

const boundaryCalibrationManifestSchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  requests: z.array(boundaryCalibrationRequestSchema),
  updatedAt: z.string().datetime(),
}).strict();

export type BoundaryCalibrationRequester = z.infer<typeof boundaryCalibrationRequesterSchema>;
export type BoundaryCalibrationRequest = z.infer<typeof boundaryCalibrationRequestSchema>;
type BoundaryCalibrationManifest = z.infer<typeof boundaryCalibrationManifestSchema>;

export function boundaryCalibrationBatchId(
  sourceId: string,
  leftSegmentId: string,
  rightSegmentId: string,
): string {
  idSchema.parse(sourceId);
  idSchema.parse(leftSegmentId);
  idSchema.parse(rightSegmentId);
  const digest = crypto.createHash("sha256")
    .update(`${sourceId}\0${leftSegmentId}\0${rightSegmentId}`)
    .digest("hex")
    .slice(0, 16);
  return `boundary-${sourceId}-${digest}`;
}

/**
 * Durable, non-canonical requests for a fresh two-segment compiler pass.
 * A request can survive process interruption, but it never changes world truth.
 */
export class BoundaryCalibrationStore {
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(worldStorageRoot(workspaceRoot), "compiler", "boundary-calibrations");
  }

  async list(sourceId: string): Promise<BoundaryCalibrationRequest[]> {
    return structuredClone((await this.read(sourceId)).requests);
  }

  async get(sourceId: string, calibrationBatchId: string): Promise<BoundaryCalibrationRequest | undefined> {
    idSchema.parse(calibrationBatchId);
    return (await this.list(sourceId)).find((request) => request.id === calibrationBatchId);
  }

  async request(input: {
    sourceId: string;
    leftSegmentId: string;
    rightSegmentId: string;
    requestedByBatchId: string;
    requestedBySegmentId: string;
    direction: "previous" | "next";
    reason: string;
    artifactIds?: readonly string[];
  }): Promise<BoundaryCalibrationRequest> {
    const now = new Date().toISOString();
    const requester = boundaryCalibrationRequesterSchema.parse({
      batchId: input.requestedByBatchId,
      segmentId: input.requestedBySegmentId,
      direction: input.direction,
      reason: input.reason,
      artifactIds: [...new Set(input.artifactIds ?? [])].sort(),
      requestedAt: now,
    });
    const current = await this.read(input.sourceId);
    const id = boundaryCalibrationBatchId(input.sourceId, input.leftSegmentId, input.rightSegmentId);
    const prior = current.requests.find((request) => request.id === id);
    const requestedBy = [
      ...(prior?.requestedBy ?? []).filter((item) =>
        item.batchId !== requester.batchId || item.direction !== requester.direction),
      requester,
    ].sort((left, right) =>
      left.batchId.localeCompare(right.batchId) || left.direction.localeCompare(right.direction));
    const request = boundaryCalibrationRequestSchema.parse({
      version: 1,
      id,
      sourceId: input.sourceId,
      leftSegmentId: input.leftSegmentId,
      rightSegmentId: input.rightSegmentId,
      requestedBy,
      updatedAt: now,
    });
    await this.write({
      version: 1,
      sourceId: input.sourceId,
      requests: [...current.requests.filter((item) => item.id !== id), request]
        .sort((left, right) => left.id.localeCompare(right.id)),
      updatedAt: now,
    });
    return structuredClone(request);
  }

  async removeRequestedByBatch(sourceId: string, batchId: string): Promise<void> {
    idSchema.parse(batchId);
    const current = await this.read(sourceId);
    const requests = current.requests.flatMap((request) => {
      const requestedBy = request.requestedBy.filter((item) => item.batchId !== batchId);
      return requestedBy.length ? [{ ...request, requestedBy }] : [];
    });
    if (requests.length === current.requests.length
      && requests.every((request, index) => request.requestedBy.length === current.requests[index]?.requestedBy.length)) return;
    await this.write({
      version: 1,
      sourceId,
      requests,
      updatedAt: new Date().toISOString(),
    });
  }

  async reset(sourceId: string): Promise<void> {
    await fs.rm(this.filePath(sourceId), { force: true });
  }

  private async read(sourceId: string): Promise<BoundaryCalibrationManifest> {
    idSchema.parse(sourceId);
    try {
      const parsed = boundaryCalibrationManifestSchema.parse(
        JSON.parse(await fs.readFile(this.filePath(sourceId), "utf8")),
      );
      if (parsed.sourceId !== sourceId) {
        throw new Error(`Boundary-calibration source '${parsed.sourceId}' does not match '${sourceId}'.`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, sourceId, requests: [], updatedAt: new Date(0).toISOString() };
      }
      throw error;
    }
  }

  private async write(manifest: BoundaryCalibrationManifest): Promise<void> {
    const parsed = boundaryCalibrationManifestSchema.parse(manifest);
    const filePath = this.filePath(parsed.sourceId);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
  }

  private filePath(sourceId: string): string {
    return path.join(this.root, `${idSchema.parse(sourceId)}.json`);
  }
}

import { enqueueJob } from "./jobs.js";
import type { Db } from "../db/client.js";

export async function bootstrapCompilerJobs(db: Db, projectId: string, documentId: string): Promise<void> {
  await enqueueJob(db, projectId, "segment-source", { documentId }, 1.0, "document", documentId);
  await enqueueJob(db, projectId, "verify-model", { reason: "bootstrap" }, 0.1, "project", projectId);
}

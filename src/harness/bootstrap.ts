import { enqueueJob } from "./jobs.js";
import type { WorkspaceStore } from "../storage/workspace-store.js";

export async function bootstrapCompilerJobs(store: WorkspaceStore, documentId: string): Promise<void> {
  await enqueueJob(store, "segment-source", { documentId }, 1.0, "document", documentId);
  await enqueueJob(store, "verify-model", { reason: "bootstrap" }, 0.1, "project", "local");
}

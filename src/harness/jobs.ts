import type { WorkspaceStore } from "../storage/workspace-store.js";
import type { HarnessJob, HarnessJobType } from "./types.js";

export async function enqueueJob(
  store: WorkspaceStore,
  jobType: HarnessJobType,
  input: unknown,
  priority = 0.5,
  targetType?: string,
  targetId?: string,
): Promise<void> {
  await store.enqueueJob(jobType, input, priority, targetType, targetId);
}

export async function claimNextJob(store: WorkspaceStore): Promise<HarnessJob | null> {
  return store.claimNextJob();
}

export async function finishJob(store: WorkspaceStore, jobId: string, output: unknown): Promise<void> {
  await store.finishJob(jobId, output);
}

export async function failJob(store: WorkspaceStore, jobId: string, error: unknown): Promise<void> {
  await store.failJob(jobId, error);
}

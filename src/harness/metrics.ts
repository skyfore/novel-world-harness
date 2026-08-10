import type { WorkspaceStore } from "../storage/workspace-store.js";
import type { BuildMetrics } from "./types.js";

export async function readMetrics(store: WorkspaceStore): Promise<BuildMetrics> {
  return store.readMetrics();
}

export async function writeMetric(
  store: WorkspaceStore,
  metric: keyof BuildMetrics,
  value: number,
  details: unknown = {},
): Promise<void> {
  await store.writeMetric(metric, value, details);
}

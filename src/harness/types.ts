import type { HarnessConfig } from "../config/schema.js";
import type { WorkspaceStore } from "../storage/workspace-store.js";

export const jobTypes = [
  "segment-source",
  "extract-entities",
  "resolve-entities",
  "extract-events",
  "build-timeline",
  "derive-state-deltas",
  "build-epistemic",
  "build-causality",
  "verify-model",
  "canon-replay",
] as const;

export type HarnessJobType = (typeof jobTypes)[number];

export type BuildMetrics = {
  source: number;
  evidence: number;
  entityResolution: number;
  majorEvents: number;
  temporalConsistency: number;
  stateDelta: number;
  epistemic: number;
  causality: number;
};

export type HarnessContext = {
  config: HarnessConfig;
  store: WorkspaceStore;
};

export type HarnessJob = {
  id: string;
  jobType: HarnessJobType;
  targetType?: string;
  targetId?: string;
  priority: number;
  input: unknown;
};

export type HarnessWorker = {
  type: HarnessJobType;
  execute(ctx: HarnessContext, job: HarnessJob): Promise<unknown>;
};

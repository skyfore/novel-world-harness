import type { HarnessConfig } from "../config/schema.js";
import type { BuildMetrics } from "./types.js";

export function readinessGaps(config: HarnessConfig, metrics: BuildMetrics) {
  const target = config.harness.targetCoverage;
  return (Object.keys(target) as Array<keyof BuildMetrics>)
    .map((key) => ({ key, value: metrics[key], target: target[key] }))
    .filter((item) => item.value < item.target)
    .sort((a, b) => (b.target - b.value) - (a.target - a.value));
}

export function isRuntimeReady(config: HarnessConfig, metrics: BuildMetrics): boolean {
  return readinessGaps(config, metrics).length === 0;
}

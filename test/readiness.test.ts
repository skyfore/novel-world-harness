import { describe, expect, it } from "vitest";
import { readinessGaps } from "../src/harness/readiness.js";
import type { HarnessConfig } from "../src/config/schema.js";

const config = {
  harness: {
    targetCoverage: {
      source: 0.99,
      evidence: 0.99,
      entityResolution: 0.99,
      majorEvents: 0.98,
      temporalConsistency: 0.99,
      stateDelta: 0.95,
      epistemic: 0.9,
      causality: 0.9,
    },
  },
} as HarnessConfig;

describe("readinessGaps", () => {
  it("sorts largest readiness gap first", () => {
    const gaps = readinessGaps(config, {
      source: 1,
      evidence: 1,
      entityResolution: 1,
      majorEvents: 0.3,
      temporalConsistency: 1,
      stateDelta: 0.7,
      epistemic: 0.9,
      causality: 0.9,
    });
    expect(gaps[0]?.key).toBe("majorEvents");
  });
});

import { expect, it } from "vitest";
import { compilerFailureFingerprint, compilerFailureRepeatedAfterRepair, isCompilerUsageLimit, nextCompilerReset } from "../src/runtime/codex-compile-loop.js";
it("distinguishes hard quota from transient throttling and validation errors", () => {
  expect(isCompilerUsageLimit("You've hit your usage limit. Try again later.")).toBe(true);
  expect(isCompilerUsageLimit("usage_limit_reached")).toBe(true);
  expect(isCompilerUsageLimit("429 rate limit; retry in 2 seconds")).toBe(false);
  expect(isCompilerUsageLimit("V2 character models require legacy: keys")).toBe(false);
});
it("advances the Beijing 04:08 reset anchor by five hours, crossing days", () => {
  const anchor = new Date("2026-09-11T20:08:00Z");
  expect(nextCompilerReset(new Date("2026-09-11T16:00:00Z"), anchor).toISOString()).toBe("2026-09-11T20:08:00.000Z");
  expect(nextCompilerReset(anchor, anchor).toISOString()).toBe("2026-09-12T01:08:00.000Z");
  expect(nextCompilerReset(new Date("2026-09-12T03:00:00Z"), anchor).toISOString()).toBe("2026-09-12T06:08:00.000Z");
});
it("keeps different failed proposal targets distinct", () => {
  expect(compilerFailureFingerprint("failed proposal_id=foo: missing disposition")).not.toBe(compilerFailureFingerprint("failed proposal_id=bar: missing disposition"));
  expect(compilerFailureFingerprint("missing disposition")).not.toBe(compilerFailureFingerprint("invalid evidence"));
});

it("stops only when the recorded repaired failure recurs", () => {
  const fingerprint = compilerFailureFingerprint("failed proposal_id=foo: missing disposition");
  expect(compilerFailureRepeatedAfterRepair(fingerprint, undefined)).toBe(false);
  expect(compilerFailureRepeatedAfterRepair(fingerprint, { failureFingerprint: fingerprint, repairId: "" })).toBe(false);
  expect(compilerFailureRepeatedAfterRepair(fingerprint, { failureFingerprint: fingerprint, repairId: "review-5" })).toBe(true);
  expect(compilerFailureRepeatedAfterRepair(compilerFailureFingerprint("failed proposal_id=bar: missing disposition"), { failureFingerprint: fingerprint, repairId: "review-5" })).toBe(false);
});

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

it('distinguishes a missing dependency from failed production on the same target, retaining same-cause stops', async () => {
  const { compilerFailureCauseFingerprint } = await import('../src/runtime/codex-compile-loop.js');
  const missing = { category: 'missing-designated-quotation', targetIds: ['eva-config'], dependencyIds: ['q-instruction'] };
  const retrieval = { ...missing, category: 'knowledge-not-produced-with-verified-evidence' };
  const repair = { repairId: 'quote-retrieval-fix', failureFingerprint: compilerFailureCauseFingerprint(retrieval) };
  expect(compilerFailureRepeatedAfterRepair(compilerFailureCauseFingerprint(missing), repair)).toBe(false);
  expect(compilerFailureRepeatedAfterRepair(compilerFailureCauseFingerprint(retrieval), repair)).toBe(true);
  expect(compilerFailureRepeatedAfterRepair(compilerFailureCauseFingerprint({ ...retrieval, dependencyIds: ['other-quote'] }), repair)).toBe(false);
});

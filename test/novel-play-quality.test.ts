import { expect, it } from "vitest";
import { buildRoleRoster, roleRosterReviewSchema } from "../src/compiler/role-roster.js";
import { contentHash } from "../src/world/canonical.js";
import { BENCHMARK_SEMANTIC_LAYERS } from "../src/eval/benchmark-corpus.js";
import { NOVEL_VALIDATOR_FINGERPRINT, proportion95, validateNovelPlayQuality, type NovelPlayQuality } from "../src/eval/novel-play-quality.js";

// Pure validator fixtures: these DTOs are never persisted as live evaluation evidence.
function fixture() {
  const sha = contentHash("source"), subject = contentHash("snapshot");
  const roster = buildRoleRoster({ sourceId: "source", sourceSha256: sha, unitIds: ["unit"], annotations: [], resolutions: [], entities: [{ id: "hero", canonicalName: "Hero", kind: "character", aliases: [], evidence: [{ span: { sourceId: "source", startByte: 0, endByte: 4, startLine: 1, endLine: 1, quoteHash: sha }, strength: "explicit" }] }] });
  roster.reviews = ["review-a", "review-b"].map((runId) => roleRosterReviewSchema.parse({ runId, subjectHash: roster.subjectHash, reviewedUnitIds: ["unit"], entries: [{ candidateId: roster.candidates[0]!.id, importance: "major", rationale: "Central decision maker", basisUnitIds: ["unit"] }] }));
  const roleId = roster.candidates[0]!.id;
  const report: NovelPlayQuality = {
    version: 1, profile: "novel-play-v1", sourceSha256: sha, subjectSnapshotHash: subject, rosterHash: contentHash(roster), engineVersion: "0.3.0", schemaVersion: 3, validatorFingerprint: NOVEL_VALIDATOR_FINGERPRINT,
    sourceBytes: 4, accountedBytes: 4, sourceUnits: 1, accountedUnits: 1,
    gold: { hash: contentHash("gold"), frozenAt: "2026-01-01T00:00:00.000Z", reviewerRunIds: ["gold-review"], extractionRunIds: ["extract"], majorCandidateIds: [roleId], criticalCheckIds: ["identity"], requiredTasks: [{ candidateId: roleId, taskIds: ["deliver"] }] },
    startedAt: "2026-01-02T00:00:00.000Z", completedAt: "2026-01-03T00:00:00.000Z",
    layers: Object.fromEntries(BENCHMARK_SEMANTIC_LAYERS.map((name) => [name, { status: "evaluated", expected: 100, actual: 100, matched: 100 }])) as NovelPlayQuality["layers"],
    criticalChecks: [{ id: "identity", passed: true, evidenceHash: contentHash("identity") }],
    runs: [1, 2, 3].map((id) => ({ id: `run-${id}`, candidateId: roleId, actorId: "hero", mode: "pi-live", provider: "fixture-only", model: "fixture-only", configHash: contentHash("fixture-config"), invocationIds: [`invocation-${id}`], status: "completed",
      commits: Array.from({ length: 50 }, (_, index) => ({ eventHash: contentHash({ id, event: index }), beforeHead: contentHash({ id, head: index }), afterHead: contentHash({ id, head: index + 1 }), material: true })),
      requiredTasks: [{ id: "deliver", passed: true, evidenceHash: contentHash("task") }], replayEquivalent: true, knowledgeViolations: 0, causalViolations: 0, illegalEffectsAccepted: 0, noOps: 0, rejectedProposals: 0, modelFailures: 0,
    })), issues: [],
  };
  const expected = { sourceSha256: sha, subjectSnapshotHash: subject, roster, sourceBytes: 4, sourceUnits: 1, engineVersion: "0.3.0", schemaVersion: 3 };
  return { report, expected };
}

it("requires independent, unchanged denominators and complete per-major live runs", () => {
  const { report, expected } = fixture();
  expect(validateNovelPlayQuality(report, expected)).toEqual([]);
  expect(validateNovelPlayQuality(null, expected)[0]!.code).toBe("NOVEL_EVALUATION_NOT_RUN");
  report.runs[0]!.mode = "deterministic-fixture";
  expect(validateNovelPlayQuality(report, expected).map((issue) => issue.code)).toContain("NOVEL_RUN_NOT_LIVE_OR_COMPLETE");
  report.runs[0]!.mode = "pi-live";
  report.criticalChecks = [];
  expect(validateNovelPlayQuality(report, expected).map((issue) => issue.code)).toContain("NOVEL_CRITICAL_DENOMINATOR_CHANGED");
});

it("does not count no-ops, duplicate commits, missing layers or task deletion as success", () => {
  const { report, expected } = fixture();
  report.runs[0]!.commits[0]!.material = false;
  report.runs[1]!.commits[1] = report.runs[1]!.commits[0]!;
  report.runs[2]!.requiredTasks = [];
  report.layers.knowledge = { status: "not-annotated", reason: "Gold missing" };
  expect(validateNovelPlayQuality(report, expected).map((issue) => issue.code)).toEqual(expect.arrayContaining(["NOVEL_RUN_TOO_SHORT", "NOVEL_COMMIT_DUPLICATED", "NOVEL_HISTORY_CHAIN_BROKEN", "NOVEL_TASK_DENOMINATOR_CHANGED", "NOVEL_SEMANTIC_LAYER_UNEVALUATED"]));
});

it("reports finite-sample uncertainty and rejects empty denominators", () => {
  expect(proportion95(0, 0)).toBeNull();
  const interval = proportion95(95, 100)!;
  expect(interval.estimate).toBe(0.95);
  expect(interval.lower).toBeLessThan(0.95);
  expect(interval.upper).toBeLessThan(1);
});

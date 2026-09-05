import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { validationIssueSchema, type ValidationIssue } from "../world/model.js";
import { BENCHMARK_SEMANTIC_LAYERS } from "./benchmark-corpus.js";
import { majorRoleCandidates, type RoleRoster } from "../compiler/role-roster.js";
import { supportReviewSchema } from "../compiler/semantic-support.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const countSchema = z.number().int().nonnegative();
export const qualityLayerSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("evaluated"), expected: countSchema, actual: countSchema, matched: countSchema }).strict(),
  z.object({ status: z.literal("not-applicable"), reason: z.string().trim().min(1), frozenBeforeRun: z.literal(true) }).strict(),
  z.object({ status: z.enum(["not-annotated", "not-implemented", "not-run"]), reason: z.string().trim().min(1) }).strict(),
]);
export const novelPlayQualitySchema = z.object({
  version: z.literal(1), profile: z.literal("novel-play-v1"),
  sourceSha256: hashSchema, subjectSnapshotHash: hashSchema, rosterHash: hashSchema,
  engineVersion: z.string().min(1), schemaVersion: z.number().int(), validatorFingerprint: hashSchema,
  sourceBytes: countSchema, accountedBytes: countSchema, sourceUnits: countSchema, accountedUnits: countSchema,
  gold: z.object({ hash: hashSchema, frozenAt: z.string().datetime(), reviewerRunIds: z.array(z.string().min(1)).min(1), extractionRunIds: z.array(z.string().min(1)), majorCandidateIds: z.array(z.string().min(1)).min(1),
    criticalCheckIds: z.array(z.string().min(1)).min(1), requiredTasks: z.array(z.object({ candidateId: z.string().min(1), taskIds: z.array(z.string().min(1)).min(1) }).strict()).min(1),
  }).strict(),
  startedAt: z.string().datetime(), completedAt: z.string().datetime(),
  supportReviews: z.array(supportReviewSchema).default([]),
  layers: z.record(z.enum(BENCHMARK_SEMANTIC_LAYERS), qualityLayerSchema),
  criticalChecks: z.array(z.object({ id: z.string().min(1), passed: z.boolean(), evidenceHash: hashSchema }).strict()).min(1),
  runs: z.array(z.object({
    id: z.string().min(1), candidateId: z.string().min(1), actorId: z.string().min(1),
    mode: z.enum(["pi-live", "deterministic-fixture", "not-run"]), provider: z.string().min(1), model: z.string().min(1), configHash: hashSchema,
    invocationIds: z.array(z.string().min(1)),
    status: z.enum(["completed", "terminated", "failed", "not-run"]),
    commits: z.array(z.object({ eventHash: hashSchema, beforeHead: hashSchema, afterHead: hashSchema, material: z.boolean() }).strict()),
    termination: z.object({ verified: z.literal(true), predicateHash: hashSchema, atCommit: hashSchema, evidenceHash: hashSchema }).strict().optional(),
    requiredTasks: z.array(z.object({ id: z.string().min(1), passed: z.boolean(), evidenceHash: hashSchema }).strict()).min(1),
    replayEquivalent: z.boolean(), knowledgeViolations: countSchema, causalViolations: countSchema, illegalEffectsAccepted: countSchema,
    noOps: countSchema, rejectedProposals: countSchema, modelFailures: countSchema,
  }).strict()),
  issues: z.array(validationIssueSchema),
}).strict();
export type NovelPlayQuality = z.infer<typeof novelPlayQualitySchema>;

export const NOVEL_VALIDATOR_FINGERPRINT = contentHash({ profile: "novel-play-v1", closure: 2, sceneContract: 1, supportAssessment: 1, entryCut: 1, roleReview: 1, effectMechanism: 2, actorOutcome: 2, actorView: 2, predicateTruth: 1, liveEvaluator: 1 });

/** Wilson intervals disclose finite annotation uncertainty; an empty denominator has no estimate. */
export function proportion95(successes: number, total: number): { estimate: number; lower: number; upper: number } | null {
  if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(successes) || successes < 0 || successes > total) return null;
  const z = 1.959963984540054, p = successes / total, denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator;
  return { estimate: p, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

/** Host-generated run records, never model self-scores. Missing evidence is a blocking result. */
export function validateNovelPlayQuality(report: NovelPlayQuality | null, expected: {
  sourceSha256: string; subjectSnapshotHash: string; roster: RoleRoster; sourceBytes: number; sourceUnits: number; engineVersion: string; schemaVersion: number;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [], fail = (code: string, message: string) => issues.push({ code, message });
  if (!report) return [{ code: "NOVEL_EVALUATION_NOT_RUN", message: "Independent semantic gold and per-major live Pi evaluations have not been recorded for this snapshot" }];
  issues.push(...report.issues);
  if (report.sourceSha256 !== expected.sourceSha256 || report.subjectSnapshotHash !== expected.subjectSnapshotHash || report.rosterHash !== contentHash(expected.roster)) fail("NOVEL_EVALUATION_STALE", "Evaluation source, snapshot or roster differs");
  if (report.engineVersion !== expected.engineVersion || report.schemaVersion !== expected.schemaVersion || report.validatorFingerprint !== NOVEL_VALIDATOR_FINGERPRINT) fail("NOVEL_EVALUATOR_VERSION_STALE", "Evaluation uses another engine or validator contract");
  if (!(report.sourceBytes > 0 && report.sourceBytes === report.accountedBytes && report.sourceUnits > 0 && report.sourceUnits === report.accountedUnits)) fail("NOVEL_SOURCE_ACCOUNTING_INCOMPLETE", "Source bytes and structural units require 100% accounting");
  if (report.sourceBytes !== expected.sourceBytes || report.sourceUnits !== expected.sourceUnits) fail("NOVEL_SOURCE_DENOMINATOR_CHANGED", "Evaluation source accounting differs from the frozen source inventory");
  if (Date.parse(report.gold.frozenAt) > Date.parse(report.startedAt) || Date.parse(report.completedAt) < Date.parse(report.startedAt)) fail("NOVEL_GOLD_NOT_FROZEN", "Gold and the independent major denominator must be frozen before evaluation starts");
  if (report.gold.reviewerRunIds.some((id) => report.gold.extractionRunIds.includes(id) || expected.roster.extractionRunIds.includes(id))) fail("NOVEL_GOLD_NOT_INDEPENDENT", "Gold review reuses an extraction run");
  const major = majorRoleCandidates(expected.roster), ids = major.map((role) => role.id).sort();
  if (!ids.length || canonicalJson(ids) !== canonicalJson([...report.gold.majorCandidateIds].sort()) || report.runs.some((run) => !ids.includes(run.candidateId))) fail("NOVEL_MAJOR_DENOMINATOR_MISMATCH", "Frozen independent majors and evaluated majors must match exactly");
  if (canonicalJson(ids) !== canonicalJson(report.gold.requiredTasks.map((entry) => entry.candidateId).sort()) || report.gold.requiredTasks.some((entry) => new Set(entry.taskIds).size !== entry.taskIds.length)) fail("NOVEL_TASK_DENOMINATOR_MISSING", "Every frozen major requires exactly one distinct task inventory");
  if (new Set(report.gold.reviewerRunIds).size !== report.gold.reviewerRunIds.length) fail("NOVEL_GOLD_NOT_INDEPENDENT", "Gold reviewer run IDs must be distinct");
  for (const layer of BENCHMARK_SEMANTIC_LAYERS) {
    const metric = report.layers[layer];
    if (!metric || (metric.status !== "evaluated" && metric.status !== "not-applicable")) { fail("NOVEL_SEMANTIC_LAYER_UNEVALUATED", `Layer ${layer} has no evaluated or predeclared inapplicable denominator`); continue; }
    if (metric.status === "not-applicable") continue;
    const precision = proportion95(metric.matched, metric.actual), recall = proportion95(metric.matched, metric.expected);
    if (!precision || !recall || precision.estimate < 0.95 || recall.estimate < 0.95) fail("NOVEL_SEMANTIC_THRESHOLD_FAILED", `Layer ${layer} requires nonempty precision and recall denominators and both estimates >= 0.95`);
  }
  if (report.criticalChecks.some((check) => !check.passed) || new Set(report.criticalChecks.map((check) => check.id)).size !== report.criticalChecks.length) fail("NOVEL_CRITICAL_CHECK_FAILED", "Critical checks must be distinct and all pass");
  if (canonicalJson([...report.gold.criticalCheckIds].sort()) !== canonicalJson(report.criticalChecks.map((check) => check.id).sort())) fail("NOVEL_CRITICAL_DENOMINATOR_CHANGED", "Critical checks differ from the frozen pre-run inventory");
  if (report.layers.mentions?.status !== "evaluated" || report.layers.characterAssertions?.status !== "evaluated") fail("NOVEL_MAJOR_SEMANTICS_UNEVALUATED", "Major characters require evaluated mentions and character assertions");
  if (new Set(report.runs.map((run) => run.id)).size !== report.runs.length) fail("NOVEL_RUN_DUPLICATED", "Evaluation run IDs must be unique");
  const invocations = report.runs.flatMap((run) => run.invocationIds);
  if (new Set(invocations).size !== invocations.length) fail("NOVEL_INVOCATION_REUSED", "Independent play runs cannot reuse Pi invocations");
  for (const role of major) {
    const tasks = report.gold.requiredTasks.filter((entry) => entry.candidateId === role.id);
    if (tasks.length !== 1) fail("NOVEL_TASK_DENOMINATOR_MISSING", `Major ${role.name} has no unique frozen task inventory`);
    const runs = report.runs.filter((run) => run.candidateId === role.id);
    if (runs.length < 3) fail("NOVEL_MAJOR_RUNS_MISSING", `Major ${role.name} requires at least three independent live runs`);
    for (const run of runs) {
      if (run.actorId !== role.entityId || run.mode !== "pi-live" || !run.invocationIds.length || !["completed", "terminated"].includes(run.status)) fail("NOVEL_RUN_NOT_LIVE_OR_COMPLETE", `Run ${run.id} is not a completed live Pi run of the certified actor`);
      const material = run.commits.filter((commit) => commit.material && commit.beforeHead !== commit.afterHead);
      if (run.commits.some((commit, index) => index > 0 && run.commits[index - 1]!.afterHead !== commit.beforeHead)) fail("NOVEL_HISTORY_CHAIN_BROKEN", `Run ${run.id} does not describe one continuous committed history`);
      const events = new Set(material.map((commit) => commit.eventHash));
      if (events.size !== material.length || new Set(material.map((commit) => commit.afterHead)).size !== material.length) fail("NOVEL_COMMIT_DUPLICATED", `Run ${run.id} repeats committed history`);
      const terminated = run.status === "terminated" && run.termination?.verified === true && run.termination.atCommit === run.commits.at(-1)?.afterHead;
      if (events.size < 50 && !terminated) fail("NOVEL_RUN_TOO_SHORT", `Run ${run.id} requires 50 distinct material commits or a verified legal terminal condition`);
      if (!run.replayEquivalent || run.knowledgeViolations || run.causalViolations || run.illegalEffectsAccepted || run.requiredTasks.some((task) => !task.passed)) fail("NOVEL_RUN_CONTRACT_FAILED", `Run ${run.id} violates a required task, isolation, causality or replay contract`);
      if (canonicalJson([...(tasks[0]?.taskIds ?? [])].sort()) !== canonicalJson(run.requiredTasks.map((task) => task.id).sort())) fail("NOVEL_TASK_DENOMINATOR_CHANGED", `Run ${run.id} changed its pre-run required tasks`);
    }
  }
  return issues;
}

export class NovelPlayQualityStore {
  private readonly root: string;
  constructor(root: string) { this.root = path.join(worldStorageRoot(root), "compiler", "evaluation-runs", "v1"); }
  private directory(subjectHash: string) { return path.join(this.root, hashSchema.parse(subjectHash)); }
  async read(subjectHash: string): Promise<NovelPlayQuality | null> {
    try {
      const directory = this.directory(subjectHash);
      const revisionHash = hashSchema.parse(JSON.parse(await fs.readFile(path.join(directory, "current.json"), "utf8")).revisionHash);
      const report = novelPlayQualitySchema.parse(JSON.parse(await fs.readFile(path.join(directory, `${revisionHash}.json`), "utf8")));
      if (contentHash(report) !== revisionHash || report.subjectSnapshotHash !== subjectHash) throw new Error("Evaluation manifest integrity check failed");
      return report;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async write(value: NovelPlayQuality): Promise<void> {
    const report = novelPlayQualitySchema.parse(value), directory = this.directory(report.subjectSnapshotHash), revisionHash = contentHash(report);
    const file = path.join(directory, `${revisionHash}.json`);
    await fs.mkdir(directory, { recursive: true });
    const serialized = `${canonicalJson(report)}\n`;
    try { await fs.writeFile(file, serialized, { mode: 0o400, flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await fs.readFile(file, "utf8") !== serialized) throw error; }
    const temporary = path.join(directory, `current.${crypto.randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, `${canonicalJson({ revisionHash })}\n`, { mode: 0o600 }); await fs.rename(temporary, path.join(directory, "current.json")); }
    finally { await fs.rm(temporary, { force: true }); }
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PreparedNovelBundle } from "../compiler/prepared-cache.js";
import { preparedSubjectHash } from "../compiler/certification.js";
import { majorRoleCandidates, validateRoleRoster } from "../compiler/role-roster.js";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { deriveCharacterEntrySeed } from "../world/entry-context.js";
import { predicateSchema } from "../world/model.js";
import { playerActionCandidateSchema } from "../world/player-action.js";
import { worldStorageRoot } from "../world/paths.js";
import { compilerSemanticGoldSchema } from "./compiler-eval.js";
import { BENCHMARK_SEMANTIC_LAYERS } from "./benchmark-corpus.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/), nonempty = z.string().trim().min(1);
const conditions = z.array(predicateSchema).min(1);
export const novelEvaluationPlanInputSchema = z.object({
  reviewerRunIds: z.array(nonempty).min(1),
  gold: compilerSemanticGoldSchema,
  inapplicableLayers: z.array(z.object({ layer: z.enum(BENCHMARK_SEMANTIC_LAYERS), reason: nonempty }).strict()),
  criticalChecks: z.array(z.object({ id: nonempty, jsonPointer: z.string().startsWith("/canonical/"), expected: z.unknown() }).strict()).min(1),
  roles: z.array(z.object({
    candidateId: nonempty, actorId: nonempty, entryCutHash: hash,
    utterances: z.array(nonempty).min(1),
    // A finite experiment horizon; reaching it never counts as legal termination.
    maxTurns: z.number().int().positive(),
    tasks: z.array(z.object({ id: nonempty, description: nonempty, conditions }).strict()).min(1),
    termination: z.object({ description: nonempty, conditions }).strict().optional(),
    knowledgeChecks: z.array(z.object({ actorId: nonempty, claimId: nonempty, when: conditions }).strict()).min(1),
    rejectedProbes: z.array(z.object({ id: nonempty, candidate: playerActionCandidateSchema }).strict()).min(1),
  }).strict()).min(1),
}).strict();
export const novelEvaluationPlanSchema = novelEvaluationPlanInputSchema.extend({
  version: z.literal(1), sourceId: nonempty, sourceSha256: hash, subjectSnapshotHash: hash, rosterHash: hash, frozenAt: z.string().datetime(),
}).strict();
export type NovelEvaluationPlan = z.infer<typeof novelEvaluationPlanSchema>;

export function validateEvaluationPlan(plan: NovelEvaluationPlan, bundle: PreparedNovelBundle): void {
  const roster = bundle.compilerSnapshot.roleRoster;
  if (!roster || validateRoleRoster(roster).length) throw new Error("EVALUATION_ROSTER_REQUIRED: complete the independent source roster before freezing evaluation");
  if (plan.sourceId !== bundle.source.id || plan.sourceSha256 !== bundle.source.contentSha256 || plan.subjectSnapshotHash !== preparedSubjectHash(bundle) || plan.rosterHash !== contentHash(roster)) throw new Error("EVALUATION_PLAN_STALE: source, roster or candidate inputs changed");
  const expected = majorRoleCandidates(roster).map((role) => role.id).sort();
  if (canonicalJson(expected) !== canonicalJson(plan.roles.map((role) => role.candidateId).sort())) throw new Error("EVALUATION_MAJOR_DENOMINATOR_CHANGED: every independent major must have exactly one scenario");
  if (new Set(plan.reviewerRunIds).size !== plan.reviewerRunIds.length || plan.reviewerRunIds.some((id) => roster.extractionRunIds.includes(id))) throw new Error("EVALUATION_GOLD_NOT_INDEPENDENT: reviewers must be distinct from extraction");
  if (new Set(plan.criticalChecks.map((check) => check.id)).size !== plan.criticalChecks.length || new Set(plan.inapplicableLayers.map((layer) => layer.layer)).size !== plan.inapplicableLayers.length) throw new Error("EVALUATION_INVENTORY_DUPLICATED: checks and layer declarations must be unique");
  for (const role of plan.roles) {
    if (roster.candidates.find((candidate) => candidate.id === role.candidateId)?.entityId !== role.actorId || deriveCharacterEntrySeed(bundle, role.actorId).cut.hash !== role.entryCutHash) throw new Error(`EVALUATION_ENTRY_STALE: ${role.candidateId}`);
    if (new Set(role.tasks.map((task) => task.id)).size !== role.tasks.length || new Set(role.rejectedProbes.map((probe) => probe.id)).size !== role.rejectedProbes.length) throw new Error(`EVALUATION_INVENTORY_DUPLICATED: ${role.candidateId}`);
  }
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.sourceId === "string" && record.sourceId !== bundle.source.id) throw new Error("EVALUATION_GOLD_SOURCE_MISMATCH: gold includes another source");
    Object.values(record).forEach(inspect);
  };
  inspect(plan.gold);
}

/** Freezes actual gold, tasks and probes before any model execution, not just their IDs. */
export class NovelEvaluationPlanStore {
  readonly root: string;
  constructor(root: string) { this.root = path.join(worldStorageRoot(root), "compiler", "evaluation-plans", "v1"); }
  async freeze(input: unknown, bundle: PreparedNovelBundle): Promise<{ hash: string; plan: NovelEvaluationPlan }> {
    const plan = novelEvaluationPlanSchema.parse({ ...novelEvaluationPlanInputSchema.parse(input), version: 1, sourceId: bundle.source.id,
      sourceSha256: bundle.source.contentSha256, subjectSnapshotHash: preparedSubjectHash(bundle), rosterHash: contentHash(bundle.compilerSnapshot.roleRoster), frozenAt: new Date().toISOString() });
    validateEvaluationPlan(plan, bundle);
    const digest = contentHash(plan);
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(path.join(this.root, `${digest}.json`), `${canonicalJson(plan)}\n`, { mode: 0o400, flag: "wx" });
    return { hash: digest, plan };
  }
  async read(digest: string): Promise<NovelEvaluationPlan> {
    const plan = novelEvaluationPlanSchema.parse(JSON.parse(await fs.readFile(path.join(this.root, `${hash.parse(digest)}.json`), "utf8")));
    if (contentHash(plan) !== digest) throw new Error("EVALUATION_PLAN_INTEGRITY_FAILED: frozen gold or scenario content changed");
    return plan;
  }
}

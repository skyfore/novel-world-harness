import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { WORLD_ENGINE_VERSION, WORLD_SCHEMA_VERSION, validationIssueSchema } from "../world/model.js";
import { worldStorageRoot } from "../world/paths.js";
import { buildPreparedClosure, closureGraphSchema } from "./closure.js";
import { buildRoleRoster, majorRoleCandidates, roleRosterSchema, validateRoleRoster } from "./role-roster.js";
import { playabilityManifestSchema, probeMajorRoleEntries } from "./playability.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";
import { NovelPlayQualityStore, novelPlayQualitySchema, validateNovelPlayQuality } from "../eval/novel-play-quality.js";
import { baseStructuralUnits, validateSourceStructure } from "./structure.js";
import { deriveCharacterEntrySeed } from "../world/entry-context.js";
import { annotationAnchors } from "./annotations.js";
import { assessSemanticSupport, supportAssessmentSchema } from "./semantic-support.js";
import { buildSceneExecutionContracts, sceneExecutionContractSchema } from "./scene-execution-contracts.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const novelClosureAssessmentSchema = z.object({
  version: z.literal(1), sourceId: z.string(), sourceSha256: hashSchema, subjectSnapshotHash: hashSchema,
  engineVersion: z.string(), schemaVersion: z.number().int(),
  closure: closureGraphSchema, roster: roleRosterSchema.nullable(), playability: playabilityManifestSchema.nullable(),
  entryReady: z.boolean(), fullNovelReady: z.boolean(),
  quality: novelPlayQualitySchema.nullable(),
  supportAssessments: z.array(supportAssessmentSchema), sceneContracts: z.array(sceneExecutionContractSchema),
  issues: z.array(validationIssueSchema),
}).strict();
export type NovelClosureAssessment = z.infer<typeof novelClosureAssessmentSchema>;

/** Derived outputs are excluded so the snapshot, probes and certificate never form a hash cycle. */
export function preparedSubjectHash(bundle: Pick<PreparedNovelBundle, "version" | "source" | "canonical" | "compilerSnapshot" | "compilerFingerprint" | "segmenterVersion" | "batchIds" | "chapterSplitPlan">): string {
  return contentHash({ version: bundle.version, source: bundle.source, canonical: bundle.canonical, compilerSnapshot: bundle.compilerSnapshot,
    compilerFingerprint: bundle.compilerFingerprint ?? null, segmenterVersion: bundle.segmenterVersion, batchIds: [...bundle.batchIds].sort(), chapterSplitPlan: bundle.chapterSplitPlan ?? null });
}

/** Readiness is derived from current frozen inputs. This inspection cannot publish or create a public play session. */
export async function assessNovelClosure(root: string, bundle: PreparedNovelBundle): Promise<NovelClosureAssessment> {
  const subjectSnapshotHash = preparedSubjectHash(bundle), closure = buildPreparedClosure(bundle);
  const issues = [...closure.issues, ...validateFrozenAccounting(bundle)];
  const snapshot = bundle.compilerSnapshot;
  let roster: NovelClosureAssessment["roster"] = null, playability: NovelClosureAssessment["playability"] = null;
  try {
    const fresh = buildRoleRoster({ sourceId: bundle.source.id, sourceSha256: bundle.source.contentSha256, unitIds: snapshot.structure.baseUnitIds,
      entities: bundle.canonical.entities, annotations: snapshot.annotations, resolutions: snapshot.entityResolutions });
    const saved = snapshot.roleRoster;
    roster = saved?.subjectHash === fresh.subjectHash ? saved : fresh;
    issues.push(...validateRoleRoster(roster));
    playability = await probeMajorRoleEntries(bundle, roster, subjectSnapshotHash);
    issues.push(...playability.issues, ...playability.roles.flatMap((role) => role.issues));
  } catch (error) {
    issues.push({ code: "ROSTER_ASSESSMENT_BLOCKED", message: error instanceof Error ? error.message : String(error) });
  }
  const quality = await new NovelPlayQualityStore(root).read(subjectSnapshotHash);
  const support = assessSemanticSupport(bundle, quality?.supportReviews), scenes = buildSceneExecutionContracts(bundle, roster);
  issues.push(...support.issues, ...scenes.issues);
  const entryReady = issues.length === 0 && Boolean(playability && playability.majorTotal > 0 && playability.readyTotal === playability.majorTotal);
  const qualityIssues = roster ? validateNovelPlayQuality(quality, { sourceSha256: bundle.source.contentSha256, subjectSnapshotHash, roster, sourceBytes: snapshot.structure.sourceBytes, sourceUnits: snapshot.structure.baseUnitIds.length, engineVersion: WORLD_ENGINE_VERSION, schemaVersion: WORLD_SCHEMA_VERSION }) : [{ code: "NOVEL_ROSTER_REQUIRED", message: "Quality evaluation requires a frozen independent major roster" }];
  issues.push(...qualityIssues);
  // Entry probes establish deterministic operability, never semantic recall or 50-turn Pi behavior.
  const assessment = novelClosureAssessmentSchema.parse({ version: 1, sourceId: bundle.source.id, sourceSha256: bundle.source.contentSha256, subjectSnapshotHash,
    engineVersion: WORLD_ENGINE_VERSION, schemaVersion: WORLD_SCHEMA_VERSION, closure, roster, playability, entryReady, fullNovelReady: entryReady && qualityIssues.length === 0, quality, supportAssessments: support.assessments, sceneContracts: scenes.contracts,
    issues: [...new Map(issues.map((issue) => [`${issue.code}/${issue.path ?? ""}/${issue.message}`, issue])).values()] });
  await new NovelClosureStore(root).write(assessment);
  return assessment;
}

export function validateAssessmentRevision(bundle: PreparedNovelBundle, assessment: NovelClosureAssessment): string[] {
  const issues: string[] = [];
  if (preparedSubjectHash(bundle) !== assessment.subjectSnapshotHash) issues.push("ENTRY_CUT_STALE: prepared inputs changed after entry evaluation");
  if (assessment.sourceId !== bundle.source.id || assessment.sourceSha256 !== bundle.source.contentSha256) issues.push("WORLD_SOURCE_MISMATCH: certificate belongs to another source");
  if (assessment.engineVersion !== WORLD_ENGINE_VERSION || assessment.schemaVersion !== WORLD_SCHEMA_VERSION) issues.push("WORLD_VERSION_UNSUPPORTED: evaluator fingerprint changed");
  if (contentHash(buildPreparedClosure(bundle)) !== contentHash(assessment.closure)) issues.push("WORLD_CLOSURE_STALE: dependency revisions changed");
  if (contentHash(buildSceneExecutionContracts(bundle, assessment.roster).contracts) !== contentHash(assessment.sceneContracts)) issues.push("SCENE_CONTRACT_STALE: scene execution inputs changed");
  if (contentHash(assessSemanticSupport(bundle, assessment.quality?.supportReviews).assessments) !== contentHash(assessment.supportAssessments)) issues.push("SUPPORT_ASSESSMENT_STALE: support review inputs changed");
  if (assessment.playability && (assessment.playability.subjectSnapshotHash !== assessment.subjectSnapshotHash || assessment.playability.rosterHash !== contentHash(assessment.roster))) issues.push("MAJOR_ROLE_ROSTER_MISMATCH: entry probes refer to another source or roster");
  return issues;
}

/** The same fail-closed gate is used by publication, activation, restore and fresh play. */
export function assertPreparedReadiness(bundle: PreparedNovelBundle): void {
  const assessment = bundle.readiness;
  if (!assessment) throw new Error("WORLD_CLOSURE_BLOCKED: this revision has no full-novel readiness certificate. Complete independent role review and candidate evaluation before publication.");
  const issues = validateAssessmentRevision(bundle, assessment);
  issues.push(...assessSemanticSupport(bundle, assessment.quality?.supportReviews).issues.map((issue) => `${issue.code}: ${issue.message}`), ...buildSceneExecutionContracts(bundle, assessment.roster).issues.map((issue) => `${issue.code}: ${issue.message}`));
  issues.push(...buildPreparedClosure(bundle).issues.map((issue) => `${issue.code}: ${issue.message}`), ...validateFrozenAccounting(bundle).map((issue) => `${issue.code}: ${issue.message}`));
  issues.push(...assessment.issues.map((issue) => `${issue.code}: ${issue.message}`));
  if (!assessment.entryReady || !assessment.fullNovelReady || !assessment.roster || !assessment.playability) issues.push("WORLD_CLOSURE_BLOCKED: all major roles and independent semantic/live evaluations must pass");
  if (assessment.roster) {
    issues.push(...validateRoleRoster(assessment.roster).map((issue) => `${issue.code}: ${issue.message}`));
    if (contentHash(assessment.roster) !== contentHash(bundle.compilerSnapshot.roleRoster)) issues.push("MAJOR_ROLE_ROSTER_MISMATCH: certificate roster differs from the frozen compiler snapshot");
    const fresh = buildRoleRoster({ sourceId: bundle.source.id, sourceSha256: bundle.source.contentSha256, unitIds: bundle.compilerSnapshot.structure.baseUnitIds, entities: bundle.canonical.entities, annotations: bundle.compilerSnapshot.annotations, resolutions: bundle.compilerSnapshot.entityResolutions });
    if (contentHash({ ...assessment.roster, reviews: [] }) !== contentHash(fresh)) issues.push("MAJOR_ROLE_ROSTER_STALE: candidate identity inputs changed");
    issues.push(...validateNovelPlayQuality(assessment.quality, { sourceSha256: bundle.source.contentSha256, subjectSnapshotHash: assessment.subjectSnapshotHash, roster: assessment.roster, sourceBytes: bundle.compilerSnapshot.structure.sourceBytes, sourceUnits: bundle.compilerSnapshot.structure.baseUnitIds.length, engineVersion: WORLD_ENGINE_VERSION, schemaVersion: WORLD_SCHEMA_VERSION }).map((issue) => `${issue.code}: ${issue.message}`));
    if (assessment.playability) {
      const major = majorRoleCandidates(assessment.roster), results = assessment.playability.roles;
      if (assessment.playability.majorTotal !== major.length || canonicalJson(major.map((role) => role.id).sort()) !== canonicalJson(results.map((role) => role.candidateId).sort())) issues.push("MAJOR_ROLE_DENOMINATOR_CHANGED: probes must cover every frozen major exactly once");
      for (const candidate of major) {
        const role = results.find((result) => result.candidateId === candidate.id);
        if (!candidate.entityId || role?.actorId !== candidate.entityId) { issues.push(`MAJOR_ROLE_IDENTITY_MISMATCH: ${candidate.id}`); continue; }
        try {
          if (role.entryCutHash !== deriveCharacterEntrySeed(bundle, candidate.entityId).cut.hash) issues.push(`ENTRY_CUT_STALE: ${candidate.id}`);
        } catch (error) { issues.push(`MAJOR_ROLE_ENTRY_BLOCKED: ${String(error)}`); }
        if (canonicalJson(role.probes.map((probe) => probe.kind).sort()) !== canonicalJson(["decision", "fork", "genesis", "intent", "resume", "wait"])) issues.push(`MAJOR_ROLE_PROBES_INCOMPLETE: ${candidate.id}`);
      }
      issues.push(...assessment.playability.issues.map((issue) => `${issue.code}: ${issue.message}`));
    }
  }
  if (assessment.playability && (assessment.playability.majorTotal === 0 || assessment.playability.majorTotal !== assessment.playability.readyTotal || assessment.playability.roles.some((role) => role.status !== "ready" || !role.actorId || !role.entryCutHash || role.issues.length || role.probes.length !== 6 || role.probes.some((probe) => !probe.passed)))) issues.push("MAJOR_ROLE_NOT_CERTIFIED: role probe results are incomplete");
  if (issues.length) throw new Error(`WORLD_CLOSURE_BLOCKED: ${[...new Set(issues)].join("; ")}`);
}

export function validateFrozenAccounting(bundle: PreparedNovelBundle) {
  const issues: z.infer<typeof validationIssueSchema>[] = [];
  const { structure, accounting } = bundle.compilerSnapshot;
  try { validateSourceStructure(structure); }
  catch (error) { return [{ code: "SOURCE_PARTITION_INVALID", message: String(error) }]; }
  if (!accounting || accounting.sourceId !== bundle.source.id || accounting.sourceSha256 !== bundle.source.contentSha256 || accounting.structureVersion !== structure.structureVersion) issues.push({ code: "SOURCE_ACCOUNTING_STALE", message: "Accounting must refer to the frozen source and structure" });
  const records = new Map(accounting?.records.map((record) => [record.unitId, record]) ?? []);
  const annotations = new Map(bundle.compilerSnapshot.annotations.map((annotation) => [annotation.id, annotation]));
  const assertions = new Map(bundle.compilerSnapshot.evidenceBindings.flatMap((binding) => binding.assertions.map((assertion) => [assertion.id, assertion] as const)));
  if (records.size !== (accounting?.records.length ?? 0) || [...records.keys()].some((id) => !structure.baseUnitIds.includes(id))) issues.push({ code: "SOURCE_ACCOUNTING_INVENTORY_INVALID", message: "Accounting has duplicate or unknown units" });
  for (const unit of baseStructuralUnits(structure)) {
    const record = records.get(unit.id);
    if (!record || ["unresolved", "intentionally-deferred"].includes(record.status)) issues.push({ code: "SOURCE_UNIT_UNACCOUNTED", message: `Source unit ${unit.id} is missing or unresolved`, path: unit.id });
    else if (record.status === "represented" && !record.annotationIds.length && !record.evidenceAssertionIds.length) issues.push({ code: "SOURCE_REPRESENTATION_UNSUPPORTED", message: `Represented unit ${unit.id} has no annotation or evidence assertion`, path: unit.id });
    else if (record.status !== "represented" && (!record.reason?.trim() || (record.reviewedBy === "deterministic" && !(unit.kind === "non-scene" && record.status === "background-only")))) issues.push({ code: "SOURCE_EXCLUSION_UNREVIEWED", message: `Excluded source unit ${unit.id} requires an explicit model or human disposition`, path: unit.id });
    if (record?.status === "represented") {
      const covers = (anchors: Array<{ sourceId: string; startByte: number; endByte: number }>) => anchors.some((anchor) => anchor.sourceId === bundle.source.id && anchor.startByte < unit.anchor.endByte && anchor.endByte > unit.anchor.startByte);
      for (const id of record.annotationIds) {
        const annotation = annotations.get(id);
        if (!annotation || !covers(annotationAnchors(annotation))) issues.push({ code: "SOURCE_REPRESENTATION_REFERENCE_INVALID", message: `Unit ${unit.id} references missing or non-overlapping annotation ${id}`, path: unit.id });
      }
      for (const id of record.evidenceAssertionIds) {
        const assertion = assertions.get(id);
        if (!assertion || !covers(assertion.anchors)) issues.push({ code: "SOURCE_REPRESENTATION_REFERENCE_INVALID", message: `Unit ${unit.id} references missing or non-overlapping evidence assertion ${id}`, path: unit.id });
      }
    }
  }
  return issues;
}

export class NovelClosureStore {
  private readonly root: string;
  constructor(root: string) { this.root = path.join(worldStorageRoot(root), "compiler", "closure", "v1"); }
  private file(sourceId: string, subjectHash: string): string { return path.join(this.root, contentHash(sourceId), hashSchema.parse(subjectHash), "assessment.json"); }
  async write(value: NovelClosureAssessment): Promise<void> {
    const assessment = novelClosureAssessmentSchema.parse(value), file = this.file(assessment.sourceId, assessment.subjectSnapshotHash);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, `${canonicalJson(assessment)}\n`, { mode: 0o600 }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async read(sourceId: string, subjectHash: string): Promise<NovelClosureAssessment | null> {
    try { return novelClosureAssessmentSchema.parse(JSON.parse(await fs.readFile(this.file(sourceId, subjectHash), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
}

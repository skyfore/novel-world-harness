import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { idSchema, type Entity, type ValidationIssue } from "../world/model.js";
import { worldStorageRoot } from "../world/paths.js";
import type { SourceAnnotation } from "./annotations.js";
import type { IdentityResolution } from "./entity-resolution.js";
import { characterDimensionIdSchema } from "../world/character-ontology.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const roleCandidateSchema = z.object({
  id: idSchema, name: z.string().min(1), entityId: idSchema.optional(),
  mentionIds: z.array(idSchema), resolutionIds: z.array(idSchema),
}).strict();
export type RoleCandidate = z.infer<typeof roleCandidateSchema>;

/** Source reviewers record expectations before seeing compiled character models. */
export const roleDevelopmentExpectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stable"), rationale: z.string().trim().min(1).max(2000), basisUnitIds: z.array(idSchema).min(1) }).strict(),
  z.object({ kind: z.literal("unknown"), rationale: z.string().trim().min(1).max(2000), basisUnitIds: z.array(idSchema).min(1) }).strict(),
  z.object({ kind: z.literal("changes"), rationale: z.string().trim().min(1).max(2000), changes: z.array(z.object({
    dimensionId: characterDimensionIdSchema,
    direction: z.enum(["increase", "decrease"]),
    rationale: z.string().trim().min(1).max(2000),
    beforeUnitIds: z.array(idSchema).min(1), afterUnitIds: z.array(idSchema).min(1),
  }).strict()).min(1).max(32) }).strict(),
]);
export type RoleDevelopmentExpectation = z.infer<typeof roleDevelopmentExpectationSchema>;

export const roleRosterEntrySchema = z.object({
  candidateId: idSchema,
  importance: z.enum(["major", "supporting", "incidental"]),
  rationale: z.string().trim().min(1).max(2000),
  basisUnitIds: z.array(idSchema).min(1),
  developmentExpectation: roleDevelopmentExpectationSchema.optional(),
}).strict();
export const roleRosterReviewSchema = z.object({
  version: z.literal(2).optional(),
  runId: idSchema,
  subjectHash: hashSchema,
  reviewedUnitIds: z.array(idSchema).min(1),
  entries: z.array(roleRosterEntrySchema).min(1),
  missingMajorCharacters: z.array(z.object({ name: z.string().trim().min(1), rationale: z.string().trim().min(1), basisUnitIds: z.array(idSchema).min(1) }).strict()).default([]),
}).strict();
export type RoleRosterReview = z.infer<typeof roleRosterReviewSchema>;

export const roleRosterSchema = z.object({
  version: z.literal(1), sourceId: idSchema, sourceSha256: hashSchema,
  subjectHash: hashSchema, unitIds: z.array(idSchema).min(1),
  extractionRunIds: z.array(idSchema), candidates: z.array(roleCandidateSchema).min(1),
  reviews: z.array(roleRosterReviewSchema).max(2),
}).strict();
export type RoleRoster = z.infer<typeof roleRosterSchema>;

/** The denominator is independent of entry availability. Unresolved people remain candidates. */
export function buildRoleRoster(input: {
  sourceId: string; sourceSha256: string; unitIds: string[];
  entities: readonly Entity[]; annotations: readonly SourceAnnotation[]; resolutions: readonly IdentityResolution[];
}): RoleRoster {
  const candidates = new Map<string, RoleCandidate>();
  for (const entity of input.entities.filter((x) => x.kind === "character" && x.evidence.some((e) => e.span.sourceId === input.sourceId))) {
    const id = `role-${contentHash({ sourceId: input.sourceId, entityId: entity.id }).slice(0, 24)}`;
    candidates.set(id, { id, name: entity.canonicalName, entityId: entity.id, mentionIds: [], resolutionIds: [] });
  }
  const byEntity = new Map([...candidates.values()].map((x) => [x.entityId, x]));
  const resolutions = new Map(input.resolutions.filter((x) => x.sourceId === input.sourceId).map((x) => [x.mentionId, x]));
  for (const mention of input.annotations) {
    if (mention.sourceId !== input.sourceId || mention.annotationType !== "entity-mention" || !mention.kindCandidates.includes("character")) continue;
    const resolution = resolutions.get(mention.id);
    if (resolution?.status === "non-referential") continue;
    const matched = resolution?.entityId ? byEntity.get(resolution.entityId) : undefined;
    if (matched) {
      matched.mentionIds.push(mention.id); matched.resolutionIds.push(resolution!.id); continue;
    }
    const id = `role-${contentHash({ sourceId: input.sourceId, mentionId: mention.id }).slice(0, 24)}`;
    candidates.set(id, { id, name: mention.surface || mention.interpretation || mention.id, mentionIds: [mention.id], resolutionIds: resolution ? [resolution.id] : [] });
  }
  const subject = {
    version: 1 as const, sourceId: input.sourceId, sourceSha256: input.sourceSha256,
    unitIds: [...new Set(input.unitIds)].sort(),
    extractionRunIds: [...new Set(input.annotations.filter((x) => x.sourceId === input.sourceId).map((x) => x.derivation.runId))].sort(),
    candidates: [...candidates.values()].map((x) => ({ ...x, mentionIds: x.mentionIds.sort(), resolutionIds: [...new Set(x.resolutionIds)].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
  };
  // Bind the subject to semantic identity inputs as well as the visible candidate list.
  return roleRosterSchema.parse({ ...subject, subjectHash: contentHash({ ...subject,
    identityInputs: { entities: [...input.entities].sort((a, b) => a.id.localeCompare(b.id)), annotations: [...input.annotations].sort((a, b) => a.id.localeCompare(b.id)), resolutions: [...input.resolutions].sort((a, b) => a.id.localeCompare(b.id)) },
  }), reviews: [] });
}

export function validateRosterReview(roster: RoleRoster, review: RoleRosterReview): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fail = (code: string, message: string) => issues.push({ code, message });
  if (review.subjectHash !== roster.subjectHash) fail("ROSTER_STALE_REVIEW", "Roster review refers to stale source or identity inputs");
  if (roster.extractionRunIds.includes(review.runId) || roster.reviews.some((x) => x.runId === review.runId)) fail("ROSTER_INDEPENDENT_REVIEW_REQUIRED", "Review must use a separate run from extraction and the other review");
  const expected = new Set(roster.candidates.map((x) => x.id));
  const actual = new Set(review.entries.map((x) => x.candidateId));
  if (actual.size !== review.entries.length || actual.size !== expected.size || [...expected].some((id) => !actual.has(id))) fail("ROSTER_DENOMINATOR_MISMATCH", "Review must classify every candidate exactly once, including unresolved people");
  const units = new Set(roster.unitIds);
  if (new Set(review.reviewedUnitIds).size !== units.size || review.reviewedUnitIds.some((id) => !units.has(id))) fail("ROSTER_FULL_SOURCE_REVIEW_REQUIRED", "Review must account for the complete source unit inventory");
  for (const entry of review.entries) {
    if (entry.basisUnitIds.some((id) => !units.has(id))) fail("ROSTER_UNKNOWN_EVIDENCE_UNIT", `Role ${entry.candidateId} uses an unknown source unit`);
    const development = entry.developmentExpectation;
    if (review.version === 2 && !development) fail("ROSTER_DEVELOPMENT_EXPECTATION_REQUIRED", `Role ${entry.candidateId} needs an independent source development expectation, including unknown when evidence is insufficient`);
    if (!development) continue;
    const references = development.kind === "changes" ? development.changes.flatMap(change => [...change.beforeUnitIds, ...change.afterUnitIds]) : development.basisUnitIds;
    if (references.some(id => !units.has(id))) fail("ROSTER_UNKNOWN_EVIDENCE_UNIT", `Role ${entry.candidateId} development expectation uses an unknown source unit`);
  }
  for (const omitted of review.missingMajorCharacters ?? []) if (omitted.basisUnitIds.some((id) => !units.has(id))) fail("ROSTER_UNKNOWN_EVIDENCE_UNIT", `Omitted major ${omitted.name} uses an unknown source unit`);
  return issues;
}

/** Conservative merge: either independent review marking a role major keeps it major. */
export function majorRoleCandidates(roster: RoleRoster): RoleCandidate[] {
  const major = new Set(roster.reviews.flatMap((review) => review.entries.filter((x) => x.importance === "major").map((x) => x.candidateId)));
  const candidates = roster.candidates.filter((candidate) => major.has(candidate.id));
  // Independent source reading can discover people absent from both accepted entities and mentions.
  // Never invent an identity match from a name; unresolved discoveries stay in the denominator.
  const omissions = roster.reviews.flatMap((review) => (review.missingMajorCharacters ?? []).map((person): RoleCandidate => ({
    id: `omitted-role-${contentHash({ sourceId: roster.sourceId, name: person.name, units: [...person.basisUnitIds].sort() }).slice(0, 24)}`,
    name: person.name, mentionIds: [], resolutionIds: [],
  })));
  return [...new Map([...candidates, ...omissions].map((candidate) => [candidate.id, candidate])).values()];
}

/** These are independent requirements, not character-model satisfaction results. */
export function reviewedRoleDevelopmentRequirements(roster: RoleRoster) {
  const accumulated: RoleRoster = { ...roster, reviews: [] };
  let reviewsValid = roster.reviews.length === 2;
  for (const review of roster.reviews) {
    if (validateRosterReview(accumulated, review).length) reviewsValid = false;
    accumulated.reviews.push(review);
  }
  return majorRoleCandidates(roster).map(candidate => {
    const reviews = roster.reviews.map(review => ({
      runId: review.runId,
      expectation: review.version === 2 ? review.entries.find(entry => entry.candidateId === candidate.id)?.developmentExpectation ?? null : null,
    }));
    const kinds = reviews.map(review => review.expectation?.kind ?? "unknown");
    const status = !reviewsValid || kinds.includes("unknown") || new Set(kinds).size !== 1
      ? "unknown" as const : kinds[0] === "stable" ? "stable" as const : "changes" as const;
    const definition = { id: `${candidate.id}:development`, sourceId: roster.sourceId, sourceSha256: roster.sourceSha256,
      rosterSubjectHash: roster.subjectHash, candidateId: candidate.id, ...(candidate.entityId ? { actorId: candidate.entityId } : {}), reviews, status };
    return { ...definition, revisionHash: contentHash(definition) };
  });
}

export function validateRoleDevelopmentExpectations(roster: RoleRoster): ValidationIssue[] {
  return reviewedRoleDevelopmentRequirements(roster).filter(requirement => requirement.status === "unknown").map(requirement => ({
    code: "ROSTER_DEVELOPMENT_EXPECTATION_UNKNOWN", path: requirement.id,
    message: `Role ${requirement.candidateId} lacks two compatible independent development expectations; missing legacy data, conflicting reviews and insufficient evidence cannot certify stable development`,
  }));
}

export function validateRoleRoster(roster: RoleRoster): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (roster.reviews.length !== 2) issues.push({ code: "ROSTER_REVIEW_INCOMPLETE", message: "Two independent full-source role reviews are required" });
  const accumulated: RoleRoster = { ...roster, reviews: [] };
  for (const review of roster.reviews) {
    issues.push(...validateRosterReview(accumulated, review)); accumulated.reviews.push(review);
  }
  if (!majorRoleCandidates(roster).length) issues.push({ code: "ROSTER_NO_MAJOR_CHARACTERS", message: "No major character has been established by source review" });
  for (const candidate of majorRoleCandidates(roster)) if (!candidate.entityId) issues.push({ code: "ROSTER_MAJOR_IDENTITY_UNRESOLVED", message: `Major character ${candidate.name} lacks a resolved entity identity`, path: candidate.id });
  return issues;
}

export class RoleRosterStore {
  private readonly root: string;
  constructor(workspaceRoot: string) { this.root = path.join(worldStorageRoot(workspaceRoot), "compiler", "role-rosters"); }
  private file(sourceId: string) { return path.join(this.root, `${contentHash(sourceId)}.json`); }
  async read(sourceId: string): Promise<RoleRoster | null> {
    try { return roleRosterSchema.parse(JSON.parse(await fs.readFile(this.file(sourceId), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async write(input: RoleRoster): Promise<void> {
    const roster = roleRosterSchema.parse(input);
    await fs.mkdir(this.root, { recursive: true });
    const target = this.file(roster.sourceId), temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, `${canonicalJson(roster)}\n`, { encoding: "utf8", mode: 0o600 }); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async replaceCurrent(sourceId: string, roster: RoleRoster | null): Promise<void> {
    if (roster) {
      if (roster.sourceId !== sourceId) throw new Error("Role roster replacement escapes its source");
      await this.write(roster);
    } else await fs.rm(this.file(sourceId), { force: true });
  }
  async review(current: RoleRoster, input: RoleRosterReview): Promise<RoleRoster> {
    const review = roleRosterReviewSchema.parse(input), issues = validateRosterReview(current, review);
    if (issues.length) throw new Error(issues.map((x) => `${x.code}: ${x.message}`).join("; "));
    const next = roleRosterSchema.parse({ ...current, reviews: [...current.reviews, review] });
    await this.write(next); return next;
  }
}

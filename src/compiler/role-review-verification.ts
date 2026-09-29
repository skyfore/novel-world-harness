import { z } from "zod";
import { contentHash } from "../world/canonical.js";

const text = z.string().trim().min(1).max(2000);
const refs = z.array(z.string().min(1)).min(1).max(64);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const roleQuestionSchema = z.object({
  questionId: hash, planHash: hash, page: z.number().int().nonnegative(),
  text, sourceUnitIds: z.array(z.string()), impact: z.literal("critical"),
}).strict();
export const roleQuestionDispositionSchema = z.object({
  questionId: hash, status: z.enum(["resolved", "blocked"]), rationale: text, basisUnitIds: refs,
}).strict();
const claimCheckSchema = z.object({
  kind: z.enum(["importance", "identity", "development"]),
  verdict: z.enum(["supported", "contradicted", "insufficient"]), rationale: text, basisUnitIds: refs,
}).strict();
export const roleClaimAuditSchema = z.object({
  candidateId: z.string(), claimRevision: hash, atlasRevision: hash, packetHash: hash,
  verdict: z.enum(["supported", "contradicted", "insufficient"]),
  rationale: text, basisUnitIds: refs,
  counterevidence: z.object({ searchedUnitIds: refs, rationale: text }).strict(),
  checks: z.array(claimCheckSchema).length(3),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.checks.map(c => c.kind)).size !== 3 || (value.verdict === "supported" && value.checks.some(c => c.verdict !== "supported"))) ctx.addIssue({code: "custom", message: "Audit must separately assess importance, identity and development; unresolved checks cannot support the claim"});
});
export type RoleClaimAudit = z.infer<typeof roleClaimAuditSchema>;
export type RoleQuestion = z.infer<typeof roleQuestionSchema>;
export type RoleQuestionDisposition = z.infer<typeof roleQuestionDispositionSchema>;
export const roleDiscoveryDispositionSchema = z.object({
  findingId: hash, candidateIds: z.array(z.string()).max(32),
  disposition: z.enum(["mapped", "missing-major", "nonmajor", "blocked"]),
  rationale: text, basisUnitIds: refs,
}).strict();
// Legacy question strings identify their frozen source core (planHash/page), not
// individual finding citations. Do not invent precise evidence links during migration.
export function roleQuestions(planHash: string, page: number, note: { openQuestions: string[]; findings: {unitIds: string[]}[] }): RoleQuestion[] {
  return note.openQuestions.map((text, index) => ({ questionId: contentHash({ planHash, page, index, text }), planHash, page, text,
    sourceUnitIds: [], impact: "critical" }));
}
export function roleFindingId(planHash: string, page: number, index: number) { return contentHash({ planHash, page, index }); }
export function sameIds(actual: string[], expected: string[]) {
  return new Set(actual).size === actual.length && contentHash([...actual].sort()) === contentHash([...expected].sort());
}
export function roleEntryEvidence(entry: { basisUnitIds: string[]; developmentExpectation?: { basisUnitIds?: string[]; changes?: {beforeUnitIds: string[]; afterUnitIds: string[]}[] } }) {
  return [...new Set([...entry.basisUnitIds, ...(entry.developmentExpectation?.basisUnitIds ?? []),
    ...(entry.developmentExpectation?.changes ?? []).flatMap(c => [...c.beforeUnitIds, ...c.afterUnitIds])])];
}

export const roleEvidenceNeedSchema = z.object({
  question: text, missing: text, decisionImpact: text,
  searchedUnitIds: z.array(z.string()).max(64), requestedUnitIds: refs.max(16),
}).strict();
export type RoleEvidenceNeed = z.infer<typeof roleEvidenceNeedSchema>;

import { z } from "zod";
import { roleAuditWorkSchema, type RoleAuditWork } from "./role-review-work.js";
import { roleDiscoveryDispositionSchema, sameIds } from "./role-review-verification.js";

// Keep the retained receipt schema compatible. New tool schemas expose the
// conditional constraint that used to be discoverable only through a failure.
export const roleAuditSubmissionSchema = roleAuditWorkSchema.required({
  atlasRevision: true, questionDispositions: true, discoveryDispositions: true,
}).extend({ discoveryDispositions: z.array(z.discriminatedUnion("disposition", [
  roleDiscoveryDispositionSchema.extend({ disposition: z.literal("mapped"), candidateIds: z.array(z.string()).min(1).max(32) }),
  ...(["blocked", "missing-major", "nonmajor"] as const).map(disposition =>
    roleDiscoveryDispositionSchema.extend({ disposition: z.literal(disposition), candidateIds: z.array(z.string()).length(0) })),
])).max(64) });

export type RoleAuditIssue = { code: string; path: string; message: string; guidance: string;
  candidateIds?: string[]; unreadUnitIds?: string[] };
export class RoleAuditPreflightError extends Error {
  constructor(readonly issues: RoleAuditIssue[]) {
    super(issues.map(i => `${i.path}: ${i.message}${i.unreadUnitIds ? `: ${JSON.stringify({unreadUnitIds:i.unreadUnitIds})}` : ""}${i.candidateIds ? `: ${JSON.stringify({candidateIds:i.candidateIds})}` : ""}. ${i.guidance}`).join("\n"));
  }
}
export type RoleAuditAccess = {
  atlasRevision: string;
  questionIds: string[];
  discoveries: { findingId: string; name: string }[];
  candidates: { id: string; hasEntry: boolean; read: boolean; supported: boolean }[];
  fullyRead: ReadonlySet<string>;
  knownUnits: ReadonlySet<string>;
};

/** Pure, aggregate preflight. No proposal, progress credit, or authority is
 * created here. Submission and draft rechecks use the same checks. */
export function roleAuditIssues(audit: RoleAuditWork, access: RoleAuditAccess): RoleAuditIssue[] {
  const issues: RoleAuditIssue[] = [];
  const responsibility = "Copy atlasRevision, expectedQuestions[].questionId and discoveries[].findingId from the assigned packet. Preserve every responsibility and correct the same draft once; never guess or change scope.";
  if (audit.atlasRevision !== access.atlasRevision) issues.push({code:"atlas-revision",path:"atlasRevision",message:"Stale audit revision",guidance:responsibility});
  if (!audit.questionDispositions || !sameIds(audit.questionDispositions.map(q => q.questionId), access.questionIds)) issues.push({code:"question-responsibilities",path:"questionDispositions",message:"Incomplete audit responsibilities",guidance:responsibility});
  if (!audit.discoveryDispositions || !sameIds(audit.discoveryDispositions.map(d => d.findingId), access.discoveries.map(d => d.findingId))) issues.push({code:"discovery-responsibilities",path:"discoveryDispositions",message:"Incomplete audit responsibilities",guidance:responsibility});
  for (const [index, d] of (audit.discoveryDispositions ?? []).entries()) {
    const field = `discoveryDispositions[${index}]`;
    if ((d.disposition === "mapped") !== (d.candidateIds.length > 0)) issues.push({code:"disposition-candidates",path:`${field}.candidateIds`,candidateIds:d.candidateIds,
      message:"Mapped discovery must name candidates; other dispositions must not",
      guidance:d.disposition === "mapped" ? "Read the judgment with read_role_audit_inventory and copy candidates[].id once. If no entry exists, preserve this finding as blocked or evidenced missing-major."
        : "Keep this finding and its evidence. Clear candidateIds for this non-mapped disposition; retain any relevant identities and unresolved dependencies in rationale/unresolved. Do not reread missing entries or change the disposition merely to pass."});
    // A blocked finding cannot be repaired by trying to read an absent entry.
    if (d.disposition === "mapped") for (const id of [...new Set(d.candidateIds)]) {
      const candidate = access.candidates.find(c => c.id === id);
      if (!candidate) issues.push({code:"unknown-candidate",path:`${field}.candidateIds`,candidateIds:[id],message:"Unknown mapped candidate",
        guidance:"Use read_role_audit_inventory in this scope, copy candidates[].id and read its entry before one corrected submission. Never guess IDs or retry unchanged."});
      else if (!candidate.hasEntry) issues.push({code:"missing-judgment",path:`${field}.candidateIds`,candidateIds:[id],message:"Candidate has no judgment entry",
        guidance:"The inventory name has no entry to read. Preserve this discovery as blocked or evidenced missing-major with candidateIds=[] and retain its dependency in unresolved; do not retry reads, invent a judgment, or claim support."});
      else if (!candidate.read) issues.push({code:"unread-judgment",path:`${field}.candidateIds`,candidateIds:[id],message:"Unread mapped claim",
        guidance:"Call read_role_audit_inventory with this exact candidateId and read candidates[].entry. Correct once; never guess or reread unrelated candidates."});
      if (candidate && !candidate.supported && !audit.unresolved.some(issue => issue.includes(id))) issues.push({code:"unverified-dependency",path:"unresolved",candidateIds:[id],message:"Mapped claim is unverified",
        guidance:"Retain this exact candidate ID in unresolved together with its evidence boundary. Mapping does not repair or support the claim. Correct once under the same work ID."});
    }
    const discovery = access.discoveries.find(f => f.findingId === d.findingId);
    if (d.disposition === "missing-major" && discovery && !audit.missingMajorCharacters.some(m => m.name === discovery.name)) issues.push({code:"missing-major-retention",path:"missingMajorCharacters",message:`Missing-major discovery must retain ${discovery.name}`,
      guidance:"Copy the assigned discovery name into missingMajorCharacters with original evidence. Preserve the finding and correct once; never drop responsibilities."});
  }
  const refs = [...new Set([...audit.missingMajorCharacters.flatMap(m => m.basisUnitIds), ...(audit.questionDispositions ?? []).flatMap(q => q.basisUnitIds), ...(audit.discoveryDispositions ?? []).flatMap(d => d.basisUnitIds)])];
  const foreign = refs.filter(id => !access.knownUnits.has(id));
  if (foreign.length) issues.push({code:"unknown-evidence",path:"basisUnitIds",unreadUnitIds:foreign,message:"Unknown or out-of-scope evidence",
    guidance:"Discover with read_role_work_evidence query, copy units[].unitId, then read the complete original and correct once. Never guess or repeat unchanged references."});
  const unreadUnitIds = refs.filter(id => access.knownUnits.has(id) && !access.fullyRead.has(id));
  if (unreadUnitIds.length) issues.push({code:"unread-evidence",path:"basisUnitIds",unreadUnitIds,message:"Unread role work evidence",
    guidance:"Call read_role_work_evidence for these exact unitId values and every nextOffset. Only complete current-context originals count. Correct once; never reread all citations, guess IDs or retry unchanged."});
  return issues;
}

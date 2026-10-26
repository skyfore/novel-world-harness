import { roleAuditContractAuthoritySchema, roleAuditContractProofSchema, type RoleAuditContractAuthority, type RoleAuditContractProof } from "./role-audit-contract.js";
import { prerequisiteRecordSchema, validatePrerequisiteHistory, prerequisiteStop, type PrerequisiteRecord } from "./role-source-prerequisites.js";
import { representationRecordSchema, validateRepresentationHistory, assertRepresentationAnchors, type RepresentationRecord } from "./source-representation.js";
import { roleDependencyReviewSchema, type RoleDependencyReview } from "./role-dependency-review.js";
import { semanticScopeRecordSchema, validateSemanticScopeHistory, type SemanticScopeRecord } from "./role-semantic-scope.js";
import { identityRecordSchema, validateIdentityHistory, type IdentityRecord } from "./identity-requirements.js";
import { consumerRepairRecordSchema, validateConsumerRepairHistory, type ConsumerRepairRecord } from "./identity-consumer-repair-model.js";
import { consumerRevalidationRecordSchema, consumerRevalidationId, validateConsumerRevalidationHistory, validateConsumerCorrectionLineage, type ConsumerRevalidationRecord } from "./identity-consumer-revalidation-model.js";
import type { IdentityRecoveryPermit } from "../runtime/compile-loop/identity-recovery-host.js";
import { textAnchorForByteRange } from "./text-anchors.js";
import { sourceAuditProofSchema, type SourceAuditProof } from "./role-source-audit-model.js";
import { roleQuestionSchema, roleQuestionDispositionSchema, type RoleQuestion, type RoleQuestionDisposition, roleQuestions, roleEvidenceNeedSchema, type RoleEvidenceNeed } from "./role-review-verification.js";
import { roleClaimAuditSchema, type RoleClaimAudit } from "./role-review-verification.js";
import { roleJudgmentRepairPolicySchema, roleJudgmentFindingSchema, roleJudgmentRevisionProofSchema,
  type RoleJudgmentRepairPolicy, type RoleJudgmentFinding, type RoleJudgmentRevisionProof } from "./role-judgment-revision.js";
import { requirementResultSchema, type RequirementResult } from "./requirement-result.js";
export { requirementResultSchema, type RequirementResult } from "./requirement-result.js";
import { roleReviewRevisionSchema, assertRoleReviewRevisionEvidence, type RoleReviewRevision } from "./role-review-revision.js";
import { compilerFinishReceiptSchema, type CompilerFinishReceipt } from "./finish-receipts.js";
import { coreRoleAttemptScope } from "./requirement-attempts.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { idSchema } from "../world/model.js";
import { worldStorageRoot } from "../world/paths.js";
import { evaluateSceneCapabilities, evaluateReviewedSceneCapabilities, sceneCapabilitySpecSchema, type SceneReviewCatalog } from "../eval/scene-capabilities.js";
import { SCENE_REQUIREMENT_EVALUATOR_VERSION } from "../eval/scene-requirements.js";
import { coreRoleRequirementDefinitionSchema, coreRoleRequirementHistorySchema, coreRoleDefinitions, assertCoreRoleDefinitionEvidence, type CoreRoleRequirementDefinition } from "./core-role-requirement-records.js";
import { validateRoleRoster, roleRosterSchema, type RoleRoster } from "./role-roster.js";
import type { StructuralUnit } from "./structure.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";
import type { NovelClosureAssessment } from "./certification.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1);
export const requirementSetSchema = z.object({
  id: idSchema, revisionHash: hash, parentRevision: hash.nullable(),
  scopeDecisionRef: text, spec: sceneCapabilitySpecSchema,
}).strict().superRefine(({ revisionHash, ...identity }, ctx) => {
  if (contentHash(identity) !== revisionHash) ctx.addIssue({ code: "custom", message: "Requirement definition hash mismatch" });
});
export type RequirementSet = z.infer<typeof requirementSetSchema>;
const payloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("identity-consumer-revalidation"), record: consumerRevalidationRecordSchema }).strict(),
  z.object({ kind: z.literal("identity-consumer-repair"), record: consumerRepairRecordSchema }).strict(),
  z.object({ kind: z.literal("identity-requirements"), record: identityRecordSchema }).strict(),
  z.object({ kind: z.literal("role-dependency-review"), review: roleDependencyReviewSchema }).strict(),
  z.object({ kind: z.literal("role-semantic-scope"), record: semanticScopeRecordSchema }).strict(),
  z.object({ kind: z.literal("source-representation"), record: representationRecordSchema }).strict(),
  z.object({ kind: z.literal("role-source-prerequisite"), record: prerequisiteRecordSchema }).strict(),
  z.object({ kind: z.literal("role-source-audit-repair"), proof: sourceAuditProofSchema }).strict(),
  z.object({ kind: z.literal("role-audit-contract-authority"), authority: roleAuditContractAuthoritySchema }).strict(),
  z.object({ kind: z.literal("role-audit-contract-resolution"), findingRef: hash, proof: roleAuditContractProofSchema }).strict(),
  z.object({ kind: z.literal("role-judgment-repair-policy"), policy: roleJudgmentRepairPolicySchema }).strict(),
  z.object({ kind: z.literal("role-judgment-finding"), finding: roleJudgmentFindingSchema }).strict(),
  z.object({ kind: z.literal("role-judgment-resolution"), findingRef: hash, revision: roleJudgmentRevisionProofSchema, audit: roleClaimAuditSchema }).strict(),
  z.object({ kind: z.literal("role-review-evidence-need"), planHash: hash, workId: text, need: roleEvidenceNeedSchema }).strict(),
  z.object({ kind: z.literal("role-review-evidence-resolution"), planHash: hash, workId: text, needRef: hash, resolutionRef: hash }).strict(),
  z.object({ kind: z.literal("role-review-question"), question: roleQuestionSchema }).strict(),
  z.object({ kind: z.literal("role-review-question-disposition"), planHash: hash, auditRef: hash, disposition: roleQuestionDispositionSchema }).strict(),
  z.object({ kind: z.literal("core-role-review-snapshot"), roster: roleRosterSchema }).strict(),
  z.object({ kind: z.literal("core-role-review-revision"), revision: roleReviewRevisionSchema }).strict(),
  z.object({ kind: z.literal("core-role-invalidation"), evaluationRef: hash, nextSubjectSnapshotHash: hash.nullable(), reason: text }).strict(),
  z.object({ kind: z.literal("core-role-attempt-evaluation"), settlementKey: hash, receiptFingerprint: hash, definitionRevision: hash,
    subjectSnapshotHash: hash, evaluationRef: hash, result: requirementResultSchema.shape.requirements.element }).strict(),
  z.object({ kind: z.literal("core-role-attempt"), receipt: compilerFinishReceiptSchema }).strict(),
  z.object({ kind: z.literal("definition"), definition: requirementSetSchema }).strict(),
  z.object({ kind: z.literal("evaluation"), result: requirementResultSchema }).strict(),
  z.object({ kind: z.literal("core-role-definition"), definition: coreRoleRequirementDefinitionSchema }).strict(),
  z.object({ kind: z.literal("core-role-evaluation"), definitionRevision: hash, subjectSnapshotHash: hash, result: requirementResultSchema }).strict(),
]);
const recordSchema = z.object({
  version: z.literal(1), sourceId: idSchema, sequence: z.number().int().nonnegative(),
  predecessorHash: hash.nullable(), payload: payloadSchema, hash,
}).strict().superRefine(({ hash: recordedHash, ...identity }, ctx) => {
  if (contentHash(identity) !== recordedHash) ctx.addIssue({ code: "custom", message: "Requirement journal hash mismatch" });
});
export type LedgerRecord = z.infer<typeof recordSchema>;
export function roleJudgmentJournalIssues(history: LedgerRecord[], planHash: string, revisions: RoleJudgmentRevisionProof[], audits: RoleClaimAudit[], contracts: RoleAuditContractProof[] = []) {
  const issues: string[] = [];
  for (const proof of contracts) {
    if (!history.some(r => r.payload.kind === "role-audit-contract-authority" && contentHash(r.payload.authority) === contentHash(proof.authority))) issues.push("ROLE_AUDIT_CONTRACT_AUTHORITY_MISSING");
    if (!history.some(r => r.payload.kind === "role-audit-contract-resolution" && contentHash(r.payload.proof) === contentHash(proof))) issues.push("ROLE_AUDIT_CONTRACT_RESOLUTION_MISSING");
  }
  for (const revision of revisions) {
    const a = revision.authority;
    if (!history.some(r => r.payload.kind === "role-judgment-repair-policy" && contentHash(r.payload.policy) === contentHash(a.policy))) issues.push("ROLE_JUDGMENT_AUTHORITY_MISSING");
    if (!history.some(r => r.payload.kind === "role-judgment-resolution" && contentHash(r.payload.revision) === contentHash(revision)
      && audits.some(audit => contentHash(audit) === contentHash(r.payload.kind === "role-judgment-resolution" ? r.payload.audit : null)))) issues.push("ROLE_JUDGMENT_RESOLUTION_MISSING");
  }
  for (const record of history) if (record.payload.kind === "role-judgment-finding" && record.payload.finding.planHash === planHash) {
    const finding = record.payload.finding;
    if (!history.some(r => r.payload.kind === "role-audit-contract-resolution" && r.payload.findingRef === contentHash(finding)
      && contracts.some(p => contentHash(p) === contentHash(r.payload.kind === "role-audit-contract-resolution" ? r.payload.proof : null))
      && audits.some(a => contentHash(a) === contentHash(r.payload.kind === "role-audit-contract-resolution" ? r.payload.proof.audit : null)))
      && !history.some(r => r.payload.kind === "role-judgment-resolution" && r.payload.findingRef === contentHash(finding)
      && revisions.some(revision => contentHash(revision) === contentHash(r.payload.kind === "role-judgment-resolution" ? r.payload.revision : null))
      && audits.some(audit => contentHash(audit) === contentHash(r.payload.kind === "role-judgment-resolution" ? r.payload.audit : null)))) issues.push("ROLE_JUDGMENT_FINDING_UNRESOLVED");
  }
  return issues;
}
const headSchema = z.object({ version: z.literal(1), sourceId: idSchema, sequence: z.number().int().nonnegative(), hash }).strict();

/** Frozen input only. Evaluations are derived, never part of their own subject hash. */
export const frozenRequirementSetsSchema = z.array(requirementSetSchema).superRefine((sets, ctx) => {
  if (new Set(sets.map(set => set.id)).size !== sets.length) ctx.addIssue({ code: "custom", message: "Duplicate requirement set identity" });
});

export const requirementDefinitionHistorySchema = z.array(requirementSetSchema).superRefine((history, ctx) => {
  const active = new Map<string, RequirementSet>();
  for (const set of history) {
    if (set.parentRevision !== (active.get(set.id)?.revisionHash ?? null)) ctx.addIssue({ code: "custom", message: "Requirement definition history is incomplete" });
    active.set(set.id, set);
  }
});
export function activeRequirementSets(history: readonly RequirementSet[]): RequirementSet[] {
  const active = new Map<string, RequirementSet>();
  for (const set of requirementDefinitionHistorySchema.parse(history)) active.set(set.id, set);
  return [...active.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function sceneCatalogHash(catalog: SceneReviewCatalog): string {
  // Fix the vocabulary; callers with a larger validator catalog must hash the
  // exact same consumer inputs as a frozen bundle, not unrelated Map fields.
  return contentHash(Object.fromEntries(sceneCatalogKeys.map(key =>
    [key, [...(catalog[key]?.values() ?? [])].sort((a, b) => a.id.localeCompare(b.id))])));
}
export const sceneCatalogKeys = ["entities", "events", "eventParticipations", "actionSchemas", "eventExecutions", "normTemplates", "processTemplates", "rules", "claims", "propositions", "attributions", "utteranceExpressions", "perceptionObservations", "acquisitions"] as const;

export function evaluateRequirementSet(setInput: RequirementSet, bytes: Uint8Array, catalog: SceneReviewCatalog): RequirementResult {
  const set = requirementSetSchema.parse(setInput);
  const report = evaluateSceneCapabilities(set.spec, bytes, catalog);
  return resultFromReport(set, report, catalog);
}
export function resultFromReport(set: RequirementSet, report: ReturnType<typeof evaluateReviewedSceneCapabilities>, catalog: SceneReviewCatalog): RequirementResult {
  return requirementResultSchema.parse({ setId: set.id, revisionHash: set.revisionHash,
    catalogHash: sceneCatalogHash(catalog), evaluatorVersion: SCENE_REQUIREMENT_EVALUATOR_VERSION,
    requirements: report.requirements.requirements.map(({ state, ownState: _own, diagnostics, blockedBy, ...definition }) => ({
      id: definition.id, definitionHash: contentHash(definition), state, diagnostics, blockedBy,
    })),
  });
}

/** Fail closed on stale inputs and partial success; proposed is not a state. */
export function requirementResultIssues(setsInput: readonly RequirementSet[], results: readonly RequirementResult[], catalog: SceneReviewCatalog): string[] {
  const sets = frozenRequirementSetsSchema.parse(setsInput), issues: string[] = [];
  const catalogHash = sceneCatalogHash(catalog);
  for (const result of results) {
    requirementResultSchema.parse(result);
    if (!sets.some(set => set.id === result.setId)) issues.push(`REQUIREMENT_RESULT_OUTSIDE_SCOPE: ${result.setId}`);
  }
  for (const set of sets) {
    const found = results.filter(result => result.setId === set.id);
    if (found.length !== 1) { issues.push(`REQUIREMENT_NOT_EVALUATED: ${set.id} must have exactly one result`); continue; }
    const result = found[0]!;
    if (result.revisionHash !== set.revisionHash || result.catalogHash !== catalogHash || result.evaluatorVersion !== SCENE_REQUIREMENT_EVALUATOR_VERSION) {
      issues.push(`REQUIREMENT_REVISION_STALE: ${set.id}`); continue;
    }
    const expectedIds = set.spec.cases.flatMap(item => [
      `${item.id}:case-validation`,
      ...(item.kind === "event-effects" ? [`${item.id}:state-effect`, ...(item.initiatorId ? [`${item.id}:agency`] : []), ...(item.requiresMechanism ? [`${item.id}:mechanism`] : [])] : []),
    ]).sort();
    if (canonicalJson(expectedIds) !== canonicalJson(result.requirements.map(item => item.id).sort())) issues.push(`REQUIREMENT_DENOMINATOR_CHANGED: ${set.id}`);
    const rechecked = resultFromReport(set, evaluateReviewedSceneCapabilities(set.spec, catalog), catalog);
    if (contentHash(rechecked) !== contentHash(result)) issues.push(`REQUIREMENT_RESULT_MISMATCH: ${set.id}`);
    for (const item of result.requirements) if (item.state !== "satisfied" || item.diagnostics.length || item.blockedBy.length) issues.push(`REQUIREMENT_UNRESOLVED: ${set.id}/${item.id}: ${item.state}`);
  }
  return issues;
}

/** Host-only mutations under the compiler lock. A head publishes an immutable
 * chain; temp/orphan files do not grant authority. Published writes are idempotent;
 * a missing head with existing records stops for host inspection. Old records
 * and predecessor definitions are never deleted.
 */
export class RequirementLedger {
  private readonly directory: string;
  constructor(private readonly root: string, readonly sourceId: string) {
    this.directory = path.join(worldStorageRoot(root), "compiler", "requirements", idSchema.parse(sourceId));
  }
  private async readHead() {
    try {
      const head = headSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory, "head.json"), "utf8")));
      if (head.sourceId !== this.sourceId) throw new Error("Requirement journal source mismatch; stop for host review.");
      return head;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let files: string[];
      try { files = await fs.readdir(this.directory); }
      catch (listError) { if ((listError as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw listError; }
      if (files.some(file => /^[a-f0-9]{64}\.json$/.test(file))) throw new Error("Requirement journal head is missing; stop for host recovery, do not reset obligations.");
      return undefined;
    }
  }
  async history(): Promise<LedgerRecord[]> {
    const head = await this.readHead();
    if (!head) return [];
    const records: LedgerRecord[] = [];
    let cursor: string | null = head.hash;
    for (let sequence = head.sequence; sequence >= 0; sequence--) {
      if (!cursor) throw new Error("Requirement journal chain truncated; stop for host review, do not reset the ledger.");
      const record = recordSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory, `${cursor}.json`), "utf8")));
      if (record.hash !== cursor || record.sequence !== sequence || record.sourceId !== this.sourceId) throw new Error("Requirement journal chain mismatch; stop for host review.");
      records.push(record); cursor = record.predecessorHash;
    }
    if (cursor) throw new Error("Requirement journal has an invalid root; stop for host review.");
    records.reverse();
    return requirementJournalSchema.parse(records);
  }
  async assertJournalRestorable(input: readonly LedgerRecord[], bytes?: Uint8Array): Promise<void> {
    const incoming = requirementJournalSchema.parse(input), current = await this.history();
    if (current.some((record, index) => record.hash !== incoming[index]?.hash)) throw new Error("Requirement journal restore would discard or rewrite current audit history; preserve the journal and stop for host review");
    if (incoming.some(record => record.sourceId !== this.sourceId)) throw new Error("Requirement journal restore source mismatch; stop for host review");
    if (incoming.length && !bytes) throw new Error("Requirement journal restore needs immutable source bytes; stop for host storage review");
    for (const record of incoming) {
      if (record.payload.kind === "identity-consumer-revalidation" && (record.payload.record.scope.sourceHash !== crypto.createHash("sha256").update(bytes!).digest("hex")
        || record.payload.record.evidence.some(e => contentHash(e.anchor) !== contentHash(textAnchorForByteRange(this.sourceId, bytes!, e.anchor.startByte, e.anchor.endByte))
          || Buffer.from(bytes!).subarray(e.anchor.startByte, e.anchor.endByte).toString("utf8") !== e.selector.exact))) throw prerequisiteStop("Consumer revalidation restore evidence mismatch");
      if ((record.payload.kind === "identity-requirements" || record.payload.kind === "identity-consumer-repair") && (record.payload.record.intent.sourceHash !== crypto.createHash("sha256").update(bytes!).digest("hex")
        || record.payload.record.evidence.some(e => contentHash(e.anchor) !== contentHash(textAnchorForByteRange(this.sourceId, bytes!, e.anchor.startByte, e.anchor.endByte))
          || Buffer.from(bytes!).subarray(e.anchor.startByte, e.anchor.endByte).toString("utf8") !== e.selector.exact))) throw prerequisiteStop("Identity requirement restore evidence mismatch");
      if (record.payload.kind === "role-dependency-review" && record.payload.review.scope.sourceHash !== crypto.createHash("sha256").update(bytes!).digest("hex")) throw prerequisiteStop("Dependency review restore source hash mismatch");
      if (record.payload.kind === "role-semantic-scope" && record.payload.record.evidence.some(e => contentHash(e.anchor) !== contentHash(textAnchorForByteRange(this.sourceId, bytes!, e.anchor.startByte, e.anchor.endByte))
        || Buffer.from(bytes!).subarray(e.anchor.startByte, e.anchor.endByte).toString("utf8") !== e.selector.exact)) throw prerequisiteStop("Semantic scope restore source evidence mismatch");
      if (record.payload.kind === "source-representation") assertRepresentationEvidence(record.payload.record, bytes!);
      if (record.payload.kind === "role-source-prerequisite") assertPrerequisiteEvidence(record.payload.record, bytes!);
      if (record.payload.kind === "role-audit-contract-authority" && record.payload.authority.sourceHash !== crypto.createHash("sha256").update(bytes!).digest("hex")) throw new Error("Role audit contract source hash mismatch");
      if (record.payload.kind === "role-judgment-repair-policy" && record.payload.policy.sourceHash !== crypto.createHash("sha256").update(bytes!).digest("hex")) throw new Error("Role judgment repair source hash mismatch; stop for host source review");
      if (record.payload.kind === "core-role-review-snapshot" && record.payload.roster.sourceSha256 !== crypto.createHash("sha256").update(bytes!).digest("hex")) throw new Error("Role review snapshot source hash mismatch; stop for host source review");
      if (record.payload.kind === "core-role-review-revision") assertRoleReviewRevisionEvidence(record.payload.revision, bytes!);
      if (record.payload.kind === "core-role-definition") assertCoreRoleDefinitionEvidence(record.payload.definition, bytes!);
      if (record.payload.kind === "definition") evaluateRequirementSet(record.payload.definition, bytes!, Object.fromEntries(sceneCatalogKeys.map(key => [key, new Map()])) as SceneReviewCatalog);
    }
  }
  async restoreJournal(input: readonly LedgerRecord[], bytes?: Uint8Array): Promise<void> {
    await this.assertJournalRestorable(input, bytes);
    const current = await this.history();
    for (const record of input.slice(current.length)) await this.publish(record.payload);
  }
  async definitions(): Promise<RequirementSet[]> {
    return activeRequirementSets(await this.definitionHistory());
  }
  async definitionHistory(): Promise<RequirementSet[]> {
    return (await this.history()).flatMap(record => record.payload.kind === "definition" ? [record.payload.definition] : []);
  }
  async coreRoleDefinitionHistory(): Promise<CoreRoleRequirementDefinition[]> {
    return (await this.history()).flatMap(record => record.payload.kind === "core-role-definition" ? [record.payload.definition] : []);
  }
  async recordRoleReviewSnapshot(input: RoleRoster, bytes: Uint8Array): Promise<void> {
    const roster = roleRosterSchema.parse(input);
    if (!roster.reviews.length || roster.sourceId !== this.sourceId || roster.sourceSha256 !== crypto.createHash("sha256").update(bytes).digest("hex")) throw new Error("Role review snapshot source or completion mismatch; preserve the saved review and stop model retries");
    const history = await this.history();
    const previous = history.findLast(record => record.payload.kind === "core-role-review-snapshot" && record.payload.roster.reviewRevisionId === roster.reviewRevisionId);
    if (previous?.payload.kind === "core-role-review-snapshot" && contentHash(previous.payload.roster) === contentHash(roster)) return;
    const payload = { kind: "core-role-review-snapshot" as const, roster };
    const identity = { version: 1 as const, sourceId: this.sourceId, sequence: history.length, predecessorHash: history.at(-1)?.hash ?? null, payload };
    requirementJournalSchema.parse([...history, { ...identity, hash: contentHash(identity) }]);
    await this.publish(payload);
  }
  async roleReviewRevisions(): Promise<RoleReviewRevision[]> {
    return (await this.history()).flatMap(record => record.payload.kind === "core-role-review-revision" ? [record.payload.revision] : []);
  }
  async roleDependencyReviews(): Promise<RoleDependencyReview[]> {
    return (await this.history()).flatMap(r => r.payload.kind === "role-dependency-review" ? [r.payload.review] : []);
  }
  async recordRoleDependencyReview(raw: RoleDependencyReview): Promise<void> {
    const review = roleDependencyReviewSchema.parse(raw), previous = (await this.roleDependencyReviews()).find(r => r.taskId === review.taskId);
    if (previous) {
      if (contentHash(previous) !== contentHash(review)) throw prerequisiteStop("Pending dependency review already has different frozen input");
      return;
    }
    if (review.scope.sourceId !== this.sourceId) throw prerequisiteStop("Dependency review source mismatch");
    const { prepareCoreRoleDependencyReview } = await import("./role-dependency-review-service.js");
    const actual = await prepareCoreRoleDependencyReview(this.root, { scope: review.scope, upstreamPlanHash: review.upstream.planHash, authorizationRef: review.authorizationRef });
    if (contentHash(actual.review) !== contentHash(review)) throw prerequisiteStop("Pending dependency review differs from actual retained state");
    await this.publish({ kind: "role-dependency-review", review });
  }
  async roleSemanticScopes(taskId: string): Promise<SemanticScopeRecord[]> {
    return (await this.history()).flatMap(r => r.payload.kind === "role-semantic-scope" && r.payload.record.taskId === taskId ? [r.payload.record] : []);
  }
  async identityRequirements(taskId: string): Promise<IdentityRecord[]> {
    return (await this.history()).flatMap(r => r.payload.kind === "identity-requirements" && r.payload.record.intent.taskId === taskId ? [r.payload.record] : []);
  }
  async recordIdentityRequirements(raw: IdentityRecord, recoveryPermit?: IdentityRecoveryPermit): Promise<void> {
    const record = identityRecordSchema.parse(raw), previous = await this.identityRequirements(record.intent.taskId);
    const existing = previous.find(r => r.stage === record.stage);
    if (existing) {
      if (contentHash(existing) !== contentHash(record)) throw prerequisiteStop("Identity phase already consumed");
      const { verifyIdentityRecord } = await import("./identity-requirement-trace.js");
      await verifyIdentityRecord(this.root, record, previous.slice(0, previous.indexOf(existing)), undefined, recoveryPermit);
      return;
    }
    validateIdentityHistory([...previous, record]);
    const { verifyIdentityRecord } = await import("./identity-requirement-trace.js");
    await verifyIdentityRecord(this.root, record, previous, undefined, recoveryPermit);
    await this.publish({ kind: "identity-requirements", record });
  }
  async recordIdentityConsumerRevalidation(raw: ConsumerRevalidationRecord): Promise<void> {
    const record = consumerRevalidationRecordSchema.parse(raw), history = await this.history();
    const previous = history.flatMap(r => r.payload.kind === "identity-consumer-revalidation"
      && consumerRevalidationId(r.payload.record.scope) === consumerRevalidationId(record.scope) ? [r.payload.record] : []);
    const existing = previous.find(r => r.output.phase === record.output.phase);
    if (existing && contentHash(existing) !== contentHash(record)) throw prerequisiteStop("Consumer revalidation phase was already consumed; preserve its original record, no replacement");
    validateConsumerRevalidationHistory(existing ? previous : [...previous, record], await this.identityRequirements(record.scope.taskId));
    await (await import("./identity-consumer-revalidation.js")).verifyConsumerRevalidationRecord(this.root, record);
    if (!existing) await this.publish({ kind: "identity-consumer-revalidation", record });
  }

  async recordIdentityConsumerRepair(raw: ConsumerRepairRecord): Promise<void> {
    const record = consumerRepairRecordSchema.parse(raw), history = await this.history();
    const previous = history.flatMap(r => r.payload.kind === "identity-consumer-repair"
      && r.payload.record.intent.findingId === record.intent.findingId ? [r.payload.record] : []);
    const existing = previous.find(r => r.output.phase === record.output.phase);
    if (existing && contentHash(existing) !== contentHash(record)) throw prerequisiteStop("Consumer repair phase already consumed; preserve it, no replacement or retry");
    validateConsumerRepairHistory(existing ? previous : [...previous, record], await this.identityRequirements(record.intent.taskId));
    const { verifyConsumerRepairRecord } = await import("./identity-consumer-repair-trace.js");
    await verifyConsumerRepairRecord(this.root, record);
    if (!existing) await this.publish({ kind: "identity-consumer-repair", record });
  }
  async recordRoleSemanticScope(raw: SemanticScopeRecord): Promise<void> {
    const record = semanticScopeRecordSchema.parse(raw), review = (await this.roleDependencyReviews()).find(r => r.taskId === record.taskId);
    if (!review) throw prerequisiteStop("Semantic scope lacks the exact pending denominator revision");
    const previous = await this.roleSemanticScopes(record.taskId);
    const existing = previous.find(r => r.phase === record.phase);
    if (existing) { if (contentHash(existing) !== contentHash(record)) throw prerequisiteStop("Semantic scope phase already consumed"); return; }
    validateSemanticScopeHistory(review, [...previous, record]);
    const { verifySemanticScopeRecord } = await import("./role-semantic-scope-trace.js");
    await verifySemanticScopeRecord(this.root, review, record);
    await this.publish({ kind: "role-semantic-scope", record });
  }
  async beginRoleReviewRevision(input: Omit<RoleReviewRevision, "revisionHash">, bytes: Uint8Array): Promise<RoleReviewRevision> {
    input = { ...input, scopeDecisionRef: input.scopeDecisionRef.trim(), reason: input.reason.trim() };
    const revision = roleReviewRevisionSchema.parse({ ...input, revisionHash: contentHash(input) });
    assertRoleReviewRevisionEvidence(revision, bytes);
    const history = await this.history();
    const existing = history.find(record => record.payload.kind === "core-role-review-revision" && record.payload.revision.id === revision.id);
    if (existing) {
      if (existing.payload.kind !== "core-role-review-revision" || contentHash(existing.payload.revision) !== contentHash(revision)) throw new Error("Role review revision ID already has different frozen input; stop unchanged retries and preserve the original decision");
      return existing.payload.revision;
    }
    const payload = { kind: "core-role-review-revision" as const, revision };
    const identity = { version: 1 as const, sourceId: this.sourceId, sequence: history.length, predecessorHash: history.at(-1)?.hash ?? null, payload };
    requirementJournalSchema.parse([...history, { ...identity, hash: contentHash(identity) }]);
    await this.publish(payload);
    return revision;
  }
  async registerCoreRoles(input: { roster: RoleRoster; units: StructuralUnit[]; scopeDecisionRef: string; scopeChangeReason: string; predecessorRevision?: string; allowScopeReduction?: boolean }, bytes: Uint8Array): Promise<CoreRoleRequirementDefinition> {
    input = { ...input, roster: roleRosterSchema.parse(input.roster) };
    const activeReview = (await this.roleReviewRevisions()).at(-1);
    if (input.roster.reviewRevisionId !== activeReview?.id || (activeReview && input.roster.subjectHash !== activeReview.nextRoster.subjectHash)) throw new Error("Role definition is outside the authorized host review revision; preserve prior reviews and stop model retries");
    const issues = validateRoleRoster(input.roster).filter(issue => !["ROSTER_MAJOR_IDENTITY_UNRESOLVED", "ROSTER_NO_MAJOR_CHARACTERS"].includes(issue.code));
    if (issues.length) throw new Error(`Core role source review is incomplete: ${issues.map(issue => issue.code).join(", ")}; preserve reviews and stop unchanged retries`);
    const retainedDefinitions = await this.coreRoleDefinitionHistory(), previous = retainedDefinitions.at(-1);
    const specHash = contentHash({ definitions: coreRoleDefinitions({ source: { id: this.sourceId } }, input.roster), units: input.units });
    if (previous?.specHash === specHash) { assertCoreRoleDefinitionEvidence(previous, bytes); return previous; }
    for (const review of input.roster.reviews) {
      const retained = retainedDefinitions.flatMap(definition => definition.roster.reviews).find(item => item.runId === review.runId);
      if (retained && contentHash(retained) !== contentHash(review)) throw new Error("Core role review run was rewritten. Preserve the original review and use fresh independent review runs; do not retry with mutated history.");
    }
    if (input.predecessorRevision !== previous?.revisionHash) throw new Error(`Core role predecessor changed. Run nwh requirements inspect --source ${this.sourceId}, copy coreRoleDefinitions[].revisionHash from the last entry, and make one corrected host retry. Stop model retries; do not reset history.`);
    const nextIds = new Set(coreRoleDefinitions({ source: { id: this.sourceId } }, input.roster).map(item => item.id));
    const removedRequirementIds = previous ? coreRoleDefinitions({ source: { id: this.sourceId } }, previous.roster).map(item => item.id).filter(id => !nextIds.has(id)).sort() : [];
    if (removedRequirementIds.length && !input.allowScopeReduction) throw new Error(`Core role scope reduction requires host review of ${removedRequirementIds.join(", ")}. Stop model retries. The host must use nwh requirements register-core-roles --source ${this.sourceId} with the exact --predecessor, --scope-decision and --reason; preserve history and do not retry unchanged.`);
    const identity = { version: 1 as const, id: "core-roles" as const, sourceId: this.sourceId, sourceSha256: input.roster.sourceSha256,
      parentRevision: previous?.revisionHash ?? null, specHash, scopeDecisionRef: text.parse(input.scopeDecisionRef), scopeChangeReason: text.parse(input.scopeChangeReason),
      removedRequirementIds, roster: input.roster, units: input.units };
    const definition = coreRoleRequirementDefinitionSchema.parse({ ...identity, revisionHash: contentHash(identity) });
    assertCoreRoleDefinitionEvidence(definition, bytes);
    await this.publish({ kind: "core-role-definition", definition });
    return definition;
  }
  async assertCoreRoleAttemptsRestorable(receipts: readonly CompilerFinishReceipt[], definitions: readonly CoreRoleRequirementDefinition[]): Promise<void> {
    const attempts = receipts.filter(receipt => receipt.state === "completed" && receipt.identity.requirementAttempts);
    for (const receipt of attempts) assertCoreRoleAttemptDefinition(compilerFinishReceiptSchema.parse(receipt), definitions, this.sourceId);
    for (const record of await this.history()) {
      const payload = record.payload;
      if (payload.kind === "core-role-attempt" && !attempts.some(receipt => receipt.fingerprint === payload.receipt.fingerprint)) throw new Error("Core role restore would forget a repair attempt; preserve its receipt and stop for host review");
    }
  }
  async recordCoreRoleAttempts(input: CompilerFinishReceipt): Promise<void> {
    const receipt = compilerFinishReceiptSchema.parse(input);
    assertCoreRoleAttemptDefinition(receipt, await this.coreRoleDefinitionHistory(), this.sourceId);
    const history = await this.history();
    if (history.some(record => record.payload.kind === "core-role-attempt" && record.payload.receipt.fingerprint === receipt.fingerprint)) return;
    await this.publish({ kind: "core-role-attempt", receipt });
  }
  async invalidateCoreRoleEvaluation(nextSubjectSnapshotHash: string): Promise<void> {
    hash.parse(nextSubjectSnapshotHash);
    await this.recordCoreRoleInvalidation(nextSubjectSnapshotHash, "Frozen subject changed; retain the previous evaluation as historical evidence only");
  }
  async invalidateUnobservableCoreRoleEvaluation(reason: string): Promise<void> {
    await this.recordCoreRoleInvalidation(null, text.parse(reason));
  }
  private async recordCoreRoleInvalidation(nextSubjectSnapshotHash: string | null, reason: string): Promise<void> {
    const history = await this.history(), previous = history.findLast(record => record.payload.kind === "core-role-evaluation");
    if (!previous || previous.payload.kind !== "core-role-evaluation" || previous.payload.subjectSnapshotHash === nextSubjectSnapshotHash) return;
    const evaluationRef = contentHash(previous.payload);
    if (history.slice(previous.sequence + 1).some(record => record.payload.kind === "core-role-invalidation" && record.payload.evaluationRef === evaluationRef && record.payload.nextSubjectSnapshotHash === nextSubjectSnapshotHash && record.payload.reason === reason)) return;
    await this.publish({ kind: "core-role-invalidation", evaluationRef, nextSubjectSnapshotHash, reason });
  }
  async recordCoreRoleEvaluation(bundle: PreparedNovelBundle, assessment: NovelClosureAssessment): Promise<void> {
    const definition = (await this.coreRoleDefinitionHistory()).at(-1);
    if (!definition || bundle.source.id !== this.sourceId || bundle.source.contentSha256 !== definition.sourceSha256 || bundle.compilerSnapshot.coreRoleRequirementDefinitions?.at(-1)?.revisionHash !== definition.revisionHash) throw new Error("Core role evaluation lacks its current frozen definition; stop for host review");
    const { evaluateCoreRoleCapabilities } = await import("./core-role-capabilities.js");
    const { preparedSubjectHash } = await import("./certification.js");
    const subjectSnapshotHash = preparedSubjectHash(bundle);
    if (!assessment.coreRoleResult) throw new Error("Core role evaluation result is missing; evaluate the frozen candidate before recording, never submit model success as a result");
    if (!assessment.roster || assessment.subjectSnapshotHash !== subjectSnapshotHash || contentHash(assessment.roster) !== contentHash(definition.roster)) throw new Error("Core role evaluation subject is stale; re-evaluate the current candidate, do not replay model writes");
    const result = evaluateCoreRoleCapabilities(bundle, assessment.roster, assessment.playability, subjectSnapshotHash);
    if (result.revisionHash !== definition.specHash || contentHash(result) !== contentHash(assessment.coreRoleResult)) throw new Error("Core role evaluation differs from its frozen deterministic result; stop for host review");
    const payload = { kind: "core-role-evaluation" as const, definitionRevision: definition.revisionHash, subjectSnapshotHash, result };
    const history = await this.history(), previous = history.findLast(record => record.payload.kind === "core-role-evaluation");
    const invalidated = previous && history.slice(previous.sequence + 1).some(record => record.payload.kind === "core-role-invalidation" && record.payload.evaluationRef === contentHash(previous.payload));
    if (!previous || invalidated || contentHash(previous.payload) !== contentHash(payload)) {
      await this.invalidateCoreRoleEvaluation(subjectSnapshotHash);
      await this.publish(payload);
    }
    await this.settleCoreRoleAttempts(bundle, payload);
  }
  private async settleCoreRoleAttempts(bundle: PreparedNovelBundle, evaluation: Extract<LedgerRecord["payload"], { kind: "core-role-evaluation" }>): Promise<void> {
    const history = await this.history();
    const settled = new Map(history.flatMap(record => record.payload.kind === "core-role-attempt-evaluation" ? [[record.payload.settlementKey, record.payload] as const] : []));
    const { ProposalStore } = await import("../world/canonical-model.js");
    const proposals = new ProposalStore(this.root), active = new Map<string, boolean>();
    for (const record of history) {
      if (record.payload.kind !== "core-role-attempt") continue;
      const receipt = record.payload.receipt;
      for (const attempt of receipt.identity.requirementAttempts ?? []) {
        const result = evaluation.result.requirements.find(item => item.id === attempt.requirementId);
        const diagnostics: string[] = [];
        if (attempt.definitionRevision !== evaluation.definitionRevision || result?.definitionHash !== attempt.definitionHash) diagnostics.push("ATTEMPT_REQUIREMENT_REVISION_STALE");
        for (const ref of attempt.proposalRefs) {
          const key = contentHash(ref);
          if (!active.has(key)) {
            try {
              const envelope = await proposals.readEnvelope("accepted", ref.proposalId);
              const catalog = envelope.kind === "character-model" ? bundle.canonical.models : envelope.kind === "character-goal" ? bundle.canonical.goals : [];
              active.set(key, contentHash(envelope) === ref.hash && catalog.some(item => contentHash(item) === contentHash(envelope.payload)));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              active.set(key, false);
            }
          }
          if (!active.get(key)) diagnostics.push(`ATTEMPT_DEPENDENCY_NOT_ACTIVE: ${ref.proposalId}`);
        }
        const settledResult = diagnostics.length ? { id: attempt.requirementId, definitionHash: attempt.definitionHash, state: "stale" as const, diagnostics, blockedBy: [] } : result!;
        const settlementKey = contentHash({ receiptFingerprint: receipt.fingerprint, requirementId: attempt.requirementId, definitionHash: attempt.definitionHash, subjectSnapshotHash: evaluation.subjectSnapshotHash });
        const payload = { kind: "core-role-attempt-evaluation" as const, settlementKey, receiptFingerprint: receipt.fingerprint, definitionRevision: attempt.definitionRevision,
          subjectSnapshotHash: evaluation.subjectSnapshotHash, evaluationRef: contentHash(evaluation), result: settledResult };
        if (settled.has(settlementKey)) {
          if (contentHash(settled.get(settlementKey)) !== contentHash(payload)) throw new Error("Role attempt settlement dependencies changed for the same frozen subject; stop for host review, never replay model writes");
          continue;
        }
        await this.publish(payload);
      }
    }
  }
  async assertCoreRolesRestorable(input: readonly CoreRoleRequirementDefinition[], bytes?: Uint8Array): Promise<void> {
    const incoming = coreRoleRequirementHistorySchema.parse(input), current = await this.coreRoleDefinitionHistory();
    if (current.some((definition, index) => definition.revisionHash !== incoming[index]?.revisionHash)) throw new Error("Core role restore would forget current obligations; use an isolated workspace, never reset the ledger");
    for (const definition of incoming) {
      if (definition.sourceId !== this.sourceId) throw new Error("Core role restore source mismatch");
      if (!bytes) throw new Error("Core role restore requires immutable source bytes");
      assertCoreRoleDefinitionEvidence(definition, bytes);
    }
  }
  async restoreCoreRoles(input: readonly CoreRoleRequirementDefinition[], bytes?: Uint8Array): Promise<void> {
    await this.assertCoreRolesRestorable(input, bytes);
    const current = await this.coreRoleDefinitionHistory();
    for (const definition of input.slice(current.length)) {
      const revision = (await this.roleReviewRevisions()).at(-1);
      if (definition.roster.reviewRevisionId !== revision?.id) throw new Error("Role definition restore requires its retained host review revision; restore the complete journal, do not invent authorization");
      await this.publish({ kind: "core-role-definition", definition });
    }
  }
  async recordRoleEvidenceNeed(planHash: string, workId: string, need: RoleEvidenceNeed) {
    const payload = {kind: "role-review-evidence-need" as const, planHash, workId, need};
    const prior = (await this.history()).find(r => r.payload.kind === "role-review-evidence-need" && r.payload.planHash === planHash && r.payload.workId === workId);
    if (prior && contentHash(prior.payload) !== contentHash(payload)) throw new Error("ROLE_REVIEW_WORK_HOST_REQUIRED: repeated evidence supplement request. Stop; preserve the original need and budget, do not rotate work identities.");
    if (!prior) await this.publish(payload);
    return contentHash(payload);
  }
  async authorizeRoleAuditContractRevision(authority: RoleAuditContractAuthority) {
    roleAuditContractAuthoritySchema.parse(authority);
    if (authority.sourceId !== this.sourceId) throw new Error("Foreign audit contract source");
    const history = await this.history();
    const prior = history.find(r => r.payload.kind === "role-audit-contract-authority" && r.payload.authority.revisionId === authority.revisionId);
    if (prior && contentHash(prior.payload) !== contentHash({kind: "role-audit-contract-authority", authority})) throw new Error("Audit contract authority cannot be replaced");
    if (!prior) await this.publish({kind: "role-audit-contract-authority", authority});
  }
  async resolveRoleAuditContractFinding(proof: RoleAuditContractProof) {
    roleAuditContractProofSchema.parse(proof);
    const history = await this.history(), a = proof.authority;
    const finding = history.flatMap(r => r.payload.kind === "role-judgment-finding"
      && r.payload.finding.planHash === a.planHash && r.payload.finding.workId === a.predecessorWorkId ? [r.payload.finding] : [])[0];
    if (!history.some(r => r.payload.kind === "role-audit-contract-authority" && contentHash(r.payload.authority) === contentHash(a))
      || !finding || contentHash(finding.audit) !== contentHash(a.predecessorAudit)) throw new Error("Audit contract resolution lacks exact authority and finding");
    const payload = {kind: "role-audit-contract-resolution" as const, findingRef: contentHash(finding), proof};
    const prior = history.find(r => r.payload.kind === payload.kind && r.payload.findingRef === payload.findingRef);
    if (prior && contentHash(prior.payload) !== contentHash(payload)) throw new Error("Audit contract resolution cannot be rewritten");
    if (!prior) await this.publish(payload);
  }
  async roleJudgmentRepairPolicy(planHash: string) {
    return (await this.history()).flatMap(r => r.payload.kind === "role-judgment-repair-policy" && r.payload.policy.planHash === planHash ? [r.payload.policy] : [])[0];
  }
  async authorizeRoleJudgmentRepairs(policy: RoleJudgmentRepairPolicy) {
    roleJudgmentRepairPolicySchema.parse(policy);
    if (policy.sourceId !== this.sourceId) throw new Error("Role judgment policy source mismatch");
    const prior = await this.roleJudgmentRepairPolicy(policy.planHash);
    if (prior && contentHash(prior) !== contentHash(policy)) throw new Error("Role judgment policy cannot be replaced to renew allowance");
    if (!prior) await this.publish({ kind: "role-judgment-repair-policy", policy });
  }
  async recordRoleJudgmentFinding(finding: RoleJudgmentFinding) {
    roleJudgmentFindingSchema.parse(finding);
    const prior = (await this.history()).find(r => r.payload.kind === "role-judgment-finding" && r.payload.finding.workId === finding.workId && r.payload.finding.planHash === finding.planHash);
    if (prior && contentHash(prior.payload) !== contentHash({ kind: "role-judgment-finding", finding })) throw new Error("Role judgment finding cannot be rewritten");
    if (!prior) await this.publish({ kind: "role-judgment-finding", finding });
    return contentHash(finding);
  }
  async resolveRoleJudgmentFinding(revision: RoleJudgmentRevisionProof, audit: RoleClaimAudit) {
    roleJudgmentRevisionProofSchema.parse(revision); roleClaimAuditSchema.parse(audit);
    const history = await this.history(), authority = revision.authority;
    const finding = history.flatMap(r => r.payload.kind === "role-judgment-finding" && r.payload.finding.planHash === authority.policy.planHash
      && r.payload.finding.workId === authority.predecessorAuditWorkId ? [r.payload.finding] : [])[0];
    if (!history.some(r => r.payload.kind === "role-judgment-repair-policy" && contentHash(r.payload.policy) === contentHash(authority.policy))
      || !finding || contentHash(finding.audit) !== contentHash(authority.predecessorAudit)
      || audit.verdict !== "supported" || audit.candidateId !== revision.entry.candidateId || audit.claimRevision !== contentHash(revision.entry)
      || audit.atlasRevision !== authority.predecessorAudit.atlasRevision) throw new Error("Role judgment finding requires independently supported successor evidence");
    const payload = { kind: "role-judgment-resolution" as const, findingRef: contentHash(finding), revision, audit };
    if (history.some(r => r.payload.kind === "role-judgment-resolution" && r.payload.findingRef === payload.findingRef && contentHash(r.payload) !== contentHash(payload))) throw new Error("Role judgment resolution cannot be rewritten");
    if (!history.some(r => contentHash(r.payload) === contentHash(payload))) await this.publish(payload);
  }
  async assertRoleJudgmentFindingsResolved(planHash: string, revisions: RoleJudgmentRevisionProof[], audits: RoleClaimAudit[], contracts: RoleAuditContractProof[] = []) {
    const issues = roleJudgmentJournalIssues(await this.history(), planHash, revisions, audits, contracts);
    if (issues.length) throw new Error(`ROLE_REVIEW_WORK_HOST_REQUIRED: ${issues.join("; ")}. Preserve findings and revisions; recover the original independent audit and ledger publication, never skip or relabel a verdict.`);
  }
  async resolveRoleEvidenceNeed(planHash: string, workId: string, resolutionRef: string) {
    const history = await this.history();
    const need = history.find(r => r.payload.kind === "role-review-evidence-need" && r.payload.planHash === planHash && r.payload.workId === workId);
    if (!need) return;
    const payload = {kind: "role-review-evidence-resolution" as const, planHash, workId, needRef: contentHash(need.payload), resolutionRef};
    if (!history.some(r => contentHash(r.payload) === contentHash(payload))) await this.publish(payload);
  }
  async assertRoleEvidenceNeedsResolved(planHash: string) {
    const history = await this.history();
    for (const r of history) if (r.payload.kind === "role-review-evidence-need" && r.payload.planHash === planHash
      && !history.some(s => s.payload.kind === "role-review-evidence-resolution" && s.payload.needRef === contentHash(r.payload))) throw new Error("ROLE_REVIEW_WORK_HOST_REQUIRED: unresolved evidence need. Resume its original work; never finish or reset the budget.");
  }
  async registerRoleQuestions(questions: RoleQuestion[]): Promise<void> {
    const existingQuestions = new Map((await this.history()).flatMap(record => record.payload.kind === "role-review-question"
      ? [[record.payload.question.questionId, record.payload.question] as const] : []));
    for (const question of questions) {
      const existing = existingQuestions.get(question.questionId);
      if (existing) {
        if (contentHash(existing) !== contentHash(question)) throw new Error("Role question identity collision; stop for host review");
      } else {
        await this.publish({ kind: "role-review-question", question });
        existingQuestions.set(question.questionId, question);
      }
    }
  }
  async sourcePrerequisites(taskId: string): Promise<PrerequisiteRecord[]> {
    return (await this.history()).flatMap(r => r.payload.kind === "role-source-prerequisite" && r.payload.record.taskId === taskId ? [r.payload.record] : []);
  }
  async sourceRepresentations(taskId: string): Promise<RepresentationRecord[]> {
    return (await this.history()).flatMap(r => r.payload.kind === "source-representation" && r.payload.record.scope.taskId === taskId ? [r.payload.record] : []);
  }
  /** Retain a proposed exact source-only write scope; upstream authorization is separate. */
  async recordSourceRepresentation(raw: RepresentationRecord, bytes: Uint8Array): Promise<void> {
    const record = representationRecordSchema.parse(raw), scope = record.scope.prerequisiteScope;
    const { WorkspaceOperationLock } = await import("../util/workspace-lock.js");
    if ((await WorkspaceOperationLock.inspect(this.root)).owner?.pid !== process.pid || scope.sourceId !== this.sourceId) throw prerequisiteStop("Representation publication requires its owning compiler lock and source");
    const history = await this.history(), previous = await this.sourceRepresentations(record.scope.taskId);
    validateRepresentationHistory(await this.sourcePrerequisites(record.scope.taskId), [...previous, record]);
    for (const question of scope.questions) {
      const disposition = history.findLast(r => r.payload.kind === "role-review-question-disposition" && r.payload.disposition.questionId === question.questionId)?.payload;
      if (disposition?.kind !== "role-review-question-disposition" || disposition.disposition.status !== "blocked") throw prerequisiteStop("Original representation question is no longer blocked");
    }
    assertRepresentationEvidence(record, bytes);
    const { verifyRepresentationTrace } = await import("./source-representation-trace.js");
    await verifyRepresentationTrace(this.root, record);
    await this.publish({ kind: "source-representation", record });
  }
  /** Append source review evidence only; this never settles a question or grants a repair. */
  async recordSourcePrerequisite(raw: PrerequisiteRecord, bytes: Uint8Array): Promise<void> {
    const record = prerequisiteRecordSchema.parse(raw);
    if (record.scope.sourceId !== this.sourceId) throw prerequisiteStop("Prerequisite publication changed its registered source");
    const { WorkspaceOperationLock } = await import("../util/workspace-lock.js");
    if ((await WorkspaceOperationLock.inspect(this.root)).owner?.pid !== process.pid) throw prerequisiteStop("Prerequisite publication requires the owning compiler lock");
    const previous = await this.sourcePrerequisites(record.taskId);
    if (previous.some(p => p.phase === record.phase)) throw prerequisiteStop("This original prerequisite stage is consumed");
    validatePrerequisiteHistory([...previous, record]);
    assertPrerequisiteEvidence(record, bytes);
    const history = await this.history();
    for (const question of record.scope.questions) {
      if (!history.some(r => r.payload.kind === "role-review-question" && contentHash(r.payload.question) === contentHash(question))) throw prerequisiteStop("Missing original registered question");
      const disposition = history.findLast(r => r.payload.kind === "role-review-question-disposition" && r.payload.disposition.questionId === question.questionId)?.payload;
      if (disposition?.kind !== "role-review-question-disposition" || disposition.disposition.status !== "blocked") throw prerequisiteStop("Original question is no longer blocked");
    }
    const { verifyPrerequisiteTrace } = await import("./role-source-prerequisite-trace.js");
    await verifyPrerequisiteTrace(this.root, record);
    await this.publish({ kind: "role-source-prerequisite", record });
  }
  async recordRoleQuestionDisposition(planHash: string, auditRef: string, disposition: RoleQuestionDisposition): Promise<void> {
    const history = await this.history();
    if (!history.some(r => r.payload.kind === "role-review-question" && r.payload.question.planHash === planHash && r.payload.question.questionId === disposition.questionId)) throw new Error("Unknown role question; preserve scope and stop for host review");
    const payload = { kind: "role-review-question-disposition" as const, planHash, auditRef, disposition };
    if (!history.some(r => contentHash(r.payload) === contentHash(payload))) await this.publish(payload);
  }
  async recordSourceAuditRepair(proof: SourceAuditProof) {
    sourceAuditProofSchema.parse(proof);
    const prior = (await this.history()).find(r => r.payload.kind === "role-source-audit-repair"
      && r.payload.proof.authority.revisionId === proof.authority.revisionId);
    if (prior) {
      if (contentHash(prior.payload) !== contentHash({ kind: "role-source-audit-repair", proof })) throw new Error("Source audit repair history changed; retain both receipts and stop.");
      return;
    }
    await this.publish({ kind: "role-source-audit-repair", proof });
  }
  private async publish(payload: z.infer<typeof payloadSchema>): Promise<void> {
    const history = await this.history(), last = history.at(-1);
    if (last && contentHash(last.payload) === contentHash(payload)) return;
    const identity = { version: 1 as const, sourceId: this.sourceId, sequence: history.length, predecessorHash: last?.hash ?? null, payload };
    const record = recordSchema.parse({ ...identity, hash: contentHash(identity) });
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = path.join(this.directory, `${record.hash}.json`), temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${canonicalJson(record)}\n`, { flag: "wx", mode: 0o600 });
      // link publishes complete bytes with no overwrite, including on recovery.
      try { await fs.link(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (canonicalJson(JSON.parse(await fs.readFile(destination, "utf8"))) !== canonicalJson(record)) throw new Error("Requirement journal collision; stop for host review.");
      }
      await fs.unlink(temporary);
      const head = headSchema.parse({ version: 1, sourceId: this.sourceId, sequence: record.sequence, hash: record.hash });
      await fs.writeFile(temporary, `${canonicalJson(head)}\n`, { mode: 0o600 });
      await fs.rename(temporary, path.join(this.directory, "head.json"));
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async register(input: { id: string; spec: unknown; scopeDecisionRef: string; predecessorRevision?: string }, bytes: Uint8Array, catalog: SceneReviewCatalog): Promise<RequirementSet> {
    const spec = sceneCapabilitySpecSchema.parse(input.spec);
    if (spec.sourceId !== this.sourceId) throw new Error("Requirement source scope mismatch; stop for host review.");
    // Verify immutable source anchors before publishing any obligation. Bad
    // candidate semantics may be blocked; bad evidence cannot register a spec.
    evaluateSceneCapabilities(spec, bytes, catalog);
    const previous = (await this.definitions()).find(set => set.id === input.id);
    if (previous && contentHash(previous.spec) === contentHash(spec) && previous.scopeDecisionRef === input.scopeDecisionRef) return previous;
    if ((previous?.revisionHash ?? undefined) !== input.predecessorRevision) throw new Error("Requirement predecessor changed. Inspect the same-source requirement ledger and copy definitions[].revisionHash; do not guess, overwrite, or retry unchanged.");
    const identity = { id: idSchema.parse(input.id), parentRevision: previous?.revisionHash ?? null, scopeDecisionRef: text.parse(input.scopeDecisionRef), spec };
    const definition = requirementSetSchema.parse({ ...identity, revisionHash: contentHash(identity) });
    await this.publish({ kind: "definition", definition });
    return definition;
  }
  async evaluate(bytes: Uint8Array, catalog: SceneReviewCatalog): Promise<RequirementResult[]> {
    const results: RequirementResult[] = [];
    for (const set of await this.definitions()) {
      const result = evaluateRequirementSet(set, bytes, catalog);
      const previous = (await this.history()).findLast(record => record.payload.kind === "evaluation" && record.payload.result.setId === set.id);
      if (!previous || previous.payload.kind !== "evaluation" || contentHash(previous.payload.result) !== contentHash(result)) await this.publish({ kind: "evaluation", result });
      results.push(result);
    }
    return results;
  }
  /** Materialization may add missing requirements, never discard newer/local
   * obligations in order to match an older bundle. A different lineage needs a
   * fresh isolated repair workspace; old branches already use their frozen input.
   */
  async assertRestorable(historyInput: readonly RequirementSet[]): Promise<void> {
    const history = requirementDefinitionHistorySchema.parse(historyInput), current = await this.definitionHistory();
    for (const set of history) if (set.spec.sourceId !== this.sourceId) throw new Error("Requirement restore source mismatch");
    if (current.some((set, i) => set.revisionHash !== history[i]?.revisionHash)) throw new Error("Requirement restore would forget current obligations; use an isolated workspace. Do not retry unchanged or reset the ledger.");
  }
  async restore(historyInput: readonly RequirementSet[]): Promise<void> {
    await this.assertRestorable(historyInput);
    const history = requirementDefinitionHistorySchema.parse(historyInput), current = await this.definitionHistory();
    for (const set of history.slice(current.length)) {
      if (set.spec.sourceId !== this.sourceId) throw new Error("Requirement restore source mismatch");
      await this.publish({ kind: "definition", definition: set });
    }
  }
}

export function assertCoreRoleAttemptDefinition(receipt: CompilerFinishReceipt, history: readonly CoreRoleRequirementDefinition[], sourceId: string): void {
  const scope = receipt.identity.requirementScope?.coreRoleScope;
  const definition = history.find(item => item.revisionHash === scope?.definitionRevision);
  if (receipt.state !== "completed" || !scope || !receipt.identity.requirementAttempts || !definition
    || receipt.identity.sourceId !== sourceId || receipt.identity.sourceSha256 !== definition.sourceSha256
    || contentHash(scope) !== contentHash(coreRoleAttemptScope(definition))) throw new Error("Core role attempt lacks its completed receipt and retained independent definition; preserve history and stop model retries");
}

export function coreRoleAttemptHistoryIssues(receipts: readonly CompilerFinishReceipt[], definitions: readonly CoreRoleRequirementDefinition[], sourceId: string): string[] {
  const issues: string[] = [];
  for (const receipt of receipts) {
    if (receipt.state !== "completed" || !receipt.identity.requirementAttempts) continue;
    try { assertCoreRoleAttemptDefinition(receipt, definitions, sourceId); }
    catch { issues.push(`CORE_ROLE_ATTEMPT_DEFINITION_MISMATCH: ${receipt.fingerprint}`); }
  }
  return issues;
}

/** Complete audit history, excluded from the semantic subject hash. */
export const requirementJournalSchema = z.array(recordSchema).superRefine((records, ctx) => {
  try {
    const sourceId = records[0]?.sourceId ?? "";
    for (const [index, record] of records.entries()) {
      if (record.sourceId !== sourceId || record.sequence !== index || record.predecessorHash !== (records[index - 1]?.hash ?? null)) throw new Error("Requirement journal source or predecessor chain mismatch");
      if (index && contentHash(record.payload) === contentHash(records[index - 1]!.payload)) throw new Error("Requirement journal repeats an adjacent published payload");
    }
    const definitions = new Map<string, RequirementSet>();
    const coreHistory: CoreRoleRequirementDefinition[] = [];
    const evaluations = new Map<string, Extract<LedgerRecord["payload"], { kind: "core-role-evaluation" }>>();
    const attempts = new Map<string, CompilerFinishReceipt>();
    const settlementKeys = new Set<string>();
    const reviewRevisions: RoleReviewRevision[] = [];
    const dependencyReviews = new Map<string, RoleDependencyReview>();
    const semanticScopes = new Map<string, SemanticScopeRecord[]>();
    const identityHistories = new Map<string, IdentityRecord[]>();
    for (const [index, r] of records.entries()) {
      if (r.payload.kind === "role-dependency-review") {
        const d = r.payload.review;
        if (dependencyReviews.has(d.taskId) || d.scope.sourceId !== sourceId || d.requirementPrefix.length !== index
          || d.requirementPrefix.head !== records[index - 1]?.hash) throw prerequisiteStop("Dependency revision lost its original requirement prefix or reused a task");
        const prefix = records.slice(0, index);
        const priorSpecs = prefix.flatMap(r => r.payload.kind === "role-source-prerequisite" && r.payload.record.taskId === d.taskId ? [contentHash(r.payload.record)] : []);
        const priorRepresentations = prefix.flatMap(r => r.payload.kind === "source-representation" && r.payload.record.scope.taskId === d.taskId ? [contentHash(r.payload.record)] : []);
        if (contentHash(priorSpecs) !== contentHash(d.prerequisiteRecordHashes) || contentHash(priorRepresentations) !== contentHash(d.representationRecordHashes)) throw prerequisiteStop("Pending dependency review lacks the exact consumed specification and representation prefix");
        dependencyReviews.set(d.taskId, d);
      }
      if (r.payload.kind === "role-semantic-scope") {
        const s = r.payload.record, d = dependencyReviews.get(s.taskId);
        if (!d) throw prerequisiteStop("Semantic scope has no preceding exact denominator revision");
        if (s.correction && (s.correction.requirementPrefix.length !== index || s.correction.requirementPrefix.head !== records[index - 1]?.hash)) throw prerequisiteStop("Semantic correction lost the original pending requirement prefix");
        const current = [...(semanticScopes.get(s.taskId) ?? []), s];
        validateSemanticScopeHistory(d, current); semanticScopes.set(s.taskId, current);
      }
      if (r.payload.kind === "identity-requirements") {
        const entry = r.payload.record, intent = entry.intent, d = dependencyReviews.get(intent.taskId);
        const previous = identityHistories.get(intent.taskId) ?? [];
        if (!d || intent.sourceId !== sourceId || intent.sourceHash !== d.scope.sourceHash || intent.parentStateHash !== d.scope.parentStateHash
          || intent.originalPlanHash !== d.scope.planHash || intent.originalBudgetHash !== d.scope.originalBudgetHash || intent.revisionHash !== d.revisionHash
          || contentHash(intent.semanticRecordHashes) !== contentHash((semanticScopes.get(intent.taskId) ?? []).map(contentHash))
          || (!previous.length && (intent.requirementPrefix.length !== index || intent.requirementPrefix.head !== records[index - 1]?.hash))) throw prerequisiteStop("Identity requirement lost original scope, consumed phases or ledger prefix");
        const current = [...previous, entry]; validateIdentityHistory(current); identityHistories.set(intent.taskId, current);
      }
    }
    const consumerRepairs = new Map<string, ConsumerRepairRecord[]>();
    for (const [index, entry] of records.entries()) if (entry.payload.kind === "identity-consumer-repair") {
      const r = entry.payload.record, previous = consumerRepairs.get(r.intent.findingId) ?? [];
      if (r.intent.sourceId !== sourceId || (!previous.length && (r.intent.requirementPrefix.length !== index
        || r.intent.requirementPrefix.head !== records[index - 1]?.hash))) throw prerequisiteStop("Consumer repair lost its original ledger prefix");
      const current = [...previous, r];
      validateConsumerRepairHistory(current, identityHistories.get(r.intent.taskId) ?? []);
      consumerRepairs.set(r.intent.findingId, current);
    }
    const retainedReviews = new Map<string, string>();
    const revalidations = new Map<string, ConsumerRevalidationRecord[]>();
    for (const [index, entry] of records.entries()) if (entry.payload.kind === "identity-consumer-revalidation") {
      const r = entry.payload.record, id = consumerRevalidationId(r.scope), previous = revalidations.get(id) ?? [];
      validateConsumerCorrectionLineage(r.scope, [...revalidations.values()].flat());
      if (r.scope.sourceId !== sourceId || (!previous.length && (r.scope.requirementPrefix.length !== index
        || r.scope.requirementPrefix.head !== records[index - 1]?.hash))) throw prerequisiteStop("Consumer revalidation changed its original ledger prefix");
      validateConsumerRevalidationHistory([...previous, r], identityHistories.get(r.scope.taskId) ?? []);
      revalidations.set(id, [...previous, r]);
    }
    const reviewSnapshots = new Map<string, RoleRoster>();
    const prerequisites = new Map<string, PrerequisiteRecord[]>();
    const representations = new Map<string, RepresentationRecord[]>();
    for (const record of records) {
      if (record.payload.kind === "identity-consumer-revalidation" || record.payload.kind === "identity-consumer-repair" || record.payload.kind === "role-dependency-review" || record.payload.kind === "role-semantic-scope" || record.payload.kind === "identity-requirements") continue; // Validated above; original question dispositions never change here.
      const roster = record.payload.kind === "core-role-definition" ? record.payload.definition.roster : record.payload.kind === "core-role-review-revision" ? record.payload.revision.priorRoster : record.payload.kind === "core-role-review-snapshot" ? record.payload.roster : undefined;
      for (const review of roster?.reviews ?? []) {
        if (retainedReviews.has(review.runId) && retainedReviews.get(review.runId) !== contentHash(review)) throw new Error("Retained role review run was rewritten");
        retainedReviews.set(review.runId, contentHash(review));
      }
      if (record.payload.kind === "source-representation") {
        const p = record.payload.record, prior = representations.get(p.scope.taskId) ?? [];
        if (p.scope.prerequisiteScope.sourceId !== sourceId) throw prerequisiteStop("Representation journal changed source");
        for (const q of p.scope.prerequisiteScope.questions) {
          const disposition = records.slice(0, record.sequence).findLast(r => r.payload.kind === "role-review-question-disposition" && r.payload.disposition.questionId === q.questionId)?.payload;
          if (disposition?.kind !== "role-review-question-disposition" || disposition.disposition.status !== "blocked") throw prerequisiteStop("Representation journal lacks the retained blocked question");
        }
        validateRepresentationHistory(prerequisites.get(p.scope.taskId) ?? [], [...prior, p]);
        representations.set(p.scope.taskId, [...prior, p]);
      } else if (record.payload.kind === "role-source-prerequisite") {
        const p = record.payload.record;
        if (p.scope.sourceId !== sourceId || p.scope.questions.some(q => !records.slice(0, record.sequence).some(r => r.payload.kind === "role-review-question" && contentHash(r.payload.question) === contentHash(q)))) throw prerequisiteStop("Prerequisite journal lacks original questions");
        for (const q of p.scope.questions) {
          const disposition = records.slice(0, record.sequence).findLast(r => r.payload.kind === "role-review-question-disposition" && r.payload.disposition.questionId === q.questionId)?.payload;
          if (disposition?.kind !== "role-review-question-disposition" || disposition.disposition.status !== "blocked") throw prerequisiteStop("Prerequisite journal lacks a retained blocked question");
        }
        const prior = prerequisites.get(p.taskId) ?? [];
        validatePrerequisiteHistory([...prior, p]);
        prerequisites.set(p.taskId, [...prior, p]);
      } else if (record.payload.kind === "role-audit-contract-authority") {
        const a = record.payload.authority;
        if (a.sourceId !== sourceId || records.slice(0, record.sequence).some(r => r.payload.kind === "role-audit-contract-authority"
          && r.payload.authority.revisionId === a.revisionId)
          || !records.slice(0, record.sequence).some(r => r.payload.kind === "role-judgment-finding"
            && r.payload.finding.planHash === a.planHash && r.payload.finding.workId === a.predecessorWorkId
            && contentHash(r.payload.finding.audit) === contentHash(a.predecessorAudit))) throw new Error("Repeated or unbound audit contract authority");
      } else if (record.payload.kind === "role-audit-contract-resolution") {
        const p = record.payload, a = p.proof.authority;
        if (!records.slice(0, record.sequence).some(r => r.payload.kind === "role-audit-contract-authority" && contentHash(r.payload.authority) === contentHash(a))
          || !records.slice(0, record.sequence).some(r => r.payload.kind === "role-judgment-finding" && contentHash(r.payload.finding) === p.findingRef
            && r.payload.finding.planHash === a.planHash && r.payload.finding.workId === a.predecessorWorkId
            && contentHash(r.payload.finding.audit) === contentHash(a.predecessorAudit))
          || records.slice(0, record.sequence).some(r => r.payload.kind === p.kind && r.payload.findingRef === p.findingRef)) throw new Error("Audit contract resolution lacks exact retained history");
      } else if (record.payload.kind === "role-judgment-repair-policy") {
        const p = record.payload.policy;
        if (p.sourceId !== sourceId || records.slice(0, record.sequence).some(r => r.payload.kind === "role-judgment-repair-policy" && r.payload.policy.planHash === p.planHash)) throw new Error("Repeated or foreign semantic repair authority");
      } else if (record.payload.kind === "role-judgment-finding") {
        const f = record.payload.finding;
        if (records.slice(0, record.sequence).some(r => r.payload.kind === "role-judgment-finding" && r.payload.finding.planHash === f.planHash && r.payload.finding.workId === f.workId)) throw new Error("Repeated semantic finding");
      } else if (record.payload.kind === "role-judgment-resolution") {
        const p = record.payload, a = p.revision.authority;
        if (!records.slice(0, record.sequence).some(r => r.payload.kind === "role-judgment-repair-policy" && contentHash(r.payload.policy) === contentHash(a.policy))
          || !records.slice(0, record.sequence).some(r => r.payload.kind === "role-judgment-finding" && contentHash(r.payload.finding) === p.findingRef
            && r.payload.finding.planHash === a.policy.planHash && r.payload.finding.workId === a.predecessorAuditWorkId && contentHash(r.payload.finding.audit) === contentHash(a.predecessorAudit))
          || records.slice(0, record.sequence).some(r => r.payload.kind === "role-judgment-resolution" && r.payload.findingRef === p.findingRef)
          || p.audit.verdict !== "supported" || p.audit.candidateId !== p.revision.entry.candidateId || p.audit.claimRevision !== contentHash(p.revision.entry)
          || p.audit.atlasRevision !== a.predecessorAudit.atlasRevision) throw new Error("Semantic resolution lacks exact authority, finding or independent successor audit");
      } else if (record.payload.kind === "role-source-audit-repair") {
        const a = record.payload.proof.authority;
        if (a.sourceId !== sourceId || records.slice(0, record.sequence).some(r => r.payload.kind === "role-source-audit-repair"
          && r.payload.proof.authority.revisionId === a.revisionId)) throw new Error("Repeated or foreign source audit repair");
      } else if (record.payload.kind === "role-review-evidence-need") {
        const p = record.payload;
        if (records.slice(0, record.sequence).some(r => r.payload.kind === p.kind && r.payload.planHash === p.planHash && r.payload.workId === p.workId)) throw new Error("Repeated evidence need; do not reset work allowance");
      } else if (record.payload.kind === "role-review-evidence-resolution") {
        const p = record.payload;
        if (!records.slice(0, record.sequence).some(r => r.payload.kind === "role-review-evidence-need" && r.payload.planHash === p.planHash && r.payload.workId === p.workId && contentHash(r.payload) === p.needRef)) throw new Error("Evidence resolution lacks its retained need");
      } else if (record.payload.kind === "role-review-question") {
        const q = record.payload.question;
        if (records.slice(0, record.sequence).some(r => r.payload.kind === "role-review-question" && r.payload.question.questionId === q.questionId)) throw new Error("Repeated role review question");
      } else if (record.payload.kind === "role-review-question-disposition") {
        const p = record.payload;
        if (!records.slice(0, record.sequence).some(r => r.payload.kind === "role-review-question" && r.payload.question.planHash === p.planHash && r.payload.question.questionId === p.disposition.questionId)) throw new Error("Role question disposition has no retained question");
      } else if (record.payload.kind === "core-role-review-snapshot") {
        const roster = record.payload.roster, activeRevision = reviewRevisions.at(-1), key = roster.reviewRevisionId ?? "";
        const prior = reviewSnapshots.get(key);
        if (roster.sourceId !== sourceId || !roster.reviews.length || roster.reviewRevisionId !== activeRevision?.id
          || (activeRevision && roster.subjectHash !== activeRevision.nextRoster.subjectHash)
          || (prior && (prior.subjectHash !== roster.subjectHash || prior.reviews.some((review, index) => contentHash(review) !== contentHash(roster.reviews[index] ?? null))))) throw new Error("Role review snapshot would rewrite retained partial work; stop for host review");
        reviewSnapshots.set(key, roster);
      } else if (record.payload.kind === "core-role-review-revision") {
        const revision = record.payload.revision, prior = reviewRevisions.at(-1);
        if (revision.sourceId !== sourceId || reviewRevisions.some(item => item.id === revision.id)
          || revision.predecessorDefinitionRevision !== (coreHistory.at(-1)?.revisionHash ?? null)
          || revision.priorRoster.reviewRevisionId !== prior?.id) throw new Error("Role review revision has stale host scope; preserve history and stop for host review");
        reviewRevisions.push(revision);
      } else if (record.payload.kind === "definition") {
        const next = record.payload.definition;
        if (next.spec.sourceId !== sourceId || next.parentRevision !== (definitions.get(next.id)?.revisionHash ?? null)) throw new Error("Requirement definition lineage mismatch; stop for host review.");
        definitions.set(next.id, next);
      } else if (record.payload.kind === "evaluation") {
        if (definitions.get(record.payload.result.setId)?.revisionHash !== record.payload.result.revisionHash) throw new Error("Requirement evaluation has no active definition; stop for host review.");
      } else if (record.payload.kind === "core-role-definition") {
        if (record.payload.definition.sourceId !== sourceId) throw new Error("Core role definition escapes its source; stop for host review.");
        const activeReview = reviewRevisions.at(-1);
        if (record.payload.definition.roster.reviewRevisionId !== activeReview?.id) throw new Error("Role definition lacks its authorized review revision");
        if (activeReview && record.payload.definition.roster.subjectHash !== activeReview.nextRoster.subjectHash) throw new Error("Role definition changed its frozen review subject");
        coreHistory.push(record.payload.definition);
        coreRoleRequirementHistorySchema.parse(coreHistory);
      } else if (record.payload.kind === "core-role-attempt") {
        assertCoreRoleAttemptDefinition(record.payload.receipt, coreHistory, sourceId);
        if (attempts.has(record.payload.receipt.fingerprint)) throw new Error("Requirement journal repeats an immutable attempt");
        attempts.set(record.payload.receipt.fingerprint, record.payload.receipt);
      } else if (record.payload.kind === "core-role-invalidation") {
        if (!evaluations.has(record.payload.evaluationRef)) throw new Error("Role invalidation has no retained evaluation; stop for host review");
      } else if (record.payload.kind === "core-role-attempt-evaluation") {
        const payload = record.payload, evaluation = evaluations.get(payload.evaluationRef);
        const attempt = attempts.get(payload.receiptFingerprint)?.identity.requirementAttempts?.find(item => item.requirementId === payload.result.id && item.definitionHash === payload.result.definitionHash);
        const key = contentHash({ receiptFingerprint: payload.receiptFingerprint, requirementId: payload.result.id, definitionHash: payload.result.definitionHash, subjectSnapshotHash: payload.subjectSnapshotHash });
        if (!evaluation || !attempt || attempt.definitionRevision !== payload.definitionRevision || evaluation.subjectSnapshotHash !== payload.subjectSnapshotHash
          || payload.settlementKey !== key || settlementKeys.has(key)
          || (payload.result.state !== "stale" && contentHash(evaluation.result.requirements.find(item => item.id === payload.result.id)) !== contentHash(payload.result))) throw new Error("Role attempt settlement has invalid immutable references; stop for host review");
        settlementKeys.add(key);
      } else {
        const active = coreHistory.at(-1);
        if (!active || record.payload.definitionRevision !== active.revisionHash || record.payload.result.setId !== "core-roles" || record.payload.result.revisionHash !== active.specHash) throw new Error("Core role evaluation has no active definition; stop for host review.");
        const expected = coreRoleDefinitions({ source: { id: sourceId } }, active.roster).map(item => ({ id: item.id, definitionHash: contentHash(item) }));
        const actual = record.payload.result.requirements.map(item => ({ id: item.id, definitionHash: item.definitionHash }));
        if (contentHash(expected.sort((a, b) => a.id.localeCompare(b.id))) !== contentHash(actual.sort((a, b) => a.id.localeCompare(b.id)))) throw new Error("Historical core role evaluation definition inventory mismatch");
        evaluations.set(contentHash(record.payload), record.payload);
      }
    }
  } catch (error) { ctx.addIssue({ code: "custom", message: String(error) }); }
});

function assertPrerequisiteEvidence(record: PrerequisiteRecord, bytes: Uint8Array) {
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== record.scope.sourceHash
    || record.evidence.some(e => contentHash(e.anchor) !== contentHash(textAnchorForByteRange(record.scope.sourceId, bytes, e.anchor.startByte, e.anchor.endByte))
      || Buffer.from(bytes).subarray(e.anchor.startByte, e.anchor.endByte).toString("utf8") !== e.selector.exact)) throw prerequisiteStop("Prerequisite evidence differs from immutable source bytes");
}
function assertRepresentationEvidence(record: RepresentationRecord, bytes: Uint8Array) {
  const scope = record.scope.prerequisiteScope;
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== scope.sourceHash
    || record.evidence.some(e => contentHash(e.anchor) !== contentHash(textAnchorForByteRange(scope.sourceId, bytes, e.anchor.startByte, e.anchor.endByte))
      || Buffer.from(bytes).subarray(e.anchor.startByte, e.anchor.endByte).toString("utf8") !== e.selector.exact)) throw prerequisiteStop("Representation evidence differs from immutable source bytes");
  assertRepresentationAnchors(record.output, scope.sourceId, bytes);
}

export function requirementSnapshotInputs<T extends { requirementJournal?: LedgerRecord[] }>(snapshot: T): Omit<T, "requirementJournal"> {
  const { requirementJournal: _history, ...inputs } = snapshot;
  return inputs;
}

export function requirementJournalBindingIssues(snapshot: {
  requirementJournal?: LedgerRecord[]; coreRoleReviewRevision?: RoleReviewRevision; roleRoster?: RoleRoster | null; requirementDefinitions?: RequirementSet[]; coreRoleRequirementDefinitions?: CoreRoleRequirementDefinition[];
  reconciliationObligations?: { receipt: CompilerFinishReceipt }[];
}, sourceId: string, sourceSha256: string, requireHistory = false): string[] {
  if (!snapshot.requirementJournal) {
    if (snapshot.roleRoster?.reviews.some(r => (r.workEvidence?.judgmentRevisions?.length || r.workEvidence?.auditContractRevisions?.length || r.workEvidence?.sourceAuditRevisions?.length))) return ["REQUIREMENT_JOURNAL_MISSING"];
    if (snapshot.coreRoleReviewRevision || snapshot.roleRoster?.reviewRevisionId || snapshot.coreRoleRequirementDefinitions?.some(definition => definition.roster.reviewRevisionId)) return ["CORE_ROLE_REVIEW_REVISION_MISMATCH"];
    return requireHistory && (snapshot.requirementDefinitions?.length || snapshot.coreRoleRequirementDefinitions?.length) ? ["REQUIREMENT_JOURNAL_MISSING"] : []; // Historical bundles predate full journal transport.
  }
  const parsed = requirementJournalSchema.safeParse(snapshot.requirementJournal);
  if (!parsed.success) return ["REQUIREMENT_JOURNAL_INVALID"];
  const history = parsed.data, issues: string[] = [];
  if (history.some(r => r.payload.kind === "source-representation" && r.payload.record.scope.prerequisiteScope.sourceHash !== sourceSha256)) issues.push("SOURCE_REPRESENTATION_SOURCE_MISMATCH");
  if (history.some(r => r.payload.kind === "role-source-prerequisite" && r.payload.record.scope.sourceHash !== sourceSha256)) issues.push("ROLE_PREREQUISITE_SOURCE_MISMATCH");
  const reviewRevision = history.findLast(record => record.payload.kind === "core-role-review-revision");
  const expectedRevision = reviewRevision?.payload.kind === "core-role-review-revision" ? reviewRevision.payload.revision : undefined;
  if (contentHash(expectedRevision ?? null) !== contentHash(snapshot.coreRoleReviewRevision ?? null) || (snapshot.roleRoster?.reviewRevisionId && snapshot.roleRoster.reviewRevisionId !== expectedRevision?.id)) issues.push("CORE_ROLE_REVIEW_REVISION_MISMATCH");
  const reviewSnapshot = history.findLast(record => record.payload.kind === "core-role-review-snapshot" && record.payload.roster.reviewRevisionId === expectedRevision?.id);
  if (reviewSnapshot?.payload.kind === "core-role-review-snapshot") {
    const retained = reviewSnapshot.payload.roster, current = snapshot.roleRoster;
    if (!current || current.subjectHash !== retained.subjectHash || current.reviewRevisionId !== retained.reviewRevisionId || retained.reviews.some((review, index) => contentHash(review) !== contentHash(current.reviews[index] ?? null))) issues.push("CORE_ROLE_REVIEW_SNAPSHOT_MISMATCH");
  }
  if (requireHistory && expectedRevision && (snapshot.roleRoster?.reviewRevisionId !== expectedRevision.id || snapshot.coreRoleRequirementDefinitions?.at(-1)?.roster.reviewRevisionId !== expectedRevision.id)) issues.push("CORE_ROLE_REVIEW_REVISION_PENDING");
  if (history.some(record => record.sourceId !== sourceId)) issues.push("REQUIREMENT_JOURNAL_SOURCE_MISMATCH");
  for (const review of snapshot.roleRoster?.reviews ?? []) {
    const proof = review.workEvidence;
    if (proof?.version !== 2) continue;
    const planHash = contentHash(proof.plan);
    for (const repair of proof.sourceAuditRevisions ?? []) {
      if (!history.some(r => r.payload.kind === "role-source-audit-repair" && contentHash(r.payload.proof) === contentHash(repair))) issues.push("SOURCE_AUDIT_REPAIR_HISTORY_MISSING");
    }
    for (const { payload } of history) if (payload.kind === "role-source-audit-repair" && payload.proof.authority.planHash === planHash) {
      if (!(proof.sourceAuditRevisions ?? []).some(repair => contentHash(repair) === contentHash(payload.proof))) issues.push("SOURCE_AUDIT_REPAIR_PROOF_MISSING");
    }
    issues.push(...roleJudgmentJournalIssues(history, planHash, proof.judgmentRevisions ?? [], proof.claimAudits ?? [], proof.auditContractRevisions ?? []));
    for (const r of history) if (r.payload.kind === "role-review-evidence-need" && r.payload.planHash === planHash
      && !history.some(s => s.payload.kind === "role-review-evidence-resolution" && s.payload.needRef === contentHash(r.payload))) issues.push("ROLE_REVIEW_EVIDENCE_NEED_UNRESOLVED");
    for (const [page, note] of proof.sourceWork.entries()) for (const question of roleQuestions(planHash, page, note)) {
      const audit = proof.auditWork[page], disposition = audit?.questionDispositions?.find(d => d.questionId === question.questionId);
      if (!history.some(r => r.payload.kind === "role-review-question" && contentHash(r.payload.question) === contentHash(question))
        || !history.some(r => r.payload.kind === "role-review-question-disposition" && r.payload.planHash === planHash && r.payload.auditRef === contentHash(audit)
          && contentHash(r.payload.disposition) === contentHash(disposition ?? null))) issues.push("ROLE_REVIEW_QUESTION_HISTORY_MISSING");
    }
  }
  const scenes = history.flatMap(record => record.payload.kind === "definition" ? [record.payload.definition] : []);
  const roles = history.flatMap(record => record.payload.kind === "core-role-definition" ? [record.payload.definition] : []);
  if (contentHash(scenes) !== contentHash(snapshot.requirementDefinitions ?? []) || contentHash(roles) !== contentHash(snapshot.coreRoleRequirementDefinitions ?? [])) issues.push("REQUIREMENT_JOURNAL_DEFINITIONS_MISMATCH");
  if (scenes.some(set => set.spec.sourceSha256 !== sourceSha256) || roles.some(definition => definition.sourceSha256 !== sourceSha256)) issues.push("REQUIREMENT_JOURNAL_SOURCE_MISMATCH");
  for (const record of history) {
    if (record.payload.kind !== "core-role-attempt") continue;
    const retained = record.payload.receipt;
    if (!(snapshot.reconciliationObligations ?? []).some(item => contentHash(item.receipt) === contentHash(retained))) issues.push("REQUIREMENT_JOURNAL_RECEIPT_MISSING");
  }
  return issues;
}

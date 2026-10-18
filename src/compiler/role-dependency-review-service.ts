import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { CanonicalModelStore } from "../world/canonical-model.js";
import { SourceAnnotationStore } from "./annotations.js";
import { EntityResolutionStore } from "./entity-resolution.js";
import { EventResolutionStore } from "./event-resolution.js";
import { SourceStructureStore } from "./structure.js";
import { RoleRosterStore, buildRoleRoster } from "./role-roster.js";
import { RoleReviewWorkStore } from "./role-review-work.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { UpstreamRepairLedger } from "./upstream-repair-ledger.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import { prerequisiteTaskId, prerequisiteStop, type PrerequisiteScope } from "./role-source-prerequisites.js";
import { validateRepresentationHistory, representationIsReady } from "./source-representation.js";
import { verifyPrerequisiteTrace } from "./role-source-prerequisite-trace.js";
import { verifyRepresentationTrace } from "./source-representation-trace.js";
import { verifySourceUpstreamAcceptance } from "./source-representation-acceptance.js";
import { verifyUpstreamRepairPlan } from "./upstream-repair-preflight.js";
import { sourceAuditAuthorities, sourceAuditRepairState, assertSourceAuditHistory } from "./role-source-audit-repair.js";
import { sourceAuditRepairWorkId } from "./role-source-audit-model.js";
import { inspectRoleReviewBudget } from "./role-review-budget.js";
import { loadCompilerArtifactRecords } from "./artifact-retrieval.js";
import { discoverUpstreamRepairDiagnostics } from "./upstream-repair-discovery.js";
import { assertAdditiveRoleInventory, freezeRoleDependencyReview, type RoleDependencyReview } from "./role-dependency-review.js";

export type RoleDependencyReviewInput = { scope: PrerequisiteScope; upstreamPlanHash: string; authorizationRef: string };
export type SemanticCatalogItem = { kind: string; id: string; revisionHash: string; payload: unknown };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Strictly read-only. Reconstruct the OLD roster by removing only exact outputs
 * of the completed receipt. Shared text or a caller's candidate count is insufficient. */
export async function prepareCoreRoleDependencyReview(root: string, input: RoleDependencyReviewInput) {
  const { scope } = input, taskId = prerequisiteTaskId(scope), sourceId = scope.sourceId;
  const ledger = new RequirementLedger(root, sourceId), history = await ledger.history();
  const existing = (await ledger.roleDependencyReviews()).find(r => r.taskId === taskId);
  const prerequisites = await ledger.sourcePrerequisites(taskId), representations = await ledger.sourceRepresentations(taskId);
  validateRepresentationHistory(prerequisites, representations);
  if (!representationIsReady(representations) || contentHash(prerequisites[0]?.scope) !== contentHash(scope)) throw prerequisiteStop("Missing original independently checked source specifications");
  for (const r of prerequisites) await verifyPrerequisiteTrace(root, r);
  for (const r of representations) await verifyRepresentationTrace(root, r);
  const upstream = await new UpstreamRepairLedger(root, sourceId).inspect();
  const completed = upstream.plans.find(p => p.plan.planHash === input.upstreamPlanHash);
  if (!completed || completed.state !== "converged" || completed.plan.sourceRepresentation?.taskId !== taskId
    || !completed.finishedReceipt || upstream.modelSessions.some(s => !s.closed)) throw prerequisiteStop("Exact source dependency has no settled converged receipt");
  const acceptance = await verifySourceUpstreamAcceptance(root, completed.plan);
  const receipt = await new CompilerFinishReceipts(root, sourceId, completed.plan.batchId).read();
  if (!receipt || receipt.state !== "completed" || receipt.fingerprint !== completed.finishedReceipt
    || receipt.identity.upstreamRepairIntent?.planHash !== input.upstreamPlanHash) throw prerequisiteStop("Original source finish intent/receipt differs from convergence");
  const outputs = new Map(receipt.identity.upstreamRepairIntent.proposals.map(p => [`${p.artifactKind}:${p.artifactId}`, p.payloadHash]));
  await verifyUpstreamRepairPlan(root, completed.plan, outputs);
  const source = await WorkspaceStore.openReadOnly(root).getSource(sourceId);
  if (!source || source.contentSha256 !== scope.sourceHash) throw prerequisiteStop("Original source registration changed");
  const bytes = await readSourceMaterial(root, source);
  const [saved, structure, annotations, resolutions, events, allEntities] = await Promise.all([
    new RoleRosterStore(root).read(sourceId), new SourceStructureStore(root).read(sourceId), new SourceAnnotationStore(root).list(sourceId),
    new EntityResolutionStore(root).list(sourceId), new EventResolutionStore(root).list(sourceId), new CanonicalModelStore(root).listEntities(),
  ]);
  const priorPlan = (await RoleReviewWorkStore.plans(root, sourceId)).find(p => contentHash(p) === scope.planHash);
  if (!priorPlan || !saved || !structure || structure.sourceSha256 !== scope.sourceHash || contentHash(structure) !== priorPlan.structureHash) throw prerequisiteStop("Original role plan, roster or structure changed");
  const work = new RoleReviewWorkStore(root, priorPlan), authority = sourceAuditAuthorities(work, scope.questions[0]!.page).find(a => a.revisionId === scope.auditRevisionId);
  if (!authority) throw prerequisiteStop("Original consumed audit authority is missing");
  await assertSourceAuditHistory(work, authority);
  const old = sourceAuditRepairState(work, authority);
  if (!old.proposal || old.verification || contentHash(old.proposal) !== scope.negativeProposalHash
    || contentHash(old.proposal.unresolved) !== scope.retainedIssuesHash
    || inspectRoleReviewBudget(root, scope.planHash, work.budgetWorkId(sourceAuditRepairWorkId(scope.auditRevisionId))).hash !== scope.originalBudgetHash) throw prerequisiteStop("Original consumed repair, failure or cumulative budget changed");
  for (const q of scope.questions) {
    const registered = history.find(r => r.payload.kind === "role-review-question" && r.payload.question.questionId === q.questionId);
    const disposition = history.findLast(r => r.payload.kind === "role-review-question-disposition" && r.payload.disposition.questionId === q.questionId);
    if (registered?.payload.kind !== "role-review-question" || contentHash(registered.payload.question) !== contentHash(q)
      || q.impact !== "critical" || disposition?.payload.kind !== "role-review-question-disposition" || disposition.payload.disposition.status !== "blocked") throw prerequisiteStop("Original critical/blocked question lineage changed");
  }
  const addedAnnotationIds = completed.plan.allowedCreations.map(a => a.id);
  if (outputs.size !== addedAnnotationIds.length || annotations.filter(a => addedAnnotationIds.includes(a.id)).some(a => outputs.get(`${a.annotationType}:${a.id}`) !== contentHash(a))) throw prerequisiteStop("Source output payload changed after acceptance");
  const entities = allEntities.filter(e => e.evidence.some(e => e.span.sourceId === sourceId));
  const build = (items: typeof annotations) => buildRoleRoster({ sourceId, sourceSha256: scope.sourceHash, unitIds: structure.baseUnitIds, entities, annotations: items, resolutions });
  const prior = build(annotations.filter(a => !addedAnnotationIds.includes(a.id))), nextRoster = build(annotations);
  const { reviews: _savedReviews, reviewRevisionId: _savedRevision, ...savedSubject } = saved;
  const { reviews: _priorReviews, reviewRevisionId: _priorRevision, ...priorSubject } = prior;
  if (contentHash(priorSubject) !== contentHash(savedSubject)) throw prerequisiteStop("Receipt removal does not reproduce the entire original role subject");
  const addedCandidateIds = assertAdditiveRoleInventory(saved, nextRoster, addedAnnotationIds);
  const catalog: SemanticCatalogItem[] = [
    ...annotations.map(a => ({ kind: a.annotationType, id: a.id, payload: a })),
    ...resolutions.map(a => ({ kind: "entity-resolution", id: a.id, payload: a })),
    ...events.map(a => ({ kind: "event-resolution", id: a.id, payload: a })),
    ...(await loadCompilerArtifactRecords(root, sourceId)).filter(a => a.status === "canonical").flatMap(a => [
      { kind: a.kind, id: a.logicalId, payload: a.payload }, ...a.evidenceAssertions.map(e => ({ kind: "evidence-assertion", id: e.id, payload: e })),
    ]),
  ].map(a => ({ ...a, revisionHash: contentHash(a.payload) }));
  const catalogByKey = new Map<string, SemanticCatalogItem>();
  for (const item of catalog) {
    const key = `${item.kind}:${item.id}`, previous = catalogByKey.get(key);
    if (previous && previous.revisionHash !== item.revisionHash) throw prerequisiteStop("Conflicting current revisions for one typed semantic dependency");
    catalogByKey.set(key, item);
  }
  const uniqueCatalog = [...catalogByKey.values()].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  const discovery = await discoverUpstreamRepairDiagnostics(root, sourceId);
  const retainedFiles: RoleDependencyReview["retainedFiles"] = [];
  const storage = worldStorageRoot(root);
  async function capture(file: string) {
    const stat = await fs.lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
    if (!stat) return;
    if (stat.isSymbolicLink() || file.endsWith(".tmp") || file.endsWith(".pending")) throw prerequisiteStop("Unsettled or redirected original role work");
    if (stat.isDirectory()) { for (const name of (await fs.readdir(file)).sort()) await capture(path.join(file, name)); return; }
    retainedFiles.push({ path: path.relative(storage, file), hash: digest(await fs.readFile(file)) });
  }
  // Includes all inherited plans, failed invocations, semantic grants and budgets,
  // rather than only the ordinary source/candidate allowance keys.
  await capture(path.join(storage, "compiler", "role-review-work"));
  await capture(path.join(storage, "compiler", "proposal-obligations", createHash("sha256").update(JSON.stringify([sourceId, priorPlan.batchId])).digest("hex")));
  const prefix = existing?.requirementPrefix ?? { length: history.length, head: history.at(-1)!.hash };
  if (history[prefix.length - 1]?.hash !== prefix.head) throw prerequisiteStop("Original requirement prefix changed");
  const convergence = upstream.records.findLast(r => r.payload.kind === "converged" && r.payload.planHash === input.upstreamPlanHash);
  if (!convergence) throw prerequisiteStop("Source convergence record missing");
  const review = freezeRoleDependencyReview({ version: 1, taskId, scope, authorizationRef: input.authorizationRef,
    authority: "semantic-scope-planning-only", priorPlan, priorRoster: saved, nextRoster,
    prerequisiteRecordHashes: prerequisites.map(contentHash), representationRecordHashes: representations.map(contentHash),
    upstream: { planHash: input.upstreamPlanHash, receiptFingerprint: receipt.fingerprint, acceptanceRecordHash: contentHash(acceptance),
      convergenceRef: convergence.hash, prefixLength: upstream.records.length, prefixHead: upstream.records.at(-1)!.hash },
    requirementPrefix: prefix, addedCandidateIds, addedAnnotationIds, catalogHash: contentHash(uniqueCatalog), discoveryHash: contentHash(discovery), retainedFiles });
  if (existing && contentHash(existing) !== contentHash(review)) throw prerequisiteStop("Frozen pending denominator revision changed; preserve it, never allocate another task or grant");
  return { review, catalog: uniqueCatalog, discovery, prerequisites, representations, bytes, source, upstreamPlan: completed.plan };
}

/** Caller owns the compiler lock. Publishes a pending revision only; the original
 * plan, roster pointer, question IDs, attempts and budgets remain byte-identical. */
export async function beginCoreRoleDependencyReview(root: string, input: RoleDependencyReviewInput) {
  const prepared = await prepareCoreRoleDependencyReview(root, input);
  await new RequirementLedger(root, input.scope.sourceId).recordRoleDependencyReview(prepared.review);
  return prepared;
}

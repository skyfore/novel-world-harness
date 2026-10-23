import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, vi } from 'vitest';
import { contentHash as h } from '../src/world/canonical.js';
import { worldStorageRoot } from '../src/world/paths.js';
import { roleDependencyFixture } from './helpers/role-dependency-fixture.js';
import { prepareCoreRoleDependencyReview } from '../src/compiler/role-dependency-review-service.js';
import { RequirementLedger } from '../src/compiler/requirement-ledger.js';
import { UpstreamRepairLedger } from '../src/compiler/upstream-repair-ledger.js';
import { CompilerFinishReceipts } from '../src/compiler/finish-receipts.js';
import { RoleReviewWorkStore } from '../src/compiler/role-review-work.js';
import { SourceStructureStore } from '../src/compiler/structure.js';
import { SourceAnnotationStore } from '../src/compiler/annotations.js';
import * as representation from '../src/compiler/source-representation.js';
import * as prerequisiteTrace from '../src/compiler/role-source-prerequisite-trace.js';
import * as representationTrace from '../src/compiler/source-representation-trace.js';
import * as acceptance from '../src/compiler/source-representation-acceptance.js';
import * as preflight from '../src/compiler/upstream-repair-preflight.js';
import * as audit from '../src/compiler/role-source-audit-repair.js';
import * as budget from '../src/compiler/role-review-budget.js';
import * as roster from '../src/compiler/role-roster.js';
import * as artifacts from '../src/compiler/artifact-retrieval.js';
import * as discovery from '../src/compiler/upstream-repair-discovery.js';
import { prerequisiteTaskId } from '../src/compiler/role-source-prerequisites.js';

test('freezes only the selected source while retaining its own plans, budgets and failed work', async () => {
  const f = await roleDependencyFixture();
  try {
    // Stub only the settled predecessor proofs; exercise the real preparation,
    // filesystem capture and freeze/compare operation under review.
    const sourceId = f.scope.sourceId;
    const structure = { sourceSha256: f.scope.sourceHash, baseUnitIds: ['unit'] };
    const priorPlan = { ...f.review.priorPlan, structureHash: h(structure) };
    const negative = { unresolved: ['Retained source question'] };
    const scope = { ...f.scope, planHash: h(priorPlan), negativeProposalHash: h(negative), retainedIssuesHash: h(negative.unresolved) };
    scope.questions = scope.questions.map(q => ({ ...q, planHash: scope.planHash }));
    const taskId = prerequisiteTaskId(scope);
    const prerequisites = f.prepared.prerequisites.map((r: any) => ({ ...r, scope, taskId }));
    const representations = f.prepared.representations;
    const history = scope.questions.flatMap(q => [
      { hash: h(q), payload: { kind: 'role-review-question', question: q } },
      { hash: h({ q, status: 'blocked' }), payload: { kind: 'role-review-question-disposition', disposition: { questionId: q.questionId, status: 'blocked' } } },
    ]);
    let saved: any;
    vi.spyOn(RequirementLedger.prototype, 'history').mockResolvedValue(history as any);
    vi.spyOn(RequirementLedger.prototype, 'roleDependencyReviews').mockImplementation(async () => saved ? [saved] : []);
    vi.spyOn(RequirementLedger.prototype, 'sourcePrerequisites').mockResolvedValue(prerequisites);
    vi.spyOn(RequirementLedger.prototype, 'sourceRepresentations').mockResolvedValue(representations);
    vi.spyOn(representation, 'validateRepresentationHistory').mockImplementation(() => {});
    vi.spyOn(representation, 'representationIsReady').mockReturnValue(true);
    vi.spyOn(prerequisiteTrace, 'verifyPrerequisiteTrace').mockResolvedValue(undefined as any);
    vi.spyOn(representationTrace, 'verifyRepresentationTrace').mockResolvedValue(undefined as any);
    const upstreamPlanHash = h('upstream');
    const additions = f.review.addedAnnotationIds.map(id => ({ annotationType: 'entity-mention', id }));
    const completed = { state: 'converged', finishedReceipt: h('receipt'), plan: { planHash: upstreamPlanHash, batchId: 'source-representation', sourceRepresentation: { taskId }, allowedCreations: additions } };
    vi.spyOn(UpstreamRepairLedger.prototype, 'inspect').mockResolvedValue({ plans: [completed], modelSessions: [], records: [{ hash: h('convergence'), payload: { kind: 'converged', planHash: upstreamPlanHash } }] } as any);
    vi.spyOn(acceptance, 'verifySourceUpstreamAcceptance').mockResolvedValue({ accepted: true } as any);
    vi.spyOn(CompilerFinishReceipts.prototype, 'read').mockResolvedValue({ state: 'completed', fingerprint: completed.finishedReceipt, identity: { upstreamRepairIntent: { planHash: upstreamPlanHash, proposals: additions.map(a => ({ artifactKind: a.annotationType, artifactId: a.id, payloadHash: h(a) })) } } } as any);
    vi.spyOn(preflight, 'verifyUpstreamRepairPlan').mockResolvedValue(undefined as any);
    vi.spyOn(RoleReviewWorkStore, 'plans').mockResolvedValue([priorPlan]);
    vi.spyOn(RoleReviewWorkStore.prototype, 'budgetWorkId').mockImplementation(id => id);
    vi.spyOn(SourceStructureStore.prototype, 'read').mockResolvedValue(structure as any);
    vi.spyOn(SourceAnnotationStore.prototype, 'list').mockResolvedValue(additions as any);
    vi.spyOn(audit, 'sourceAuditAuthorities').mockReturnValue([{ revisionId: scope.auditRevisionId }] as any);
    vi.spyOn(audit, 'assertSourceAuditHistory').mockResolvedValue(undefined);
    vi.spyOn(audit, 'sourceAuditRepairState').mockReturnValue({ proposal: negative } as any);
    vi.spyOn(budget, 'inspectRoleReviewBudget').mockReturnValue({ hash: scope.originalBudgetHash } as any);
    vi.spyOn(roster, 'buildRoleRoster').mockImplementation(input => input.annotations.length ? f.review.nextRoster : f.review.priorRoster);
    vi.spyOn(artifacts, 'loadCompilerArtifactRecords').mockResolvedValue([]);
    vi.spyOn(discovery, 'discoverUpstreamRepairDiagnostics').mockResolvedValue({ findings: [] } as any);
    const workDir = path.join(worldStorageRoot(f.root), 'compiler', 'role-review-work');
    await fs.mkdir(path.join(workDir, 'v1', h(sourceId)), { recursive: true });
    await fs.writeFile(path.join(workDir, 'v1', h(sourceId), 'plan.json'), JSON.stringify({ sourceId, plan: priorPlan }));
    const budgetDir = path.join(workDir, 'budgets', h(priorPlan));
    await fs.mkdir(budgetDir, { recursive: true });
    await fs.writeFile(path.join(budgetDir, 'usage.json'), JSON.stringify({ consumed: 3 }));
    const input = { scope, upstreamPlanHash, authorizationRef: 'Exact source A authorization' };
    const first = await prepareCoreRoleDependencyReview(f.root, input);
    saved = first.review;
    await expect(prepareCoreRoleDependencyReview(f.root, input)).resolves.toMatchObject({ review: saved });
    // Simulate a separate novel's valid role plan being created after A pauses.
    await fs.mkdir(path.join(workDir, 'v1', h('unrelated-source-B')), { recursive: true });
    await fs.writeFile(path.join(workDir, 'v1', h('unrelated-source-B'), 'plan.json'), JSON.stringify({ sourceId: 'unrelated-source-B' }));
    await fs.writeFile(path.join(workDir, 'v1', h('unrelated-source-B'), 'running.pending'), 'in flight');
    await expect(prepareCoreRoleDependencyReview(f.root, input)).resolves.toMatchObject({ review: saved });
    expect(saved.retainedFiles.some((f: { path: string }) => f.path.includes(h('unrelated-source-B')))).toBe(false);
    expect(saved.retainedFiles.some((f: { path: string }) => f.path.endsWith('usage.json'))).toBe(true);
    await fs.writeFile(path.join(budgetDir, 'usage.json'), JSON.stringify({ consumed: 4 }));
    await expect(prepareCoreRoleDependencyReview(f.root, input)).rejects.toThrow('Frozen pending denominator revision changed');
    await fs.writeFile(path.join(budgetDir, 'usage.json'), JSON.stringify({ consumed: 3 }));
    await fs.writeFile(path.join(workDir, 'v1', h(sourceId), 'running.pending'), 'in flight');
    await expect(prepareCoreRoleDependencyReview(f.root, input)).rejects.toThrow('Unsettled');
  } finally {
    vi.restoreAllMocks();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

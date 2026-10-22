import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEvidenceFixture } from "./evidence.js";
import { contentHash as h } from "../../src/world/canonical.js";
import { prerequisiteTaskId } from "../../src/compiler/role-source-prerequisites.js";
import { RequirementLedger } from "../../src/compiler/requirement-ledger.js";
import { RoleRosterStore } from "../../src/compiler/role-roster.js";
import { freezeRoleDependencyReview } from "../../src/compiler/role-dependency-review.js";
import { semanticScopePlanSchema } from "../../src/compiler/role-semantic-scope.js";
import { textAnchorForByteRange } from "../../src/compiler/text-anchors.js";

export async function roleDependencyFixture(parent: string | ((root: string, source: { id: string; contentSha256: string }) => string) = h("BREAK"), content = "Ada waits.") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-role-dependency-"));
  const f = await createEvidenceFixture(root, content), sourceId = f.source.id, sourceHash = f.source.contentSha256;
  const parentStateHash = typeof parent === "string" ? parent : parent(root, f.source);
  const candidates = Array.from({ length: 76 }, (_, i) => ({ id: `role-${i}`, name: `Candidate ${i}`, mentionIds: [], resolutionIds: [] }));
  const priorRoster = { version: 1 as const, sourceId, sourceSha256: sourceHash, subjectHash: h("old"), unitIds: ["unit"], extractionRunIds: [], candidates, reviews: [] };
  const nextRoster = { ...priorRoster, subjectHash: h("new"), candidates: [...candidates, { id: "role-76", name: "he", mentionIds: ["new-1"], resolutionIds: [] }, { id: "role-77", name: "brother", mentionIds: ["new-2"], resolutionIds: [] }] };
  const priorPlan = { version: 1 as const, sourceId, sourceHash, subjectHash: priorRoster.subjectHash, batchId: `role-roster-${sourceId}-original`, structureHash: h("structure"), spans: [{ start: 0, end: 10 }], legacyDraftHashes: [] };
  const scope = { version: 1 as const, policy: "role-source-prerequisites/v1" as const, sourceId, sourceHash, planHash: h(priorPlan), auditRevisionId: h("consumed"),
    negativeProposalHash: h("negative"), retainedIssuesHash: h("unresolved"), originalBudgetHash: h("19 calls consumed"), parentStateHash, authorizationRef: "Original authorization",
    questions: [1, 2, 3].map(i => ({ questionId: h(i), planHash: h(priorPlan), page: 0, text: `Independent critical question ${i}`, sourceUnitIds: ["unit"], impact: "critical" as const })) };
  const ledger = new RequirementLedger(root, sourceId);
  await ledger.registerRoleQuestions(scope.questions);
  for (const q of scope.questions) await ledger.recordRoleQuestionDisposition(scope.planHash, h("negative audit"), { questionId: q.questionId, status: "blocked", rationale: "Original negative evidence", basisUnitIds: ["unit"] });
  await new RoleRosterStore(root).write(priorRoster);
  const taskId = prerequisiteTaskId(scope), evidence = [{ segment_id: f.segmentId, exact: "Ada waits." }];
  const anchor = textAnchorForByteRange(sourceId, Buffer.from(content), 0, 10);
  const prerequisites: any[] = [];
  for (const phase of ["specification", "specification-check", "binding", "binding-check"]) {
    const base = { phase, scopeHash: h(scope) }, q = (questionId: string) => ({ questionId, impact: "critical", evidence });
    const output = phase === "specification" ? { ...base, requirements: scope.questions.map(i => ({ ...q(i.questionId), kind: "identity", requirement: "Independent requirement", acceptanceCriteria: ["Independent criterion"], evidenceBoundaries: ["Unknown retained"] })) }
      : phase === "binding" ? { ...base, specificationHash: h(prerequisites[0].output), discoveryHash: h([]), bindings: scope.questions.map(i => ({ ...q(i.questionId), route: "missing-source-representation", findingIds: [], candidateIds: [], rationale: "Representation absent", missingCondition: "Typed source boundary" })) }
      : { ...base, proposalHash: h(prerequisites.at(-1).output), judgments: scope.questions.map(i => ({ ...q(i.questionId), verdict: "supported", rationale: "Independent check" })) };
    prerequisites.push({ taskId, scope, phase, inputHash: h(phase), output, evidence: scope.questions.map(() => ({ selector: evidence[0], anchor })), traceRunId: `old-${phase}`, sessionId: `old-${phase}`, provider: "openai-codex", model: "gpt-6.1-sol", subscription: true, predecessorRecordHash: prerequisites.length ? h(prerequisites.at(-1)) : null });
  }
  const repScope = { version: 1, taskId, prerequisiteScope: scope, prerequisiteRecordHashes: prerequisites.map(h), authorizationRef: "Source representation authorization" };
  const annotationId = `sr-${taskId.slice(0, 32)}-1`, representationOutput = { phase: "representation-plan", scopeHash: h(repScope), catalogHash: h([]),
    annotations: [{ slot: 1, payload: { version: 1, annotationType: "discourse-segment", id: annotationId, sourceId, kind: "unclassified", anchors: [anchor], confidence: 0, interpretation: "Uncertain source voice", derivation: { runId: `source-representation-${taskId}`, compilerBatchId: `source-representation-${taskId}`, provider: "openai-codex", model: "gpt-6.1-sol", worker: "test", ontologyVersion: "observation-v1" } } }],
    readableAnnotationIds: [], boundaries: scope.questions.map(q => ({ questionId: q.questionId, kind: "identity", status: "unresolved", fromAnnotationIds: [annotationId], toAnnotationIds: [], rationale: "Boundary retained", evidence })),
    coverage: scope.questions.map((q, index) => ({ questionId: q.questionId, impact: "critical", originalStatus: "blocked", criteria: [{ index: 0, status: "represented", annotationIds: [annotationId], boundaryIndexes: [index], rationale: "Unknown retained" }], evidence })) };
  const representations: any[] = [];
  for (const phase of ["representation-plan", "representation-check"]) {
    const output = phase === "representation-plan" ? representationOutput : { phase, scopeHash: h(repScope), proposalHash: h(representationOutput), judgments: scope.questions.map(q => ({ questionId: q.questionId, verdict: "supported", rationale: "Independent representation check", evidence })) };
    representations.push({ scope: repScope, phase, inputHash: h(phase), output, evidence: Array.from({ length: phase === "representation-plan" ? 6 : 3 }, () => ({ selector: evidence[0], anchor })), traceRunId: `old-${phase}`, sessionId: `old-${phase}`, provider: "openai-codex", model: "gpt-6.1-sol", subscription: true, predecessorRecordHash: representations.length ? h(representations.at(-1)) : null });
  }
  const history = await ledger.history();
  for (const record of [...prerequisites, ...representations]) {
    const payload: any = record.taskId ? { kind: "role-source-prerequisite", record } : { kind: "source-representation", record };
    const identity = { version: 1 as const, sourceId, sequence: history.length, predecessorHash: history.at(-1)!.hash, payload };
    history.push({ ...identity, hash: h(identity) });
  }
  await ledger.restoreJournal(history, Buffer.from(content));
  const review = freezeRoleDependencyReview({ version: 1, taskId, scope, authority: "semantic-scope-planning-only", authorizationRef: "User authorizes exact semantic scopes after source receipt", priorPlan, priorRoster, nextRoster,
    prerequisiteRecordHashes: prerequisites.map(h), representationRecordHashes: representations.map(h), upstream: { planHash: h("upstream"), receiptFingerprint: h("receipt"), acceptanceRecordHash: h("acceptance"), convergenceRef: h("converged"), prefixLength: 125, prefixHead: h("head") },
    requirementPrefix: { length: history.length, head: history.at(-1)!.hash }, addedCandidateIds: ["role-76", "role-77"], addedAnnotationIds: ["new-1", "new-2"],
    catalogHash: h([]), discoveryHash: h([]), retainedFiles: [{ path: "compiler/original-consumed-grant.json", hash: h("unaltered") }] });
  const proposal = semanticScopePlanSchema.parse({ phase: "semantic-scope-plan", revisionHash: review.revisionHash, operations: [],
    questions: scope.questions.map((q, i) => ({ questionId: q.questionId, impact: "critical", originalStatus: "blocked",
      criteria: [{ index: 0, route: "evidence-gap", operationSlots: [], rationale: "No typed semantic repair is justified", missingCondition: "Independent source correspondence evidence", evidence }],
      boundaries: [{ index: i, status: "unresolved", rationale: "Uncertainty retained" }] })),
    consumer: { priorPlanHash: scope.planHash, priorSubjectHash: priorRoster.subjectHash, nextSubjectHash: nextRoster.subjectHash, addedCandidateIds: review.addedCandidateIds,
      affectedCandidateIds: review.addedCandidateIds, affectedSourcePages: [0], preserveOriginalQuestionIds: true, renewConsumedGrant: false, rationale: "Keep old source questions and budgets", activationConditions: ["Exact typed repair must be independently accepted"] } });
  const prepared: any = { review, catalog: [], discovery: { findings: [] }, prerequisites, representations, bytes: Buffer.from("Ada waits."), source: f.source, upstreamPlan: { sourceScope: { segmentIds: [f.segmentId] } } };
  return { root, f, ledger, review, scope, proposal, prepared, history, evidence };
}

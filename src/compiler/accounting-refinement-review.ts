import { z } from "zod";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { SourceMaterialStore } from "../storage/source-material-store.js";
import { contentHash } from "../world/canonical.js";
import { ActorModelStore } from "../world/actors.js";
import { CanonicalModelStore, ProposalStore, type CanonicalKind } from "../world/canonical-model.js";
import { InitialWorldStore } from "../world/initial.js";
import { evidenceAssertionSchema, idSchema, type EvidenceAssertion, type TextAnchor } from "../world/model.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { CompilerBatchStore } from "./batch-progress.js";
import { CompilerAccountingPages, type AccountingPage } from "./accounting-pages.js";
import { accountingCoverageProofFailure, type AccountingCoverageProof } from "./accounting-coverage-proof.js";
import {
  accountingRefinementCorrectionSchema,
  CompilerProposalObligations,
  type AccountingRefinementCorrection,
  type ProposalAttempt,
} from "./proposal-obligations.js";
import { SourceAnnotationStore, annotationAnchors } from "./annotations.js";
import { readPriorStageAccountingCoverage } from "./accounting-coverage.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import { EvidenceVerifier } from "./evidence.js";
import { createCompilerProposalToolset } from "./proposal-tools.js";
import {
  SourceAccountingStore,
  isBlockingSourceAccountingStatus,
  projectSourceAccountingProposalDecisions,
  sourceAccountingProposalIdentityHash,
  sourceUnitAccountingDecisionSchema,
  sourceUnitReviewRange,
  sourceUnitReviewStatusSchema,
  type ActiveSourceAccountingProposal,
  type SourceAccountingProposal,
  type SourceAccountingRefinement,
  type SourceUnitAccountingDecision,
} from "./source-accounting.js";
import { baseStructuralUnits, SourceStructureStore } from "./structure.js";
import type { SourceSegment } from "./segments.js";
import { jsonPointerExists } from "./text-anchors.js";

import { buildAccountingCoverageProof, readAccountingBatchSegments, rangeCovered } from "./accounting-review.js";

const accountingRefinementDispositionSchema = z.object({
  status: sourceUnitReviewStatusSchema,
  reason: z.string().trim().min(1).max(1_000),
}).strict();
const accountingRefinementInputSchema = z.object({
  proposal_id: idSchema,
  page_token: z.string().regex(/^acctpg-[a-f0-9]{16}$/),
  page_default: accountingRefinementDispositionSchema,
  page_overrides: z.array(z.object({
    unit_index: z.number().int().positive(),
    status: sourceUnitReviewStatusSchema,
    reason: z.string().trim().min(1).max(1_000),
  }).strict()).max(200).optional(),
}).strict();
export const accountingRefinementReviewOptionsSchema = z.object({
  sourceId: idSchema,
  batchId: idSchema,
  proposalId: idSchema,
  settleProposalIds: z.array(idSchema).refine(ids => new Set(ids).size === ids.length, "Settlement proposal IDs must be unique"),
  duplicateSupportProposalIds: z.array(idSchema)
    .refine(ids => new Set(ids).size === ids.length, "Duplicate support proposal IDs must be unique"),
  reason: z.string().trim().min(1),
  auditRef: z.string().trim().min(1),
  correctedInput: accountingRefinementInputSchema,
  expectedAuthorityHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type AccountingRefinementReviewOptions = z.infer<typeof accountingRefinementReviewOptionsSchema>;

export type AccountingRefinementPreview = {
  status: "verified-preview";
  executableCertification: false;
  authorityHash: string;
  binding: AccountingRefinementCorrection;
  input: z.infer<typeof accountingRefinementInputSchema>;
  batchSegmentIds: string[];
  units: Array<{
    unitId: string;
    startByte: number;
    endByte: number;
    text: string;
    proposedStatus: string;
    proposedReason: string;
    predecessorProposalId: string;
    predecessorStatus: string;
  }>;
};
export type AccountingRefinementResult = AccountingRefinementPreview | (Omit<AccountingRefinementPreview, "status"> & {
  status: "staged" | "recovered";
  proposal: SourceAccountingProposal;
  settlements: AccountingCoverageProof[];
});

/**
 * Preview or apply one exact host-reviewed replay of an exhausted accounting
 * identity whose page refines immutable blocking decisions. Apply requires the
 * authority hash returned by preview and revalidates it under the compiler lock.
 */
export async function reviewAccountingRefinementObligation(
  root: string,
  rawOptions: AccountingRefinementReviewOptions,
  apply = false,
): Promise<AccountingRefinementResult> {
  const options = accountingRefinementReviewOptionsSchema.parse(rawOptions);
  if (!apply) return buildAccountingRefinementPreview(root, options);
  if (!options.expectedAuthorityHash) {
    throw new Error("Host accounting refinement apply requires expectedAuthorityHash from its exact read-only preview.");
  }
  return withWorkspaceOperationLock(root, "compiler", async () => {
    const journal = new CompilerProposalObligations(root, options.sourceId, options.batchId);
    const history = journal.history("account_source_units", options.proposalId);
    const latest = history.at(-1);
    const retainedBinding = latest?.hostReview?.accountingRefinementCorrection;
    if (retainedBinding) {
      if (retainedBinding.authorityHash !== options.expectedAuthorityHash
        || latest.hostReview?.reason !== options.reason || latest.hostReview.auditRef !== options.auditRef) {
        throw new Error("A retained host accounting refinement has different authority or review identity.");
      }
      if (latest.status === "failed") throw new Error("The reviewed host accounting refinement failed and its single-use grant is exhausted.");
      if (latest.status !== "running" && latest.status !== "succeeded") {
        throw new Error("The retained host accounting refinement is not recoverable.");
      }
      return recoverAccountingRefinement(root, options, retainedBinding, latest.status === "running");
    }

    const preview = await buildAccountingRefinementPreview(root, options);
    if (preview.authorityHash !== options.expectedAuthorityHash) {
      throw new Error("Host accounting refinement authority changed after preview; inspect the new preview instead of applying stale approval.");
    }
    const toolset = createCompilerProposalToolset(root, {}, { hostObligationCorrection: true });
    await toolset.beginBatch(preview.batchSegmentIds, options.batchId, options.sourceId);
    const tool = toolset.tools.find(candidate => candidate.name === "account_source_units");
    if (!tool) throw new Error("Host accounting refinement tool is unavailable.");
    await journal.withHostAccountingRefinement(
      preview.input,
      preview.binding,
      options.reason,
      options.auditRef,
      async () => {
        const prepared = tool.prepareArguments ? await tool.prepareArguments(preview.input) : preview.input;
        return tool.execute("host-accounting-refinement", prepared as never, undefined, undefined, {} as never);
      },
    );
    const proposal = await readVerifiedRefinementProposal(root, preview.binding, preview.input);
    const settlements = await settleAccountingRefinementPredecessors(root, options, preview.binding);
    return { ...preview, status: "staged", proposal, settlements: settlements.proofs };
  });
}

async function buildAccountingRefinementPreview(
  root: string,
  options: AccountingRefinementReviewOptions,
): Promise<AccountingRefinementPreview> {
  const { sourceId, batchId, proposalId } = options;
  const journal = new CompilerProposalObligations(root, sourceId, batchId);
  const history = journal.history("account_source_units", proposalId);
  const latest = history.at(-1);
  if (!latest || latest.status !== "failed" || history.some(attempt => attempt.hostReview || attempt.coverageProof)) {
    throw new Error("Host accounting refinement requires one exact unreviewed failed identity.");
  }
  const failed = [...new Map(history.filter(attempt => attempt.status === "failed").map(attempt => [attempt.inputHash, attempt])).values()];
  if (failed.length < 2) throw new Error("Host accounting refinement requires exhausted original and corrected inputs.");
  const latestFailedInput = accountingRefinementInputSchema.parse(latest.input);
  const input = options.correctedInput;
  if (input.proposal_id !== proposalId) throw new Error("Host accounting refinement must retain the exact failed proposal ID.");
  if (input.page_token !== latestFailedInput.page_token) {
    throw new Error("Host accounting refinement correction must retain the latest failed page token and exact unit scope.");
  }
  const inputHash = CompilerProposalObligations.identity("account_source_units", input).inputHash;
  if (failed.some(attempt => attempt.inputHash === inputHash)) {
    throw new Error("Host accounting refinement requires one reviewed correction that differs from every exhausted failed input.");
  }

  const source = await WorkspaceStore.openReadOnly(root).getSource(sourceId);
  if (!source) throw new Error(`Unknown source ${sourceId}; inspect registered sources before host review.`);
  const bytes = await new SourceMaterialStore().read(source);
  if (!bytes) throw new Error("Archived source bytes are missing; host review cannot reconstruct them.");
  const structure = await new SourceStructureStore(root).read(sourceId);
  if (!structure || structure.sourceSha256 !== source.contentSha256) {
    throw new Error("Missing or incompatible source structure; host repair is required.");
  }
  const segments = await readAccountingBatchSegments(root, sourceId, batchId);
  const batchSegmentIds = segments.map(segment => segment.id).sort();
  const finish = await new CompilerFinishReceipts(root, sourceId, batchId).read();
  if (finish) throw new Error("Host accounting refinement is forbidden after a prepared or completed finish receipt.");
  const progress = await new CompilerBatchStore(root).read(sourceId);
  if (progress.completedBatchIds.includes(batchId)) throw new Error("Host accounting refinement is forbidden after the current batch checkpoint.");

  const pages = new CompilerAccountingPages(root, sourceId, batchId);
  const failedPages = failed.map((attempt) => {
    const failedInput = accountingRefinementInputSchema.parse(attempt.input);
    if (failedInput.proposal_id !== proposalId) throw new Error("Failed accounting refinement history changed proposal identity.");
    const page = pages.read(failedInput.page_token);
    if (!page || page.consumedBy || page.sourceSha256 !== source.contentSha256
      || contentHash([...page.segmentIds].sort()) !== contentHash(batchSegmentIds)) {
      throw new Error(`Failed accounting page ${failedInput.page_token} is missing, consumed, or outside the current source/batch scope.`);
    }
    return { attempt, input: failedInput, page };
  });
  const replayPage = pages.read(input.page_token)!;
  const unitIds = [...replayPage.unitIds];
  if (failedPages.some(({ page }) => contentHash(page.unitIds) !== contentHash(unitIds))) {
    throw new Error("Failed accounting inputs do not share one exact bounded unit scope.");
  }
  const decisions = expandAccountingRefinementInput(input, replayPage);
  if (decisions.some(decision => isBlockingSourceAccountingStatus(decision.status))) {
    throw new Error("Host accounting refinement must replace blocking decisions with reviewed nonblocking dispositions.");
  }

  const accounting = new SourceAccountingStore(root);
  for (const status of ["pending", "accepted", "rejected"] as const) {
    try {
      await accounting.readProposal(sourceId, status, proposalId);
      throw new Error(`Host accounting refinement proposal ${proposalId} already has ${status} output.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const activeAccounting = await readActiveAccountingProposals(accounting, sourceId, batchId);
  const semantic = await readAccountingSemanticBaseline(root, sourceId, batchId, segments);
  const unitsById = new Map(baseStructuralUnits(structure).map(unit => [unit.id, unit]));
  const statusByProposal = new Map(activeAccounting.map(item => [item.proposal.id, item.proposalStatus]));
  const projected = projectSourceAccountingProposalDecisions(activeAccounting).filter((decision) => {
    const unit = unitsById.get(decision.unitId);
    if (!unit) return true;
    const represented = semantic.spans.some(span => span.sourceId === sourceId
      && unit.anchor.startByte < span.endByte && span.startByte < unit.anchor.endByte);
    const inherited = semantic.inheritedSpans.some(span => span.sourceId === sourceId
      && unit.anchor.startByte < span.endByte && span.startByte < unit.anchor.endByte);
    return !(represented && (statusByProposal.get(decision.proposalId!) === "accepted" || inherited));
  });
  const priorByUnit = new Map(projected.map(decision => [decision.unitId, decision]));
  const activeById = new Map(activeAccounting.map(item => [item.proposal.id, item.proposal]));
  const predecessorDecisions: AccountingRefinementCorrection["predecessorDecisions"] = [];
  for (const decision of decisions) {
    const unit = unitsById.get(decision.unitId);
    if (!unit || unit.kind === "non-scene" || !rangeCovered(sourceUnitReviewRange(bytes, unit), segments)) {
      throw new Error(`Refined source unit ${decision.unitId} is missing, deterministic, or outside the exact batch scope.`);
    }
    if (semantic.spans.some(span => span.sourceId === sourceId
      && unit.anchor.startByte < span.endByte && span.startByte < unit.anchor.endByte)) {
      throw new Error(`Refined source unit ${decision.unitId} now has represented semantic coverage; refetch instead of replaying the failed page.`);
    }
    const prior = priorByUnit.get(decision.unitId);
    const predecessor = prior?.proposalId ? activeById.get(prior.proposalId) : undefined;
    if (!prior?.proposalId || !predecessor || !isBlockingSourceAccountingStatus(prior.status)) {
      throw new Error(`Refined source unit ${decision.unitId} no longer has one active blocking predecessor decision.`);
    }
    predecessorDecisions.push({
      unitId: decision.unitId,
      proposalId: prior.proposalId,
      proposalHash: contentHash(predecessor),
      status: prior.status,
    });
  }
  const refinements: SourceAccountingRefinement[] = [...new Set(predecessorDecisions.map(item => item.proposalId))]
    .sort()
    .map(predecessorId => ({
      proposalId: predecessorId,
      proposalHash: predecessorDecisions.find(item => item.proposalId === predecessorId)!.proposalHash,
      unitIds: predecessorDecisions.filter(item => item.proposalId === predecessorId).map(item => item.unitId).sort(),
    }));
  const expectedProposal: SourceAccountingProposal = {
    version: 1,
    id: proposalId,
    sourceId,
    compilerBatchId: batchId,
    decisions,
    generatedBy: { worker: "account_source_units" },
    refinements,
    createdAt: latest.updatedAt,
  };

  const requiredSettlementIds = [...new Set(predecessorDecisions.map(item => item.proposalId)
    .filter(id => journal.unresolved().some(item => item.tool === "account_source_units" && item.proposalId === id)))].sort();
  const selectedSettlementIds = [...options.settleProposalIds].sort();
  if (contentHash(requiredSettlementIds) !== contentHash(selectedSettlementIds)) {
    throw new Error(`Host accounting refinement must settle exactly these predecessor obligations: ${requiredSettlementIds.join(", ") || "(none)"}.`);
  }
  const settlementObligations = selectedSettlementIds.map(settlementId => {
    const settlementHistory = journal.history("account_source_units", settlementId);
    const unresolved = journal.unresolved().find(item => item.tool === "account_source_units" && item.proposalId === settlementId);
    if (!unresolved || unresolved.status === "running" || settlementHistory.some(attempt => attempt.hostReview || attempt.coverageProof)) {
      throw new Error(`Predecessor accounting obligation ${settlementId} is not an unreviewed failed identity.`);
    }
    const failedUnitIds = accountingFailureUnitIds(root, sourceId, batchId, settlementHistory);
    if (failedUnitIds.some(id => !unitIds.includes(id))) {
      throw new Error(`Predecessor accounting obligation ${settlementId} includes units outside the reviewed refinement.`);
    }
    return { proposalId: settlementId, historyHash: contentHash(settlementHistory), unitIds: failedUnitIds };
  });
  const duplicateSupportDependencies = await readDuplicateSupportDependencies(
    root,
    sourceId,
    decisions,
    new Map([...unitsById].map(([unitId, unit]) => [unitId, unit.anchor])),
    options.duplicateSupportProposalIds,
  );

  const activeAccountingGraphHash = contentHash(activeAccounting.map(item => ({
    status: item.proposalStatus,
    proposal: item.proposal,
  })).sort((left, right) => left.proposal.id.localeCompare(right.proposal.id)));
  const pageReceipts = failedPages.map(({ page }) => ({ token: page.token, hash: contentHash(page) }))
    .sort((left, right) => left.token.localeCompare(right.token));
  const authorityBase = {
    version: 1 as const,
    sourceId,
    batchId,
    proposalId,
    inputHash,
    failedInputHashes: failed.map(attempt => attempt.inputHash).sort(),
    historyHash: contentHash(history),
    sourceSha256: source.contentSha256,
    structureHash: contentHash(structure),
    batchSegmentIds,
    activeAccountingGraphHash,
    semanticBaselineHash: semantic.hash,
    batchProgressHash: contentHash(progress),
    pageReceipts,
    unitIds: [...unitIds],
    predecessorDecisions: [...predecessorDecisions].sort((left, right) => left.unitId.localeCompare(right.unitId)),
    proposalIdentityHash: sourceAccountingProposalIdentityHash(expectedProposal),
    settlementObligations,
    duplicateSupportDependencies,
  };
  const authorityHash = contentHash(authorityBase);
  const binding = accountingRefinementCorrectionSchema.parse({ ...authorityBase, authorityHash });
  if (options.expectedAuthorityHash && options.expectedAuthorityHash !== authorityHash) {
    throw new Error("Host accounting refinement authority changed after preview; inspect the new preview instead of applying stale approval.");
  }
  return {
    status: "verified-preview",
    executableCertification: false,
    authorityHash,
    binding,
    input,
    batchSegmentIds,
    units: decisions.map(decision => {
      const unit = unitsById.get(decision.unitId)!;
      const prior = predecessorDecisions.find(item => item.unitId === decision.unitId)!;
      return {
        unitId: decision.unitId,
        startByte: unit.anchor.startByte,
        endByte: unit.anchor.endByte,
        text: bytes.subarray(unit.anchor.startByte, unit.anchor.endByte).toString("utf8"),
        proposedStatus: decision.status,
        proposedReason: decision.reason,
        predecessorProposalId: prior.proposalId,
        predecessorStatus: prior.status,
      };
    }),
  };
}

function expandAccountingRefinementInput(
  input: z.infer<typeof accountingRefinementInputSchema>,
  page: AccountingPage,
): SourceUnitAccountingDecision[] {
  const overrides = new Map<number, z.infer<typeof accountingRefinementDispositionSchema>>();
  for (const override of input.page_overrides ?? []) {
    if (override.unit_index > page.unitIds.length || overrides.has(override.unit_index)) {
      throw new Error(`Accounting refinement override ${override.unit_index} is outside or duplicated in the retained page.`);
    }
    overrides.set(override.unit_index, { status: override.status, reason: override.reason });
  }
  return page.unitIds.map((unitId, index) => sourceUnitAccountingDecisionSchema.omit({ proposalId: true }).parse({
    unitId,
    ...(overrides.get(index + 1) ?? input.page_default),
  }));
}

const duplicateSupportCanonicalKinds: Readonly<Record<string, CanonicalKind>> = {
  entity: "entities",
  proposition: "propositions",
  attribution: "attributions",
  claim: "claims",
  "canonical-event": "events",
  "event-participation": "event-participations",
  "event-relation": "event-relations",
  "spatial-relation": "spatial-relations",
  "scene-occurrence": "scene-occurrences",
  "event-frame": "event-frames",
  "semantic-effect": "semantic-effects",
  "perception-observation": "perception-observations",
  acquisition: "acquisitions",
  "utterance-expression": "utterance-expressions",
  "action-schema": "action-schemas",
  "event-execution": "event-executions",
  "action-constraint": "action-constraints",
  "norm-template": "norm-templates",
  "process-template": "process-templates",
  "world-rule": "rules",
};

async function readDuplicateSupportDependencies(
  root: string,
  sourceId: string,
  decisions: readonly SourceUnitAccountingDecision[],
  unitAnchors: ReadonlyMap<string, TextAnchor>,
  proposalIdsInput: readonly string[],
): Promise<AccountingRefinementCorrection["duplicateSupportDependencies"]> {
  const duplicateUnitIds = decisions.filter(decision => decision.status === "duplicate-description")
    .map(decision => decision.unitId).sort();
  const proposalIds = [...proposalIdsInput].sort();
  if (!duplicateUnitIds.length) {
    if (proposalIds.length) throw new Error("Host accounting refinement supplied semantic support without any duplicate-description decision.");
    return [];
  }
  if (!proposalIds.length) {
    throw new Error("Every duplicate-description correction requires at least one exact accepted semantic support proposal.");
  }

  const proposals = new ProposalStore(root);
  const verifier = new EvidenceVerifier(root);
  const dependencies: AccountingRefinementCorrection["duplicateSupportDependencies"] = [];
  const coveredUnitIds = new Set<string>();
  for (const proposalId of proposalIds) {
    let raw: Record<string, unknown>;
    try {
      raw = await proposals.readEnvelope("accepted", proposalId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Duplicate-description support proposal ${proposalId} is not accepted.`);
      }
      throw error;
    }
    for (const ambiguousStatus of ["pending", "rejected"] as const) {
      try {
        await proposals.readEnvelope(ambiguousStatus, proposalId);
        throw new Error(`Duplicate-description support proposal ${proposalId} also exists in ${ambiguousStatus} state.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const envelope = z.object({
      id: idSchema,
      kind: idSchema,
      payload: z.record(z.string(), z.unknown()),
      evidenceAssertions: evidenceAssertionSchema.array().default([]),
    }).passthrough().parse(raw);
    if (envelope.id !== proposalId) throw new Error(`Duplicate-description support proposal ${proposalId} changed identity.`);
    const artifactId = envelope.kind === "character-model"
      ? idSchema.parse(envelope.payload.actorId)
      : envelope.kind === "initial-world"
        ? "initial-world"
        : idSchema.parse(envelope.payload.id);
    const artifactRevisionHash = contentHash(envelope.payload);
    let currentRevisionHash: string | undefined;
    const canonicalKind = duplicateSupportCanonicalKinds[envelope.kind];
    if (canonicalKind) {
      currentRevisionHash = (await new CanonicalModelStore(root).currentRevision(canonicalKind, artifactId))?.hash;
    } else if (envelope.kind === "character-goal" || envelope.kind === "character-model") {
      currentRevisionHash = (await new ActorModelStore(root).currentRevision(
        envelope.kind === "character-goal" ? "goals" : "models",
        artifactId,
      ))?.hash;
    } else if (envelope.kind === "initial-world") {
      currentRevisionHash = (await new InitialWorldStore(root).currentRevision())?.hash;
    } else {
      throw new Error(`Accepted proposal ${proposalId} has unsupported duplicate-description artifact kind ${envelope.kind}.`);
    }
    if (currentRevisionHash !== artifactRevisionHash) {
      throw new Error(`Duplicate-description support proposal ${proposalId} is not the current accepted artifact revision.`);
    }

    const supportingAssertions = envelope.evidenceAssertions.filter(assertion =>
      assertion.relation === "supports"
      && assertion.target.artifactKind === envelope.kind
      && assertion.target.artifactId === artifactId
      && jsonPointerExists(envelope.payload, assertion.target.jsonPointer)
      && assertion.anchors.every(anchor => anchor.sourceId === sourceId));
    const verification = await verifier.verifyAssertions(supportingAssertions);
    if (!verification.valid) {
      throw new Error(`Duplicate-description support proposal ${proposalId} has invalid exact evidence: ${verification.issues.map(issue => issue.code).join(", ")}.`);
    }
    const supportedUnitIds = duplicateUnitIds.filter((unitId) => {
      const unit = unitAnchors.get(unitId);
      return Boolean(unit && supportingAssertions.some(assertion => assertion.anchors.some(anchor =>
        anchor.startByte < unit.endByte && unit.startByte < anchor.endByte)));
    });
    if (!supportedUnitIds.length) {
      throw new Error(`Duplicate-description support proposal ${proposalId} has no exact evidence overlapping the reviewed duplicate units.`);
    }
    supportedUnitIds.forEach(unitId => coveredUnitIds.add(unitId));
    const evidenceAssertionIds = supportingAssertions.filter(assertion => assertion.anchors.some(anchor =>
      supportedUnitIds.some(unitId => {
        const unit = unitAnchors.get(unitId)!;
        return anchor.startByte < unit.endByte && unit.startByte < anchor.endByte;
      }))).map(assertion => assertion.id).sort();
    if (new Set(evidenceAssertionIds).size !== evidenceAssertionIds.length) {
      throw new Error(`Duplicate-description support proposal ${proposalId} has duplicate evidence assertion IDs.`);
    }
    dependencies.push({
      proposalId,
      proposalHash: contentHash(raw),
      artifactKind: envelope.kind,
      artifactId,
      artifactRevisionHash,
      unitIds: supportedUnitIds,
      evidenceAssertionIds,
    });
  }
  const missing = duplicateUnitIds.filter(unitId => !coveredUnitIds.has(unitId));
  if (missing.length) {
    throw new Error(`Duplicate-description correction lacks exact accepted semantic support for units: ${missing.join(", ")}.`);
  }
  return dependencies;
}

async function readActiveAccountingProposals(
  accounting: SourceAccountingStore,
  sourceId: string,
  batchId: string,
): Promise<ActiveSourceAccountingProposal[]> {
  const summaries = (await accounting.listBatchProposals(sourceId, batchId))
    .filter((summary): summary is typeof summary & { status: "pending" | "accepted" } => summary.status !== "rejected");
  return Promise.all(summaries.map(async summary => ({
    proposal: await accounting.readProposal(sourceId, summary.status, summary.id),
    proposalStatus: summary.status,
  })));
}

async function readAccountingSemanticBaseline(
  root: string,
  sourceId: string,
  batchId: string,
  segments: readonly SourceSegment[],
): Promise<{ hash: string; spans: TextAnchor[]; inheritedSpans: TextAnchor[] }> {
  const world = new ProposalStore(root);
  const worldDependencies: Array<{ proposalId: string; hash: string }> = [];
  const worldAssertions: EvidenceAssertion[] = [];
  for (const summary of await world.list("pending", sourceId)) {
    const envelope = await world.readEnvelope("pending", summary.id);
    const origin = envelope.generatedBy as { compilerBatchId?: string } | undefined;
    if (origin?.compilerBatchId !== batchId) continue;
    worldDependencies.push({ proposalId: summary.id, hash: contentHash(envelope) });
    worldAssertions.push(...evidenceAssertionSchema.array().parse(envelope.evidenceAssertions ?? []));
  }
  const annotations = new SourceAnnotationStore(root);
  const annotationDependencies: Array<{ proposalId: string; status: string; hash: string }> = [];
  const annotationSpans: TextAnchor[] = [];
  for (const summary of await annotations.listBatchProposals(sourceId, batchId)) {
    let status: "pending" | "accepted" = "pending";
    const proposal = await annotations.readProposal(sourceId, status, summary.id).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      status = "accepted";
      return annotations.readProposal(sourceId, status, summary.id);
    });
    annotationDependencies.push({ proposalId: summary.id, status, hash: contentHash(proposal) });
    annotationSpans.push(...annotationAnchors(proposal.payload));
  }
  const inherited = await readPriorStageAccountingCoverage(root, sourceId, batchId, segments);
  const inheritedSpans = [
    ...inherited.assertions.flatMap(item => item.anchors),
    ...inherited.annotations.flatMap(item => item.anchors),
  ];
  return {
    hash: contentHash({
      worldDependencies: worldDependencies.sort((left, right) => left.proposalId.localeCompare(right.proposalId)),
      annotationDependencies: annotationDependencies.sort((left, right) => left.proposalId.localeCompare(right.proposalId)),
      inherited,
    }),
    spans: [
      ...inheritedSpans,
      ...worldAssertions.flatMap(item => item.anchors),
      ...annotationSpans,
    ],
    inheritedSpans,
  };
}

function accountingFailureUnitIds(
  root: string,
  sourceId: string,
  batchId: string,
  history: readonly ProposalAttempt[],
): string[] {
  const lastResolution = history.findLastIndex(item => item.status === "succeeded" || item.status === "unsupported");
  const failed = [...new Map(history.slice(lastResolution + 1)
    .filter(item => item.status === "failed")
    .map(item => [item.inputHash, item])).values()];
  const unitIds = new Set<string>();
  for (const attempt of failed) {
    const input = z.record(z.string(), z.unknown()).parse(attempt.input);
    if (typeof input.page_token === "string") {
      const page = new CompilerAccountingPages(root, sourceId, batchId).read(input.page_token);
      if (!page) throw new Error(`Predecessor accounting page ${input.page_token} is missing.`);
      page.unitIds.forEach(id => unitIds.add(id));
      continue;
    }
    if (!Array.isArray(input.decisions) || input.decisions.length === 0) {
      throw new Error("Predecessor accounting failure has no unambiguous nonempty unit scope.");
    }
    for (const decision of input.decisions) {
      unitIds.add(z.object({ unit_id: idSchema }).passthrough().parse(decision).unit_id);
    }
  }
  if (!unitIds.size) throw new Error("Predecessor accounting failure has no bounded unit scope.");
  return [...unitIds].sort();
}

async function readVerifiedRefinementProposal(
  root: string,
  binding: AccountingRefinementCorrection,
  input: z.infer<typeof accountingRefinementInputSchema>,
): Promise<SourceAccountingProposal> {
  const accounting = new SourceAccountingStore(root);
  let proposal: SourceAccountingProposal;
  try {
    proposal = await accounting.readProposal(binding.sourceId, "pending", binding.proposalId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error("Host accounting refinement has no exact pending output; interrupted or accepted output requires separate inspection.");
  }
  if (sourceAccountingProposalIdentityHash(proposal) !== binding.proposalIdentityHash) {
    throw new Error("Host accounting refinement output differs from the reviewed proposal identity.");
  }
  const page = new CompilerAccountingPages(root, binding.sourceId, binding.batchId).read(input.page_token);
  if (!page || (page.consumedBy && page.consumedBy !== binding.proposalId)) {
    throw new Error("Host accounting refinement page receipt has ambiguous consumption state.");
  }
  return proposal;
}

async function settleAccountingRefinementPredecessors(
  root: string,
  options: AccountingRefinementReviewOptions,
  binding: AccountingRefinementCorrection,
): Promise<{ proofs: AccountingCoverageProof[]; changed: boolean }> {
  const journal = new CompilerProposalObligations(root, options.sourceId, options.batchId);
  const proofs: AccountingCoverageProof[] = [];
  let changed = false;
  for (const settlement of binding.settlementObligations) {
    const history = journal.history("account_source_units", settlement.proposalId);
    const last = history.at(-1);
    if (last?.status === "superseded-by-coverage") {
      if (!last.coverageProof || accountingCoverageProofFailure(root, last.coverageProof)
        || last.hostReview?.reason !== options.reason || last.hostReview.auditRef !== options.auditRef) {
        throw new Error(`Predecessor settlement ${settlement.proposalId} changed or has a different review identity.`);
      }
      proofs.push(last.coverageProof);
      continue;
    }
    if (contentHash(history) !== settlement.historyHash) {
      throw new Error(`Predecessor accounting obligation ${settlement.proposalId} changed after preview.`);
    }
    const { proof } = await buildAccountingCoverageProof(root, {
      sourceId: options.sourceId,
      batchId: options.batchId,
      proposalId: settlement.proposalId,
      reason: options.reason,
      auditRef: options.auditRef,
    });
    journal.recordCoverageSettlement(proof, options.reason, options.auditRef);
    proofs.push(proof);
    changed = true;
  }
  return { proofs, changed };
}

async function recoverAccountingRefinement(
  root: string,
  options: AccountingRefinementReviewOptions,
  bindingInput: AccountingRefinementCorrection,
  completeRunning: boolean,
): Promise<AccountingRefinementResult> {
  const binding = accountingRefinementCorrectionSchema.parse(bindingInput);
  if (binding.sourceId !== options.sourceId || binding.batchId !== options.batchId
    || binding.proposalId !== options.proposalId
    || CompilerProposalObligations.identity("account_source_units", options.correctedInput).inputHash !== binding.inputHash) {
    throw new Error("Retained host accounting refinement source, batch, proposal, or corrected input changed.");
  }
  if (contentHash([...options.settleProposalIds].sort())
    !== contentHash(binding.settlementObligations.map(item => item.proposalId).sort())) {
    throw new Error("Retained host accounting refinement settlement scope changed.");
  }
  if (contentHash([...options.duplicateSupportProposalIds].sort())
    !== contentHash(binding.duplicateSupportDependencies.map(item => item.proposalId).sort())) {
    throw new Error("Retained host accounting refinement semantic support scope changed.");
  }
  const source = await WorkspaceStore.openReadOnly(root).getSource(options.sourceId);
  const structure = await new SourceStructureStore(root).read(options.sourceId);
  const segments = await readAccountingBatchSegments(root, options.sourceId, options.batchId);
  const progress = await new CompilerBatchStore(root).read(options.sourceId);
  if (!source || source.contentSha256 !== binding.sourceSha256 || !structure
    || contentHash(structure) !== binding.structureHash
    || contentHash(segments.map(segment => segment.id).sort()) !== contentHash(binding.batchSegmentIds)
    || contentHash(progress) !== binding.batchProgressHash || progress.completedBatchIds.includes(options.batchId)
    || await new CompilerFinishReceipts(root, options.sourceId, options.batchId).read()) {
    throw new Error("Retained host accounting refinement source, scope, checkpoint, or finish baseline changed.");
  }
  const semantic = await readAccountingSemanticBaseline(root, options.sourceId, options.batchId, segments);
  if (semantic.hash !== binding.semanticBaselineHash) {
    throw new Error("Retained host accounting refinement semantic coverage changed.");
  }
  const accounting = new SourceAccountingStore(root);
  const activeAccounting = await readActiveAccountingProposals(accounting, options.sourceId, options.batchId);
  const baselineAccountingGraphHash = contentHash(activeAccounting
    .filter(item => item.proposal.id !== binding.proposalId)
    .map(item => ({ status: item.proposalStatus, proposal: item.proposal }))
    .sort((left, right) => left.proposal.id.localeCompare(right.proposal.id)));
  if (baselineAccountingGraphHash !== binding.activeAccountingGraphHash) {
    throw new Error("Retained host accounting refinement active accounting graph changed.");
  }
  for (const prior of binding.predecessorDecisions) {
    const proposal = await accounting.readProposal(options.sourceId, "pending", prior.proposalId).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return accounting.readProposal(options.sourceId, "accepted", prior.proposalId);
    });
    if (contentHash(proposal) !== prior.proposalHash) throw new Error(`Accounting predecessor ${prior.proposalId} changed.`);
  }
  const journal = new CompilerProposalObligations(root, options.sourceId, options.batchId);
  const history = journal.history("account_source_units", options.proposalId);
  const input = accountingRefinementInputSchema.parse(history.findLast(item => item.inputHash === binding.inputHash)?.input);
  const proposal = await readVerifiedRefinementProposal(root, binding, input);
  const pageStore = new CompilerAccountingPages(root, options.sourceId, options.batchId);
  const replayPage = pageStore.read(input.page_token);
  if (!replayPage) throw new Error("Retained host accounting refinement page receipt is missing.");
  for (const receipt of binding.pageReceipts) {
    const page = pageStore.read(receipt.token);
    if (!page) throw new Error(`Retained host accounting refinement page receipt ${receipt.token} is missing.`);
    if (page.consumedBy && (receipt.token !== replayPage.token || page.consumedBy !== binding.proposalId)) {
      throw new Error(`Retained host accounting refinement page receipt ${receipt.token} has ambiguous consumption state.`);
    }
    const { consumedBy: _consumedBy, ...unconsumedPage } = page;
    if (contentHash(unconsumedPage) !== receipt.hash) {
      throw new Error(`Retained host accounting refinement page receipt ${receipt.token} changed outside its expected consumption marker.`);
    }
  }
  const unitsById = new Map(baseStructuralUnits(structure).map(unit => [unit.id, unit]));
  const duplicateSupportDependencies = await readDuplicateSupportDependencies(
    root,
    options.sourceId,
    proposal.decisions,
    new Map([...unitsById].map(([unitId, unit]) => [unitId, unit.anchor])),
    options.duplicateSupportProposalIds,
  );
  if (contentHash(duplicateSupportDependencies) !== contentHash(binding.duplicateSupportDependencies)) {
    throw new Error("Retained host accounting refinement accepted semantic support changed after preview.");
  }
  if (completeRunning) {
    if (!replayPage.consumedBy) pageStore.consume(replayPage.token, binding.proposalId);
    else if (replayPage.consumedBy !== binding.proposalId) throw new Error("Retained accounting page was consumed by another proposal.");
    journal.completeInterruptedHostAccountingRefinement(input, binding, options.reason, options.auditRef);
  } else if (replayPage.consumedBy !== binding.proposalId) {
    throw new Error("Completed host accounting refinement lacks its exact consumed page receipt.");
  }
  const unresolvedSettlement = binding.settlementObligations.some(settlement =>
    journal.unresolved().some(item => item.tool === "account_source_units" && item.proposalId === settlement.proposalId));
  if (!completeRunning && !unresolvedSettlement) {
    throw new Error("The reviewed host accounting refinement grant was already consumed.");
  }
  const settlements = await settleAccountingRefinementPredecessors(root, options, binding);
  const bytes = await new SourceMaterialStore().read(source);
  if (!bytes) throw new Error("Retained source bytes are missing.");
  return {
    status: "recovered",
    executableCertification: false,
    authorityHash: binding.authorityHash,
    binding,
    input,
    batchSegmentIds: [...binding.batchSegmentIds],
    units: proposal.decisions.map(decision => {
      const unit = unitsById.get(decision.unitId);
      const prior = binding.predecessorDecisions.find(item => item.unitId === decision.unitId);
      if (!unit || !prior) throw new Error(`Retained accounting refinement unit ${decision.unitId} changed.`);
      return {
        unitId: decision.unitId,
        startByte: unit.anchor.startByte,
        endByte: unit.anchor.endByte,
        text: bytes.subarray(unit.anchor.startByte, unit.anchor.endByte).toString("utf8"),
        proposedStatus: decision.status,
        proposedReason: decision.reason,
        predecessorProposalId: prior.proposalId,
        predecessorStatus: prior.status,
      };
    }),
    proposal,
    settlements: settlements.proofs,
  };
}

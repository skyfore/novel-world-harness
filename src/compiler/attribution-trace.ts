import { assessExpressionObjectSupport } from "./expression-content.js";
import { propositionSchema, type Proposition } from "../world/model.js";
import { assessQuotationContentSupport } from "./content-support.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import {
  attributionSchema,
  idSchema,
  type Attribution,
  type EvidenceRef,
  type KnowledgeDelta,
  type EvidenceAssertion,
  evidenceAssertionSchema,
} from "../world/model.js";
import { EvidenceAssertionStore } from "./evidence-assertions.js";
import { findKnowledgeDeltas } from "../world/knowledge-semantics.js";
import { assertEvidenceExclusiveToSource } from "../world/source-scope.js";
import {
  SourceAnnotationStore,
  quotationSchema,
  type Quotation,
} from "./annotations.js";
import {
  EntityResolutionStore,
  type IdentityResolution,
} from "./entity-resolution.js";

type AttributionTraceCatalog = {
  quotations: ReadonlyMap<string, Quotation>;
  resolutions: ReadonlyMap<string, IdentityResolution>;
};

export async function validateAttributionProposalTrace(
  workspaceRoot: string,
  sourceIdInput: string,
  worldProposalIds: readonly string[],
  annotationProposalIds: readonly string[],
  resolutionProposalIds: readonly string[],
): Promise<string[]> {
  const sourceId = idSchema.parse(sourceIdInput);
  const [catalog, attributions] = await Promise.all([
    loadTraceCatalog(workspaceRoot, sourceId, annotationProposalIds, resolutionProposalIds),
    loadAttributionCatalog(workspaceRoot, sourceId, worldProposalIds, true),
  ]);
  const issues: string[] = [];
  for (const attribution of attributions.all.values()) {
    issues.push(...attributionQuotationTraceIssues(attribution, sourceId, catalog));
    const content = await loadPropositionContent(workspaceRoot, attribution.propositionId, worldProposalIds);
    issues.push(...attributionContentTraceIssues(attribution, content.assertions, catalog.quotations, content.propositions));
  }
  return [...new Set(issues)].sort();
}

export async function validateKnowledgeAcquisitionProposalTrace(
  workspaceRoot: string,
  sourceIdInput: string,
  worldProposalIds: readonly string[],
  annotationProposalIds: readonly string[],
  resolutionProposalIds: readonly string[],
): Promise<string[]> {
  const sourceId = idSchema.parse(sourceIdInput);
  const [catalog, attributions] = await Promise.all([
    loadTraceCatalog(workspaceRoot, sourceId, annotationProposalIds, resolutionProposalIds),
    loadAttributionCatalog(workspaceRoot, sourceId, worldProposalIds, true),
  ]);
  const proposals = new ProposalStore(workspaceRoot);
  const issues: string[] = [];
  for (const proposalId of uniqueIds(worldProposalIds)) {
    let envelope: Record<string, unknown>;
    try {
      envelope = await proposals.readEnvelope("pending", proposalId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    for (const located of findKnowledgeDeltas(envelope.payload)) {
      issues.push(...knowledgeAcquisitionTraceIssues(
        located.delta,
        located.path || "payload",
        attributions.all,
        catalog,
      ).map((message) => `${proposalId}: ${message}`));
    }
  }
  return [...new Set(issues)].sort();
}

export async function validateCommittedAttributionTrace(
  workspaceRoot: string,
  sourceIdInput: string,
  attributionInput: Attribution,
): Promise<string[]> {
  const sourceId = idSchema.parse(sourceIdInput);
  const attribution = attributionSchema.parse(attributionInput);
  const catalog = await loadTraceCatalog(workspaceRoot, sourceId);
  const content = await loadPropositionContent(workspaceRoot, attribution.propositionId);
  return [...attributionQuotationTraceIssues(attribution, sourceId, catalog),
    ...attributionContentTraceIssues(attribution, content.assertions, catalog.quotations, content.propositions)];
}

/** Exact object evidence must be supported by the cited discourse, not merely the same segment. */
export function attributionContentTraceIssues(attribution: Attribution, assertions: readonly EvidenceAssertion[], quotations: ReadonlyMap<string, Quotation>, propositions?: ReadonlyMap<string, Proposition>): string[] {
  if (!attribution.quotationIds?.length) return [];
  const content = assertions.filter(a => a.target.artifactKind === "proposition" && a.target.artifactId === attribution.propositionId
    && (a.target.jsonPointer === "/object" || a.target.jsonPointer.startsWith("/object/")) && a.relation === "supports");
  // Retain legacy readability, not certification. Once object evidence exists,
  // structural-only selectors cannot be used as a substitute for its content.
  if (!content.length) return [];
  const cited = attribution.quotationIds.flatMap(id => { const q = quotations.get(id); return q ? [q.anchor] : []; });
  const expression = propositions ? assessExpressionObjectSupport(attribution.propositionId, propositions, assertions, cited) : undefined;
  const assessment = expression ? { status: expression.status, missingPaths: expression.objects.flatMap(item => item.missingPaths.map(path => `${item.propositionId}${path}`)).concat(expression.issues.filter(item => !item.code.startsWith("EXPRESSION_CONTENT_")).map(item => `${item.code}:${item.propositionId}`)) } : assessQuotationContentSupport(attribution.propositionId, content, cited);
  const defectiveId = expression?.issues[0]?.propositionId ?? attribution.propositionId;
  const expansionStopped = expression?.issues.some(issue => issue.code === "EXPRESSION_PROPOSITION_CYCLE" || issue.code === "EXPRESSION_EXPANSION_LIMIT");
  if (expansionStopped) return [`Attribution ${attribution.id}: proposition ${defectiveId} content expansion stopped (${expression!.issues.map(issue => issue.code).join(", ")}). Preserve drafts and stop for host graph review; do not retry, increase expansion limits, remove references, or guess replacement IDs.`];
  return assessment.status === "supported" ? [] : [`Attribution ${attribution.id}: proposition ${attribution.propositionId} object evidence is outside its cited quotation content or lacks content-bearing support (${assessment.status}: ${assessment.missingPaths.join(", ")}). The defective dependency is proposition ${defectiveId} at /object (or its child pointer), not the attribution evidence. Inspect and correct that proposition content selector; changing attribution /propositionId, /holderEntityId or /quotationIds selectors cannot repair it. Read the proposition evidence with same-source find_compiler_artifacts (kind proposition), copying results[].readArguments.ref into read_compiler_artifact.ref; copy payload.id only when a logical ID is required. Discover the exact quotation with same-source find_source_annotations (annotation_type quotation), copying results[].readArguments.ref into read_source_annotation.ref. A shared segment or speaker is insufficient. Correct the named trace once only when source supports it; if a quotation revision or wider authority is needed, preserve drafts and stop for host source review. Do not remove content assertions, change acquisition mode, or substitute IDs to bypass this check.`];
}

async function loadPropositionContent(root: string, rootId: string, proposalIds: readonly string[] = []) {
  const pending = new Map<string, { payload: Proposition; assertions: EvidenceAssertion[] }>();
  const store = new ProposalStore(root), canonical = new CanonicalModelStore(root), exact = new EvidenceAssertionStore(root);
  for (const id of proposalIds) {
    const envelope = await store.readEnvelope("pending", id).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (envelope?.kind !== "proposition") continue;
    const payload = propositionSchema.parse(envelope.payload);
    if (pending.has(payload.id)) continue;
    pending.set(payload.id, { payload, assertions: evidenceAssertionSchema.array().parse(envelope.evidenceAssertions ?? []) });
  }
  const propositions = new Map<string, Proposition>(), assertions: EvidenceAssertion[] = [], seen = new Set<string>();
  let id: string | undefined = rootId;
  // At most one child per current object variant. A 33rd record lets the
  // deterministic assessor report its own depth bound rather than guess.
  while (id && !seen.has(id) && seen.size < 33) {
    seen.add(id);
    const staged = pending.get(id);
    const payload: Proposition | undefined = staged?.payload ?? await canonical.getProposition(id).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!payload) break;
    propositions.set(id, payload);
    assertions.push(...(staged?.assertions ?? await exact.listForArtifact("proposition", id)));
    id = payload.object.kind === "proposition" ? payload.object.propositionId : undefined;
  }
  return { propositions, assertions };
}

export async function validateCommittedKnowledgeAcquisitionTrace(
  workspaceRoot: string,
  sourceIdInput: string,
  deltas: readonly { path: string; delta: KnowledgeDelta }[],
): Promise<string[]> {
  const sourceId = idSchema.parse(sourceIdInput);
  const [catalog, attributions] = await Promise.all([
    loadTraceCatalog(workspaceRoot, sourceId),
    loadAttributionCatalog(workspaceRoot, sourceId, [], true),
  ]);
  return [...new Set(deltas.flatMap(({ path, delta }) =>
    knowledgeAcquisitionTraceIssues(delta, path, attributions.all, catalog)))].sort();
}

function attributionQuotationTraceIssues(
  attribution: Attribution,
  sourceId: string,
  catalog: AttributionTraceCatalog,
): string[] {
  if (!attribution.quotationIds?.length) return [];
  const issues: string[] = [];
  for (const quotationId of attribution.quotationIds) {
    const quotation = catalog.quotations.get(quotationId);
    if (!quotation) {
      issues.push(`Attribution ${attribution.id} references unknown quotation '${quotationId}'.`);
      continue;
    }
    if (!attribution.evidence.some((reference) => evidenceContainsAnchor(reference, quotation.anchor))) {
      issues.push(`Attribution ${attribution.id} evidence does not contain quotation '${quotationId}'.`);
    }
    const speakerMentionId = quotation.speakerMentionId;
    if (attribution.holderKind === "narrator") {
      if (speakerMentionId) {
        issues.push(`Narrator attribution ${attribution.id} cannot cite quotation '${quotationId}' with speaker mention '${speakerMentionId}'.`);
      }
      continue;
    }
    if (attribution.holderKind === "unknown") {
      if (speakerMentionId && selectedEntityId(catalog.resolutions.get(speakerMentionId))) {
        issues.push(`Unknown-holder attribution ${attribution.id} cites quotation '${quotationId}' whose speaker is already resolved.`);
      }
      continue;
    }
    // A document is the containing information source, not a speaking actor.
    // Its quotation may therefore have no speaker or may quote another actor;
    // document identity is already validated through holderEntityId.
    if (attribution.holderKind === "document") continue;
    if (!speakerMentionId) {
      issues.push(`${attribution.holderKind} attribution ${attribution.id} cites quotation '${quotationId}' without a speaker mention.`);
      continue;
    }
    const resolved = selectedEntityId(catalog.resolutions.get(speakerMentionId));
    if (!resolved) {
      issues.push(`Attribution ${attribution.id} quotation '${quotationId}' speaker mention '${speakerMentionId}' is not resolved.`);
    } else if (resolved !== attribution.holderEntityId) {
      issues.push(`Attribution ${attribution.id} holder '${attribution.holderEntityId}' does not match quotation '${quotationId}' speaker '${resolved}'.`);
    }
  }
  return issues;
}

function knowledgeAcquisitionTraceIssues(
  delta: KnowledgeDelta,
  path: string,
  attributions: ReadonlyMap<string, Attribution>,
  catalog: AttributionTraceCatalog,
): string[] {
  const issues: string[] = [];
  for (let index = 0; index < delta.operations.length; index += 1) {
    const operation = delta.operations[index]!;
    if (operation.op !== "learn" || !operation.acquisitionMode) continue;
    if (operation.acquisitionMode !== "told" && operation.acquisitionMode !== "read") continue;
    const operationPath = `${path}.operations.${index}`;
    const attribution = operation.attributionId ? attributions.get(operation.attributionId) : undefined;
    if (!attribution) continue;
    if (!attribution.quotationIds?.length) {
      issues.push(`${operationPath}: ${operation.acquisitionMode} acquisition requires attribution '${attribution.id}' to cite a quotation.`);
      continue;
    }
    if (operation.acquisitionMode !== "told") continue;
    const addressed = attribution.quotationIds.some((quotationId) => {
      const quotation = catalog.quotations.get(quotationId);
      return quotation?.addresseeMentionIds.some((mentionId) =>
        selectedEntityId(catalog.resolutions.get(mentionId)) === operation.actorId) ?? false;
    });
    if (!addressed) {
      issues.push(`${operationPath}: told acquisition actor '${operation.actorId}' is not a resolved addressee of attribution '${attribution.id}'.`);
    }
  }
  return issues;
}

async function loadTraceCatalog(
  workspaceRoot: string,
  sourceId: string,
  annotationProposalIds: readonly string[] = [],
  resolutionProposalIds: readonly string[] = [],
): Promise<AttributionTraceCatalog> {
  const annotations = new SourceAnnotationStore(workspaceRoot);
  const resolutions = new EntityResolutionStore(workspaceRoot);
  const quotationCatalog = new Map(
    (await annotations.list(sourceId, "quotation"))
      .map((value) => {
        const quotation = quotationSchema.parse(value);
        return [quotation.id, quotation] as const;
      }),
  );
  for (const proposalId of uniqueIds(annotationProposalIds)) {
    const proposal = await readActiveAnnotationProposal(annotations, sourceId, proposalId);
    if (proposal.payload.annotationType !== "quotation") continue;
    const quotation = quotationSchema.parse(proposal.payload);
    quotationCatalog.set(quotation.id, quotation);
  }
  const resolutionCatalog = new Map(
    (await resolutions.list(sourceId)).map((resolution) => [resolution.mentionId, resolution]),
  );
  for (const proposalId of uniqueIds(resolutionProposalIds)) {
    const proposal = await readActiveResolutionProposal(resolutions, sourceId, proposalId);
    resolutionCatalog.set(proposal.payload.mentionId, proposal.payload);
  }
  return { quotations: quotationCatalog, resolutions: resolutionCatalog };
}

async function loadAttributionCatalog(
  workspaceRoot: string,
  sourceId: string,
  worldProposalIds: readonly string[],
  includeCanonical: boolean,
): Promise<{ selected: Map<string, Attribution>; all: Map<string, Attribution> }> {
  const canonical = new Map<string, Attribution>();
  if (includeCanonical) {
    for (const attribution of await new CanonicalModelStore(workspaceRoot).listAttributions()) {
      if (!attribution.evidence.some((reference) => reference.span.sourceId === sourceId)) continue;
      assertEvidenceExclusiveToSource(attribution.evidence, sourceId, `Canonical attribution ${attribution.id}`);
      canonical.set(attribution.id, attribution);
    }
  }
  const selected = new Map<string, Attribution>();
  const proposals = new ProposalStore(workspaceRoot);
  for (const proposalId of uniqueIds(worldProposalIds)) {
    let envelope: Record<string, unknown>;
    try {
      envelope = await proposals.readEnvelope("pending", proposalId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    if (envelope.kind !== "attribution") continue;
    const attribution = attributionSchema.parse(envelope.payload);
    assertEvidenceExclusiveToSource(attribution.evidence, sourceId, `Attribution proposal ${proposalId}`);
    selected.set(attribution.id, attribution);
  }
  return { selected, all: new Map([...canonical, ...selected]) };
}

async function readActiveAnnotationProposal(
  store: SourceAnnotationStore,
  sourceId: string,
  proposalId: string,
) {
  try {
    return await store.readProposal(sourceId, "pending", proposalId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return store.readProposal(sourceId, "accepted", proposalId);
  }
}

async function readActiveResolutionProposal(
  store: EntityResolutionStore,
  sourceId: string,
  proposalId: string,
) {
  try {
    return await store.readProposal(sourceId, "pending", proposalId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return store.readProposal(sourceId, "accepted", proposalId);
  }
}

function selectedEntityId(resolution: IdentityResolution | undefined): string | undefined {
  return resolution && (resolution.status === "resolved" || resolution.status === "new-entity" || resolution.status === "misidentified")
    ? resolution.entityId
    : undefined;
}

function evidenceContainsAnchor(reference: EvidenceRef, anchor: Quotation["anchor"]): boolean {
  if (reference.span.sourceId !== anchor.sourceId) return false;
  if (reference.span.startByte !== undefined && reference.span.endByte !== undefined) {
    return reference.span.startByte <= anchor.startByte && reference.span.endByte >= anchor.endByte;
  }
  return reference.span.startLine <= anchor.startLine && reference.span.endLine >= anchor.endLine;
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => idSchema.parse(value)))].sort();
}

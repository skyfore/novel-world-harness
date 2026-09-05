import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import {
  attributionSchema,
  idSchema,
  type Attribution,
  type EvidenceRef,
  type KnowledgeDelta,
} from "../world/model.js";
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
    loadAttributionCatalog(workspaceRoot, sourceId, worldProposalIds, false),
  ]);
  const issues: string[] = [];
  for (const attribution of attributions.selected.values()) {
    issues.push(...attributionQuotationTraceIssues(attribution, sourceId, catalog));
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
  return attributionQuotationTraceIssues(
    attribution,
    sourceId,
    await loadTraceCatalog(workspaceRoot, sourceId),
  );
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

import { evidenceAssertionSchema, type EvidenceAssertion, type TextAnchor } from "../world/model.js";
import { SourceAnnotationStore, annotationAnchors } from "./annotations.js";
import { CompilerBatchStore } from "./batch-progress.js";
import { CompilerProposalService, compilerProposalLogicalIdentity, type CompilerProposalKind } from "./proposals.js";
import type { SourceSegment } from "./segments.js";

export type AccountingCoverage = {
  assertions: EvidenceAssertion[];
  annotations: Array<{ id: string; anchors: TextAnchor[] }>;
};

/** Evidence coverage only. A checkpointed semantic proposal is not world truth
 * and an observed mention never proves that an executable mechanism exists. */
export async function readPriorStageAccountingCoverage(
  root: string, sourceId: string, batchId: string, segments: readonly SourceSegment[],
): Promise<AccountingCoverage> {
  const coverage: AccountingCoverage = { assertions: [], annotations: [] };
  if (!batchId.startsWith(`batch-${sourceId}-`) || !/-\d{5}-executable-[a-f0-9]+$/.test(batchId)) return coverage;
  const completed = new Set((await new CompilerBatchStore(root).read(sourceId)).completedBatchIds);
  const priorIds = new Set([batchId.replace("-executable-", "-observation-"), batchId.replace("-executable-", "-semantic-")]
    .filter((id) => completed.has(id)));
  const inScope = (anchor: TextAnchor) => anchor.sourceId === sourceId && segments.some((segment) =>
    segment.sourceId === sourceId && anchor.startByte >= segment.startByte && anchor.endByte <= segment.endByte);
  // Follow current refs, never historical/rejected annotation revisions.
  for (const annotation of await new SourceAnnotationStore(root).list(sourceId)) {
    if (!priorIds.has(annotation.derivation.compilerBatchId ?? "") || annotation.annotationType === "discourse-segment") continue;
    const anchors = annotationAnchors(annotation).filter(inScope);
    if (anchors.length) coverage.annotations.push({ id: annotation.id, anchors });
  }
  const store = new CompilerProposalService(root).store;
  const pending = await store.list("pending");
  const envelopes = await Promise.all(pending.map((item) => store.readEnvelope("pending", item.id)));
  const identities = envelopes.map((item, index) => compilerProposalLogicalIdentity(pending[index]!.kind as CompilerProposalKind, item.payload));
  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = envelopes[index]!;
    const origin = envelope.generatedBy as { compilerBatchId?: string } | undefined;
    if (!priorIds.has(origin?.compilerBatchId ?? "")) continue;
    // An ambiguous/superseded logical artifact is not coverage. Retain the
    // closure diagnostic rather than picking a replacement by timestamp.
    const identity = identities[index];
    if (identity && identities.filter((other) => other === identity).length !== 1) continue;
    for (const assertion of evidenceAssertionSchema.array().parse(envelope.evidenceAssertions ?? [])) {
      const anchors = assertion.anchors.filter(inScope);
      if (anchors.length) coverage.assertions.push({ ...assertion, anchors });
    }
  }
  return coverage;
}

import { contentHash } from "../world/canonical.js";
import { ProposalStore } from "../world/canonical-model.js";
import { utteranceExpressionSchema, type UtteranceExpression } from "../world/utterance-expression.js";
import type { ValidationIssue } from "../world/model.js";
import { EvidenceVerifier } from "./evidence.js";
import { loadTraceCatalog, type AttributionTraceCatalog } from "./attribution-trace.js";

const recovery = "Discover the same-source quotation with find_source_annotations (annotation_type quotation); copy results[].readArguments.ref into read_source_annotation.ref. Discover canonical dependencies with same-source find_compiler_artifacts; copy results[].readArguments.ref into read_compiler_artifact.ref and use payload.id only for logical IDs. Copy payload.id into the corresponding logical quotation/proposition field. Read semanticHash and payload for diagnosis; the host freezes revisions, anchors and snapshots. Do not submit or guess hashes. Correct this draft once only if current source evidence supports it. If annotation or identity authority must change, preserve drafts and stop for host source review; do not retry unchanged or remove evidence to bypass validation.";

/** Also used with the prepared bundle's frozen annotations/resolutions. */
export async function validateUtteranceExpressionTrace(
  workspaceRoot: string, expression: UtteranceExpression, catalog?: AttributionTraceCatalog,
): Promise<ValidationIssue[]> {
  const sourceId = expression.quotation.anchor.sourceId;
  const trace = catalog ?? await loadTraceCatalog(workspaceRoot, sourceId);
  const issues: ValidationIssue[] = [];
  const fail = (code: string, message: string, path: string) => issues.push({ code, message: `${message} ${recovery}`, path });
  const quotation = trace.quotations.get(expression.quotation.quotationId);
  if (!quotation || quotation.sourceId !== sourceId || contentHash(quotation) !== expression.quotation.revisionHash
    || contentHash(quotation.anchor) !== contentHash(expression.quotation.anchor)) {
    fail("EXPRESSION_QUOTATION_REVISION_MISMATCH", "Expression requires the exact current quotation revision and anchor.", "quotation");
  } else {
    const resolved = (mentionId: string | undefined) => {
      const resolution = mentionId ? trace.resolutions.get(mentionId) : undefined;
      return resolution && resolution.sourceId === sourceId
        && ["resolved", "new-entity", "misidentified"].includes(resolution.status) && "entityId" in resolution
        ? resolution.entityId : undefined;
    };
    if (resolved(quotation.speakerMentionId) !== expression.speakerId) fail("EXPRESSION_SPEAKER_TRACE_MISMATCH", "Expression speaker must match this quotation's resolved speaker mention.", "speakerId");
    const addressees = quotation.addresseeMentionIds.map(resolved);
    if (addressees.some(id => !id) || new Set(addressees).size !== expression.addresseeIds.length
      || expression.addresseeIds.some(id => !addressees.includes(id))) {
      fail("EXPRESSION_ADDRESSEE_TRACE_MISMATCH", "Expression addressees must exactly match this quotation's resolved addressee mentions.", "addresseeIds");
    }
  }
  const verifier = new EvidenceVerifier(workspaceRoot);
  for (const [index, anchor] of [expression.quotation.anchor, ...expression.fragments.map(item => item.anchor)].entries()) {
    const inspection = await verifier.inspectAnchor(anchor);
    for (const issue of inspection.issues) fail(issue.code, issue.message, index === 0 ? "quotation.anchor" : `fragments.${index - 1}.anchor`);
    if (index > 0 && inspection.excerpt !== expression.fragments[index - 1]!.text) fail("EXPRESSION_FRAGMENT_BYTES_MISMATCH", "Expression fragment differs from immutable source bytes.", `fragments.${index - 1}.text`);
  }
  return issues;
}

export async function validateUtteranceExpressionProposalTrace(
  workspaceRoot: string, sourceId: string, worldProposalIds: readonly string[], annotationProposalIds: readonly string[], resolutionProposalIds: readonly string[],
): Promise<string[]> {
  const catalog = await loadTraceCatalog(workspaceRoot, sourceId, annotationProposalIds, resolutionProposalIds);
  const store = new ProposalStore(workspaceRoot);
  const issues: string[] = [];
  for (const id of [...new Set(worldProposalIds)]) {
    let proposal: Record<string, unknown>;
    try { proposal = await store.readEnvelope("pending", id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (proposal.kind !== "utterance-expression") continue;
    const expression = utteranceExpressionSchema.parse(proposal.payload);
    if (expression.quotation.anchor.sourceId !== sourceId) issues.push(`${id}: EXPRESSION_SOURCE_MISMATCH. ${recovery}`);
    issues.push(...(await validateUtteranceExpressionTrace(workspaceRoot, expression, catalog)).map(issue => `${id}: ${issue.code}: ${issue.message}`));
  }
  return issues;
}

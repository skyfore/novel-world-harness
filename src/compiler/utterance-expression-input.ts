import { z } from "zod";
import { idSchema, propositionSchema, type EvidenceRef } from "../world/model.js";
import { contentHash } from "../world/canonical.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { utteranceExpressionSchema } from "../world/utterance-expression.js";
import { loadTraceCatalog } from "./attribution-trace.js";
import { modelTextSelectorSchema, type ModelTextSelector } from "./text-anchors.js";
import type { TextAnchor } from "../world/model.js";

export const utteranceExpressionInputSchema = z.object({
  ontologyVersion: z.literal("utterance-expression-v1"), id: idSchema,
  canonicalEventId: idSchema, speakerId: idSchema, addresseeIds: z.array(idSchema).max(32),
  modality: z.enum(["speech", "writing", "thought"]), documentId: idSchema.optional(),
  quotation: z.object({ quotationId: idSchema }).strict(),
  fragments: z.array(modelTextSelectorSchema).min(1).max(32),
  propositionId: idSchema,
  propositions: z.array(z.object({ propositionId: idSchema }).strict()).min(1).max(128),
}).strict();

/** Hashes, raw-byte anchors and nested proposition evidence are exclusively host-owned. */
export async function hydrateUtteranceExpressionInput(workspaceRoot: string, sourceId: string, input: unknown,
  evidence: EvidenceRef[], worldProposalIds: readonly string[], annotationProposalIds: readonly string[],
  resolve: (selector: ModelTextSelector) => Promise<TextAnchor>) {
  const value = utteranceExpressionInputSchema.parse(input);
  const trace = await loadTraceCatalog(workspaceRoot, sourceId, annotationProposalIds);
  const quotation = trace.quotations.get(value.quotation.quotationId);
  if (!quotation) throw new Error("EXPRESSION_QUOTATION_MISSING: Use same-source find_source_annotations with annotation_type quotation; copy results[].readArguments.ref into read_source_annotation.ref and its payload.id into quotation.quotationId. Make at most one corrected retry; stop for host source review if absent. Do not guess or retry unchanged.");
  const canonical = new CanonicalModelStore(workspaceRoot), proposals = new ProposalStore(workspaceRoot);
  const catalog = new Map((await canonical.listPropositions()).map(item => [item.id, item]));
  for (const id of worldProposalIds) {
    const proposal = await proposals.readEnvelope("pending", id);
    if (proposal.kind === "proposition") { const item = propositionSchema.parse(proposal.payload); catalog.set(item.id, item); }
  }
  const frozen = value.propositions.map(item => {
    const snapshot = catalog.get(item.propositionId);
    if (!snapshot) throw new Error("EXPRESSION_PROPOSITION_MISSING: Use same-source find_compiler_artifacts with kind proposition; copy results[].readArguments.ref into read_compiler_artifact.ref and its payload.id into propositions[].propositionId. Make at most one corrected retry; stop for host compilation if absent. Do not guess or retry unchanged.");
    return { propositionId: snapshot.id, revisionHash: contentHash(snapshot), snapshot };
  });
  const fragments = await Promise.all(value.fragments.map(async selector => ({ anchor: await resolve(selector), text: selector.exact })));
  return utteranceExpressionSchema.parse({ ...value, evidence, fragments, propositions: frozen,
    quotation: { quotationId: quotation.id, revisionHash: contentHash(quotation), anchor: quotation.anchor } });
}

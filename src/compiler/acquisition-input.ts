import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { acquisitionInputSchema, acquisitionSchema, hydrateAcquisition, type AcquisitionCatalog } from "../world/acquisition.js";
import { propositionSchema, claimSchema, attributionSchema, canonicalEventSchema, entitySchema, type EvidenceRef } from "../world/model.js";
import { utteranceExpressionSchema } from "../world/utterance-expression.js";
import { perceptionObservationSchema } from "../world/perception-observation.js";

export async function hydrateAcquisitionInput(root: string, input: unknown, evidence: EvidenceRef[], proposalIds: readonly string[]) {
  const canon = new CanonicalModelStore(root), proposals = new ProposalStore(root);
  const catalog = {
    entities: new Map((await canon.listEntities()).map(item => [item.id, item])),
    events: new Map((await canon.listEvents()).map(item => [item.id, item])),
    claims: new Map((await canon.listClaims()).map(item => [item.id, item])),
    propositions: new Map((await canon.listPropositions()).map(item => [item.id, item])),
    attributions: new Map((await canon.listAttributions()).map(item => [item.id, item])),
    utteranceExpressions: new Map((await canon.listUtteranceExpressions()).map(item => [item.id, item])),
    perceptionObservations: new Map((await canon.listPerceptionObservations()).map(item => [item.id, item])),
    acquisitions: new Map((await canon.listAcquisitions()).map(item => [item.id, item])),
  } satisfies AcquisitionCatalog;
  for (const id of proposalIds) {
    const envelope = await proposals.readEnvelope("pending", id);
    if (envelope.kind === "entity") { const value = entitySchema.parse(envelope.payload); catalog.entities.set(value.id, value); }
    if (envelope.kind === "canonical-event") { const value = canonicalEventSchema.parse(envelope.payload); catalog.events.set(value.id, value); }
    if (envelope.kind === "claim") { const value = claimSchema.parse(envelope.payload); catalog.claims.set(value.id, value); }
    if (envelope.kind === "proposition") { const value = propositionSchema.parse(envelope.payload); catalog.propositions.set(value.id, value); }
    if (envelope.kind === "attribution") { const value = attributionSchema.parse(envelope.payload); catalog.attributions.set(value.id, value); }
    if (envelope.kind === "utterance-expression") { const value = utteranceExpressionSchema.parse(envelope.payload); catalog.utteranceExpressions.set(value.id, value); }
    if (envelope.kind === "perception-observation") { const value = perceptionObservationSchema.parse(envelope.payload); catalog.perceptionObservations.set(value.id, value); }
    if (envelope.kind === "acquisition") { const value = acquisitionSchema.parse(envelope.payload); catalog.acquisitions.set(value.id, value); }
  }
  const parsed = acquisitionInputSchema.parse(input), event = catalog.events.get(parsed.canonicalEventId);
  if (!event || !event.evidence.length || event.evidence.some(ref => !evidence.some(selected => selected.span.sourceId === ref.span.sourceId))) throw new Error("ACQUISITION_OCCURRENCE_MISSING: Use same-source find_compiler_artifacts with kind canonical-event, copy results[].readArguments.ref into read_compiler_artifact.ref and payload.id into canonicalEventId. At most one corrected retry; if the acquiring event is absent or outside authority, preserve drafts and stop. Never guess.");
  return hydrateAcquisition(parsed, event.evidence, catalog);
}

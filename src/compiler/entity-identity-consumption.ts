import { contentHash } from "../world/canonical.js";
import type { Entity, ValidationIssue } from "../world/model.js";
import { SourceAnnotationStore, type SourceAnnotation } from "./annotations.js";
import { EntityResolutionStore, type IdentityResolution } from "./entity-resolution.js";

/** The marker is a proposal until its exact current unresolved decision and
 * complete retained predecessor chain validate. A new name or confidence is
 * never an identity-consumption permit. */
export function validateIdentityConsumptionBinding(entity: Entity, current: readonly IdentityResolution[], annotations: readonly SourceAnnotation[], history: readonly IdentityResolution[]): ValidationIssue[] {
  const basis = entity.identityConsumption;
  if (!basis) return [];
  const fail = (message: string): ValidationIssue[] => [{ code: "ENTITY_IDENTITY_CONSUMPTION_INVALID", path: "/identityConsumption", message }];
  const mention = annotations.find(a => a.id === basis.mentionId && a.annotationType === "entity-mention" && a.sourceId === basis.sourceId);
  const decision = current.find(r => r.mentionId === basis.mentionId && r.sourceId === basis.sourceId);
  if (!mention || !entity.evidence.some(e => e.span.sourceId === basis.sourceId) || !decision || decision.id !== basis.resolutionId
    || contentHash(decision) !== basis.resolutionRevisionHash || decision.status !== "unresolved" || decision.entityId || decision.intendedEntityId)
    return fail("Identity quarantine requires its exact source mention and current unresolved resolution revision; preserve all history, no inferred identity or retry.");
  const revisions = new Map<string, IdentityResolution>();
  for (const r of history) {
    if (revisions.has(r.id) && contentHash(revisions.get(r.id)) !== contentHash(r)) return fail("Identity predecessor has conflicting historical revisions; no guessed baseline or retry.");
    revisions.set(r.id, r);
  }
  const chain: string[] = [], seen = new Set([decision.id]); let next = decision.supersedesResolutionId, retainedEntity = false;
  while (next) {
    const prior = revisions.get(next);
    if (seen.has(next) || !prior || prior.sourceId !== basis.sourceId || prior.mentionId !== basis.mentionId)
      return fail("Identity predecessor chain is missing, cyclic or outside the same source/mention; preserve it, no retry.");
    seen.add(next); chain.push(next); retainedEntity ||= prior.entityId === entity.id;
    next = prior.supersedesResolutionId;
  }
  if (!retainedEntity || contentHash(chain) !== contentHash(basis.supersedesResolutionIds))
    return fail("Identity quarantine must preserve the exact complete predecessor chain which created or consumed this existing entity; no replacement identity.");
  if (basis.mode === "source-local") {
    const refs = basis.referentScope.mentionIds;
    if (entity.kind !== "character" || !refs.includes(basis.mentionId) || new Set(refs).size !== refs.length
      || refs.some(id => !annotations.some(a => a.id === id && a.annotationType === "entity-mention"
        && a.sourceId === basis.sourceId && mention.annotationType === "entity-mention" && contentHash(a.anchor) === contentHash(mention.anchor))))
      return fail("Source-local scope must retain the same anchored character occurrence; it cannot merge other mentions, layers or persons. Discover the original same-source mention, copy its id once; stop if unsupported.");
  }
  return [];
}

export async function validateCommittedIdentityConsumption(root: string, entity: Entity): Promise<ValidationIssue[]> {
  const basis = entity.identityConsumption;
  if (!basis) return [];
  const store = new EntityResolutionStore(root), history: IdentityResolution[] = [];
  for (const p of await store.listProposals(basis.sourceId, "accepted")) history.push((await store.readProposal(basis.sourceId, "accepted", p.id)).payload);
  return validateIdentityConsumptionBinding(entity, await store.list(basis.sourceId), await new SourceAnnotationStore(root).list(basis.sourceId), history);
}

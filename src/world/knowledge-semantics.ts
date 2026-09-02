import { canonicalJson } from "./canonical.js";
import type {
  Attribution,
  Claim,
  Entity,
  KnowledgeOperation,
  KnowledgeDelta,
  Proposition,
  PropositionObject,
  ValidationIssue,
} from "./model.js";
import { knowledgeDeltaSchema } from "./model.js";
import type { BranchSemanticState } from "./semantic-effects.js";

export type KnowledgeSemanticCatalog = {
  claims: ReadonlyMap<string, Claim>;
  propositions?: ReadonlyMap<string, Proposition>;
  attributions?: ReadonlyMap<string, Attribution>;
  branchSemantics?: BranchSemanticState;
};

export type LocatedKnowledgeDelta = { path: string; delta: KnowledgeDelta };

/** Characters and explicitly modeled communication systems may be quoted/information sources. */
export function isCommunicatingKnowledgeSource(
  entity: Pick<Entity, "kind"> | undefined,
): entity is Pick<Entity, "kind"> {
  return Boolean(entity && ["character", "institution", "artifact", "other"].includes(entity.kind));
}

/** Locates typed knowledge deltas inside compiler artifact payloads. */
export function findKnowledgeDeltas(value: unknown): LocatedKnowledgeDelta[] {
  const found: LocatedKnowledgeDelta[] = [];
  const seen = new WeakSet<object>();
  let visited = 0;
  const visit = (candidate: unknown, path: string) => {
    if (!candidate || typeof candidate !== "object") return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    visited += 1;
    if (visited > 20_000) throw new Error("Knowledge-delta discovery exceeded its bounded object limit.");
    const parsed = knowledgeDeltaSchema.safeParse(candidate);
    if (parsed.success) {
      found.push({ path, delta: parsed.data });
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, path ? `${path}.${index}` : String(index)));
      return;
    }
    for (const [key, nested] of Object.entries(candidate)) visit(nested, path ? `${path}.${key}` : key);
  };
  visit(value, "");
  return found;
}

/**
 * Validates the additive semantic bridge while preserving claimId as the
 * runtime compatibility key. This function never decides proposition truth;
 * it only proves that all referenced representations describe the same
 * content and that acquisition provenance is structurally coherent.
 */
export function validateKnowledgeSemanticReferences(
  operation: KnowledgeOperation,
  catalog: KnowledgeSemanticCatalog,
  path: string,
): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  if (!operation.propositionId) return errors;

  const proposition = catalog.propositions?.get(operation.propositionId)
    ?? catalog.branchSemantics?.propositions[operation.propositionId];
  if (!proposition) {
    errors.push(issue(
      "UNKNOWN_KNOWLEDGE_PROPOSITION",
      `Knowledge operation references unknown proposition ${operation.propositionId}`,
      `${path}.propositionId`,
    ));
    return errors;
  }
  const claim = catalog.claims.get(operation.claimId);
  if (claim) {
    const mismatches = claimProjectionMismatches(claim, proposition);
    for (const mismatch of mismatches) {
      errors.push(issue(
        "KNOWLEDGE_PROJECTION_MISMATCH",
        `Claim ${claim.id} is not a compatible runtime projection of proposition ${proposition.id}: ${mismatch}`,
        `${path}.claimId`,
      ));
    }
  } else {
    const branchClaim = catalog.branchSemantics?.claims[operation.claimId];
    if (branchClaim && branchClaim.propositionId !== proposition.id) {
      errors.push(issue(
        "KNOWLEDGE_PROJECTION_MISMATCH",
        `Branch claim ${branchClaim.id} describes proposition ${branchClaim.propositionId}, not ${proposition.id}`,
        `${path}.claimId`,
      ));
    }
  }
  if (operation.op !== "learn" || !operation.attributionId) return errors;

  const attribution = catalog.attributions?.get(operation.attributionId)
    ?? catalog.branchSemantics?.attributions[operation.attributionId];
  if (!attribution) {
    errors.push(issue(
      "UNKNOWN_KNOWLEDGE_ATTRIBUTION",
      `Knowledge operation references unknown attribution ${operation.attributionId}`,
      `${path}.attributionId`,
    ));
    return errors;
  }
  if (attribution.propositionId !== proposition.id) {
    errors.push(issue(
      "KNOWLEDGE_ATTRIBUTION_MISMATCH",
      `Attribution ${attribution.id} concerns proposition ${attribution.propositionId}, not ${proposition.id}`,
      `${path}.attributionId`,
    ));
  }
  if (operation.acquisitionMode === "told") {
    if ((attribution.holderKind !== "character" && attribution.holderKind !== "system")
      || attribution.holderEntityId !== operation.sourceActorId) {
      errors.push(issue(
        "TOLD_SOURCE_ATTRIBUTION_MISMATCH",
        `Told acquisition source ${operation.sourceActorId ?? "missing"} must be the character/system holder of attribution ${attribution.id}`,
        `${path}.attributionId`,
      ));
    }
  }
  if (operation.acquisitionMode === "read" && attribution.holderKind !== "document") {
    errors.push(issue(
      "READ_SOURCE_ATTRIBUTION_MISMATCH",
      `Read acquisition requires a document attribution; ${attribution.id} has holder kind ${attribution.holderKind}`,
      `${path}.attributionId`,
    ));
  }
  if (
    operation.acquisitionMode === "deceived-misattributed"
    && operation.sourceActorId
    && (attribution.holderKind === "character" || attribution.holderKind === "system")
    && attribution.holderEntityId !== operation.sourceActorId
  ) {
    errors.push(issue(
      "DECEPTIVE_SOURCE_ATTRIBUTION_MISMATCH",
      `Deceived acquisition source ${operation.sourceActorId} does not match attribution holder ${attribution.holderEntityId ?? "missing"}`,
      `${path}.attributionId`,
    ));
  }
  return errors;
}

export function claimProjectionMismatches(
  claim: Claim,
  proposition: Pick<Proposition, "id" | "subjectEntityId" | "relationId" | "object" | "polarity" | "modality">,
): string[] {
  const mismatches: string[] = [];
  if (claim.subject !== proposition.subjectEntityId) mismatches.push("subject differs");
  if (claim.predicate !== proposition.relationId) mismatches.push("predicate/relation differs");
  if (canonicalJson(claim.object) !== canonicalJson(projectPropositionObject(proposition.object))) {
    mismatches.push("object differs");
  }
  if (proposition.polarity !== "positive") {
    mismatches.push(`polarity '${proposition.polarity}' is not losslessly representable by a legacy claim`);
  }
  if (proposition.modality !== "asserted") {
    mismatches.push(`modality '${proposition.modality}' is not losslessly representable by a legacy claim`);
  }
  return mismatches;
}

export function projectPropositionObject(object: PropositionObject): unknown {
  if (object.kind === "entity") return object.entityId;
  if (object.kind === "literal") return object.value;
  return { propositionId: object.propositionId };
}

function issue(code: string, message: string, path: string): ValidationIssue {
  return { code, message, path };
}

import crypto from "node:crypto";
import { ActorModelStore, type CharacterGoal } from "../world/actors.js";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { CanonicalModelStore } from "../world/canonical-model.js";
import { claimProjectionMismatches, projectPropositionObject } from "../world/knowledge-semantics.js";
import {
  evidenceAssertionSchema,
  type Attribution,
  type CanonicalEvent,
  type Claim,
  type EventParticipation,
  type EventRelation,
  type EvidenceAssertion,
  type EvidenceRef,
  type Proposition,
  type TextAnchor,
} from "../world/model.js";
import { SourceAnnotationStore, annotationAnchors, type SourceAnnotation } from "./annotations.js";
import {
  EvidenceAssertionStore,
  validateEvidenceAssertionTargets,
} from "./evidence-assertions.js";
import { EvidenceVerifier } from "./evidence.js";
import { EventResolutionStore } from "./event-resolution.js";
import { EntityResolutionStore, type IdentityResolution } from "./entity-resolution.js";

export type ExactEvidenceBackfillResult = {
  created: string[];
  skipped: string[];
  createdByKind: Record<string, number>;
};

type BackfillArtifact = {
  kind: "attribution" | "claim" | "canonical-event" | "event-participation" | "event-relation" | "character-goal";
  id: string;
  payload: Attribution | Claim | CanonicalEvent | EventParticipation | EventRelation | CharacterGoal;
  evidence: EvidenceRef[];
  targetPath: string;
};

/**
 * Upgrade legacy, segment-grounded artifacts to exact evidence without asking
 * the model to rewrite already accepted world semantics.
 *
 * Every generated binding is derived from an existing exact source anchor and
 * a deterministic, already-validated semantic link: quotation→attribution,
 * proposition→legacy claim projection, event mention→canonical event,
 * canonical event→typed participation, endpoint events→event relation, or an
 * actor's exact-bound event→goal. Unsupported artifacts remain unbound and the
 * ordinary publication audit continues to fail closed.
 */
export async function backfillLegacyExactEvidence(
  workspaceRoot: string,
  sourceId: string,
  runId: string,
): Promise<ExactEvidenceBackfillResult> {
  const canon = new CanonicalModelStore(workspaceRoot);
  const actors = new ActorModelStore(workspaceRoot);
  const bindings = new EvidenceAssertionStore(workspaceRoot);
  const verifier = new EvidenceVerifier(workspaceRoot);
  const annotations = (await new SourceAnnotationStore(workspaceRoot).list(sourceId));
  const annotationsById = new Map(annotations.map((annotation) => [annotation.id, annotation]));
  const [eventResolutions, entityResolutions] = await Promise.all([
    new EventResolutionStore(workspaceRoot).list(sourceId),
    new EntityResolutionStore(workspaceRoot).list(sourceId),
  ]);
  const [attributions, claims, propositions, events, participations, relations, spatialRelations, goals] = await Promise.all([
    canon.listAttributions(),
    canon.listClaims(),
    canon.listPropositions(),
    canon.listEvents(),
    canon.listEventParticipations(),
    canon.listEventRelations(),
    canon.listSpatialRelations(),
    actors.listGoals(),
  ]);
  const sourceArtifacts = <T extends { evidence: EvidenceRef[] }>(items: T[]) =>
    items.filter((item) => item.evidence.some((reference) => reference.span.sourceId === sourceId));
  const sourceAttributions = sourceArtifacts(attributions);
  const sourceClaims = sourceArtifacts(claims);
  const sourcePropositions = sourceArtifacts(propositions);
  const sourceEvents = sourceArtifacts(events);
  const sourceParticipations = sourceArtifacts(participations);
  const sourceRelations = sourceArtifacts(relations);
  const sourceSpatialRelations = sourceArtifacts(spatialRelations);
  const sourceGoals = sourceArtifacts(goals);
  const eventsById = new Map(sourceEvents.map((event) => [event.id, event]));

  const result: ExactEvidenceBackfillResult = { created: [], skipped: [], createdByKind: {} };

  const bind = async (artifact: BackfillArtifact, anchorsInput: readonly TextAnchor[], interpretation: string) => {
    if ((await bindings.bindingForArtifact(artifact.kind, artifact.id))?.assertions.length) return;
    const anchors = exactAnchorsInsideEvidence(anchorsInput, artifact.evidence);
    if (!anchors.length) {
      result.skipped.push(`${artifact.kind}:${artifact.id}`);
      return;
    }
    const assertion = derivedAssertion(artifact, anchors, interpretation, runId);
    const targetIssues = validateEvidenceAssertionTargets(artifact.kind, artifact.id, artifact.payload, [assertion]);
    const evidenceIssues = (await verifier.verifyAssertions([assertion])).issues;
    if (targetIssues.length || evidenceIssues.length) {
      throw new Error(
        `Cannot backfill exact evidence for ${artifact.kind}:${artifact.id}: `
        + [...targetIssues, ...evidenceIssues].map((issue) => `${issue.code}: ${issue.message}`).join("; "),
      );
    }
    await bindings.replaceForArtifact(artifact.kind, artifact.id, contentHash(artifact.payload), [assertion]);
    result.created.push(`${artifact.kind}:${artifact.id}`);
    result.createdByKind[artifact.kind] = (result.createdByKind[artifact.kind] ?? 0) + 1;
  };

  for (const attribution of sourceAttributions) {
    if ((await bindings.bindingForArtifact("attribution", attribution.id))?.assertions.length) continue;
    const quotations = attribution.quotationIds?.map((id) => annotationsById.get(id)).filter(isQuotation) ?? [];
    await bind(
      artifact("attribution", attribution, "/attitude"),
      quotations.flatMap(annotationAnchors),
      "Backfilled from the attribution's exact quoted-speech anchors after committed speaker/addressee trace validation.",
    );
  }

  for (const claim of sourceClaims) {
    if ((await bindings.bindingForArtifact("claim", claim.id))?.assertions.length) continue;
    const exactProjection = sourcePropositions.filter((proposition) =>
      claimProjectionMismatches(claim, proposition).length === 0);
    const aggregateProjection = exactProjection.length ? exactProjection : bestAggregatePropositions(claim, sourcePropositions);
    let anchors = await donorAnchors(bindings, "proposition", aggregateProjection, claim.evidence);
    let interpretation = exactProjection.length
      ? "Backfilled from an exact-bound proposition whose legacy claim projection is lossless."
      : "Backfilled from exact-bound same-subject propositions in the same evidence slice that deterministically support this aggregate legacy claim.";
    if (!anchors.length) {
      const spatialDonors = sourceSpatialRelations.filter((relation) =>
        relation.knownByClaimIds.includes(claim.id)
        && evidenceOverlaps(claim.evidence, relation.evidence));
      anchors = await donorAnchors(bindings, "spatial-relation", spatialDonors, claim.evidence);
      if (anchors.length) {
        interpretation = "Backfilled from exact-bound spatial relations that explicitly name this claim as their knowledge gate.";
      }
    }
    if (!anchors.length) {
      anchors = await resolvedSpeakerQuotationAnchors(
        claim,
        annotations,
        entityResolutions,
        verifier,
      );
      if (anchors.length) {
        interpretation = "Backfilled from an exact quotation whose committed speaker resolution matches this character claim and whose wording materially overlaps the claim projection.";
      }
    }
    await bind(
      artifact("claim", claim, "/object"),
      anchors,
      interpretation,
    );
  }

  for (const event of sourceEvents) {
    if ((await bindings.bindingForArtifact("canonical-event", event.id))?.assertions.length) continue;
    const mentions = eventResolutions
      .filter((resolution) =>
        (resolution.status === "resolved" || resolution.status === "new-event")
        && resolution.canonicalEventId === event.id)
      .flatMap((resolution) => resolution.eventMentionIds)
      .map((id) => annotationsById.get(id))
      .filter(isEventMention);
    await bind(
      artifact("canonical-event", event, "/readerSummary"),
      mentions.flatMap(annotationAnchors),
      "Backfilled from exact event-mention anchors whose committed resolution selects this canonical event or one of its subevents.",
    );
  }

  for (const participation of sourceParticipations) {
    const event = eventsById.get(participation.eventId);
    const anchors = event
      ? await boundAnchors(bindings, "canonical-event", event.id, participation.evidence)
      : [];
    await bind(
      artifact("event-participation", participation, "/role"),
      anchors,
      "Backfilled from the exact-bound canonical occurrence after deterministic typed-participation projection validation.",
    );
  }

  for (const relation of sourceRelations) {
    const endpointAnchors = [relation.fromEventId, relation.toEventId]
      .map((id) => eventsById.get(id))
      .filter((event): event is CanonicalEvent => Boolean(event));
    const anchors = (await Promise.all(endpointAnchors.map((event) =>
      boundAnchors(bindings, "canonical-event", event.id, relation.evidence)))).flat();
    await bind(
      artifact("event-relation", relation, relation.mechanism ? "/mechanism" : "/type"),
      anchors,
      "Backfilled from exact-bound endpoint occurrences after deterministic event-relation and temporal-graph validation.",
    );
  }

  for (const goal of sourceGoals) {
    const candidateEvents = sourceEvents.filter((event) =>
      (event.participants.includes(goal.actorId)
        || goal.activation?.afterCanonicalEventIds.includes(event.id)
        || goal.activation?.afterExperiencedCanonicalEventIds?.includes(event.id))
      && evidenceOverlaps(goal.evidence, event.evidence));
    const anchors = (await Promise.all(candidateEvents.map((event) =>
      boundAnchors(bindings, "canonical-event", event.id, goal.evidence)))).flat();
    await bind(
      artifact("character-goal", goal, "/description"),
      anchors,
      "Backfilled from exact-bound actor events in the goal's source and activation window after goal-reference validation.",
    );
  }

  result.created.sort();
  result.skipped.sort();
  return result;
}

function artifact<K extends BackfillArtifact["kind"]>(
  kind: K,
  payload: Extract<BackfillArtifact["payload"], { id: string }>,
  targetPath: string,
): BackfillArtifact {
  return { kind, id: payload.id, payload, evidence: payload.evidence, targetPath } as BackfillArtifact;
}

function derivedAssertion(
  artifactValue: BackfillArtifact,
  anchors: TextAnchor[],
  interpretation: string,
  runId: string,
): EvidenceAssertion {
  const digest = crypto.createHash("sha256").update(canonicalJson({
    kind: artifactValue.kind,
    id: artifactValue.id,
    targetPath: artifactValue.targetPath,
    anchors,
    runId,
  })).digest("hex").slice(0, 32);
  return evidenceAssertionSchema.parse({
    version: 1,
    id: `evidence-backfill-${digest}`,
    target: {
      artifactKind: artifactValue.kind,
      artifactId: artifactValue.id,
      jsonPointer: artifactValue.targetPath,
    },
    anchors,
    relation: "supports",
    strength: "strong-inference",
    interpretation,
    derivation: {
      runId,
      worker: "repair-existing-exact-evidence-backfill",
      ontologyVersion: "evidence-v1",
    },
  });
}

async function donorAnchors(
  bindings: EvidenceAssertionStore,
  kind: string,
  donors: Array<{ id: string }>,
  evidence: EvidenceRef[],
): Promise<TextAnchor[]> {
  return (await Promise.all(donors.map((donor) => boundAnchors(bindings, kind, donor.id, evidence)))).flat();
}

async function boundAnchors(
  bindings: EvidenceAssertionStore,
  kind: string,
  id: string,
  evidence: EvidenceRef[],
): Promise<TextAnchor[]> {
  const binding = await bindings.bindingForArtifact(kind, id);
  return exactAnchorsInsideEvidence(binding?.assertions.flatMap((assertion) => assertion.anchors) ?? [], evidence);
}

function exactAnchorsInsideEvidence(anchors: readonly TextAnchor[], evidence: readonly EvidenceRef[]): TextAnchor[] {
  const byIdentity = new Map<string, TextAnchor>();
  for (const anchor of anchors) {
    if (!evidence.some((reference) => {
      if (reference.span.sourceId !== anchor.sourceId) return false;
      if (reference.span.startByte !== undefined && reference.span.endByte !== undefined) {
        return reference.span.startByte <= anchor.startByte && reference.span.endByte >= anchor.endByte;
      }
      return reference.span.startLine <= anchor.startLine && reference.span.endLine >= anchor.endLine;
    })) continue;
    byIdentity.set(canonicalJson(anchor), structuredClone(anchor));
  }
  return [...byIdentity.values()]
    .sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte)
    .slice(0, 16);
}

function bestAggregatePropositions(claim: Claim, propositions: Proposition[]): Proposition[] {
  const candidates = propositions
    .filter((proposition) =>
      proposition.subjectEntityId === claim.subject
      && evidenceOverlaps(claim.evidence, proposition.evidence))
    .map((proposition) => ({ proposition, score: lexicalOverlapScore(
      `${claim.predicate} ${String(claim.object)}`,
      `${proposition.relationId} ${String(projectPropositionObject(proposition.object))}`,
    ) }))
    .sort((left, right) => right.score - left.score || left.proposition.id.localeCompare(right.proposition.id));
  const positive = candidates.filter((candidate) => candidate.score > 0);
  return (positive.length ? positive : candidates).slice(0, 8).map((candidate) => candidate.proposition);
}

function lexicalOverlapScore(left: string, right: string): number {
  const grams = (value: string) => {
    const normalized = value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}_-]+/gu, "");
    const result = new Set<string>();
    for (let index = 0; index < normalized.length - 1; index += 1) result.add(normalized.slice(index, index + 2));
    return result;
  };
  const leftGrams = grams(left);
  const rightGrams = grams(right);
  let overlap = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) overlap += 1;
  return overlap;
}

async function resolvedSpeakerQuotationAnchors(
  claim: Claim,
  annotations: readonly SourceAnnotation[],
  entityResolutions: readonly IdentityResolution[],
  verifier: EvidenceVerifier,
): Promise<TextAnchor[]> {
  if (claim.epistemicType !== "character-claim" || !claim.speaker) return [];
  const entityByMention = new Map(entityResolutions.flatMap((resolution) =>
    (resolution.status === "resolved" || resolution.status === "new-entity" || resolution.status === "misidentified") && resolution.entityId
      ? [[resolution.mentionId, resolution.entityId] as const]
      : []));
  const candidates: Array<{ anchor: TextAnchor; score: number }> = [];
  for (const annotation of annotations) {
    if (!isQuotation(annotation)
      || !annotation.speakerMentionId
      || entityByMention.get(annotation.speakerMentionId) !== claim.speaker) continue;
    for (const anchor of exactAnchorsInsideEvidence(annotationAnchors(annotation), claim.evidence)) {
      const inspection = await verifier.inspectAnchor(anchor);
      if (!inspection.valid || !inspection.excerpt) continue;
      const score = lexicalOverlapScore(
        `${claim.predicate} ${canonicalJson(claim.object)}`,
        inspection.excerpt,
      );
      // Four matching bigrams is deliberately conservative: a same-speaker
      // quotation elsewhere in a chapter-sized legacy evidence slice must not
      // become a donor merely because it shares a short name or verb.
      if (score >= 4) candidates.push({ anchor, score });
    }
  }
  return candidates
    .sort((left, right) => right.score - left.score
      || left.anchor.startByte - right.anchor.startByte
      || left.anchor.endByte - right.anchor.endByte)
    .slice(0, 4)
    .map(({ anchor }) => anchor);
}

function evidenceOverlaps(left: readonly EvidenceRef[], right: readonly EvidenceRef[]): boolean {
  return left.some((leftReference) => right.some((rightReference) => {
    if (leftReference.span.sourceId !== rightReference.span.sourceId) return false;
    if (
      leftReference.span.startByte !== undefined
      && leftReference.span.endByte !== undefined
      && rightReference.span.startByte !== undefined
      && rightReference.span.endByte !== undefined
    ) {
      return leftReference.span.startByte < rightReference.span.endByte
        && rightReference.span.startByte < leftReference.span.endByte;
    }
    return leftReference.span.startLine <= rightReference.span.endLine
      && rightReference.span.startLine <= leftReference.span.endLine;
  }));
}

function isQuotation(annotation: SourceAnnotation | undefined): annotation is Extract<SourceAnnotation, { annotationType: "quotation" }> {
  return annotation?.annotationType === "quotation";
}

function isEventMention(annotation: SourceAnnotation | undefined): annotation is Extract<SourceAnnotation, { annotationType: "event-mention" }> {
  return annotation?.annotationType === "event-mention";
}

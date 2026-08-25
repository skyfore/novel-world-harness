import type { EvidenceRef } from "./model.js";
import type { WorldEngine, WorldModelContext } from "./engine.js";
import { characterOntologyEvidence } from "./character-ontology.js";
import { spatialRelationEvidence } from "./spatial-ontology.js";

export class AmbiguousLegacySourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousLegacySourceError";
  }
}

export function evidenceSourceIds(evidence: readonly EvidenceRef[]): string[] {
  return [...new Set(evidence.map((reference) => reference.span.sourceId))].sort();
}

/** Every evidence source represented by a pinned world-model snapshot. */
export function contextEvidenceSourceIds(context: WorldModelContext): string[] {
  return evidenceSourceIds([
    ...[...context.entities.values()].flatMap((artifact) => artifact.evidence),
    ...[...(context.claims?.values() ?? [])].flatMap((artifact) => artifact.evidence),
    ...[...(context.events?.values() ?? [])].flatMap((artifact) => artifact.evidence),
    ...[...context.rules.values()].flatMap((artifact) => artifact.evidence),
    ...(context.spatialRelations ?? []).flatMap(spatialRelationEvidence),
    ...(context.actorGoals ?? []).flatMap((artifact) => artifact.evidence),
    ...[...(context.actorModels?.values() ?? [])].flatMap((artifact) => [
      ...artifact.evidence,
      ...characterOntologyEvidence(artifact),
    ]),
    ...(context.possibilityTemplates ?? []).flatMap((artifact) => artifact.evidence),
  ]);
}

export function contextContainsGroundedArtifacts(context: WorldModelContext): boolean {
  return contextEvidenceSourceIds(context).length > 0;
}

/** Infer a scope only when evidence has one unambiguous owning source. */
export function exclusiveEvidenceSourceId(evidence: readonly EvidenceRef[]): string | undefined {
  const sourceIds = evidenceSourceIds(evidence);
  return sourceIds.length === 1 ? sourceIds[0] : undefined;
}

/** Boolean source ownership check for runtime visibility filters. */
export function evidenceBelongsExclusivelyToSource(
  evidence: readonly EvidenceRef[],
  sourceId?: string,
): boolean {
  return !sourceId || (evidence.length > 0
    && evidence.every((reference) => reference.span.sourceId === sourceId));
}

/** Compiler artifacts are source-owned; mixed evidence would cross novel boundaries. */
export function assertSingleEvidenceSource(
  evidence: readonly EvidenceRef[],
  label: string,
): string | undefined {
  const sourceIds = evidenceSourceIds(evidence);
  if (sourceIds.length > 1) {
    throw new Error(`${label} mixes evidence from multiple novel sources: ${sourceIds.join(", ")}. Split it into source-owned artifacts.`);
  }
  return sourceIds[0];
}

/** A source-scoped context must never serialize an artifact owned by another source. */
export function assertEvidenceExclusiveToSource(
  evidence: readonly EvidenceRef[],
  sourceId: string,
  label: string,
): void {
  const actual = assertSingleEvidenceSource(evidence, label);
  if (actual !== sourceId) {
    throw new Error(`${label} is not exclusively grounded in active novel source ${sourceId}${actual ? ` (found ${actual})` : " (no source evidence)"}.`);
  }
}

/**
 * Recover source ownership for branches created before sourceId was persisted.
 * Genesis participants are the strongest signal; the entire pinned context is
 * only a fallback when all grounded artifacts belong to one source.
 */
export async function inferLegacyBranchSourceId(
  engine: Pick<WorldEngine, "objects" | "contextForCommit">,
  headCommitId: string,
): Promise<string | undefined> {
  let genesisId = headCommitId;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(genesisId)) throw new Error(`Commit ancestry cycle detected at ${genesisId}`);
    seen.add(genesisId);
    const commit = await engine.objects.getCommit(genesisId);
    if (!commit.parentCommitId) break;
    genesisId = commit.parentCommitId;
  }

  const [genesis, context] = await Promise.all([
    engine.objects.getCommit(genesisId),
    engine.contextForCommit(genesisId),
  ]);
  const participantSourceIds = new Set<string>();
  for (const eventHash of genesis.eventHashes) {
    const event = await engine.objects.getEvent(eventHash);
    for (const evidence of event.evidence) participantSourceIds.add(evidence.span.sourceId);
    for (const participant of event.participants) {
      for (const evidence of context.entities.get(participant)?.evidence ?? []) {
        participantSourceIds.add(evidence.span.sourceId);
      }
    }
  }
  if (participantSourceIds.size === 1) return [...participantSourceIds][0];
  if (participantSourceIds.size > 1) return undefined;

  const contextSourceIds = contextEvidenceSourceIds(context);
  return contextSourceIds.length === 1 ? contextSourceIds[0] : undefined;
}

/**
 * Resolve the source owning one committed branch head. Explicit/saved scope is
 * checked against pinned or safely inferred ownership; an evidence-bearing
 * legacy context with no unique owner fails closed instead of becoming an
 * unbounded actor view.
 */
export async function resolveCommitSourceId(
  engine: Pick<WorldEngine, "objects" | "contextForCommit" | "branches">,
  context: WorldModelContext,
  commitId: string,
  requestedSourceId?: string,
  label = "Committed context",
): Promise<string | undefined> {
  const commit = await engine.objects.getCommit(commitId);
  const branch = await engine.branches.read(commit.branchId);
  if (branch.sourceId && context.sourceId && branch.sourceId !== context.sourceId) {
    throw new Error(`${label} branch source '${branch.sourceId}' does not match pinned context source '${context.sourceId}'.`);
  }
  const pinnedSourceId = branch.sourceId ?? context.sourceId ?? await inferLegacyBranchSourceId(engine, commitId);
  if (requestedSourceId && pinnedSourceId && requestedSourceId !== pinnedSourceId) {
    throw new Error(`${label} source '${requestedSourceId}' does not match committed branch context source '${pinnedSourceId}'.`);
  }
  const sourceId = requestedSourceId ?? pinnedSourceId;
  if (!sourceId && contextContainsGroundedArtifacts(context)) {
    throw new AmbiguousLegacySourceError(
      `${label} belongs to an ambiguous legacy multi-source context; assign or recreate a source-owned branch before continuing.`,
    );
  }
  return sourceId;
}

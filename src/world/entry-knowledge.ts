import { entryAgencyIssues, remoteEntryOccurrenceIssues } from "./entry-agency.js";
import { contentHash } from "./canonical.js";
import { entryKnowledgeHistorySchema, type EntryKnowledgeHistory, type KnowledgeDelta } from "./model.js";
import { executeSceneEvent } from "./source-history.js";
import { applyKnowledgeDelta, type KnowledgeState } from "./knowledge.js";
import { emptyBranchSemanticState } from "./semantic-effects.js";
import type { WorldModelContext } from "./engine.js";
import type { PreparedNovelBundle } from "../compiler/prepared-cache.js";

/** A committed entry reference reconstructs experience; serialized receipts are never input. */
export function replayEntryKnowledge(input: EntryKnowledgeHistory, context: WorldModelContext, realized: readonly string[], expected: KnowledgeDelta | undefined, commitId: string): KnowledgeState {
  const history = entryKnowledgeHistorySchema.parse(input), opening = context.initialWorld;
  const stop = (message: string): never => { throw new Error(`ENTRY_KNOWLEDGE_HISTORY_INVALID: ${message}. Preserve head and stop for host source/entry review; do not guess a cut, relabel acquisition or retry unchanged.`); };
  if (!opening || !context.sourceId) return stop("Frozen opening baseline is missing");
  if (opening.projectionSeed?.knowledgeHistory) return stop("Recursive opening knowledge history is not supported");
  const target = context.events?.get(history.beforeCanonicalEventId);
  if (!target || context.entities.get(history.actorId)?.kind !== "character") return stop("Entry occurrence or character is outside the frozen scope");
  const checkpoint = target.characterEntryCheckpoints?.find(item => item.actorId === history.actorId);
  if (!checkpoint) return stop("Entry character has no grounded checkpoint");
  const bundle = { source: { id: context.sourceId }, canonical: {
    initialWorld: opening, entities: [...context.entities.values()], events: [...(context.events?.values() ?? [])], rules: [...context.rules.values()],
    claims: [...(context.claims?.values() ?? [])], propositions: [...(context.propositions?.values() ?? [])], attributions: [...(context.attributions?.values() ?? [])],
    acquisitions: [...(context.acquisitions?.values() ?? [])], utteranceExpressions: [...(context.utteranceExpressions?.values() ?? [])], perceptionObservations: [...(context.perceptionObservations?.values() ?? [])],
    semanticEffects: [...(context.semanticEffects?.values() ?? [])], eventExecutions: [...(context.eventExecutions?.values() ?? [])],
    actionSchemas: [...(context.actionSchemas?.values() ?? [])], actionConstraints: [...(context.actionConstraints?.values() ?? [])],
    processTemplates: [...(context.processTemplates?.values() ?? [])], normTemplates: [...(context.normTemplates?.values() ?? [])],
    eventRelations: context.eventRelations ?? [], eventParticipations: context.eventParticipations ?? [], spatialRelations: context.spatialRelations ?? [], goals: context.actorGoals ?? [],
  } } as unknown as PreparedNovelBundle;
  const result = executeSceneEvent(bundle, target, undefined, { beforeOnly: true, ignoreCheckpoint: true, sourceEventRevisions: context.sourceEventRevisions });
  if (result.cut.hash !== history.cutHash || contentHash([...result.cut.completedEventIds].sort()) !== contentHash([...new Set(realized)].sort())) return stop("Entry cut is stale or imports a future/unrealized occurrence");
  const inheritedOperations = [...(opening.knowledge?.operations ?? []), ...result.cut.replayEventIds.flatMap(id => context.events!.get(id)!.observedKnowledge?.operations ?? [])];
  const checkpointKnowledge = checkpoint.projectionSeed?.knowledgeHistory ? undefined : checkpoint.participantPresence.some(item => item.entityId === history.actorId && item.mode === "remote")
    ? entryKnowledgeSupplement(inheritedOperations, checkpoint.knowledge) : checkpoint.knowledge;
  const operations = [...inheritedOperations, ...(checkpointKnowledge?.operations ?? [])];
  if (contentHash({ version: 1, operations }) !== contentHash(expected ?? { version: 1, operations: [] })) return stop("Entry knowledge differs from the exact frozen historical operations");
  const agencyIssues = [...entryAgencyIssues(history.actorId, { ...checkpoint, knowledge: expected }, context), ...remoteEntryOccurrenceIssues(history.actorId, checkpoint, target, context.eventParticipations)];
  if (agencyIssues.length) return stop(agencyIssues.map(issue => `${issue.code}: ${issue.message}`).join("; "));
  let knowledge = result.beforeKnowledge;
  if (checkpointKnowledge) knowledge = applyKnowledgeDelta(knowledge, checkpointKnowledge, commitId, {
    ...context, currentCanonicalEventIds: new Set(), realizedCanonicalEventIds: new Set(result.cut.completedEventIds),
    branchSemantics: emptyBranchSemanticState(commitId), perceptionOccurrence: { eventIds: new Set(), before: result.before, after: result.before, schema: context.stateSchema },
  });
  knowledge = structuredClone(knowledge);
  knowledge.atCommit = commitId;
  for (const facts of Object.values(knowledge.actors)) for (const fact of Object.values(facts)) fact.acquiredAtCommit = commitId;
  for (const receipt of Object.values(knowledge.acquisitions ?? {})) receipt.acquiredAtCommit = commitId;
  return knowledge;
}

/** An identical historical acquisition is a snapshot reference, never a second receipt. */
export function entryKnowledgeSupplement(inherited: KnowledgeDelta["operations"], checkpoint: KnowledgeDelta | undefined): KnowledgeDelta | undefined {
  if (!checkpoint) return undefined;
  const historicalReceipts = new Set(inherited.filter(operation => operation.op === "learn" && operation.acquisitionId).map(operation => contentHash(operation)));
  return { version: 1, operations: checkpoint.operations.filter(operation => !(operation.op === "learn" && operation.acquisitionId && historicalReceipts.has(contentHash(operation)))) };
}

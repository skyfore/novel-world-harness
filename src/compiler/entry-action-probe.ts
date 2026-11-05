import { z } from "zod";
import { ActorAlternativeBudgetError, ActorModelStore, deterministicActorProposalSource } from "../world/actors.js";
import { declaredActionStateDelta } from "../world/action-ontology.js";
import { deriveAdHocAction, normalizeActorProposal } from "../world/action-invocation.js";
import { contentHash } from "../world/canonical.js";
import { ENTRY_CONTRACT_VERSION } from "../world/entry-contract.js";
import type { CharacterGoal } from "../world/actors.js";
import type { ActionSchema } from "../world/action-ontology.js";
import type { WorldEngine } from "../world/engine.js";
import { KnowledgeProjector, isActionableKnowledge } from "../world/knowledge.js";
import { mechanismIsDisclosed } from "../world/mechanism-visibility.js";
import { committedEventSchema, stateDeltaSchema, knowledgeDeltaSchema, branchSemanticDeltaSchema, processDeltaSchema, normDeltaSchema, worldCommitSchema, type EventProposal } from "../world/model.js";
import { validateCommittedProgress } from "../world/progress.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const effectsSchema = z.object({ stateDelta: stateDeltaSchema.optional(), knowledgeDelta: knowledgeDeltaSchema.optional(),
  semanticDelta: branchSemanticDeltaSchema.optional(), processDelta: processDeltaSchema.optional(), normDelta: normDeltaSchema.optional() }).strict();
export const entryActionWitnessSchema = z.object({
  version: z.literal(1), contractVersion: z.string(), sourceId: z.string(), subjectSnapshotHash: hash, entryCutHash: hash, actorId: z.string(),
  entryHead: hash, resultingHead: hash, commit: worldCommitSchema, eventHash: hash, event: committedEventSchema, effects: effectsSchema,
  origin: z.object({ kind: z.enum(["compiled-goal", "self-schema"]), id: z.string(), revisionHash: hash }).strict(),
}).strict();
export type EntryActionWitness = z.infer<typeof entryActionWitnessSchema>;
export type EntryActionScope = { sourceId: string; subjectSnapshotHash: string; entryCutHash: string; actorId: string };
const materialChannels = new Set(["state", "knowledge", "semantic", "process", "norm", "speech", "text"]);
const materialAction = (certificate: EntryActionWitness["event"]["progressCertificate"]) =>
  certificate.channels.some(channel => materialChannels.has(channel))
  || Boolean(certificate.sceneTransition && certificate.sceneTransition.kind !== "stay");

export function entryActionWitnessIssues(witness: EntryActionWitness | undefined, scope: EntryActionScope): string[] {
  if (!witness) return ["ENTRY_ACTION_NOT_EVALUATED"];
  const issues: string[] = [];
  if (witness.contractVersion !== ENTRY_CONTRACT_VERSION) issues.push("ENTRY_ACTION_CONTRACT_STALE");
  if (witness.sourceId !== scope.sourceId || witness.subjectSnapshotHash !== scope.subjectSnapshotHash
    || witness.entryCutHash !== scope.entryCutHash || witness.actorId !== scope.actorId) issues.push("ENTRY_ACTION_SCOPE_STALE");
  if (witness.entryHead === witness.resultingHead || witness.commit.parentCommitId !== witness.entryHead
    || contentHash(witness.commit) !== witness.resultingHead || contentHash(witness.event) !== witness.eventHash
    || contentHash(witness.commit.eventHashes) !== contentHash([witness.eventHash])) issues.push("ENTRY_ACTION_COMMIT_MISMATCH");
  if (witness.event.actorId !== scope.actorId || !witness.event.action
    || witness.event.realizesCanonicalEventIds?.length || witness.event.canonicalAdaptation) issues.push("ENTRY_ACTION_NOT_BRANCH_ACTION");
  if (!materialAction(witness.event.progressCertificate)) issues.push("ENTRY_ACTION_NO_MATERIAL_EFFECT");
  if (witness.event.evidence.some(ref => ref.span.sourceId !== scope.sourceId)) issues.push("ENTRY_ACTION_SOURCE_MISMATCH");
  for (const key of ["stateDelta", "knowledgeDelta", "semanticDelta", "processDelta", "normDelta"] as const) {
    if ((witness.effects[key] ? contentHash(witness.effects[key]) : undefined) !== witness.event.effects[`${key}Hash`]) issues.push("ENTRY_ACTION_EFFECT_HASH_MISMATCH");
  }
  try { validateCommittedProgress(witness.event, witness.effects, witness.event.progressCertificate.timeAdvanced); }
  catch { issues.push("ENTRY_ACTION_PROGRESS_INVALID"); }
  return [...new Set(issues)];
}

export function entryActionDependencyIssues(witness: EntryActionWitness, catalog: { goals: readonly CharacterGoal[]; actionSchemas: readonly ActionSchema[] }): string[] {
  const { origin, event } = witness;
  const artifact = origin.kind === "compiled-goal" ? catalog.goals.find(goal => goal.id === origin.id && goal.actorId === witness.actorId)
    : catalog.actionSchemas.find(schema => schema.id === origin.id);
  if (!artifact || contentHash(artifact) !== origin.revisionHash) return ["ENTRY_ACTION_DEPENDENCY_STALE"];
  if (origin.kind === "self-schema") return event.action?.lane === "schema-bound" && event.action.schemaId === origin.id ? [] : ["ENTRY_ACTION_ORIGIN_MISMATCH"];
  const goal = artifact as CharacterGoal;
  return [goal.candidateAction, ...(goal.actionPatterns ?? [])].some(action => {
    if (!action) return false;
    // Goals can omit the invocation just like ordinary actor proposals. Their
    // only speech adapter is the compiled expression list; it must not be
    // inferred from an unverified witness when checking the frozen origin.
    const invocation = action.action ?? deriveAdHocAction({ kind: action.expressionCandidates?.length ? "speak" : "act",
      description: action.title, delta: action.proposedDelta, preconditions: action.preconditions });
    return contentHash(invocation) === contentHash(event.action);
  })
    ? [] : ["ENTRY_ACTION_ORIGIN_MISMATCH"];
}

/** Bounded real commit on a caller-owned isolated probe branch. No invented
 * intention, location, numeric state, future occurrence or automatic module. */
export async function probeEntryAction(engine: WorldEngine, scratch: string, input: EntryActionScope & { branchId: string; head: string }): Promise<EntryActionWitness> {
  const context = await engine.contextForCommit(input.head), state = await engine.projector.project(input.head);
  const candidates: { proposal: EventProposal; origin: EntryActionWitness["origin"] }[] = [];
  const rejected: string[] = [];
  let incomplete = false;
  const exclude = new Set([...context.entities.keys()].filter(id => id !== input.actorId));
  try {
    const source = deterministicActorProposalSource(engine, new ActorModelStore(scratch), { excludedActorIds: exclude,
      acceptCandidate: (_candidate, preview) => Boolean(preview.progressCertificate && materialAction(preview.progressCertificate)) });
    for (const candidate of await source({ branchId: input.branchId, commitId: input.head, maxActors: 1 })) {
      const goal = context.actorGoals?.find(goal => goal.id === candidate.goalId && goal.actorId === input.actorId);
      if (goal) candidates.push({ proposal: normalizeActorProposal(candidate.proposal), origin: { kind: "compiled-goal", id: goal.id, revisionHash: contentHash(goal) } });
    }
  } catch (error) {
    if (!(error instanceof ActorAlternativeBudgetError)) throw error;
    incomplete = true;
    rejected.push(error.message);
  }
  const known = new Set((await new KnowledgeProjector(engine).view(input.actorId, input.head)).knowledge
    .filter(item => isActionableKnowledge(item.fact)).map(item => item.fact.claimId));
  const mechanisms = [...(context.actionSchemas?.values() ?? [])].filter(schema => schema.roles.length === 1 && !schema.parameters.length
    && mechanismIsDisclosed(schema, { sourceId: input.sourceId, knownClaimIds: known })).sort((a, b) => a.id.localeCompare(b.id));
  if (mechanisms.length > 32) incomplete = true;
  for (const schema of mechanisms.slice(0, 32)) {
    const action = { lane: "schema-bound" as const, schemaId: schema.id, roleBindings: [{ roleId: schema.initiatorRoleId, entityIds: [input.actorId] }], parameters: {} };
    try {
      candidates.push({ origin: { kind: "self-schema", id: schema.id, revisionHash: contentHash(schema) }, proposal: {
        proposalId: `entry-action-${contentHash([input.head, input.actorId, schema.id]).slice(0, 24)}`, branchId: input.branchId,
        expectedParentCommit: input.head, source: "player", actorId: input.actorId, title: schema.name, participants: [input.actorId],
        proposedTime: state.logicalTime.storyTime ?? { kind: "unknown" }, preconditions: [], proposedDelta: declaredActionStateDelta(action, schema),
        action, causalParents: [], evidence: schema.evidence,
      } });
    } catch (error) { rejected.push(`${schema.id}: ${String(error)}`); }
  }
  for (const { proposal, origin } of candidates) {
    if (proposal.action?.lane === "schema-bound") {
      const schema = context.actionSchemas?.get(proposal.action.schemaId);
      if (!schema || !mechanismIsDisclosed(schema, { sourceId: input.sourceId, knownClaimIds: known })) {
        rejected.push(`${origin.id}: action mechanism not disclosed to this actor`); continue;
      }
    }
    const preview = await engine.previewProposal(proposal);
    if (!preview.report.accepted || !preview.progressCertificate || !materialAction(preview.progressCertificate)) {
      rejected.push(`${origin.id}: ${preview.report.errors.map(issue => issue.code).join(",") || "no material effect"}`);
      continue;
    }
    const result = await engine.commitProposal(proposal);
    if (!result.report.accepted || !result.eventHash) throw new Error("ENTRY_ACTION_COMMIT_FAILED: Preserve the isolated branch and stop; do not retry a changed head.");
    const event = await engine.objects.getEvent(result.eventHash), effects: z.infer<typeof effectsSchema> = {};
    if (event.effects.stateDeltaHash) effects.stateDelta = await engine.objects.getDelta(event.effects.stateDeltaHash);
    if (event.effects.knowledgeDeltaHash) effects.knowledgeDelta = await engine.objects.getKnowledgeDelta(event.effects.knowledgeDeltaHash);
    if (event.effects.semanticDeltaHash) effects.semanticDelta = await engine.objects.getSemanticDelta(event.effects.semanticDeltaHash);
    if (event.effects.processDeltaHash) effects.processDelta = await engine.objects.getProcessDelta(event.effects.processDeltaHash);
    if (event.effects.normDeltaHash) effects.normDelta = await engine.objects.getNormDelta(event.effects.normDeltaHash);
    const witness = entryActionWitnessSchema.parse({ version: 1, contractVersion: ENTRY_CONTRACT_VERSION,
      sourceId: input.sourceId, subjectSnapshotHash: input.subjectSnapshotHash, entryCutHash: input.entryCutHash, actorId: input.actorId,
      entryHead: input.head, resultingHead: result.newHead, commit: await engine.objects.getCommit(result.newHead),
      eventHash: result.eventHash, event, effects, origin });
    const issues = entryActionWitnessIssues(witness, input);
    if (issues.length) throw new Error(`${issues.join("; ")}. Stop for host probe review; do not retry.`);
    return witness;
  }
  throw new Error(`${incomplete ? "ENTRY_ACTION_SEARCH_INCOMPLETE" : "ENTRY_ACTION_UNPROVEN"}: No material action witness established by the bounded compiled-goal/self-schema probe. ${rejected.join("; ")}. Inspect frozen goals, disclosed mechanisms and their exact preconditions; preserve unknowns and stop for source/capability review. No unchanged retry, invented plan, widened budget or inference that no possible action exists.`);
}

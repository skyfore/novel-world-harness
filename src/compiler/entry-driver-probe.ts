import { z } from "zod";
import { ActorModelStore, deterministicActorProposalSource } from "../world/actors.js";
import { contentHash } from "../world/canonical.js";
import type { WorldEngine } from "../world/engine.js";
import { AUTONOMOUS_BACKGROUND_KINDS, committedEventSchema, idSchema, stateDeltaSchema, knowledgeDeltaSchema, branchSemanticDeltaSchema, processDeltaSchema, normDeltaSchema, type Possibility } from "../world/model.js";
import { validateCommittedProgress } from "../world/progress.js";
import { WorldRuntime, type MoveResult } from "../world/runtime.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const effectsSchema = z.object({ stateDelta: stateDeltaSchema.optional(), knowledgeDelta: knowledgeDeltaSchema.optional(),
  semanticDelta: branchSemanticDeltaSchema.optional(), processDelta: processDeltaSchema.optional(), normDelta: normDeltaSchema.optional() }).strict();
export const entryDriverWitnessSchema = z.object({
  version: z.literal(1), sourceId: idSchema, subjectSnapshotHash: hash, entryCutHash: hash,
  excludedActorId: idSchema, entryHead: hash, resultingHead: hash,
  lane: z.enum(["actor", "background"]),
  events: z.array(z.object({ hash, event: committedEventSchema, effects: effectsSchema }).strict()).min(1).max(64),
}).strict();
export type EntryDriverWitness = z.infer<typeof entryDriverWitnessSchema>;

export function entryDriverWitnessIssues(witness: EntryDriverWitness | undefined, scope: {
  sourceId: string; subjectSnapshotHash: string; entryCutHash: string; actorId: string;
}): string[] {
  if (!witness) return ["ENTRY_DRIVER_NOT_EVALUATED"];
  const issues: string[] = [];
  if (witness.sourceId !== scope.sourceId || witness.subjectSnapshotHash !== scope.subjectSnapshotHash
    || witness.entryCutHash !== scope.entryCutHash || witness.excludedActorId !== scope.actorId) issues.push("ENTRY_DRIVER_SCOPE_STALE");
  if (witness.entryHead === witness.resultingHead || !witness.events.length) issues.push("ENTRY_DRIVER_NO_COMMIT");
  for (const { hash: eventHash, event, effects } of witness.events) {
    if (contentHash(event) !== eventHash) issues.push("ENTRY_DRIVER_EVENT_HASH_MISMATCH");
    if (!event.progressCertificate.channels.length) issues.push("ENTRY_DRIVER_NO_MATERIAL_PROGRESS");
    if (witness.lane === "actor" && (!event.actorId || event.actorId === scope.actorId)) issues.push("ENTRY_DRIVER_PLAYER_ACTION");
    if ((witness.lane === "background") !== Boolean(event.possibilityId)) issues.push("ENTRY_DRIVER_LANE_MISMATCH");
    if (event.realizesCanonicalEventIds?.length || event.canonicalAdaptation) issues.push("ENTRY_DRIVER_CANON_REPLAY");
    // Due domain modules use module provenance rather than novel EvidenceRefs.
    // Their instantiated process/norm is already part of the source-bound entry projection.
    const moduleDue = witness.lane === "background" && /^due-(process|norm)-/.test(event.possibilityId ?? "")
      && Boolean(effects.processDelta?.operations.length || effects.normDelta?.operations.length);
    if ((!event.evidence.length && !moduleDue) || event.evidence.some(ref => ref.span.sourceId !== scope.sourceId)) issues.push("ENTRY_DRIVER_SOURCE_MISMATCH");
    for (const key of ["stateDelta", "knowledgeDelta", "semanticDelta", "processDelta", "normDelta"] as const) {
      const expected = event.effects[`${key}Hash`];
      if ((effects[key] ? contentHash(effects[key]) : undefined) !== expected) issues.push("ENTRY_DRIVER_EFFECT_HASH_MISMATCH");
    }
    try { validateCommittedProgress(event, effects, event.progressCertificate.timeAdvanced); }
    catch { issues.push("ENTRY_DRIVER_PROGRESS_INVALID"); }
  }
  return [...new Set(issues)];
}

/** A bounded operability probe on isolated forks. Never synthesizes a player action or advances a canon scheduler. */
export async function probeEntryDriver(engine: WorldEngine, scratch: string, input: {
  branchId: string; head: string; actorId: string; sourceId: string; subjectSnapshotHash: string; entryCutHash: string;
}): Promise<EntryDriverWitness> {
  const actorSource = deterministicActorProposalSource(engine, new ActorModelStore(scratch));
  const allowed = (possibility: Pick<Possibility, "kind" | "canonicalEventId" | "sourceActorId">) =>
    !possibility.canonicalEventId && possibility.kind !== "canon-analogue" && possibility.kind !== "player-choice"
    && (possibility.sourceActorId !== input.actorId || possibility.kind === "due-process");
  const runtime = new WorldRuntime(engine, async ({ branchId, commitId }) => {
    const context = await engine.contextForCommit(commitId);
    return (context.possibilityTemplates ?? []).filter(allowed)
      .filter(template => template.evidence.length && template.evidence.every(ref => ref.span.sourceId === input.sourceId))
      .map(template => ({ ...template, branchId, evaluatedAtCommit: commitId }));
  }, undefined, async request => (await actorSource(request)).filter(candidate => candidate.proposal.actorId !== input.actorId));
  const attempts: MoveResult[] = [];
  for (const lane of ["actor", "background"] as const) {
    const branchId = `${input.branchId}-driver-${lane}`;
    await runtime.forkBranch(input.branchId, input.head, branchId, `Entry driver: ${lane}`);
    const frontier = await runtime.refreshFrontier(branchId, input.head, { temporalMode: "current-window" });
    const result = await runtime.move({ branchId, maxActorCandidates: lane === "actor" ? 32 : 0,
      maxBackgroundCandidates: lane === "background" ? 1 : 0, temporalMode: "current-window",
      backgroundKinds: AUTONOMOUS_BACKGROUND_KINDS,
      excludedBackgroundPossibilityIds: frontier.evaluated.filter(entry => !allowed(entry.possibility)).map(entry => entry.possibility.id),
    });
    attempts.push(result);
    const events = await Promise.all(result.committedEvents.map(async eventHash => {
      const event = await engine.objects.getEvent(eventHash), refs = event.effects;
      const effects: z.infer<typeof effectsSchema> = {};
      if (refs.stateDeltaHash) effects.stateDelta = await engine.objects.getDelta(refs.stateDeltaHash);
      if (refs.knowledgeDeltaHash) effects.knowledgeDelta = await engine.objects.getKnowledgeDelta(refs.knowledgeDeltaHash);
      if (refs.semanticDeltaHash) effects.semanticDelta = await engine.objects.getSemanticDelta(refs.semanticDeltaHash);
      if (refs.processDeltaHash) effects.processDelta = await engine.objects.getProcessDelta(refs.processDeltaHash);
      if (refs.normDeltaHash) effects.normDelta = await engine.objects.getNormDelta(refs.normDeltaHash);
      return { hash: eventHash, event, effects };
    }));
    const material = events.filter(({ event }) => event.progressCertificate.channels.length > 0);
    if (!material.length) continue;
    const witness = entryDriverWitnessSchema.parse({ version: 1, sourceId: input.sourceId, subjectSnapshotHash: input.subjectSnapshotHash,
      entryCutHash: input.entryCutHash, excludedActorId: input.actorId, entryHead: input.head, resultingHead: result.newHead, lane, events: material });
    const issues = entryDriverWitnessIssues(witness, input);
    if (issues.length) throw new Error(issues.join("; "));
    return witness;
  }
  throw new Error(`ENTRY_DRIVER_UNPROVEN: no material autonomous event committed at the entry cut after excluding ${input.actorId}. Bounded probe: 32 actor candidates and 1 background commit; rejected proposals: ${attempts.flatMap(result => result.rejectedProposals).join(", ") || "none"}. A goal or future canonical event is not a driver witness.`);
}

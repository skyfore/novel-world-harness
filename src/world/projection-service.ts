import { deepFreeze } from "../util/immutable.js";
import type { ResolvedWorldModelContext } from "./engine.js";
import {
  WORLD_ENGINE_VERSION,
  WORLD_SCHEMA_VERSION,
  type CommitId,
  type CommittedEvent,
  type KnowledgeDelta,
  type LogicalTime,
  type NormDelta,
  type ObjectHash,
  type ProcessDelta,
  type StateDelta,
  type WorldCommit,
  type WorldState,
  type BranchSemanticDelta,
} from "./model.js";
import {
  applyKnowledgeDelta,
  emptyKnowledgeState,
  type KnowledgeState,
} from "./knowledge.js";
import { applyNormDelta, emptyNormState, type NormState } from "./norm-effects.js";
import { applyProcessDelta, emptyProcessState, type ProcessState } from "./process-effects.js";
import {
  applyBranchSemanticDelta,
  emptyBranchSemanticState,
  type BranchSemanticState,
  type EffectProvenance,
} from "./semantic-effects.js";
import {
  advanceTemporalState,
  applyStateDelta,
  emptyWorldState,
  validateEngineInvariants,
} from "./state.js";
import type { WorldObjectStore } from "./store.js";
import { assertMonotonicLogicalTime } from "./time.js";

export type HistoryCommit = {
  id: CommitId;
  commit: WorldCommit;
};

export type ProjectedHistoryEntry = {
  commitId: CommitId;
  eventHash: ObjectHash;
  event: CommittedEvent;
  /** Compatibility name consumed by the current scene reducer. */
  delta: StateDelta;
  knowledgeDelta?: KnowledgeDelta;
  semanticDelta?: BranchSemanticDelta;
  processDelta?: ProcessDelta;
  normDelta?: NormDelta;
};

export type SceneIndex = {
  version: 1;
  atCommit: CommitId;
  transitions: Array<{
    commitId: CommitId;
    eventId: string;
    eventHash: ObjectHash;
    participantIds: string[];
    scene: NonNullable<NonNullable<CommittedEvent["progress"]>["scene"]>;
  }>;
};

export type CausalIndex = {
  version: 1;
  atCommit: CommitId;
  events: Record<string, {
    commitId: CommitId;
    eventHash: ObjectHash;
    causalParents: string[];
  }>;
  childrenByParent: Record<string, string[]>;
};

export type WorldProjectionBundle = {
  version: 1;
  atCommit: CommitId;
  state: WorldState;
  knowledge: KnowledgeState;
  semantics: BranchSemanticState;
  processes: ProcessState;
  norms: NormState;
  scenes: SceneIndex;
  causality: CausalIndex;
  history: ProjectedHistoryEntry[];
};

export type ProjectionOptions = { fresh?: boolean };
export type ProjectionContextResolver = (snapshotHash?: ObjectHash) => Promise<ResolvedWorldModelContext>;

/** Reads and validates one immutable ancestry chain for all downstream reducers. */
export class SharedHistoryCursor {
  constructor(private readonly objects: WorldObjectStore) {}

  async read(commitId: CommitId): Promise<HistoryCommit[]> {
    const reversed: HistoryCommit[] = [];
    const seen = new Set<string>();
    let cursor: CommitId | undefined = commitId;
    while (cursor) {
      if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
      seen.add(cursor);
      const commit = await this.objects.getCommit(cursor);
      if (commit.schemaVersion !== WORLD_SCHEMA_VERSION) {
        throw new Error(`Unsupported world schema version ${commit.schemaVersion} at ${cursor}`);
      }
      if (commit.engineVersion !== WORLD_ENGINE_VERSION) {
        throw new Error(`Unsupported engine version ${commit.engineVersion} at ${cursor}`);
      }
      reversed.push({ id: cursor, commit });
      cursor = commit.parentCommitId;
      if (reversed.length > 100_000) throw new Error("Commit ancestry exceeds safety limit");
    }
    return reversed.reverse();
  }
}

/**
 * Authoritative derived-read boundary. Every effect channel consumes the same
 * ordered commit/event stream; a dangling or invalid channel aborts the whole
 * projection instead of leaving mutually inconsistent read models.
 */
export class ProjectionService {
  readonly cursor: SharedHistoryCursor;
  private readonly cache = new Map<CommitId, Promise<WorldProjectionBundle>>();

  constructor(
    private readonly objects: WorldObjectStore,
    private readonly contextForSnapshot: ProjectionContextResolver,
  ) {
    this.cursor = new SharedHistoryCursor(objects);
  }

  async project(commitId: CommitId, options: ProjectionOptions = {}): Promise<WorldProjectionBundle> {
    if (options.fresh) return this.projectFresh(commitId);
    const cached = this.cache.get(commitId);
    if (cached) return cached;
    const pending = this.projectFresh(commitId).catch((error) => {
      this.cache.delete(commitId);
      throw error;
    });
    this.cache.set(commitId, pending);
    return pending;
  }

  clear(commitId?: CommitId): void {
    if (commitId) this.cache.delete(commitId);
    else this.cache.clear();
  }

  private async projectFresh(commitId: CommitId): Promise<WorldProjectionBundle> {
    const chain = await this.cursor.read(commitId);
    const genesisId = chain[0]?.id ?? commitId;
    let state = emptyWorldState(genesisId, 0);
    let knowledge = emptyKnowledgeState(genesisId);
    let semantics = emptyBranchSemanticState(genesisId);
    let processes = emptyProcessState(genesisId);
    let norms = emptyNormState(genesisId);
    const scenes: SceneIndex = { version: 1, atCommit: genesisId, transitions: [] };
    const causality: CausalIndex = { version: 1, atCommit: genesisId, events: {}, childrenByParent: {} };
    const history: ProjectedHistoryEntry[] = [];
    const knownCommittedEventIds = new Set<string>();
    let previousTime: LogicalTime | undefined;

    for (const entry of chain) {
      const context = await this.contextForSnapshot(entry.commit.canonicalSnapshotHash);
      if (previousTime) {
        try {
          assertMonotonicLogicalTime(previousTime, entry.commit.logicalTime);
        } catch (error) {
          throw new Error(`Non-monotonic world time at commit ${entry.id}: ${messageOf(error)}`);
        }
      }
      state = advanceTemporalState(state, entry.commit.logicalTime, context.stateSchema, context.entities);
      const eventHashes = new Set<string>();

      for (const eventHash of entry.commit.eventHashes) {
        if (eventHashes.has(eventHash)) throw new Error(`Commit ${entry.id} repeats event hash ${eventHash}`);
        eventHashes.add(eventHash);
        const event = await this.objects.getEvent(eventHash);
        if (event.branchId !== entry.commit.branchId) {
          throw new Error(`Event ${eventHash} branch ${event.branchId} differs from commit branch ${entry.commit.branchId}`);
        }
        if (event.logicalTime.step !== entry.commit.logicalTime.step) {
          throw new Error(`Event/commit logical time mismatch for ${eventHash}`);
        }
        if (causality.events[event.eventId]) throw new Error(`Committed event ID is not unique in branch history: ${event.eventId}`);

        try {
          const effects = await this.loadEffects(event);
          const provenance: EffectProvenance = { commitId: entry.id, eventId: event.eventId, eventHash };
          if (effects.delta.operations.length) {
            state = applyStateDelta(state, effects.delta, context.stateSchema, context.entities, context.rules);
          }
          if (effects.semanticDelta) {
            semantics = applyBranchSemanticDelta(semantics, effects.semanticDelta, {
              entities: context.entities,
              canonicalPropositionIds: context.propositions ? new Set(context.propositions.keys()) : undefined,
              canonicalAttributionIds: context.attributions ? new Set(context.attributions.keys()) : undefined,
              canonicalClaimIds: context.claims ? new Set(context.claims.keys()) : undefined,
              canonicalGoalIds: context.actorGoals ? new Set(context.actorGoals.map((goal) => goal.id)) : undefined,
              canonicalEventIds: context.events ? new Set(context.events.keys()) : undefined,
              knownCommittedEventIds,
            }, provenance);
          }
          if (effects.knowledgeDelta) {
            knowledge = applyKnowledgeDelta(knowledge, effects.knowledgeDelta, entry.id, {
              entities: context.entities,
              claims: context.claims,
              propositions: context.propositions,
              attributions: context.attributions,
              branchSemantics: semantics,
            });
          }
          if (effects.processDelta) {
            processes = applyProcessDelta(
              processes,
              effects.processDelta,
              context.entities,
              provenance,
              entry.commit.logicalTime.elapsedDays ?? 0,
            );
          }
          if (effects.normDelta) {
            norms = applyNormDelta(norms, effects.normDelta, context.entities, provenance);
          }

          history.push({
            commitId: entry.id,
            eventHash,
            event,
            delta: effects.delta,
            ...(effects.knowledgeDelta ? { knowledgeDelta: effects.knowledgeDelta } : {}),
            ...(effects.semanticDelta ? { semanticDelta: effects.semanticDelta } : {}),
            ...(effects.processDelta ? { processDelta: effects.processDelta } : {}),
            ...(effects.normDelta ? { normDelta: effects.normDelta } : {}),
          });
        } catch (error) {
          throw new Error(`Cannot project event ${event.eventId} (${eventHash}) at commit ${entry.id}: ${messageOf(error)}`);
        }

        causality.events[event.eventId] = {
          commitId: entry.id,
          eventHash,
          causalParents: [...event.causalParents],
        };
        for (const parentId of event.causalParents) {
          const children = (causality.childrenByParent[parentId] ??= []);
          if (!children.includes(event.eventId)) children.push(event.eventId);
          children.sort();
        }
        if (event.progress?.scene) {
          scenes.transitions.push({
            commitId: entry.id,
            eventId: event.eventId,
            eventHash,
            participantIds: [...event.participants],
            scene: structuredClone(event.progress.scene),
          });
        }
        knownCommittedEventIds.add(event.eventId);
      }

      state = { ...state, atCommit: entry.id, logicalTime: entry.commit.logicalTime };
      knowledge = { ...knowledge, atCommit: entry.id };
      semantics = { ...semantics, atCommit: entry.id };
      processes = { ...processes, atCommit: entry.id };
      norms = { ...norms, atCommit: entry.id };
      scenes.atCommit = entry.id;
      causality.atCommit = entry.id;
      const invariantErrors = validateEngineInvariants(state, context.stateSchema, context.entities, context.rules);
      if (invariantErrors.length) throw new Error(`Projected state violates invariants: ${invariantErrors.join("; ")}`);
      previousTime = entry.commit.logicalTime;
    }

    return deepFreeze({
      version: 1,
      atCommit: commitId,
      state,
      knowledge,
      semantics,
      processes,
      norms,
      scenes,
      causality,
      history,
    });
  }

  private async loadEffects(event: CommittedEvent): Promise<{
    delta: StateDelta;
    knowledgeDelta?: KnowledgeDelta;
    semanticDelta?: BranchSemanticDelta;
    processDelta?: ProcessDelta;
    normDelta?: NormDelta;
  }> {
    const [delta, knowledgeDelta, semanticDelta, processDelta, normDelta] = await Promise.all([
      event.effects.stateDeltaHash
        ? this.objects.getDelta(event.effects.stateDeltaHash)
        : Promise.resolve({ version: 1 as const, operations: [] }),
      event.effects.knowledgeDeltaHash
        ? this.objects.getKnowledgeDelta(event.effects.knowledgeDeltaHash)
        : Promise.resolve(undefined),
      event.effects.semanticDeltaHash
        ? this.objects.getSemanticDelta(event.effects.semanticDeltaHash)
        : Promise.resolve(undefined),
      event.effects.processDeltaHash
        ? this.objects.getProcessDelta(event.effects.processDeltaHash)
        : Promise.resolve(undefined),
      event.effects.normDeltaHash
        ? this.objects.getNormDelta(event.effects.normDeltaHash)
        : Promise.resolve(undefined),
    ]);
    return {
      delta,
      ...(knowledgeDelta ? { knowledgeDelta } : {}),
      ...(semanticDelta ? { semanticDelta } : {}),
      ...(processDelta ? { processDelta } : {}),
      ...(normDelta ? { normDelta } : {}),
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

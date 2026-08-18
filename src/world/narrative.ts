import type { CommitId, CommittedEvent, EntityId, StateValue, WorldState } from "./model.js";
import type { WorldEngine } from "./engine.js";
import { KnowledgeProjector } from "./knowledge.js";
import { observeCommittedEvent } from "./actor-visible.js";
import { evidenceBelongsExclusivelyToSource, resolveCommitSourceId } from "./source-scope.js";
import { deepFreeze } from "../util/immutable.js";

export type NarrativeEvent = { hash: string; event: CommittedEvent };
export type ActorNarrativeEvent = {
  event: Pick<CommittedEvent, "title">;
};
export type ActorNarrativeView = {
  actor: { name: string };
  selfState: Record<string, StateValue>;
  knowledge: Array<{
    status: "knows" | "believes" | "suspects" | "heard" | "disbelieves";
    confidence: number;
    claim: {
      subject: string;
      predicate: string;
      object: unknown;
      epistemicType: "explicit-fact" | "narrator-claim" | "character-claim" | "rumor" | "inference" | "interpretation";
      speaker?: string;
    };
  }>;
};
export type OmniscientNarrativeFrame = {
  pointOfView: "omniscient";
  branchId: string;
  commitId: CommitId;
  state: WorldState;
  events: NarrativeEvent[];
};
export type ActorNarrativeFrame = {
  pointOfView: "actor";
  events: ActorNarrativeEvent[];
  actorView: ActorNarrativeView;
};
export type NarrativeFrame = OmniscientNarrativeFrame | ActorNarrativeFrame;
export type NarrativeStyle = { pointOfView?: "omniscient" | "actor"; actorId?: EntityId; tone?: string };
export type NarrativeAdapter = (frame: Readonly<NarrativeFrame>, style: Readonly<NarrativeStyle>) => Promise<string> | string;

export class NarrativeRenderer {
  private readonly knowledge: KnowledgeProjector;
  constructor(private readonly engine: WorldEngine, private readonly adapter: NarrativeAdapter = deterministicRender) {
    this.knowledge = new KnowledgeProjector(engine);
  }

  async frame(branchId: string, commitId: CommitId, style: NarrativeStyle = {}, sourceId?: string): Promise<NarrativeFrame> {
    const state = await this.engine.projector.project(commitId);
    const events = await collectEvents(this.engine, commitId);
    if (style.pointOfView === "actor") {
      if (!style.actorId) throw new Error("Actor point of view requires actorId");
      const context = await this.engine.contextForCommit(commitId);
      const actor = context.entities.get(style.actorId);
      const effectiveSourceId = await resolveCommitSourceId(this.engine, context, commitId, sourceId, "Actor narrative");
      if (!actor || actor.kind !== "character"
        || !evidenceBelongsExclusivelyToSource(actor.evidence, effectiveSourceId)) {
        throw new Error(`Actor narrative view requires a source-owned character: ${style.actorId}`);
      }
      const actorView = await this.knowledge.view(style.actorId, commitId, state);
      const visibleEvents = events.flatMap(({ event }) => {
        if (event.title === "Genesis") return [];
        if (event.evidence.length
          && !evidenceBelongsExclusivelyToSource(event.evidence, effectiveSourceId)) return [];
        const observation = observeCommittedEvent(event, style.actorId!);
        if (!observation) return [];
        return [{
          event: {
            title: observation.summary,
          },
        }];
      });
      return {
        pointOfView: "actor",
        events: structuredClone(visibleEvents),
        actorView: {
          actor: { name: actor.canonicalName },
          selfState: narrativeState(actorView.selfState, context, effectiveSourceId),
          knowledge: actorView.knowledge.flatMap((entry) => {
            const claim = entry.claim;
            if (!claim
              || !evidenceBelongsExclusivelyToSource(claim.evidence, effectiveSourceId)
              || !sourceOwnedEntity(context, claim.subject, effectiveSourceId)
              || claim.speaker && !sourceOwnedEntity(context, claim.speaker, effectiveSourceId)
              || !claimObjectIsSourceSafe(claim.object, context, effectiveSourceId)) return [];
            return [{
              status: entry.fact.status,
              confidence: entry.fact.confidence,
              claim: {
                subject: narrativeValue(claim.subject, context, effectiveSourceId) as string,
                predicate: claim.predicate,
                object: narrativeValue(claim.object, context, effectiveSourceId),
                epistemicType: claim.epistemicType,
                ...(claim.speaker
                  ? { speaker: narrativeValue(claim.speaker, context, effectiveSourceId) as string }
                  : {}),
              },
            }];
          }),
        },
      };
    }
    return {
      pointOfView: "omniscient",
      branchId,
      commitId,
      state: structuredClone(state),
      events: structuredClone(events),
    };
  }

  async render(branchId: string, commitId: CommitId, style: NarrativeStyle = {}, sourceId?: string): Promise<string> {
    const beforeHead = await this.engine.branches.readHead(branchId);
    if (beforeHead !== commitId) throw new Error(`Narrative render commit ${commitId} is not the current head of branch ${branchId}`);
    const frame = await this.frame(branchId, commitId, style, sourceId);
    const adapterStyle = style.pointOfView === "actor"
      ? { pointOfView: "actor" as const, ...(style.tone ? { tone: style.tone } : {}) }
      : { ...style };
    const text: unknown = await this.adapter(deepFreeze(frame), deepFreeze(adapterStyle));
    const afterHead = await this.engine.branches.readHead(branchId);
    if (afterHead !== beforeHead) throw new Error("Narrative renderer mutated branch truth");
    if (typeof text !== "string") throw new Error("Narrative adapter must return a string");
    return text;
  }
}

async function collectEvents(engine: WorldEngine, commitId: CommitId): Promise<NarrativeEvent[]> {
  const commits: { id: CommitId; eventHashes: string[] }[] = [];
  const seen = new Set<string>();
  let cursor: CommitId | undefined = commitId;
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
    seen.add(cursor);
    const commit = await engine.objects.getCommit(cursor);
    commits.push({ id: cursor, eventHashes: commit.eventHashes });
    cursor = commit.parentCommitId;
  }
  commits.reverse();
  const events: NarrativeEvent[] = [];
  for (const commit of commits) for (const hash of commit.eventHashes) events.push({ hash, event: await engine.objects.getEvent(hash) });
  return events;
}

function deterministicRender(frame: Readonly<NarrativeFrame>, style: Readonly<NarrativeStyle>): string {
  const prefix = style.tone ? `[${style.tone}] ` : "";
  return frame.pointOfView === "actor"
    ? frame.events.map(({ event }, index) => `${prefix}${index + 1}. ${event.title}`).join("\n")
    : frame.events.map(({ event }) => `${prefix}${event.logicalTime.step}. ${event.title}`).join("\n");
}

function sourceOwnedEntity(
  context: Awaited<ReturnType<WorldEngine["contextForCommit"]>>,
  entityId: string,
  sourceId?: string,
): boolean {
  const entity = context.entities.get(entityId);
  return Boolean(entity && evidenceBelongsExclusivelyToSource(entity.evidence, sourceId));
}

function claimObjectIsSourceSafe(
  value: unknown,
  context: Awaited<ReturnType<WorldEngine["contextForCommit"]>>,
  sourceId?: string,
  depth = 0,
): boolean {
  if (typeof value === "string") {
    const entity = context.entities.get(value);
    return !entity || evidenceBelongsExclusivelyToSource(entity.evidence, sourceId);
  }
  if (depth >= 8) return false;
  if (Array.isArray(value)) return value.every((item) => claimObjectIsSourceSafe(item, context, sourceId, depth + 1));
  if (!value || typeof value !== "object") return true;
  return Object.values(value as Record<string, unknown>)
    .every((item) => claimObjectIsSourceSafe(item, context, sourceId, depth + 1));
}

function narrativeState(
  values: Readonly<Record<string, unknown>>,
  context: Awaited<ReturnType<WorldEngine["contextForCommit"]>>,
  sourceId?: string,
): Record<string, StateValue> {
  const result: Record<string, StateValue> = {};
  for (const [field, value] of Object.entries(values)) {
    let valueType;
    try {
      valueType = context.stateSchema.get(field).valueType;
    } catch {
      continue;
    }
    if (valueType === "entity-ref") {
      if (typeof value === "string" && sourceOwnedEntity(context, value, sourceId)) {
        result[field] = narrativeValue(value, context, sourceId) as string;
      }
      continue;
    }
    if (valueType === "entity-ref-set") {
      if (Array.isArray(value)) {
        result[field] = value
          .filter((item): item is string => typeof item === "string" && sourceOwnedEntity(context, item, sourceId))
          .map((item) => narrativeValue(item, context, sourceId) as string);
      }
      continue;
    }
    result[field] = structuredClone(value) as StateValue;
  }
  return result;
}

function narrativeValue(
  value: unknown,
  context: Awaited<ReturnType<WorldEngine["contextForCommit"]>>,
  sourceId?: string,
  depth = 0,
): unknown {
  if (typeof value === "string") {
    const entity = context.entities.get(value);
    return entity && evidenceBelongsExclusivelyToSource(entity.evidence, sourceId)
      ? entity.canonicalName
      : value;
  }
  if (depth >= 8) return "[nested data omitted]";
  if (Array.isArray(value)) return value.map((item) => narrativeValue(item, context, sourceId, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, narrativeValue(item, context, sourceId, depth + 1)]));
}

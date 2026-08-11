import type { CommitId, CommittedEvent, EntityId, WorldState } from "./model.js";
import type { WorldEngine } from "./engine.js";
import { KnowledgeProjector, type ActorWorldView } from "./knowledge.js";

export type NarrativeEvent = { hash: string; event: CommittedEvent };
export type NarrativeFrame = {
  branchId: string;
  commitId: CommitId;
  state: WorldState;
  events: NarrativeEvent[];
  actorView?: ActorWorldView;
};
export type NarrativeStyle = { pointOfView?: "omniscient" | "actor"; actorId?: EntityId; tone?: string };
export type NarrativeAdapter = (frame: Readonly<NarrativeFrame>, style: Readonly<NarrativeStyle>) => Promise<string> | string;

export class NarrativeRenderer {
  private readonly knowledge: KnowledgeProjector;
  constructor(private readonly engine: WorldEngine, private readonly adapter: NarrativeAdapter = deterministicRender) {
    this.knowledge = new KnowledgeProjector(engine);
  }

  async frame(branchId: string, commitId: CommitId, style: NarrativeStyle = {}): Promise<NarrativeFrame> {
    const state = await this.engine.projector.project(commitId);
    const events = await collectEvents(this.engine, commitId);
    const actorView = style.pointOfView === "actor" && style.actorId
      ? await this.knowledge.view(style.actorId, commitId, state)
      : undefined;
    return { branchId, commitId, state: structuredClone(state), events: structuredClone(events), ...(actorView ? { actorView: structuredClone(actorView) } : {}) };
  }

  async render(branchId: string, commitId: CommitId, style: NarrativeStyle = {}): Promise<string> {
    const beforeHead = await this.engine.branches.readHead(branchId);
    if (beforeHead !== commitId) throw new Error(`Narrative render commit ${commitId} is not the current head of branch ${branchId}`);
    const frame = await this.frame(branchId, commitId, style);
    const text = await this.adapter(deepFreeze(frame), deepFreeze({ ...style }));
    const afterHead = await this.engine.branches.readHead(branchId);
    if (afterHead !== beforeHead) throw new Error("Narrative renderer mutated branch truth");
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
  const visible = style.pointOfView === "actor" && frame.actorView
    ? frame.events.filter(({ event }) => event.participants.includes(frame.actorView!.actorId))
    : frame.events;
  return visible.map(({ event }) => `${prefix}${event.logicalTime.step}. ${event.title}`).join("\n");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

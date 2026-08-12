import type { WorldEngine } from "./engine.js";
import { KnowledgeProjector } from "./knowledge.js";
import type { CommitId, KnowledgeFact, WorldState } from "./model.js";

export type StateDifference = { entityId: string; field: string; left?: unknown; right?: unknown };
export type HistoryDifference = {
  commitId: CommitId;
  step: number;
  eventHash: string;
  eventId: string;
  title: string;
};
export type KnowledgeDifference = { actorId: string; claimId: string; left?: KnowledgeFact; right?: KnowledgeFact };
export type WorldBranchDiff = {
  left: { branch: string; head: CommitId };
  right: { branch: string; head: CommitId };
  commonAncestor?: CommitId;
  stateDifferences: StateDifference[];
  history: { leftOnly: HistoryDifference[]; rightOnly: HistoryDifference[] };
  knowledgeDifferences: KnowledgeDifference[];
};

export async function diffWorldBranches(engine: WorldEngine, leftBranch: string, rightBranch: string): Promise<WorldBranchDiff> {
  const [leftHead, rightHead] = await Promise.all([
    engine.branches.readHead(leftBranch),
    engine.branches.readHead(rightBranch),
  ]);
  const [leftChain, rightChain, leftState, rightState, leftKnowledge, rightKnowledge] = await Promise.all([
    collectCommitChain(engine, leftHead),
    collectCommitChain(engine, rightHead),
    engine.projector.project(leftHead),
    engine.projector.project(rightHead),
    new KnowledgeProjector(engine).project(leftHead),
    new KnowledgeProjector(engine).project(rightHead),
  ]);
  const leftIds = new Set(leftChain.map((entry) => entry.id));
  const commonAncestor = [...rightChain].reverse().find((entry) => leftIds.has(entry.id))?.id;
  return {
    left: { branch: leftBranch, head: leftHead },
    right: { branch: rightBranch, head: rightHead },
    ...(commonAncestor ? { commonAncestor } : {}),
    stateDifferences: diffWorldStates(leftState, rightState),
    history: {
      leftOnly: await historyAfter(engine, leftChain, commonAncestor),
      rightOnly: await historyAfter(engine, rightChain, commonAncestor),
    },
    knowledgeDifferences: diffKnowledge(leftKnowledge.actors, rightKnowledge.actors),
  };
}

async function collectCommitChain(engine: WorldEngine, head: CommitId) {
  const chain: Array<{ id: CommitId; step: number; eventHashes: string[] }> = [];
  const seen = new Set<string>();
  let cursor: CommitId | undefined = head;
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
    seen.add(cursor);
    const commit = await engine.objects.getCommit(cursor);
    chain.push({ id: cursor, step: commit.logicalTime.step, eventHashes: commit.eventHashes });
    cursor = commit.parentCommitId;
  }
  return chain.reverse();
}

async function historyAfter(
  engine: WorldEngine,
  chain: Array<{ id: CommitId; step: number; eventHashes: string[] }>,
  ancestor?: CommitId,
): Promise<HistoryDifference[]> {
  const start = ancestor ? chain.findIndex((entry) => entry.id === ancestor) + 1 : 0;
  const differences: HistoryDifference[] = [];
  for (const commit of chain.slice(start)) {
    for (const eventHash of commit.eventHashes) {
      const event = await engine.objects.getEvent(eventHash);
      differences.push({ commitId: commit.id, step: commit.step, eventHash, eventId: event.eventId, title: event.title });
    }
  }
  return differences;
}

export function diffWorldStates(left: WorldState, right: WorldState): StateDifference[] {
  const entityIds = new Set([...Object.keys(left.values), ...Object.keys(right.values)]);
  const differences: StateDifference[] = [];
  for (const entityId of [...entityIds].sort()) {
    const leftFields = left.values[entityId] ?? {};
    const rightFields = right.values[entityId] ?? {};
    const fields = new Set([...Object.keys(leftFields), ...Object.keys(rightFields)]);
    for (const field of [...fields].sort()) {
      const leftValue = leftFields[field];
      const rightValue = rightFields[field];
      if (!same(leftValue, rightValue)) differences.push(compact({ entityId, field, left: leftValue, right: rightValue }));
    }
  }
  const leftRules = [...left.activeRuleIds].sort();
  const rightRules = [...right.activeRuleIds].sort();
  if (!same(leftRules, rightRules)) differences.push({ entityId: "$world", field: "activeRuleIds", left: leftRules, right: rightRules });
  return differences;
}

function diffKnowledge(
  left: Record<string, Record<string, KnowledgeFact>>,
  right: Record<string, Record<string, KnowledgeFact>>,
): KnowledgeDifference[] {
  const actorIds = new Set([...Object.keys(left), ...Object.keys(right)]);
  const differences: KnowledgeDifference[] = [];
  for (const actorId of [...actorIds].sort()) {
    const leftFacts = left[actorId] ?? {};
    const rightFacts = right[actorId] ?? {};
    const claimIds = new Set([...Object.keys(leftFacts), ...Object.keys(rightFacts)]);
    for (const claimId of [...claimIds].sort()) {
      const leftFact = leftFacts[claimId];
      const rightFact = rightFacts[claimId];
      if (!same(leftFact, rightFact)) differences.push(compact({ actorId, claimId, left: leftFact, right: rightFact }));
    }
  }
  return differences;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

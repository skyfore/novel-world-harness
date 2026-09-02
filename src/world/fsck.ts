import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "./canonical.js";
import type { WorldEngine } from "./engine.js";
import type { Branch, CommitId } from "./model.js";
import { WorldSnapshotStore } from "./snapshot.js";

export type FsckIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  branchId?: string;
  objectId?: string;
};

export type WorldFsckReport = {
  ok: boolean;
  branches: number;
  reachableCommits: number;
  reachableEvents: number;
  reachableDeltas: number;
  reachableKnowledgeDeltas: number;
  orphanObjects: Record<string, string[]>;
  issues: FsckIssue[];
};

type Reachable = {
  commits: Set<string>;
  events: Set<string>;
  deltas: Set<string>;
  knowledge: Set<string>;
};

export async function fsckWorld(engine: WorldEngine): Promise<WorldFsckReport> {
  const issues: FsckIssue[] = [];
  const reachable: Reachable = {
    commits: new Set(),
    events: new Set(),
    deltas: new Set(),
    knowledge: new Set(),
  };
  const branches = await listBranches(engine, issues);
  const snapshots = new WorldSnapshotStore(path.resolve(engine.objects.root, "../../.."));

  for (const branch of branches) {
    const lock = await engine.branches.inspectLock(branch.id);
    if (lock.present) {
      issues.push((lock.stale ? error : warning)(
        lock.stale ? "STALE_BRANCH_LOCK" : "BRANCH_LOCK_PRESENT",
        `${lock.stale ? "Stale" : "Active"} mutation lock exists for branch ${branch.id}`,
        branch.id,
      ));
    }
    try {
      await auditBranch(engine, branch, reachable, issues);
      const first = await engine.projector.project(branch.headCommitId);
      const second = await engine.projector.project(branch.headCommitId);
      if (contentHash(first) !== contentHash(second)) {
        issues.push(error("NON_DETERMINISTIC_REPLAY", `Branch ${branch.id} projected to different states`, branch.id));
      }
      const snapshot = await snapshots.read(branch.headCommitId);
      if (snapshot && contentHash(snapshot.state) !== contentHash(first)) {
        issues.push(warning("STALE_SNAPSHOT", `Snapshot for ${branch.headCommitId} differs from authoritative replay`, branch.id, branch.headCommitId));
      }
    } catch (cause) {
      issues.push(error("BRANCH_REPLAY_FAILED", cause instanceof Error ? cause.message : String(cause), branch.id));
    }
  }

  for (const branch of branches) {
    if (!branch.parentBranchId || !branch.forkCommitId) continue;
    const parent = branches.find((candidate) => candidate.id === branch.parentBranchId);
    if (!parent) {
      issues.push(error("MISSING_PARENT_BRANCH", `Branch ${branch.id} references missing parent ${branch.parentBranchId}`, branch.id));
      continue;
    }
    try {
      if (!(await isAncestor(engine, branch.forkCommitId, parent.headCommitId))) {
        issues.push(error("INVALID_FORK_POINT", `Fork commit ${branch.forkCommitId} is not in parent branch ${parent.id}`, branch.id, branch.forkCommitId));
      }
    } catch (cause) {
      issues.push(error("FORK_CHECK_FAILED", cause instanceof Error ? cause.message : String(cause), branch.id));
    }
  }

  const objectKinds = ["commits", "events", "deltas", "knowledge"] as const;
  const orphanObjects: Record<string, string[]> = {};
  for (const kind of objectKinds) {
    const all = await listObjectHashes(engine.objects.root, kind);
    const live = reachable[kind];
    const orphans = all.filter((hash) => !live.has(hash));
    orphanObjects[kind] = orphans;
    for (const orphan of orphans) {
      issues.push(warning("ORPHAN_OBJECT", `Unreachable ${kind} object ${orphan}`, undefined, orphan));
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    branches: branches.length,
    reachableCommits: reachable.commits.size,
    reachableEvents: reachable.events.size,
    reachableDeltas: reachable.deltas.size,
    reachableKnowledgeDeltas: reachable.knowledge.size,
    orphanObjects,
    issues,
  };
}

async function auditBranch(engine: WorldEngine, branch: Branch, reachable: Reachable, issues: FsckIssue[]): Promise<void> {
  const seen = new Set<string>();
  let cursor: CommitId | undefined = branch.headCommitId;
  let childStep: number | undefined;
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`Commit ancestry cycle at ${cursor}`);
    seen.add(cursor);
    reachable.commits.add(cursor);
    const commit = await engine.objects.getCommit(cursor);
    if (childStep !== undefined && commit.logicalTime.step !== childStep - 1) {
      issues.push(error(
        "NON_CONTIGUOUS_TIME",
        `Commit ${cursor} step ${commit.logicalTime.step} is not exactly one step before child step ${childStep}`,
        branch.id,
        cursor,
      ));
    }
    childStep = commit.logicalTime.step;
    for (const eventHash of commit.eventHashes) {
      reachable.events.add(eventHash);
      const event = await engine.objects.getEvent(eventHash);
      if (event.logicalTime.step !== commit.logicalTime.step) {
        issues.push(error("EVENT_TIME_MISMATCH", `Event ${eventHash} step ${event.logicalTime.step} differs from commit step ${commit.logicalTime.step}`, branch.id, eventHash));
      }
      let material = Boolean(event.timeAdvance)
        || Boolean(event.spokenUtterances?.length)
        || Boolean(event.progress?.scene)
        || Boolean(event.progress?.outcome);
      if (event.effects.stateDeltaHash) {
        reachable.deltas.add(event.effects.stateDeltaHash);
        const delta = await engine.objects.getDelta(event.effects.stateDeltaHash);
        material ||= delta.operations.length > 0;
      }
      if (event.effects.knowledgeDeltaHash) {
        reachable.knowledge.add(event.effects.knowledgeDeltaHash);
        const delta = await engine.objects.getKnowledgeDelta(event.effects.knowledgeDeltaHash);
        material ||= delta.operations.length > 0;
      }
      if (commit.parentCommitId && !material) {
        issues.push(error(
          "EMPTY_EVENT",
          `Event ${eventHash} has no material effect, utterance, adjudicated outcome, time advancement, or scene beat`,
          branch.id,
          eventHash,
        ));
      }
    }
    cursor = commit.parentCommitId;
  }
}

async function listBranches(engine: WorldEngine, issues: FsckIssue[]): Promise<Branch[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(engine.branches.root, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  const branches: Branch[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) {
      issues.push(warning("UNRECOGNIZED_BRANCH_DIRECTORY", `Ignoring non-branch directory ${entry.name}`, entry.name));
      continue;
    }
    try {
      branches.push(await engine.branches.read(entry.name));
    } catch (cause) {
      issues.push(error(
        "INCOMPLETE_BRANCH",
        `Branch ${entry.name} cannot be read completely: ${cause instanceof Error ? cause.message : String(cause)}`,
        entry.name,
      ));
    }
  }
  return branches;
}

async function listObjectHashes(root: string, kind: string): Promise<string[]> {
  const directory = path.join(root, "objects", kind);
  try {
    return (await fs.readdir(directory))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => name.slice(0, -5))
      .sort();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
}

async function isAncestor(engine: WorldEngine, ancestor: CommitId, descendant: CommitId): Promise<boolean> {
  const seen = new Set<string>();
  let cursor: CommitId | undefined = descendant;
  while (cursor) {
    if (cursor === ancestor) return true;
    if (seen.has(cursor)) throw new Error(`Commit ancestry cycle at ${cursor}`);
    seen.add(cursor);
    cursor = (await engine.objects.getCommit(cursor)).parentCommitId;
  }
  return false;
}

function error(code: string, message: string, branchId?: string, objectId?: string): FsckIssue {
  return { severity: "error", code, message, ...(branchId ? { branchId } : {}), ...(objectId ? { objectId } : {}) };
}
function warning(code: string, message: string, branchId?: string, objectId?: string): FsckIssue {
  return { severity: "warning", code, message, ...(branchId ? { branchId } : {}), ...(objectId ? { objectId } : {}) };
}

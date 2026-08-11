import type { BranchId, CommitId, Predicate, WorldState } from "./model.js";
import { evaluatePredicate } from "./state.js";
import type { Frontier } from "./frontier.js";
import { WorldRuntime } from "./runtime.js";

export type CanonReplayCheckpoint = {
  id: string;
  label: string;
  expected: Predicate[];
};

export type ReplayDiagnostic = {
  checkpointId: string;
  code: "NO_PROGRESS" | "MISSING_PRECONDITION" | "BLOCKED" | "CHECKPOINT_MISMATCH" | "MOVE_LIMIT";
  message: string;
  frontier?: { id: string; status: string; reasons: string[] }[];
};

export type CanonReplayResult = {
  branchId: BranchId;
  startCommit: CommitId;
  endCommit: CommitId;
  matchedCheckpoints: string[];
  diagnostics: ReplayDiagnostic[];
  moves: number;
  passed: boolean;
};

export async function runCanonReplay(
  runtime: WorldRuntime,
  branchId: BranchId,
  checkpoints: readonly CanonReplayCheckpoint[],
  maxMoves = 100,
): Promise<CanonReplayResult> {
  if (!Number.isInteger(maxMoves) || maxMoves <= 0) throw new Error("maxMoves must be a positive integer");
  const startCommit = await runtime.engine.branches.readHead(branchId);
  let head = startCommit;
  let moves = 0;
  let checkpointIndex = 0;
  const matchedCheckpoints: string[] = [];
  const diagnostics: ReplayDiagnostic[] = [];

  while (checkpointIndex < checkpoints.length) {
    const checkpoint = checkpoints[checkpointIndex]!;
    const state = await runtime.engine.projector.project(head);
    if (matchesCheckpoint(state, checkpoint)) {
      matchedCheckpoints.push(checkpoint.id);
      checkpointIndex += 1;
      continue;
    }
    if (moves >= maxMoves) {
      diagnostics.push({ checkpointId: checkpoint.id, code: "MOVE_LIMIT", message: `Replay exceeded ${maxMoves} moves` });
      break;
    }

    const before = head;
    const move = await runtime.move({ branchId, maxBackgroundCandidates: 1 });
    moves += 1;
    head = move.newHead;
    if (head === before) {
      diagnostics.push(diagnoseNoProgress(checkpoint, move.frontier));
      break;
    }
  }

  if (checkpointIndex < checkpoints.length && !diagnostics.length) {
    const checkpoint = checkpoints[checkpointIndex]!;
    diagnostics.push({ checkpointId: checkpoint.id, code: "CHECKPOINT_MISMATCH", message: `Checkpoint ${checkpoint.label} was not reproduced` });
  }

  return {
    branchId,
    startCommit,
    endCommit: head,
    matchedCheckpoints,
    diagnostics,
    moves,
    passed: checkpointIndex === checkpoints.length,
  };
}

export async function verifyHistoryReplay(runtime: WorldRuntime, commitId: CommitId): Promise<boolean> {
  const first = await runtime.engine.projector.project(commitId);
  const second = await runtime.engine.projector.project(commitId);
  return JSON.stringify(first) === JSON.stringify(second);
}

function matchesCheckpoint(state: WorldState, checkpoint: CanonReplayCheckpoint): boolean {
  return checkpoint.expected.every((predicate) => evaluatePredicate(state, predicate));
}

function diagnoseNoProgress(checkpoint: CanonReplayCheckpoint, frontier: Frontier): ReplayDiagnostic {
  const compact = frontier.evaluated.map((entry) => ({
    id: entry.possibility.id,
    status: entry.status,
    reasons: entry.reasons,
  }));
  if (frontier.evaluated.some((entry) => entry.status === "blocked")) {
    return {
      checkpointId: checkpoint.id,
      code: "BLOCKED",
      message: `No progress toward ${checkpoint.label}; candidate developments are blocked`,
      frontier: compact,
    };
  }
  if (frontier.evaluated.some((entry) => entry.status === "latent")) {
    return {
      checkpointId: checkpoint.id,
      code: "MISSING_PRECONDITION",
      message: `No progress toward ${checkpoint.label}; candidate preconditions are not satisfied`,
      frontier: compact,
    };
  }
  return {
    checkpointId: checkpoint.id,
    code: "NO_PROGRESS",
    message: `No eligible development can advance toward ${checkpoint.label}`,
    frontier: compact,
  };
}

import fs from "node:fs/promises";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { contentHash } from "./canonical.js";
import type { BranchId, CommitId, EventProposal, EvidenceRef, Possibility, StoryTime, WorldState } from "./model.js";
import { evaluatePredicate } from "./state.js";
import { comparableStoryTime } from "./time.js";

export type PossibilityStatus = "latent" | "eligible" | "blocked" | "expired" | "superseded" | "invalidated" | "realized";
export type SchedulerFactors = { urgency: number; causalSupport: number; actorPressure: number; runtimeRelevance: number; conditionStrength: number; canonAffinity: number };
export type EvaluatedPossibility = { possibility: Possibility; status: PossibilityStatus; reasons: string[]; factors: SchedulerFactors; score: number };
export type FrontierTemporalMode = "current-window" | "advance";
export type Frontier = {
  version: 1;
  branchId: BranchId;
  commitId: CommitId;
  temporalMode: FrontierTemporalMode;
  evaluated: EvaluatedPossibility[];
};

type FrontierEvaluationOptions = {
  realizedIds?: ReadonlySet<string>;
  supersededIds?: ReadonlySet<string>;
  canonAffinity?: number;
  temporalMode?: FrontierTemporalMode;
  temporalAnchor?: StoryTime;
  activeEntityIds?: ReadonlySet<string>;
  rootEvidenceSupported?: boolean;
};

export function evaluatePossibility(state: WorldState, possibility: Possibility, options: FrontierEvaluationOptions = {}): EvaluatedPossibility {
  const reasons: string[] = [];
  const unresolvedParents = possibility.causalParents.filter((parent) =>
    !options.realizedIds?.has(parent) && !options.realizedIds?.has(`canon-${parent}`),
  );
  const causalParentsSatisfied = unresolvedParents.length === 0;
  const temporal = assessTemporalCompatibility(
    options.temporalAnchor ?? state.logicalTime.storyTime,
    possibility.candidateWindow,
    options.temporalMode ?? "current-window",
    possibility.causalParents.length > 0,
    !possibility.canonicalEventId && possibility.kind !== "canon-analogue",
  );
  const rootSceneSupported = !possibility.canonicalEventId
    || possibility.causalParents.length > 0
    || possibility.preconditions.length > 0
    || options.rootEvidenceSupported === true
    || (options.rootEvidenceSupported === undefined && (
      options.activeEntityIds === undefined
      || possibility.participants.some((participant) => options.activeEntityIds!.has(participant))
    ));
  let status: PossibilityStatus;
  if (options.realizedIds?.has(possibility.id)) {
    status = "realized";
    reasons.push("linked event is committed");
  } else if (options.supersededIds?.has(possibility.id)) {
    status = "superseded";
    reasons.push("replaced by another committed development");
  } else if (possibility.causalParents.some((parent) => possibilityIdAliases(parent).some((id) => options.supersededIds?.has(id)))) {
    status = "invalidated";
    reasons.push("a required causal parent was replaced by branch history");
  } else if (possibility.expiry?.some((predicate) => evaluatePredicate(state, predicate))) {
    status = "expired";
    reasons.push("an expiry condition is true");
  } else {
    const activeBlockers = possibility.blockers.filter((predicate) => evaluatePredicate(state, predicate));
    if (activeBlockers.length) {
      status = "blocked";
      reasons.push(`${activeBlockers.length} blocker(s) are active`);
    } else if (!causalParentsSatisfied) {
      status = "latent";
      reasons.push(`waiting for causal parent(s): ${unresolvedParents.join(", ")}`);
    } else {
      const satisfied = possibility.preconditions.filter((predicate) => evaluatePredicate(state, predicate)).length;
      if (satisfied === possibility.preconditions.length && temporal.allowed && rootSceneSupported) {
        status = "eligible";
        reasons.push("all preconditions and causal dependencies are satisfied");
        if (temporal.reason) reasons.push(temporal.reason);
      } else if (satisfied === possibility.preconditions.length && !rootSceneSupported) {
        status = "latent";
        reasons.push("root canonical development has no participant, condition, or causal support in the active scene");
      } else if (satisfied === possibility.preconditions.length) {
        status = "latent";
        reasons.push(temporal.reason ?? "candidate time is outside the active scene window");
      } else {
        status = "latent";
        reasons.push(`${satisfied}/${possibility.preconditions.length} preconditions are satisfied`);
      }
    }
  }
  const conditionStrength = possibility.preconditions.length ? possibility.preconditions.filter((predicate) => evaluatePredicate(state, predicate)).length / possibility.preconditions.length : 1;
  const factors: SchedulerFactors = {
    urgency: 1,
    causalSupport: possibility.causalParents.length ? (causalParentsSatisfied ? 1 : 0) : 0.8,
    actorPressure: clampFactor(possibility.pressure),
    runtimeRelevance: clampFactor(possibility.relevance),
    conditionStrength,
    canonAffinity: possibility.canonicalEventId ? clampFactor(options.canonAffinity ?? 1) : 1,
  };
  const score = status === "eligible" ? Object.values(factors).reduce((product, factor) => product * factor, 1) : 0;
  return { possibility, status, reasons, factors, score };
}

export function buildFrontier(branchId: BranchId, commitId: CommitId, state: WorldState, templates: readonly Possibility[], options: {
  realizedIds?: ReadonlySet<string>;
  supersededIds?: ReadonlySet<string>;
  canonAffinity?: ReadonlyMap<string, number>;
  temporalMode?: FrontierTemporalMode;
  temporalAnchor?: StoryTime;
  activeEntityIds?: ReadonlySet<string>;
  activeEvidence?: readonly EvidenceRef[];
} = {}): Frontier {
  const rootEvidenceSupport = canonicalRootEvidenceSupport(templates, options.activeEvidence);
  const evaluated = templates.map((template) => {
    const possibility: Possibility = { ...template, branchId, evaluatedAtCommit: commitId };
    return evaluatePossibility(state, possibility, {
      realizedIds: options.realizedIds,
      supersededIds: options.supersededIds,
      canonAffinity: possibility.canonicalEventId ? options.canonAffinity?.get(possibility.canonicalEventId) : undefined,
      temporalMode: options.temporalMode,
      temporalAnchor: options.temporalAnchor,
      activeEntityIds: options.activeEntityIds,
      rootEvidenceSupported: rootEvidenceSupport.get(possibility.id),
    });
  });
  propagateInvalidatedDescendants(evaluated);
  evaluated.sort((left, right) => {
    if (options.temporalMode === "advance" && left.status === "eligible" && right.status === "eligible") {
      const leftOrder = temporalOrder(left.possibility.candidateWindow);
      const rightOrder = temporalOrder(right.possibility.candidateWindow);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    }
    return right.score - left.score || left.possibility.id.localeCompare(right.possibility.id);
  });
  return { version: 1, branchId, commitId, temporalMode: options.temporalMode ?? "current-window", evaluated };
}

/**
 * Disconnected root canon must not all become "now" merely because a recurring
 * protagonist is active.  Anchor root events to committed source evidence; on
 * legacy branches whose genesis carried no evidence, expose only the earliest
 * source window. Causally linked and state-gated events are handled separately
 * by the normal frontier rules.
 */
function canonicalRootEvidenceSupport(
  templates: readonly Possibility[],
  activeEvidence: readonly EvidenceRef[] | undefined,
): ReadonlyMap<string, boolean> {
  const anchors = new Map<string, number>();
  for (const reference of activeEvidence ?? []) {
    anchors.set(
      reference.span.sourceId,
      Math.max(anchors.get(reference.span.sourceId) ?? Number.NEGATIVE_INFINITY, reference.span.endLine),
    );
  }
  const earliest = new Map<string, number>();
  for (const possibility of templates) {
    if (!possibility.canonicalEventId || possibility.causalParents.length || possibility.preconditions.length) continue;
    for (const reference of possibility.evidence) {
      earliest.set(
        reference.span.sourceId,
        Math.min(earliest.get(reference.span.sourceId) ?? Number.POSITIVE_INFINITY, reference.span.startLine),
      );
    }
  }
  const result = new Map<string, boolean>();
  for (const possibility of templates) {
    if (!possibility.canonicalEventId || possibility.causalParents.length || possibility.preconditions.length) continue;
    // Hand-built engine contexts and legacy tests may contain ungrounded
    // canonical fixtures. They cannot participate in source-window ordering,
    // so preserve the older active-participant gate for those records.
    if (!possibility.evidence.length) continue;
    result.set(possibility.id, possibility.evidence.some((reference) => {
      const anchor = anchors.get(reference.span.sourceId);
      if (anchor !== undefined) return reference.span.startLine <= anchor;
      return reference.span.startLine === earliest.get(reference.span.sourceId);
    }));
  }
  return result;
}

export function selectEligible(frontier: Frontier, limit = 10, options: { includePlayerChoices?: boolean } = {}): EvaluatedPossibility[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("Scheduler limit must be a non-negative integer");
  return frontier.evaluated
    .filter((entry) => entry.status === "eligible" && (options.includePlayerChoices || !["player-choice", "actor-plan"].includes(entry.possibility.kind)))
    .slice(0, limit);
}

export function possibilityToProposal(entry: EvaluatedPossibility, actorId?: string): EventProposal | null {
  const possibility = entry.possibility;
  const proposedDelta = possibility.proposedDelta;
  if (entry.status !== "eligible" || !proposedDelta) return null;
  return {
    proposalId: `poss-${contentHash({ id: possibility.id, at: possibility.evaluatedAtCommit }).slice(0, 24)}`,
    branchId: possibility.branchId,
    expectedParentCommit: possibility.evaluatedAtCommit,
    source: possibility.kind === "canon-analogue" ? "canon-candidate" : actorId ? "actor" : "background",
    ...(actorId ? { actorId } : {}),
    title: possibility.title,
    participants: possibility.participants,
    proposedTime: possibility.candidateWindow ?? { kind: "unknown" },
    ...(possibility.timeAdvance ? { timeAdvance: possibility.timeAdvance } : {}),
    preconditions: possibility.preconditions,
    proposedDelta,
    ...(possibility.proposedKnowledge ? { proposedKnowledge: possibility.proposedKnowledge } : {}),
    causalParents: possibility.causalParents,
    evidence: possibility.evidence,
    possibilityId: possibility.id,
  };
}

export class FrontierStore {
  readonly root: string;
  constructor(workspaceRoot: string) { this.root = path.join(workspaceStateDir(workspaceRoot), "world", "v1", "frontier"); }
  async write(frontier: Frontier): Promise<void> {
    const filePath = this.filePath(frontier.branchId, frontier.commitId, frontier.temporalMode);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(frontier, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
  }
  async read(
    branchId: BranchId,
    commitId: CommitId,
    temporalMode: FrontierTemporalMode = "current-window",
  ): Promise<Frontier | null> {
    try { return JSON.parse(await fs.readFile(this.filePath(branchId, commitId, temporalMode), "utf8")) as Frontier; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (temporalMode !== "current-window") return null;
      // Read-only compatibility with the pre-temporal-mode cache layout.
      try {
        const legacy = JSON.parse(await fs.readFile(this.legacyFilePath(branchId, commitId), "utf8")) as Omit<Frontier, "temporalMode">;
        return { ...legacy, temporalMode: "current-window" };
      } catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw legacyError;
      }
    }
  }
  private filePath(branchId: BranchId, commitId: CommitId, temporalMode: FrontierTemporalMode): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branchId)) throw new Error(`Invalid branch id: ${branchId}`);
    if (!/^[a-f0-9]{64}$/.test(commitId)) throw new Error(`Invalid commit id: ${commitId}`);
    return path.join(this.root, branchId, `${commitId}.${temporalMode}.json`);
  }
  private legacyFilePath(branchId: BranchId, commitId: CommitId): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branchId)) throw new Error(`Invalid branch id: ${branchId}`);
    if (!/^[a-f0-9]{64}$/.test(commitId)) throw new Error(`Invalid commit id: ${commitId}`);
    return path.join(this.root, branchId, `${commitId}.json`);
  }
}
function clampFactor(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }

function assessTemporalCompatibility(
  current: StoryTime | undefined,
  candidate: StoryTime | undefined,
  mode: FrontierTemporalMode,
  causallySupported: boolean,
  unwindowedIsImmediate: boolean,
): { allowed: boolean; reason?: string } {
  const currentRange = comparableStoryTime(current);
  const candidateRange = comparableStoryTime(candidate);
  if (!currentRange) return { allowed: true };
  if (!candidateRange || candidateRange.scale !== currentRange.scale) {
    return causallySupported
      ? { allowed: true, reason: "candidate time is admitted by an already-realized causal parent" }
      : unwindowedIsImmediate && !candidate
        ? { allowed: true, reason: "an unwindowed non-canonical development is treated as immediate" }
      : { allowed: false, reason: "candidate time cannot be placed safely relative to the active scene" };
  }
  if (candidateRange.max < currentRange.min) {
    return { allowed: false, reason: "candidate window is earlier than committed branch time" };
  }
  if (mode === "current-window" && candidateRange.min > currentRange.max) {
    return { allowed: false, reason: "candidate window is later than the active scene; explicit time advancement is required" };
  }
  return {
    allowed: true,
    reason: candidateRange.min > currentRange.max
      ? "candidate is the earliest eligible forward development"
      : "candidate window overlaps committed branch time",
  };
}

function temporalOrder(time: StoryTime | undefined): number {
  return comparableStoryTime(time)?.min ?? Number.POSITIVE_INFINITY;
}

function possibilityIdAliases(id: string): string[] {
  return id.startsWith("canon-") ? [id, id.slice("canon-".length)] : [id, `canon-${id}`];
}

function propagateInvalidatedDescendants(evaluated: EvaluatedPossibility[]): void {
  const byId = new Map<string, EvaluatedPossibility>();
  for (const entry of evaluated) {
    byId.set(entry.possibility.id, entry);
    if (entry.possibility.canonicalEventId) byId.set(entry.possibility.canonicalEventId, entry);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of evaluated) {
      if (["realized", "superseded", "expired", "invalidated"].includes(entry.status)) continue;
      const invalidParent = entry.possibility.causalParents
        .map((parent) => byId.get(parent) ?? byId.get(`canon-${parent}`))
        .find((parent) => parent && ["superseded", "expired", "invalidated"].includes(parent.status));
      if (!invalidParent) continue;
      entry.status = "invalidated";
      entry.score = 0;
      entry.reasons = [`required causal parent ${invalidParent.possibility.id} is ${invalidParent.status}`];
      changed = true;
    }
  }
}

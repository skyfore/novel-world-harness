import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "./canonical.js";
import type { BranchId, CommitId, EventProposal, Possibility, WorldState } from "./model.js";
import { evaluatePredicate } from "./state.js";

export type PossibilityStatus = "latent" | "eligible" | "blocked" | "expired" | "superseded" | "realized";
export type SchedulerFactors = { urgency: number; causalSupport: number; actorPressure: number; runtimeRelevance: number; conditionStrength: number; canonAffinity: number };
export type EvaluatedPossibility = { possibility: Possibility; status: PossibilityStatus; reasons: string[]; factors: SchedulerFactors; score: number };
export type Frontier = { version: 1; branchId: BranchId; commitId: CommitId; evaluated: EvaluatedPossibility[] };

export function evaluatePossibility(state: WorldState, possibility: Possibility, options: { realizedIds?: ReadonlySet<string>; supersededIds?: ReadonlySet<string>; canonAffinity?: number } = {}): EvaluatedPossibility {
  const reasons: string[] = [];
  const canonicalParentsSatisfied = possibility.kind !== "canon-analogue" || possibility.causalParents.every((parent) => options.realizedIds?.has(`canon-${parent}`));
  let status: PossibilityStatus;
  if (options.realizedIds?.has(possibility.id)) {
    status = "realized";
    reasons.push("linked event is committed");
  } else if (options.supersededIds?.has(possibility.id)) {
    status = "superseded";
    reasons.push("replaced by another committed development");
  } else if (possibility.expiry?.some((predicate) => evaluatePredicate(state, predicate))) {
    status = "expired";
    reasons.push("an expiry condition is true");
  } else {
    const activeBlockers = possibility.blockers.filter((predicate) => evaluatePredicate(state, predicate));
    if (activeBlockers.length) {
      status = "blocked";
      reasons.push(`${activeBlockers.length} blocker(s) are active`);
    } else if (!canonicalParentsSatisfied) {
      status = "latent";
      const unresolved = possibility.causalParents.filter((parent) => !options.realizedIds?.has(`canon-${parent}`));
      reasons.push(`waiting for canonical causal parent(s): ${unresolved.join(", ")}`);
    } else {
      const satisfied = possibility.preconditions.filter((predicate) => evaluatePredicate(state, predicate)).length;
      if (satisfied === possibility.preconditions.length) {
        status = "eligible";
        reasons.push("all preconditions and causal dependencies are satisfied");
      } else {
        status = "latent";
        reasons.push(`${satisfied}/${possibility.preconditions.length} preconditions are satisfied`);
      }
    }
  }
  const conditionStrength = possibility.preconditions.length ? possibility.preconditions.filter((predicate) => evaluatePredicate(state, predicate)).length / possibility.preconditions.length : 1;
  const factors: SchedulerFactors = {
    urgency: 1,
    causalSupport: possibility.causalParents.length ? (canonicalParentsSatisfied ? 1 : 0) : 0.8,
    actorPressure: clampFactor(possibility.pressure),
    runtimeRelevance: clampFactor(possibility.relevance),
    conditionStrength,
    canonAffinity: possibility.canonicalEventId ? clampFactor(options.canonAffinity ?? 1) : 1,
  };
  const score = status === "eligible" ? Object.values(factors).reduce((product, factor) => product * factor, 1) : 0;
  return { possibility, status, reasons, factors, score };
}

export function buildFrontier(branchId: BranchId, commitId: CommitId, state: WorldState, templates: readonly Possibility[], options: { realizedIds?: ReadonlySet<string>; supersededIds?: ReadonlySet<string>; canonAffinity?: ReadonlyMap<string, number> } = {}): Frontier {
  const evaluated = templates.map((template) => {
    const possibility: Possibility = { ...template, branchId, evaluatedAtCommit: commitId };
    return evaluatePossibility(state, possibility, { realizedIds: options.realizedIds, supersededIds: options.supersededIds, canonAffinity: possibility.canonicalEventId ? options.canonAffinity?.get(possibility.canonicalEventId) : undefined });
  }).sort((left, right) => right.score - left.score || left.possibility.id.localeCompare(right.possibility.id));
  return { version: 1, branchId, commitId, evaluated };
}

export function selectEligible(frontier: Frontier, limit = 10, options: { includePlayerChoices?: boolean } = {}): EvaluatedPossibility[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("Scheduler limit must be a non-negative integer");
  return frontier.evaluated
    .filter((entry) => entry.status === "eligible" && (options.includePlayerChoices || entry.possibility.kind !== "player-choice"))
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
  constructor(workspaceRoot: string) { this.root = path.join(workspaceRoot, ".novel-harness", "world", "v1", "frontier"); }
  async write(frontier: Frontier): Promise<void> {
    const filePath = this.filePath(frontier.branchId, frontier.commitId);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(frontier, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
  }
  async read(branchId: BranchId, commitId: CommitId): Promise<Frontier | null> {
    try { return JSON.parse(await fs.readFile(this.filePath(branchId, commitId), "utf8")) as Frontier; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private filePath(branchId: BranchId, commitId: CommitId): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branchId)) throw new Error(`Invalid branch id: ${branchId}`);
    if (!/^[a-f0-9]{64}$/.test(commitId)) throw new Error(`Invalid commit id: ${commitId}`);
    return path.join(this.root, branchId, `${commitId}.json`);
  }
}
function clampFactor(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }

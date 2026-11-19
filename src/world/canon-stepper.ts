import { canonPositionFor, expandTimelineAliases, type CanonTimeline } from "./canon-timeline.js";
import type { WorldEngine } from "./engine.js";
import { possibilityToProposal, type Frontier } from "./frontier.js";
import { eventAvailableToActor, type CanonicalEvent, type CommitId, type EventParticipation } from "./model.js";
import { branchCanonResolution } from "./read-horizon.js";

/** Who a canonical beat belongs to, from the current player's point of view. */
export type CanonBeatKind = "offscreen" | "world" | "player" | "unattributed";

export type CanonStepPolicy = {
  /** Maximum canonical events committed by one step (D4: 3 per turn, 8 when waiting or changing scene). */
  budget: number;
  /** Maximum world beats (others acting where the player can take part) per step (D4: 1). */
  worldBeatBudget: number;
  /** Accepted player turns a player beat may wait at the front before it is passed (D4: 3). */
  patience?: number;
  /** The player chose to wait this turn: their own beats pass on. */
  playerWaited?: boolean;
  /** The player left the scene this turn: their own beats pass on. */
  playerLeftScene?: boolean;
};

export type CanonStepInput = CanonStepPolicy & { branchId: string; actorId: string; expectedHead: CommitId };

export type CanonStepResult = {
  newHead: CommitId;
  committed: string[];
  passedPlayerBeats: string[];
  /** idle: unresolved canon remains below the horizon but none of it is feasible right now. */
  stoppedAt: "awaiting-player" | "budget" | "beyond-horizon" | "exhausted" | "idle";
  awaitingEventId?: string;
  position: number;
};

export const DEFAULT_CANON_STEP_POLICY = { budget: 3, waitBudget: 8, worldBeatBudget: 1, patience: 3 } as const;

/** Agents of a canonical event: the schema-bound initiator, else typed agent participations. */
export function canonEventAgents(event: CanonicalEvent, participations: readonly EventParticipation[], initiatorRoles: ReadonlyMap<string, string> = new Map()): string[] {
  if (event.action?.lane === "schema-bound") {
    const role = initiatorRoles.get(event.action.schemaId);
    const initiator = event.action.roleBindings.find((binding) => binding.roleId === role)?.entityIds ?? [];
    if (initiator.length) return [...initiator];
  }
  return [...new Set(participations.filter((item) => item.eventId === event.id && item.role === "agent").map((item) => item.entityId))].sort();
}

export function classifyCanonBeat(event: CanonicalEvent, actorId: string, agents: readonly string[]): CanonBeatKind {
  if (!eventAvailableToActor(event, actorId)) return "offscreen";
  if (agents.includes(actorId)) return "player";
  return agents.length ? "world" : "unattributed";
}

export type CanonStepDependencies = {
  engine: WorldEngine;
  refreshFrontier: (branchId: string, commitId: CommitId) => Promise<Frontier>;
};

/**
 * Resolve canonical events in timeline order. Offscreen developments that are
 * feasible happen on their own; others' beats around the player happen when
 * their physical participants share the player's place (bounded per step);
 * the player's own beats wait for the player, unless patience runs out, the
 * player waits, or the player has left. Infeasible or invalidated events are
 * skipped and expire once a later event commits. Canon is gravity, not a
 * scheduler: only events whose conditions and necessary causes hold commit.
 */
export async function stepCanon(deps: CanonStepDependencies, input: CanonStepInput): Promise<CanonStepResult> {
  const { engine } = deps;
  let head = input.expectedHead;
  const branchHead = await engine.branches.readHead(input.branchId);
  if (branchHead !== head) throw new Error(`Canon step expected head '${head}', found '${branchHead}'.`);
  const context = await engine.contextForCommit(head);
  const timeline = context.timeline;
  const committed: string[] = [], passedPlayerBeats: string[] = [];
  if (!timeline) return { newHead: head, committed, passedPlayerBeats, stoppedAt: "exhausted", position: 0 };
  const events = context.events ?? new Map<string, CanonicalEvent>();
  const participations = context.eventParticipations ?? [];
  const initiatorRoles = new Map([...(context.actionSchemas?.values() ?? [])].map((schema) => [schema.id, schema.initiatorRoleId]));
  const horizon = Math.min(timeline.entries.length, context.canonHorizonIndex ?? timeline.entries.length);
  const patience = input.patience ?? DEFAULT_CANON_STEP_POLICY.patience;
  let worldBeats = 0;
  const skipped = new Set<string>();

  for (;;) {
    const projection = await engine.projections.project(head);
    const resolution = branchCanonResolution(projection.history.map((entry) => entry.event));
    const settled = expandTimelineAliases(timeline, [...resolution.resolved, ...resolution.superseded]);
    const position = canonPositionFor(timeline, settled);
    const done = (stoppedAt: CanonStepResult["stoppedAt"], awaitingEventId?: string): CanonStepResult =>
      ({ newHead: head, committed, passedPlayerBeats, stoppedAt, ...(awaitingEventId ? { awaitingEventId } : {}), position });
    if (committed.length >= input.budget) return done("budget");
    const frontier = await deps.refreshFrontier(input.branchId, head);
    const byEvent = new Map(frontier.evaluated.flatMap((entry) => entry.possibility.canonicalEventId && entry.possibility.canonicalOrder !== undefined ? [[entry.possibility.canonicalEventId, entry] as const] : []));
    let progressed = false;
    for (const entry of timeline.entries) {
      if (entry.index < position || settled.has(entry.eventId) || skipped.has(entry.eventId)) continue;
      if (entry.index >= horizon) return done("beyond-horizon");
      const event = events.get(entry.eventId);
      const evaluated = byEvent.get(entry.eventId);
      if (!event || !evaluated || !steppable(evaluated)) { skipped.add(entry.eventId); continue; }
      const beat = classifyCanonBeat(event, input.actorId, canonEventAgents(event, participations, initiatorRoles));
      if (beat === "unattributed") { skipped.add(entry.eventId); continue; }
      if (beat === "player") {
        const waitedTurns = playerTurnsSinceCanonMoved(projection.history.map((item) => item.event), input.actorId);
        if (input.playerWaited || input.playerLeftScene || waitedTurns >= patience) {
          passedPlayerBeats.push(entry.eventId);
          skipped.add(entry.eventId);
          continue;
        }
        return done("awaiting-player", entry.eventId);
      }
      if (beat === "world") {
        if (worldBeats >= input.worldBeatBudget || !sharesPlayerPlace(event, input.actorId, projection.state.values)) { skipped.add(entry.eventId); continue; }
      }
      // The engine re-validates the proposal; the stepper only vouches for order.
      const proposal = possibilityToProposal({ ...evaluated, status: "eligible" });
      if (!proposal) { skipped.add(entry.eventId); continue; }
      const result = await engine.commitProposal({ ...proposal, proposalId: `canon-step-${entry.eventId}-${head.slice(0, 12)}` });
      if (!result.report.accepted) { skipped.add(entry.eventId); continue; }
      head = result.newHead;
      committed.push(entry.eventId);
      if (beat === "world") worldBeats += 1;
      progressed = true;
      break;
    }
    if (!progressed) {
      const live = timeline.entries.some((entry) => entry.index >= position && entry.index < horizon && !settled.has(entry.eventId)
        && !["expired", "invalidated", "superseded"].includes(byEvent.get(entry.eventId)?.status ?? "invalidated"));
      return done(live ? "idle" : horizon < timeline.entries.length ? "beyond-horizon" : "exhausted");
    }
  }
}

/**
 * Feasible for the stepper: eligible, or latent only because the root-scene
 * heuristic did not place it in the active scene. The stepper enforces
 * timeline order itself, so an unattributed front cannot stall later canon.
 */
function steppable(entry: Frontier["evaluated"][number]): boolean {
  if (entry.status === "eligible") return true;
  if (entry.status !== "latent") return false;
  const failed = entry.trace.gates.filter((gate) => gate.outcome === "fail");
  return failed.length > 0 && failed.every((gate) => gate.gate === "scene");
}

/** Player-authored commits since the canonical position last moved (or Genesis). */
function playerTurnsSinceCanonMoved(history: ReadonlyArray<{ actorId?: string; realizesCanonicalEventIds?: readonly string[]; supersedesCanonicalEventIds?: readonly string[]; canonicalAdaptation?: unknown }>, actorId: string): number {
  let turns = 0;
  for (let index = history.length - 1; index >= 1; index--) {
    const event = history[index]!;
    if (event.realizesCanonicalEventIds?.length || event.supersedesCanonicalEventIds?.length || event.canonicalAdaptation) break;
    if (event.actorId === actorId) turns += 1;
  }
  return turns;
}

/** Every bodily participant other than the player is where the player is. */
function sharesPlayerPlace(event: CanonicalEvent, actorId: string, values: Record<string, Record<string, unknown>>): boolean {
  const here = values[actorId]?.["character.location"];
  if (typeof here !== "string") return false;
  const others = (event.participantPresence ?? [])
    .filter((item) => item.entityId !== actorId && item.mode === "physical")
    .map((item) => item.entityId);
  return others.every((id) => values[id]?.["character.location"] === here);
}

/** Where the branch stands relative to canon; never a silent stall. */
export type CanonStatus = {
  status: "following" | "diverged" | "beyond-horizon" | "exhausted";
  position: number;
  total: number;
  horizonIndex: number;
  diverged: boolean;
};

/**
 * exhausted: no unresolved canonical event remains; beyond-horizon: the next
 * unresolved event lies beyond the admission horizon; diverged: the branch
 * superseded canon (later prose describes a parallel history); else following.
 */
export function deriveCanonStatus(timeline: CanonTimeline, history: Parameters<typeof branchCanonResolution>[0], horizonIndex = timeline.entries.length): CanonStatus {
  const resolution = branchCanonResolution(history);
  const settled = expandTimelineAliases(timeline, [...resolution.resolved, ...resolution.superseded]);
  const position = canonPositionFor(timeline, settled);
  const horizon = Math.min(horizonIndex, timeline.entries.length);
  const next = timeline.entries.find((entry) => entry.index >= position && !settled.has(entry.eventId));
  const diverged = resolution.superseded.size > 0;
  const status = !next ? "exhausted" : next.index >= horizon ? "beyond-horizon" : diverged ? "diverged" : "following";
  return { status, position, total: timeline.entries.length, horizonIndex: horizon, diverged };
}

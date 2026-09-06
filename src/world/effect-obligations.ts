import type { WorldModelContext } from "./engine.js";
import type { EventProposal, ValidationIssue, WorldState } from "./model.js";
import { canonicalJson } from "./canonical.js";
import { findSpatialRoute, resolveActiveSpatialRelations, validateActiveSpatialTopology } from "./spatial-ontology.js";

/** Validate actual effects at the final boundary; intent labels never enable this gate. */
export function validateEffectObligations(input: {
  proposal: Pick<EventProposal, "actorId" | "source" | "action">;
  before: WorldState;
  effectBaseline?: WorldState;
  after: WorldState;
  context: WorldModelContext;
  realizedCanonicalEventIds?: ReadonlySet<string>;
}): ValidationIssue[] {
  const { proposal, before, after, context } = input;
  const effectBaseline = input.effectBaseline ?? before;
  const issues: ValidationIssue[] = [];
  if (proposal.actorId && (proposal.source === "player" || proposal.source === "actor") && proposal.action?.lane !== "schema-bound") {
    for (const [entityId, fields] of Object.entries(after.values)) for (const field of new Set([...Object.keys(fields), ...Object.keys(effectBaseline.values[entityId] ?? {})])) {
      if (canonicalJson(fields[field] ?? null) === canonicalJson(effectBaseline.values[entityId]?.[field] ?? null)) continue;
      // These are actor-controlled intent, or movement validated against an actual route below.
      const intent = entityId === proposal.actorId && ["character.plan", "character.momentum"].includes(field);
      const travel = entityId === proposal.actorId && field === "character.location" && context.spatialOntologyVersion === "spatial-v1";
      if (!intent && !travel) issues.push({ code: "ACTOR_EFFECT_REQUIRES_MECHANISM", message: `Changing ${field} requires a bound, validated executable action schema; an action name or matching footprint is not authority`, path: `proposedDelta.${entityId}.${field}` });
    }
    if (canonicalJson(before.activeRuleIds) !== canonicalJson(after.activeRuleIds)) issues.push({ code: "ACTOR_RULE_EFFECT_REQUIRES_MECHANISM", message: "An actor cannot change active world rules through an ad-hoc action" });
  }
  if (context.spatialOntologyVersion !== "spatial-v1") return issues;
  const relations = resolveActiveSpatialRelations(context.spatialRelations ?? [], {
    state: before, realizedCanonicalEventIds: input.realizedCanonicalEventIds ?? new Set(),
  });
  issues.push(...validateActiveSpatialTopology(relations));
  for (const entity of context.entities.values()) {
    if (entity.kind !== "character") continue;
    const from = before.values[entity.id]?.["character.location"];
    const to = after.values[entity.id]?.["character.location"];
    if (from === to) continue;
    const path = `proposedDelta.${entity.id}.character.location`;
    const reject = (code: string, message: string) => issues.push({ code: `SPATIAL_${code}`, message, path });
    if (typeof from !== "string" || typeof to !== "string") {
      reject("LOCATION_REQUIRED", "A physical location change requires a known origin and destination; an unset location cannot authorize travel.");
      continue;
    }
    const mode = proposal.action?.travelMode;
    if (!mode) {
      reject("MODE_REQUIRED", "A physical location change requires action.travelMode, including host and canonical proposals.");
      continue;
    }
    const route = findSpatialRoute(relations, from, to, mode);
    if (!route) {
      reject("ROUTE_UNPROVEN", `No active ${mode} route permits the proposed physical movement.`);
      continue;
    }
    const elapsed = (after.logicalTime.elapsedDays ?? 0) - (before.logicalTime.elapsedDays ?? 0);
    if (route.minimumDurationDays !== undefined && elapsed + Number.EPSILON < route.minimumDurationDays) {
      reject("TRAVEL_TOO_FAST", "The proposed movement is faster than the route's minimum duration.");
    }
  }
  return issues;
}

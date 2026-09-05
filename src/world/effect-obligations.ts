import type { WorldModelContext } from "./engine.js";
import type { EventProposal, ValidationIssue, WorldState } from "./model.js";
import { findSpatialRoute, resolveActiveSpatialRelations, validateActiveSpatialTopology } from "./spatial-ontology.js";

/** Validate actual effects at the final boundary; intent labels never enable this gate. */
export function validateEffectObligations(input: {
  proposal: EventProposal;
  before: WorldState;
  after: WorldState;
  context: WorldModelContext;
  realizedCanonicalEventIds?: ReadonlySet<string>;
}): ValidationIssue[] {
  const { proposal, before, after, context } = input;
  if (context.spatialOntologyVersion !== "spatial-v1") return [];
  const relations = resolveActiveSpatialRelations(context.spatialRelations ?? [], {
    state: before, realizedCanonicalEventIds: input.realizedCanonicalEventIds ?? new Set(),
  });
  const issues = validateActiveSpatialTopology(relations);
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

import { spatialRelationSchema } from "../../src/world/spatial-ontology.js";
import { CanonicalModelStore } from "../../src/world/canonical-model.js";
import type { ActionInvocation, EvidenceRef } from "../../src/world/model.js";
import { createEvidenceFixture } from "./evidence.js";

/** In-memory rule tests use an explicit route; this is not source recall evidence. */
export function routeContext(fromLocationId: string, toLocationId: string) {
  return { spatialOntologyVersion: "spatial-v1" as const, spatialRelations: [spatialRelationSchema.parse({ ontologyVersion: "spatial-v1", id: "test-route", kind: "route", fromLocationId, toLocationId,
    direction: "two-way", modes: ["foot"], duration: { minimum: 1, unit: "minute" }, basis: "explicit", visibility: "public", knownByClaimIds: [], status: "supported", confidence: 1,
    evidence: [{ span: { sourceId: "novel", startByte: 0, endByte: 4, startLine: 1, endLine: 1, quoteHash: "a".repeat(64) }, strength: "explicit" }] })] };
}

export const hallCampWalkAction: ActionInvocation = {
  lane: "ad-hoc", actionKindId: "walk", description: "Walk from the hall to camp", travelMode: "foot",
  footprint: { reads: [{ entityId: "hero", field: "character.location" }], writes: [{ entityId: "hero", field: "character.location" }], resources: [] },
};

export const hallCampWalkIntent = {
  kind: "act" as const, summary: "Walk from the hall to camp", targets: [{ kind: "entity" as const, entityId: "camp" }],
  requestedTimeAdvance: { amount: 1, unit: "minute" as const },
  sceneTransition: { kind: "arrive" as const, destination: { kind: "entity" as const, entityId: "camp" }, travelMode: "foot" as const },
};

export async function installHallCampRoute(root: string, suppliedEvidence?: EvidenceRef[]) {
  const canon = new CanonicalModelStore(root);
  const evidence = suppliedEvidence ?? (await createEvidenceFixture(root, "林岐 Hero is in 前厅 Hall, knows the one-minute footpath to 营地 Camp, and walks there.\n", "travel-world.txt")).evidence("one-minute footpath");
  if (!suppliedEvidence) {
    for (const entity of await canon.listEntities()) if (!entity.evidence.length) await canon.putEntity({ ...entity, evidence });
    for (const claim of await canon.listClaims()) if (!claim.evidence.length) await canon.putClaim({ ...claim, evidence });
    for (const event of await canon.listEvents()) if (!event.evidence.length) await canon.putEvent({ ...event, evidence });
  }
  await canon.putSpatialRelation(spatialRelationSchema.parse({ ontologyVersion: "spatial-v1", id: "hall-camp-route", kind: "route", fromLocationId: "hall", toLocationId: "camp", direction: "two-way", modes: ["foot"],
    duration: { minimum: 1, unit: "minute" }, basis: "explicit", visibility: "public", knownByClaimIds: [], status: "supported", confidence: 1, evidence }));
}

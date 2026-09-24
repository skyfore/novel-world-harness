import crypto from "node:crypto";
import { z } from "zod";
import { contentHash, canonicalJson } from "../world/canonical.js";
import { idSchema } from "../world/model.js";
import { CHARACTER_ONTOLOGY_VERSION } from "../world/character-ontology.js";
import { roleRosterSchema, majorRoleCandidates, reviewedRoleDevelopmentRequirements, type RoleRoster } from "./role-roster.js";
import { structuralUnitSchema } from "./structure.js";
import { textAnchorForByteRange } from "./text-anchors.js";
import type { SemanticRequirement } from "./semantic-requirements.js";

/** Independent source review supplies the denominator; accepted models never shrink it. */
export function coreRoleDefinitions(bundle: { source: { id: string } }, roster: RoleRoster): SemanticRequirement[] {
  const evidenceRefs = roster.unitIds.map(id => `source-unit:${id}`);
  const common = { sourceId: bundle.source.id, evidenceRefs };
  const definitions: SemanticRequirement[] = [{ ...common, id: "core-roles:source-review", targetRef: `source:${bundle.source.id}`,
    capability: "role-denominator", stage: "source-review", expectation: { kind: "two-independent-full-source-reviews", rosterHash: contentHash(roster) }, dependsOn: [] }];
  const development = reviewedRoleDevelopmentRequirements(roster);
  for (const role of majorRoleCandidates(roster)) {
    const targetRef = role.entityId ? `character:${role.entityId}` : `unresolved-role:${role.id}`;
    definitions.push({ ...common, id: `${role.id}:ontology`, targetRef, capability: "ontology", stage: "ontology",
      expectation: { kind: "character-ontology", version: CHARACTER_ONTOLOGY_VERSION }, dependsOn: ["core-roles:source-review"] });
    definitions.push({ ...common, id: `${role.id}:development`, targetRef, capability: "development", stage: "executable",
      expectation: { kind: "source-reviewed-development", review: development.find(item => item.candidateId === role.id)! }, dependsOn: [`${role.id}:ontology`] });
    definitions.push({ ...common, id: `${role.id}:opening-driver`, targetRef, capability: "opening-driver", stage: "executable",
      expectation: { kind: "committed-autonomy-at-first-physical-entry", excludedActorId: role.entityId ?? null }, dependsOn: ["core-roles:source-review"] });
  }
  return definitions;
}


const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const coreRoleRequirementDefinitionSchema = z.object({
  version: z.literal(1), id: z.literal("core-roles"), sourceId: idSchema, sourceSha256: hash,
  revisionHash: hash, parentRevision: hash.nullable(), specHash: hash,
  scopeDecisionRef: z.string().trim().min(1), scopeChangeReason: z.string().trim().min(1),
  removedRequirementIds: z.array(z.string().min(1)),
  roster: roleRosterSchema, units: z.array(structuralUnitSchema).min(1),
}).strict().superRefine(({ revisionHash, ...definition }, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (contentHash(definition) !== revisionHash) fail("Core role definition hash mismatch");
  if (definition.roster.reviews.length !== 2) fail("Core role definition requires two retained independent reviews");
  if (definition.roster.sourceId !== definition.sourceId || definition.roster.sourceSha256 !== definition.sourceSha256) fail("Core role definition source mismatch");
  if (definition.units.some(unit => unit.sourceId !== definition.sourceId || unit.anchor.sourceId !== definition.sourceId)
    || canonicalJson(definition.units.map(unit => unit.id).sort()) !== canonicalJson([...definition.roster.unitIds].sort())) fail("Core role definition unit inventory mismatch");
  if (definition.specHash !== contentHash({ definitions: coreRoleDefinitions({ source: { id: definition.sourceId } }, definition.roster), units: definition.units })) fail("Core role requirement spec hash mismatch");
});
export type CoreRoleRequirementDefinition = z.infer<typeof coreRoleRequirementDefinitionSchema>;
export const coreRoleRequirementHistorySchema = z.array(coreRoleRequirementDefinitionSchema).superRefine((history, ctx) => {
  let previous: CoreRoleRequirementDefinition | undefined;
  const reviewHashes = new Map<string, string>();
  for (const definition of history) {
    if (definition.parentRevision !== (previous?.revisionHash ?? null)) ctx.addIssue({ code: "custom", message: "Core role requirement lineage is incomplete" });
    const before = previous ? coreRoleDefinitions({ source: { id: previous.sourceId } }, previous.roster).map(item => item.id) : [];
    const after = new Set(coreRoleDefinitions({ source: { id: definition.sourceId } }, definition.roster).map(item => item.id));
    if (canonicalJson(before.filter(id => !after.has(id)).sort()) !== canonicalJson([...definition.removedRequirementIds].sort())) ctx.addIssue({ code: "custom", message: "Core role scope reduction inventory mismatch" });
    for (const review of definition.roster.reviews) {
      const hash = contentHash(review), retained = reviewHashes.get(review.runId);
      if (retained && retained !== hash) ctx.addIssue({ code: "custom", message: "Core role review run was rewritten" });
      reviewHashes.set(review.runId, hash);
    }
    previous = definition;
  }
});

export function assertCoreRoleDefinitionEvidence(definition: Pick<CoreRoleRequirementDefinition, "sourceId" | "sourceSha256" | "units">, bytes: Uint8Array): void {
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== definition.sourceSha256) throw new Error("Core role immutable source hash mismatch; stop for host storage review");
  let cursor = 0;
  for (const unit of [...definition.units].sort((a, b) => a.anchor.startByte - b.anchor.startByte)) {
    if (unit.anchor.startByte !== cursor || !["sentence", "non-scene"].includes(unit.kind)) throw new Error("Core role source review must retain the complete base partition; stop for host review");
    const expected = textAnchorForByteRange(definition.sourceId, bytes, unit.anchor.startByte, unit.anchor.endByte);
    if (contentHash(unit.anchor) !== contentHash(expected)) throw new Error(`Core role source unit evidence is invalid: ${unit.id}; stop for host source review`);
    cursor = unit.anchor.endByte;
  }
  if (cursor !== bytes.length) throw new Error("Core role source review omits source bytes; stop for host review");
}

export function coreRoleDefinitionBindingIssues(history: readonly CoreRoleRequirementDefinition[], input: {
  sourceId: string; sourceSha256: string; roster: RoleRoster | null; specHash?: string;
}): string[] {
  const definitions = coreRoleRequirementHistorySchema.parse(history), active = definitions.at(-1);
  if (!active) return ["CORE_ROLE_DEFINITION_NOT_REGISTERED"];
  const issues: string[] = [];
  if (definitions.some(definition => definition.sourceId !== input.sourceId || definition.sourceSha256 !== input.sourceSha256)) issues.push("CORE_ROLE_DEFINITION_SOURCE_MISMATCH");
  if (!input.roster || contentHash(active.roster) !== contentHash(input.roster) || active.specHash !== input.specHash) issues.push("CORE_ROLE_DEFINITION_STALE");
  return issues;
}

import type { Entity, EvidenceAssertion, ValidationIssue } from "./model.js";
import { worldArtifactReferences, worldReferenceFields, type ReferenceFields, type WorldReferenceKind } from "./artifact-references.js";
import type { WorldModelContext } from "./engine.js";

type Catalog = Partial<WorldModelContext>;
export const entityConsumerFields = new Set(Object.entries(worldReferenceFields).filter(([, kind]) => kind === "entity").map(([field]) => field));
const catalogs = {
  entity: "entities", event: "events", rule: "rules", claim: "claims", proposition: "propositions", attribution: "attributions",
  action: "actionSchemas", frame: "eventFrames", "event-execution": "eventExecutions", "semantic-effect": "semanticEffects",
  acquisition: "acquisitions", "perception-observation": "perceptionObservations", "utterance-expression": "utteranceExpressions",
  norm: "normTemplates", process: "processTemplates", constraint: "actionConstraints", goal: "actorGoals", scene: "sceneOccurrences",
} satisfies Record<WorldReferenceKind, keyof Catalog>;

export function identityConsumerReferences(value: unknown, fields: ReferenceFields, pointer = ""): { id: string; pointer: string }[] {
  return worldArtifactReferences(value, fields, pointer).filter(ref => ref.kind === "entity");
}

export function identityConsumptionIssues(value: unknown, entities: ReadonlyMap<string, Entity>, fields: ReferenceFields, catalog: Catalog = {}): ValidationIssue[] {
  if (![...entities.values()].some(entity => entity.identityConsumption?.mode === "quarantined")) return [];
  const issues: ValidationIssue[] = [], seen = new Set<string>();
  const visit = (node: unknown, pointer: string) => {
    for (const ref of worldArtifactReferences(node, fields, pointer, catalog.actionSchemas)) {
      if (ref.kind === "entity") {
        const decision = entities.get(ref.id)?.identityConsumption;
        if (decision?.mode === "quarantined") issues.push({ code: "ENTITY_IDENTITY_CONSUMPTION_BLOCKED", path: ref.pointer,
          message: `Entity ${ref.id} retains unresolved identity under ${decision.resolutionId}@${decision.resolutionRevisionHash}; world consumption is quarantined. Preserve the entity, source and prior decisions; do not infer identity, rebind or retry unchanged.` });
        continue;
      }
      const namespace = catalogs[ref.kind], identity = `${namespace}:${ref.id}`;
      if (seen.has(identity)) continue;
      const lookup = catalog[namespace];
      const dependency = Array.isArray(lookup) ? lookup.find(item => item.id === ref.id) : (lookup as ReadonlyMap<string, unknown> | undefined)?.get(ref.id);
      if (!dependency) continue;
      seen.add(identity);
      visit(dependency, `${ref.pointer}/@${identity.replaceAll("~", "~0").replaceAll("/", "~1")}`);
    }
  };
  visit(value, "");
  return issues;
}

/** Grounding a local referent is an independently supported compiler revision,
 * never an automatic consequence of an unresolved identity or physical label. */
export function validateSourceLocalIdentityEvidence(entity: Entity, assertions: readonly EvidenceAssertion[]): ValidationIssue[] {
  const basis = entity.identityConsumption;
  if (basis?.mode !== "source-local") return [];
  return ["/identityConsumption/mode", "/identityConsumption/referentScope"].filter(pointer => !assertions.some(a =>
    a.target.artifactKind === "entity" && a.target.artifactId === entity.id && a.target.jsonPointer === pointer
    && a.relation === "supports" && a.strength !== "weak-inference" && a.anchors.length
    && a.anchors.every(anchor => anchor.sourceId === basis.sourceId)))
    .map(path => ({ code: "SOURCE_LOCAL_IDENTITY_EVIDENCE_REQUIRED", path,
      message: "A source-local referent needs exact source support for its local scope without asserting named identity or distinctness. Read the same source mention and supply its supported field selectors once; stop if unsupported, no relabeling or unchanged retry." }));
}

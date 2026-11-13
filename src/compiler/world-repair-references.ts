import { worldArtifactReferences, type WorldReferenceKind } from "../world/artifact-references.js";
import type { ActionSchema } from "../world/action-ontology.js";
import { DEFAULT_STATE_FIELDS } from "../world/state.js";

const fields = new Map(DEFAULT_STATE_FIELDS.map(field => [field.key, field]));
const artifactKinds: Partial<Record<WorldReferenceKind, string>> = {
  event: "canonical-event", rule: "world-rule", action: "action-schema", goal: "character-goal",
  process: "process-template", norm: "norm-template", frame: "event-frame", scene: "scene-occurrence", constraint: "action-constraint",
};

export function worldRepairReferenceKeys(value: unknown, actionSchemas?: ReadonlyMap<string, ActionSchema>): string[] {
  return worldArtifactReferences(value, fields, "", actionSchemas).map(ref => (artifactKinds[ref.kind] ?? ref.kind) + ":" + ref.id);
}

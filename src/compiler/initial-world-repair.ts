import { initialWorldSchema } from "../world/initial.js";
import { worldRepairReferenceKeys } from "./world-repair-references.js";

/** The canonical seed is a singleton, not an entity with a model-assigned ID. */
export const INITIAL_WORLD_REPAIR_ID = "singleton";
export const initialWorldRevisionFields = ["readerSetup", "readerContext", "participantPresence", "actorObservations",
  "delta", "knowledge", "projectionSeed", "checkpoint", "evidence"] as const;

/** Typed external dependencies, including presentation and pre-entry seeds.
 * Seed-local semantic records remain local; text and fact IDs are not entities. */
export function initialWorldRepairReferences(raw: unknown): string[] {
  const initial = initialWorldSchema.parse(raw), refs = new Set<string>(), locals = new Set<string>();
  for (const op of initial.projectionSeed?.semantics.operations ?? []) {
    if (op.op === "record-proposition") locals.add(`proposition:${op.proposition.id}`);
    if (op.op === "record-attribution") locals.add(`attribution:${op.attribution.id}`);
    if (op.op === "record-claim") locals.add(`claim:${op.claim.id}`);
    if (op.op === "record-acquisition") locals.add(`acquisition:${op.acquisition.id}`);
    if (op.op === "open-goal") locals.add(`character-goal:${op.goal.id}`);
  }
  for (const key of worldRepairReferenceKeys(initial)) if (!locals.has(key)) refs.add(key);
  return [...refs].sort();
}

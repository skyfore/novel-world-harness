import type {
  Claim,
  CommittedEvent,
  EntityId,
  StateFieldVisibility,
  StateValue,
} from "./model.js";
import type { StateSchemaRegistry } from "./state.js";

export type ActorStateProjectionScope = "self" | "owner" | "public";

function permits(
  visibility: StateFieldVisibility | undefined,
  scope: ActorStateProjectionScope,
  explicitlyKnown: boolean,
): boolean {
  // Legacy/custom fields fail closed until their compiler schema declares a
  // visibility class. Exact knowledge can selectively reveal a gated field.
  if (visibility === "knowledge") return explicitlyKnown;
  if (visibility === "engine" || visibility === undefined) return false;
  if (visibility === "public") return true;
  if (visibility === "self") return scope === "self";
  return scope === "self" || scope === "owner";
}

export function projectActorVisibleState(
  values: Readonly<Record<string, StateValue>>,
  stateSchema: StateSchemaRegistry,
  scope: ActorStateProjectionScope,
  knownFieldKeys: ReadonlySet<string> = new Set(),
): Record<string, StateValue> {
  const projected: Record<string, StateValue> = {};
  for (const [field, value] of Object.entries(values)) {
    let spec;
    try {
      spec = stateSchema.get(field);
    } catch {
      continue;
    }
    if (!permits(spec.visibility, scope, knownFieldKeys.has(field))) continue;
    projected[field] = structuredClone(value);
  }
  return projected;
}

/**
 * A state-valued claim must opt into an exact field key. Natural-language
 * predicates are not guessed into authority-bearing schema fields.
 */
export function knownStateFieldKeys(
  actorId: EntityId,
  claims: readonly Claim[],
): ReadonlySet<string> {
  const fields = new Set<string>();
  for (const claim of claims) {
    if (claim.subject !== actorId) continue;
    const predicate = claim.predicate.normalize("NFKC").trim();
    if (predicate.startsWith("state:")) fields.add(predicate.slice("state:".length));
  }
  return fields;
}

export type ActorVisibleEventObservation = {
  summary: string;
  step: number;
  storyTime?: CommittedEvent["logicalTime"]["storyTime"];
};

/**
 * Participation proves that an event can affect an actor, not that its
 * omniscient/model-authored title is known. Only an explicit actor observation
 * may carry event-specific wording; every legacy event receives a neutral
 * fallback, including events whose actorId names the observing character.
 */
export function observeCommittedEvent(
  event: CommittedEvent,
  actorId: EntityId,
): ActorVisibleEventObservation | undefined {
  if (!event.participants.includes(actorId)) return undefined;
  const explicit = event.actorObservations?.find((entry) => entry.actorId === actorId)?.summary;
  const summary = explicit ?? "A committed change involving the character became perceptible.";
  return {
    summary,
    step: event.logicalTime.step,
    ...(event.logicalTime.storyTime ? { storyTime: structuredClone(event.logicalTime.storyTime) } : {}),
  };
}

import type { ActorWorldView } from "./knowledge.js";
import type { Entity, ValidationIssue } from "./model.js";

export const NAME_RELATIONS = ["identity-name", "identity-alias"] as const;
export type NameAuthority = "self" | "acquired" | "unidentified" | "ambiguous";
export type ActorEntityName = { id: string; kind: Entity["kind"]; name: string; nameAuthority: NameAuthority; knownNames: string[] };

/** Reserved semantic vocabulary; the literal is a held name, not global identity truth. */
export function validateIdentityName(relation: string, value: unknown): ValidationIssue[] {
  if (!NAME_RELATIONS.includes(relation as typeof NAME_RELATIONS[number])) return [];
  return typeof value === "string" && value.trim().length > 0 && value.length <= 400
    ? [] : [{ code: "IDENTITY_NAME_INVALID", message: "identity-name/identity-alias requires an explicit nonempty literal name of at most 400 characters, not an entity reference or inferred canonical label.", path: "object" }];
}

/** Caller supplies only this actor's already scope-checked committed knowledge. */
export function projectActorEntityNames(actorId: string, entities: readonly Entity[], knowledge: readonly ActorWorldView["knowledge"][number][]): ActorEntityName[] {
  const labels = new Map<string, { names: Set<string>; aliases: Set<string> }>();
  for (const { fact, claim, proposition } of knowledge) {
    if (proposition && (proposition.polarity !== "positive" || proposition.modality !== "asserted")) continue;
    if (fact.actorId !== actorId || fact.reception?.understood === false || fact.status === "disbelieves"
      || !claim || fact.claimId !== claim.id || !NAME_RELATIONS.includes(claim.predicate as typeof NAME_RELATIONS[number])
      || validateIdentityName(claim.predicate, claim.object).length) continue;
    const record = labels.get(claim.subject) ?? { names: new Set<string>(), aliases: new Set<string>() };
    (claim.predicate === "identity-name" ? record.names : record.aliases).add((claim.object as string).trim());
    labels.set(claim.subject, record);
  }
  const anonymousCounts = new Map<Entity["kind"], number>();
  return [...entities].sort((a, b) => a.id.localeCompare(b.id)).map(entity => {
    if (entity.id === actorId) return { id: entity.id, kind: entity.kind, name: entity.canonicalName, nameAuthority: "self", knownNames: [entity.canonicalName] };
    const record = labels.get(entity.id), names = [...(record?.names ?? [])].sort(), aliases = [...(record?.aliases ?? [])].sort();
    const knownNames = [...new Set([...names, ...aliases])];
    // Competing primary names retain the actor's uncertainty; no last-write-wins truth upgrade.
    const selected = names.length === 1 ? names[0] : names.length === 0 ? aliases[0] : undefined;
    if (selected) return { id: entity.id, kind: entity.kind, name: selected, nameAuthority: "acquired", knownNames };
    const ordinal = (anonymousCounts.get(entity.kind) ?? 0) + 1;
    anonymousCounts.set(entity.kind, ordinal);
    return { id: entity.id, kind: entity.kind, name: `Unidentified ${entity.kind} ${ordinal}`,
      nameAuthority: names.length > 1 ? "ambiguous" : "unidentified", knownNames };
  });
}

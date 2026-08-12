import type { PossibilityTemplate } from "../world/possibility-model.js";

const META_KNOWLEDGE_PREDICATES = new Set([
  "knows",
  "does-not-know",
  "believes",
  "suspects",
  "heard",
  "disbelieves",
]);

/** Knowledge state belongs in KnowledgeDelta, not in recursively nested claims. */
export function isMetaKnowledgePredicate(predicate: string): boolean {
  return META_KNOWLEDGE_PREDICATES.has(predicate.trim().toLowerCase().replace(/[\s_]+/g, "-"));
}

export function hasExecutablePossibilityEffect(possibility: PossibilityTemplate): boolean {
  return (possibility.proposedDelta?.operations.length ?? 0) > 0
    || (possibility.proposedKnowledge?.operations.length ?? 0) > 0;
}

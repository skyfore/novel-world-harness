import type { PossibilityTemplate } from "../world/possibility-model.js";

const META_KNOWLEDGE_PREDICATES = new Set([
  "know",
  "knows",
  "does-not-know",
  "believe",
  "believes",
  "suspect",
  "suspects",
  "hear",
  "hears",
  "heard",
  "disbelieve",
  "disbelieves",
  "understand",
  "understands",
  "understood",
  "think",
  "thinks",
  "thought",
]);

const META_KNOWLEDGE_CJK_MARKERS = ["不知道", "知道", "不相信", "相信", "怀疑", "听说"];

/** Knowledge state belongs in KnowledgeDelta, not in recursively nested claims. */
export function isMetaKnowledgePredicate(predicate: string): boolean {
  // Quoted speech is observable world evidence, not automatically the
  // enclosing subject's knowledge state. Remove it before checking the
  // predicate relation so e.g. `answers '知道了' and walks away` remains a
  // valid behavioral claim while `knows the route` is still rejected.
  const unquoted = predicate.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|“[^”]*”|‘[^’]*’/gu, " ");
  const normalized = unquoted.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return tokens.some((token) => META_KNOWLEDGE_PREDICATES.has(token))
    || META_KNOWLEDGE_CJK_MARKERS.some((marker) => normalized.includes(marker));
}

export function hasExecutablePossibilityEffect(possibility: PossibilityTemplate): boolean {
  return (possibility.proposedDelta?.operations.length ?? 0) > 0
    || (possibility.proposedKnowledge?.operations.length ?? 0) > 0;
}

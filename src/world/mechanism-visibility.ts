import { z } from "zod";
import { evidenceRefSchema, idSchema } from "./model.js";
import { evidenceBelongsExclusivelyToSource } from "./source-scope.js";

export const mechanismVisibilityFields = {
  visibility: z.enum(["public", "observable", "knowledge", "engine"]).optional(),
  knownByClaimIds: z.array(idSchema).max(64).optional(),
};

export function validateMechanismVisibility(value: { visibility?: string; knownByClaimIds?: string[] }, ctx: z.RefinementCtx): void {
  const claims = value.knownByClaimIds ?? [];
  if (value.visibility === "knowledge" && !claims.length) ctx.addIssue({ code: "custom", path: ["knownByClaimIds"], message: "A knowledge-visible mechanism requires grounding claims" });
  if (value.visibility !== "knowledge" && claims.length) ctx.addIssue({ code: "custom", path: ["knownByClaimIds"], message: "Knowledge gates require knowledge visibility" });
  if (new Set(claims).size !== claims.length) ctx.addIssue({ code: "custom", path: ["knownByClaimIds"], message: "Knowledge gates must be unique" });
}

/** Induction is compiler evidence; it is never an actor learning prerequisite. */
export function mechanismIsDisclosed(
  item: { visibility?: string; knownByClaimIds?: string[]; induction: { kind: string }; evidence: z.infer<typeof evidenceRefSchema>[] },
  scope: { knownClaimIds: ReadonlySet<string>; sourceId?: string },
): boolean {
  return item.visibility !== "engine"
    && (item.visibility !== "knowledge" || Boolean(item.knownByClaimIds?.length) && item.knownByClaimIds!.every((id) => scope.knownClaimIds.has(id)))
    && (item.induction.kind === "domain-module" || evidenceBelongsExclusivelyToSource(item.evidence, scope.sourceId));
}

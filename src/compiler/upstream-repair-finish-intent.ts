import { z } from "zod";
import { idSchema } from "../world/model.js";
import { contentHash } from "../world/canonical.js";
import { compilerFinishInputSchema } from "./finish-input.js";
import { upstreamRepairKindSchema, upstreamRepairReadableRefSchema } from "./upstream-repair-plan.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.object({
  version: z.literal(1), planHash: hash, sourceId: idSchema, sourceSha256: hash, requirementSetHash: hash,
  authorizationHeadHash: hash, input: compilerFinishInputSchema,
  proposals: z.array(z.object({ artifactKind: upstreamRepairKindSchema, artifactId: idSchema, proposalId: idSchema, attemptRef: hash, proposalHash: hash, payloadHash: hash }).strict()).min(1).max(256),
  // Read-only original baselines, never a model-provided mutation schema.
  baselines: z.array(upstreamRepairReadableRefSchema.extend({ revisionHash: hash, payload: z.unknown() }).strict()).max(256),
}).strict();
export const upstreamRepairFinishIntentSchema = identitySchema.extend({ intentHash: hash }).strict().superRefine((intent, ctx) => {
  const { intentHash, ...identity } = intent;
  if (contentHash(identity) !== intentHash) ctx.addIssue({ code: "custom", message: "Upstream finish intent hash mismatch" });
  if (intent.input.outcome !== "complete" || intent.input.target_reviews !== undefined) ctx.addIssue({ code: "custom", message: "Upstream finish uses its own frozen requirement authority" });
  for (const values of [intent.proposals.map(item => item.proposalId), intent.proposals.map(item => item.attemptRef), intent.proposals.map(item => `${item.artifactKind}:${item.artifactId}`), intent.baselines.map(item => `${item.kind}:${item.id}`), intent.input.reviewed_segments.map(item => item.segment_id)]) {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", message: "Duplicate upstream finish member" });
  }
  for (const baseline of intent.baselines) if (baseline.payload === undefined || contentHash(baseline.payload) !== baseline.revisionHash) ctx.addIssue({ code: "custom", message: "Upstream finish baseline hash mismatch" });
});
export type UpstreamRepairFinishIntent = z.infer<typeof upstreamRepairFinishIntentSchema>;
export function freezeUpstreamRepairFinishIntent(input: z.input<typeof identitySchema>): UpstreamRepairFinishIntent {
  const identity = identitySchema.parse(input);
  return upstreamRepairFinishIntentSchema.parse({ ...identity, intentHash: contentHash(identity) });
}

/** Deterministic original-finish rejection, distinct from interrupted host I/O. */
export class UpstreamRepairFinishValidationError extends Error {}

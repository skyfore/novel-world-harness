import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { idSchema } from "../world/model.js";
import { upstreamRepairKindSchema } from "./upstream-repair-plan.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const upstreamRepairFinishRevisionCorrectionSchema = z.object({
  artifactKind: upstreamRepairKindSchema,
  artifactId: idSchema,
  originalAttemptRef: hash,
  originalProposalId: idSchema,
  originalInputHash: hash,
  replacementProposalId: idSchema,
  inputHash: hash,
  toolInput: z.unknown(),
}).strict().superRefine((correction, ctx) => {
  if (correction.originalProposalId === correction.replacementProposalId) {
    ctx.addIssue({ code: "custom", path: ["replacementProposalId"], message: "A reviewed finish revision requires a new proposal ID so the original draft remains immutable" });
  }
  if (contentHash(correction.toolInput) !== correction.inputHash) {
    ctx.addIssue({ code: "custom", path: ["inputHash"], message: "Finish revision tool input hash mismatch" });
  }
  const input = correction.toolInput && typeof correction.toolInput === "object" && !Array.isArray(correction.toolInput)
    ? correction.toolInput as Record<string, unknown> : undefined;
  if (input?.proposal_id !== correction.replacementProposalId) {
    ctx.addIssue({ code: "custom", path: ["toolInput", "proposal_id"], message: "Finish revision tool input must use its exact replacement proposal ID" });
  }
});
export type UpstreamRepairFinishRevisionCorrection = z.infer<typeof upstreamRepairFinishRevisionCorrectionSchema>;

const identitySchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  planHash: hash,
  failedFinishRef: hash,
  originalIntentHash: hash,
  originalGraphHash: hash,
  auditRef: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  corrections: z.array(upstreamRepairFinishRevisionCorrectionSchema).min(1).max(256),
}).strict();

export const upstreamRepairFinishRevisionIntentSchema = identitySchema.extend({ revisionHash: hash }).strict().superRefine((revision, ctx) => {
  const { revisionHash, ...identity } = revision;
  if (contentHash(identity) !== revisionHash) ctx.addIssue({ code: "custom", path: ["revisionHash"], message: "Upstream finish revision intent hash mismatch" });
  for (const [path, values] of [
    ["corrections", revision.corrections.map(item => `${item.artifactKind}:${item.artifactId}`)],
    ["corrections", revision.corrections.map(item => item.originalAttemptRef)],
    ["corrections", revision.corrections.map(item => item.originalProposalId)],
    ["corrections", revision.corrections.map(item => item.replacementProposalId)],
  ] as const) {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", path: [path], message: "Finish revision members must be unique" });
  }
});
export type UpstreamRepairFinishRevisionIntent = z.infer<typeof upstreamRepairFinishRevisionIntentSchema>;

export function freezeUpstreamRepairFinishRevisionIntent(input: z.input<typeof identitySchema>): UpstreamRepairFinishRevisionIntent {
  const identity = identitySchema.parse(input);
  return upstreamRepairFinishRevisionIntentSchema.parse({ ...identity, revisionHash: contentHash(identity) });
}

export function finishRevisionSemanticInputHash(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return contentHash(input);
  const { proposal_id: _proposalId, ...semantic } = input as Record<string, unknown>;
  return contentHash(semantic);
}

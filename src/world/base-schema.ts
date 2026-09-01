import { z } from "zod";

export const frozenWorldBaseSchema = z.object({
  version: z.literal(1),
  sourceId: z.string().min(1),
  sourceContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  preparedRevisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  canonicalSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type FrozenWorldBase = z.infer<typeof frozenWorldBaseSchema>;

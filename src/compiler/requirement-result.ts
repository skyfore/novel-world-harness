import { z } from "zod";
import { idSchema } from "../world/model.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1);
export const requirementResultSchema = z.object({
  setId: idSchema, revisionHash: hash, catalogHash: hash, evaluatorVersion: text,
  requirements: z.array(z.object({
    id: text, definitionHash: hash,
    state: z.enum(["satisfied", "blocked", "unknown", "unmapped", "stale"]),
    diagnostics: z.array(text), blockedBy: z.array(text),
  }).strict()).min(1),
}).strict();
export type RequirementResult = z.infer<typeof requirementResultSchema>;

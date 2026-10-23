import { z } from "zod";

const count = z.number().int().nonnegative();
export const roleWorkAllowanceSchema = z.object({
  key: z.string().min(1), attempts: count.max(2),
  contextHandoffs: count.max(2).optional(),
  contextSessions: count.optional(), nativeContextFallback: z.boolean().optional(),
  budget: z.object({
    limits: z.object({ maxModelCalls: count.positive(), maxRequestBytes: count.positive(), maxTotalPayloadBytes: count.positive() }).strict(),
    state: z.object({
      usage: z.object({ modelCalls: count, payloads: count, totalPayloadBytes: count, largestRequestBytes: count }).strict(),
      blocked: z.boolean(), failure: z.object({ code: z.string(), message: z.string() }).strict().optional(),
      progress: z.object({ lastProgressCall: count, milestones: z.array(z.string()) }).strict().optional(),
    }).strict(),
  }).strict().optional(),
}).strict();
export type RoleWorkAllowance = z.infer<typeof roleWorkAllowanceSchema>;

import { z } from "zod";

const thinkingLevelSchema = z
  .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
  .default("medium");

export const llmProfileSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*_API_KEY$/, "apiKeyEnv must name an *_API_KEY variable")
      .optional(),
    thinkingLevel: thinkingLevelSchema,
    baseUrl: z.url().optional(),
    apiProtocol: z.string().min(1).optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
  })
  .strict();

const routingSchema = z.record(z.string(), z.string().min(1)).default({});

export const configSchema = z
  .object({
    version: z.literal(1),
    project: z
      .object({
        name: z.string().min(1),
        language: z.string().min(1).default("zh-CN"),
        /**
         * Workspace guidance is trusted only when the user explicitly lists it
         * in configuration. Novel source files are never implicitly promoted to
         * system instructions by filename.
         */
        instructions: z.array(
          z.string().trim().min(1).max(500)
            .refine((value) => !/[\r\n\0]/u.test(value), "instruction paths must be a single line"),
        ).max(8).default([]),
      })
      .strict(),
    llm: z
      .object({
        defaultProfile: z.string().min(1),
        profiles: z.record(z.string(), llmProfileSchema),
        routing: routingSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.llm) return;
    if (!value.llm.profiles[value.llm.defaultProfile]) {
      ctx.addIssue({
        code: "custom",
        path: ["llm", "defaultProfile"],
        message: `Unknown default profile: ${value.llm.defaultProfile}`,
      });
    }
    for (const [role, profile] of Object.entries(value.llm.routing)) {
      if (!value.llm.profiles[profile]) {
        ctx.addIssue({
          code: "custom",
          path: ["llm", "routing", role],
          message: `Unknown profile '${profile}' for role '${role}'`,
        });
      }
    }
  });

export type HarnessConfig = z.infer<typeof configSchema>;
export type LlmProfile = z.infer<typeof llmProfileSchema>;

import { z } from "zod";

export const llmProfileSchema = z
  .object({
    provider: z.literal("anthropic").default("anthropic"),
    model: z.string().min(1),
    apiKeyEnv: z.literal("ANTHROPIC_API_KEY").default("ANTHROPIC_API_KEY"),
    maxTokens: z.number().int().positive().default(8_192),
  })
  .strict();

const routingSchema = z
  .record(z.string(), z.string().min(1))
  .default({});

export const configSchema = z
  .object({
    version: z.literal(1),
    project: z.object({
      name: z.string().min(1),
      language: z.string().min(1).default("zh-CN"),
    }),
    llm: z.object({
      defaultProfile: z.string().min(1),
      profiles: z.record(z.string(), llmProfileSchema),
      routing: routingSchema,
    }),
    database: z.object({
      url: z.string().min(1),
      poolMin: z.number().int().nonnegative().default(0),
      poolMax: z.number().int().positive().default(10),
      statementTimeoutMs: z.number().int().positive().default(30_000),
    }),
    harness: z.object({
      maxLoops: z.number().int().positive().default(5_000),
      maxConcurrentWorkers: z.number().int().positive().default(4),
      batchSize: z.number().int().positive().default(8),
      checkpointEvery: z.number().int().positive().default(25),
      targetCoverage: z.object({
        source: z.number().min(0).max(1).default(0.99),
        evidence: z.number().min(0).max(1).default(0.99),
        entityResolution: z.number().min(0).max(1).default(0.99),
        majorEvents: z.number().min(0).max(1).default(0.98),
        temporalConsistency: z.number().min(0).max(1).default(0.99),
        stateDelta: z.number().min(0).max(1).default(0.95),
        epistemic: z.number().min(0).max(1).default(0.90),
        causality: z.number().min(0).max(1).default(0.90),
      }),
    }),
    runtime: z.object({
      defaultPlayerMode: z
        .enum(["canon-character", "reader-possession", "observer"])
        .default("canon-character"),
      canonAttractorWeight: z.number().min(0).max(1).default(0.25),
      divergenceDisableCanonAt: z.number().min(0).max(1).default(0.80),
      snapshotEveryEvents: z.number().int().positive().default(100),
    }),
    logging: z.object({
      level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    }),
  })
  .superRefine((value, ctx) => {
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

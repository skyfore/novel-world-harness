import { z } from "zod";

export const WEB_API_VERSION = "v1" as const;

export const projectSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  language: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const novelSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  sourcePath: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  contentSha256: z.string().min(1),
  registeredAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  instanceCount: z.number().int().nonnegative(),
}).strict();

export const instanceSummarySchema = z.object({
  branchId: z.string().min(1),
  name: z.string().min(1),
  headCommitId: z.string().min(1),
  logicalStep: z.number().int().nonnegative(),
  commitCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  lastEventTitle: z.string().optional(),
  parentBranchId: z.string().optional(),
  active: z.boolean(),
  sourceId: z.string().optional(),
  sourceTitle: z.string().optional(),
  actorId: z.string().optional(),
  actorName: z.string().optional(),
  sessionAtHead: z.boolean().optional(),
  preparedRevisionHash: z.string().optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }),
  lastPlayedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export const playSessionSummarySchema = z.object({
  id: z.string().min(1),
  storageVersion: z.union([z.literal(1), z.literal(2)]),
  branchId: z.string().min(1),
  sourceId: z.string().optional(),
  actorId: z.string().min(1),
  actorName: z.string().optional(),
  lastCommitId: z.string().min(1),
  active: z.boolean(),
  atHead: z.boolean(),
  status: z.enum(["active", "idle", "archived", "detached"]),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const catalogSnapshotSchema = z.object({
  project: projectSummarySchema.nullable(),
  novels: z.array(novelSummarySchema),
  instances: z.array(instanceSummarySchema),
  playSessions: z.array(playSessionSummarySchema),
  activeSessionId: z.string().nullable(),
}).strict();

export const providerSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  configured: z.boolean(),
  authSource: z.enum(["stored", "runtime", "environment", "fallback", "models_json_key", "models_json_command"]).optional(),
  authLabel: z.string().optional(),
  modelCount: z.number().int().nonnegative(),
}).strict();

export const modelSummarySchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  name: z.string().min(1),
  api: z.string().min(1),
  reasoning: z.boolean(),
  input: z.array(z.enum(["text", "image"])),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  available: z.boolean(),
}).strict();

export const modelCatalogSchema = z.object({
  providers: z.array(providerSummarySchema),
  models: z.array(modelSummarySchema),
  diagnostic: z.string().optional(),
}).strict();

export const featureSummarySchema = z.object({
  id: z.enum(["library", "play", "trace", "compiler", "ontology", "model-settings"]),
  status: z.enum(["available", "foundation", "planned"]),
  phase: z.number().int().nonnegative(),
}).strict();

export const bootstrapResponseSchema = z.object({
  version: z.literal(1),
  apiVersion: z.literal(WEB_API_VERSION),
  server: z.object({
    name: z.literal("novel-world-harness"),
    version: z.string().min(1),
    nodeVersion: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
  }).strict(),
  workspace: z.object({
    root: z.string().min(1),
    displayName: z.string().min(1),
  }).strict(),
  catalog: catalogSnapshotSchema,
  modelCatalog: modelCatalogSchema,
  features: z.array(featureSummarySchema),
}).strict();

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  apiVersion: z.literal(WEB_API_VERSION),
  startedAt: z.string().datetime({ offset: true }),
}).strict();

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional(),
  retry: z.object({
    kind: z.enum(["none", "same-request", "after-refresh", "after-user-action"]),
    maxAttempts: z.literal(1).optional(),
    discoveryEndpoint: z.string().optional(),
    copyField: z.string().optional(),
  }).strict(),
}).strict();

export const webEventTypeSchema = z.enum([
  "server.ready",
  "catalog.invalidated",
  "operation.changed",
]);

export const webEventSchema = z.object({
  version: z.literal(1),
  eventId: z.string().regex(/^\d+$/),
  occurredAt: z.string().datetime({ offset: true }),
  type: webEventTypeSchema,
  operationId: z.string().optional(),
  runId: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
}).strict();

export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type NovelSummary = z.infer<typeof novelSummarySchema>;
export type InstanceSummary = z.infer<typeof instanceSummarySchema>;
export type PlaySessionSummary = z.infer<typeof playSessionSummarySchema>;
export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>;
export type ProviderSummary = z.infer<typeof providerSummarySchema>;
export type ModelSummary = z.infer<typeof modelSummarySchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type WebEventType = z.infer<typeof webEventTypeSchema>;
export type WebEvent = z.infer<typeof webEventSchema>;

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
  title: z.string().min(1),
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
  csrfToken: z.string().min(32),
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
  "play.narration.delta",
  "play.narration.completed",
  "play.message.appended",
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

export const operationStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

export const operationKindSchema = z.enum([
  "player-move",
  "scene-narration",
  "prepare",
]);

export const operationSnapshotSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  kind: operationKindSchema,
  scopeId: z.string().min(1),
  clientRequestId: z.string().min(1),
  requestFingerprint: z.string().min(1),
  status: operationStatusSchema,
  cancellable: z.boolean(),
  commitBoundaryCrossed: z.boolean(),
  phase: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).optional(),
  finishedAt: z.string().datetime({ offset: true }).optional(),
  progress: z.record(z.string(), z.unknown()),
  result: z.unknown().optional(),
  error: apiErrorSchema.optional(),
}).strict();

export const operationAcceptedSchema = z.object({
  operation: operationSnapshotSchema,
  reused: z.boolean(),
}).strict();

export const createPlaySessionRequestSchema = z.object({
  branchId: z.string().min(1),
  actorId: z.string().min(1),
  sourceId: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const playableCharacterSchema = z.object({
  id: z.string().min(1),
  canonicalName: z.string().min(1),
  aliases: z.array(z.string()),
  alive: z.boolean().optional(),
  locationId: z.string().optional(),
  locationName: z.string().optional(),
  sourceIds: z.array(z.string()),
}).strict();

export const playableCharacterListSchema = z.object({
  branchId: z.string().min(1),
  sourceId: z.string().optional(),
  sourceTitle: z.string().optional(),
  characters: z.array(playableCharacterSchema),
}).strict();

export const updatePlaySessionRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["idle", "archived"]).optional(),
}).strict().refine((value) => value.title !== undefined || value.status !== undefined, {
  message: "At least one play-session field must be updated.",
});

export const playMoveRequestSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  intent: z.enum(["act", "observe", "reflect", "wait"]).optional(),
  affordanceId: z.string().min(1).optional(),
  expectedHead: z.string().min(1),
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const sceneNarrationRequestSchema = z.object({
  purpose: z.enum(["opening", "orientation", "turn", "blocked", "recovery"]),
  expectedHead: z.string().min(1),
  clientRequestId: z.string().min(1).max(200),
}).strict();

export const playMessageSummarySchema = z.object({
  id: z.string().min(1),
  branchId: z.string().min(1),
  actorId: z.string().min(1),
  atCommit: z.string().min(1),
  eventId: z.string().optional(),
  role: z.enum(["player", "scene"]),
  status: z.enum(["accepted", "rejected", "rendered"]),
  text: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const playSessionDetailSchema = z.object({
  session: playSessionSummarySchema,
  headCommitId: z.string().min(1).nullable(),
  messages: z.array(playMessageSummarySchema),
}).strict();

export const playerChoiceSummarySchema = z.object({
  action: z.string().min(1),
  affordanceId: z.string().optional(),
}).strict();

export const playOperationResultSchema = z.object({
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  actorId: z.string().min(1),
  accepted: z.boolean(),
  stage: z.string().min(1),
  previousHead: z.string().min(1),
  finalHead: z.string().min(1),
  logicalStep: z.number().int().nonnegative(),
  narrationStatus: z.enum(["rendered", "failed", "skipped"]),
  narration: z.string().optional(),
  narrationError: z.string().optional(),
  warnings: z.array(z.string()),
  choices: z.array(playerChoiceSummarySchema),
  issues: z.array(z.object({ code: z.string(), message: z.string() }).passthrough()),
  auditId: z.string().optional(),
  worldResponseEvents: z.array(z.object({ eventHash: z.string(), title: z.string(), possibilityId: z.string() }).strict()),
  reactionEvents: z.array(z.object({ eventHash: z.string(), title: z.string(), actorId: z.string() }).passthrough()),
  backgroundEvents: z.array(z.object({ eventHash: z.string(), title: z.string() }).strict()),
}).strict();

export const sceneNarrationResultSchema = z.object({
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  actorId: z.string().min(1),
  headCommitId: z.string().min(1),
  purpose: z.enum(["opening", "orientation", "turn", "blocked", "recovery"]),
  narrationStatus: z.enum(["rendered", "failed", "skipped"]),
  narration: z.string().optional(),
  narrationError: z.string().optional(),
  choices: z.array(playerChoiceSummarySchema),
}).strict();

export const removePlaySessionResultSchema = z.object({
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  branchPreserved: z.literal(true),
  conversationRemoved: z.boolean(),
}).strict();

export const clearPlayConversationResultSchema = z.object({
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  branchPreserved: z.literal(true),
  cleared: z.literal(true),
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
export type OperationStatus = z.infer<typeof operationStatusSchema>;
export type OperationKind = z.infer<typeof operationKindSchema>;
export type OperationSnapshot = z.infer<typeof operationSnapshotSchema>;
export type OperationAccepted = z.infer<typeof operationAcceptedSchema>;
export type CreatePlaySessionRequest = z.infer<typeof createPlaySessionRequestSchema>;
export type PlayableCharacter = z.infer<typeof playableCharacterSchema>;
export type PlayableCharacterList = z.infer<typeof playableCharacterListSchema>;
export type UpdatePlaySessionRequest = z.infer<typeof updatePlaySessionRequestSchema>;
export type PlayMoveRequest = z.infer<typeof playMoveRequestSchema>;
export type SceneNarrationRequest = z.infer<typeof sceneNarrationRequestSchema>;
export type PlayMessageSummary = z.infer<typeof playMessageSummarySchema>;
export type PlaySessionDetail = z.infer<typeof playSessionDetailSchema>;
export type PlayerChoiceSummary = z.infer<typeof playerChoiceSummarySchema>;
export type PlayOperationResult = z.infer<typeof playOperationResultSchema>;
export type SceneNarrationResult = z.infer<typeof sceneNarrationResultSchema>;
export type RemovePlaySessionResult = z.infer<typeof removePlaySessionResultSchema>;
export type ClearPlayConversationResult = z.infer<typeof clearPlayConversationResultSchema>;

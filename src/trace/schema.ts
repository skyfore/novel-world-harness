import { z } from "zod";

const timestampSchema = z.string().datetime({ offset: true });
export const traceIdentifierSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/,
  "Trace identifiers may contain only letters, numbers, '.', '_', ':', and '-'.",
);

export const traceRunKindSchema = z.enum(["player-move", "scene-narration", "narration-retry", "prepare"]);
export const traceRunStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled", "interrupted"]);

export const traceErrorSummarySchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
}).strict();

export const traceUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
}).strict();

export const traceCountsSchema = z.object({
  llmRequests: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
}).strict();

export const traceRunManifestSchema = z.object({
  version: z.literal(1),
  id: traceIdentifierSchema,
  kind: traceRunKindSchema,
  status: traceRunStatusSchema,
  sourceId: z.string().min(1).optional(),
  branchId: z.string().min(1).optional(),
  playSessionId: z.string().min(1).optional(),
  playerMoveId: z.string().min(1).optional(),
  actorId: z.string().min(1).optional(),
  operationId: z.string().min(1).optional(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  previousHead: z.string().min(1).optional(),
  finalHead: z.string().min(1).optional(),
  eventHash: z.string().min(1).optional(),
  auditId: z.string().min(1).optional(),
  presentationMessageIds: z.array(z.string().min(1)),
  storyTimeBefore: z.unknown().optional(),
  storyTimeAfter: z.unknown().optional(),
  rootSpanId: traceIdentifierSchema,
  lastSeq: z.number().int().nonnegative(),
  counts: traceCountsSchema,
  usage: traceUsageSchema,
  error: traceErrorSummarySchema.optional(),
}).strict();

export const traceBlobRefSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
}).strict();

export const traceEventTypeSchema = z.enum([
  "run.started",
  "run.succeeded",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
  "stage.started",
  "stage.finished",
  "stage.failed",
  "context.assembled",
  "context.finalized",
  "llm.request.started",
  "llm.request.payload",
  "llm.response.started",
  "llm.response.delta",
  "llm.response.completed",
  "llm.response.failed",
  "llm.retry",
  "tool.call.started",
  "tool.call.progress",
  "tool.call.completed",
  "tool.call.failed",
  "validation.completed",
  "world.commit.started",
  "world.commit.completed",
  "world.commit.failed",
  "recovery.diagnostic",
  "presentation.message.appended",
]);

export const traceEventSchema = z.object({
  version: z.literal(1),
  runId: traceIdentifierSchema,
  seq: z.number().int().positive(),
  observedAt: timestampSchema,
  type: traceEventTypeSchema,
  spanId: traceIdentifierSchema,
  parentSpanId: traceIdentifierSchema.optional(),
  callId: traceIdentifierSchema.optional(),
  toolCallId: traceIdentifierSchema.optional(),
  storyTime: z.unknown().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  blobRef: traceBlobRefSchema.optional(),
}).strict();

export const contextPartKindSchema = z.enum([
  "system.core",
  "system.role",
  "engine.invariant",
  "capability.contract",
  "tool.schema",
  "player.utterance",
  "actor.model",
  "actor.state",
  "actor.knowledge",
  "scene.current",
  "play.recent-history",
  "world.committed-state",
  "source.excerpt",
  "compiler.batch",
  "canonical.reference",
  "tool.result",
  "proposal.candidate",
  "presentation.context",
]);

export const contextAuthoritySchema = z.enum([
  "trusted-system",
  "engine-invariant",
  "committed-world",
  "actor-visible",
  "untrusted-player",
  "untrusted-source",
  "proposal-only",
  "presentation-only",
  "tool-result",
]);

export const traceSourceRefSchema = z.object({
  sourceId: z.string().min(1),
  startByte: z.number().int().nonnegative().optional(),
  endByte: z.number().int().nonnegative().optional(),
  label: z.string().optional(),
}).strict();

export const contextPartSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: contextPartKindSchema,
  role: z.enum(["system", "user", "assistant", "tool"]),
  authority: contextAuthoritySchema,
  sourceRefs: z.array(traceSourceRefSchema),
  contentRef: traceBlobRefSchema.optional(),
  charCount: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative().optional(),
  disposition: z.enum(["included", "omitted", "truncated"]),
  omissionReason: z.string().min(1).optional(),
  logicalMessageIndexes: z.array(z.number().int().nonnegative()),
}).strict();

export const traceToolDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  parametersRef: traceBlobRefSchema,
}).strict();

export const contextSnapshotSchema = z.object({
  version: z.literal(1),
  callId: z.string().min(1),
  invocationName: z.string().min(1),
  assemblyVersion: z.string().min(1),
  providerId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  thinkingLevel: z.string().optional(),
  parts: z.array(contextPartSchema),
  tools: z.array(traceToolDescriptorSchema),
  logicalMessagesRef: traceBlobRefSchema.optional(),
  providerPayloadRef: traceBlobRefSchema.optional(),
  logicalContextHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  providerPayloadHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  estimatedInputTokens: z.number().int().nonnegative().optional(),
  providerReportedInputTokens: z.number().int().nonnegative().optional(),
}).strict();

export const traceRunDetailSchema = z.object({
  manifest: traceRunManifestSchema,
  events: z.array(traceEventSchema),
}).strict();

export type TraceRunKind = z.infer<typeof traceRunKindSchema>;
export type TraceRunStatus = z.infer<typeof traceRunStatusSchema>;
export type TraceErrorSummary = z.infer<typeof traceErrorSummarySchema>;
export type TraceUsage = z.infer<typeof traceUsageSchema>;
export type TraceCounts = z.infer<typeof traceCountsSchema>;
export type TraceRunManifest = z.infer<typeof traceRunManifestSchema>;
export type TraceBlobRef = z.infer<typeof traceBlobRefSchema>;
export type TraceEventType = z.infer<typeof traceEventTypeSchema>;
export type TraceEvent = z.infer<typeof traceEventSchema>;
export type ContextPartKind = z.infer<typeof contextPartKindSchema>;
export type ContextAuthority = z.infer<typeof contextAuthoritySchema>;
export type TraceSourceRef = z.infer<typeof traceSourceRefSchema>;
export type ContextPart = z.infer<typeof contextPartSchema>;
export type TraceToolDescriptor = z.infer<typeof traceToolDescriptorSchema>;
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;
export type TraceRunDetail = z.infer<typeof traceRunDetailSchema>;

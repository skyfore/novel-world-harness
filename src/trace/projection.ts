import { z } from "zod";
import {
  contextPartSchema,
  contextSnapshotSchema,
  traceEventSchema,
  traceRunManifestSchema,
  traceToolDescriptorSchema,
  traceUsageSchema,
} from "./schema.js";

export const expandedContextPartSchema = contextPartSchema.extend({
  content: z.unknown().optional(),
}).strict();

export const expandedTraceToolDescriptorSchema = traceToolDescriptorSchema.extend({
  parameters: z.unknown(),
}).strict();

export const traceContextSnapshotViewSchema = z.object({
  eventSeq: z.number().int().positive(),
  requestAttempt: z.number().int().positive().optional(),
  snapshot: contextSnapshotSchema,
  parts: z.array(expandedContextPartSchema),
  availableTools: z.array(expandedTraceToolDescriptorSchema),
  logicalMessages: z.unknown().optional(),
  providerPayload: z.unknown().optional(),
}).strict();

export const traceResponseViewSchema = z.object({
  seq: z.number().int().positive(),
  status: z.enum(["started", "completed", "failed", "delta"]),
  observedAt: z.string().datetime({ offset: true }),
  data: z.record(z.string(), z.unknown()),
  content: z.unknown().optional(),
}).strict();

export const traceToolCallViewSchema = z.object({
  toolCallId: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["running", "completed", "failed"]),
  startedSeq: z.number().int().positive().optional(),
  endedSeq: z.number().int().positive().optional(),
  input: z.unknown().optional(),
  progress: z.array(z.unknown()),
  result: z.unknown().optional(),
}).strict();

export const traceCallDetailSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  callId: z.string().min(1),
  invocationName: z.string().min(1).optional(),
  startedAt: z.string().datetime({ offset: true }).optional(),
  firstResponseAt: z.string().datetime({ offset: true }).optional(),
  endedAt: z.string().datetime({ offset: true }).optional(),
  timeToFirstResponseMs: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  counts: z.object({
    requests: z.number().int().nonnegative(),
    retries: z.number().int().nonnegative(),
    tools: z.number().int().nonnegative(),
  }).strict(),
  usage: traceUsageSchema,
  contexts: z.array(traceContextSnapshotViewSchema),
  responses: z.array(traceResponseViewSchema),
  tools: z.array(traceToolCallViewSchema),
  events: z.array(traceEventSchema),
}).strict();

export const traceRunDetailViewSchema = z.object({
  version: z.literal(1),
  manifest: traceRunManifestSchema,
  events: z.array(traceEventSchema),
  callIds: z.array(z.string().min(1)),
}).strict();

export const traceEventPayloadSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  seq: z.number().int().positive(),
  event: traceEventSchema,
  content: z.unknown(),
}).strict();

export type ExpandedContextPart = z.infer<typeof expandedContextPartSchema>;
export type ExpandedTraceToolDescriptor = z.infer<typeof expandedTraceToolDescriptorSchema>;
export type TraceContextSnapshotView = z.infer<typeof traceContextSnapshotViewSchema>;
export type TraceResponseView = z.infer<typeof traceResponseViewSchema>;
export type TraceToolCallView = z.infer<typeof traceToolCallViewSchema>;
export type TraceCallDetail = z.infer<typeof traceCallDetailSchema>;
export type TraceRunDetailView = z.infer<typeof traceRunDetailViewSchema>;
export type TraceEventPayload = z.infer<typeof traceEventPayloadSchema>;

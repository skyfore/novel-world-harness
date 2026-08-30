import { z } from "zod";
import {
  apiErrorSchema,
  bootstrapResponseSchema,
  clearPlayConversationResultSchema,
  createPlaySessionRequestSchema,
  operationAcceptedSchema,
  operationSnapshotSchema,
  playableCharacterListSchema,
  playMoveRequestSchema,
  playSessionDetailSchema,
  removePlaySessionResultSchema,
  sceneNarrationRequestSchema,
  updatePlaySessionRequestSchema,
  type ApiError,
  type BootstrapResponse,
  type ClearPlayConversationResult,
  type CreatePlaySessionRequest,
  type OperationAccepted,
  type OperationSnapshot,
  type PlayableCharacterList,
  type PlayMoveRequest,
  type PlaySessionDetail,
  type RemovePlaySessionResult,
  type SceneNarrationRequest,
  type UpdatePlaySessionRequest,
} from "../../../src/web/contracts";
import {
  traceEventPayloadSchema,
  traceCallDetailSchema,
  traceRunDetailViewSchema,
  type TraceCallDetail,
  type TraceEventPayload,
  type TraceRunDetailView,
} from "../../../src/trace/projection";
import {
  traceEventSchema,
  traceRunManifestSchema,
  type TraceEvent,
  type TraceRunKind,
  type TraceRunManifest,
  type TraceRunStatus,
} from "../../../src/trace/schema";

const operationListSchema = z.array(operationSnapshotSchema);
const traceRunListSchema = z.array(traceRunManifestSchema);
const traceEventListSchema = z.array(traceEventSchema);

export type TraceRunFilters = {
  sessionId?: string;
  branchId?: string;
  kind?: TraceRunKind;
  status?: TraceRunStatus;
  modelId?: string;
  stage?: string;
  startedAfter?: string;
  startedBefore?: string;
  limit?: number;
};

export function fetchBootstrap(signal?: AbortSignal): Promise<BootstrapResponse> {
  return request("/api/v1/bootstrap", bootstrapResponseSchema, { signal });
}

export function fetchCharacters(branchId: string, sourceId?: string, signal?: AbortSignal): Promise<PlayableCharacterList> {
  const query = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : "";
  return request(`/api/v1/instances/${encodeURIComponent(branchId)}/characters${query}`, playableCharacterListSchema, { signal });
}

export function fetchPlaySession(sessionId: string, signal?: AbortSignal): Promise<PlaySessionDetail> {
  return request(`/api/v1/play-sessions/${encodeURIComponent(sessionId)}`, playSessionDetailSchema, { signal });
}

export function fetchOperation(operationId: string, signal?: AbortSignal): Promise<OperationSnapshot> {
  return request(`/api/v1/operations/${encodeURIComponent(operationId)}`, operationSnapshotSchema, { signal });
}

export function fetchOperations(scopeId?: string, signal?: AbortSignal): Promise<OperationSnapshot[]> {
  const query = scopeId ? `?scopeId=${encodeURIComponent(scopeId)}` : "";
  return request(`/api/v1/operations${query}`, operationListSchema, { signal });
}

export function fetchTraceRuns(filters: TraceRunFilters = {}, signal?: AbortSignal): Promise<TraceRunManifest[]> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return request(`/api/v1/runs${suffix}`, traceRunListSchema, { signal });
}

export function fetchTraceRun(runId: string, signal?: AbortSignal): Promise<TraceRunDetailView> {
  return request(`/api/v1/runs/${encodeURIComponent(runId)}`, traceRunDetailViewSchema, { signal });
}

export function fetchTraceEvents(runId: string, afterSeq = 0, signal?: AbortSignal): Promise<TraceEvent[]> {
  return request(
    `/api/v1/runs/${encodeURIComponent(runId)}/events?afterSeq=${encodeURIComponent(String(afterSeq))}`,
    traceEventListSchema,
    { signal },
  );
}

export function fetchTraceEventPayload(runId: string, seq: number, signal?: AbortSignal): Promise<TraceEventPayload> {
  return request(
    `/api/v1/runs/${encodeURIComponent(runId)}/events/${encodeURIComponent(String(seq))}/payload`,
    traceEventPayloadSchema,
    { signal },
  );
}

export function fetchTraceCall(callId: string, runId?: string, signal?: AbortSignal): Promise<TraceCallDetail> {
  const suffix = runId ? `?runId=${encodeURIComponent(runId)}` : "";
  return request(`/api/v1/calls/${encodeURIComponent(callId)}/context${suffix}`, traceCallDetailSchema, { signal });
}

export function createPlaySession(inputValue: CreatePlaySessionRequest, csrfToken: string): Promise<PlaySessionDetail> {
  return mutation("/api/v1/play-sessions", "POST", createPlaySessionRequestSchema.parse(inputValue), playSessionDetailSchema, csrfToken);
}

export function updatePlaySession(sessionId: string, inputValue: UpdatePlaySessionRequest, csrfToken: string): Promise<PlaySessionDetail> {
  return mutation(
    `/api/v1/play-sessions/${encodeURIComponent(sessionId)}`,
    "PATCH",
    updatePlaySessionRequestSchema.parse(inputValue),
    playSessionDetailSchema,
    csrfToken,
  );
}

export function activatePlaySession(sessionId: string, csrfToken: string): Promise<PlaySessionDetail> {
  return mutation(`/api/v1/play-sessions/${encodeURIComponent(sessionId)}/activate`, "POST", undefined, playSessionDetailSchema, csrfToken);
}

export function restorePlaySession(sessionId: string, csrfToken: string): Promise<PlaySessionDetail> {
  return mutation(`/api/v1/play-sessions/${encodeURIComponent(sessionId)}/restore`, "POST", undefined, playSessionDetailSchema, csrfToken);
}

export function clearPlayConversation(sessionId: string, csrfToken: string): Promise<ClearPlayConversationResult> {
  return mutation(`/api/v1/play-sessions/${encodeURIComponent(sessionId)}/messages`, "DELETE", undefined, clearPlayConversationResultSchema, csrfToken);
}

export function removePlaySession(sessionId: string, csrfToken: string): Promise<RemovePlaySessionResult> {
  return mutation(`/api/v1/play-sessions/${encodeURIComponent(sessionId)}`, "DELETE", undefined, removePlaySessionResultSchema, csrfToken);
}

export function startPlayerMove(sessionId: string, inputValue: PlayMoveRequest, csrfToken: string): Promise<OperationAccepted> {
  return mutation(
    `/api/v1/play-sessions/${encodeURIComponent(sessionId)}/moves`,
    "POST",
    playMoveRequestSchema.parse(inputValue),
    operationAcceptedSchema,
    csrfToken,
  );
}

export function startSceneNarration(sessionId: string, inputValue: SceneNarrationRequest, csrfToken: string): Promise<OperationAccepted> {
  return mutation(
    `/api/v1/play-sessions/${encodeURIComponent(sessionId)}/narrations`,
    "POST",
    sceneNarrationRequestSchema.parse(inputValue),
    operationAcceptedSchema,
    csrfToken,
  );
}

export function cancelOperation(operationId: string, csrfToken: string): Promise<OperationSnapshot> {
  return mutation(`/api/v1/operations/${encodeURIComponent(operationId)}/cancel`, "POST", undefined, operationSnapshotSchema, csrfToken);
}

async function mutation<T>(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
  schema: z.ZodType<T>,
  csrfToken: string,
): Promise<T> {
  return request(url, schema, {
    method,
    headers: { "X-NWH-CSRF": csrfToken },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function request<T>(url: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body: unknown = await response.json();
  if (!response.ok) throw new WebApiError(apiErrorSchema.parse(body), response.status);
  return schema.parse(body);
}

export class WebApiError extends Error {
  constructor(readonly detail: ApiError, readonly statusCode?: number) {
    super(detail.message);
    this.name = "WebApiError";
  }
}

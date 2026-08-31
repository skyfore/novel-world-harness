import { z } from "zod";
import {
  apiErrorSchema,
  bootstrapResponseSchema,
  clearPlayConversationResultSchema,
  createInstanceRequestSchema,
  createInstanceResultSchema,
  createPlaySessionRequestSchema,
  enterPlaySessionRequestSchema,
  executeRemovalRequestSchema,
  forkInstanceRequestSchema,
  forkInstanceResultSchema,
  instanceDetailSchema,
  authInteractionSnapshotSchema,
  answerAuthInteractionRequestSchema,
  modelProfileListSchema,
  narrationRetryRequestSchema,
  providerCredentialResultSchema,
  providerCredentialRequestSchema,
  providerLoginRequestSchema,
  operationAcceptedSchema,
  operationSnapshotSchema,
  ontologyGraphSchema,
  ontologyNodeDetailSchema,
  prepareNovelRequestSchema,
  preparationSnapshotSchema,
  playableCharacterListSchema,
  playMoveRequestSchema,
  playSessionEntryResultSchema,
  playSessionCommandRequestSchema,
  playSessionDetailSchema,
  removePlaySessionResultSchema,
  removalExecutionResultSchema,
  removalPreviewSchema,
  proposalAcceptRequestSchema,
  proposalConvergenceResultSchema,
  proposalConvergeRequestSchema,
  proposalDecisionResultSchema,
  proposalDetailSchema,
  proposalPageSchema,
  proposalRejectRequestSchema,
  sceneNarrationRequestSchema,
  sourceRegistrationRequestSchema,
  sourceRegistrationResultSchema,
  updatePlaySessionRequestSchema,
  updateModelProfileRequestSchema,
  type ApiError,
  type BootstrapResponse,
  type ClearPlayConversationResult,
  type CreateInstanceRequest,
  type CreateInstanceResult,
  type CreatePlaySessionRequest,
  type EnterPlaySessionRequest,
  type ExecuteRemovalRequest,
  type ForkInstanceRequest,
  type ForkInstanceResult,
  type InstanceDetail,
  type AnswerAuthInteractionRequest,
  type AuthInteractionSnapshot,
  type ModelProfileList,
  type ModelRole,
  type NarrationRetryRequest,
  type ProviderCredentialResult,
  type ProviderCredentialRequest,
  type ProviderLoginRequest,
  type OperationAccepted,
  type OperationSnapshot,
  type OntologyGraph,
  type OntologyLayer,
  type OntologyNodeDetail,
  type OntologyStatus,
  type OntologyView,
  type PrepareNovelRequest,
  type PreparationSnapshot,
  type PlayableCharacterList,
  type PlayMoveRequest,
  type PlaySessionEntryResult,
  type PlaySessionCommandRequest,
  type PlaySessionDetail,
  type RemovePlaySessionResult,
  type RemovalExecutionResult,
  type RemovalPreview,
  type ProposalAcceptRequest,
  type ProposalConvergenceResult,
  type ProposalConvergeRequest,
  type ProposalDecisionResult,
  type ProposalDetail,
  type ProposalPage,
  type ProposalRejectRequest,
  type ProposalStatus,
  type SceneNarrationRequest,
  type SourceRegistrationRequest,
  type SourceRegistrationResult,
  type UpdatePlaySessionRequest,
  type UpdateModelProfileRequest,
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

export type OntologyFilters = {
  branchId?: string;
  atCommit?: string;
  includeCanonicalFuture?: boolean;
  layers?: OntologyLayer[];
  limit?: number;
  cursor?: string;
  search?: string;
  kind?: string;
  status?: OntologyStatus;
  relationLimit?: number;
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

export function fetchPreparation(sourceId: string, branchId?: string, signal?: AbortSignal): Promise<PreparationSnapshot> {
  const suffix = branchId ? `?branchId=${encodeURIComponent(branchId)}` : "";
  return request(`/api/v1/novels/${encodeURIComponent(sourceId)}/preparation${suffix}`, preparationSnapshotSchema, { signal });
}

export function fetchProposals(
  sourceId: string,
  status: ProposalStatus = "pending",
  kind?: string,
  options: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<ProposalPage> {
  const query = new URLSearchParams({ status });
  if (kind) query.set("kind", kind);
  if (options.cursor) query.set("cursor", options.cursor);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  return request(`/api/v1/novels/${encodeURIComponent(sourceId)}/proposals?${query.toString()}`, proposalPageSchema, { signal });
}

export function fetchProposal(proposalId: string, status?: ProposalStatus, signal?: AbortSignal): Promise<ProposalDetail> {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
  return request(`/api/v1/proposals/${encodeURIComponent(proposalId)}${suffix}`, proposalDetailSchema, { signal });
}

export function fetchInstance(branchId: string, signal?: AbortSignal): Promise<InstanceDetail> {
  return request(`/api/v1/instances/${encodeURIComponent(branchId)}`, instanceDetailSchema, { signal });
}

export function fetchOntology(
  sourceId: string,
  view: OntologyView,
  filters: OntologyFilters = {},
  signal?: AbortSignal,
): Promise<OntologyGraph> {
  const query = ontologyQuery(view, filters);
  return request(`/api/v1/novels/${encodeURIComponent(sourceId)}/ontology?${query.toString()}`, ontologyGraphSchema, { signal });
}

export function fetchOntologyNode(
  sourceId: string,
  view: OntologyView,
  nodeId: string,
  filters: OntologyFilters = {},
  signal?: AbortSignal,
): Promise<OntologyNodeDetail> {
  const query = ontologyQuery(view, filters);
  query.set("sourceId", sourceId);
  return request(`/api/v1/ontology/nodes/${encodeURIComponent(nodeId)}?${query.toString()}`, ontologyNodeDetailSchema, { signal });
}

export function fetchInstanceRemovalPreview(branchId: string, signal?: AbortSignal): Promise<RemovalPreview> {
  return request(`/api/v1/instances/${encodeURIComponent(branchId)}/removal-preview`, removalPreviewSchema, { signal });
}

export function fetchNovelRemovalPreview(sourceId: string, mode: "analysis" | "novel", signal?: AbortSignal): Promise<RemovalPreview> {
  return request(`/api/v1/novels/${encodeURIComponent(sourceId)}/removal-preview?mode=${mode}`, removalPreviewSchema, { signal });
}

export function fetchOperation(operationId: string, signal?: AbortSignal): Promise<OperationSnapshot> {
  return request(`/api/v1/operations/${encodeURIComponent(operationId)}`, operationSnapshotSchema, { signal });
}

export function fetchModelProfiles(signal?: AbortSignal): Promise<ModelProfileList> {
  return request("/api/v1/model-profiles", modelProfileListSchema, { signal });
}

export function fetchOperations(scopeId?: string, signal?: AbortSignal): Promise<OperationSnapshot[]> {
  const query = new URLSearchParams({ limit: "30" });
  if (scopeId) query.set("scopeId", scopeId);
  return request(`/api/v1/operations?${query.toString()}`, operationListSchema, { signal });
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

export function registerSource(inputValue: SourceRegistrationRequest, csrfToken: string): Promise<SourceRegistrationResult> {
  return mutation("/api/v1/sources", "POST", sourceRegistrationRequestSchema.parse(inputValue), sourceRegistrationResultSchema, csrfToken);
}

export function startPreparation(sourceId: string, inputValue: PrepareNovelRequest, csrfToken: string): Promise<OperationAccepted> {
  return mutation(
    `/api/v1/novels/${encodeURIComponent(sourceId)}/prepare`,
    "POST",
    prepareNovelRequestSchema.parse(inputValue),
    operationAcceptedSchema,
    csrfToken,
  );
}

export function acceptProposal(proposalId: string, inputValue: ProposalAcceptRequest, csrfToken: string): Promise<ProposalDecisionResult> {
  return mutation(
    `/api/v1/proposals/${encodeURIComponent(proposalId)}/accept`,
    "POST",
    proposalAcceptRequestSchema.parse(inputValue),
    proposalDecisionResultSchema,
    csrfToken,
  );
}

export function rejectProposal(proposalId: string, inputValue: ProposalRejectRequest, csrfToken: string): Promise<ProposalDecisionResult> {
  return mutation(
    `/api/v1/proposals/${encodeURIComponent(proposalId)}/reject`,
    "POST",
    proposalRejectRequestSchema.parse(inputValue),
    proposalDecisionResultSchema,
    csrfToken,
  );
}

export function convergeProposals(sourceId: string, inputValue: ProposalConvergeRequest, csrfToken: string): Promise<ProposalConvergenceResult> {
  return mutation(
    `/api/v1/novels/${encodeURIComponent(sourceId)}/proposals/converge`,
    "POST",
    proposalConvergeRequestSchema.parse(inputValue),
    proposalConvergenceResultSchema,
    csrfToken,
  );
}

export function createInstance(inputValue: CreateInstanceRequest, csrfToken: string): Promise<CreateInstanceResult> {
  return mutation("/api/v1/instances", "POST", createInstanceRequestSchema.parse(inputValue), createInstanceResultSchema, csrfToken);
}

export function forkInstance(parentBranchId: string, inputValue: ForkInstanceRequest, csrfToken: string): Promise<ForkInstanceResult> {
  return mutation(
    `/api/v1/instances/${encodeURIComponent(parentBranchId)}/fork`,
    "POST",
    forkInstanceRequestSchema.parse(inputValue),
    forkInstanceResultSchema,
    csrfToken,
  );
}

export function executeInstanceRemoval(branchId: string, inputValue: ExecuteRemovalRequest, csrfToken: string): Promise<RemovalExecutionResult> {
  return mutation(
    `/api/v1/instances/${encodeURIComponent(branchId)}`,
    "DELETE",
    executeRemovalRequestSchema.parse(inputValue),
    removalExecutionResultSchema,
    csrfToken,
  );
}

export function executeAnalysisReset(sourceId: string, inputValue: ExecuteRemovalRequest, csrfToken: string): Promise<RemovalExecutionResult> {
  return mutation(
    `/api/v1/novels/${encodeURIComponent(sourceId)}/reset-analysis`,
    "POST",
    executeRemovalRequestSchema.parse(inputValue),
    removalExecutionResultSchema,
    csrfToken,
  );
}

export function executeNovelRemoval(sourceId: string, inputValue: ExecuteRemovalRequest, csrfToken: string): Promise<RemovalExecutionResult> {
  return mutation(
    `/api/v1/novels/${encodeURIComponent(sourceId)}`,
    "DELETE",
    executeRemovalRequestSchema.parse(inputValue),
    removalExecutionResultSchema,
    csrfToken,
  );
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

export function activatePlaySession(sessionId: string, inputValue: PlaySessionCommandRequest, csrfToken: string): Promise<PlaySessionDetail> {
  return mutation(`/api/v1/play-sessions/${encodeURIComponent(sessionId)}/activate`, "POST", playSessionCommandRequestSchema.parse(inputValue), playSessionDetailSchema, csrfToken);
}

export function restorePlaySession(sessionId: string, inputValue: PlaySessionCommandRequest, csrfToken: string): Promise<PlaySessionDetail> {
  return mutation(`/api/v1/play-sessions/${encodeURIComponent(sessionId)}/restore`, "POST", playSessionCommandRequestSchema.parse(inputValue), playSessionDetailSchema, csrfToken);
}

export function enterPlaySession(sessionId: string, inputValue: EnterPlaySessionRequest, csrfToken: string): Promise<PlaySessionEntryResult> {
  return mutation(
    `/api/v1/play-sessions/${encodeURIComponent(sessionId)}/enter`,
    "POST",
    enterPlaySessionRequestSchema.parse(inputValue),
    playSessionEntryResultSchema,
    csrfToken,
  );
}

export function clearPlayConversation(sessionId: string, inputValue: PlaySessionCommandRequest, csrfToken: string): Promise<ClearPlayConversationResult> {
  return mutation(`/api/v1/play-sessions/${encodeURIComponent(sessionId)}/messages`, "DELETE", playSessionCommandRequestSchema.parse(inputValue), clearPlayConversationResultSchema, csrfToken);
}

export function removePlaySession(sessionId: string, inputValue: PlaySessionCommandRequest, csrfToken: string): Promise<RemovePlaySessionResult> {
  return mutation(`/api/v1/play-sessions/${encodeURIComponent(sessionId)}`, "DELETE", playSessionCommandRequestSchema.parse(inputValue), removePlaySessionResultSchema, csrfToken);
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

export function retryNarration(sessionId: string, inputValue: NarrationRetryRequest, csrfToken: string): Promise<OperationAccepted> {
  return mutation(
    `/api/v1/play-sessions/${encodeURIComponent(sessionId)}/retry-narration`,
    "POST",
    narrationRetryRequestSchema.parse(inputValue),
    operationAcceptedSchema,
    csrfToken,
  );
}

export function updateModelProfile(role: ModelRole, inputValue: UpdateModelProfileRequest, csrfToken: string): Promise<ModelProfileList> {
  return mutation(
    `/api/v1/model-profiles/${encodeURIComponent(role)}`,
    "PATCH",
    updateModelProfileRequestSchema.parse(inputValue),
    modelProfileListSchema,
    csrfToken,
  );
}

export function loginProvider(providerId: string, inputValue: ProviderLoginRequest, csrfToken: string): Promise<OperationAccepted> {
  return mutation(
    `/api/v1/models/providers/${encodeURIComponent(providerId)}/login`,
    "POST",
    providerLoginRequestSchema.parse(inputValue),
    operationAcceptedSchema,
    csrfToken,
  );
}

export function logoutProvider(providerId: string, inputValue: ProviderCredentialRequest, csrfToken: string): Promise<ProviderCredentialResult> {
  return mutation(
    `/api/v1/models/providers/${encodeURIComponent(providerId)}/credential`,
    "DELETE",
    providerCredentialRequestSchema.parse(inputValue),
    providerCredentialResultSchema,
    csrfToken,
  );
}

export function answerAuthInteraction(interactionId: string, inputValue: AnswerAuthInteractionRequest, csrfToken: string): Promise<AuthInteractionSnapshot> {
  return mutation(
    `/api/v1/interactions/${encodeURIComponent(interactionId)}/answer`,
    "POST",
    answerAuthInteractionRequestSchema.parse(inputValue),
    authInteractionSnapshotSchema,
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

function ontologyQuery(view: OntologyView, filters: OntologyFilters): URLSearchParams {
  const query = new URLSearchParams({ view });
  if (filters.branchId) query.set("branchId", filters.branchId);
  if (filters.atCommit) query.set("atCommit", filters.atCommit);
  if (filters.includeCanonicalFuture) query.set("includeCanonicalFuture", "true");
  if (filters.layers?.length) query.set("layers", filters.layers.join(","));
  if (filters.limit !== undefined) query.set("limit", String(filters.limit));
  if (filters.cursor) query.set("cursor", filters.cursor);
  if (filters.search) query.set("search", filters.search);
  if (filters.kind) query.set("kind", filters.kind);
  if (filters.status) query.set("status", filters.status);
  if (filters.relationLimit !== undefined) query.set("relationLimit", String(filters.relationLimit));
  return query;
}

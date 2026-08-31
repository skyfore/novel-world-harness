import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { z, ZodError } from "zod";
import { CatalogService } from "../application/catalog-service.js";
import { InstanceApplicationService } from "../application/instance-service.js";
import { MaintenanceApplicationService } from "../application/maintenance-service.js";
import { OntologyProjectionService } from "../application/ontology-projection-service.js";
import { PiModelCatalogService, type ModelCatalogReader } from "../application/model-catalog-service.js";
import { ModelSettingsApplicationService } from "../application/model-settings-service.js";
import { PlayApplicationService } from "../application/play-service.js";
import { PlayTraceRecoveryService } from "../application/play-trace-recovery-service.js";
import { PreparationApplicationService } from "../application/preparation-service.js";
import { ProposalApplicationService } from "../application/proposal-service.js";
import { SourceApplicationService } from "../application/source-service.js";
import { TraceApplicationService, type TraceRunSearchFilter } from "../application/trace-service.js";
import {
  WEB_API_VERSION,
  apiErrorSchema,
  bootstrapResponseSchema,
  createInstanceRequestSchema,
  createPlaySessionRequestSchema,
  enterPlaySessionRequestSchema,
  executeRemovalRequestSchema,
  forkInstanceRequestSchema,
  healthResponseSchema,
  answerAuthInteractionRequestSchema,
  modelRoleSchema,
  narrationRetryRequestSchema,
  playSessionCommandRequestSchema,
  providerCredentialRequestSchema,
  providerLoginRequestSchema,
  operationKindSchema,
  ontologyLayerSchema,
  ontologyStatusSchema,
  ontologyViewSchema,
  prepareNovelRequestSchema,
  playMessageSummarySchema,
  playMoveRequestSchema,
  proposalAcceptRequestSchema,
  proposalConvergeRequestSchema,
  proposalRejectRequestSchema,
  sceneNarrationRequestSchema,
  sourceRegistrationRequestSchema,
  updatePlaySessionRequestSchema,
  updateModelProfileRequestSchema,
  type ApiError,
  type BootstrapResponse,
} from "./contracts.js";
import { serializeServerSentEvent, WebEventBroker } from "./event-stream.js";
import { WebApplicationError } from "./errors.js";
import { OperationManager } from "./operation-manager.js";
import { AuthInteractionManager } from "./auth-interaction-manager.js";
import { WebMutationJournal } from "./mutation-journal.js";
import { redactTraceSecrets } from "../trace/redaction.js";
import { traceIdentifierSchema, traceRunKindSchema, traceRunStatusSchema } from "../trace/schema.js";
import { TraceStore } from "../trace/store.js";

const SERVER_VERSION = "0.1.0";
const DEFAULT_STATIC_ROOT = path.resolve(import.meta.dirname, "../../dist/web-ui");

export interface CreateWebHostOptions {
  root: string;
  host?: string;
  staticRoot?: string;
  serveStatic?: boolean;
  catalogService?: CatalogService;
  modelCatalogService?: ModelCatalogReader;
  modelSettingsService?: ModelSettingsApplicationService;
  authInteractionManager?: AuthInteractionManager;
  eventBroker?: WebEventBroker;
  operationManager?: OperationManager;
  mutationJournal?: WebMutationJournal;
  playService?: PlayApplicationService;
  sourceService?: SourceApplicationService;
  preparationService?: PreparationApplicationService;
  proposalService?: ProposalApplicationService;
  instanceService?: InstanceApplicationService;
  maintenanceService?: MaintenanceApplicationService;
  ontologyService?: OntologyProjectionService;
  traceStore?: TraceStore;
  configPath?: string;
  model?: string;
  startedAt?: string;
  csrfToken?: string;
}

declare module "fastify" {
  interface FastifyInstance {
    nwh: {
      events: WebEventBroker;
      startedAt: string;
      csrfToken: string;
      operations: OperationManager;
      mutations: WebMutationJournal;
      play: PlayApplicationService;
      sources: SourceApplicationService;
      preparation: PreparationApplicationService;
      proposals: ProposalApplicationService;
      instances: InstanceApplicationService;
      maintenance: MaintenanceApplicationService;
      ontology: OntologyProjectionService;
      traces: TraceStore;
      traceQueries: TraceApplicationService;
      modelSettings: ModelSettingsApplicationService;
      interactions: AuthInteractionManager;
    };
  }
}

export type NwhWebHost = FastifyInstance;

export async function createWebHost(options: CreateWebHostOptions): Promise<NwhWebHost> {
  const root = path.resolve(options.root);
  const configuredHost = options.host ?? "127.0.0.1";
  const startedAt = options.startedAt ?? new Date().toISOString();
  const csrfToken = options.csrfToken ?? crypto.randomBytes(32).toString("base64url");
  const events = options.eventBroker ?? new WebEventBroker();
  const catalogService = options.catalogService ?? new CatalogService(root);
  const defaultModelCatalog = options.modelCatalogService ? undefined : new PiModelCatalogService();
  const modelCatalogService = options.modelCatalogService ?? defaultModelCatalog!;
  const operations = options.operationManager ?? new OperationManager(events, { workspaceRoot: root });
  await operations.initialize();
  const mutations = options.mutationJournal ?? new WebMutationJournal(root);
  await mutations.initialize();
  const traces = options.traceStore ?? options.playService?.traceStore ?? new TraceStore(root);
  await traces.initialize();
  await new PlayTraceRecoveryService(root, traces).reconcileInterruptedPlayerMoves();
  const traceQueries = new TraceApplicationService(traces);
  const interactions = options.authInteractionManager ?? new AuthInteractionManager(events);
  const modelSettings = options.modelSettingsService ?? new ModelSettingsApplicationService({
    root,
    ...(options.configPath ? { configPath: options.configPath } : {}),
    catalog: modelCatalogService,
    ...(defaultModelCatalog ? { credentials: defaultModelCatalog } : {}),
    operations,
    mutations,
    interactions,
    events,
  });
  const play = options.playService ?? new PlayApplicationService({
    root,
    operations,
    events,
    traceStore: traces,
    mutations,
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.model ? { model: options.model } : {}),
  });
  const sources = options.sourceService ?? new SourceApplicationService({
    root,
    events,
    mutations,
    ...(options.configPath ? { configPath: options.configPath } : {}),
  });
  const preparation = options.preparationService ?? new PreparationApplicationService({
    root,
    operations,
    events,
    traceStore: traces,
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.model ? { model: options.model } : {}),
  });
  const proposals = options.proposalService ?? new ProposalApplicationService({ root, events, mutations });
  const instances = options.instanceService ?? new InstanceApplicationService({ root, events, mutations });
  const maintenance = options.maintenanceService ?? new MaintenanceApplicationService({ root, events, operations, traceStore: traces, mutations });
  const ontology = options.ontologyService ?? new OntologyProjectionService(root);
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 26_214_400 });
  app.decorate("nwh", { events, startedAt, csrfToken, operations, mutations, play, sources, preparation, proposals, instances, maintenance, ontology, traces, traceQueries, modelSettings, interactions });
  app.addHook("onClose", async () => { operations.shutdown(); });

  app.addHook("onRequest", async (request, reply) => {
    if (!isAllowedHost(request, configuredHost)) {
      return reply.code(403).send(apiError("HOST_NOT_ALLOWED", "The request Host is not allowed for this local Web UI."));
    }
    const isMutation = request.method !== "GET" && request.method !== "HEAD";
    const csrfMatches = isMutation && matchesCsrfToken(request, csrfToken);
    const origin = request.headers.origin;
    if (origin
      && !isSameOrigin(origin, request.headers.host, configuredHost)
      && !isTrustedSameOriginProxyMutation(request, csrfMatches)) {
      return reply.code(403).send(apiError("ORIGIN_NOT_ALLOWED", "Cross-origin requests are not allowed."));
    }
    if (isMutation && !csrfMatches) {
      return reply.code(403).send(apiError(
        "CSRF_TOKEN_INVALID",
        "Mutating Web UI requests require the CSRF token returned by /api/v1/bootstrap.",
      ));
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (request.url.startsWith(`/api/${WEB_API_VERSION}/`)) reply.header("Cache-Control", "no-store");
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof WebApplicationError) {
      void reply.code(error.statusCode).send(apiErrorSchema.parse(redactTraceSecrets(error.detail)));
      return;
    }
    if (error instanceof ZodError) {
      void reply.code(400).send(apiError("INVALID_REQUEST", "The request does not match the Web API contract.", error.issues));
      return;
    }
    const validation = typeof error === "object" && error !== null && "validation" in error
      ? error.validation
      : undefined;
    if (validation) {
      const message = error instanceof Error ? error.message : String(error);
      void reply.code(400).send(apiError("INVALID_REQUEST", message, validation));
      return;
    }
    app.log.error(error);
    void reply.code(500).send(apiError(
      "INTERNAL_ERROR",
      "The local Web Host could not complete this request. Its internal detail was withheld from the browser; inspect authoritative workspace state and do not retry unchanged.",
    ));
  });

  app.get(`/api/${WEB_API_VERSION}/health`, async () => healthResponseSchema.parse({
    status: "ok",
    apiVersion: WEB_API_VERSION,
    startedAt,
  }));

  const readBootstrap = async (): Promise<BootstrapResponse> => {
    const [catalog, modelCatalog] = await Promise.all([
      catalogService.read(),
      modelCatalogService.read(),
    ]);
    return bootstrapResponseSchema.parse({
      version: 1,
      apiVersion: WEB_API_VERSION,
      server: {
        name: "novel-world-harness",
        version: SERVER_VERSION,
        nodeVersion: process.versions.node,
        startedAt,
      },
      workspace: {
        root,
        displayName: catalog.project?.name ?? (path.basename(root) || "Novel World Harness"),
      },
      csrfToken,
      catalog,
      modelCatalog,
      features: [
        { id: "library", status: "available", phase: 0 },
        { id: "model-settings", status: "available", phase: 0 },
        { id: "play", status: "available", phase: 1 },
        { id: "trace", status: "available", phase: 1 },
        { id: "compiler", status: "available", phase: 2 },
        { id: "ontology", status: "available", phase: 2 },
      ],
    });
  };

  app.get(`/api/${WEB_API_VERSION}/bootstrap`, readBootstrap);
  app.get(`/api/${WEB_API_VERSION}/novels`, async () => (await catalogService.read()).novels);
  app.post(`/api/${WEB_API_VERSION}/sources`, async (request, reply) => {
    const result = await sources.register(sourceRegistrationRequestSchema.parse(request.body));
    return reply.code(result.reused ? 200 : 201).send(result);
  });
  app.get(`/api/${WEB_API_VERSION}/novels/:sourceId`, async (request) => {
    const { sourceId } = sourceParamSchema.parse(request.params);
    const { branchId } = preparationQuerySchema.parse(request.query);
    return preparation.inspect(sourceId, branchId);
  });
  app.get(`/api/${WEB_API_VERSION}/novels/:sourceId/preparation`, async (request) => {
    const { sourceId } = sourceParamSchema.parse(request.params);
    const { branchId } = preparationQuerySchema.parse(request.query);
    return preparation.inspect(sourceId, branchId);
  });
  app.get(`/api/${WEB_API_VERSION}/novels/:sourceId/ontology`, async (request) => {
    const { sourceId } = sourceParamSchema.parse(request.params);
    const query = ontologyQuerySchema.parse(request.query);
    return ontology.project({ sourceId, ...query });
  });
  app.post(`/api/${WEB_API_VERSION}/novels/:sourceId/prepare`, async (request, reply) => {
    const { sourceId } = sourceParamSchema.parse(request.params);
    const accepted = await preparation.start(sourceId, prepareNovelRequestSchema.parse(request.body));
    return reply.code(202).send(accepted);
  });
  app.get(`/api/${WEB_API_VERSION}/novels/:sourceId/proposals`, async (request) => {
    const { sourceId } = sourceParamSchema.parse(request.params);
    const query = proposalListQuerySchema.parse(request.query);
    return proposals.listPage(sourceId, query);
  });
  app.post(`/api/${WEB_API_VERSION}/novels/:sourceId/proposals/converge`, async (request) => {
    const { sourceId } = sourceParamSchema.parse(request.params);
    return proposals.converge(sourceId, proposalConvergeRequestSchema.parse(request.body));
  });
  app.get(`/api/${WEB_API_VERSION}/proposals/:proposalId`, async (request) => {
    const { proposalId } = proposalParamSchema.parse(request.params);
    const { status } = proposalDetailQuerySchema.parse(request.query);
    return proposals.get(proposalId, status);
  });
  app.post(`/api/${WEB_API_VERSION}/proposals/:proposalId/accept`, async (request) => {
    const { proposalId } = proposalParamSchema.parse(request.params);
    return proposals.accept(proposalId, proposalAcceptRequestSchema.parse(request.body));
  });
  app.post(`/api/${WEB_API_VERSION}/proposals/:proposalId/reject`, async (request) => {
    const { proposalId } = proposalParamSchema.parse(request.params);
    return proposals.reject(proposalId, proposalRejectRequestSchema.parse(request.body));
  });
  app.get(`/api/${WEB_API_VERSION}/instances`, async () => (await catalogService.read()).instances);
  app.post(`/api/${WEB_API_VERSION}/instances`, async (request, reply) => {
    const result = await instances.create(createInstanceRequestSchema.parse(request.body));
    return reply.code(result.created ? 201 : 200).send(result);
  });
  app.get(`/api/${WEB_API_VERSION}/instances/:branchId`, async (request) => {
    const { branchId } = branchParamSchema.parse(request.params);
    return instances.get(branchId);
  });
  app.post(`/api/${WEB_API_VERSION}/instances/:branchId/fork`, async (request, reply) => {
    const { branchId } = branchParamSchema.parse(request.params);
    const result = await instances.fork(branchId, forkInstanceRequestSchema.parse(request.body));
    return reply.code(result.created ? 201 : 200).send(result);
  });
  app.get(`/api/${WEB_API_VERSION}/instances/:branchId/removal-preview`, async (request) => {
    const { branchId } = branchParamSchema.parse(request.params);
    return maintenance.previewInstance(branchId);
  });
  app.delete(`/api/${WEB_API_VERSION}/instances/:branchId`, async (request) => {
    const { branchId } = branchParamSchema.parse(request.params);
    return maintenance.removeInstance(branchId, executeRemovalRequestSchema.parse(request.body));
  });
  app.get(`/api/${WEB_API_VERSION}/novels/:sourceId/removal-preview`, async (request) => {
    const { sourceId } = sourceParamSchema.parse(request.params);
    const { mode } = removalPreviewQuerySchema.parse(request.query);
    return mode === "analysis" ? maintenance.previewAnalysis(sourceId) : maintenance.previewNovel(sourceId);
  });
  app.post(`/api/${WEB_API_VERSION}/novels/:sourceId/reset-analysis`, async (request) => {
    const { sourceId } = sourceParamSchema.parse(request.params);
    return maintenance.resetAnalysis(sourceId, executeRemovalRequestSchema.parse(request.body));
  });
  app.delete(`/api/${WEB_API_VERSION}/novels/:sourceId`, async (request) => {
    const { sourceId } = sourceParamSchema.parse(request.params);
    return maintenance.removeNovel(sourceId, executeRemovalRequestSchema.parse(request.body));
  });
  app.get(`/api/${WEB_API_VERSION}/play-sessions`, async () => (await catalogService.read()).playSessions);
  app.get(`/api/${WEB_API_VERSION}/instances/:branchId/characters`, async (request) => {
    const { branchId } = branchParamSchema.parse(request.params);
    const { sourceId } = sourceQuerySchema.parse(request.query);
    return play.listCharacters(branchId, sourceId);
  });
  app.post(`/api/${WEB_API_VERSION}/play-sessions`, async (request, reply) => {
    const input = createPlaySessionRequestSchema.parse(request.body);
    return reply.code(201).send(await play.createSession(input));
  });
  app.get(`/api/${WEB_API_VERSION}/play-sessions/:sessionId`, async (request) => {
    const { sessionId } = sessionParamSchema.parse(request.params);
    return play.getSession(sessionId);
  });
  app.get(`/api/${WEB_API_VERSION}/play-sessions/:sessionId/messages`, async (request) => {
    const { sessionId } = sessionParamSchema.parse(request.params);
    return z.array(playMessageSummarySchema).parse((await play.getSession(sessionId)).messages);
  });
  app.post(`/api/${WEB_API_VERSION}/play-sessions/:sessionId/enter`, async (request, reply) => {
    const { sessionId } = sessionParamSchema.parse(request.params);
    const result = await play.enterSession(sessionId, enterPlaySessionRequestSchema.parse(request.body));
    return reply.code(result.state === "starting" ? 202 : 200).send(result);
  });
  app.patch(`/api/${WEB_API_VERSION}/play-sessions/:sessionId`, async (request) => {
    const { sessionId } = sessionParamSchema.parse(request.params);
    return play.updateSession(sessionId, updatePlaySessionRequestSchema.parse(request.body));
  });
  app.post(`/api/${WEB_API_VERSION}/play-sessions/:sessionId/activate`, async (request) => {
    const { sessionId } = sessionParamSchema.parse(request.params);
    return play.activateSession(sessionId, playSessionCommandRequestSchema.parse(request.body));
  });
  app.post(`/api/${WEB_API_VERSION}/play-sessions/:sessionId/restore`, async (request) => {
    const { sessionId } = sessionParamSchema.parse(request.params);
    return play.restoreSession(sessionId, playSessionCommandRequestSchema.parse(request.body));
  });
  app.delete(`/api/${WEB_API_VERSION}/play-sessions/:sessionId/messages`, async (request) => {
    const { sessionId } = sessionParamSchema.parse(request.params);
    return play.clearConversation(sessionId, playSessionCommandRequestSchema.parse(request.body));
  });
  app.delete(`/api/${WEB_API_VERSION}/play-sessions/:sessionId`, async (request) => {
    const { sessionId } = sessionParamSchema.parse(request.params);
    return play.removeSession(sessionId, playSessionCommandRequestSchema.parse(request.body));
  });
  app.post(`/api/${WEB_API_VERSION}/play-sessions/:sessionId/moves`, async (request, reply) => {
    const { sessionId } = sessionParamSchema.parse(request.params);
    const accepted = await play.startPlayerMove(sessionId, playMoveRequestSchema.parse(request.body));
    return reply.code(202).send(accepted);
  });
  app.post(`/api/${WEB_API_VERSION}/play-sessions/:sessionId/narrations`, async (request, reply) => {
    const { sessionId } = sessionParamSchema.parse(request.params);
    const accepted = await play.startSceneNarration(sessionId, sceneNarrationRequestSchema.parse(request.body));
    return reply.code(202).send(accepted);
  });
  app.post(`/api/${WEB_API_VERSION}/play-sessions/:sessionId/retry-narration`, async (request, reply) => {
    const { sessionId } = sessionParamSchema.parse(request.params);
    const accepted = await play.startNarrationRetry(sessionId, narrationRetryRequestSchema.parse(request.body));
    return reply.code(202).send(accepted);
  });
  app.get(`/api/${WEB_API_VERSION}/operations`, async (request) => {
    const query = operationQuerySchema.parse(request.query);
    return operations.list().filter((operation) =>
      (!query.scopeId || operation.scopeId === query.scopeId)
      && (!query.kind || operation.kind === query.kind)
      && (!query.status || operation.status === query.status)).slice(0, query.limit);
  });
  app.get(`/api/${WEB_API_VERSION}/operations/:operationId`, async (request) => {
    const { operationId } = operationParamSchema.parse(request.params);
    return operations.get(operationId);
  });
  app.post(`/api/${WEB_API_VERSION}/operations/:operationId/cancel`, async (request) => {
    const { operationId } = operationParamSchema.parse(request.params);
    return operations.cancel(operationId);
  });
  app.get(`/api/${WEB_API_VERSION}/runs`, async (request) => {
    const query = traceRunQuerySchema.parse(request.query);
    const filter: TraceRunSearchFilter = {
      ...(query.sessionId ?? query.playSessionId
        ? { playSessionId: query.sessionId ?? query.playSessionId }
        : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.modelId ? { modelId: query.modelId } : {}),
      ...(query.stage ? { stage: query.stage } : {}),
      ...(query.startedAfter ? { startedAfter: query.startedAfter } : {}),
      ...(query.startedBefore ? { startedBefore: query.startedBefore } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    };
    return traceQueries.listRuns(filter);
  });
  app.get(`/api/${WEB_API_VERSION}/runs/:runId`, async (request) => {
    const { runId } = traceRunParamSchema.parse(request.params);
    return traceQueries.getRun(runId);
  });
  app.get(`/api/${WEB_API_VERSION}/runs/:runId/events`, async (request) => {
    const { runId } = traceRunParamSchema.parse(request.params);
    const { afterSeq } = traceEventsQuerySchema.parse(request.query);
    return traceQueries.getEvents(runId, afterSeq);
  });
  app.get(`/api/${WEB_API_VERSION}/runs/:runId/events/:seq/payload`, async (request) => {
    const { runId, seq } = traceEventParamSchema.parse(request.params);
    return traceQueries.getEventPayload(runId, seq);
  });
  app.get(`/api/${WEB_API_VERSION}/calls/:callId/context`, async (request) => {
    const { callId } = traceCallParamSchema.parse(request.params);
    const { runId } = traceCallQuerySchema.parse(request.query);
    return traceQueries.getCall(callId, runId);
  });
  app.get(`/api/${WEB_API_VERSION}/ontology/nodes/:nodeId`, async (request) => {
    const { nodeId } = ontologyNodeParamSchema.parse(request.params);
    const query = ontologyNodeQuerySchema.parse(request.query);
    return ontology.getNode(query, nodeId);
  });
  app.get(`/api/${WEB_API_VERSION}/models/providers`, async () => (await modelCatalogService.read()).providers);
  app.get(`/api/${WEB_API_VERSION}/models`, async () => (await modelCatalogService.read()).models);
  app.get(`/api/${WEB_API_VERSION}/model-profiles`, async () => modelSettings.listProfiles());
  app.patch(`/api/${WEB_API_VERSION}/model-profiles/:role`, async (request) => {
    const { role } = modelRoleParamSchema.parse(request.params);
    return modelSettings.updateProfile(role, updateModelProfileRequestSchema.parse(request.body));
  });
  app.post(`/api/${WEB_API_VERSION}/models/providers/:providerId/login`, async (request, reply) => {
    const { providerId } = providerParamSchema.parse(request.params);
    return reply.code(202).send(await modelSettings.startLogin(providerId, providerLoginRequestSchema.parse(request.body)));
  });
  app.delete(`/api/${WEB_API_VERSION}/models/providers/:providerId/credential`, async (request) => {
    const { providerId } = providerParamSchema.parse(request.params);
    return modelSettings.logout(providerId, providerCredentialRequestSchema.parse(request.body));
  });
  app.post(`/api/${WEB_API_VERSION}/interactions/:interactionId/answer`, async (request) => {
    const { interactionId } = interactionParamSchema.parse(request.params);
    return interactions.answer(interactionId, answerAuthInteractionRequestSchema.parse(request.body));
  });
  app.get(`/api/${WEB_API_VERSION}/events`, (request, reply) => {
    const raw = reply.raw;
    reply.hijack();
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    raw.flushHeaders();
    const headerCursor = request.headers["last-event-id"];
    const cursor = Array.isArray(headerCursor) ? headerCursor[0] : headerCursor;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = events.subscribe((event) => raw.write(serializeServerSentEvent(event)), cursor);
    } catch (error) {
      raw.write(`event: error\ndata: ${JSON.stringify(apiError("INVALID_EVENT_CURSOR", error instanceof Error ? error.message : String(error)))}\n\n`);
      raw.end();
      return;
    }
    const heartbeat = setInterval(() => raw.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe?.();
    };
    request.raw.once("close", cleanup);
    request.raw.once("error", cleanup);
  });

  const serveStatic = options.serveStatic ?? true;
  const staticRoot = path.resolve(options.staticRoot ?? DEFAULT_STATIC_ROOT);
  if (serveStatic) {
    await assertStaticAssets(staticRoot);
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: "/",
      wildcard: false,
      decorateReply: true,
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith(`/api/${WEB_API_VERSION}/`)) {
      return reply.code(404).send(apiError("NOT_FOUND", `No API route matches this ${request.method} request.`, {
        discoveryEndpoint: `/api/${WEB_API_VERSION}/bootstrap`,
      }));
    }
    if (serveStatic && request.method === "GET" && acceptsHtml(request)) return reply.sendFile("index.html");
    return reply.code(404).send(apiError("NOT_FOUND", `No route matches this ${request.method} request.`));
  });

  events.publish("server.ready", { apiVersion: WEB_API_VERSION, startedAt });
  return app;
}

function apiError(code: string, message: string, details?: unknown): ApiError {
  return apiErrorSchema.parse(redactTraceSecrets({
    code,
    message,
    ...(details !== undefined ? { details } : {}),
    retry: { kind: "none" },
  }));
}

function isAllowedHost(request: FastifyRequest, configuredHost: string): boolean {
  const requestHost = request.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const allowed = new Set([configuredHost.toLowerCase().replace(/^\[|\]$/g, "")]);
  if (isLoopbackHost(configuredHost)) {
    allowed.add("127.0.0.1");
    allowed.add("localhost");
    allowed.add("::1");
  }
  return allowed.has(requestHost);
}

function isSameOrigin(origin: string, hostHeader: string | undefined, configuredHost: string): boolean {
  if (!hostHeader) return false;
  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.host.toLowerCase() === hostHeader.toLowerCase()) return true;
    if (!isLoopbackHost(configuredHost)) return false;
    const requestHostname = new URL(`http://${hostHeader}`).hostname;
    return isLoopbackHost(parsedOrigin.hostname) && isLoopbackHost(requestHostname);
  } catch {
    return false;
  }
}

function isTrustedSameOriginProxyMutation(request: FastifyRequest, csrfMatches: boolean): boolean {
  if (!csrfMatches) return false;
  const fetchSite = request.headers["sec-fetch-site"];
  const value = Array.isArray(fetchSite) ? fetchSite[0] : fetchSite;
  // Chromium sets this forbidden request header from the browser-visible URL.
  // It lets a same-origin local reverse proxy preserve the external Origin while
  // the backend still requires the unguessable bootstrap CSRF token.
  return value === "same-origin";
}

function matchesCsrfToken(request: FastifyRequest, expected: string): boolean {
  const header = request.headers["x-nwh-csrf"];
  const received = Array.isArray(header) ? header[0] : header;
  if (!received) return false;
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && crypto.timingSafeEqual(receivedBytes, expectedBytes);
}

function acceptsHtml(request: FastifyRequest): boolean {
  return request.headers.accept?.includes("text/html") ?? false;
}

async function assertStaticAssets(staticRoot: string): Promise<void> {
  try {
    await fs.access(path.join(staticRoot, "index.html"));
  } catch {
    throw new Error(`Web UI assets are missing at ${staticRoot}. Run 'pnpm run build:web' or use a packaged nwh build.`);
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

const branchParamSchema = z.object({ branchId: z.string().min(1) }).strict();
const sourceParamSchema = z.object({ sourceId: z.string().min(1) }).strict();
const proposalParamSchema = z.object({ proposalId: z.string().min(1) }).strict();
const sessionParamSchema = z.object({ sessionId: z.string().min(1) }).strict();
const operationParamSchema = z.object({ operationId: z.string().min(1) }).strict();
const providerParamSchema = z.object({ providerId: z.string().min(1) }).strict();
const modelRoleParamSchema = z.object({ role: modelRoleSchema }).strict();
const interactionParamSchema = z.object({ interactionId: z.string().min(1) }).strict();
const sourceQuerySchema = z.object({ sourceId: z.string().min(1).optional() }).strict();
const preparationQuerySchema = z.object({ branchId: z.string().min(1).optional() }).strict();
const proposalListQuerySchema = z.object({
  status: z.enum(["pending", "accepted", "rejected"]).default("pending"),
  kind: z.string().min(1).optional(),
  cursor: z.string().min(1).max(2_000).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();
const proposalDetailQuerySchema = z.object({
  status: z.enum(["pending", "accepted", "rejected"]).optional(),
}).strict();
const ontologyLayersQuerySchema = z.preprocess(
  (value) => typeof value === "string" ? value.split(",").filter(Boolean) : value,
  z.array(ontologyLayerSchema).optional(),
);
const ontologyBooleanQuerySchema = z.preprocess(
  (value) => value === "true" ? true : value === "false" || value === undefined ? false : value,
  z.boolean(),
);
const ontologyQuerySchema = z.object({
  view: ontologyViewSchema,
  branchId: z.string().min(1).optional(),
  atCommit: z.string().min(1).optional(),
  includeCanonicalFuture: ontologyBooleanQuerySchema.default(false),
  layers: ontologyLayersQuerySchema,
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).max(2_000).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  kind: z.string().min(1).max(200).optional(),
  status: ontologyStatusSchema.optional(),
}).strict();
const ontologyNodeQuerySchema = ontologyQuerySchema.extend({
  sourceId: z.string().min(1),
  relationLimit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();
const ontologyNodeParamSchema = z.object({ nodeId: z.string().min(1) }).strict();
const removalPreviewQuerySchema = z.object({
  mode: z.enum(["analysis", "novel"]),
}).strict();
const operationQuerySchema = z.object({
  scopeId: z.string().min(1).optional(),
  kind: operationKindSchema.optional(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
}).strict();
const traceRunParamSchema = z.object({ runId: traceIdentifierSchema }).strict();
const traceCallParamSchema = z.object({ callId: traceIdentifierSchema }).strict();
const traceEventParamSchema = z.object({
  runId: traceIdentifierSchema,
  seq: z.coerce.number().int().positive(),
}).strict();
const traceRunQuerySchema = z.object({
  sessionId: z.string().min(1).optional(),
  playSessionId: z.string().min(1).optional(),
  branchId: z.string().min(1).optional(),
  kind: traceRunKindSchema.optional(),
  status: traceRunStatusSchema.optional(),
  modelId: z.string().min(1).optional(),
  stage: z.string().min(1).optional(),
  startedAfter: z.string().datetime({ offset: true }).optional(),
  startedBefore: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).optional(),
}).strict().refine(
  (query) => !query.sessionId || !query.playSessionId || query.sessionId === query.playSessionId,
  { message: "sessionId and playSessionId must match when both are provided." },
);
const traceEventsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0),
}).strict();
const traceCallQuerySchema = z.object({
  runId: traceIdentifierSchema.optional(),
}).strict();

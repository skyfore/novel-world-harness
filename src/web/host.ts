import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { z, ZodError } from "zod";
import { CatalogService } from "../application/catalog-service.js";
import { PiModelCatalogService, type ModelCatalogReader } from "../application/model-catalog-service.js";
import { PlayApplicationService } from "../application/play-service.js";
import {
  WEB_API_VERSION,
  apiErrorSchema,
  bootstrapResponseSchema,
  createPlaySessionRequestSchema,
  healthResponseSchema,
  playMoveRequestSchema,
  sceneNarrationRequestSchema,
  updatePlaySessionRequestSchema,
  type ApiError,
  type BootstrapResponse,
} from "./contracts.js";
import { serializeServerSentEvent, WebEventBroker } from "./event-stream.js";
import { WebApplicationError } from "./errors.js";
import { OperationManager } from "./operation-manager.js";
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
  eventBroker?: WebEventBroker;
  operationManager?: OperationManager;
  playService?: PlayApplicationService;
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
      play: PlayApplicationService;
      traces: TraceStore;
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
  const modelCatalogService = options.modelCatalogService ?? new PiModelCatalogService();
  const operations = options.operationManager ?? new OperationManager(events);
  const traces = options.traceStore ?? options.playService?.traceStore ?? new TraceStore(root);
  await traces.initialize();
  const play = options.playService ?? new PlayApplicationService({
    root,
    operations,
    events,
    traceStore: traces,
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.model ? { model: options.model } : {}),
  });
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 1_048_576 });
  app.decorate("nwh", { events, startedAt, csrfToken, operations, play, traces });

  app.addHook("onRequest", async (request, reply) => {
    if (!isAllowedHost(request, configuredHost)) {
      return reply.code(403).send(apiError("HOST_NOT_ALLOWED", "The request Host is not allowed for this local Web UI."));
    }
    const origin = request.headers.origin;
    if (origin && !isSameOrigin(origin, request.headers.host)) {
      return reply.code(403).send(apiError("ORIGIN_NOT_ALLOWED", "Cross-origin requests are not allowed."));
    }
    if (request.method !== "GET" && request.method !== "HEAD" && !matchesCsrfToken(request, csrfToken)) {
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
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (request.url.startsWith(`/api/${WEB_API_VERSION}/`)) reply.header("Cache-Control", "no-store");
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof WebApplicationError) {
      void reply.code(error.statusCode).send(error.detail);
      return;
    }
    if (error instanceof ZodError) {
      void reply.code(400).send(apiError("INVALID_REQUEST", "The request does not match the Web API contract.", error.issues));
      return;
    }
    const validation = typeof error === "object" && error !== null && "validation" in error
      ? error.validation
      : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (validation) {
      void reply.code(400).send(apiError("INVALID_REQUEST", message, validation));
      return;
    }
    app.log.error(error);
    void reply.code(500).send(apiError("INTERNAL_ERROR", message));
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
        { id: "model-settings", status: "foundation", phase: 0 },
        { id: "play", status: "available", phase: 1 },
        { id: "trace", status: "foundation", phase: 1 },
        { id: "compiler", status: "planned", phase: 2 },
        { id: "ontology", status: "planned", phase: 2 },
      ],
    });
  };

  app.get(`/api/${WEB_API_VERSION}/bootstrap`, readBootstrap);
  app.get(`/api/${WEB_API_VERSION}/novels`, async () => (await catalogService.read()).novels);
  app.get(`/api/${WEB_API_VERSION}/instances`, async () => (await catalogService.read()).instances);
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
  app.patch(`/api/${WEB_API_VERSION}/play-sessions/:sessionId`, async (request) => {
    const { sessionId } = sessionParamSchema.parse(request.params);
    return play.updateSession(sessionId, updatePlaySessionRequestSchema.parse(request.body));
  });
  app.post(`/api/${WEB_API_VERSION}/play-sessions/:sessionId/activate`, async (request) => {
    const { sessionId } = sessionParamSchema.parse(request.params);
    return play.activateSession(sessionId);
  });
  app.post(`/api/${WEB_API_VERSION}/play-sessions/:sessionId/restore`, async (request) => {
    const { sessionId } = sessionParamSchema.parse(request.params);
    return play.restoreSession(sessionId);
  });
  app.delete(`/api/${WEB_API_VERSION}/play-sessions/:sessionId/messages`, async (request) => {
    const { sessionId } = sessionParamSchema.parse(request.params);
    return play.clearConversation(sessionId);
  });
  app.delete(`/api/${WEB_API_VERSION}/play-sessions/:sessionId`, async (request) => {
    const { sessionId } = sessionParamSchema.parse(request.params);
    return play.removeSession(sessionId);
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
  app.get(`/api/${WEB_API_VERSION}/operations`, async (request) => {
    const query = operationQuerySchema.parse(request.query);
    return operations.list().filter((operation) =>
      (!query.scopeId || operation.scopeId === query.scopeId)
      && (!query.kind || operation.kind === query.kind)
      && (!query.status || operation.status === query.status));
  });
  app.get(`/api/${WEB_API_VERSION}/operations/:operationId`, async (request) => {
    const { operationId } = operationParamSchema.parse(request.params);
    return operations.get(operationId);
  });
  app.post(`/api/${WEB_API_VERSION}/operations/:operationId/cancel`, async (request) => {
    const { operationId } = operationParamSchema.parse(request.params);
    return operations.cancel(operationId);
  });
  app.get(`/api/${WEB_API_VERSION}/models/providers`, async () => (await modelCatalogService.read()).providers);
  app.get(`/api/${WEB_API_VERSION}/models`, async () => (await modelCatalogService.read()).models);
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
      return reply.code(404).send(apiError("NOT_FOUND", `No API route matches ${request.method} ${request.url}.`, {
        discoveryEndpoint: `/api/${WEB_API_VERSION}/bootstrap`,
      }));
    }
    if (serveStatic && request.method === "GET" && acceptsHtml(request)) return reply.sendFile("index.html");
    return reply.code(404).send(apiError("NOT_FOUND", `No route matches ${request.method} ${request.url}.`));
  });

  events.publish("server.ready", { apiVersion: WEB_API_VERSION, startedAt });
  return app;
}

function apiError(code: string, message: string, details?: unknown): ApiError {
  return apiErrorSchema.parse({
    code,
    message,
    ...(details !== undefined ? { details } : {}),
    retry: { kind: "none" },
  });
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

function isSameOrigin(origin: string, hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    return new URL(origin).host.toLowerCase() === hostHeader.toLowerCase();
  } catch {
    return false;
  }
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
const sessionParamSchema = z.object({ sessionId: z.string().min(1) }).strict();
const operationParamSchema = z.object({ operationId: z.string().min(1) }).strict();
const sourceQuerySchema = z.object({ sourceId: z.string().min(1).optional() }).strict();
const operationQuerySchema = z.object({
  scopeId: z.string().min(1).optional(),
  kind: z.enum(["player-move", "scene-narration", "prepare"]).optional(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]).optional(),
}).strict();

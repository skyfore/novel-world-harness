import fs from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { CatalogService } from "../application/catalog-service.js";
import { PiModelCatalogService, type ModelCatalogReader } from "../application/model-catalog-service.js";
import {
  WEB_API_VERSION,
  apiErrorSchema,
  bootstrapResponseSchema,
  healthResponseSchema,
  type ApiError,
  type BootstrapResponse,
} from "./contracts.js";
import { serializeServerSentEvent, WebEventBroker } from "./event-stream.js";

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
  startedAt?: string;
}

declare module "fastify" {
  interface FastifyInstance {
    nwh: {
      events: WebEventBroker;
      startedAt: string;
    };
  }
}

export type NwhWebHost = FastifyInstance;

export async function createWebHost(options: CreateWebHostOptions): Promise<NwhWebHost> {
  const root = path.resolve(options.root);
  const configuredHost = options.host ?? "127.0.0.1";
  const startedAt = options.startedAt ?? new Date().toISOString();
  const events = options.eventBroker ?? new WebEventBroker();
  const catalogService = options.catalogService ?? new CatalogService(root);
  const modelCatalogService = options.modelCatalogService ?? new PiModelCatalogService();
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 1_048_576 });
  app.decorate("nwh", { events, startedAt });

  app.addHook("onRequest", async (request, reply) => {
    if (!isAllowedHost(request, configuredHost)) {
      return reply.code(403).send(apiError("HOST_NOT_ALLOWED", "The request Host is not allowed for this local Web UI."));
    }
    const origin = request.headers.origin;
    if (origin && !isSameOrigin(origin, request.headers.host)) {
      return reply.code(403).send(apiError("ORIGIN_NOT_ALLOWED", "Cross-origin requests are not allowed."));
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
      catalog,
      modelCatalog,
      features: [
        { id: "library", status: "available", phase: 0 },
        { id: "model-settings", status: "foundation", phase: 0 },
        { id: "play", status: "planned", phase: 1 },
        { id: "trace", status: "planned", phase: 1 },
        { id: "compiler", status: "planned", phase: 2 },
        { id: "ontology", status: "planned", phase: 2 },
      ],
    });
  };

  app.get(`/api/${WEB_API_VERSION}/bootstrap`, readBootstrap);
  app.get(`/api/${WEB_API_VERSION}/novels`, async () => (await catalogService.read()).novels);
  app.get(`/api/${WEB_API_VERSION}/instances`, async () => (await catalogService.read()).instances);
  app.get(`/api/${WEB_API_VERSION}/play-sessions`, async () => (await catalogService.read()).playSessions);
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

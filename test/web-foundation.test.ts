import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceStore } from "../src/storage/workspace-store.js";
import { CatalogService, legacyPlaySessionId } from "../src/application/catalog-service.js";
import { createWebHost, isLoopbackHost, type NwhWebHost } from "../src/web/host.js";
import { WebEventBroker, serializeServerSentEvent } from "../src/web/event-stream.js";
import {
  bootstrapResponseSchema,
  healthResponseSchema,
  modelCatalogSchema,
  preparationSnapshotSchema,
  proposalPageSchema,
  removalExecutionResultSchema,
  removalPreviewSchema,
  sourceRegistrationResultSchema,
  type ModelCatalog,
} from "../src/web/contracts.js";
import { parseWebPort } from "../src/commands/web.js";

const roots: string[] = [];
const apps: NwhWebHost[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function workspace(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

const emptyModels: ModelCatalog = modelCatalogSchema.parse({ providers: [], models: [] });

describe("Web application catalog", () => {
  it("projects registered sources without parsing terminal output", async () => {
    const root = await workspace("nwh-web-catalog-");
    const store = await WorkspaceStore.create(root);
    await store.ensureProject({ name: "Browser Worlds", language: "zh-CN" });
    const source = await store.registerSourceContent("白夜行.txt", "雪穗站在窗边。\n");

    const snapshot = await new CatalogService(root).read();

    expect(snapshot.project).toMatchObject({ name: "Browser Worlds", language: "zh-CN" });
    expect(snapshot.novels).toEqual([
      expect.objectContaining({
        id: source.id,
        title: "白夜行.txt",
        sourcePath: "content:白夜行.txt",
        instanceCount: 0,
      }),
    ]);
    expect(snapshot.instances).toEqual([]);
    expect(snapshot.playSessions).toEqual([]);
    expect(snapshot.activeSessionId).toBeNull();
    expect(legacyPlaySessionId("main")).toBe("play-main");
  });
});

describe("Web event stream", () => {
  it("replays ordered events after a cursor and keeps a bounded history", () => {
    const broker = new WebEventBroker(2);
    const first = broker.publish("server.ready", { phase: 0 });
    const second = broker.publish("catalog.invalidated", { reason: "test" });
    const third = broker.publish("operation.changed", { status: "running" }, { operationId: "op-1" });

    expect(first.eventId).toBe("1");
    expect(broker.latestEventId).toBe("3");
    expect(broker.replayAfter()).toEqual([second, third]);
    expect(broker.replayAfter("2")).toEqual([third]);
    expect(() => broker.replayAfter("guess")).toThrow("non-negative integer string");
    expect(serializeServerSentEvent(third)).toContain("event: operation.changed\n");
    expect(serializeServerSentEvent(third)).toContain('"operationId":"op-1"');
  });

  it("delivers replay before live events and supports unsubscribe", () => {
    const broker = new WebEventBroker();
    broker.publish("server.ready");
    const seen: string[] = [];
    const unsubscribe = broker.subscribe((event) => seen.push(event.eventId), "0");
    broker.publish("catalog.invalidated");
    unsubscribe();
    broker.publish("catalog.invalidated");
    expect(seen).toEqual(["1", "2"]);
  });

  it("redacts secrets before replay, listener delivery, or serialization", () => {
    const broker = new WebEventBroker();
    const seen: unknown[] = [];
    broker.subscribe((event) => seen.push(event));
    const event = broker.publish("operation.changed", {
      authorization: "Bearer event-stream-canary",
      nested: { apiKey: "plain-event-secret-canary", safe: "visible" },
    });

    expect(event.data).toEqual({
      authorization: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", safe: "visible" },
    });
    const observable = JSON.stringify({ event, replay: broker.replayAfter(), seen, wire: serializeServerSentEvent(event) });
    expect(observable).not.toContain("event-stream-canary");
    expect(observable).not.toContain("plain-event-secret-canary");
  });

  it("isolates a failed event consumer from business event publication", () => {
    const broker = new WebEventBroker();
    const healthy = vi.fn();
    broker.subscribe(() => { throw new Error("disconnected SSE socket"); });
    broker.subscribe(healthy);

    expect(() => broker.publish("catalog.invalidated", { reason: "test" })).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
    broker.publish("catalog.invalidated", { reason: "second" });
    expect(healthy).toHaveBeenCalledTimes(2);
  });
});

describe("local Web host", () => {
  it("registers browser source content and exposes its preparation checkpoint", async () => {
    const root = await workspace("nwh-web-source-route-");
    const app = await createWebHost({
      root,
      serveStatic: false,
      modelCatalogService: { read: async () => emptyModels },
      csrfToken: "source-route-csrf-token-that-is-long-enough",
    });
    apps.push(app);

    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers: { "x-nwh-csrf": "source-route-csrf-token-that-is-long-enough" },
      payload: {
        title: "browser-story.txt",
        content: "The browser opens a world.\n",
        clientRequestId: "source-route-1",
      },
    });
    expect(registered.statusCode).toBe(201);
    const result = sourceRegistrationResultSchema.parse(registered.json());
    expect(result).toMatchObject({
      source: { title: "browser-story.txt" },
      preparation: { stage: "compile" },
    });

    const preparation = await app.inject({
      method: "GET",
      url: `/api/v1/novels/${result.source.id}/preparation`,
    });
    expect(preparation.statusCode).toBe(200);
    expect(preparationSnapshotSchema.parse(preparation.json())).toMatchObject({
      source: { id: result.source.id },
      nextAction: "compile",
    });

    const proposals = await app.inject({
      method: "GET",
      url: `/api/v1/novels/${result.source.id}/proposals?status=pending`,
    });
    expect(proposals.statusCode).toBe(200);
    expect(proposalPageSchema.parse(proposals.json())).toMatchObject({
      items: [],
      page: { loaded: 0, total: 0, nextCursor: null },
    });
  });

  it("requires a fresh effect hash and exact source confirmation for maintenance routes", async () => {
    const root = await workspace("nwh-web-maintenance-route-");
    const store = await WorkspaceStore.create(root);
    const source = await store.registerSourceContent("maintenance.txt", "Nothing has been compiled yet.\n");
    const csrfToken = "maintenance-route-csrf-token-is-long-enough";
    const app = await createWebHost({
      root,
      serveStatic: false,
      modelCatalogService: { read: async () => emptyModels },
      csrfToken,
    });
    apps.push(app);

    const previewResponse = await app.inject({
      method: "GET",
      url: `/api/v1/novels/${source.id}/removal-preview?mode=analysis`,
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = removalPreviewSchema.parse(previewResponse.json());
    expect(preview).toMatchObject({ action: "reset-analysis", executable: true, target: { confirmation: source.id } });

    const resetResponse = await app.inject({
      method: "POST",
      url: `/api/v1/novels/${source.id}/reset-analysis`,
      headers: { "x-nwh-csrf": csrfToken },
      payload: { effectHash: preview.effectHash, confirmation: source.id, clientRequestId: "maintenance-route-reset" },
    });
    expect(resetResponse.statusCode).toBe(200);
    expect(removalExecutionResultSchema.parse(resetResponse.json())).toMatchObject({ action: "reset-analysis", immutableSourcePreserved: true });

    const novelPreviewResponse = await app.inject({ method: "GET", url: `/api/v1/novels/${source.id}/removal-preview?mode=novel` });
    const novelPreview = removalPreviewSchema.parse(novelPreviewResponse.json());
    const removeResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/novels/${source.id}`,
      headers: { "x-nwh-csrf": csrfToken },
      payload: { effectHash: novelPreview.effectHash, confirmation: source.id, clientRequestId: "maintenance-route-remove" },
    });
    expect(removeResponse.statusCode).toBe(200);
    expect(removalExecutionResultSchema.parse(removeResponse.json())).toMatchObject({ action: "remove-novel", removed: { sourceRegistrations: 1 } });
  });

  it("serves versioned catalog APIs with strict local headers", async () => {
    const root = await workspace("nwh-web-host-");
    const store = await WorkspaceStore.create(root);
    await store.ensureProject({ name: "Host Test", language: "en" });
    await store.registerSourceContent("story.txt", "A beginning.\n");
    const app = await createWebHost({
      root,
      serveStatic: false,
      modelCatalogService: { read: async () => emptyModels },
      startedAt: "2026-08-30T00:00:00.000Z",
    });
    apps.push(app);

    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(healthResponseSchema.parse(health.json())).toEqual({
      status: "ok",
      apiVersion: "v1",
      startedAt: "2026-08-30T00:00:00.000Z",
    });
    expect(health.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(health.headers["content-security-policy"]).toContain("style-src-attr 'unsafe-inline'");
    expect(health.headers["cache-control"]).toBe("no-store");

    const response = await app.inject({ method: "GET", url: "/api/v1/bootstrap" });
    expect(response.statusCode).toBe(200);
    const bootstrap = bootstrapResponseSchema.parse(response.json());
    expect(bootstrap.workspace.displayName).toBe("Host Test");
    expect(bootstrap.csrfToken).toHaveLength(43);
    expect(bootstrap.catalog.novels).toHaveLength(1);
    expect(bootstrap.features).toContainEqual({ id: "library", status: "available", phase: 0 });

    const novels = await app.inject({ method: "GET", url: "/api/v1/novels" });
    expect(novels.json()).toEqual([expect.objectContaining({ title: "story.txt" })]);
    const missing = await app.inject({ method: "GET", url: "/api/v1/missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "NOT_FOUND", retry: { kind: "none" } });

    const mutationWithoutToken = await app.inject({ method: "POST", url: "/api/v1/missing" });
    expect(mutationWithoutToken.statusCode).toBe(403);
    expect(mutationWithoutToken.json()).toMatchObject({ code: "CSRF_TOKEN_INVALID" });
    const mutationWithToken = await app.inject({
      method: "POST",
      url: "/api/v1/missing",
      headers: { "x-nwh-csrf": bootstrap.csrfToken },
    });
    expect(mutationWithToken.statusCode).toBe(404);
  });

  it("rejects cross-origin requests and unexpected Host headers", async () => {
    const root = await workspace("nwh-web-origin-");
    const app = await createWebHost({
      root,
      serveStatic: false,
      modelCatalogService: { read: async () => emptyModels },
    });
    apps.push(app);

    const origin = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "localhost:3080", origin: "https://evil.example" },
    });
    expect(origin.statusCode).toBe(403);
    expect(origin.json()).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });

    const host = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "attacker.example:3080" },
    });
    expect(host.statusCode).toBe(403);
    expect(host.json()).toMatchObject({ code: "HOST_NOT_ALLOWED" });
  });

  it("does not expose unexpected server errors or secret-bearing domain identifiers", async () => {
    const root = await workspace("nwh-web-error-boundary-");
    const catalog = new CatalogService(root);
    vi.spyOn(catalog, "read").mockRejectedValue(new Error("Bearer generic-host-error-canary"));
    const app = await createWebHost({
      root,
      serveStatic: false,
      catalogService: catalog,
      modelCatalogService: { read: async () => emptyModels },
    });
    apps.push(app);

    const unexpected = await app.inject({ method: "GET", url: "/api/v1/bootstrap" });
    expect(unexpected.statusCode).toBe(500);
    expect(unexpected.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      retry: { kind: "none" },
    });
    expect(unexpected.body).not.toContain("generic-host-error-canary");

    const missing = await app.inject({ method: "GET", url: "/api/v1/operations/sk-domain-identifier-canary" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "OPERATION_NOT_FOUND", message: "Unknown operation '[REDACTED]'." });
    expect(missing.body).not.toContain("domain-identifier-canary");

    const unknownRoute = await app.inject({ method: "GET", url: "/api/v1/missing?opaque=plain-url-secret-canary" });
    expect(unknownRoute.statusCode).toBe(404);
    expect(unknownRoute.body).not.toContain("plain-url-secret-canary");
  });

  it("serves the built SPA shell for browser routes", async () => {
    const root = await workspace("nwh-web-static-workspace-");
    const staticRoot = await workspace("nwh-web-static-assets-");
    await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>NWH test shell</title>", "utf8");
    const app = await createWebHost({
      root,
      staticRoot,
      modelCatalogService: { read: async () => emptyModels },
    });
    apps.push(app);

    const rootPage = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
    expect(rootPage.statusCode).toBe(200);
    expect(rootPage.body).toContain("NWH test shell");
    const nestedPage = await app.inject({ method: "GET", url: "/instances/main", headers: { accept: "text/html" } });
    expect(nestedPage.statusCode).toBe(200);
    expect(nestedPage.body).toContain("NWH test shell");
    const ingestPage = await app.inject({ method: "GET", url: "/novels/new", headers: { accept: "text/html" } });
    expect(ingestPage.statusCode).toBe(200);
    expect(ingestPage.body).toContain("NWH test shell");
    const compilerPage = await app.inject({ method: "GET", url: "/novels/source-1/compile", headers: { accept: "text/html" } });
    expect(compilerPage.statusCode).toBe(200);
    expect(compilerPage.body).toContain("NWH test shell");
    const ontologyPage = await app.inject({ method: "GET", url: "/novels/source-1/ontology/events", headers: { accept: "text/html" } });
    expect(ontologyPage.statusCode).toBe(200);
    expect(ontologyPage.body).toContain("NWH test shell");
    const traceListPage = await app.inject({ method: "GET", url: "/traces", headers: { accept: "text/html" } });
    expect(traceListPage.statusCode).toBe(200);
    expect(traceListPage.body).toContain("NWH test shell");
    const traceDetailPage = await app.inject({ method: "GET", url: "/play/play-main/trace/run-1", headers: { accept: "text/html" } });
    expect(traceDetailPage.statusCode).toBe(200);
    expect(traceDetailPage.body).toContain("NWH test shell");
  });
});

describe("Web command safety", () => {
  it("validates ports and loopback hosts", () => {
    expect(parseWebPort("3080")).toBe(3080);
    expect(() => parseWebPort("0")).toThrow("--port");
    expect(() => parseWebPort("3.5")).toThrow("--port");
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuthInteraction, AuthType } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ModelSettingsApplicationService } from "../src/application/model-settings-service.js";
import type { ModelCredentialRuntime } from "../src/application/model-catalog-service.js";
import type { ModelCatalog, ProviderCredentialResult } from "../src/web/contracts.js";
import { AuthInteractionManager } from "../src/web/auth-interaction-manager.js";
import { WebEventBroker } from "../src/web/event-stream.js";
import { createWebHost } from "../src/web/host.js";
import { OperationManager } from "../src/web/operation-manager.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

class FakeCredentialRuntime implements ModelCredentialRuntime {
  configured = false;
  credentialType?: AuthType;
  logoutCalls = 0;
  receivedAnswers: string[] = [];
  private promptStarted?: () => void;
  readonly atPrompt = new Promise<void>((resolve) => { this.promptStarted = resolve; });

  async read(): Promise<ModelCatalog> {
    return {
      providers: [{
        id: "fake",
        name: "Fake Provider",
        configured: this.configured,
        ...(this.configured ? { authSource: "stored" as const, authLabel: "Stored credential" } : {}),
        ...(this.credentialType ? { credentialType: this.credentialType } : {}),
        authTypes: ["api_key", "oauth"],
        modelCount: 2,
      }],
      models: [
        { id: "fast", providerId: "fake", name: "Fast", api: "fake", reasoning: false, input: ["text"], contextWindow: 16_000, maxTokens: 2_000, available: true },
        { id: "deep", providerId: "fake", name: "Deep", api: "fake", reasoning: true, input: ["text"], contextWindow: 32_000, maxTokens: 4_000, available: true },
      ],
    };
  }

  async login(providerId: string, authType: AuthType, interaction: AuthInteraction): Promise<ProviderCredentialResult> {
    expect(providerId).toBe("fake");
    if (authType === "api_key") {
      const answer = await interaction.prompt({ type: "secret", message: "Enter the fake API key" });
      this.receivedAnswers.push(answer);
      interaction.notify({ type: "progress", message: `Provider accepted ${answer}` });
    } else {
      interaction.notify({ type: "auth_url", url: "https://provider.example/login", instructions: "Authorize this local client." });
      this.promptStarted?.();
      const answer = await interaction.prompt({ type: "manual_code", message: "Paste the one-time code", placeholder: "code" });
      this.receivedAnswers.push(answer);
    }
    this.configured = true;
    this.credentialType = authType;
    return { providerId, configured: true, authType, authSource: "stored", authLabel: "Stored credential" };
  }

  async logout(providerId: string): Promise<ProviderCredentialResult> {
    this.logoutCalls += 1;
    this.configured = false;
    this.credentialType = undefined;
    return { providerId, configured: false };
  }
}

async function fixture(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const events = new WebEventBroker();
  const operations = new OperationManager(events);
  const interactions = new AuthInteractionManager(events, 30_000);
  const runtime = new FakeCredentialRuntime();
  const service = new ModelSettingsApplicationService({
    root,
    catalog: runtime,
    credentials: runtime,
    operations,
    interactions,
    events,
  });
  return { root, events, operations, interactions, runtime, service };
}

describe("Web model settings", () => {
  it("writes role profiles through shared YAML without expanding placeholders", async () => {
    const { root, runtime, service } = await fixture("nwh-web-model-profile-");
    await fs.writeFile(path.join(root, "novel-harness.yaml"), [
      "# preserve this project comment",
      "version: 1",
      "project:",
      "  name: demo",
      "  language: zh-CN",
      "  instructions: []",
      "llm:",
      "  defaultProfile: existing",
      "  profiles:",
      "    existing:",
      "      provider: fake",
      "      model: fast",
      "      baseUrl: ${CUSTOM_BASE_URL}",
      "      thinkingLevel: low",
      "  routing: {}",
      "",
    ].join("\n"), "utf8");

    const updated = await service.updateProfile("narrator", {
      providerId: "fake",
      modelId: "deep",
      thinkingLevel: "high",
      clientRequestId: "profile-narrator-1",
    });
    expect(updated.roles.find((role) => role.role === "narrator")).toMatchObject({
      profileId: "web-narrator",
      providerId: "fake",
      modelId: "deep",
      thinkingLevel: "high",
      inheritedDefault: false,
    });
    expect(updated.roles.find((role) => role.role === "extractor")).toMatchObject({
      profileId: "existing",
      inheritedDefault: true,
    });
    const raw = await fs.readFile(path.join(root, "novel-harness.yaml"), "utf8");
    expect(raw).toContain("# preserve this project comment");
    expect(raw).toContain("${CUSTOM_BASE_URL}");
    expect(raw).toContain("narrator: web-narrator");
    expect(raw).not.toContain("canary-secret");

    const restartedEvents = new WebEventBroker();
    const restarted = new ModelSettingsApplicationService({
      root,
      catalog: runtime,
      operations: new OperationManager(restartedEvents),
      interactions: new AuthInteractionManager(restartedEvents, 30_000),
      events: restartedEvents,
    });
    const replayed = await restarted.updateProfile("narrator", {
      providerId: "fake",
      modelId: "deep",
      thinkingLevel: "high",
      clientRequestId: "profile-narrator-1",
    });
    expect(replayed).toEqual(updated);
    expect(restartedEvents.replayAfter()).toEqual([]);

    await expect(service.updateProfile("narrator", {
      providerId: "fake",
      modelId: "missing",
      thinkingLevel: "medium",
      clientRequestId: "profile-narrator-missing",
    })).rejects.toMatchObject({ detail: { code: "MODEL_NOT_FOUND", retry: { maxAttempts: 1 } } });
  });

  it("passes an API key to Pi without persisting or publishing the secret", async () => {
    const { events, operations, runtime, service } = await fixture("nwh-web-model-api-key-");
    const secret = "canary-api-key-never-echo";
    const accepted = await service.startLogin("fake", {
      authType: "api_key",
      apiKey: secret,
      clientRequestId: "api-key-login-1",
    });
    const completed = await operations.wait(accepted.operation.id);
    expect(runtime.receivedAnswers).toEqual([secret]);
    expect(completed).toMatchObject({
      status: "succeeded",
      kind: "provider-login",
      result: { providerId: "fake", configured: true, authType: "api_key" },
    });
    const observable = JSON.stringify({ operations: operations.list(), events: events.replayAfter() });
    expect(observable).not.toContain(secret);
    expect(observable).not.toContain("apiKey");
  });

  it("round-trips one OAuth prompt without echoing the one-time answer", async () => {
    const { events, operations, interactions, runtime, service } = await fixture("nwh-web-model-oauth-");
    const accepted = await service.startLogin("fake", {
      authType: "oauth",
      clientRequestId: "oauth-login-1",
    });
    await runtime.atPrompt;
    await Promise.resolve();
    const waiting = operations.get(accepted.operation.id);
    const interaction = waiting.progress.interaction as { id: string; status: string; prompt: { type: string } };
    expect(waiting).toMatchObject({ status: "running", phase: "waiting-for-user" });
    expect(interaction).toMatchObject({ status: "pending", prompt: { type: "manual_code" } });
    expect(waiting.progress.authEvent).toMatchObject({ type: "auth_url", url: "https://provider.example/login" });

    const oneTimeCode = "canary-oauth-answer-never-echo";
    expect(interactions.answer(interaction.id, { answer: oneTimeCode })).toMatchObject({ status: "answered" });
    expect(() => interactions.answer(interaction.id, { answer: "again" })).toThrow("already answered");
    const completed = await operations.wait(accepted.operation.id);
    expect(runtime.receivedAnswers).toEqual([oneTimeCode]);
    expect(completed).toMatchObject({ status: "succeeded", result: { authType: "oauth", configured: true } });
    const observable = JSON.stringify({ operations: operations.list(), events: events.replayAfter() });
    expect(observable).not.toContain(oneTimeCode);
    expect(observable).toContain("https://provider.example/login");
  });

  it("exposes CSRF-protected profile, login, interaction, and logout routes", async () => {
    const { root, events, operations, interactions, runtime, service } = await fixture("nwh-web-model-http-");
    const app = await createWebHost({
      root,
      serveStatic: false,
      eventBroker: events,
      operationManager: operations,
      authInteractionManager: interactions,
      modelCatalogService: runtime,
      modelSettingsService: service,
    });
    try {
      const bootstrap = await app.inject({ method: "GET", url: "/api/v1/bootstrap" });
      const csrfToken = (bootstrap.json() as { csrfToken: string }).csrfToken;
      expect(bootstrap.json()).toMatchObject({
        modelCatalog: { providers: [expect.objectContaining({ id: "fake", authTypes: ["api_key", "oauth"] })] },
        features: expect.arrayContaining([expect.objectContaining({ id: "model-settings", status: "available" })]),
      });

      const denied = await app.inject({
        method: "PATCH",
        url: "/api/v1/model-profiles/narrator",
        payload: { providerId: "fake", modelId: "deep", thinkingLevel: "high", clientRequestId: "http-profile-denied" },
      });
      expect(denied.statusCode).toBe(403);
      const profile = await app.inject({
        method: "PATCH",
        url: "/api/v1/model-profiles/narrator",
        headers: { "x-nwh-csrf": csrfToken },
        payload: { providerId: "fake", modelId: "deep", thinkingLevel: "high", clientRequestId: "http-profile" },
      });
      expect(profile.statusCode, profile.body).toBe(200);
      expect(profile.json()).toMatchObject({ roles: expect.arrayContaining([expect.objectContaining({ role: "narrator", modelId: "deep" })]) });

      const oauth = await app.inject({
        method: "POST",
        url: "/api/v1/models/providers/fake/login",
        headers: { "x-nwh-csrf": csrfToken },
        payload: { authType: "oauth", clientRequestId: "http-oauth" },
      });
      expect(oauth.statusCode).toBe(202);
      const operationId = (oauth.json() as { operation: { id: string } }).operation.id;
      await runtime.atPrompt;
      await Promise.resolve();
      const waiting = await app.inject({ method: "GET", url: `/api/v1/operations/${operationId}` });
      const interactionId = (waiting.json() as { progress: { interaction: { id: string } } }).progress.interaction.id;
      const answer = await app.inject({
        method: "POST",
        url: `/api/v1/interactions/${interactionId}/answer`,
        headers: { "x-nwh-csrf": csrfToken },
        payload: { answer: "http-one-time-code" },
      });
      expect(answer.statusCode).toBe(200);
      expect(JSON.stringify(answer.json())).not.toContain("http-one-time-code");
      await operations.wait(operationId);

      const logout = await app.inject({
        method: "DELETE",
        url: "/api/v1/models/providers/fake/credential",
        headers: { "x-nwh-csrf": csrfToken },
        payload: { clientRequestId: "http-logout" },
      });
      expect(logout.statusCode).toBe(200);
      expect(logout.json()).toEqual({ providerId: "fake", configured: false });
      const replayedLogout = await app.inject({
        method: "DELETE",
        url: "/api/v1/models/providers/fake/credential",
        headers: { "x-nwh-csrf": csrfToken },
        payload: { clientRequestId: "http-logout" },
      });
      expect(replayedLogout.statusCode).toBe(200);
      expect(replayedLogout.json()).toEqual({ providerId: "fake", configured: false });
      expect(runtime.logoutCalls).toBe(1);
    } finally {
      await app.close();
    }
  });
});

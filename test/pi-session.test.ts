import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { LocalFileWorkspace } from "../src/workspace/local-files.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const root of temporaryDirectories.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("PiAgentSession", () => {
  it("uses Pi with an in-memory session without making a model request", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-"));
    temporaryDirectories.push(root);
    await fs.writeFile(path.join(root, "NOVEL.md"), "# Test novel\n", "utf8");
    const session = await PiAgentSession.create({
      workspace: await LocalFileWorkspace.create(root),
      saveSession: false,
      profile: {
        provider: "anthropic",
        model: "claude-sonnet-5",
        thinkingLevel: "medium",
        maxTokens: 8_192,
      },
    });
    expect(session.model).toBe("anthropic/claude-sonnet-5");
    expect(session.messageCount).toBe(0);
    expect(session.sessionFile).toBeUndefined();
    await session.dispose();
  });

  it("registers a configured custom provider through Pi", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-custom-"));
    temporaryDirectories.push(root);
    const session = await PiAgentSession.create({
      workspace: await LocalFileWorkspace.create(root),
      saveSession: false,
      profile: {
        provider: "local-openai",
        model: "novel-model",
        baseUrl: "http://127.0.0.1:8080/v1",
        apiProtocol: "openai-completions",
        thinkingLevel: "off",
        contextWindow: 32_768,
        maxTokens: 4_096,
      },
    });
    expect(session.model).toBe("local-openai/novel-model");
    await session.dispose();
  });

  it("restores the model selected in a previous workspace session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-persisted-model-"));
    temporaryDirectories.push(root);
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";

    try {
      const first = await PiAgentSession.create({
        workspace: await LocalFileWorkspace.create(root),
        saveSession: false,
      });
      const internals = first as unknown as {
        runtimeHost: {
          session: { setModel(model: unknown): Promise<void> };
          services: { modelRuntime: { getModel(provider: string, modelId: string): unknown } };
        };
      };
      const selectedModel = internals.runtimeHost.services.modelRuntime.getModel("anthropic", "claude-haiku-4-5");
      expect(selectedModel).toBeDefined();
      await internals.runtimeHost.session.setModel(selectedModel);
      await first.dispose();

      const restarted = await PiAgentSession.create({
        workspace: await LocalFileWorkspace.create(root),
        saveSession: false,
      });
      expect(restarted.model).toBe("anthropic/claude-haiku-4-5");
      await restarted.dispose();

      const savedSettings = JSON.parse(await fs.readFile(path.join(root, ".novel-harness", "pi", "settings.json"), "utf8")) as Record<string, unknown>;
      expect(savedSettings).toMatchObject({
        defaultProvider: "anthropic",
        defaultModel: "claude-haiku-4-5",
      });
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  });
});

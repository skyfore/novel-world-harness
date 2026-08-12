import { describe, expect, it } from "vitest";
import { profileForRole } from "../src/config/load.js";
import { configSchema, llmProfileSchema } from "../src/config/schema.js";

const baseConfig = {
  version: 1 as const,
  project: { name: "test", language: "zh-CN" },
  llm: {
    defaultProfile: "main",
    profiles: { main: { provider: "anthropic", model: "claude-sonnet-5" } },
    routing: {},
  },
};

describe("llmProfileSchema", () => {
  it("keeps Pi provider and model selection generic", () => {
    expect(llmProfileSchema.parse({
      provider: "openai-compatible-local",
      model: "novel-model",
      apiKeyEnv: "LOCAL_LLM_API_KEY",
      baseUrl: "http://127.0.0.1:8080/v1",
      apiProtocol: "openai-completions",
    })).toMatchObject({
      provider: "openai-compatible-local",
      model: "novel-model",
      thinkingLevel: "medium",
      maxTokens: 8_192,
    });
  });

  it("does not allow repository config to select a general-purpose secret", () => {
    expect(() => llmProfileSchema.parse({
      provider: "anthropic",
      model: "claude-test",
      apiKeyEnv: "AWS_SECRET_ACCESS_KEY",
    })).toThrow("*_API_KEY");
  });
});

describe("configSchema", () => {
  it("allows a provider-neutral project config", () => {
    const config = configSchema.parse({
      version: 1,
      project: { name: "fresh-world" },
    });

    expect(config).toEqual({
      version: 1,
      project: { name: "fresh-world", language: "zh-CN" },
    });
    expect(profileForRole(config, "narrator")).toEqual({ name: undefined, profile: undefined });
  });

  it("rejects the removed external database block", () => {
    expect(() => configSchema.parse({
      ...baseConfig,
      database: { url: "postgres://localhost/novel" },
    })).toThrow();
  });
});

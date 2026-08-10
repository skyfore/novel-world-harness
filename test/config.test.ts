import { describe, expect, it } from "vitest";
import { llmProfileSchema } from "../src/config/schema.js";

describe("llmProfileSchema", () => {
  it("accepts the Phase 0 official Anthropic profile", () => {
    expect(llmProfileSchema.parse({ model: "claude-test" })).toEqual({
      provider: "anthropic",
      model: "claude-test",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      maxTokens: 8_192,
    });
  });

  it("rejects custom external endpoints and Pi protocol fields", () => {
    expect(() => llmProfileSchema.parse({
      provider: "anthropic",
      model: "claude-test",
      baseUrl: "https://gateway.example.com",
      apiProtocol: "anthropic-messages",
    })).toThrow();
  });

  it("does not allow a repository config to select an arbitrary secret environment variable", () => {
    expect(() => llmProfileSchema.parse({
      model: "claude-test",
      apiKeyEnv: "AWS_SECRET_ACCESS_KEY",
    })).toThrow();
  });
});

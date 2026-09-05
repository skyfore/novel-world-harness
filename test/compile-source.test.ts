import { describe, expect, it } from "vitest";
import { isRecoverableCompilerSessionException } from "../src/commands/compile-source.js";
import { COMPILER_PROMPT_TIMEOUT_MS } from "../src/compiler/limits.js";

describe("compiler source session recovery", () => {
  it("allows a one-hour compiler turn for effect-first MVP compilation", () => {
    expect(COMPILER_PROMPT_TIMEOUT_MS).toBe(60 * 60 * 1_000);
  });

  it("recovers bounded timeout and transient network exceptions", () => {
    expect(isRecoverableCompilerSessionException(
      new Error("Model turn exceeded its 600000ms wall-clock limit."),
    )).toBe(true);
    expect(isRecoverableCompilerSessionException(new Error("request ETIMEDOUT"))).toBe(true);
    expect(isRecoverableCompilerSessionException(new Error("TypeError: fetch failed"))).toBe(true);
  });

  it("does not retry user cancellation or deterministic compiler failures", () => {
    const cancellation = new Error("The operation was aborted by the user.");
    cancellation.name = "AbortError";
    expect(isRecoverableCompilerSessionException(cancellation)).toBe(false);
    expect(isRecoverableCompilerSessionException(
      new Error("Compiler batch proposal graph is incomplete."),
    )).toBe(false);
    expect(isRecoverableCompilerSessionException("timeout")).toBe(false);
  });
});

import { RuntimeHooks, withRuntimeHooks, type RuntimeHookEvent } from "../src/runtime/hooks.js";
import { describe, expect, it } from "vitest";
import { compileSourceCommand, isRecoverableCompilerSessionException } from "../src/commands/compile-source.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TraceStore } from "../src/trace/store.js";
import { WorkspaceOperationLock } from "../src/util/workspace-lock.js";
import { COMPILER_PROMPT_TIMEOUT_MS } from "../src/compiler/limits.js";

describe("compiler source session recovery", () => {
  it("persists a terminal audit run for CLI compiler failure and releases its lock", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-compiler-audit-"));
    try {
      const hooks = new RuntimeHooks();
      const events: RuntimeHookEvent[] = [];
      hooks.subscribe(event => { events.push(event); });
      await expect(withRuntimeHooks(hooks, () => compileSourceCommand({ root, configPath: path.join(root, "missing.yaml"), allowMissingConfig: true, onProgress() {} }))).rejects.toThrow("No ingested sources");
      expect(events).toHaveLength(1); // lock/trace recursion must not duplicate completion
      expect(events[0]).toMatchObject({ type: "compiler.batches", status: "failed" });
      const runs = await new TraceStore(root).listRuns({ kind: "prepare" });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "failed", error: { code: "COMPILER_RUN_FAILED", message: expect.stringContaining("No ingested sources") } });
      const replacement = await WorkspaceOperationLock.acquire(root, "compiler");
      await replacement.release();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
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

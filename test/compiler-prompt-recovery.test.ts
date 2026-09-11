import { beforeEach, describe, expect, it, vi } from "vitest";

const { createPiCompilerSession } = vi.hoisted(() => ({
  createPiCompilerSession: vi.fn(),
}));

vi.mock("../src/compiler/pi-compiler.js", () => ({ createPiCompilerSession }));

import { compileCommand } from "../src/commands/compile.js";

describe("compiler prompt recovery", () => {
  beforeEach(() => {
    createPiCompilerSession.mockReset();
  });

  it("re-reviews a no-artifacts finish with failed proposal calls in a fresh session", async () => {
    const prompts: string[] = [];
    const reports = [
      {
        assistantStopReason: "stop",
        proposalSucceeded: 0,
        proposalFailed: 4,
        completionSignaled: true,
        completionOutcome: "no-artifacts" as const,
      },
      {
        assistantStopReason: "stop",
        proposalSucceeded: 0,
        proposalFailed: 0,
        completionSignaled: true,
        completionOutcome: "no-artifacts" as const,
      },
    ];
    createPiCompilerSession.mockImplementation(async () => ({
      abort: vi.fn(),
      dispose: vi.fn(),
      promptWithReport: vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        return reports.shift();
      }),
      runInteractive: vi.fn(),
    }));

    await compileCommand({
      root: "/tmp/nwh-compiler-prompt-recovery",
      configPath: "/tmp/nwh-compiler-prompt-recovery/missing-config.json",
      allowMissingConfig: true,
      acquireLock: false,
      saveSession: false,
      prompt: "Review this immutable reconciliation shard.",
    });

    expect(createPiCompilerSession).toHaveBeenCalledTimes(2);
    expect(prompts[0]).toBe("Review this immutable reconciliation shard.");
    expect(prompts[1]).toContain("Compiler-prompt recovery attempt 1/3");
    expect(prompts[1]).toContain("Repair persisted failures with the same exact tool and proposal_id");
    expect(prompts[1]).toContain("Review this immutable reconciliation shard.");
  });

  it("preserves failure after bounded recovery exhausts only rejected proposals", async () => {
    const onProgress = vi.fn();
    const report = {
      assistantStopReason: "stop",
      proposalSucceeded: 0,
      proposalFailed: 1,
      completionSignaled: true,
      completionOutcome: "no-artifacts" as const,
    };
    createPiCompilerSession.mockImplementation(async () => ({
      abort: vi.fn(),
      dispose: vi.fn(),
      promptWithReport: vi.fn(async () => report),
      runInteractive: vi.fn(),
    }));

    await expect(compileCommand({
      root: "/tmp/nwh-compiler-prompt-recovery-exhausted",
      configPath: "/tmp/nwh-compiler-prompt-recovery-exhausted/missing-config.json",
      allowMissingConfig: true,
      acquireLock: false,
      saveSession: false,
      prompt: "Review this immutable reconciliation shard.",
      onProgress,
    })).rejects.toThrow("Compiler prompt was not completed: 1 proposal tool call(s) failed before the model declared no artifacts.");

    expect(createPiCompilerSession).toHaveBeenCalledTimes(4);
    expect(onProgress).not.toHaveBeenCalledWith(expect.stringContaining("accepting the final no-artifacts review"));
  });
});

it("records a failed opening run even when the durable guard prevents session creation", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { CompilerProposalObligations } = await import("../src/compiler/proposal-obligations.js");
  const { TraceStore } = await import("../src/trace/store.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-opening-trace-"));
  createPiCompilerSession.mockReset();
  try {
    const journal = new CompilerProposalObligations(root, "source", "opening-batch-source");
    journal.record("propose_initial_world", { proposal_id: "opening", payload: {} }, "failed", "first");
    journal.record("propose_initial_world", { proposal_id: "opening", payload: { version: 1 } }, "failed", "second");
    await expect(compileCommand({ root, configPath: path.join(root, "missing.json"), allowMissingConfig: true,
      acquireLock: false, saveSession: false, prompt: "Opening evidence", sourceId: "source", compilerBatchId: "opening-batch-source",
    })).rejects.toThrow("requires host review");
    expect(createPiCompilerSession).not.toHaveBeenCalled();
    const runs = await new TraceStore(root).peekRuns({ sourceId: "source" });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", operationId: "opening-batch-source", error: { code: "COMPILER_PROMPT_FAILED" } });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

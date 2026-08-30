import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  buildNwhToolRecoveryAdvice,
  formatNwhToolError,
  NWH_TOOL_RECOVERY_MARKER,
  recoverNwhToolResult,
  withNwhToolRecovery,
} from "../src/agent/tool-recovery.js";

describe("agent tool recovery", () => {
  it("turns a stale read ref into an exact paired-discovery SOP", () => {
    const advice = buildNwhToolRecoveryAdvice(
      "read_compiler_artifact",
      "Artifact ref 'canonical:event:wrong' was not found in active source 'novel-1'.",
    );

    expect(advice).toMatchObject({
      category: "lookup-miss",
      retryable: true,
      suggestedCall: {
        tool: "find_compiler_artifacts",
        arguments: { query: "*", max_results: 20 },
      },
    });
    expect(advice.steps.join(" ")).toContain("Copy the exact ref");
    expect(advice.steps.join(" ")).toContain("do not guess");
    expect(advice.steps.join(" ")).toContain("Retry read_compiler_artifact once");
  });

  it("keeps opaque player-handle recovery inside the isolated prompt", () => {
    const advice = buildNwhToolRecoveryAdvice(
      "select_player_world_response",
      "Unknown responseId 'response-999'.",
    );

    expect(advice).toMatchObject({ category: "lookup-miss", retryable: true });
    expect(advice.suggestedCall).toBeUndefined();
    expect(advice.retryCondition).toContain("current isolated prompt");
    expect(advice.steps.join(" ")).toContain("do not search outside");
  });

  it("stops blind loops for single-use, circuit-breaker, and host-state failures", () => {
    expect(buildNwhToolRecoveryAdvice(
      "propose_player_action",
      "Only one player action candidate may be captured per turn.",
    )).toMatchObject({ category: "scope-or-lifecycle", retryable: false });
    expect(buildNwhToolRecoveryAdvice(
      "propose_entity",
      "Compiler tool-call safety fuse tripped after 1000 calls.",
    )).toMatchObject({ category: "budget-or-circuit-breaker", retryable: false });
    expect(buildNwhToolRecoveryAdvice(
      "read_source_evidence",
      "Source evidence index is missing or stale; re-ingest/reparse before reconciliation.",
    )).toMatchObject({ category: "host-repair-required", retryable: false });
  });

  it("classifies finish graph diagnostics as repairable validation instead of a generic lookup miss", () => {
    const advice = buildNwhToolRecoveryAdvice(
      "finish_compiler_batch",
      "Entity-resolution graph is incomplete:\n- resolution-hero: candidate references unknown entity 'hero'",
    );

    expect(advice).toMatchObject({
      category: "invalid-arguments",
      retryable: true,
    });
    expect(advice.suggestedCall).toBeUndefined();
    expect(advice.retryCondition).toContain("correcting every reported graph/trace section");
    expect(advice.steps.join(" ")).toContain("resolutionMode");
    expect(advice.steps.join(" ")).toContain("do not re-propose a checkpointed pending identity");
  });

  it("pairs source-accounting misses and finish gaps with bounded unit discovery", () => {
    const lookup = buildNwhToolRecoveryAdvice(
      "account_source_units",
      "Unknown deterministic source unit guessed-unit; call find_source_accounting_units.",
    );
    expect(lookup).toMatchObject({
      category: "lookup-miss",
      retryable: true,
      suggestedCall: {
        tool: "find_source_accounting_units",
        arguments: { status: "unresolved", offset: 0, max_results: 200 },
      },
    });
    expect(lookup.steps.join(" ")).toContain("Copy the exact pageToken");
    expect(lookup.steps.join(" ")).toContain("do not guess");
    expect(lookup.steps.join(" ")).toContain("Retry account_source_units once");

    const finish = buildNwhToolRecoveryAdvice(
      "finish_compiler_batch",
      "Source-unit accounting is incomplete:\n- Source unit sentence-9 has no account_source_units disposition.",
    );
    expect(finish).toMatchObject({
      category: "invalid-arguments",
      retryable: true,
      suggestedCall: {
        tool: "find_source_accounting_units",
        arguments: { status: "unresolved", offset: 0, max_results: 200 },
      },
    });
    expect(finish.steps.join(" ")).toContain("exact pageToken");
    expect(finish.steps.join(" ")).toContain("refetch status=unresolved at offset=0");
    expect(finish.steps.join(" ")).toContain("same full diagnostic repeats");
  });

  it("marks terminate-style retrieval budget results as errors and appends the stop SOP", () => {
    const recovered = recoverNwhToolResult({
      type: "tool_result",
      toolName: "find_related_messages",
      toolCallId: "call-budget",
      input: { query: "*" },
      content: [{ type: "text", text: '{"error":"Related-message retrieval tool-call budget exceeded."}' }],
      details: { relatedMessageRetrieval: true, blocked: true, callCount: 25 },
      isError: false,
    });

    expect(recovered).toMatchObject({
      isError: true,
      details: {
        blocked: true,
        nwhToolRecovery: { category: "budget-or-circuit-breaker", retryable: false },
      },
    });
    expect(recovered?.content?.at(-1)).toMatchObject({
      type: "text",
      text: expect.stringContaining("Stop the current tool loop"),
    });
  });

  it("preflights schema failures and preserves Pi error semantics through a thrown actionable error", () => {
    const wrapped = withNwhToolRecovery(defineTool({
      name: "read_example",
      label: "Read example",
      description: "Read one example by ref.",
      parameters: Type.Object({ ref: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      async execute() {
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    }));

    expect(() => wrapped.prepareArguments?.({})).toThrow(NWH_TOOL_RECOVERY_MARKER);
    expect(() => wrapped.prepareArguments?.({})).toThrow('"category": "invalid-arguments"');
  });

  it("adds lookup steps to execution errors exactly once and leaves successful results unchanged", async () => {
    const failing = withNwhToolRecovery(defineTool({
      name: "read_actor_context",
      label: "Read actor context",
      description: "Read one record.",
      parameters: Type.Object({ ref: Type.String() }, { additionalProperties: false }),
      async execute() {
        throw new Error("Actor-context ref 'actor-context:wrong' does not exist in this isolated turn.");
      },
    }));
    const executeFailing = () => failing.execute(
      "call-1",
      { ref: "actor-context:wrong" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    await expect(executeFailing()).rejects.toThrow("find_actor_context");
    await expect(executeFailing()).rejects.toThrow("Retry read_actor_context once");

    const once = formatNwhToolError("read_actor_context", "missing record");
    expect(formatNwhToolError("read_actor_context", once)).toBe(once);
    expect(once.match(/<nwh-tool-recovery>/gu)).toHaveLength(1);

    const successful = withNwhToolRecovery(defineTool({
      name: "successful_tool",
      label: "Successful tool",
      description: "Return normally.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return { content: [{ type: "text" as const, text: "ok" }], details: { ok: true } };
      },
    }));
    await expect(successful.execute(
      "call-2",
      {},
      undefined,
      undefined,
      {} as ExtensionContext,
    )).resolves.toEqual({ content: [{ type: "text", text: "ok" }], details: { ok: true } });
    expect(withNwhToolRecovery(successful)).toBe(successful);
  });
});

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

  it("recovers a missing exact quote from the named immutable source chunk", () => {
    const segmentId = "source-1-00003-acde1234";
    const advice = buildNwhToolRecoveryAdvice(
      "propose_initial_world",
      `Evidence selector 7 for target_path '/readerSetup' failed: Exact evidence quote was not found in segment ${segmentId}.`,
    );

    expect(advice).toMatchObject({
      category: "lookup-miss",
      retryable: true,
      suggestedCall: {
        tool: "read_source_evidence",
        arguments: { ref: `source-segment:${segmentId}`, offset: 0, max_chars: 120_000 },
      },
    });
    expect(advice.steps.join(" ")).toContain("returned chunk");
    expect(advice.steps.join(" ")).toContain("evidence_segment_id");
    expect(advice.steps.join(" ")).toContain("do not copy JSON escaping");
    expect(advice.steps.join(" ")).toContain("Retry propose_initial_world once");
  });

  it("keeps runtime source-ref recovery inside the frozen consultation scope", () => {
    const advice = buildNwhToolRecoveryAdvice(
      "read_runtime_source_evidence",
      "Frozen source ref 'source-unit:wrong' was not found in the current branch scope.",
    );

    expect(advice).toMatchObject({
      category: "lookup-miss",
      retryable: true,
      suggestedCall: {
        tool: "find_runtime_source_evidence",
        arguments: { query: "*", max_results: 20 },
      },
    });
    expect(advice.steps.join(" ")).toContain("Copy the exact ref");
    expect(advice.steps.join(" ")).toContain("Retry read_runtime_source_evidence once");
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

  it("repairs only named dangling annotation references with exact logical annotation IDs", () => {
    const advice = buildNwhToolRecoveryAdvice(
      "finish_compiler_batch",
      "Source annotation graph is incomplete:\n"
        + "- obs-ent-anna: sceneId references unknown annotation 'obs-scene-hall'\n"
        + "- obs-quote-go: speakerMentionId references unknown annotation 'proposal-mention-anna'\n\n"
        + "Active source annotation IDs available for exact reference repair (copy annotation_id values; proposal IDs and refs are envelope/discovery handles only):\n"
        + "- entity-mention annotation_id values: mention-anna\n"
        + "- discourse-segment annotation_id values: ds-hall",
    );

    expect(advice).toMatchObject({
      category: "invalid-arguments",
      retryable: true,
      suggestedCall: {
        tool: "find_source_annotations",
        arguments: { query: "*", status: "pending", offset: 0, max_results: 200 },
      },
    });
    expect(advice.steps.join(" ")).toContain("obs-ent-anna, obs-quote-go");
    expect(advice.steps.join(" ")).toContain("annotationId");
    expect(advice.steps.join(" ")).toContain("never copy ref/proposalId");
    expect(advice.steps.join(" ")).toContain("Preserve every unlisted active proposal");
    expect(advice.steps.join(" ")).toContain("outcome=complete");
    expect(advice.steps.join(" ")).toContain("never mass-withdraw");
    expect(advice.steps.join(" ")).toContain("no-artifacts");
  });

  it("routes cross-batch logical supersession through the existing boundary calibration workflow", () => {
    const advice = buildNwhToolRecoveryAdvice(
      "finish_compiler_batch",
      "Cross-batch proposal lifecycle:\n- CROSS_BATCH_LOGICAL_SUPERSESSION direction=previous prior='scene-prior' current='scene-current-v2' kind='scene-occurrence': checkpointed proposal cannot be withdrawn here.\n\nDeterministic canonical commit preview:\n- scene-prior: SUPERSEDED_LOGICAL_PROPOSAL: superseded by newer active proposal 'scene-current-v2'.",
    );

    expect(advice).toMatchObject({
      category: "invalid-arguments",
      retryable: true,
      suggestedCall: {
        tool: "withdraw_compiler_proposal",
        arguments: { proposal_id: "scene-current-v2" },
      },
    });
    expect(advice.steps.join(" ")).toContain("Never try to withdraw the checkpointed prior proposal(s): scene-prior");
    expect(advice.steps.join(" ")).toContain("peek_adjacent_evidence");
    expect(advice.steps.join(" ")).toContain("defer_boundary_artifact");
    expect(advice.steps.join(" ")).toContain("replace_boundary_proposal");
    expect(advice.steps.join(" ")).toContain("one-sided scene/event");
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
        arguments: { status: "unresolved", offset: 0, max_results: 20 },
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
        arguments: { status: "unresolved", offset: 0, max_results: 20 },
      },
    });
    expect(finish.steps.join(" ")).toContain("exact pageToken");
    expect(finish.steps.join(" ")).toContain("refetch status=unresolved at offset=0");
    expect(finish.steps.join(" ")).toContain("same full diagnostic repeats");

    const representedConflict = buildNwhToolRecoveryAdvice(
      "finish_compiler_batch",
      "Source-unit accounting is incomplete:\n- Source unit sentence-10 overlaps exact semantic evidence and is host-derived as represented; withdraw source-accounting proposal 'accounting-page-1'.",
    );
    expect(representedConflict).toMatchObject({
      category: "invalid-arguments",
      retryable: true,
      suggestedCall: {
        tool: "withdraw_compiler_proposal",
        arguments: { proposal_id: "accounting-page-1" },
      },
    });
    expect(representedConflict.steps.join(" ")).toContain("accounting-page-1");
    expect(representedConflict.steps.join(" ")).toContain("Do not guess a unit-to-proposal mapping");
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

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
  it("requires durable obligation repair before finish and stops exhausted retries", () => {
    const advice = buildNwhToolRecoveryAdvice("finish_compiler_batch", "Unresolved compiler proposal obligations (persisted across sessions): propose_action_schema proposal_id=schema-1: failed: Exact evidence quote was not found in segment source-1.");
    expect(advice.steps.join(" ")).toContain("same identity");
    expect(advice.steps.join(" ")).toContain("stop for host review");
    expect(buildNwhToolRecoveryAdvice("propose_action_schema", "Compiler proposal obligation requires host review: original and corrected inputs failed.").retryable).toBe(false);
  });
  it("fixes accounting review dispositions instead of withdrawing pages or inventing finish offsets", () => {
    const advice = buildNwhToolRecoveryAdvice("finish_compiler_batch", "Source-unit accounting is incomplete: unit is inside a no-artifacts segment; withdraw proposal page-1. Call find_source_accounting_units with offset=0.");
    expect(advice.category).toBe("invalid-arguments");
    expect(advice.steps.join(" ")).toContain("reviewed_segments.disposition");
    expect(advice.steps.join(" ")).toContain("Retain the accounting pages");
    expect(advice.steps.join(" ")).toContain("finish_compiler_batch has no offset argument");
    const missing = buildNwhToolRecoveryAdvice("finish_compiler_batch", "Source-unit accounting is incomplete: unreviewed units. Refetch offset=0.");
    expect(missing.suggestedCall).toMatchObject({ tool: "find_source_accounting_units", arguments: { offset: 0 } });
  });
  it("repairs execution envelopes and discovers real mechanisms without relabeling ad-hoc actions", () => {
    const message = formatNwhToolError("propose_event_execution", new Error("Validation failed: evidence_segment_ids missing; action requires schema-bound"));
    expect(message).toContain("Validation failed: evidence_segment_ids missing");
    expect(message).toContain("never nest evidence_segment_ids/evidence_selectors inside payload");
    const advice = buildNwhToolRecoveryAdvice("propose_event_execution", "Execution bindings require an explicit compiled mechanism");
    expect(advice.suggestedCall).toMatchObject({ tool: "find_compiler_artifacts", arguments: { kind: "action-schema" } });
    expect(advice.steps.join(" ")).toContain("read payload.id into action.schemaId");
    expect(advice.steps.join(" ")).toContain("never copy an event's ad-hoc action");
    expect(advice.steps.join(" ")).toContain("Retry once after concrete correction");
    expect(buildNwhToolRecoveryAdvice("propose_event_execution", "requires schema-bound", { activeToolNames: ["propose_event_execution"] })).toMatchObject({ retryable: false, category: "scope-or-lifecycle" });
  });
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
      { activeToolNames: ["propose_initial_world", "read_source_evidence"] },
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

  it("disambiguates repeated source wording without losing annotation identity", () => {
    const segmentId = "source-1-00009-acde1234";
    const diagnostic = `Exact evidence quote is ambiguous in segment ${segmentId}: 5 occurrences match. Supply prefix/suffix or a one-based occurrence.`;
    const advice = buildNwhToolRecoveryAdvice("propose_entity_mention", diagnostic, {
      activeToolNames: ["propose_entity_mention", "read_source_evidence"],
    });
    expect(advice).toMatchObject({
      category: "invalid-arguments",
      retryable: true,
      suggestedCall: {
        tool: "read_source_evidence",
        arguments: { ref: `source-segment:${segmentId}`, offset: 0, max_chars: 120_000 },
      },
    });
    const steps = advice.steps.join(" ");
    expect(steps).toContain("evidence_segment_id");
    expect(steps).toContain("never from an individual page");
    expect(steps).toContain("retain the intended logical annotation ID");
    expect(steps).toContain("Retry propose_entity_mention once");
    expect(steps).toContain("same diagnostic repeats, stop");
    expect(formatNwhToolError("propose_entity_mention", new Error(diagnostic))).toContain(diagnostic);
  });

  it.each([
    "Exact evidence quote is ambiguous in segment source-1-00009: 2 occurrences match.",
    "Exact evidence quote was not found in segment source-1-00009.",
  ])("uses supplied evidence for bounded quote recovery: %s", async (diagnostic) => {
    const scope = { activeToolNames: ["propose_entity_mention", "finish_compiler_batch"] };
    const tool = withNwhToolRecovery(defineTool({
      name: "propose_entity_mention",
      label: "Propose entity mention",
      description: "Test the model-facing recovery boundary.",
      parameters: Type.Object({}),
      async execute() { throw new Error(diagnostic); },
    }), () => scope);
    let failure: Error | undefined;
    try {
      await tool.execute("quote-failure", {}, undefined, undefined, {} as ExtensionContext);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toContain(diagnostic);
    const recovered = recoverNwhToolResult({
      type: "tool_result",
      toolName: tool.name,
      toolCallId: "quote-failure",
      input: {},
      content: [{ type: "text", text: failure!.message }],
      isError: true,
    }, scope);
    const advice = buildNwhToolRecoveryAdvice(tool.name, diagnostic, scope);
    expect(recovered).toMatchObject({ isError: true, details: { nwhToolRecovery: advice } });
    expect(advice.suggestedCall).toBeUndefined();
    expect(advice.steps.join(" ")).toContain('complete host-supplied <source-segment id="source-1-00009">');
    expect(advice.steps.join(" ")).toContain("stop and report the missing evidence");
    expect(failure?.message).not.toContain("read_source_evidence");
    expect(advice.steps.join(" ")).toContain("Retry propose_entity_mention once");

    scope.activeToolNames.push("read_source_evidence");
    await expect(tool.execute("quote-with-retrieval", {}, undefined, undefined, {} as ExtensionContext))
      .rejects.toThrow("Call read_source_evidence");
  });

  it("classifies a schema failure without treating echoed proposal text as the diagnostic", () => {
    const diagnostic = 'Validation failed for tool "propose_canonical_event":\n  - payload.narrativeContext.mode: must be equal to one of the allowed values';
    const echoed = `${diagnostic}\n\nReceived arguments:\n${JSON.stringify({
      evidence_segment_ids: ["source-1-00002"],
      payload: { narrativeContext: { mode: "dream" }, readerSummary: "Unknown identity; offset remains unknown." },
    })}`;
    const expected = buildNwhToolRecoveryAdvice("propose_canonical_event", diagnostic);
    expect(expected.category).toBe("invalid-arguments");
    expect(buildNwhToolRecoveryAdvice("propose_canonical_event", echoed)).toEqual(expected);
    expect(formatNwhToolError("propose_canonical_event", new Error(echoed))).toContain(echoed);
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

    const noArtifactsConflict = buildNwhToolRecoveryAdvice(
      "finish_compiler_batch",
      "Source-unit accounting is incomplete:\n- Source unit sentence-11 is inside a no-artifacts segment and is already host-classified as background-only; withdraw source-accounting proposal 'accounting-page-2'.",
    );
    expect(noArtifactsConflict).toMatchObject({
      category: "invalid-arguments",
      retryable: true,
    });
    expect(noArtifactsConflict.suggestedCall).toBeUndefined();
    expect(noArtifactsConflict.steps.join(" ")).toContain("Set the named reviewed_segments.disposition fields to proposed");
  });

  it("keeps recovery metadata consistent when an actionable error is wrapped again", () => {
    const diagnostic = "Source annotation closure failed:\n- obs-event: participantMentionIds references unknown annotation 'missing-mention'";
    const toolName = "finish_compiler_batch";
    const expected = buildNwhToolRecoveryAdvice(toolName, diagnostic);
    expect(expected.category).toBe("invalid-arguments");
    const content = [{ type: "text" as const, text: formatNwhToolError(toolName, new Error(diagnostic)) }];
    const recovered = recoverNwhToolResult({
      type: "tool_result", toolName, toolCallId: "wrapped-finish", input: {}, content, isError: true,
    });
    expect(recovered).toMatchObject({ isError: true, content, details: { nwhToolRecovery: expected } });
    expect(buildNwhToolRecoveryAdvice(toolName, content[0]!.text)).toEqual(expected);
  });

  it("returns an actionable exact-name repair while preserving the failed finish status", async () => {
    const diagnostic = "Canonical entity proposal trace is incomplete:\n- Entity artifact-copper-urn-00012 canonicalName '铜罐' has no resolved source mention.";
    const tool = withNwhToolRecovery(defineTool({
      name: "finish_compiler_batch",
      label: "Finish compiler batch",
      description: "Exercise failed finish recovery as the model receives it.",
      parameters: Type.Object({}),
      async execute() { throw new Error(diagnostic); },
    }));
    let failure: Error | undefined;
    try {
      await tool.execute("finish-name-trace", {}, undefined, undefined, {} as ExtensionContext);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toContain(diagnostic);
    const recovered = recoverNwhToolResult({
      type: "tool_result", toolName: tool.name, toolCallId: "finish-name-trace", input: {},
      content: [{ type: "text", text: failure!.message }], isError: true,
    });
    expect(recovered).toMatchObject({
      isError: true,
      details: { nwhToolRecovery: {
        category: "invalid-arguments", retryable: true,
        suggestedCall: { tool: "find_source_annotations", arguments: {
          query: "铜罐", annotation_type: "entity-mention", offset: 0, max_results: 20,
        } },
      } },
    });
    const advice = buildNwhToolRecoveryAdvice(tool.name, failure!.message);
    expect(advice.suggestedCall?.arguments).not.toHaveProperty("status");
    const steps = advice.steps.join(" ");
    for (const text of ["artifact-copper-urn-00012", "surface === canonicalName", "annotationId, never ref/proposalId",
      "find_entity_resolution_candidates", "propose_entity_resolution", "new-entity", "all reported sections",
      "same full diagnostic repeats, stop", "Preserve unrelated valid drafts"]) {
      expect(steps).toContain(text);
    }
    const blocked = buildNwhToolRecoveryAdvice(tool.name, `Compiler batch stopped by its circuit breaker. Reason: ${diagnostic}`);
    expect(blocked).toMatchObject({ category: "budget-or-circuit-breaker", retryable: false });
    expect(blocked.suggestedCall).toBeUndefined();
  });

  it("includes every missing name and keeps discovery arguments within tool limits", () => {
    const advice = buildNwhToolRecoveryAdvice("finish_compiler_batch",
      `Canonical entity proposal trace is incomplete:\n- Entity urn canonicalName '${"罐".repeat(501)}' has no resolved source mention.\n- Entity person canonicalName 'O'Brien' has no resolved source mention.\n\nCanonical event proposal trace is incomplete:\n- Missing event dependency.`);
    expect(advice.suggestedCall?.arguments.query).toBe("*");
    expect(advice.steps.join(" ")).toContain('person -> "O\'Brien"');
    expect(advice.retryCondition).toContain("every reported graph/trace section");
  });

  it("completes participant mention identity selection before retrying finish", () => {
    const advice = buildNwhToolRecoveryAdvice(
      "finish_compiler_batch",
      "Canonical event proposal trace is incomplete:\n- Canonical event evt-hatchling participant 'artifact-bottle' at participants.4 has no resolved participant mention in its event trace.",
    );
    expect(advice).toMatchObject({
      category: "invalid-arguments",
      retryable: true,
      suggestedCall: {
        tool: "find_source_annotations",
        arguments: { query: "*", status: "pending", offset: 0, max_results: 200 },
      },
    });
    const steps = advice.steps.join(" ");
    expect(steps).toContain("evt-hatchling -> artifact-bottle");
    expect(steps).toContain("eventMentionIds");
    expect(steps).toContain("participantMentionIds");
    expect(steps).toContain("event-mention revision");
    expect(steps).toContain("add the missing mention ID to participant_mention_ids");
    expect(steps).toContain("Creating an unreferenced entity mention alone cannot change the event trace");
    expect(steps).toContain("propose_entity_resolution");
    expect(steps).toContain("Merely creating the mention or merely calling the finder does not select an identity");
    expect(steps).toContain("Only after all 1 selected resolution(s) succeed");
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

it("keeps a failed mention's original identity and stops preview scope or retry violations", () => {
  const advice = buildNwhToolRecoveryAdvice("propose_entity_mention", "A non-zero entity mention surface must exactly equal selector.exact.");
  expect(advice.category).toBe("invalid-arguments");
  expect(advice.steps.join(" ")).toContain("same proposal_id");
  expect(advice.retryCondition).toContain("One corrected call");
  expect(buildNwhToolRecoveryAdvice("preview_initial_world", "Initial-world preview requires an active opening or reconciliation batch").retryable).toBe(false);
  expect(buildNwhToolRecoveryAdvice("preview_initial_world", "Compiler proposal obligation requires host review: opening preview repeated unchanged input").retryable).toBe(false);
  const invalid = buildNwhToolRecoveryAdvice("preview_initial_world", "Initial-world preview validation failed: missing holderEntityId");
  expect(invalid.steps.join(" ")).toContain("every reported validation path");
});

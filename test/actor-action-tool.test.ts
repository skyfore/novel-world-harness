import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { createActorActionCaptureTool } from "../src/agent/actor-action-tool.js";
import { NWH_TOOL_RECOVERY_MARKER, withNwhToolRecovery } from "../src/agent/tool-recovery.js";

describe("autonomous actor action capture tool", () => {
  it("accepts one scoped proposal without exposing branch or commit authority", async () => {
    const capture = createActorActionCaptureTool(["character.plan"]);
    const validator = Compile(capture.tool.parameters);
    const candidate = {
      title: "Continue the current plan",
      participants: [],
      preconditions: [],
      proposedDelta: {
        version: 1 as const,
        operations: [{ op: "set" as const, entityId: "actor-self", field: "character.plan", value: "continue" }],
      },
    };

    expect(validator.Check(candidate)).toBe(true);
    expect(validator.Check({
      ...candidate,
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "actor-self", field: "location.open", value: true }],
      },
    })).toBe(false);
    const serializedSchema = JSON.stringify(capture.tool.parameters);
    expect(serializedSchema).not.toContain("expectedParentCommit");
    expect(serializedSchema).not.toContain("branchId");
    expect(serializedSchema).not.toContain("eventHash");

    await expect(capture.tool.execute(
      "actor-action-1",
      candidate,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).resolves.toMatchObject({ details: { captured: true } });
    expect(capture.getCandidate()).toEqual(candidate);
    expect(capture.getExecutionAttempts()).toBe(1);
  });

  it("reports a repeated capture as a non-retryable lifecycle failure", async () => {
    const capture = createActorActionCaptureTool(["character.plan"]);
    const tool = withNwhToolRecovery(capture.tool);
    const candidate = {
      title: "Continue the current plan",
      participants: [],
      preconditions: [],
      proposedDelta: {
        version: 1 as const,
        operations: [{ op: "set" as const, entityId: "actor-self", field: "character.plan", value: "continue" }],
      },
    };
    await tool.execute("actor-action-1", candidate, undefined, undefined, {} as ExtensionContext);

    const repeated = tool.execute("actor-action-2", candidate, undefined, undefined, {} as ExtensionContext);
    await expect(repeated).rejects.toThrow(NWH_TOOL_RECOVERY_MARKER);
    await expect(tool.execute(
      "actor-action-3",
      candidate,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).rejects.toThrow('"retryable": false');
    await expect(tool.execute(
      "actor-action-4",
      candidate,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).rejects.toThrow("Stop calling this tool in the current turn");
  });
});

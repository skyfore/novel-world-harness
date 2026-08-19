import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { createPlayerWorldResolutionCaptureTool } from "../src/agent/player-world-outcome-tool.js";

describe("player world resolution capture tool", () => {
  it("captures one contradiction-certified consequence without world mutation authority", async () => {
    const capture = createPlayerWorldResolutionCaptureTool(["character.plan"]);
    const validator = Compile(capture.tool.parameters);
    const resolution = {
      decision: "transform" as const,
      status: "blocked" as const,
      contradiction: {
        kind: "capability" as const,
        summary: "The desired effect directly exceeds current capability.",
        basis: [{ source: "causal-principle" as const, principle: "Ordinary action cannot reverse death." }],
      },
      replacement: {
        title: "The attempt has an ordinary consequence",
        intent: { kind: "act" as const, summary: "Try and perceive the failed result", targets: [] },
        participants: [],
        preconditions: [],
        proposedDelta: { version: 1 as const, operations: [] },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      },
      eventTitle: "The attempt meets the world's limits",
      actorObservation: "The body remains still.",
    };

    expect(validator.Check(resolution)).toBe(true);
    expect(validator.Check({
      ...resolution,
      contradiction: { ...resolution.contradiction, basis: [] },
    })).toBe(false);
    expect(JSON.stringify(capture.tool.parameters)).not.toContain("expectedParentCommit");
    await capture.tool.execute("resolution-1", resolution, undefined, undefined, {} as ExtensionContext);
    expect(capture.getResolution()).toEqual(resolution);
    expect(capture.getExecutionAttempts()).toBe(1);
    await expect(capture.tool.execute(
      "resolution-2",
      resolution,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).rejects.toThrow("Only one player-world resolution");
  });
});

import { describe, expect, it } from "vitest";
import { resolvePlaySessionContinuation } from "../src/commands/play.js";

describe("interactive transcript continuation", () => {
  it("continues interactive restarts by default while keeping print mode fresh", () => {
    expect(resolvePlaySessionContinuation({})).toBe(true);
    expect(resolvePlaySessionContinuation({ printPrompt: "status" })).toBe(false);
    expect(resolvePlaySessionContinuation({ continueSession: false })).toBe(false);
    expect(resolvePlaySessionContinuation({ continueSession: true, printPrompt: "status" })).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { jsonArguments } from "../src/agent/json-arguments.js";
import { withNwhToolRecovery } from "../src/agent/tool-recovery.js";

describe("Pi JSON argument boundary", () => {
  it("preserves valid nested values and shared references without serialization", () => {
    const shared = { text: "世界", optional: null };
    const input = { first: shared, second: shared, array: [false, 0, [shared]] };
    expect(jsonArguments(input)).toBe(input);
  });

  it.each([undefined, null, [], "text", 1, { value: undefined }, { value: NaN },
    { value: Infinity }, { value: 1n }, { value: () => 1 }, { value: new Date() },
    { value: new Array(2) }, { [Symbol("hidden")]: 1 }])("rejects non-JSON input %#", (input) => {
    expect(() => jsonArguments(input)).toThrow();
  });

  it("rejects cycles and accessors without executing user code", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => jsonArguments(cycle)).toThrow("Cyclic");
    let read = false;
    expect(() => jsonArguments({ get value() { read = true; return 1; } })).toThrow("property");
    expect(read).toBe(false);
  });

  it("preserves bounded recovery guidance on invalid host-prepared arguments", () => {
    const tool = withNwhToolRecovery(defineTool({
      name: "read_source_evidence", label: "Evidence", description: "Read evidence",
      parameters: Type.Object({ ref: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    }));
    expect(() => tool.prepareArguments!({ ref: undefined })).toThrow("Retry read_source_evidence once with corrected arguments");
  });
});

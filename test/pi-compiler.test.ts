import { describe, expect, it } from "vitest";
import { resolvePiCompilerSessionLifecycle } from "../src/compiler/pi-compiler.js";

describe("Pi compiler session lifecycle", () => {
  it("keeps an explicit manual compiler conversation persistable", () => {
    expect(resolvePiCompilerSessionLifecycle({})).toEqual({ isolated: false, saveSession: true, includeNwhExtension: true });
    expect(resolvePiCompilerSessionLifecycle({ saveSession: false })).toEqual({ isolated: false, saveSession: false, includeNwhExtension: true });
  });

  it("makes every source-, batch-, slice-, or tool-bounded job fresh and ephemeral", () => {
    for (const options of [
      { sourceId: "source-1" },
      { compilerBatchId: "batch-1" },
      { segmentIds: [] },
      { includeLocalTools: false },
    ] as const) {
      expect(resolvePiCompilerSessionLifecycle(options)).toEqual({ isolated: true, saveSession: false, includeNwhExtension: false });
    }
  });

  it("rejects transcript resume or persistence when a compiler authority boundary is active", () => {
    expect(() => resolvePiCompilerSessionLifecycle({ sourceId: "source-1", sessionId: "old-session" }))
      .toThrow("cannot resume a saved transcript");
    expect(() => resolvePiCompilerSessionLifecycle({ compilerBatchId: "batch-1", saveSession: true }))
      .toThrow("cannot persist its transcript");
  });
});

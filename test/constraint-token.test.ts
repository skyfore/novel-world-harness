import { describe, expect, it } from "vitest";
import { ConstraintTokenLedger } from "../src/world/constraint-token.js";

describe("turn-local constraint tokens", () => {
  const candidate = {
    title: "Try the locked door",
    proposedDelta: { version: 1, operations: [] },
  };

  it("binds an opaque token to the exact parent and candidate and consumes it once", () => {
    const ledger = new ConstraintTokenLedger("commit-a", candidate, [
      { kind: "state", entityId: "door", field: "artifact.locked" },
    ]);
    const token = ledger.constraints[0]!.token;

    expect(token).toMatch(/^ct1-[a-f0-9]{48}$/);
    expect(token).not.toContain("door");
    expect(ledger.consume([token], "commit-a", candidate)).toEqual([
      { kind: "state", entityId: "door", field: "artifact.locked" },
    ]);
    expect(() => ledger.consume([token], "commit-a", candidate)).toThrow(/CONSTRAINT_TOKEN_REUSED/u);
  });

  it("rejects spoofed and stale-scope tokens without consuming a valid capability", () => {
    const ledger = new ConstraintTokenLedger("commit-a", candidate, [
      { kind: "deterministic-issue", issueCode: "LOCKED" },
    ]);
    const token = ledger.constraints[0]!.token;

    expect(() => ledger.consume([`ct1-${"0".repeat(48)}`], "commit-a", candidate)).toThrow(/CONSTRAINT_TOKEN_INVALID/u);
    expect(() => ledger.consume([token], "commit-b", candidate)).toThrow(/CONSTRAINT_TOKEN_SCOPE_MISMATCH/u);
    expect(() => ledger.consume([token], "commit-a", { ...candidate, title: "Changed" })).toThrow(/CONSTRAINT_TOKEN_SCOPE_MISMATCH/u);
    expect(ledger.consume([token], "commit-a", candidate)).toEqual([
      { kind: "deterministic-issue", issueCode: "LOCKED" },
    ]);
  });
});

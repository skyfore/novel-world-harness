import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  branchHasUntrustedSummary,
  contextPolicyMarker,
  NWH_CONTEXT_POLICY_MARKER,
  projectCompletedNwhMessages,
  projectNwhModelMessages,
  projectNwhSummaryEntries,
} from "../src/agent/context-policy.js";

const base = (id: string) => ({ id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" });

describe("NWH context policy", () => {
  it("preserves ordinary Pi summaries when no NWH-private entry exists", () => {
    const entries = [
      { ...base("s1"), type: "compaction", firstKeptEntryId: "u1", tokensBefore: 100, summary: "ordinary summary" },
      { ...base("u2"), type: "message", message: { role: "user", content: "after", timestamp: 3 } },
    ] as SessionEntry[];

    expect(projectNwhSummaryEntries(entries)).toEqual(entries);
    expect(branchHasUntrustedSummary(entries)).toBe(false);
  });

  it("rejects an unmarked summary when private NWH context existed only on another branch", () => {
    const currentBranch = [
      { ...base("legacy-branch-summary"), type: "branch_summary", fromId: "elsewhere", summary: "possibly mixed" },
      { ...base("u2"), type: "message", message: { role: "user", content: "after", timestamp: 3 } },
    ] as SessionEntry[];

    expect(branchHasUntrustedSummary(currentBranch, true)).toBe(true);
    expect(projectNwhSummaryEntries(currentBranch, true).map((entry) => entry.id)).toEqual(["u2"]);
  });

  it("keeps display-only play transcript out of every ordinary model turn", () => {
    const before = { role: "user", content: "ordinary" };
    const after = { role: "assistant", content: "answer" };
    expect(projectNwhModelMessages([
      before,
      { role: "custom", customType: "nwh-play", content: "private player wording" },
      { role: "custom", customType: "nwh-narrator", content: "rendered prose" },
      after,
    ], false)).toEqual([before, after]);
  });

  it("fails closed when an active compiler turn has no host evidence boundary", () => {
    expect(projectNwhModelMessages([
      { role: "user", content: "ordinary conversation" },
      { role: "assistant", content: "prior answer" },
    ], true)).toEqual([]);
  });

  it("carries compiler-span state across compaction partitions", () => {
    const history = projectCompletedNwhMessages([
      { role: "user", content: "ordinary" },
      { role: "custom", customType: "nwh-compiler-batch", content: "evidence" },
    ]);
    const prefix = projectCompletedNwhMessages([
      { role: "assistant", content: "compiler analysis" },
      { role: "toolResult", content: "proposal" },
      { role: "user", content: "new ordinary turn" },
    ], history.state.compilerSpan);

    expect(history.messages).toEqual([{ role: "user", content: "ordinary" }]);
    expect(prefix.messages).toEqual([{ role: "user", content: "new ordinary turn" }]);
    expect(JSON.stringify([...history.messages, ...prefix.messages])).not.toContain("compiler analysis");
    expect(JSON.stringify([...history.messages, ...prefix.messages])).not.toContain("proposal");
  });

  it("removes private spans and legacy summaries before tree summarization", () => {
    const entries = [
      { ...base("u1"), type: "message", message: { role: "user", content: "before", timestamp: 1 } },
      { ...base("c1"), type: "custom_message", customType: "nwh-compiler-batch", content: "evidence", display: false },
      { ...base("a1"), type: "message", message: { role: "assistant", content: [], timestamp: 2 } },
      { ...base("p1"), type: "custom_message", customType: "nwh-play", content: "player", display: true },
      { ...base("s1"), type: "branch_summary", fromId: "u1", summary: "legacy summary" },
      { ...base("u2"), type: "message", message: { role: "user", content: "after", timestamp: 3 } },
    ] as SessionEntry[];

    expect(projectNwhSummaryEntries(entries).map((entry) => entry.id)).toEqual(["u1", "u2"]);
    expect(branchHasUntrustedSummary(entries)).toBe(true);
  });

  it("treats persisted native narrator streams as private custom entries", () => {
    const entries = [
      { ...base("n1"), type: "custom", customType: "nwh-narrator", data: { message: { role: "assistant", content: "private prose" } } },
      { ...base("s1"), type: "compaction", firstKeptEntryId: "n1", tokensBefore: 100, summary: "legacy mixed summary" },
      { ...base("u1"), type: "message", message: { role: "user", content: "ordinary", timestamp: 3 } },
    ] as SessionEntry[];

    expect(branchHasUntrustedSummary(entries)).toBe(true);
    expect(projectNwhSummaryEntries(entries).map((entry) => entry.id)).toEqual(["u1"]);
  });

  it("accepts only summaries carrying a persisted projection-policy marker", () => {
    const entries = [
      { ...base("p1"), type: "custom_message", customType: "nwh-play", content: "player", display: true },
      { ...base("s1"), type: "compaction", firstKeptEntryId: "p1", tokensBefore: 100, summary: "safe" },
      { ...base("m1"), type: "custom", customType: NWH_CONTEXT_POLICY_MARKER, data: contextPolicyMarker("s1", "compaction") },
    ] as SessionEntry[];

    expect(branchHasUntrustedSummary(entries)).toBe(false);
    expect(projectNwhSummaryEntries(entries).map((entry) => entry.id)).toContain("s1");
  });

  it("allows a marked latest compaction to supersede an older unsafe branch summary", () => {
    const entries = [
      { ...base("p1"), type: "custom_message", customType: "nwh-play", content: "player", display: true },
      { ...base("legacy-branch"), type: "branch_summary", fromId: "p1", summary: "legacy" },
      { ...base("safe-compaction"), type: "compaction", firstKeptEntryId: "p1", tokensBefore: 100, summary: "safe" },
      { ...base("marker"), type: "custom", customType: NWH_CONTEXT_POLICY_MARKER, data: contextPolicyMarker("safe-compaction", "compaction") },
    ] as SessionEntry[];
    expect(branchHasUntrustedSummary(entries)).toBe(false);
  });
});

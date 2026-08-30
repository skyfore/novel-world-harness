import { describe, expect, it } from "vitest";
import { traceContextSnapshotViewSchema } from "../src/trace/projection.js";
import { traceEventSchema, type TraceEventType } from "../src/trace/schema.js";
import {
  buildTraceLedger,
  diffContextParts,
  isWorldEffectEvent,
  playerVisibleText,
} from "../apps/web/src/trace-model.js";

const observedAt = "2026-08-30T00:00:00.000Z";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

describe("Web trace projections", () => {
  it("derives ledger depth from span parents instead of event ordering", () => {
    const events = [
      event(1, "run.started", "root"),
      event(2, "stage.started", "child", "root", { label: "Interpret", kind: "agent" }),
      event(3, "stage.started", "grandchild", "child", { label: "Request", kind: "llm-turn" }, "call-1"),
      event(4, "stage.started", "parallel", "root", { label: "NPC", kind: "agent" }),
      event(5, "llm.request.started", "grandchild", "child", { modelId: "fake" }, "call-1"),
      event(6, "stage.finished", "child", "root", { label: "Interpret", kind: "agent" }),
    ];

    const rows = buildTraceLedger(events, "root");

    expect(rows.map((row) => [row.event.seq, row.depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 1],
      [5, 2],
      [6, 1],
    ]);
    expect(rows[4]).toMatchObject({ category: "llm", label: "Request #1 · request started" });
  });

  it("diffs context parts by stable IDs, hashes, disposition, and message indexes", () => {
    const left = snapshot([
      part("stable", "Stable", hashA, [0]),
      part("changed", "Changed", hashA, [1]),
      part("removed", "Removed", hashA, [2]),
    ]);
    const right = snapshot([
      part("stable", "Stable", hashA, [0]),
      part("changed", "Changed", hashB, [3]),
      part("added", "Added", hashA, [4]),
    ]);

    expect(diffContextParts(left, right).map((entry) => ({
      id: entry.id,
      status: entry.status,
      changes: entry.changes,
    }))).toEqual([
      { id: "stable", status: "unchanged", changes: [] },
      { id: "changed", status: "changed", changes: ["content hash", "message indexes"] },
      { id: "removed", status: "removed", changes: ["part removed"] },
      { id: "added", status: "added", changes: ["part added"] },
    ]);
  });

  it("extracts only explicit player-visible text fields", () => {
    expect(playerVisibleText({ text: "Visible scene" })).toBe("Visible scene");
    expect(playerVisibleText({ content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] })).toBe("AB");
    expect(playerVisibleText({ thinking: "hidden" })).toBeUndefined();
  });

  it("presents restart reconciliation as an inspectable world-effect observation", () => {
    const recovery = event(1, "recovery.diagnostic", "root", undefined, {
      code: "PLAYER_MOVE_COMMIT_RECONCILED_FROM_AUDIT",
      worldOutcome: "committed",
    });
    expect(isWorldEffectEvent(recovery)).toBe(true);
    expect(buildTraceLedger([recovery], "root")[0]).toMatchObject({
      category: "world",
      label: "Restart reconciliation",
      detail: "PLAYER_MOVE_COMMIT_RECONCILED_FROM_AUDIT",
      terminal: true,
    });
  });
});

function event(
  seq: number,
  type: TraceEventType,
  spanId: string,
  parentSpanId?: string,
  data: Record<string, unknown> = {},
  callId?: string,
) {
  return traceEventSchema.parse({
    version: 1,
    runId: "run-1",
    seq,
    observedAt,
    type,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    ...(callId ? { callId } : {}),
    data,
  });
}

function snapshot(parts: ReturnType<typeof part>[]) {
  const storedParts = parts.map(({ content: _content, ...stored }) => stored);
  return traceContextSnapshotViewSchema.parse({
    eventSeq: 1,
    snapshot: {
      version: 1,
      callId: "call-1",
      invocationName: "test",
      assemblyVersion: "v1",
      parts: storedParts,
      tools: [],
    },
    parts,
    availableTools: [],
  });
}

function part(id: string, label: string, sha256: string, logicalMessageIndexes: number[]) {
  return {
    id,
    label,
    kind: "player.utterance" as const,
    role: "user" as const,
    authority: "untrusted-player" as const,
    sourceRefs: [],
    contentRef: { sha256, byteLength: 10, mediaType: "text/plain" },
    content: label,
    charCount: 10,
    estimatedTokens: 3,
    disposition: "included" as const,
    logicalMessageIndexes,
  };
}

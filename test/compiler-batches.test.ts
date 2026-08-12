import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCompilerBatches, runCompilerBatches } from "../src/compiler/batches.js";
import { compilerBatchFailure, compilerBatchOutcomeFromMessages } from "../src/compiler/batch-outcome.js";
import { SegmentStore, segmentSource } from "../src/compiler/segments.js";
import type { SourceDocument } from "../src/storage/workspace-store.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture(): Promise<{ root: string; source: SourceDocument }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-batches-"));
  roots.push(root);
  const content = Array.from({ length: 12 }, (_, index) => `第${index + 1}章\n人物在第${index + 1}章行动。\n`).join("\n");
  const buffer = Buffer.from(content, "utf8");
  await fs.writeFile(path.join(root, "novel.txt"), buffer);
  const sha = crypto.createHash("sha256").update(buffer).digest("hex");
  const source: SourceDocument = {
    version: 1,
    id: sha.slice(0, 20),
    title: "novel.txt",
    sourcePath: "novel.txt",
    contentSha256: sha,
    bytes: buffer.byteLength,
    registeredAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const manifest = await segmentSource(root, source);
  await new SegmentStore(root).write(manifest);
  return { root, source };
}

describe("compiler batches", () => {
  it("requires a clean model stop and an explicit, consistent finish handshake", () => {
    expect(compilerBatchFailure({ assistantStopReason: "stop", proposalSucceeded: 1, proposalFailed: 0, completionSignaled: true, completionOutcome: "complete" })).toBeUndefined();
    expect(compilerBatchFailure({ assistantStopReason: "stop", proposalSucceeded: 0, proposalFailed: 0, completionSignaled: true, completionOutcome: "no-artifacts" })).toBeUndefined();
    expect(compilerBatchFailure({ assistantStopReason: "stop", proposalSucceeded: 1, proposalFailed: 0, completionSignaled: false })).toContain("explicitly finish");
    expect(compilerBatchFailure({ assistantStopReason: "stop", proposalSucceeded: 0, proposalFailed: 0, completionSignaled: true, completionOutcome: "complete" })).toContain("without a valid");
    expect(compilerBatchFailure({ assistantStopReason: "stop", proposalSucceeded: 2, proposalFailed: 1, completionSignaled: true, completionOutcome: "complete" })).toContain("failed");
    expect(compilerBatchFailure({ assistantStopReason: "length", proposalSucceeded: 2, proposalFailed: 0, completionSignaled: true, completionOutcome: "complete" })).toContain("length");
  });

  it("treats a successful retry of the same proposal id as resolving its earlier tool error", () => {
    const outcome = compilerBatchOutcomeFromMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "bad", name: "propose_claim", arguments: { proposal_id: "claim-1", payload: "{not-json" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "bad", toolName: "propose_claim", isError: true, content: [] },
      { role: "assistant", content: [{ type: "toolCall", id: "fixed", name: "propose_claim", arguments: { proposal_id: "claim-1", payload: JSON.stringify({ id: "claim-1" }) } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "fixed", toolName: "propose_claim", isError: false, content: [] },
      { role: "assistant", content: [{ type: "toolCall", id: "finish", name: "finish_compiler_batch", arguments: { outcome: "complete", proposal_ids: ["claim-1"], summary: "done" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "finish", toolName: "finish_compiler_batch", isError: false, content: [] },
      { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    expect(outcome).toEqual({ assistantStopReason: "stop", proposalSucceeded: 1, proposalFailed: 0, completionSignaled: true, completionOutcome: "complete" });
    expect(compilerBatchFailure(outcome)).toBeUndefined();
  });

  it("keeps an abandoned proposal error unresolved", () => {
    const outcome = compilerBatchOutcomeFromMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "bad", name: "propose_claim", arguments: { proposal_id: "claim-1" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "bad", toolName: "propose_claim", isError: true, content: [] },
      { role: "assistant", content: [{ type: "toolCall", id: "other", name: "propose_claim", arguments: { proposal_id: "claim-2" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "other", toolName: "propose_claim", isError: false, content: [] },
      { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    expect(outcome.proposalFailed).toBe(1);
    expect(compilerBatchFailure(outcome)).toContain("failed");
  });
  it("builds bounded prompts with explicit evidence refs", async () => {
    const { root, source } = await fixture();
    const batches = await prepareCompilerBatches(root, source);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => batch.segmentIds.length <= 6)).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("EvidenceRef"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("<source-segment"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("character.location"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("Copy a supplied whole-segment EvidenceRef exactly"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("finish_compiler_batch"))).toBe(true);
  });

  it("marks successful batches and resumes after an interrupted run", async () => {
    const { root, source } = await fixture();
    const firstSeen: string[] = [];
    const first = await runCompilerBatches({
      workspaceRoot: root,
      source,
      maxBatches: 1,
      runner: async (batch) => { firstSeen.push(batch.id); },
    });
    expect(first.completed).toBe(1);
    expect(first.remaining).toBeGreaterThan(0);

    const resumedSeen: string[] = [];
    const resumed = await runCompilerBatches({
      workspaceRoot: root,
      source,
      runner: async (batch) => { resumedSeen.push(batch.id); },
    });
    expect(resumed.skipped).toBe(1);
    expect(resumed.remaining).toBe(0);
    expect(resumedSeen).not.toContain(firstSeen[0]);

    const noWork = await runCompilerBatches({
      workspaceRoot: root,
      source,
      runner: async () => { throw new Error("should not run"); },
    });
    expect(noWork.completed).toBe(0);
    expect(noWork.skipped).toBe(noWork.total);
  });

  it("does not checkpoint a failed batch", async () => {
    const { root, source } = await fixture();
    await expect(
      runCompilerBatches({
        workspaceRoot: root,
        source,
        maxBatches: 1,
        runner: async () => { throw new Error("model failed"); },
      }),
    ).rejects.toThrow("model failed");
    const retried: string[] = [];
    const retry = await runCompilerBatches({
      workspaceRoot: root,
      source,
      maxBatches: 1,
      runner: async (batch) => { retried.push(batch.id); },
    });
    expect(retry.completed).toBe(1);
    expect(retried).toHaveLength(1);
  });
});

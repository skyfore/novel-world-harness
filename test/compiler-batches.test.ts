import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCompilerBatches, runCompilerBatches } from "../src/compiler/batches.js";
import { compilerBatchFailure, compilerBatchOutcomeFromMessages } from "../src/compiler/batch-outcome.js";
import { SegmentStore, segmentSource } from "../src/compiler/segments.js";
import type { SourceDocument } from "../src/storage/workspace-store.js";
import { ProposalStore } from "../src/world/canonical-model.js";
import { claimSchema, entitySchema } from "../src/world/model.js";
import { initialWorldSchema } from "../src/world/initial.js";
import { characterGoalSchema, characterModelSchema } from "../src/world/actors.js";

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
    expect(compilerBatchFailure({ assistantStopReason: "stop", proposalSucceeded: 2, proposalFailed: 1, completionSignaled: true, completionOutcome: "complete" })).toBeUndefined();
    expect(compilerBatchFailure({ assistantStopReason: "stop", proposalSucceeded: 0, proposalFailed: 1, completionSignaled: true, completionOutcome: "no-artifacts" })).toContain("failed");
    expect(compilerBatchFailure({ assistantStopReason: "length", proposalSucceeded: 2, proposalFailed: 0, completionSignaled: true, completionOutcome: "complete" })).toContain("length");
  });

  it("treats a successful retry of the same proposal id as resolving its earlier tool error", () => {
    const outcome = compilerBatchOutcomeFromMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "bad", name: "propose_claim", arguments: { proposal_id: "claim-1", payload: "{not-json" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "bad", toolName: "propose_claim", isError: true, content: [] },
      { role: "assistant", content: [{ type: "toolCall", id: "fixed", name: "propose_claim", arguments: { proposal_id: "claim-1", payload: JSON.stringify({ id: "claim-1" }) } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "fixed", toolName: "propose_claim", isError: false, content: [] },
      { role: "assistant", content: [{ type: "toolCall", id: "finish", name: "finish_compiler_batch", arguments: { outcome: "complete", proposal_ids: ["claim-1"], reviewed_segments: [], summary: "done" } }], stopReason: "toolUse" },
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

  it("treats a successful complete handshake as authoritative after corrected or abandoned drafts", () => {
    const outcome = compilerBatchOutcomeFromMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "bad", name: "propose_claim", arguments: { proposal_id: "claim-draft" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "bad", toolName: "propose_claim", isError: true, content: [] },
      { role: "assistant", content: [{ type: "toolCall", id: "fixed", name: "propose_claim", arguments: { proposal_id: "claim-final" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "fixed", toolName: "propose_claim", isError: false, content: [] },
      { role: "assistant", content: [{ type: "toolCall", id: "finish", name: "finish_compiler_batch", arguments: { outcome: "complete", proposal_ids: ["claim-final"], reviewed_segments: [], summary: "done" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "finish", toolName: "finish_compiler_batch", isError: false, content: [] },
      { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    expect(outcome.proposalFailed).toBe(1);
    expect(compilerBatchFailure(outcome)).toBeUndefined();
  });

  it("counts host-recovered proposals acknowledged only by the finish result", () => {
    const outcome = compilerBatchOutcomeFromMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "finish", name: "finish_compiler_batch", arguments: { outcome: "complete", reviewed_segments: [], summary: "recovered" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "finish", toolName: "finish_compiler_batch", isError: false, content: [], details: { compilerBatchFinished: true, proposalIds: ["proposal-from-prior-run"] } },
      { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);

    expect(outcome).toMatchObject({ proposalSucceeded: 1, completionSignaled: true, completionOutcome: "complete" });
    expect(compilerBatchFailure(outcome)).toBeUndefined();
  });

  it("removes a successfully withdrawn proposal from the active batch outcome", () => {
    const outcome = compilerBatchOutcomeFromMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "draft", name: "propose_claim", arguments: { proposal_id: "claim-draft" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "draft", toolName: "propose_claim", isError: false, content: [] },
      { role: "assistant", content: [{ type: "toolCall", id: "withdraw", name: "withdraw_compiler_proposal", arguments: { proposal_id: "claim-draft", reason: "bad reference" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "withdraw", toolName: "withdraw_compiler_proposal", isError: false, content: [] },
      { role: "assistant", content: [{ type: "toolCall", id: "final", name: "propose_claim", arguments: { proposal_id: "claim-final" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "final", toolName: "propose_claim", isError: false, content: [] },
      { role: "assistant", content: [{ type: "toolCall", id: "finish", name: "finish_compiler_batch", arguments: { outcome: "complete", proposal_ids: ["claim-final"], reviewed_segments: [], summary: "done" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "finish", toolName: "finish_compiler_batch", isError: false, content: [] },
      { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    expect(outcome).toMatchObject({ proposalSucceeded: 1, proposalFailed: 0, completionSignaled: true });
    expect(compilerBatchFailure(outcome)).toBeUndefined();
  });

  it("reports a terminating finish circuit breaker as a batch failure", () => {
    const outcome = compilerBatchOutcomeFromMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "finish", name: "finish_compiler_batch", arguments: { outcome: "complete", proposal_ids: ["claim-draft"], reviewed_segments: [], summary: "done" } }], stopReason: "toolUse" },
      {
        role: "toolResult",
        toolCallId: "finish",
        toolName: "finish_compiler_batch",
        isError: true,
        content: [],
        details: { compilerBatchBlocked: true, reason: "graph remains incomplete", finishFailureCount: 2 },
      },
    ]);
    expect(outcome).toMatchObject({ completionSignaled: false, blockedReason: "graph remains incomplete" });
    expect(compilerBatchFailure(outcome)).toContain("finish circuit breaker");
  });

  it("builds bounded prompts with explicit evidence refs", async () => {
    const { root, source } = await fixture();
    const batches = await prepareCompilerBatches(root, source);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches).toHaveLength(12);
    expect(batches.every((batch) => batch.segmentIds.length === 1)).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("EvidenceRef"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("at most 24 high-leverage active proposals"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("<source-segment"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("character.location"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("ASCII logical entity ID"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("Compile explicitly narrated later canonical events too"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("observedKnowledge"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("location.open"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("artifact.delivered"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("one explicitly narrated transition at a time"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("Every explicitly narrated character movement"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("never use a chapter number, bell count"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("Pending proposals are immutable"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("withdraw_compiler_proposal"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("kind=canon-analogue"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("Use player-choice"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("Copy a supplied whole-segment EvidenceRef exactly"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("finish_compiler_batch"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("only compiler pass guaranteed"))).toBe(true);
    expect(batches.every((batch) => batch.prompt.includes("reviewed_segments"))).toBe(true);
  });

  it("rebuilds a stale segmenter manifest even when source bytes are unchanged", async () => {
    const { root, source } = await fixture();
    const store = new SegmentStore(root);
    const stale = await store.readManifest(source.id);
    expect(stale).not.toBeNull();
    await store.write({ ...stale!, segmenterVersion: 1 });

    await prepareCompilerBatches(root, source);

    await expect(store.readManifest(source.id)).resolves.toMatchObject({ segmenterVersion: 2 });
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

  it("refreshes pending entity identities between batches in the same run", async () => {
    const { root, source } = await fixture();
    const seen: string[] = [];
    await runCompilerBatches({
      workspaceRoot: root,
      source,
      maxBatches: 2,
      runner: async (batch) => {
        seen.push(batch.prompt);
        if (seen.length !== 1) return;
        const evidence = [{ span: { sourceId: source.id, startLine: 1, endLine: 1, quoteHash: "fixture" }, strength: "explicit" as const }];
        await new ProposalStore(root).writePending({
          id: "proposal-existing-person",
          kind: "entity",
          schemaVersion: 1,
          payload: {
            id: "existing-person",
            kind: "character",
            canonicalName: "人物2",
            aliases: ["Existing Person"],
            evidence,
          },
          evidence: [],
          generatedBy: { worker: "test" },
          createdAt: new Date(0).toISOString(),
        }, entitySchema);
        await new ProposalStore(root).writePending({
          id: "proposal-existing-claim",
          kind: "claim",
          schemaVersion: 1,
          payload: {
            id: "existing-claim",
            subject: "existing-person",
            predicate: "entered",
            object: "city",
            epistemicType: "explicit-fact",
            evidence,
          },
          evidence: [],
          generatedBy: { worker: "test" },
          createdAt: new Date(0).toISOString(),
        }, claimSchema);
        await new ProposalStore(root).writePending({
          id: "proposal-opening",
          kind: "initial-world",
          schemaVersion: 1,
          payload: { version: 1, delta: { version: 1, operations: [] }, evidence },
          evidence: [],
          generatedBy: { worker: "test" },
          createdAt: new Date(0).toISOString(),
        }, initialWorldSchema);
        await new ProposalStore(root).writePending({
          id: "proposal-existing-goal",
          kind: "character-goal",
          schemaVersion: 1,
          payload: { id: "existing-goal", actorId: "existing-person", description: "Enter the city", priority: 0.8, requiresKnowledge: [], evidence },
          evidence: [],
          generatedBy: { worker: "test" },
          createdAt: new Date(0).toISOString(),
        }, characterGoalSchema);
        await new ProposalStore(root).writePending({
          id: "proposal-existing-model",
          kind: "character-model",
          schemaVersion: 1,
          payload: { actorId: "existing-person", traits: { bold: 0.5 }, decisionBiases: {}, evidence },
          evidence: [],
          generatedBy: { worker: "test" },
          createdAt: new Date(0).toISOString(),
        }, characterModelSchema);
      },
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('"entities":[]');
    expect(seen[1]).toContain('"id":"existing-person"');
    expect(seen[1]).toContain('"id":"existing-claim"');
    expect(seen[1]).toContain('"proposalId":"proposal-opening"');
    expect(seen[1]).toContain('"id":"existing-goal"');
    expect(seen[1]).toContain('"proposalId":"proposal-existing-model"');
    expect(seen[1]).toContain('"status":"pending"');
    expect(seen[1]).toContain("Do not submit a second initial-world");
  });

  it("does not leak pending artifacts from another source into the active catalog", async () => {
    const { root, source } = await fixture();
    await new ProposalStore(root).writePending({
      id: "foreign-entity-proposal",
      kind: "entity",
      schemaVersion: 1,
      payload: {
        id: "foreign-entity",
        kind: "character",
        canonicalName: "Foreign",
        aliases: [],
        evidence: [{ span: { sourceId: "another-source", startLine: 1, endLine: 1, quoteHash: "foreign" }, strength: "explicit" }],
      },
      evidence: [],
      generatedBy: { worker: "test" },
      createdAt: new Date(0).toISOString(),
    }, entitySchema);

    let prompt = "";
    await runCompilerBatches({
      workspaceRoot: root,
      source,
      maxBatches: 1,
      runner: async (batch) => { prompt = batch.prompt; },
    });

    expect(prompt).not.toContain("foreign-entity");
  });

  it("bounds the hydrated artifact catalog for long full-book runs", async () => {
    const { root, source } = await fixture();
    const proposals = new ProposalStore(root);
    const evidence = [{ span: { sourceId: source.id, startLine: 1, endLine: 1, quoteHash: "fixture" }, strength: "explicit" as const }];
    await Promise.all(Array.from({ length: 450 }, async (_, index) => {
      const id = `catalog-person-${String(index).padStart(4, "0")}`;
      await proposals.writePending({
        id: `proposal-${id}`,
        kind: "entity",
        schemaVersion: 1,
        payload: { id, kind: "character", canonicalName: `Person ${index}`, aliases: [], evidence },
        evidence: [],
        generatedBy: { worker: "test" },
        createdAt: new Date(0).toISOString(),
      }, entitySchema);
    }));
    let prompt = "";
    await runCompilerBatches({
      workspaceRoot: root,
      source,
      maxBatches: 1,
      runner: async (batch) => { prompt = batch.prompt; },
    });

    expect(prompt.length).toBeLessThan(100_000);
    expect(prompt).toContain('"omitted":{"entities":50}');
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

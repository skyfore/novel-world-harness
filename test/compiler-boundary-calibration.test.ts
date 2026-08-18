import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { BoundaryCalibrationStore } from "../src/compiler/boundary-calibration.js";
import { prepareCompilerBatches, runCompilerBatches } from "../src/compiler/batches.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { ProposalStore } from "../src/world/canonical-model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-boundary-calibration-"));
  roots.push(root);
  const evidence = await createEvidenceFixture(
    root,
    "Chapter 1\nAlice raises the silver key and\n\nChapter 2\nopens the gate before dawn.\n",
  );
  const segments = await new SegmentStore(root).list(evidence.source.id);
  expect(segments).toHaveLength(2);
  return { root, evidence, segments };
}

function resultText(result: unknown): string {
  return (result as { content: Array<{ type: string; text?: string }> }).content
    .flatMap((item) => item.type === "text" && item.text ? [item.text] : [])
    .join("\n");
}

describe("compiler boundary calibration", () => {
  it("peeks once without granting citable evidence and queues a durable pair batch", async () => {
    const { root, evidence, segments } = await fixture();
    const regular = (await prepareCompilerBatches(root, evidence.source))[0]!;
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([segments[0]!.id], regular.id, evidence.source.id);
    const peek = toolset.tools.find((tool) => tool.name === "peek_adjacent_evidence")!;
    const defer = toolset.tools.find((tool) => tool.name === "defer_boundary_artifact")!;

    await expect(defer.execute("too-early", {
      direction: "next",
      reason: "The action may continue.",
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("peek_adjacent_evidence");

    const preview = await peek.execute("peek", {
      direction: "next",
      max_chars: 1_000,
      reason: "The first segment ends mid-action.",
    } as never, undefined, undefined, {} as ExtensionContext);
    expect(resultText(preview)).toContain("opens the gate before dawn");
    expect(resultText(preview)).toContain("context-only");
    expect(resultText(preview)).not.toContain("quoteHash");
    await expect(peek.execute("peek-again", {
      direction: "next",
      reason: "Read it again.",
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("already been read");

    await expect(defer.execute("defer", {
      direction: "next",
      reason: "Raising and using the key is one action split between segments.",
      artifact_ids: ["alice-opens-gate"],
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { compilerBoundaryCalibrationRequested: true, direction: "next" },
    });

    const requests = await new BoundaryCalibrationStore(root).list(evidence.source.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      leftSegmentId: segments[0]!.id,
      rightSegmentId: segments[1]!.id,
      requestedBy: [{ batchId: regular.id, artifactIds: ["alice-opens-gate"] }],
    });
    const batches = await prepareCompilerBatches(root, evidence.source);
    const calibration = batches.find((batch) => batch.purpose === "boundary-calibration")!;
    expect(calibration.segmentIds).toEqual([segments[0]!.id, segments[1]!.id]);
    expect(calibration.prompt).toContain("dedicated boundary-calibration pass");
    expect(calibration.prompt).toContain("replace_boundary_proposal");
    expect(calibration.prompt.match(/<source-segment id=/g)).toHaveLength(2);

    const retry = createCompilerProposalToolset(root);
    await retry.beginBatch([segments[0]!.id], regular.id, evidence.source.id);
    await expect(new BoundaryCalibrationStore(root).list(evidence.source.id)).resolves.toEqual([]);
  });

  it("discovers newly requested calibration work before crossing the review barrier", async () => {
    const { root, evidence, segments } = await fixture();
    const seen: Array<{ id: string; purpose: string }> = [];
    const result = await runCompilerBatches({
      workspaceRoot: root,
      source: evidence.source,
      async runner(batch) {
        seen.push({ id: batch.id, purpose: batch.purpose });
        if (batch.purpose === "source-review" && batch.segmentIds[0] === segments[0]!.id) {
          await new BoundaryCalibrationStore(root).request({
            sourceId: evidence.source.id,
            leftSegmentId: segments[0]!.id,
            rightSegmentId: segments[1]!.id,
            requestedByBatchId: batch.id,
            requestedBySegmentId: segments[0]!.id,
            direction: "next",
            reason: "The action crosses the split.",
          });
        }
      },
    });

    expect(seen.map((item) => item.purpose)).toEqual([
      "source-review",
      "source-review",
      "boundary-calibration",
    ]);
    expect(result).toEqual({ total: 3, completed: 3, skipped: 0, remaining: 0 });
  });

  it("replaces only a same-identity adjacent draft from inside the pair calibration", async () => {
    const { root, evidence, segments } = await fixture();
    const regular = (await prepareCompilerBatches(root, evidence.source))[0]!;
    const sourceTools = createCompilerProposalToolset(root);
    await sourceTools.beginBatch([segments[0]!.id], regular.id, evidence.source.id);
    const proposeSourceEntity = sourceTools.tools.find((tool) => tool.name === "propose_entity")!;
    await proposeSourceEntity.execute("partial", {
      proposal_id: "alice-partial",
      payload: {
        id: "alice",
        kind: "character",
        canonicalName: "Alice",
        aliases: [],
        evidence: evidence.evidence("Alice"),
      },
    } as never, undefined, undefined, {} as ExtensionContext);
    const peek = sourceTools.tools.find((tool) => tool.name === "peek_adjacent_evidence")!;
    const defer = sourceTools.tools.find((tool) => tool.name === "defer_boundary_artifact")!;
    await peek.execute("peek", {
      direction: "next",
      reason: "The action continues.",
    } as never, undefined, undefined, {} as ExtensionContext);
    await defer.execute("defer", {
      direction: "next",
      reason: "The identity participates in a cross-boundary action.",
      artifact_ids: ["alice-partial"],
    } as never, undefined, undefined, {} as ExtensionContext);

    const calibration = (await prepareCompilerBatches(root, evidence.source))
      .find((batch) => batch.purpose === "boundary-calibration")!;
    const boundaryTools = createCompilerProposalToolset(root);
    await boundaryTools.beginBatch(calibration.segmentIds, calibration.id, evidence.source.id);
    const proposeReplacement = boundaryTools.tools.find((tool) => tool.name === "propose_entity")!;
    const replace = boundaryTools.tools.find((tool) => tool.name === "replace_boundary_proposal")!;
    await proposeReplacement.execute("replacement", {
      proposal_id: "alice-boundary-v2",
      payload: {
        id: "alice",
        kind: "character",
        canonicalName: "Alice",
        aliases: [],
        evidence: evidence.evidence("Alice"),
      },
    } as never, undefined, undefined, {} as ExtensionContext);
    await expect(replace.execute("replace", {
      proposal_id: "alice-partial",
      replacement_proposal_id: "alice-boundary-v2",
      reason: "The pair pass supersedes the partial boundary reading.",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: {
        compilerBoundaryProposalReplaced: true,
        proposalId: "alice-partial",
        replacementProposalId: "alice-boundary-v2",
      },
    });

    const proposals = new ProposalStore(root);
    await expect(proposals.list("pending")).resolves.toEqual([
      expect.objectContaining({ id: "alice-boundary-v2" }),
    ]);
    await expect(proposals.list("rejected")).resolves.toEqual([
      expect.objectContaining({ id: "alice-partial" }),
    ]);
  });
});

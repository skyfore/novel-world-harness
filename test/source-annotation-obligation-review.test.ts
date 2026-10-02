import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SourceAnnotationStore } from "../src/compiler/annotations.js";
import { sourceBatchId } from "../src/compiler/batch-plan.js";
import { CompilerFinishReceipts } from "../src/compiler/finish-receipts.js";
import { CompilerProposalObligations } from "../src/compiler/proposal-obligations.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { reviewSourceAnnotationObligation } from "../src/compiler/source-annotation-obligation-review.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function failedEventMentionFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-annotation-obligation-review-"));
  roots.push(root);
  const content = "The boy climbed ashore.\nHe watched for several seconds.\n“I came for my brother. Did you see him?” the boy asked, his voice distant.\n";
  const fixture = await createEvidenceFixture(root, content);
  const batchId = sourceBatchId(fixture.source.id, 0, "semantic", [fixture.segmentId]);
  const toolset = createCompilerProposalToolset(root);
  await toolset.beginBatch([fixture.segmentId], batchId, fixture.source.id);
  const tool = toolset.tools.find(candidate => candidate.name === "propose_event_mention")!;
  const common = {
    proposal_id: "mention-pool-encounter-v2",
    annotation_id: "mention-pool-encounter",
    trigger: "the boy asked",
    event_type_candidates: ["communication"],
    participant_mention_ids: [],
    salience: "supporting",
    confidence: 0.99,
    interpretation: "The boy asks whether the listener saw his brother.",
  };
  const original = {
    ...common,
    trigger_selector: {
      segment_id: fixture.segmentId,
      exact: "the boy asked",
      prefix: "a quiet visitor",
      suffix: ", climbing the ladder",
    },
    extent_selectors: [{
      segment_id: fixture.segmentId,
      exact: "“I came for my brother. Did you see him?” the boy asked, his voice distant.",
      prefix: "climbed ashore.",
      suffix: "The listener answered.",
    }],
  };
  const modelCorrection = {
    ...common,
    trigger_selector: {
      segment_id: fixture.segmentId,
      exact: "the boy asked",
      prefix: "a quiet visitor",
      suffix: ", his voice distant.",
    },
    extent_selectors: [{
      segment_id: fixture.segmentId,
      exact: "I came for my brother. Did you see him?",
      prefix: "He watched for seconds. “",
      suffix: "” the boy asked",
    }],
  };
  await expect(tool.execute("original", original as never, undefined, undefined, {} as never))
    .rejects.toThrow(/trigger_selector.*extent_selectors\[0\]/s);
  await expect(tool.execute("model-correction", modelCorrection as never, undefined, undefined, {} as never))
    .rejects.toThrow(/trigger_selector.*extent_selectors\[0\]/s);
  const corrected = {
    ...common,
    trigger_selector: { segment_id: fixture.segmentId, exact: "the boy asked" },
    extent_selectors: [{
      segment_id: fixture.segmentId,
      exact: "“I came for my brother. Did you see him?” the boy asked, his voice distant.",
    }],
  };
  const journal = new CompilerProposalObligations(root, fixture.source.id, batchId);
  const failedInputHashes = journal.history("propose_event_mention", common.proposal_id)
    .filter(attempt => attempt.status === "failed")
    .map(attempt => attempt.inputHash);
  const review = {
    version: 1 as const,
    sourceId: fixture.source.id,
    batchId,
    tool: "propose_event_mention" as const,
    proposalId: common.proposal_id,
    failedInputHashes,
    reason: "Immutable source confirms the attempted trigger and full extent; optional context was not adjacent.",
    auditRef: "test:source-annotation-selector-review",
    input: corrected,
  };
  return { root, fixture, batchId, original, modelCorrection, corrected, journal, review };
}

it("repairs an exhausted event-mention context mismatch without changing source semantics or history", async () => {
  const fixture = await failedEventMentionFixture();
  expect(fixture.journal.requiringHostReview()).toHaveLength(1);

  await expect(reviewSourceAnnotationObligation(fixture.root, {
    ...fixture.review,
    input: { ...fixture.corrected, interpretation: "Changed event meaning." },
  })).rejects.toThrow("cannot change non-selector semantics");
  await expect(reviewSourceAnnotationObligation(fixture.root, {
    ...fixture.review,
    input: {
      ...fixture.corrected,
      extent_selectors: [{
        segment_id: fixture.fixture.segmentId,
        exact: "the boy asked, his voice distant",
      }],
    },
  })).rejects.toThrow("must reuse an exact span from the failed history");
  await expect(reviewSourceAnnotationObligation(fixture.root, {
    ...fixture.review,
    input: fixture.modelCorrection,
  })).rejects.toThrow("must differ from every failed input");

  const preview = await reviewSourceAnnotationObligation(fixture.root, fixture.review);
  expect(preview).toMatchObject({
    status: "verified-preview",
    executableCertification: false,
    batchSegmentIds: [fixture.fixture.segmentId],
    binding: {
      proposalId: fixture.review.proposalId,
      failedInputHashes: [...fixture.review.failedInputHashes].sort(),
      selectorBindings: [
        { path: "/trigger_selector", segmentId: fixture.fixture.segmentId },
        { path: "/extent_selectors/0", segmentId: fixture.fixture.segmentId },
      ],
    },
  });
  await expect(new SourceAnnotationStore(fixture.root).listProposals(fixture.fixture.source.id, "pending"))
    .resolves.toEqual([]);
  await expect(reviewSourceAnnotationObligation(fixture.root, {
    ...fixture.review,
    expectedPreviewHash: "0".repeat(64),
  }, true)).rejects.toThrow("preview changed");

  const applied = await reviewSourceAnnotationObligation(fixture.root, {
    ...fixture.review,
    expectedPreviewHash: preview.previewHash,
  }, true);
  expect(applied.status).toBe("staged");
  await expect(new SourceAnnotationStore(fixture.root).readProposal(
    fixture.fixture.source.id,
    "pending",
    fixture.review.proposalId,
  )).resolves.toMatchObject({
    id: fixture.review.proposalId,
    payload: {
      id: fixture.corrected.annotation_id,
      annotationType: "event-mention",
      trigger: fixture.corrected.trigger,
    },
  });
  const history = fixture.journal.history("propose_event_mention", fixture.review.proposalId);
  expect(history.filter(attempt => attempt.status === "failed").map(attempt => attempt.input))
    .toEqual([fixture.original, fixture.modelCorrection]);
  expect(history.at(-1)).toMatchObject({
    status: "succeeded",
    hostReview: {
      auditRef: fixture.review.auditRef,
      annotationSelectorCorrection: { inputHash: preview.binding.inputHash },
    },
  });
  expect(fixture.journal.unresolved()).toEqual([]);
  await expect(reviewSourceAnnotationObligation(fixture.root, fixture.review))
    .rejects.toThrow(/unresolved, unreviewed failed identity|already has proposal output/);
});

it("refuses annotation correction after a finish receipt freezes the failed batch", async () => {
  const fixture = await failedEventMentionFixture();
  const segments = await new SegmentStore(fixture.root).list(fixture.fixture.source.id);
  await new CompilerFinishReceipts(fixture.root, fixture.fixture.source.id, fixture.batchId).prepare({
    version: 1,
    sourceId: fixture.fixture.source.id,
    sourceSha256: fixture.fixture.source.contentSha256,
    batchId: fixture.batchId,
    input: { outcome: "complete", reviewed_segments: [], summary: "Frozen test finish" },
    segments,
    dependencies: [],
    metadata: {},
  });
  await expect(reviewSourceAnnotationObligation(fixture.root, fixture.review))
    .rejects.toThrow("finish receipt already exists");
});

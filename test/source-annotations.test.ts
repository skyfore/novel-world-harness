import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { SourceAnnotationStore } from "../src/compiler/annotations.js";
import { auditCompiler } from "../src/compiler/audit.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { SourceAccountingStore } from "../src/compiler/source-accounting.js";
import { SourceStructureStore, baseStructuralUnits, ensureSourceStructure } from "../src/compiler/structure.js";
import { CanonicalModelStore, ProposalStore } from "../src/world/canonical-model.js";
import { removeNovelAnalysis } from "../src/world/removal.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
const context = {} as ExtensionContext;

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("source annotation compilation", () => {
  it("commits a source-local mention/quotation/discourse graph without creating canonical identities", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-source-annotations-"));
    roots.push(root);
    const content = `Hero said, "Wait." The villager listened.\nHero remembered the fire.\n`;
    const fixture = await createEvidenceFixture(root, content);
    const initialStructure = await ensureSourceStructure(root, fixture.source);
    const initialOrder = baseStructuralUnits(initialStructure).map((unit) => unit.id);
    const batchId = `batch-${fixture.source.id}-annotations`;
    const toolset = createCompilerProposalToolset(root, { provider: "test", model: "observation-model" });
    await toolset.beginBatch([fixture.segmentId], batchId, fixture.source.id);
    const mention = toolset.tools.find((tool) => tool.name === "propose_entity_mention")!;
    const quotation = toolset.tools.find((tool) => tool.name === "propose_quotation")!;
    const discourse = toolset.tools.find((tool) => tool.name === "propose_discourse_segment")!;
    const finish = toolset.tools.find((tool) => tool.name === "finish_compiler_batch")!;

    await mention.execute("hero-mention", {
      proposal_id: "proposal-mention-hero",
      annotation_id: "mention-hero-opening",
      selector: { segment_id: fixture.segmentId, exact: "Hero", occurrence: 1 },
      surface: "Hero",
      form: "proper",
      kind_candidates: ["character"],
      scene_id: "scene-opening",
      confidence: 0.99,
    } as never, undefined, undefined, context);
    await mention.execute("villager-mention", {
      proposal_id: "proposal-mention-villager",
      annotation_id: "mention-villager",
      selector: { segment_id: fixture.segmentId, exact: "villager" },
      surface: "villager",
      form: "nominal",
      kind_candidates: ["character", "other"],
      scene_id: "scene-opening",
      confidence: 0.8,
    } as never, undefined, undefined, context);
    await discourse.execute("opening-scene", {
      proposal_id: "proposal-scene-opening",
      annotation_id: "scene-opening",
      kind: "scene",
      selectors: [{ segment_id: fixture.segmentId, exact: content }],
      viewpoint_mention_id: "mention-hero-opening",
      confidence: 0.95,
    } as never, undefined, undefined, context);
    await quotation.execute("wait-quote", {
      proposal_id: "proposal-quote-wait",
      annotation_id: "quote-wait",
      selector: { segment_id: fixture.segmentId, exact: '"Wait."' },
      mode: "direct",
      speaker_mention_id: "mention-hero-opening",
      addressee_mention_ids: ["mention-villager"],
      cue_selector: { segment_id: fixture.segmentId, exact: "Hero said" },
      scene_id: "scene-opening",
      attribution_confidence: 0.98,
    } as never, undefined, undefined, context);
    await discourse.execute("memory", {
      proposal_id: "proposal-discourse-memory",
      annotation_id: "discourse-memory",
      kind: "recollection",
      selectors: [{ segment_id: fixture.segmentId, exact: "Hero remembered the fire." }],
      viewpoint_mention_id: "mention-hero-opening",
      confidence: 0.9,
      interpretation: "The remembering clause presents the fire as recalled material inside the enclosing scene.",
    } as never, undefined, undefined, context);

    await expect(finish.execute("finish-annotations", {
      outcome: "complete",
      reviewed_segments: [{
        segment_id: fixture.segmentId,
        disposition: "proposed",
        summary: "Recorded two mentions, attributed speech, an enclosing scene, and an overlapping recollection.",
      }],
      summary: "Committed source observations only.",
    } as never, undefined, undefined, context)).resolves.toMatchObject({
      details: {
        compilerBatchFinished: true,
        proposalIds: [
          "proposal-discourse-memory",
          "proposal-mention-hero",
          "proposal-mention-villager",
          "proposal-quote-wait",
          "proposal-scene-opening",
        ],
      },
    });

    const annotations = await new SourceAnnotationStore(root).list(fixture.source.id);
    expect(annotations.filter((annotation) => annotation.annotationType === "entity-mention")).toHaveLength(2);
    expect(annotations.filter((annotation) => annotation.annotationType === "quotation")).toHaveLength(1);
    expect(annotations.filter((annotation) => annotation.annotationType === "discourse-segment")).toHaveLength(2);
    expect(annotations.find((annotation) => annotation.id === "mention-hero-opening")).not.toHaveProperty("entityId");
    await expect(new CanonicalModelStore(root).listEntities()).resolves.toEqual([]);
    await expect(new ProposalStore(root).list("pending")).resolves.toEqual([]);

    const structure = await new SourceStructureStore(root).read(fixture.source.id);
    expect(baseStructuralUnits(structure!).map((unit) => unit.id)).toEqual(initialOrder);
    await expect(new SourceAccountingStore(root).summarize(structure!)).resolves.toMatchObject({
      blockingUnits: 0,
      unitCoverage: 1,
      byteCoverage: 1,
    });
    await expect(auditCompiler(root, { sourceId: fixture.source.id })).resolves.toMatchObject({
      observations: {
        entityMentions: 2,
        quotations: 1,
        discourseSegments: 2,
        pendingAnnotations: 0,
        invalidAnchors: 0,
      },
      coverage: { entityResolution: 0 },
      readiness: { resolution: "not-ready" },
    });

    const find = toolset.tools.find((tool) => tool.name === "find_source_annotations")!;
    const found = await find.execute("find-annotations", {
      query: "*",
      annotation_type: "quotation",
    } as never, undefined, undefined, context);
    expect(JSON.parse(resultText(found))).toMatchObject({
      sourceId: fixture.source.id,
      returned: 1,
      results: [{ ref: "committed:quote-wait", annotationType: "quotation" }],
    });

    const removal = await removeNovelAnalysis(root, fixture.source);
    expect(removal.sourceObservations).toBe(true);
    await expect(new SourceAnnotationStore(root).list(fixture.source.id)).resolves.toEqual([]);
  });

  it("rejects dangling mention and scene references before observations become current", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-annotation-closure-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, '"Go," someone said.\n');
    const batchId = `batch-${fixture.source.id}-dangling`;
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([fixture.segmentId], batchId, fixture.source.id);
    const quotation = toolset.tools.find((tool) => tool.name === "propose_quotation")!;
    const finish = toolset.tools.find((tool) => tool.name === "finish_compiler_batch")!;
    const withdraw = toolset.tools.find((tool) => tool.name === "withdraw_compiler_proposal")!;

    await quotation.execute("dangling-quote", {
      proposal_id: "proposal-dangling-quote",
      annotation_id: "quote-go",
      selector: { segment_id: fixture.segmentId, exact: '"Go,"' },
      mode: "direct",
      speaker_mention_id: "mention-missing-speaker",
      addressee_mention_ids: [],
      scene_id: "scene-missing",
      attribution_confidence: 0.2,
    } as never, undefined, undefined, context);
    await expect(finish.execute("finish-dangling", {
      outcome: "complete",
      reviewed_segments: [{ segment_id: fixture.segmentId, disposition: "proposed", summary: "Quotation needs reference closure." }],
      summary: "Attempt closure.",
    } as never, undefined, undefined, context)).rejects.toThrow(/unknown annotation 'scene-missing'.*unknown annotation 'mention-missing-speaker'/s);
    await expect(new SourceAnnotationStore(root).list(fixture.source.id)).resolves.toEqual([]);
    await expect(withdraw.execute("withdraw-dangling", {
      proposal_id: "proposal-dangling-quote",
      reason: "Speaker and scene observations are absent from this bounded evidence.",
    } as never, undefined, undefined, context)).resolves.toMatchObject({
      details: { compilerProposalWithdrawn: true },
    });
    await expect(new SourceAnnotationStore(root).listProposals(fixture.source.id, "rejected"))
      .resolves.toContainEqual(expect.objectContaining({ id: "proposal-dangling-quote" }));
  });

  it("disambiguates repeated surface forms and recovers staged annotations after a process restart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-annotation-recovery-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "He waits. He leaves.\n");
    const batchId = `batch-${fixture.source.id}-recovery`;
    const first = createCompilerProposalToolset(root);
    await first.beginBatch([fixture.segmentId], batchId, fixture.source.id);
    const mention = first.tools.find((tool) => tool.name === "propose_entity_mention")!;
    const ambiguous = {
      proposal_id: "proposal-he-second",
      annotation_id: "mention-he-second",
      selector: { segment_id: fixture.segmentId, exact: "He" },
      surface: "He",
      form: "pronoun",
      kind_candidates: ["character"],
      confidence: 0.7,
      interpretation: "The second pronoun continues the locally salient actor.",
    };
    await expect(mention.execute("ambiguous", ambiguous as never, undefined, undefined, context))
      .rejects.toThrow("ambiguous");
    await mention.execute("second", {
      ...ambiguous,
      selector: { ...ambiguous.selector, occurrence: 2 },
    } as never, undefined, undefined, context);

    const retry = createCompilerProposalToolset(root);
    await retry.beginBatch([fixture.segmentId], batchId, fixture.source.id);
    const finish = retry.tools.find((tool) => tool.name === "finish_compiler_batch")!;
    await expect(finish.execute("finish-recovered", {
      outcome: "complete",
      reviewed_segments: [{ segment_id: fixture.segmentId, disposition: "proposed", summary: "Recovered the second pronoun observation." }],
      summary: "Recovered the exact pending annotation.",
    } as never, undefined, undefined, context)).resolves.toMatchObject({
      details: { proposalIds: ["proposal-he-second"] },
    });
    await expect(new SourceAnnotationStore(root).read(fixture.source.id, "mention-he-second"))
      .resolves.toMatchObject({ surface: "He", anchor: { startByte: 10 } });
  });

  it("pages exact annotation payloads and restores the prior revision when a committed batch is rejected", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-annotation-revisions-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "A memory returns.\n");
    const store = new SourceAnnotationStore(root);
    const firstBatch = `batch-${fixture.source.id}-revision-one`;
    const first = createCompilerProposalToolset(root);
    await first.beginBatch([fixture.segmentId], firstBatch, fixture.source.id);
    const firstDiscourse = first.tools.find((tool) => tool.name === "propose_discourse_segment")!;
    await firstDiscourse.execute("first-memory", {
      proposal_id: "proposal-memory-one",
      annotation_id: "memory-observation",
      kind: "recollection",
      selectors: [{ segment_id: fixture.segmentId, exact: "A memory returns." }],
      confidence: 0.5,
      interpretation: "x".repeat(1_000),
    } as never, undefined, undefined, context);
    await finishOnly(first, fixture.segmentId, "first revision");

    const find = first.tools.find((tool) => tool.name === "find_source_annotations")!;
    const read = first.tools.find((tool) => tool.name === "read_source_annotation")!;
    const found = JSON.parse(resultText(await find.execute("find-memory", {
      query: "memory-observation",
    } as never, undefined, undefined, context))) as { results: Array<{ ref: string }> };
    const pageOne = JSON.parse(resultText(await read.execute("read-page-one", {
      ref: found.results[0]!.ref,
      max_chars: 1_000,
    } as never, undefined, undefined, context))) as { nextOffset: number; chunk: string };
    expect(pageOne.nextOffset).toBe(1_000);
    expect(pageOne.chunk).toHaveLength(1_000);
    const pageTwo = JSON.parse(resultText(await read.execute("read-page-two", {
      ref: found.results[0]!.ref,
      offset: pageOne.nextOffset,
      max_chars: 1_000,
    } as never, undefined, undefined, context))) as { nextOffset?: number; chunk: string };
    expect(pageTwo.chunk.length).toBeGreaterThan(0);
    expect(pageTwo.nextOffset).toBeUndefined();

    const secondBatch = `batch-${fixture.source.id}-revision-two`;
    const second = createCompilerProposalToolset(root);
    await second.beginBatch([fixture.segmentId], secondBatch, fixture.source.id);
    const secondDiscourse = second.tools.find((tool) => tool.name === "propose_discourse_segment")!;
    await secondDiscourse.execute("second-memory", {
      proposal_id: "proposal-memory-two",
      annotation_id: "memory-observation",
      kind: "recollection",
      selectors: [{ segment_id: fixture.segmentId, exact: "A memory returns." }],
      confidence: 0.9,
      interpretation: "The narration explicitly presents remembered material.",
    } as never, undefined, undefined, context);
    await finishOnly(second, fixture.segmentId, "second revision");
    await expect(store.read(fixture.source.id, "memory-observation")).resolves.toMatchObject({ confidence: 0.9 });

    await expect(store.rejectBatch(secondBatch)).resolves.toEqual(["proposal-memory-two"]);
    await expect(store.read(fixture.source.id, "memory-observation")).resolves.toMatchObject({ confidence: 0.5 });
    await expect(store.listProposals(fixture.source.id, "rejected"))
      .resolves.toContainEqual(expect.objectContaining({ id: "proposal-memory-two" }));
  });
});

async function finishOnly(
  toolset: ReturnType<typeof createCompilerProposalToolset>,
  segmentId: string,
  summary: string,
): Promise<void> {
  const finish = toolset.tools.find((tool) => tool.name === "finish_compiler_batch")!;
  await finish.execute(`finish-${summary}`, {
    outcome: "complete",
    reviewed_segments: [{ segment_id: segmentId, disposition: "proposed", summary }],
    summary,
  } as never, undefined, undefined, context);
}

function resultText(result: { content: readonly unknown[] }): string {
  const first = result.content[0] as { type?: string; text?: string } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string") throw new Error("Expected a text tool result.");
  return first.text;
}

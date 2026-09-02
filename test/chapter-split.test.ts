import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildChapterStructureSample,
  ChapterSplitPlanStore,
  evaluateChapterSplitPlan,
} from "../src/compiler/chapter-split.js";
import { prepareCompilerBatches, runCompilerBatches, selectOpeningCompilerBatch } from "../src/compiler/batches.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(options: { preamble?: string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-chapter-split-"));
  roots.push(root);
  const chapters = Array.from({ length: 6 }, (_, chapter) => [
    `:: ${chapter + 1} :: Author title ${chapter + 1}`,
    "",
    ...Array.from({ length: 220 }, (_, line) =>
      `Narrative sentence for chapter ${chapter + 1}, line ${line + 1}, with enough text to make this a novel-sized source.`),
    "",
  ].join("\n"));
  const content = `${options.preamble ? `${options.preamble}\n\n` : ""}${chapters.join("\n")}`;
  const absolute = path.join(root, "novel.txt");
  await fs.writeFile(absolute, content, "utf8");
  const workspace = await WorkspaceStore.create(root);
  const source = await workspace.registerSource(absolute);
  return { root, source };
}

describe("agentic chapter split discovery", () => {
  it("validates a sampled declarative rule and commits it only with the finish handshake", async () => {
    const { root, source } = await fixture();
    const preliminary = await prepareCompilerBatches(root, source);
    expect(preliminary[0]).toMatchObject({ purpose: "structure-discovery", segmentIds: [] });
    expect(preliminary.filter((batch) => batch.purpose === "source-review").length).toBeGreaterThan(1);
    expect((await new SegmentStore(root).list(source.id)).every((segment) => segment.kind === "block")).toBe(true);

    const sample = await buildChapterStructureSample(root, source);
    const examples = sample.lines
      .filter((line) => /^:: [12] ::/u.test(line.text) && !line.truncated)
      .slice(0, 2)
      .map(({ line, text }) => ({ line, text }));
    expect(examples).toHaveLength(2);

    const toolset = createCompilerProposalToolset(root, { provider: "test", model: "structure-model" });
    await toolset.beginBatch([], preliminary[0]!.id, source.id);
    const configure = toolset.tools.find((tool) => tool.name === "configure_chapter_split")!;
    const finish = toolset.tools.find((tool) => tool.name === "finish_compiler_batch")!;
    await expect(configure.execute("configure", {
      mode: "custom",
      rule: {
        prefix: ":: ",
        number_style: "arabic",
        suffix: " ::",
        case_sensitive: true,
        allow_leading_whitespace: false,
        allow_trailing_text: true,
      },
      examples,
      reason: "The sampled author headings repeat one literal numbered form.",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { compilerChapterSplitConfigured: true, mode: "custom", headingCount: 6 },
    });

    await expect(new ChapterSplitPlanStore(root).read(source.id)).resolves.toBeNull();
    await expect(finish.execute("finish", {
      outcome: "no-artifacts",
      reviewed_segments: [],
      summary: "Validated the author chapter structure.",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { compilerBatchFinished: true, outcome: "no-artifacts" },
    });

    await expect(new ChapterSplitPlanStore(root).read(source.id)).resolves.toMatchObject({
      mode: "custom",
      rule: { prefix: ":: ", suffix: " ::", numberStyle: "arabic" },
      generatedBy: { provider: "test", model: "structure-model" },
    });
    const regenerated = await prepareCompilerBatches(root, source);
    expect(regenerated[0]!.id).toBe(preliminary[0]!.id);
    expect(regenerated[0]!.prompt).toContain("checkpoint-recovery turn");
    expect(regenerated[0]!.prompt).toContain("<current-chapter-split-plan>");
    const sourceBatches = regenerated.filter((batch) => batch.purpose === "source-review");
    expect(sourceBatches).toHaveLength(18);
    for (const stage of ["observation", "semantic", "executable"] as const) {
      const stageBatches = sourceBatches.filter((batch) => batch.semanticStage === stage);
      expect(stageBatches.map((batch) => batch.chapterOrdinal)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(stageBatches.map((batch) => batch.chapterTitle)).toEqual([
        ":: 1 :: Author title 1",
        ":: 2 :: Author title 2",
        ":: 3 :: Author title 3",
        ":: 4 :: Author title 4",
        ":: 5 :: Author title 5",
        ":: 6 :: Author title 6",
      ]);
    }

    const recovery = createCompilerProposalToolset(root);
    await recovery.beginBatch([], regenerated[0]!.id, source.id);
    const recoveryFinish = recovery.tools.find((tool) => tool.name === "finish_compiler_batch")!;
    await expect(recoveryFinish.execute("recovery-finish", {
      outcome: "no-artifacts",
      reviewed_segments: [],
      summary: "Recovered the already validated chapter plan.",
    } as never, undefined, undefined, {} as ExtensionContext)).resolves.toMatchObject({
      details: { compilerBatchFinished: true },
    });
  });

  it("cannot finish or persist structure discovery without a validated decision", async () => {
    const { root, source } = await fixture();
    const discovery = (await prepareCompilerBatches(root, source))[0]!;
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([], discovery.id, source.id);
    const finish = toolset.tools.find((tool) => tool.name === "finish_compiler_batch")!;

    await expect(finish.execute("finish", {
      outcome: "no-artifacts",
      reviewed_segments: [],
      summary: "No decision.",
    } as never, undefined, undefined, {} as ExtensionContext)).rejects.toThrow("configure_chapter_split");
    await expect(new ChapterSplitPlanStore(root).read(source.id)).resolves.toBeNull();
  });

  it("does not checkpoint a custom runner that skips the required structure decision", async () => {
    const { root, source } = await fixture();

    await expect(runCompilerBatches({
      workspaceRoot: root,
      source,
      maxBatches: 1,
      async runner() {},
    })).rejects.toThrow("did not commit a validated split plan");
  });

  it("selects the first custom author chapter rather than publication front matter for the opening", async () => {
    const { root, source } = await fixture({ preamble: "Collected edition\nPublication metadata" });
    const sample = await buildChapterStructureSample(root, source);
    const examples = sample.lines
      .filter((line) => /^:: [12] ::/u.test(line.text) && !line.truncated)
      .slice(0, 2)
      .map(({ line, text }) => ({ line, text }));
    const evaluation = await evaluateChapterSplitPlan(root, source, {
      mode: "custom",
      rule: {
        prefix: ":: ",
        numberStyle: "arabic",
        suffix: " ::",
        caseSensitive: true,
        allowLeadingWhitespace: false,
        allowTrailingText: true,
      },
      examples,
      reason: "The repeated sampled lines are author chapter headings.",
    }, { compilerBatchId: `structure-${source.id}-v1` });
    await new ChapterSplitPlanStore(root).write(evaluation.plan);

    const batches = await prepareCompilerBatches(root, source);
    const sourceBatches = batches.filter((batch) => batch.purpose === "source-review");
    expect(sourceBatches[0]).toMatchObject({ chapterTitle: "Collected edition" });
    expect(sourceBatches[1]).toMatchObject({
      chapterTitle: ":: 1 :: Author title 1",
      authorChapterHeading: true,
    });
    expect(selectOpeningCompilerBatch(batches)?.id).toBe(
      sourceBatches.find((batch) => batch.semanticStage === "executable" && batch.authorChapterHeading)?.id,
    );
  });
});

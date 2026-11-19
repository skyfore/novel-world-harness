import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import { runPipeline } from "../../src/compiler/pipeline/compile.js";
import { loadPipelineView, measureView } from "../../src/compiler/pipeline/view.js";
import { bellTowerAgent, pipelineWorkspace } from "./fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe("pipeline end to end", () => {
  it("compiles the synthetic fixture from empty through closure with a scripted model", async () => {
    const workspace = await pipelineWorkspace();
    cleanups.push(workspace.cleanup);
    const agent = bellTowerAgent();
    const result = await runPipeline({ root: workspace.root, source: workspace.source, agent, generatedBy: { provider: "test", model: "scripted" } });
    expect(result.stages.flatMap((stage) => stage.held)).toEqual([]);
    expect(result.closure.issues).toEqual([]);
    expect(result.closure.passed).toBe(true);
    const report = measureView(await loadPipelineView(workspace.root, workspace.source.id));
    expect(report.summary.gap).toBe(0);
    expect(agent.runs.map((run) => run.stage)).toEqual(expect.arrayContaining(["census", "observation", "identity", "scenes", "world", "roster", "opening"]));
    // A second run is a no-op: every scope's gate still passes, no model call is made.
    const before = agent.runs.length;
    const again = await runPipeline({ root: workspace.root, source: workspace.source, agent });
    expect(agent.runs.length).toBe(before);
    expect(again.closure.passed).toBe(true);
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { heuristicAgent } from "./fixture.js";

describe("pipeline end to end on the representative micro novels", () => {
  const corpus = path.resolve("fixtures/corpus/representative");
  for (const work of ["glass-ledger", "ash-court", "tide-alliance"]) {
    it(`runs the whole chain on ${work} and closes honestly`, async () => {
      const text = await fs.readFile(path.join(corpus, `${work}.zh-CN.txt`), "utf8");
      const gold = JSON.parse(await fs.readFile(path.join(corpus, "gold.v2.json"), "utf8")) as { semantic: { mentions: Array<{ kind: string; type?: string; span: { sourceId: string; startByte: number; endByte: number } }> } };
      const bytes = Buffer.from(text);
      const surfaces: Record<string, "person" | "location" | "object"> = {};
      for (const mention of gold.semantic.mentions) {
        if (mention.span.sourceId !== `${work}-zh` || !["entity", "place"].includes(mention.kind)) continue;
        const cls = mention.type === "character" ? "person" : mention.type === "location" ? "location" : mention.type === "artifact" ? "object" : undefined;
        if (cls) surfaces[bytes.subarray(mention.span.startByte, mention.span.endByte).toString("utf8")] = cls;
      }
      const workspace = await pipelineWorkspace(text);
      cleanups.push(workspace.cleanup);
      const result = await runPipeline({ root: workspace.root, source: workspace.source, agent: heuristicAgent(surfaces) });
      // The chain never stops on a held scope; every stage ran.
      expect(result.stages.map((stage) => stage.stage)).toEqual(["census", "observation", "identity", "scenes", "world", "roster", "opening"]);
      expect(result.stages.find((stage) => stage.stage === "observation")!.held).toEqual([]);
      const receipts = await (await import("../../src/compiler/pipeline/store.js")).PipelineStore.prototype.receipts.call(new (await import("../../src/compiler/pipeline/store.js")).PipelineStore(workspace.root, workspace.source.id));
      expect(receipts.filter((item) => item.stage === "identity" && item.status === "held").map((item) => [item.error, item.gate?.checks.filter((check) => !check.passed)])).toEqual([]);
      expect(result.stages.find((stage) => stage.stage === "identity")!.held).toEqual([]);
      // Closure is honest: it passes only with no issue, and every issue names a measure gap, a held scope or an unexplained unknown.
      expect(result.closure.passed).toBe(result.closure.issues.length === 0);
      for (const issue of result.closure.issues) expect(issue).toMatch(/^(?:gap |scope .* held|unknown .* without a reason)/u);
      const report = measureView(await loadPipelineView(workspace.root, workspace.source.id));
      expect(report.measures.find((item) => item.id === "observation.speech-annotated")!.status).toMatch(/satisfied|unknown/u);
      expect(report.measures.find((item) => item.id === "identity.mentions-resolved")!.status).toBe("satisfied");
    });
  }
});

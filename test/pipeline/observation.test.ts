import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import { censusCandidates, censusStage } from "../../src/compiler/pipeline/census.js";
import { observationStage, openCandidates } from "../../src/compiler/pipeline/observation.js";
import { releaseHeldScope, runStage } from "../../src/compiler/pipeline/runner.js";
import { loadPipelineView, measureView } from "../../src/compiler/pipeline/view.js";
import { must, observationScript, pipelineWorkspace, stageContext, unitsOf } from "./fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const census = stageContext.bind(null);
const classes: Record<string, string> = { 林岐: "person", 墨砚: "person", 钟楼: "location", 银钥: "object" };

async function runCensus(root: string, sourceId: string) {
  const ctx = census(root, sourceId, async (input, call) => {
    const ids = [...input.prompt.matchAll(/^(c-[a-f0-9]+) \| ([^|]+) \|/gmu)].map((match) => ({ candidate: match[1]!, class: classes[match[2]!.trim()] ?? "non-entity", rationale: "Test classification." }));
    await must(call, "classify_census_candidates", { items: ids });
    await must(call, "finish_scope", {});
  });
  return { ctx, summary: await runStage(censusStage, ctx) };
}

describe("pipeline census and observation", () => {
  it("proposes speaker-position names and gates on their classification", async () => {
    const workspace = await pipelineWorkspace();
    cleanups.push(workspace.cleanup);
    const view = await loadPipelineView(workspace.root, workspace.source.id);
    const candidates = censusCandidates(view.bytes);
    expect(new Set(candidates.filter((item) => item.required).map((item) => item.surface))).toEqual(new Set(["林岐", "墨砚"]));
    // Counterexample: an agent that classifies nothing never passes the gate.
    const idle = census(workspace.root, workspace.source.id, async () => undefined);
    const held = await runStage(censusStage, idle);
    expect(held.held).toHaveLength(1);
    expect((await idle.store.receipts())[0]).toMatchObject({ status: "held", attempts: 2 });
    expect((await idle.store.receipts())[0]!.gate!.checks.find((check) => check.id === "census.required-classified")!.passed).toBe(false);
  });

  it("reviews every host candidate in a window and refuses to finish while one is skipped", async () => {
    const workspace = await pipelineWorkspace();
    cleanups.push(workspace.cleanup);
    const { summary } = await runCensus(workspace.root, workspace.source.id);
    expect(summary.completed).toHaveLength(1);
    let skip = true;
    const ctx = stageContext(workspace.root, workspace.source.id, async (input, call) => {
      const lines = unitsOf(input.prompt);
      // A unit holding an unrejected candidate cannot be closed as background.
      const speechUnit = lines.find((line) => line.text.startsWith("“第七声钟"))!;
      expect((await call("account_units", { items: [{ unit: speechUnit.unit, status: "background-only", rationale: "Try to hide it." }] })).details).toMatchObject({ accounted: [], failed: [{ index: 0 }] });
      await observationScript({ skipFirstSpeech: () => skip })(input, call);
    });
    const first = await runStage(observationStage, ctx, { maxAttempts: 1 });
    expect(first.held).toHaveLength(1);
    const receipt = (await ctx.store.receipts()).find((item) => item.stage === "observation")!;
    expect(receipt.error).toBeUndefined();
    expect(receipt.gate!.checks.filter((check) => !check.passed).map((check) => check.id)).toEqual(["observation.candidates-reviewed", "observation.speech-annotated", "source.blocking-units"]);

    // Release and redo with the full review: the same gate now passes.
    await releaseHeldScope(ctx.store, receipt.id);
    skip = false;
    const second = await runStage(observationStage, ctx);
    expect(second.completed).toEqual([receipt.id]);
    const view = await loadPipelineView(workspace.root, workspace.source.id);
    expect(openCandidates(view, receipt.range)).toEqual([]);
    const report = measureView(view);
    const byId = new Map(report.measures.map((item) => [item.id, item]));
    expect(byId.get("observation.speech-annotated")).toMatchObject({ numerator: 7, total: 7, status: "satisfied" });
    expect(byId.get("observation.names-annotated")!.status).toBe("satisfied");
    expect(byId.get("source.hidden-units")!.numerator).toBe(0);
    const quotations = view.bundle.compilerSnapshot.annotations.filter((item) => item.annotationType === "quotation");
    expect(quotations.every((item) => item.annotationType === "quotation" && item.speakerMentionId)).toBe(true);
    expect(quotations[0]!.derivation.worker).toBe("host-lexical-v1");
  });
});

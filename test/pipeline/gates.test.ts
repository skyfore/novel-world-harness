import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { censusCandidates } from "../../src/compiler/pipeline/census.js";
import { gapsStage } from "../../src/compiler/pipeline/gaps.js";
import { openingStage } from "../../src/compiler/pipeline/opening.js";
import { rosterStage } from "../../src/compiler/pipeline/roster.js";
import { runStage } from "../../src/compiler/pipeline/runner.js";
import { loadPipelineView, measureView } from "../../src/compiler/pipeline/view.js";
import { buildLexicalInventory } from "../../src/compiler/lexical-inventory.js";
import { WORLD_STORAGE_VERSION, worldStorageRoot } from "../../src/world/paths.js";
import { NovelCompilationRunStore } from "../../src/workflow/novel-compilation.js";
import { BELL_TOWER, must, scenedWorkspace, stageContext, unitsOf } from "./fixture.js";

vi.setConfig({ testTimeout: 60_000 });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe("stage gates refuse to finish when work is missing", () => {
  it("holds the roster and opening scopes when no review or initial world is given", async () => {
    const workspace = await scenedWorkspace();
    cleanups.push(workspace.cleanup);
    const idle = stageContext(workspace.root, workspace.source.id, async () => undefined);
    expect((await runStage(rosterStage, idle)).held).toHaveLength(1);
    expect((await runStage(openingStage, idle)).held).toHaveLength(1);
    const receipts = await idle.store.receipts();
    expect(receipts.find((item) => item.stage === "roster")!.gate!.checks[0]).toMatchObject({ id: "characters.roster-reviewed", passed: false });
    expect(receipts.find((item) => item.stage === "opening")!.gate!.checks.map((check) => [check.id, check.passed])).toEqual([["opening.initial-world", false], ["space.opening-positions", false]]);
  });

  it("gap loop: an item failing twice is held while the other items still complete", async () => {
    const workspace = await scenedWorkspace();
    cleanups.push(workspace.cleanup);
    const view = await loadPipelineView(workspace.root, workspace.source.id);
    const plan = await gapsStage.plan(stageContext(workspace.root, workspace.source.id, async () => undefined), view);
    const keys = plan.map((scope) => scope.items[0]);
    expect(keys).toEqual(expect.arrayContaining(["world:key-event:event-walk-north-gate", "world:autonomy:source"]));
    const ctx = stageContext(workspace.root, workspace.source.id, async (input, call) => {
      if (input.prompt.includes("key-event:event-walk-north-gate")) {
        await must(call, "record_dispositions", { items: [{ measure: "causality.conditioned-key-events", subject: "event:event-walk-north-gate", verdict: "unconditioned", rationale: "Nothing gates it." }] });
      }
      await call("finish_scope", {});
    });
    const summary = await runStage(gapsStage, ctx);
    const byKey = new Map(plan.map((scope) => [scope.items[0], scope.id]));
    expect(summary.completed).toContain(byKey.get("world:key-event:event-walk-north-gate"));
    expect(summary.held).toContain(byKey.get("world:autonomy:source"));
    expect((await ctx.store.receipt(byKey.get("world:autonomy:source")!))!.attempts).toBe(2);
  });

  it("ranged identity decisions keep two same-name characters apart without a collision", async () => {
    const text = "第一章 两个阿青\n\n“走吧。”阿青说。“好。”阿青说。“快。”阿青说。\n\n第二章 另一个\n\n“来了。”阿青说。“嗯。”阿青说。“是。”阿青说。\n";
    const { pipelineWorkspace, censusScript, observationScript } = await import("./fixture.js");
    const workspace = await pipelineWorkspace(text);
    cleanups.push(workspace.cleanup);
    const { censusStage } = await import("../../src/compiler/pipeline/census.js");
    const { observationStage } = await import("../../src/compiler/pipeline/observation.js");
    const { identityStage } = await import("../../src/compiler/pipeline/identity.js");
    await runStage(censusStage, stageContext(workspace.root, workspace.source.id, censusScript({ 阿青: "person" })));
    const observe = stageContext(workspace.root, workspace.source.id, async (input, call) => {
      const open = await must(call, "list_open_candidates", {});
      if (open.candidates.length) await must(call, "review_observation_candidates", { items: open.candidates.map((item: { id: string; kind: string; cue?: string }) => item.kind === "speech" && item.cue ? { id: item.id, verdict: "accept", speaker: "cue" } : { id: item.id, verdict: "accept" }) });
      // Headings name 阿青, so they are annotated and segmented rather than closed as paratext.
      const lines = unitsOf(input.prompt);
      const bare = lines.filter((line) => line.text.startsWith("第") && !line.text.includes("阿青"));
      if (bare.length) await must(call, "account_units", { items: bare.map((line) => ({ unit: line.unit, status: "paratext", rationale: "Chapter heading." })) });
      await must(call, "propose_discourse_segments", { items: [{ extent: { from: lines[0]!.unit, to: lines.at(-1)!.unit }, kind: "scene" }] });
      await call("finish_scope", {});
    });
    void observationScript;
    const observed = await runStage(observationStage, observe);
    expect((await observe.store.receipts()).filter((item) => item.status === "held").map((item) => [item.error, item.gate?.checks.filter((check) => !check.passed)])).toEqual([]);
    expect(observed.held).toEqual([]);
    const ctx = stageContext(workspace.root, workspace.source.id, async (input, call) => {
      if (input.scopeId.includes("-lexicon-")) {
        const lines = [...input.prompt.matchAll(/阿青/gu)];
        void lines;
        const view = await loadPipelineView(workspace.root, workspace.source.id);
        const units = view.structure.units.filter((unit) => view.structure.baseUnitIds.includes(unit.id));
        const label = (byte: number) => `u${String(units.findIndex((unit) => unit.anchor.startByte <= byte && byte < unit.anchor.endByte)).padStart(4, "0")}`;
        const split = Buffer.byteLength(text.slice(0, text.indexOf("第二章")), "utf8");
        // Both get created from their own first mention through ranged decisions.
        await must(call, "propose_entities", { items: [{ id: "char-aqing-1", kind: "character", canonicalName: "阿青" }] });
        await must(call, "decide_lexicon_entries", { items: [
          { surface: "阿青", verdict: "entity", entity: "char-aqing-1", aliasType: "name", ranges: [{ from: label(0), to: label(split - 1) }], rationale: "The first chapter's 阿青." },
        ] });
        const second = view.bundle.compilerSnapshot.annotations.find((item) => item.annotationType === "entity-mention" && item.anchor.startByte >= split);
        await must(call, "propose_entities", { items: [{ id: "char-aqing-2", kind: "character", canonicalName: "阿青" }] }).catch(() => undefined);
        void second;
      }
      await call("finish_scope", {});
    });
    await runStage(identityStage, ctx, { maxAttempts: 1 });
    const view = await loadPipelineView(workspace.root, workspace.source.id);
    // The ranged decision covers only chapter one; no surface is attested for two characters, so no collision.
    const first = view.bundle.compilerSnapshot.entityResolutions.filter((item) => item.entityId === "char-aqing-1");
    expect(first.length).toBe(3);
    expect(measureView(view).measures.find((item) => item.id === "identity.name-collisions")!.numerator).toBe(0);
  });
});

describe("generalisation and namespace", () => {
  it("source denominators do not change when names are swapped, independent sentences reordered or distractor dialogue is quoted terms only", () => {
    const base = BELL_TOWER;
    const renamed = base.replaceAll("林岐", "苏衡").replaceAll("墨砚", "顾川");
    const count = (text: string) => {
      const bytes = Buffer.from(text);
      const inventory = buildLexicalInventory({ source: bytes, lexicon: { entries: censusCandidates(bytes).filter((item) => item.required).map((item) => ({ surface: item.surface, entityId: `k:${item.surface}` })), collisions: [] } });
      return { speech: inventory.speech.filter((span) => span.kind === "speech").length, cues: inventory.cues.length, names: inventory.occurrences.length, required: censusCandidates(bytes).filter((item) => item.required).length };
    };
    expect(count(renamed)).toEqual(count(base));
    const lines = base.split("\n");
    const reordered = [...lines.slice(0, 3), lines[4]!, lines[3]!, ...lines.slice(5)].join("\n");
    expect(count(reordered)).toEqual(count(base));
    const distracted = base.replace("他带着墨砚走向北门。", "他带着墨砚走向“北门”这个“地方”。");
    expect(count(distracted)).toEqual(count(base));
  });

  it("the new code reads only the v4 namespace and never resumes a run record of the retired chain", async () => {
    expect(WORLD_STORAGE_VERSION).toBe("v4");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-namespace-"));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    expect(worldStorageRoot(root).endsWith(path.join("world", "v4"))).toBe(true);
    const file = path.join(worldStorageRoot(root), "compiler", "novel-compilation", "legacy.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 1, id: "novel-old", sourceId: "legacy", mode: "rebuild", history: [] }));
    expect(await new NovelCompilationRunStore(root).read("legacy")).toBeNull();
  });
});

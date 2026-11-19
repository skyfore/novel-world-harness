import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 90_000 });
import { ScriptedStageAgent } from "../../src/compiler/pipeline/agent.js";
import { censusStage } from "../../src/compiler/pipeline/census.js";
import { gapItems, gapsStage } from "../../src/compiler/pipeline/gaps.js";
import { continuableSegments, observationStage, observationWindows, openCandidates } from "../../src/compiler/pipeline/observation.js";
import { rosterStage } from "../../src/compiler/pipeline/roster.js";
import { gateOf, releaseHeldScopes, runStage, type StageDefinition } from "../../src/compiler/pipeline/runner.js";
import { scenesStage } from "../../src/compiler/pipeline/scenes.js";
import { loadPipelineView, measureView } from "../../src/compiler/pipeline/view.js";
import { worldStage } from "../../src/compiler/pipeline/world.js";
import { BELL_TOWER, censusScript, identifiedWorkspace, must, observationScript, pipelineWorkspace, scenedWorkspace, stageContext, unitsOf, worldScript } from "./fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const failing = (checks: Array<{ id: string; passed: boolean }> | undefined) => (checks ?? []).filter((check) => !check.passed).map((check) => check.id);

describe("stage gates refuse the remaining design counterexamples", () => {
  it("observation: one skipped name occurrence keeps the window open", async () => {
    const workspace = await pipelineWorkspace();
    cleanups.push(workspace.cleanup);
    await runStage(censusStage, stageContext(workspace.root, workspace.source.id, censusScript()));
    // Review every candidate but one name occurrence, then do the rest of the window's work.
    const skipping = stageContext(workspace.root, workspace.source.id, async (input, call) => {
      const open = await must(call, "list_open_candidates", {});
      const skipped = open.candidates.find((item: { kind: string }) => item.kind === "name").id;
      await must(call, "review_observation_candidates", { items: open.candidates.filter((item: { id: string }) => item.id !== skipped)
        .map((item: { id: string; kind: string; cue?: string }) => ({ id: item.id, verdict: "accept", ...(item.kind === "speech" && item.cue ? { speaker: "cue" } : {}) })) });
      await call("finish_scope", {});
    });
    const held = await runStage(observationStage, skipping, { maxAttempts: 1 });
    expect(held.held).toHaveLength(1);
    const receipt = (await skipping.store.receipts()).find((item) => item.stage === "observation")!;
    expect(failing(receipt.gate!.checks)).toEqual(expect.arrayContaining(["observation.candidates-reviewed", "observation.names-annotated"]));
  });

  it("scenes: a scene without a location or a reasoned unknown is refused and the scope is held", async () => {
    const workspace = await identifiedWorkspace();
    cleanups.push(workspace.cleanup);
    const ctx = stageContext(workspace.root, workspace.source.id, async (_input, call) => {
      const refused = await call("propose_scene", { present: ["char-lin-qi"] });
      expect(refused.ok).toBe(false);
      expect(refused.text).toMatch(/location or locationUnknown/u);
      await call("finish_scope", {});
    });
    const summary = await runStage(scenesStage, ctx, { maxAttempts: 1 });
    expect(summary.held).toHaveLength(1);
    expect(failing((await ctx.store.receipts()).find((item) => item.stage === "scenes")!.gate!.checks)).toContain("scenes.record");
  });

  it("world: a key event without a condition or a reviewed \"unconditioned\" keeps its scope open", async () => {
    const workspace = await scenedWorkspace();
    cleanups.push(workspace.cleanup);
    const answerAllButKeyEvents = worldScript();
    const ctx = stageContext(workspace.root, workspace.source.id, async (input, call) => {
      if (input.prompt.includes("key-event:")) { await call("finish_scope", {}); return; }
      await answerAllButKeyEvents(input, call);
    });
    const summary = await runStage(worldStage, ctx, { maxAttempts: 1 });
    const held = (await ctx.store.receipts()).filter((item) => item.status === "held");
    expect(held.map((item) => item.items)).toEqual([["key-event:event-walk-north-gate"]]);
    expect(held[0]!.gate!.checks[0]).toMatchObject({ id: "world.items-answered", passed: false, detail: "open: key-event:event-walk-north-gate" });
    expect(summary.completed.length).toBeGreaterThan(0);
  });
});

describe("held scopes and host review", () => {
  it("releases held scopes by stage with the review note kept on the receipt, then reattempts them", async () => {
    const workspace = await pipelineWorkspace();
    cleanups.push(workspace.cleanup);
    const idle = stageContext(workspace.root, workspace.source.id, async () => undefined);
    const held = await runStage(censusStage, idle);
    expect(held.held).toHaveLength(1);
    // A rerun skips a held scope until the host releases it.
    expect((await runStage(censusStage, idle)).held).toEqual(held.held);
    expect(idle.agent.runs).toHaveLength(2);
    await expect(releaseHeldScopes(idle.store, { scopeIds: ["census-nope"] })).rejects.toThrow(/Not held/u);
    await expect(releaseHeldScopes(idle.store, {})).rejects.toThrow(/--scope/u);
    expect(await releaseHeldScopes(idle.store, { stage: "census" }, "Classified the speaker surfaces by hand review.")).toEqual(held.held);
    const receipt = (await idle.store.receipts())[0]!;
    expect(receipt).toMatchObject({ status: "running", attempts: 0, releases: [{ attempts: 2, note: "Classified the speaker surfaces by hand review." }] });
    const done = await runStage(censusStage, stageContext(workspace.root, workspace.source.id, censusScript()));
    expect(done.completed).toEqual(held.held);
  });
});

describe("scenes across observation windows", () => {
  const PATTERNS = [(n: number) => `林岐沿着第${n}条小路慢慢往前走。`, (n: number) => `风吹过来，林岐停下脚步，数到${n}。`, (n: number) => `林岐看见第${n}棵树。`, (n: number) => `雨落在林岐的肩上，${n}滴。`];
  const LONG = ["第一章 小路", "", ...Array.from({ length: 420 }, (_, index) => PATTERNS[index % PATTERNS.length]!(index + 1)), ""].join("\n");

  it("continues a segment across the 16 KiB window boundary so the scene stays one scene", async () => {
    const workspace = await pipelineWorkspace(LONG);
    cleanups.push(workspace.cleanup);
    await runStage(censusStage, stageContext(workspace.root, workspace.source.id, censusScript({ 林岐: "person" })));
    const view = await loadPipelineView(workspace.root, workspace.source.id);
    const windows = await observationWindows(stageContext(workspace.root, workspace.source.id, async () => undefined), view);
    expect(windows).toHaveLength(2);
    const prompts: string[] = [];
    const ctx = stageContext(workspace.root, workspace.source.id, async (input, call) => {
      prompts.push(input.prompt);
      for (;;) {
        const open = await must(call, "list_open_candidates", {});
        if (!open.total) break;
        await must(call, "review_observation_candidates", { items: open.candidates.map((item: { id: string }) => ({ id: item.id, verdict: "accept" })) });
      }
      const lines = unitsOf(input.prompt);
      const heading = lines.find((line) => line.text.startsWith("第一章"));
      if (heading) await must(call, "account_units", { items: [{ unit: heading.unit, status: "paratext", rationale: "Chapter heading." }] });
      const narrative = lines.filter((line) => line !== heading);
      const open = /Segment (ds-\d+-\d+) \(scene\) runs up to this window's start/u.exec(input.prompt)?.[1];
      if (open) {
        // A bogus id is refused; the real one continues.
        expect((await call("propose_discourse_segments", { items: [{ extent: { from: narrative[0]!.unit, to: narrative.at(-1)!.unit }, kind: "scene", continues: "ds-1-2" }] })).details).toMatchObject({ created: [], failed: [{ index: 0 }] });
        await must(call, "propose_discourse_segments", { items: [{ extent: { from: narrative[0]!.unit, to: narrative.at(-1)!.unit }, kind: "scene", continues: open }] });
      } else {
        await must(call, "propose_discourse_segments", { items: [{ extent: { from: narrative[0]!.unit, to: narrative.at(-1)!.unit }, kind: "scene" }] });
      }
      await call("finish_scope", {});
    });
    // Concurrency is ignored for observation: a window may continue the previous one.
    const summary = await runStage(observationStage, ctx, { concurrency: 4 });
    expect(summary.held).toEqual([]);
    expect(summary.completed).toHaveLength(2);
    expect(prompts[0]).not.toMatch(/runs up to this window's start/u);
    expect(prompts[1]).toMatch(/runs up to this window's start/u);
    const after = await loadPipelineView(workspace.root, workspace.source.id);
    const segments = after.bundle.compilerSnapshot.annotations.filter((item) => item.annotationType === "discourse-segment");
    expect(segments).toHaveLength(1);
    expect(segments[0]!.annotationType === "discourse-segment" && segments[0]!.anchors).toHaveLength(2);
    // One scene scope spanning both windows.
    const scenes = await scenesStage.plan(stageContext(workspace.root, workspace.source.id, async () => undefined), after);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.range).toMatchObject({ startByte: windows[0]!.range.startByte < scenes[0]!.range.startByte ? scenes[0]!.range.startByte : windows[0]!.range.startByte });
    expect(scenes[0]!.range.endByte).toBe(windows[1]!.range.endByte);
    // Nothing runs up to a chapter heading: a new chapter never continues the last scene.
    expect(continuableSegments(after, { startByte: 0, endByte: 1 })).toEqual([]);
  });

  it("gap queues stay discoverable past the first 50 items: every window with an unannotated name gets a scope", async () => {
    const workspace = await pipelineWorkspace(LONG);
    cleanups.push(workspace.cleanup);
    await runStage(censusStage, stageContext(workspace.root, workspace.source.id, censusScript({ 林岐: "person" })));
    const ctx = stageContext(workspace.root, workspace.source.id, async () => undefined);
    const view = await loadPipelineView(workspace.root, workspace.source.id);
    const bounded = measureView(view);
    expect(bounded.queues.unannotatedNames.total).toBe(420);
    expect(bounded.queues.unannotatedNames.ranges).toHaveLength(50);
    const windows = await observationWindows(ctx, view);
    const keys = (await gapsStage.plan(ctx, view)).map((scope) => scope.items[0]);
    expect(keys).toEqual(expect.arrayContaining(windows.map((window) => `names@${window.range.startByte}`)));
    // Unaccounted units hold the cut horizon back: they come first, earliest first.
    expect(keys.slice(0, 2)).toEqual(windows.map((window) => `blocking@${window.range.startByte}`));
  });
});

describe("gap items cover every measure that can be a gap", () => {
  it("maps each repair queue to a bounded scope with the tools its target needs", async () => {
    const workspace = await scenedWorkspace();
    cleanups.push(workspace.cleanup);
    const view = await loadPipelineView(workspace.root, workspace.source.id);
    const report = measureView(view, { startByte: 0, endByte: view.bytes.byteLength });
    const speech = view.inventory.speech.find((span) => span.kind === "speech")!;
    const unit = view.structure.units.find((item) => item.anchor.startByte <= speech.startByte && speech.startByte < item.anchor.endByte)!.anchor;
    const segment = view.bundle.compilerSnapshot.annotations.find((item) => item.annotationType === "discourse-segment")!.id;
    const mention = view.bundle.compilerSnapshot.annotations.find((item) => item.annotationType === "entity-mention")!;
    const range = { startByte: speech.startByte, endByte: speech.endByte };
    const scene = view.bundle.canonical.sceneOccurrences[0]!.id;
    const forced = { ...report, queues: { ...report.queues,
      blockingUnits: { total: 1, ranges: [{ startByte: unit.startByte, endByte: unit.endByte }] },
      unannotatedNames: { total: 1, ranges: [range] }, unattributedSpeech: { total: 1, ranges: [range] },
      unresolvedEntityMentions: { total: 1, mentions: [{ mentionId: mention.id, startByte: speech.startByte, endByte: speech.endByte }] },
      unresolvedEventMentions: { total: 1, mentions: [{ mentionId: "ev-x", startByte: speech.startByte, endByte: speech.endByte, salience: "minor" }] },
      uneffectfulEvents: ["event-hurry"], untypedAgentEvents: ["event-hurry"], unanchoredEvents: ["event-hurry"],
      speechOutsideBeats: { total: 1, ranges: [range] }, narrativeOutsideScenes: { total: 1, ranges: [range] }, unpositionedOpening: ["char-mo-yan"] } };
    const items = gapItems(view, forced, view.bytes.byteLength);
    const byKey = new Map(items.map((item) => [item.key, item]));
    expect([...byKey.keys()]).toEqual(expect.arrayContaining(["blocking@0", "names@0", "attribution@0", "mentions@0", `event-mentions@${segment}`, `effect@${scene}`, `agent@${scene}`,
      `beats@${segment}`, `coverage@${segment}`, `time@${scene}`, "opening"]));
    expect(items[0]!.key).toBe("blocking@0");
    expect(byKey.get(`agent@${scene}`)).toMatchObject({ layer: "scenes", segmentId: segment });
    expect(byKey.get("attribution@0")!.describe).toMatch(new RegExp(`s${speech.startByte}@u\\d+`, "u"));
    // A scope's tool set follows its target: the scene tools for its segment, the opening tool for the opening.
    const ctx = stageContext(workspace.root, workspace.source.id, async () => undefined);
    const toolsFor = (key: string) => gapsStage.tools(ctx, { id: "x", range: byKey.get(key)!.range, items: [key, ...(byKey.get(key)!.segmentId ? [`segment:${byKey.get(key)!.segmentId}`] : []), ...(byKey.get(key)!.opening ? ["tools:opening"] : [])], title: key }, { finished: false, calls: 0 }).map((tool) => tool.name);
    expect(toolsFor(`agent@${scene}`)).toEqual(expect.arrayContaining(["propose_beats", "resolve_event_mentions", "record_dispositions"]));
    expect(toolsFor("opening")).toContain("propose_initial_world");
    expect(new Set(toolsFor(`agent@${scene}`)).size).toBe(toolsFor(`agent@${scene}`).length);
  });

  it("closes a ratio-measure item with a validated reviewed exception and refuses an unknown subject", async () => {
    const workspace = await scenedWorkspace();
    cleanups.push(workspace.cleanup);
    const results: Array<{ ok: boolean; text: string }> = [];
    const ctx = stageContext(workspace.root, workspace.source.id, async (_input, call) => {
      results.push(await call("record_dispositions", { items: [{ measure: "events.typed-agent", subject: "event:nope", verdict: "not-stated", rationale: "x" }] }));
      results.push(await call("record_dispositions", { items: [{ measure: "events.typed-agent", subject: "speech:1", verdict: "not-stated", rationale: "x" }] }));
      results.push(await call("record_dispositions", { items: [{ measure: "relations.roster-pairs", subject: "pair:char-mo-yan|char-lin-qi", verdict: "not-stated", rationale: "Reviewed; reversed order is normalised." }] }));
      await call("finish_scope", {});
    });
    await runStage(worldStage, ctx, { maxAttempts: 1 });
    expect(results.slice(0, 2).map((result) => (JSON.parse(result.text) as { failed: unknown[] }).failed.length)).toEqual([1, 1]);
    expect(JSON.parse(results[2]!.text)).toMatchObject({ recorded: ["relations.roster-pairs pair:char-lin-qi|char-mo-yan"] });
  });

  it("keeps a missing major from the roster review open until it is reviewed, through a world work item", async () => {
    const workspace = await scenedWorkspace();
    cleanups.push(workspace.cleanup);
    await runStage(rosterStage, stageContext(workspace.root, workspace.source.id, async (input, call) => {
      const ids = [...input.prompt.matchAll(/^(char-[\w-]+) \|/gmu)].map((match) => match[1]!);
      await must(call, "review_roster", { majors: ids, missing: [{ name: "白鸦", rationale: "The keeper the bells answer to." }], rationale: "Both drive the scene; one major is never named here." });
      await call("finish_scope", {});
    }));
    const view = await loadPipelineView(workspace.root, workspace.source.id);
    const report = measureView(view);
    expect(report.measures.find((item) => item.id === "characters.roster-modelled")).toMatchObject({ total: 3, status: "gap" });
    const plan = await worldStage.plan(stageContext(workspace.root, workspace.source.id, async () => undefined), view);
    const scope = plan.find((item) => item.items.includes("roster:missing:白鸦"))!;
    expect(scope).toBeDefined();
    // The scope offers the entity tools a missing major may need.
    expect(worldStage.tools(stageContext(workspace.root, workspace.source.id, async () => undefined), scope, { finished: false, calls: 0 }).map((tool) => tool.name)).toEqual(expect.arrayContaining(["propose_entities", "propose_entity_mentions"]));
    const ctx = stageContext(workspace.root, workspace.source.id, async (_input, call) => {
      expect((await call("record_dispositions", { items: [{ measure: "characters.roster-modelled", subject: "missing:无名", verdict: "not-stated", rationale: "x" }] })).text).toMatch(/names no missing major/u);
      await must(call, "record_dispositions", { items: [{ measure: "characters.roster-modelled", subject: "missing:白鸦", verdict: "not-stated", rationale: "The opening never presents this person; the reviewer drew on later chapters." }] });
      // The other roster slots in this scope (the two reviewed majors) are answered too.
      await must(call, "record_dispositions", { items: scope.items.filter((item) => item.startsWith("roster:actor:")).map((item) => ({ measure: "characters.roster-modelled", subject: item.slice("roster:".length), verdict: "not-stated", rationale: "Test: no model asserted." })) });
      await call("finish_scope", {});
    });
    const summary = await runStage(worldStage, ctx, { scopeIds: [scope.id], maxAttempts: 1 });
    expect(summary.completed).toEqual([scope.id]);
  });
});

describe("observation time candidates", () => {
  it("offers each explicit time expression as a candidate the window must review", async () => {
    const text = BELL_TOWER.replace("林岐站在钟楼下。", "第二天早上，林岐站在钟楼下。");
    const workspace = await pipelineWorkspace(text);
    cleanups.push(workspace.cleanup);
    await runStage(censusStage, stageContext(workspace.root, workspace.source.id, censusScript()));
    const view = await loadPipelineView(workspace.root, workspace.source.id);
    const window = (await observationWindows(stageContext(workspace.root, workspace.source.id, async () => undefined), view))[0]!;
    const time = openCandidates(view, window.range).find((item) => item.kind === "time")!;
    expect(time).toMatchObject({ text: "第二天早上", timeKind: "relative" });
    let rejectTime = false;
    const ctx = stageContext(workspace.root, workspace.source.id, async (input, call) => {
      if (!rejectTime) {
        // Everything but the time candidate; a time candidate cannot be rewritten.
        const open = await must(call, "list_open_candidates", {});
        await must(call, "review_observation_candidates", { items: open.candidates.filter((item: { kind: string }) => item.kind !== "time")
          .map((item: { id: string; kind: string; cue?: string }) => ({ id: item.id, verdict: "accept", ...(item.kind === "speech" && item.cue ? { speaker: "cue" } : {}) })) });
        expect((await call("review_observation_candidates", { items: [{ id: time.id, verdict: "rewrite", span: { unit: "u0002", text: "第二天" } }] })).details).toMatchObject({ failed: [{ index: 0, error: expect.stringMatching(/accepted or rejected/u) }] });
        await call("finish_scope", {});
        return;
      }
      await must(call, "review_observation_candidates", { items: [{ id: time.id, verdict: "reject", rationale: "Test: treat it as not story time." }] });
      await observationScript()(input, call);
    });
    const first = await runStage(observationStage, ctx, { maxAttempts: 1 });
    expect(first.held).toHaveLength(1);
    expect((await ctx.store.receipts()).find((item) => item.stage === "observation")!.gate!.checks.find((check) => check.id === "observation.candidates-reviewed")!.detail).toContain(time.id);
    await releaseHeldScopes(ctx.store, { stage: "observation" });
    rejectTime = true;
    expect((await runStage(observationStage, ctx)).completed).toHaveLength(1);
    const after = await loadPipelineView(workspace.root, workspace.source.id);
    expect(after.options.handled?.times).toEqual([time.range]);
  });
});

describe("parallel scopes and per-stage provenance", () => {
  it("runs scopes with disjoint ranges side by side and a whole-source scope alone", async () => {
    const workspace = await pipelineWorkspace();
    cleanups.push(workspace.cleanup);
    const intervals = new Map<string, { start: number; end: number }>();
    const done = new Set<string>();
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const stage: StageDefinition = {
      stage: "gaps",
      plan: () => [
        { id: "a", range: { startByte: 0, endByte: 10 }, items: [], title: "a" },
        { id: "b", range: { startByte: 10, endByte: 20 }, items: [], title: "b" },
        { id: "whole", range: { startByte: 0, endByte: 20 }, items: [], title: "whole" },
      ],
      prompt: (_ctx, _view, scope) => scope.id,
      tools: () => [],
      gate: (_ctx, _view, scope) => gateOf([{ id: "done", passed: done.has(scope.id), detail: scope.id }]),
    };
    const ctx = { ...stageContext(workspace.root, workspace.source.id, async () => undefined), agent: new ScriptedStageAgent(async (input) => {
      const start = Date.now();
      await sleep(150);
      done.add(input.scopeId);
      intervals.set(input.scopeId, { start, end: Date.now() });
    }) };
    const summary = await runStage(stage, ctx, { concurrency: 3 });
    expect(summary.completed.sort()).toEqual(["a", "b", "whole"]);
    const a = intervals.get("a")!, b = intervals.get("b")!, whole = intervals.get("whole")!;
    expect(a.start < b.end && b.start < a.end).toBe(true);
    expect(whole.start).toBeGreaterThanOrEqual(Math.max(a.end, b.end));
  });

  it("records the routed stage model on model-produced observations", async () => {
    const workspace = await pipelineWorkspace();
    cleanups.push(workspace.cleanup);
    await runStage(censusStage, stageContext(workspace.root, workspace.source.id, censusScript()));
    const ctx = { ...stageContext(workspace.root, workspace.source.id, observationScript()), stageGeneratedBy: { observation: { provider: "cheap", model: "mini" } } };
    expect((await runStage(observationStage, ctx)).completed).toHaveLength(1);
    const view = await loadPipelineView(workspace.root, workspace.source.id);
    const pronoun = view.bundle.compilerSnapshot.annotations.find((item) => item.annotationType === "entity-mention" && item.form === "pronoun")!;
    expect(pronoun.derivation).toMatchObject({ worker: "pipeline-observation", provider: "cheap", model: "mini" });
  });
});

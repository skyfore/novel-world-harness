import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import { releaseHeldScope, runStage } from "../../src/compiler/pipeline/runner.js";
import { scenesStage } from "../../src/compiler/pipeline/scenes.js";
import { loadPipelineView, measureView } from "../../src/compiler/pipeline/view.js";
import { identifiedWorkspace, scenesScript, stageContext } from "./fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe("pipeline scenes", () => {
  it("refuses a scene whose dialogue sits outside every beat, then compiles beats with typed agents and effects", async () => {
    const workspace = await identifiedWorkspace();
    cleanups.push(workspace.cleanup);
    let conversations = false;
    const ctx = stageContext(workspace.root, workspace.source.id, scenesScript({ conversations: () => conversations }));
    const first = await runStage(scenesStage, ctx, { maxAttempts: 1 });
    expect(first.held).toHaveLength(1);
    const held = (await ctx.store.receipts()).find((item) => item.stage === "scenes")!;
    expect(held.error).toBeUndefined();
    expect(held.gate!.checks.filter((check) => !check.passed).map((check) => check.id)).toEqual(["events.speech-in-beats"]);

    await releaseHeldScope(ctx.store, held.id);
    conversations = true;
    const second = await runStage(scenesStage, ctx);
    const again = (await ctx.store.receipts()).find((item) => item.id === held.id)!;
    expect(again.error).toBeUndefined();
    expect(again.gate!.checks.filter((check) => !check.passed)).toEqual([]);
    expect(second.completed).toEqual([held.id]);
    const view = await loadPipelineView(workspace.root, workspace.source.id);
    const scene = view.bundle.canonical.sceneOccurrences[0]!;
    expect(scene).toMatchObject({ locationId: "loc-bell-tower", presentActorIds: ["char-lin-qi", "char-mo-yan"] });
    expect(scene.eventIds).toEqual(["event-ask-for-key", "event-walk-north-gate", "event-hurry"]);
    const byId = new Map(measureView(view).measures.map((item) => [item.id, item]));
    expect(byId.get("events.speech-in-beats")).toMatchObject({ numerator: 7, total: 7 });
    expect(byId.get("events.typed-agent")).toMatchObject({ numerator: 3, total: 3 });
    expect(byId.get("events.effectful")).toMatchObject({ numerator: 3, total: 3, note: "2 by a reviewed \"no change\"." });
    expect(byId.get("scenes.location-contract")!.status).toBe("satisfied");
    expect(byId.get("observation.event-mentions-resolved")).toMatchObject({ numerator: 3, total: 3 });
  });
});

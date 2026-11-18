import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import { isRegisteredDomainModule, BASE_ACTION_SCHEMAS } from "../../src/compiler/pipeline/domain-modules.js";
import { rosterStage } from "../../src/compiler/pipeline/roster.js";
import { runStage } from "../../src/compiler/pipeline/runner.js";
import { loadPipelineView, measureView } from "../../src/compiler/pipeline/view.js";
import { worldStage, worldWorkItems } from "../../src/compiler/pipeline/world.js";
import { must, scenedWorkspace, stageContext, worldScript } from "./fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe("pipeline world and roster", () => {
  it("derives work items from the contract, accepts artifacts or reviewed dispositions, and installs base domain modules", async () => {
    const workspace = await scenedWorkspace();
    cleanups.push(workspace.cleanup);
    const before = worldWorkItems(measureView(await loadPipelineView(workspace.root, workspace.source.id)));
    expect(before.sort()).toEqual(["autonomy:source", "key-event:event-walk-north-gate", "location:loc-bell-tower", "location:loc-north-gate"]);
    // Counterexample: an agent that answers nothing leaves every scope held.
    const idle = stageContext(workspace.root, workspace.source.id, async () => undefined);
    const held = await runStage(worldStage, idle, { maxAttempts: 1 });
    expect(held.completed).toEqual([]);
    expect(held.held.length).toBeGreaterThan(0);
    for (const id of held.held) await (await import("../../src/compiler/pipeline/runner.js")).releaseHeldScope(idle.store, id);

    const summary = await runStage(worldStage, stageContext(workspace.root, workspace.source.id, worldScript()));
    expect((await idle.store.receipts()).filter((item) => item.status === "held").map((item) => [item.id, item.error, item.gate?.checks])).toEqual([]);
    expect(summary.held).toEqual([]);
    const view = await loadPipelineView(workspace.root, workspace.source.id);
    expect(worldWorkItems(measureView(view))).toEqual([]);
    expect(view.bundle.canonical.actionSchemas.map((schema) => schema.id).sort()).toEqual(BASE_ACTION_SCHEMAS.map((schema) => schema.id).sort());
    expect(view.bundle.canonical.normTemplates[0]!.induction).toEqual({ kind: "source-statement", statement: "林岐催促：快走！" });
    const byId = new Map(measureView(view).measures.map((item) => [item.id, item]));
    expect(byId.get("space.locations-on-graph")!.status).toBe("satisfied");
    expect(byId.get("possibility.autonomous-templates")!.status).toBe("satisfied");
  });

  it("refuses an invented domain module and reviews the roster independently", async () => {
    expect(isRegisteredDomainModule(BASE_ACTION_SCHEMAS[0])).toBe(true);
    expect(isRegisteredDomainModule({ ...BASE_ACTION_SCHEMAS[0], name: "Fly" })).toBe(false);
    const workspace = await scenedWorkspace();
    cleanups.push(workspace.cleanup);
    const ctx = stageContext(workspace.root, workspace.source.id, async (input, call) => {
      expect(input.prompt).not.toMatch(/traits|dispositions:|goals:/u);
      const ids = [...input.prompt.matchAll(/^(char-[\w-]+) \|/gmu)].map((match) => match[1]!);
      const refused = await call("review_roster", { majors: ["char-nobody"], rationale: "x" });
      expect(refused.ok).toBe(false);
      await must(call, "review_roster", { majors: ids, missing: [], rationale: "Both drive the only scene." });
      await call("finish_scope", {});
    });
    const summary = await runStage(rosterStage, ctx);
    expect(summary.completed).toHaveLength(1);
    const view = await loadPipelineView(workspace.root, workspace.source.id);
    expect(view.roster!.review!.majors.sort()).toEqual(["char-lin-qi", "char-mo-yan"]);
    expect(measureView(view).roster).toMatchObject({ reviewed: true });
    expect(measureView(view).measures.find((item) => item.id === "characters.roster-reviewed")!.status).toBe("satisfied");
  });
});

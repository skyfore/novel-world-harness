import fs from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { compilationHandoff, horizonTask } from "../src/compiler/compilation-handoff.js";
import { inspectCompilerStatus } from "../src/compiler/status.js";
import { createAdmittedWorkspace } from "./helpers/admitted-workspace.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const cut = (index: number, tier: string, blocking: Array<{ code: string; message: string; path?: string }> = []) =>
  ({ cutId: String(index).repeat(64).slice(0, 64), beforeEventId: `e${index}`, sceneIds: [`s${index}`], sceneId: `s${index}`, index, discourseByte: index, tier, actors: [], blocking, advisories: [], dependsOn: [], closureHash: "a".repeat(64) });
const manifest = {
  horizonIndex: 3,
  cuts: [
    cut(0, "enterable"), cut(2, "replayable"),
    cut(4, "blocked", [{ code: "CUT_PREFIX_REPLAY_FAILED", message: "move without origin", path: "event/e3" }, { code: "CUT_SOURCE_UNACCOUNTED", message: "unit", path: "unit/u9" }, { code: "CUT_SOURCE_UNACCOUNTED", message: "unit", path: "unit/u9" }]),
    cut(6, "blocked", [{ code: "CUT_PREFIX_REPLAY_FAILED", message: "move without origin", path: "event/e3" }]),
  ],
} as never;
const command = (...args: string[]) => ({ program: "nwh" as const, args });

it("names the first blocked cut after the horizon with its causes grouped", () => {
  const task = horizonTask({ sourceId: "src" }, { bundleHash: "f".repeat(64), manifest }, command)!;
  expect(task).toMatchObject({ id: `horizon:${"4".repeat(64)}`, kind: "horizon", state: "blocked", execution: "inspect-only", command: { args: ["compile-novel", "cuts"] } });
  expect(task.groups).toEqual([{ code: "CUT_PREFIX_REPLAY_FAILED", nodes: ["event/e3"], count: 1 }, { code: "CUT_SOURCE_UNACCOUNTED", nodes: ["unit/u9"], count: 2 }]);
  expect(task.reason).toMatch(/holds back 2 cut/);
  expect(task.refs).toEqual(["f".repeat(64), "4".repeat(64), "event/e3", "unit/u9"]);
  expect(horizonTask({ sourceId: "src" }, { bundleHash: "f".repeat(64), manifest: { horizonIndex: 9, cuts: [cut(0, "enterable")] } as never }, command)).toBeUndefined();
});

it("puts the horizon task first in the compilation plan", async () => {
  const workspace = await createAdmittedWorkspace("nwh-horizon-plan-"); roots.push(workspace.root);
  const source = (await inspectCompilerStatus(workspace.root, workspace.source.id)).sources[0]!;
  const upstream = { records: [], plans: [], attempts: [], modelSessions: [] };
  const plan = compilationHandoff(workspace.root, source, null, upstream as never, { bundleHash: workspace.admitted.bundleHash!, manifest });
  expect(plan.tasks[0]).toMatchObject({ kind: "horizon" });
  expect(plan.blockers[0]).toBe(plan.tasks[0]!.id);
  expect(compilationHandoff(workspace.root, source, null, upstream as never).tasks.some((task) => task.kind === "horizon")).toBe(false);
}, 120_000);

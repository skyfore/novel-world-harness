import fs from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { ACT_PROBE_INTENTS, actProbeReportSchema, ActProbeStore, defaultActProbeScript, runActProbe, summarizeActProbes } from "../src/eval/act-probe.js";
import { createWorldBranch } from "../src/world/instance.js";
import { createAdmittedWorkspace } from "./helpers/admitted-workspace.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it("runs all six intent classes through the production turn pipeline and reports complete measurements", async () => {
  const workspace = await createAdmittedWorkspace("nwh-act-probe-"); roots.push(workspace.root);
  const opening = workspace.admitted.admission.cuts.find((cut) => cut.beforeEventId === "letter")!;
  await createWorldBranch(workspace.root, "probe-hero", undefined, workspace.source.id, workspace.cacheRoot, "hero", undefined, undefined, { entryCutId: opening.cutId });
  const script = defaultActProbeScript(1);
  expect(script.map((step) => step.intent)).toEqual([...ACT_PROBE_INTENTS]);
  const report = await runActProbe({ root: workspace.root, branchId: "probe-hero", actorId: "hero", cutId: opening.cutId, sourceId: workspace.source.id, mode: "fake", script });
  expect(actProbeReportSchema.parse(report)).toEqual(report);
  expect(report.failure).toBeUndefined();
  expect(report.turns.map((turn) => turn.intent)).toEqual([...ACT_PROBE_INTENTS]);
  expect(report.replayEquivalent).toBe(true);
  expect(report.knowledgeViolations).toBe(0);
  for (const turn of report.turns) {
    expect(turn.modelCalls).toBe(0);
    expect(turn.latencyMs).toBeGreaterThanOrEqual(0);
    expect(turn.canonPositionAfter).toBeGreaterThanOrEqual(turn.canonPositionBefore);
    expect(Object.keys(turn.committedByLane).sort()).toEqual(["actor", "background", "canon-step", "npc", "player", "world-response"]);
    if (!turn.accepted) expect(turn.rejectedAt).toBeTruthy();
  }
  expect(report.turns[0]!.canonPositionBefore).toBe(opening.index);
  expect(report.turns.find((turn) => turn.intent === "observe")?.accepted).toBe(true);
  expect(report.turns.find((turn) => turn.intent === "wait")?.accepted).toBe(true);
  for (const value of Object.values(report.rates)) expect(value).toBeGreaterThanOrEqual(0);
  const summary = summarizeActProbes([report]);
  expect(summary).toMatchObject({ entries: 1, turns: 6, replayEquivalent: true, knowledgeViolations: 0, modelCalls: 0 });
  expect(Object.keys(summary.byIntent)).toEqual([...ACT_PROBE_INTENTS]);
  const file = await new ActProbeStore(workspace.root).write(workspace.source.id, [report], summary);
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({ version: 1, sourceId: workspace.source.id, reports: [{ runId: report.runId }] });
}, 120_000);

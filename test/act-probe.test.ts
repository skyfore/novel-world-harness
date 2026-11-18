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

it("probes every admitted cut x actor in isolated scratch workspaces and saves the report", async () => {
  const workspace = await createAdmittedWorkspace("nwh-novel-probe-"); roots.push(workspace.root);
  const { runNovelProbe } = await import("../src/commands/novel-probe.js");
  const { BranchStore } = await import("../src/world/store.js");
  const result = await runNovelProbe({ root: workspace.root, sourceId: workspace.source.id, cacheRoot: workspace.cacheRoot });
  const admittedCount = workspace.admitted.admission.cuts.reduce((count, cut) => count + cut.actors.filter((actor) => ["enterable", "reviewed", "certified"].includes(actor.tier)).length, 0);
  expect(result.summary).toMatchObject({ mode: "fake", admittedEntries: admittedCount, entries: admittedCount, failures: [], replayEquivalent: true, knowledgeViolations: 0 });
  expect(result.summary.turns).toBe(admittedCount * 6);
  expect(result.reports.map((report) => report.actorId).sort()).toEqual(workspace.admitted.admission.cuts.flatMap((cut) => cut.actors.filter((actor) => actor.tier !== "blocked" && actor.tier !== "replayable").map((actor) => actor.actorId)).sort());
  expect(await new BranchStore(workspace.root).listIds()).toEqual([]);
  expect(JSON.parse(await fs.readFile(result.reportPath, "utf8")).summary.entries).toBe(admittedCount);
  const one = await runNovelProbe({ root: workspace.root, sourceId: workspace.source.id, cacheRoot: workspace.cacheRoot, cutId: result.reports[0]!.cutId });
  expect(one.reports.every((report) => report.cutId === result.reports[0]!.cutId)).toBe(true);
}, 180_000);

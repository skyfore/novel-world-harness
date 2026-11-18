import fs from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { fakeActProbeReasoners } from "../src/eval/act-probe.js";
import { createWorldBranch } from "../src/world/instance.js";
import { performPlayTurn } from "../src/world/play-experience.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { createAdmittedWorkspace } from "./helpers/admitted-workspace.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it("advances canon after the player's turn in a frozen-timeline world and replays the result", async () => {
  const workspace = await createAdmittedWorkspace("nwh-canon-turn-"); roots.push(workspace.root);
  const opening = workspace.admitted.admission.cuts.find((cut) => cut.beforeEventId === "letter")!;
  const created = await createWorldBranch(workspace.root, "play", undefined, workspace.source.id, workspace.cacheRoot, "hero", undefined, undefined, { entryCutId: opening.cutId });
  const step = { intent: "observe" as const, utterance: "我观察四周。" };
  const outcome = await performPlayTurn({ root: workspace.root, branchId: "play", actorId: "hero", sourceId: workspace.source.id, utterance: step.utterance,
    expectedHead: created.head, intent: "observe", ...fakeActProbeReasoners(step) });
  expect(outcome.result.accepted).toBe(true);
  expect(outcome.canonStepError).toBeUndefined();
  // The courier's letter and Later's arrival are offscreen for Hero and happen on their own;
  // Hero's unattributed reading is left to the world-response channel and is passed.
  expect(outcome.canonStep).toMatchObject({ committed: ["letter", "later-arrives"], position: 3, stoppedAt: "exhausted" });
  expect(outcome.canonStepEvents.map((event) => event.canonicalEventId)).toEqual(["letter", "later-arrives"]);
  expect(outcome.canonStatus).toEqual({ status: "exhausted", position: 3, total: 3, horizonIndex: 3, diverged: false });
  const { engine } = await openWorkspaceWorld(workspace.root);
  const cold = await engine.projections.project(outcome.finalHead, { fresh: true, useCheckpoints: false });
  expect(cold.history.flatMap((entry) => entry.event.realizesCanonicalEventIds ?? [])).toEqual(expect.arrayContaining(["letter", "later-arrives"]));
  // Offscreen canon does not hand Hero knowledge of what happened elsewhere.
  expect(Object.keys(cold.knowledge.actors.hero ?? {})).toEqual([]);
}, 120_000);

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { performPlayTurn, type PerformPlayTurnOptions } from "../src/world/play-experience.js";
import { PlaySessionStore } from "../src/world/play-session.js";
import { PlayMoveStore } from "../src/world/play-move.js";
import { PlayConversationStore } from "../src/world/play-conversation.js";
import type { PlayerActionCandidate } from "../src/world/player-action.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-idempotency-")); roots.push(root);
  const source = await createEvidenceFixture(root, "Ada waits.");
  await new CanonicalModelStore(root).putEntity({ id: "ada", kind: "character", canonicalName: "Ada", aliases: [], evidence: source.evidence("Ada") });
  const { engine } = await openWorkspaceWorld(root);
  const head = await engine.createBranch("main", "Main", { version: 1, operations: [{ op: "set", entityId: "ada", field: "character.alive", value: true }] }, undefined, source.source.id);
  const candidate: PlayerActionCandidate = { title: "Ada waits", intent: { kind: "act", summary: "Wait one minute", targets: [],
    controlledAct: { eventTitle: "Ada waits", actorObservation: "You wait one minute." }, requestedTimeAdvance: { amount: 1, unit: "minute" } },
    participants: [], preconditions: [], proposedDelta: { version: 1, operations: [] }, requiresKnowledge: [], forbidsKnowledge: [] };
  const translator = vi.fn(() => candidate);
  const options: PerformPlayTurnOptions = { root, branchId: "main", actorId: "ada", utterance: "I wait one minute", playerMoveId: "move-1",
    advanceActors: 0, advanceBackground: 0, expectedHead: head, translator };
  return { root, engine, options, translator, head, candidate };
}

it("returns the committed result on session failure and repairs only the session on retry", async () => {
  const f = await fixture();
  vi.spyOn(PlaySessionStore.prototype, "write").mockRejectedValueOnce(new Error("Injected session IO failure"));
  const result = await performPlayTurn(f.options);
  expect(result.result.accepted).toBe(true);
  expect(result.sessionError).toContain("Injected session IO failure");
  expect(result.finalHead).not.toBe(f.head);
  const retried = await performPlayTurn(f.options);
  expect(retried).toMatchObject({ replayed: true, finalHead: result.finalHead, result: result.result });
  expect(retried.sessionError).toBeUndefined();
  expect(await f.engine.branches.readHead("main")).toBe(result.finalHead);
  expect(f.translator).toHaveBeenCalledOnce();
  expect(await new PlaySessionStore(f.root).read()).toMatchObject({ lastCommitId: result.finalHead });
  expect(await new PlayConversationStore(f.root).list("main")).toHaveLength(1);
});

it("replays a completed move after later turns without rolling the session back", async () => {
  const f = await fixture();
  const first = await performPlayTurn(f.options);
  const next = await performPlayTurn({ ...f.options, expectedHead: first.finalHead, playerMoveId: "move-2" });
  expect((await performPlayTurn(f.options)).finalHead).toBe(first.finalHead);
  expect(await f.engine.branches.readHead("main")).toBe(next.finalHead);
  expect((await new PlaySessionStore(f.root).read())?.lastCommitId).toBe(next.finalHead);
  expect(f.translator).toHaveBeenCalledTimes(2);
  await expect(performPlayTurn({ ...f.options, utterance: "A different action" })).rejects.toThrow("PLAY_MOVE_ID_CONFLICT");
  expect(f.translator).toHaveBeenCalledTimes(2);
});

it("admits only one concurrent execution of a move", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const translating = new Promise<void>(resolve => { entered = resolve; });
  const translator = vi.fn(async () => { entered(); await waiting; return f.candidate; });
  const options = { ...f.options, translator };
  const first = performPlayTurn(options);
  try {
    await translating;
    await expect(performPlayTurn(options)).rejects.toThrow("PLAY_MOVE_RECOVERY_REQUIRED");
    expect(await f.engine.branches.readHead("main")).toBe(f.head);
  } finally { release(); }
  const done = await first;
  expect((await performPlayTurn(options)).finalHead).toBe(done.finalHead);
  expect(translator).toHaveBeenCalledOnce();
});

it.each([false, true])("never reexecutes after a completion write failure (receipt published=%s)", async published => {
  const f = await fixture();
  const complete = PlayMoveStore.prototype.complete;
  vi.spyOn(PlayMoveStore.prototype, "complete").mockImplementationOnce(async function (this: PlayMoveStore, outcome) {
    if (published) await complete.call(this, outcome);
    throw new Error("Injected completion write failure");
  });
  await expect(performPlayTurn(f.options)).rejects.toThrow("Injected completion write failure");
  const committed = await f.engine.branches.readHead("main");
  expect(committed).not.toBe(f.head);
  if (published) expect((await performPlayTurn(f.options)).finalHead).toBe(committed);
  else await expect(performPlayTurn(f.options)).rejects.toThrow("Do not repeat the action");
  expect(await f.engine.branches.readHead("main")).toBe(committed);
  expect(f.translator).toHaveBeenCalledOnce();
});

it("does not consume a move ID on failed preflight", async () => {
  const f = await fixture();
  await expect(performPlayTurn({ ...f.options, utterance: " " })).rejects.toThrow();
  await expect(performPlayTurn({ ...f.options, advanceActors: -1 })).rejects.toThrow("advanceActors");
  await expect(performPlayTurn({ ...f.options, expectedHead: "stale" })).rejects.toThrow("expected branch head");
  expect((await performPlayTurn(f.options)).result.accepted).toBe(true);
  expect(f.translator).toHaveBeenCalledOnce();
});

it.each(["{broken", "null", JSON.stringify({ outcome: {} })])("retains the committed move and stops on a damaged receipt: %s", async damaged => {
  const f = await fixture();
  const original = await performPlayTurn(f.options);
  const store = new PlayMoveStore({ ...f.options, playerMoveId: "move-1" });
  await fs.writeFile(path.join(store.directory, "outcome.json"), damaged);
  await expect(performPlayTurn(f.options)).rejects.toThrow("PLAY_MOVE_RECOVERY_REQUIRED");
  expect(await f.engine.branches.readHead("main")).toBe(original.finalHead);
  expect(f.translator).toHaveBeenCalledOnce();
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorldEngine, type WorldModelContext } from "../src/world/engine.js";
import { WorldRuntime } from "../src/world/runtime.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";
import {
  modelPlayConversation,
  playConversationAtCommit,
  PlayConversationStore,
  recentPlayConversation,
} from "../src/world/play-conversation.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function engineFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-conversation-"));
  roots.push(root);
  const context: WorldModelContext = {
    entities: new Map([
      ["hero", { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] }],
    ]),
    rules: new Map(),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  const engine = new WorldEngine(root, context);
  const genesis = await engine.createBranch("main", "Main", {
    version: 1,
    operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
  });
  return { root, engine, genesis };
}

describe("play conversation memory", () => {
  it("injects exactly the latest ten messages while preserving a complete retrieval archive", async () => {
    const { root, engine, genesis } = await engineFixture();
    const store = new PlayConversationStore(root);
    for (let index = 0; index < 12; index += 1) {
      await store.append({
        branchId: "main",
        actorId: "hero",
        atCommit: genesis,
        role: index % 2 === 0 ? "player" : "scene",
        status: index % 2 === 0 ? "accepted" : "rendered",
        text: `message-${index}`,
      });
    }
    await store.append({
      branchId: "main",
      actorId: "other-character",
      atCommit: genesis,
      role: "player",
      status: "accepted",
      text: "private wording from another embodied character",
    });
    const archive = await playConversationAtCommit(engine, "main", genesis, "hero");
    const recent = recentPlayConversation(archive);

    expect(archive).toHaveLength(12);
    expect(archive.map((message) => message.text)).not.toContain("private wording from another embodied character");
    expect(recent.map((message) => message.text)).toEqual(
      Array.from({ length: 10 }, (_value, index) => `message-${index + 2}`),
    );
    expect(modelPlayConversation(recent)[0]).toEqual({
      role: "player",
      text: "message-2",
      worldStatus: "accepted",
      authority: "untrusted-player-text",
      order: 0,
    });
    expect(modelPlayConversation(recent)[1]).toMatchObject({
      role: "scene",
      authority: "presentation-only",
    });
  });

  it("filters parent messages by the selected fork's commit ancestry", async () => {
    const { root, engine, genesis } = await engineFixture();
    const store = new PlayConversationStore(root);
    await store.append({
      branchId: "main",
      actorId: "hero",
      atCommit: genesis,
      role: "scene",
      status: "rendered",
      text: "shared opening",
    });
    const advanced = await engine.commitProposal({
      proposalId: "main-only-step",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "player",
      actorId: "hero",
      title: "Main branch action",
      actorObservations: [{ actorId: "hero", summary: "You act on main." }],
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      causalParents: [],
      evidence: [],
      progress: {
        version: 1,
        channels: ["consequence"],
        threadIds: [],
        noveltyKey: "main-only-step",
      },
    });
    expect(advanced.report.accepted).toBe(true);
    await store.append({
      branchId: "main",
      actorId: "hero",
      atCommit: advanced.newHead,
      role: "player",
      status: "accepted",
      text: "main-only request",
    });
    await new WorldRuntime(engine, () => []).forkBranch("main", genesis, "fork", "Fork");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.append({
      branchId: "main",
      actorId: "hero",
      atCommit: genesis,
      role: "scene",
      status: "rendered",
      text: "late parent rendering at the fork commit",
    });
    await store.append({
      branchId: "fork",
      actorId: "hero",
      atCommit: genesis,
      role: "player",
      status: "rejected",
      text: "fork-local rejected request",
    });

    const forkMessages = await playConversationAtCommit(engine, "fork", genesis, "hero");
    expect(forkMessages.map((message) => message.text)).toEqual([
      "shared opening",
      "fork-local rejected request",
    ]);
    expect(forkMessages.map((message) => message.text)).not.toContain("main-only request");
    expect(forkMessages.map((message) => message.text)).not.toContain("late parent rendering at the fork commit");
  });
});

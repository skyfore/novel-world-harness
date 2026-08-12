import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdout } from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { playWorldCommand } from "../src/commands/play-world.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { PlaySessionStore } from "../src/world/play-session.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-world-"));
  roots.push(root);
  const canon = new CanonicalModelStore(root);
  await canon.putEntity({ id: "hero", kind: "character", canonicalName: "林岐", aliases: ["Lin Qi"], evidence: [] });
  await canon.putEntity({ id: "hall", kind: "location", canonicalName: "前厅", aliases: [], evidence: [] });
  await canon.putEntity({ id: "camp", kind: "location", canonicalName: "营地", aliases: [], evidence: [] });
  const { engine } = await openWorkspaceWorld(root);
  const genesis = await engine.createBranch("main", "Main", {
    version: 1,
    operations: [
      { op: "set", entityId: "hero", field: "character.alive", value: true },
      { op: "set", entityId: "hero", field: "character.location", value: "hall" },
    ],
  });
  return { root, genesis };
}

describe("play-world command", () => {
  it("selects a character, translates a natural-language action, commits, renders, and persists resume state", async () => {
    const { root, genesis } = await fixture();
    const output: string[] = [];
    vi.spyOn(stdout, "write").mockImplementation(((value: string | Uint8Array) => {
      output.push(String(value));
      return true;
    }) as typeof stdout.write);
    const result = await playWorldCommand({
      root,
      configPath: path.join(root, "novel-harness.yaml"),
      branchId: "main",
      character: "林岐",
      action: "我离开前厅，去营地。",
      translator: () => ({
        title: "林岐离开前厅，抵达营地",
        participants: ["camp"],
        preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.location", value: "hall" }],
        proposedDelta: {
          version: 1,
          operations: [{ op: "set", entityId: "hero", field: "character.location", value: "camp" }],
        },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      }),
    });

    expect(result?.accepted).toBe(true);
    expect(result?.newHead).not.toBe(genesis);
    expect(output.join("")).toContain("林岐离开前厅，抵达营地");
    await expect(new PlaySessionStore(root).read()).resolves.toMatchObject({
      branchId: "main",
      actorId: "hero",
      lastCommitId: result?.newHead,
    });
    const reopened = await openWorkspaceWorld(root);
    expect((await reopened.engine.projector.project(result!.newHead)).values.hero?.["character.location"]).toBe("camp");
  });

  it("reports deterministic rejection and leaves the selected branch unchanged", async () => {
    const { root, genesis } = await fixture();
    vi.spyOn(stdout, "write").mockImplementation((() => true) as typeof stdout.write);
    const result = await playWorldCommand({
      root,
      configPath: path.join(root, "novel-harness.yaml"),
      character: "hero",
      action: "我留在前厅。",
      translator: () => ({
        title: "Impossible move",
        participants: [],
        preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.alive", value: false }],
        proposedDelta: { version: 1, operations: [] },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      }),
    });

    expect(result?.accepted).toBe(false);
    expect(result?.issues).toContainEqual(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
    expect(await (await openWorkspaceWorld(root)).engine.branches.readHead("main")).toBe(genesis);
  });
});

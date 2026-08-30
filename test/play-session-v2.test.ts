import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceStateDir } from "../src/agent/runtime-paths.js";
import {
  PlaySessionStore,
  activePlaySessionSchema,
  playConversationIdForBranch,
  playSessionIdForBranch,
} from "../src/world/play-session.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-session-v2-"));
  roots.push(root);
  return root;
}

describe("PlaySession v2", () => {
  it("lazily migrates the v1 active pointer and branch record", async () => {
    const root = await workspace();
    const playRoot = path.join(workspaceStateDir(root), "world", "v1", "play");
    const legacy = {
      version: 1,
      branchId: "main",
      sourceId: "novel-1",
      actorId: "hero",
      lastCommitId: "commit-1",
      updatedAt: "2026-08-30T00:00:00.000Z",
    } as const;
    await fs.mkdir(path.join(playRoot, "instances"), { recursive: true });
    await fs.writeFile(path.join(playRoot, "active.json"), `${JSON.stringify(legacy)}\n`, "utf8");
    await fs.writeFile(path.join(playRoot, "instances", "main.json"), `${JSON.stringify(legacy)}\n`, "utf8");

    const session = await new PlaySessionStore(root).read();

    expect(session).toEqual({
      version: 2,
      id: "play-main",
      branchId: "main",
      sourceId: "novel-1",
      actorId: "hero",
      lastCommitId: "commit-1",
      title: "main",
      status: "active",
      conversationId: "conversation-main",
      createdAt: legacy.updatedAt,
      updatedAt: legacy.updatedAt,
    });
    const persisted = JSON.parse(await fs.readFile(path.join(playRoot, "active.json"), "utf8"));
    expect(activePlaySessionSchema.parse(persisted)).toEqual(session);
    expect(activePlaySessionSchema.parse(JSON.parse(
      await fs.readFile(path.join(playRoot, "instances", "main.json"), "utf8"),
    ))).toEqual(session);
  });

  it("keeps one active writer while preserving stable session identity", async () => {
    const root = await workspace();
    const store = new PlaySessionStore(root);
    const main = await store.write({
      branchId: "main",
      sourceId: "novel-1",
      actorId: "hero",
      lastCommitId: "commit-main",
      title: "Hero · Main",
    });
    const child = await store.write({
      branchId: "child",
      sourceId: "novel-1",
      actorId: "hero",
      lastCommitId: "commit-child",
    });

    expect(main.id).toBe(playSessionIdForBranch("main"));
    expect(main.conversationId).toBe(playConversationIdForBranch("main"));
    expect(child.status).toBe("active");
    expect(await store.read()).toMatchObject({ id: child.id, branchId: "child", status: "active" });
    expect(await store.readInstance("main")).toMatchObject({ id: main.id, title: "Hero · Main", status: "idle" });

    const reactivated = await store.activate(main.id);
    expect(reactivated).toMatchObject({ id: main.id, status: "active" });
    expect(await store.readInstance("child")).toMatchObject({ id: child.id, status: "idle" });
  });

  it("archives, restores, and removes presentation sessions without changing IDs", async () => {
    const root = await workspace();
    const store = new PlaySessionStore(root);
    const session = await store.write({
      branchId: "main",
      actorId: "hero",
      lastCommitId: "commit-1",
    });

    const archived = await store.updateMetadata(session.id, { title: "Archived hero", status: "archived" });
    expect(archived).toMatchObject({ id: session.id, title: "Archived hero", status: "archived" });
    await expect(store.read()).resolves.toBeNull();
    await expect(store.activate(session.id)).rejects.toThrow("Restore it before continuing");

    const restored = await store.restore(session.id);
    expect(restored).toMatchObject({ id: session.id, status: "idle" });
    await expect(store.activate(session.id)).resolves.toMatchObject({ id: session.id, status: "active" });

    await expect(store.removeSession(session.id)).resolves.toMatchObject({ id: session.id });
    await expect(store.getById(session.id)).resolves.toBeNull();
    await expect(store.read()).resolves.toBeNull();
  });

  it("detaches presentation history when its world instance is removed", async () => {
    const root = await workspace();
    const store = new PlaySessionStore(root);
    const main = await store.write({
      branchId: "main",
      sourceId: "novel-1",
      actorId: "hero",
      lastCommitId: "commit-main",
    });
    const child = await store.write({
      branchId: "child",
      sourceId: "novel-1",
      actorId: "hero",
      lastCommitId: "commit-child",
    });

    const result = await store.detachInstance("child");

    expect(result.detachedSession).toMatchObject({ id: child.id, branchId: "child", status: "detached" });
    expect(result.nextActiveSession).toMatchObject({ id: main.id, branchId: "main", status: "active" });
    await expect(store.getById(child.id)).resolves.toMatchObject({ status: "detached" });
    await expect(store.read()).resolves.toMatchObject({ id: main.id, status: "active" });
    await expect(store.activate(child.id)).rejects.toThrow("detached because its branch no longer exists");
  });
});

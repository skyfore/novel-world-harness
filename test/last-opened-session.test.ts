import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMostRecentlyActiveSession, readLastOpenedSession, writeLastOpenedSession } from "../src/agent/last-opened-session.js";
import { workspaceSessionDir } from "../src/agent/runtime-paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const root of temporaryDirectories.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("last-opened workspace transcript", () => {
  it("persists the transcript selected by the interactive user", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-last-opened-workspace-"));
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-last-opened-runtime-"));
    temporaryDirectories.push(root, runtimeDir);
    const sessionDir = workspaceSessionDir(root, runtimeDir);
    const sessionFile = path.join(sessionDir, "selected.jsonl");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(sessionFile, "{}\n", "utf8");

    await writeLastOpenedSession(root, runtimeDir, sessionFile);

    await expect(readLastOpenedSession(root, runtimeDir)).resolves.toBe(sessionFile);
  });

  it("ignores missing, corrupt, and out-of-scope transcript pointers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-last-opened-workspace-"));
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-last-opened-runtime-"));
    temporaryDirectories.push(root, runtimeDir);

    await expect(readLastOpenedSession(root, runtimeDir)).resolves.toBeUndefined();
    await expect(writeLastOpenedSession(root, runtimeDir, path.join(root, "outside.jsonl")))
      .rejects.toThrow("outside this workspace's transcript directory");

    const sessionDir = workspaceSessionDir(root, runtimeDir);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "last-opened.json"), "not-json\n", "utf8");
    await expect(readLastOpenedSession(root, runtimeDir)).resolves.toBeUndefined();
  });

  it("bootstraps from logical conversation activity instead of polluted file mtime", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-logical-recent-workspace-"));
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-logical-recent-runtime-"));
    temporaryDirectories.push(root, runtimeDir);
    const sessionDir = workspaceSessionDir(root, runtimeDir);
    await fs.mkdir(sessionDir, { recursive: true });
    const stickyMain = path.join(sessionDir, "main.jsonl");
    const actualLatest = path.join(sessionDir, "latest.jsonl");
    await fs.writeFile(stickyMain, [
      { type: "session", version: 3, id: "main", timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
      { type: "message", id: "main-message", parentId: null, timestamp: "2026-01-01T01:00:00.000Z", message: { role: "user", content: "old" } },
      { type: "session_info", id: "startup-touch", parentId: "main-message", timestamp: "2026-01-03T00:00:00.000Z", name: "main" },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    await fs.writeFile(actualLatest, [
      { type: "session", version: 3, id: "latest", timestamp: "2026-01-02T00:00:00.000Z", cwd: root },
      { type: "custom_message", id: "latest-play", parentId: null, timestamp: "2026-01-02T02:00:00.000Z", customType: "nwh-play", content: "latest", display: true },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    await fs.utimes(stickyMain, new Date("2026-01-04T00:00:00.000Z"), new Date("2026-01-04T00:00:00.000Z"));
    await fs.utimes(actualLatest, new Date("2026-01-02T02:00:00.000Z"), new Date("2026-01-02T02:00:00.000Z"));

    await expect(findMostRecentlyActiveSession(root, runtimeDir)).resolves.toBe(actualLatest);
  });
});

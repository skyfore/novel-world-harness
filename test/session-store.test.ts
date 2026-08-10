import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/agent/session-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const root of temporaryDirectories.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("persists and resumes the latest workspace-local session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-session-"));
    temporaryDirectories.push(root);
    const store = new SessionStore(root);
    const session = store.create("claude-test");
    session.messages.push({ role: "user", content: "hello" });
    await store.save(session);

    const resumed = await store.loadLatest();
    expect(resumed?.id).toBe(session.id);
    expect(resumed?.messages).toEqual([{ role: "user", content: "hello" }]);
    const stat = await fs.stat(path.join(root, ".novel-harness", "sessions", `${session.id}.json`));
    expect(stat.mode & 0o077).toBe(0);
  });

  it("rejects a tampered latest-session path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-session-"));
    temporaryDirectories.push(root);
    const stateDir = path.join(root, ".novel-harness");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, "latest-session"), "../../outside\n", "utf8");
    await expect(new SessionStore(root).loadLatest()).rejects.toThrow("session id is invalid");
  });
});

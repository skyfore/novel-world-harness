import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { LocalFileWorkspace } from "../src/workspace/local-files.js";
import { workspaceSessionDir } from "../src/agent/runtime-paths.js";
import { mockPiProvider } from "./helpers/pi-provider.js";

const roots: string[] = [];
const sessions: PiAgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.dispose();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it("resumes, appends and forks an actual 0.84.2 session while preserving the original", async () => {
  const fixture = new URL("./fixtures/pi-0.84.2/session.jsonl", import.meta.url);
  const original = await fs.readFile(fixture, "utf8");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-pi-legacy-"));
  roots.push(root);
  const runtimeDir = path.join(root, "runtime");
  const sessionDir = workspaceSessionDir(root, runtimeDir);
  await fs.mkdir(sessionDir, { recursive: true });
  const [rawHeader, ...entries] = original.trimEnd().split("\n");
  const header = JSON.parse(rawHeader) as { id: string; cwd: string; version: number };
  expect(header.version).toBe(3);
  const relocated = JSON.stringify({ ...header, cwd: root }) + "\n" + entries.join("\n") + "\n";
  const sessionFile = path.join(sessionDir, "legacy.jsonl");
  await fs.writeFile(sessionFile, relocated);
  const options = { workspace: await LocalFileWorkspace.create(root), runtimeDir,
    piAgentDir: path.join(root, "pi"), sessionId: header.id, saveSession: true,
    includeLocalTools: false, includeNwhExtension: false };
  const session = await PiAgentSession.create(options);
  sessions.push(session);
  const first = await mockPiProvider(session);
  await session.prompt("new 1.0 dialogue");
  expect(JSON.stringify(first.payloads)).toContain("LEGACY_VISIBLE_DIALOGUE");
  expect(JSON.stringify(first.payloads)).not.toMatch(/LEGACY_(?:PRIVATE|NATIVE|COMPILER|UNTRUSTED)/u);
  expect((await fs.readFile(sessionFile, "utf8")).startsWith(relocated)).toBe(true);
  expect(first.host.session.sessionManager.getEntries().some(entry => entry.type === "message" && entry.message.role === "system")).toBe(true);
  await session.dispose(); sessions.splice(sessions.indexOf(session), 1);

  const resumed = await PiAgentSession.create(options);
  sessions.push(resumed);
  const second = await mockPiProvider(resumed);
  await resumed.prompt("resume mixed history");
  expect(JSON.stringify(second.payloads)).toContain("new 1.0 dialogue");
  expect(JSON.stringify(second.payloads)).not.toContain("LEGACY_COMPILER_SECRET");
  const beforeFork = await fs.readFile(sessionFile, "utf8");
  const target = second.host.session.sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user")!;
  expect(await second.host.fork(target.id, { position: "at" })).toMatchObject({ cancelled: false });
  const forked = await mockPiProvider(resumed);
  await resumed.prompt("fork continuation");
  expect(forked.host.session.sessionFile).not.toBe(sessionFile);
  expect(await fs.readFile(sessionFile, "utf8")).toBe(beforeFork);
  expect(JSON.stringify(forked.payloads)).not.toMatch(/LEGACY_(?:PRIVATE|NATIVE|COMPILER|UNTRUSTED)/u);
  expect(await fs.readFile(fixture, "utf8")).toBe(original);
});

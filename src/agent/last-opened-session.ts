import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { workspaceSessionDir } from "./runtime-paths.js";

type LastOpenedSessionRecord = {
  version: 1;
  sessionFile: string;
  updatedAt: string;
};

function pointerPath(workspaceRoot: string, runtimeDir: string): string {
  return path.join(workspaceSessionDir(workspaceRoot, runtimeDir), "last-opened.json");
}

function validSessionFile(workspaceRoot: string, runtimeDir: string, candidate: unknown): string | undefined {
  if (typeof candidate !== "string") return undefined;
  const sessionDir = path.resolve(workspaceSessionDir(workspaceRoot, runtimeDir));
  const sessionFile = path.resolve(candidate);
  if (path.dirname(sessionFile) !== sessionDir || path.extname(sessionFile) !== ".jsonl") return undefined;
  return sessionFile;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function sessionActivity(content: string, workspaceRoot: string): { activity: number; created: number } | undefined {
  let cwd: string | undefined;
  let created = 0;
  let activity = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "session" && cwd === undefined) {
      cwd = typeof entry.cwd === "string" ? entry.cwd : undefined;
      created = timestamp(entry.timestamp) ?? 0;
      activity = created;
      continue;
    }
    const isVisibleConversationEntry = entry.type === "message"
      || (entry.type === "custom_message" && entry.display !== false)
      || entry.type === "compaction"
      || entry.type === "branch_summary";
    if (!isVisibleConversationEntry) continue;
    const message = entry.message && typeof entry.message === "object"
      ? entry.message as Record<string, unknown>
      : undefined;
    activity = Math.max(activity, timestamp(entry.timestamp) ?? 0, timestamp(message?.timestamp) ?? 0);
  }
  if (!cwd || path.resolve(cwd) !== path.resolve(workspaceRoot)) return undefined;
  return { activity, created };
}

export async function findMostRecentlyActiveSession(
  workspaceRoot: string,
  runtimeDir: string,
): Promise<string | undefined> {
  const sessionDir = workspaceSessionDir(workspaceRoot, runtimeDir);
  try {
    const candidates: Array<{ sessionFile: string; activity: number; created: number }> = [];
    for (const name of (await fs.readdir(sessionDir)).filter((entry) => entry.endsWith(".jsonl"))) {
      const sessionFile = path.join(sessionDir, name);
      const logical = sessionActivity(await fs.readFile(sessionFile, "utf8"), workspaceRoot);
      if (logical) candidates.push({ sessionFile, ...logical });
    }
    candidates.sort((left, right) => right.activity - left.activity
      || right.created - left.created
      || left.sessionFile.localeCompare(right.sessionFile));
    return candidates[0]?.sessionFile;
  } catch {
    return undefined;
  }
}

export async function readLastOpenedSession(
  workspaceRoot: string,
  runtimeDir: string,
): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(pointerPath(workspaceRoot, runtimeDir), "utf8")) as Partial<LastOpenedSessionRecord>;
    if (parsed.version !== 1) return undefined;
    const sessionFile = validSessionFile(workspaceRoot, runtimeDir, parsed.sessionFile);
    if (!sessionFile || !(await fs.stat(sessionFile)).isFile()) return undefined;
    return sessionFile;
  } catch {
    return undefined;
  }
}

export async function writeLastOpenedSession(
  workspaceRoot: string,
  runtimeDir: string,
  sessionFile: string,
): Promise<void> {
  const validated = validSessionFile(workspaceRoot, runtimeDir, sessionFile);
  if (!validated) throw new Error(`Session file is outside this workspace's transcript directory: ${sessionFile}`);
  const filePath = pointerPath(workspaceRoot, runtimeDir);
  const record: LastOpenedSessionRecord = {
    version: 1,
    sessionFile: validated,
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

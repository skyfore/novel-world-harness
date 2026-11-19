import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function nwhRuntimeDir(): string {
  return path.resolve(process.env.NWH_HOME ?? path.join(os.homedir(), ".novel-harness"));
}

export function workspaceSessionDir(workspaceRoot: string, runtimeDir = nwhRuntimeDir()): string {
  return path.join(path.resolve(runtimeDir), "sessions", workspaceRuntimeId(workspaceRoot));
}

export function workspaceStateDir(workspaceRoot: string, runtimeDir = nwhRuntimeDir()): string {
  return path.join(path.resolve(runtimeDir), "workspaces", "v1", workspaceRuntimeId(workspaceRoot));
}

/** Durable archives (legacy reference packs). Never purged by maintenance. */
export function workspaceArchiveDir(workspaceRoot: string, runtimeDir = nwhRuntimeDir()): string {
  return path.join(path.resolve(runtimeDir), "archives", workspaceRuntimeId(workspaceRoot));
}

/** The workspace state directory. A legacy in-workspace `.novel-harness` directory is never migrated (decision D5). */
export async function ensureWorkspaceState(workspaceRoot: string, runtimeDir = nwhRuntimeDir()): Promise<string> {
  return workspaceStateDir(workspaceRoot, runtimeDir);
}

function workspaceRuntimeId(workspaceRoot: string): string {
  const candidate = path.resolve(workspaceRoot);
  let resolvedRoot = candidate;
  try {
    resolvedRoot = realpathSync.native(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const label = path.basename(resolvedRoot).replace(/[^a-zA-Z0-9._-]+/g, "-") || "workspace";
  const identity = createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 12);
  return `${label}-${identity}`;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

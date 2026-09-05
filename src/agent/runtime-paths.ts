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

export function legacyWorkspaceStateDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".novel-harness");
}

export async function ensureWorkspaceState(workspaceRoot: string, runtimeDir = nwhRuntimeDir()): Promise<string> {
  const target = workspaceStateDir(workspaceRoot, runtimeDir);
  if (await isDirectory(target)) return target;
  const legacy = legacyWorkspaceStateDir(workspaceRoot);
  if (!(await isDirectory(legacy))) return target;

  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const staging = `${target}.${process.pid}.${Date.now()}.migrating`;
  try {
    await fs.cp(legacy, staging, { recursive: true, force: false, errorOnExist: true });
    await fs.chmod(staging, 0o700);
    try {
      await fs.rename(staging, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
      await fs.rm(staging, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  return target;
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

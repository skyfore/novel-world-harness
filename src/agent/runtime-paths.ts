import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export function nwhRuntimeDir(): string {
  return path.resolve(process.env.NWH_HOME ?? path.join(os.homedir(), ".novel-harness"));
}

export function workspaceSessionDir(workspaceRoot: string, runtimeDir = nwhRuntimeDir()): string {
  const resolvedRoot = path.resolve(workspaceRoot);
  const label = path.basename(resolvedRoot).replace(/[^a-zA-Z0-9._-]+/g, "-") || "workspace";
  const identity = createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 12);
  return path.join(path.resolve(runtimeDir), "sessions", `${label}-${identity}`);
}

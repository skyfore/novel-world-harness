import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { compileLoopDirectory } from "./state.js";

/** Shared, durable engineering identity. Never substitute the originating chat. */
export const dedicatedSessionSchema = z.object({
  version: z.literal(1), purpose: z.literal("nwh-rebuild-review"), threadId: z.string().uuid(),
  workspace: z.string(), sourceId: z.string(), model: z.string(), effort: z.literal("max"),
  createdAt: z.string().datetime(), lastUsedAt: z.string().datetime(),
}).strict();
export type DedicatedSession = z.infer<typeof dedicatedSessionSchema>;
export type EngineeringScope = Pick<DedicatedSession, "workspace" | "sourceId" | "model" | "effort">;
export const DEDICATED_SESSION_TTL_MS = 72 * 60 * 60_000;
/** New identities belong to the same workspace/source as their compilation.
 * Retain a matching legacy registry in place: resolving a path never migrates,
 * rotates, or replaces an already registered engineering session. */
export function dedicatedRegistryPath(root: string, sourceId: string): string {
  const scoped = path.join(compileLoopDirectory(root, sourceId), "engineering-session/reviewer-session.json");
  const records = path.join(root, "run-records"), matching: string[] = [];
  // Legacy directory labels are user data. Resolve ownership from each record,
  // never from a particular novel's name or by choosing the first match.
  if (fs.existsSync(records) && (!fs.lstatSync(records).isDirectory() || fs.lstatSync(records).isSymbolicLink()))
    throw new Error("DEDICATED_REGISTRY_INVALID: inspect the original run-records directory on its owning host; do not replace it or dispatch another session.");
  for (const entry of fs.existsSync(records) ? fs.readdirSync(records, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) : []) {
    if (entry.isSymbolicLink()) throw new Error("DEDICATED_REGISTRY_INVALID: inspect the linked historical directory on its owning host; do not follow it or dispatch another session.");
    if (!entry.isDirectory()) continue;
    const legacy = path.join(records, entry.name, "reviewer-session.json");
    if (!fs.existsSync(legacy)) {
      if (fs.lstatSync(legacy, { throwIfNoEntry: false })) throw new Error("DEDICATED_REGISTRY_INVALID: inspect the dangling registry link on its owning host; no replacement or dispatch.");
      continue;
    }
    if (!fs.lstatSync(legacy).isFile()) throw new Error("DEDICATED_REGISTRY_INVALID: inspect the original registry on its owning host; do not replace it or dispatch another session.");
    let previous: DedicatedSession;
    try { previous = dedicatedSessionSchema.parse(JSON.parse(fs.readFileSync(legacy, "utf8"))); }
    catch (error) { throw new Error(`DEDICATED_REGISTRY_INVALID: ${String(error)}. Inspect ${legacy} on its owning host; do not guess its source, replace it, or dispatch another session.`, { cause: error }); }
    if (previous.workspace === path.resolve(root) && previous.sourceId === sourceId) matching.push(legacy);
  }
  if (matching.length > 1 || (matching.length && fs.existsSync(scoped))) throw new Error("DEDICATED_REGISTRY_CONFLICT: multiple registries claim this source; inspect their original UUIDs and history before dispatch, never guess or replace any registry.");
  return matching[0] ?? scoped;
}

/** Protect the current registry directory (including absent future records) and
 * any retained checkout history. Fresh workspaces need not contain run-records. */
export function dedicatedHistoryPaths(root: string, registryFile: string): string[] {
  const records = path.join(root, "run-records");
  return [path.dirname(registryFile), ...(fs.existsSync(records) ? [records] : [])];
}
export const fileHash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Unlike the source baseline, audit capture does not exclude run-records. */
export function captureRecordTree(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(directory)) return result;
  const visit = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error("DEDICATED_AUDIT_SYMLINK: inspect original records; no dispatch.");
      if (item.isDirectory()) visit(file);
      else if (item.isFile()) result[path.relative(directory, file)] = fileHash(file);
    }
  };
  visit(directory); return result;
}

export function dedicatedSessionMode(session: DedicatedSession | null, scope: EngineeringScope, now: number) {
  if (!session) return "create" as const;
  for (const key of ["workspace", "sourceId", "model", "effort"] as const) {
    if (session[key] !== scope[key]) throw new Error(`DEDICATED_SESSION_SCOPE_CHANGED: ${key}; inspect the original registry, do not rotate or retry.`);
  }
  const age = now - Date.parse(session.createdAt);
  if (!Number.isFinite(age) || age < 0) throw new Error("DEDICATED_SESSION_CLOCK_INVALID: preserve the registry and inspect the owning host.");
  return age > DEDICATED_SESSION_TTL_MS ? "rotate" as const : "resume" as const;
}

export function dedicatedSessionArgs(scope: EngineeringScope, session: DedicatedSession | null, now: number,
  schema: string, output: string, readOnly = false): string[] {
  const resume = dedicatedSessionMode(session, scope, now) === "resume";
  return ["exec", ...(resume ? ["resume"] : ["--cd", scope.workspace]), "--model", scope.model,
    "-c", 'model_reasoning_effort="max"', "-c", `sandbox_mode="${readOnly ? "read-only" : "workspace-write"}"`,
    "-c", 'approval_policy="never"', "--json", "--output-schema", schema, "--output-last-message", output,
    ...(resume ? [session!.threadId] : []), "-"];
}

export function acceptDedicatedSession(scope: EngineeringScope, previous: DedicatedSession | null, id: string, now: number): DedicatedSession {
  z.string().uuid().parse(id);
  const mode = dedicatedSessionMode(previous, scope, now);
  if ((mode === "resume" && previous!.threadId !== id) || (mode === "rotate" && previous!.threadId === id)) {
    throw new Error("DEDICATED_SESSION_ID_CHANGED: a resume must keep the UUID and a rotation must create a different UUID; never renew creation time.");
  }
  return { version: 1, purpose: "nwh-rebuild-review", ...scope, threadId: id,
    createdAt: mode === "resume" ? previous!.createdAt : new Date(now).toISOString(), lastUsedAt: new Date(now).toISOString() };
}

/** The child may only write its result directory; all world/history paths are
 * OS read-only and network dispatch is disabled during inspect/verify. */
export function readOnlyNodeArgs(root: string, outputDirectory: string, nodeArgs: string[]): string[] {
  return ["--die-with-parent", "--unshare-user", "--cap-drop", "ALL", "--unshare-net", "--ro-bind", "/", "/", "--bind", outputDirectory, outputDirectory,
    "--chdir", root, "--setenv", "TSX_DISABLE_CACHE", "1", "--setenv", "TMPDIR", outputDirectory,
    "--", process.execPath, ...nodeArgs];
}

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nwhRuntimeDir } from "../agent/runtime-paths.js";
import { WORLD_STORAGE_VERSION } from "../world/paths.js";
import { CACHE_FORMAT_VERSION } from "../compiler/prepared-cache.js";

/**
 * Legacy data purge (iteration 02, design 6.1 step 3). Preview first, then
 * execute only with the exact plan hash. Generic over every workspace under
 * $NWH_HOME; it never touches `sources/` (immutable source bytes) or
 * `archives/` (reference packs), the current world namespace, project
 * registrations, sessions or Pi login state.
 */
export type LegacyPurgeItem = {
  kind: "world-namespace" | "prepared-cache" | "compile-loops" | "trace-runs" | "temporary-workspace";
  path: string;
  bytes: number;
  detail: string;
  /** Trace runs only: index entries removed with the run directories. */
  runIds?: string[];
};
export type LegacyPurgePlan = { runtimeDir: string; currentWorld: string; items: LegacyPurgeItem[]; totalBytes: number; planHash: string };

const LEGACY_WORLD = /^v[0-9]+$/u;
const PROTECTED = new Set(["sources", "archives"]);

async function exists(target: string): Promise<boolean> {
  try { await fs.access(target); return true; } catch { return false; }
}
async function sizeOf(target: string): Promise<number> {
  let total = 0;
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  for (const entry of await fs.readdir(target, { withFileTypes: true })) total += await sizeOf(path.join(target, entry.name));
  return total;
}
const worldRank = (name: string) => Number(name.slice(1));

/** Is only empty structure, locks or a source registry left once legacy items are gone? */
async function emptyAfterPurge(workspace: string, purged: Set<string>): Promise<boolean> {
  for (const entry of await fs.readdir(workspace, { withFileTypes: true })) {
    const full = path.join(workspace, entry.name);
    if (purged.has(full) || entry.name === "locks") continue;
    if (entry.name === "world") {
      const versions = await fs.readdir(full).catch(() => []);
      if (versions.some((version) => !purged.has(path.join(full, version)))) return false;
      continue;
    }
    if (entry.name === "sources") continue;
    return false;
  }
  return true;
}

export async function planLegacyPurge(options: { runtimeDir?: string } = {}): Promise<LegacyPurgePlan> {
  const runtimeDir = path.resolve(options.runtimeDir ?? nwhRuntimeDir());
  const current = worldRank(WORLD_STORAGE_VERSION);
  const items: LegacyPurgeItem[] = [];
  const workspaces = path.join(runtimeDir, "workspaces", "v1");
  for (const name of (await fs.readdir(workspaces).catch(() => [])).sort()) {
    const workspace = path.join(workspaces, name);
    if (!(await fs.stat(workspace)).isDirectory()) continue;
    const purged = new Set<string>();
    const add = async (item: Omit<LegacyPurgeItem, "bytes">) => { items.push({ ...item, bytes: await sizeOf(item.path) }); purged.add(item.path); };
    const world = path.join(workspace, "world");
    for (const version of (await fs.readdir(world).catch(() => [])).sort()) {
      if (LEGACY_WORLD.test(version) && worldRank(version) < current) await add({ kind: "world-namespace", path: path.join(world, version), detail: `${name}: world/${version} (superseded by ${WORLD_STORAGE_VERSION})` });
    }
    const loops = path.join(workspace, "compile-loops");
    if (await exists(loops)) await add({ kind: "compile-loops", path: loops, detail: `${name}: outer engineering-loop records` });
    // Trace runs started before this workspace's current namespace existed belong to the retired compile.
    const observability = path.join(workspace, "observability", "v1");
    const indexFile = path.join(observability, "indexes", "runs.json");
    if (await exists(indexFile)) {
      const currentWorld = path.join(world, WORLD_STORAGE_VERSION);
      const cutoff = (await fs.stat(currentWorld).catch(() => null))?.birthtime.toISOString() ?? new Date().toISOString();
      const index = JSON.parse(await fs.readFile(indexFile, "utf8")) as { runs?: Array<{ id: string; relativePath: string; startedAt: string }> };
      const old = (index.runs ?? []).filter((run) => run.startedAt < cutoff);
      if (old.length && old.length === (index.runs ?? []).length) {
        // Every run is legacy: the whole store goes, including its content-addressed blobs.
        await add({ kind: "trace-runs", path: path.join(workspace, "observability"), detail: `${name}: all ${old.length} trace runs (and their blobs) started before ${cutoff}` });
      } else if (old.length) {
        let bytes = 0;
        for (const run of old) bytes += await sizeOf(path.join(observability, run.relativePath));
        items.push({ kind: "trace-runs", path: observability, bytes, detail: `${name}: ${old.length} of ${(index.runs ?? []).length} trace runs started before ${cutoff}; unreferenced blobs are collected`, runIds: old.map((run) => run.id).sort() });
      }
    }
    if (!(await exists(path.join(workspace, "project.json"))) && await emptyAfterPurge(workspace, purged)) {
      // An unregistered workspace holding nothing current is a leftover temporary workspace.
      for (const index of items.map((item, position) => [item, position] as const).filter(([item]) => item.path.startsWith(`${workspace}${path.sep}`)).map(([, position]) => position).reverse()) items.splice(index, 1);
      items.push({ kind: "temporary-workspace", path: workspace, bytes: await sizeOf(workspace), detail: `${name}: unregistered workspace with no current namespace` });
    }
  }
  const prepared = path.join(runtimeDir, "prepared-novels");
  for (const version of (await fs.readdir(prepared).catch(() => [])).sort()) {
    if (LEGACY_WORLD.test(version) && version !== currentCacheVersion()) items.push({ kind: "prepared-cache", path: path.join(prepared, version), bytes: await sizeOf(path.join(prepared, version)), detail: `prepared-novels/${version} (legacy cache format)` });
  }
  for (const item of items) {
    const relative = path.relative(runtimeDir, item.path).split(path.sep);
    if (PROTECTED.has(relative[0]!) || relative[0] === "..") throw new Error(`Refusing to plan a protected path: ${item.path}`);
  }
  const planHash = crypto.createHash("sha256").update(JSON.stringify(items.map(({ kind, path: target, runIds }) => ({ kind, target, runIds })))).digest("hex");
  return { runtimeDir, currentWorld: WORLD_STORAGE_VERSION, items, totalBytes: items.reduce((total, item) => total + item.bytes, 0), planHash };
}

/** The prepared-cache directory name the current code reads. */
export function currentCacheVersion(): string { return `v${CACHE_FORMAT_VERSION}`; }

/** Execute exactly the previewed plan. A changed plan (new data, a different set) refuses to run. */
export async function executeLegacyPurge(confirmHash: string, options: { runtimeDir?: string } = {}): Promise<{ removed: LegacyPurgeItem[]; freedBytes: number }> {
  const plan = await planLegacyPurge(options);
  if (plan.planHash !== confirmHash) throw new Error(`LEGACY_PURGE_PLAN_CHANGED: preview again; the current plan hash is ${plan.planHash}.`);
  for (const item of plan.items) {
    if (item.kind === "trace-runs" && item.runIds) {
      const indexFile = path.join(item.path, "indexes", "runs.json");
      const index = JSON.parse(await fs.readFile(indexFile, "utf8")) as { version: number; runs: Array<{ id: string; relativePath: string }> };
      const remove = new Set(item.runIds ?? []);
      for (const run of index.runs.filter((entry) => remove.has(entry.id))) await fs.rm(path.join(item.path, run.relativePath), { recursive: true, force: true });
      const temporary = `${indexFile}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify({ ...index, runs: index.runs.filter((entry) => !remove.has(entry.id)) }, null, 2)}\n`);
      await fs.rename(temporary, indexFile);
      await collectUnreferencedBlobs(item.path, index.runs.filter((entry) => !remove.has(entry.id)).map((entry) => entry.relativePath));
    } else {
      await fs.rm(item.path, { recursive: true, force: true });
    }
  }
  return { removed: plan.items, freedBytes: plan.totalBytes };
}

/** Remove blobs no surviving run's events reference (blobs are content-addressed and shared). */
async function collectUnreferencedBlobs(observability: string, survivingRuns: readonly string[]): Promise<void> {
  const referenced = new Set<string>();
  for (const run of survivingRuns) {
    const events = await fs.readFile(path.join(observability, run, "events.jsonl"), "utf8").catch(() => "");
    for (const match of events.matchAll(/"sha256":"([a-f0-9]{64})"/gu)) referenced.add(match[1]!);
  }
  const blobs = path.join(observability, "blobs", "sha256");
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      const digest = entry.name.replace(/\.json$/u, "");
      if (/^[a-f0-9]{64}$/u.test(digest) && !referenced.has(digest)) await fs.rm(full, { force: true });
    }
  };
  await walk(blobs);
}

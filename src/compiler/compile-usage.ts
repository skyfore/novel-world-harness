import fs from "node:fs/promises";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import type { CompileUsage } from "./world-completeness.js";

type IndexEntry = { id: string; relativePath: string; startedAt: string; kind: string; sourceId?: string };
type ManifestUsage = { input?: number; output?: number; cacheRead?: number; cost?: number };

/**
 * Model usage the compile of one source has recorded in its trace runs.
 * Read-only: it parses the run index and manifests directly instead of
 * initialising the trace store, which would reconcile interrupted runs.
 */
export async function summarizeCompileUsage(workspaceRoot: string, sourceId: string, options: { since?: string } = {}): Promise<CompileUsage | null> {
  const root = path.join(workspaceStateDir(workspaceRoot), "observability", "v1");
  let entries: IndexEntry[];
  try {
    const index = JSON.parse(await fs.readFile(path.join(root, "indexes", "runs.json"), "utf8")) as { runs?: IndexEntry[] };
    entries = (index.runs ?? []).filter((entry) => entry.kind === "prepare" && entry.sourceId === sourceId && (!options.since || entry.startedAt >= options.since));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const usage: CompileUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, nominalUsd: 0, runs: 0 };
  for (const entry of entries) {
    let manifest: { usage?: ManifestUsage };
    try { manifest = JSON.parse(await fs.readFile(path.join(root, entry.relativePath, "manifest.json"), "utf8")) as { usage?: ManifestUsage }; }
    catch { continue; }
    usage.runs += 1;
    usage.inputTokens += manifest.usage?.input ?? 0;
    usage.outputTokens += manifest.usage?.output ?? 0;
    usage.cacheReadTokens += manifest.usage?.cacheRead ?? 0;
    usage.nominalUsd += manifest.usage?.cost ?? 0;
  }
  return usage.runs ? usage : null;
}

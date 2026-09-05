import { stdout } from "node:process";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { RepairRunStore } from "../compiler/repair-run.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { InitialWorldStore } from "../world/initial.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../compiler/batches.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { prepareAllCommand } from "./prepare-all.js";
import { repairExistingCommand, type RepairExistingCommandOptions } from "./repair-existing.js";

/** Build a reviewable world; expensive compiler progress is independent of Play certification. */
export async function rebuildCommand(options: RepairExistingCommandOptions): Promise<void> {
  if (options.acquireLock !== false) return withWorkspaceOperationLock(options.root, "compiler", () => rebuildCommand({ ...options, acquireLock: false }));
  options.signal?.throwIfAborted();
  const sources = await (await WorkspaceStore.create(options.root)).listSources();
  const source = options.sourceId ? sources.find((item) => item.id === options.sourceId) : sources.length === 1 ? sources[0] : undefined;
  if (!source) throw new Error(`REBUILD_SOURCE_REQUIRED: select --source from registered sources: ${sources.map((item) => item.id).join(", ") || "(none; ingest the original novel first)"}`);
  const cache = new PreparedNovelCache(options.root, options.cacheRoot), journal = await new RepairRunStore(options.root).read(source.id);
  const active = await cache.lookup(source);
  let parent = journal?.baselineBundleHash ?? options.fromRevision ?? active.bundleHash;
  if (!parent) {
    const initial = await new InitialWorldStore(options.root).get();
    const batches = await prepareCompilerBatches(options.root, source), progress = await new CompilerBatchStore(options.root).read(source.id);
    if (!initial?.evidence.some((reference) => reference.span.sourceId === source.id) || batches.some((batch) => !progress.completedBatchIds.includes(batch.id))) {
      if (options.chapters) throw new Error("REBUILD_BASELINE_REQUIRED: chapter rebuild requires an existing complete candidate; first rebuild the whole source");
      await prepareAllCommand({ ...options, sourceId: source.id, yes: true, candidateOnly: true, createBranch: false, restoreCache: false, acquireLock: false });
      const candidate = await cache.archiveCandidate(source);
      stdout.write(`${JSON.stringify({ sourceId: source.id, candidateBundleHash: candidate.bundleHash, activeBundleHash: (await cache.lookup(source)).bundleHash ?? null }, null, 2)}\n`);
      return;
    }
    parent = (await cache.archiveCandidate(source)).bundleHash;
  }
  const result = await repairExistingCommand({ ...options, sourceId: source.id, fromRevision: parent, candidateOnly: true, acquireLock: false });
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

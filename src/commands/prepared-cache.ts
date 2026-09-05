import { stdout } from "node:process";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { describePreparedRoles } from "../world/play-roles.js";

export async function listPreparedCacheRevisionsCommand(root: string, sourceId?: string): Promise<void> {
  const source = await resolveSource(root, sourceId);
  const revisions = await new PreparedNovelCache(root).listRevisions(source);
  if (!revisions.length) {
    stdout.write(`No prepared revisions for ${source.contentMd5 ?? source.id}.\n`);
    return;
  }
  for (const revision of revisions) {
    const lineage = revision.lineage
      ? `\t${revision.lineage.operation}\tparent=${revision.lineage.parentBundleHash}\trun=${revision.lineage.runId}`
      : "";
    stdout.write(`${revision.active ? "active" : "stored"}\t${revision.bundleHash}\t${revision.createdAt}\t${revision.cachePath}${lineage}\n`);
  }
}

export async function activatePreparedCacheRevisionCommand(root: string, bundleHash: string, sourceId?: string): Promise<void> {
  await withWorkspaceOperationLock(root, "compiler", async () => {
    const source = await resolveSource(root, sourceId);
    const result = await new PreparedNovelCache(root).activate(source, bundleHash);
    stdout.write(`Activated prepared revision ${result.bundleHash} for ${result.contentMd5}; existing branches remain pinned to their captured preparation context.\n`);
  });
}

export async function inspectNovelClosureCommand(root: string, sourceId?: string): Promise<void> {
  await withWorkspaceOperationLock(root, "compiler", async () => {
    const source = await resolveSource(root, sourceId);
    const { bundle, assessment } = await new PreparedNovelCache(root).inspectCandidate(source);
    stdout.write(`${JSON.stringify({ ...assessment, roles: describePreparedRoles(bundle, assessment) }, null, 2)}\n`);
  });
}

async function resolveSource(root: string, sourceId?: string): Promise<SourceDocument> {
  const sources = await (await WorkspaceStore.create(root)).listSources();
  const source = sourceId ? sources.find((candidate) => candidate.id === sourceId) : sources.length === 1 ? sources[0] : undefined;
  if (source) return source;
  if (!sources.length) throw new Error("No ingested sources. Run nwh ingest first.");
  if (sourceId) throw new Error(`Unknown source id: ${sourceId}`);
  throw new Error(`Multiple sources are registered; specify --source. Available: ${sources.map((item) => item.id).join(", ")}`);
}

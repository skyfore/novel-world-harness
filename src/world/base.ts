import { WorkspaceStore } from "../storage/workspace-store.js";
import { SourceMaterialStore } from "../storage/source-material-store.js";
import { deepFreeze } from "../util/immutable.js";
import { frozenWorldBaseSchema, type FrozenWorldBase } from "./base-schema.js";
import { WorldContextStore } from "./context.js";
import { BranchStore, WorldObjectStore } from "./store.js";

export { frozenWorldBaseSchema, type FrozenWorldBase } from "./base-schema.js";

/** Resolve and integrity-check the frozen base pinned by one modern branch. */
export async function readFrozenWorldBase(
  workspaceRoot: string,
  branchId: string,
): Promise<Readonly<FrozenWorldBase>> {
  const branches = new BranchStore(workspaceRoot);
  const objects = new WorldObjectStore(workspaceRoot);
  const branch = await branches.read(branchId);
  if (!branch.sourceId || !branch.preparedRevisionHash) {
    throw new Error(`Instance '${branchId}' is legacy or unpinned and has no frozen world base identity.`);
  }
  const source = await (await WorkspaceStore.create(workspaceRoot)).getSource(branch.sourceId);
  if (!source) throw new Error(`Frozen world base source '${branch.sourceId}' is not registered.`);
  if (source.id !== branch.sourceId || !source.contentSha256.startsWith(branch.sourceId)) {
    throw new Error(`Frozen world base source identity '${branch.sourceId}' failed its content-address check.`);
  }
  if (!await new SourceMaterialStore().read(source)) {
    throw new Error(`Frozen world base source bytes '${source.contentSha256}' are missing from immutable storage.`);
  }
  const head = await objects.getCommit(branch.headCommitId);
  if (!head.canonicalSnapshotHash) {
    throw new Error(`Instance '${branchId}' head has no canonical snapshot identity.`);
  }
  const context = await new WorldContextStore(workspaceRoot).load(head.canonicalSnapshotHash);
  if (context.sourceId !== branch.sourceId) {
    throw new Error(
      `Instance '${branchId}' source '${branch.sourceId}' does not match frozen snapshot source '${context.sourceId ?? "unscoped"}'.`,
    );
  }
  if (context.preparedRevisionHash !== branch.preparedRevisionHash) {
    throw new Error(
      `Instance '${branchId}' prepared revision '${branch.preparedRevisionHash}' does not match `
      + `frozen snapshot revision '${context.preparedRevisionHash ?? "unprepared"}'.`,
    );
  }
  return deepFreeze(frozenWorldBaseSchema.parse({
    version: 1,
    sourceId: branch.sourceId,
    sourceContentSha256: source.contentSha256,
    preparedRevisionHash: branch.preparedRevisionHash,
    canonicalSnapshotHash: head.canonicalSnapshotHash,
  }));
}

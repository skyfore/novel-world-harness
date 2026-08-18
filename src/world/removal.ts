import fs from "node:fs/promises";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { CompilerBatchStore } from "../compiler/batches.js";
import { BoundaryCalibrationStore } from "../compiler/boundary-calibration.js";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { SegmentStore } from "../compiler/segments.js";
import { ChapterSplitPlanStore } from "../compiler/chapter-split.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { ActorModelStore } from "./actors.js";
import { CanonicalModelStore, ProposalStore } from "./canonical-model.js";
import { InitialWorldStore } from "./initial.js";
import { PlaySessionStore, type ActivePlaySession } from "./play-session.js";
import { inspectPlayExperience, resolveNovelSource } from "./play-experience.js";
import { PossibilityTemplateStore } from "./possibility-model.js";
import { BranchStore } from "./store.js";

export type InstanceRemovalResult = {
  branchId: string;
  sourceId?: string;
  nextActiveSession: ActivePlaySession | null;
};

export type NovelAnalysisRemovalResult = {
  source: SourceDocument;
  canonicalArtifacts: number;
  actorArtifacts: number;
  possibilities: number;
  proposals: number;
  initialWorld: boolean;
  evidenceIndex: boolean;
  compilerProgress: boolean;
  preparedCache: boolean;
};

export type NovelRemovalResult = {
  source: SourceDocument;
  removedBranchIds: string[];
  analysis: NovelAnalysisRemovalResult;
  sourceUnregistered: boolean;
};

export async function removeWorldInstance(root: string, branchId: string): Promise<InstanceRemovalResult> {
  const catalog = await inspectPlayExperience(root);
  const instance = catalog.instances.find((candidate) => candidate.branchId === branchId);
  if (!instance) throw new Error(`Unknown instance '${branchId}'. Use /instances to list playable instances.`);

  await new BranchStore(root).remove(branchId);
  const nextActiveSession = await new PlaySessionStore(root).removeInstance(branchId);
  await fs.rm(path.join(workspaceStateDir(root), "world", "v1", "frontier", branchId), {
    recursive: true,
    force: true,
  });
  return {
    branchId,
    ...(instance.sourceId ? { sourceId: instance.sourceId } : {}),
    nextActiveSession,
  };
}

export async function removeNovelAnalysis(
  root: string,
  sourceInput: string | SourceDocument,
  options: { cacheRoot?: string } = {},
): Promise<NovelAnalysisRemovalResult> {
  const workspace = await WorkspaceStore.create(root);
  const source = typeof sourceInput === "string"
    ? await resolveNovelSource(workspace, sourceInput)
    : sourceInput;
  const sourceId = source.id;
  const canonical = new CanonicalModelStore(root);
  const actors = new ActorModelStore(root);
  const possibilities = new PossibilityTemplateStore(root);

  let canonicalArtifacts = 0;
  for (const entity of await canonical.listEntities()) {
    if (!containsSourceEvidence(entity, sourceId)) continue;
    const evidence = withoutSourceEvidence(entity, sourceId);
    if (evidence.length) await canonical.putEntity({ ...entity, evidence });
    else await canonical.removeCurrent("entities", entity.id);
    canonicalArtifacts += 1;
  }
  for (const claim of await canonical.listClaims()) {
    if (!containsSourceEvidence(claim, sourceId)) continue;
    const evidence = withoutSourceEvidence(claim, sourceId);
    if (evidence.length) await canonical.putClaim({ ...claim, evidence });
    else await canonical.removeCurrent("claims", claim.id);
    canonicalArtifacts += 1;
  }
  for (const event of await canonical.listEvents()) {
    if (!containsSourceEvidence(event, sourceId)) continue;
    const evidence = withoutSourceEvidence(event, sourceId);
    if (evidence.length) await canonical.putEvent({ ...event, evidence });
    else await canonical.removeCurrent("events", event.id);
    canonicalArtifacts += 1;
  }
  for (const rule of await canonical.listRules()) {
    if (!containsSourceEvidence(rule, sourceId)) continue;
    const evidence = withoutSourceEvidence(rule, sourceId);
    if (evidence.length) await canonical.putRule({ ...rule, evidence });
    else await canonical.removeCurrent("rules", rule.id);
    canonicalArtifacts += 1;
  }

  let actorArtifacts = 0;
  for (const goal of await actors.listGoals()) {
    if (!containsSourceEvidence(goal, sourceId)) continue;
    const evidence = withoutSourceEvidence(goal, sourceId);
    if (evidence.length) await actors.putGoal({ ...goal, evidence });
    else await actors.removeGoal(goal.id);
    actorArtifacts += 1;
  }
  for (const model of await actors.listModels()) {
    if (!containsSourceEvidence(model, sourceId)) continue;
    const evidence = withoutSourceEvidence(model, sourceId);
    if (evidence.length) await actors.putModel({ ...model, evidence });
    else await actors.removeModel(model.actorId);
    actorArtifacts += 1;
  }

  let possibilityCount = 0;
  for (const possibility of await possibilities.list()) {
    if (!containsSourceEvidence(possibility, sourceId)) continue;
    const evidence = withoutSourceEvidence(possibility, sourceId);
    if (evidence.length) await possibilities.put({ ...possibility, evidence });
    else await possibilities.remove(possibility.id);
    possibilityCount += 1;
  }

  const initialWorldStore = new InitialWorldStore(root);
  const initialWorld = await initialWorldStore.get();
  const removedInitialWorld = Boolean(initialWorld && containsSourceEvidence(initialWorld, sourceId));
  if (initialWorld && removedInitialWorld) {
    const evidence = withoutSourceEvidence(initialWorld, sourceId);
    if (evidence.length) await initialWorldStore.put({ ...initialWorld, evidence });
    else await initialWorldStore.clear();
  }

  const segments = new SegmentStore(root);
  const evidenceIndex = Boolean(await segments.readManifest(sourceId));
  await segments.remove(sourceId);
  await new ChapterSplitPlanStore(root).remove(sourceId);

  const batchStore = new CompilerBatchStore(root);
  const boundaryStore = new BoundaryCalibrationStore(root);
  const compilerProgress = (await batchStore.read(sourceId)).updatedAt !== new Date(0).toISOString()
    || (await boundaryStore.list(sourceId)).length > 0;
  await batchStore.reset(sourceId);
  await boundaryStore.reset(sourceId);

  const proposals = await new ProposalStore(root).removeForSource(sourceId);
  const preparedCache = await new PreparedNovelCache(root, options.cacheRoot).remove(source);

  return {
    source,
    canonicalArtifacts,
    actorArtifacts,
    possibilities: possibilityCount,
    proposals,
    initialWorld: removedInitialWorld,
    evidenceIndex,
    compilerProgress,
    preparedCache,
  };
}

export async function removeNovel(
  root: string,
  sourceInput: string | SourceDocument,
  options: { cacheRoot?: string } = {},
): Promise<NovelRemovalResult> {
  const workspace = await WorkspaceStore.create(root);
  const source = typeof sourceInput === "string"
    ? await resolveNovelSource(workspace, sourceInput)
    : sourceInput;
  const catalog = await inspectPlayExperience(root);
  const branches = new BranchStore(root);
  const removing = new Set(
    catalog.instances
      .filter((instance) => instance.sourceId === source.id)
      .map((instance) => instance.branchId),
  );

  for (const branchId of removing) await branches.assertRemovable(branchId, removing);
  const removalOrder = childFirstBranchOrder(
    catalog.instances
      .filter((instance) => removing.has(instance.branchId))
      .map((instance) => ({ id: instance.branchId, parentId: instance.parentBranchId })),
  );

  const analysis = await removeNovelAnalysis(root, source, options);
  for (const branchId of removalOrder) await removeWorldInstance(root, branchId);
  const sourceUnregistered = await workspace.unregisterSource(source.id);
  return { source, removedBranchIds: removalOrder, analysis, sourceUnregistered };
}

function containsSourceEvidence(
  artifact: { evidence: readonly { span: { sourceId: string } }[] },
  sourceId: string,
): boolean {
  return artifact.evidence.some((reference) => reference.span.sourceId === sourceId);
}

function withoutSourceEvidence<T extends { span: { sourceId: string } }>(
  artifact: { evidence: readonly T[] },
  sourceId: string,
): T[] {
  return artifact.evidence.filter((reference) => reference.span.sourceId !== sourceId);
}

function childFirstBranchOrder(branches: readonly { id: string; parentId?: string }[]): string[] {
  const remaining = new Map(branches.map((branch) => [branch.id, branch]));
  const ordered: string[] = [];
  while (remaining.size) {
    const parents = new Set([...remaining.values()].flatMap((branch) => branch.parentId ? [branch.parentId] : []));
    const leaves = [...remaining.keys()].filter((id) => !parents.has(id)).sort();
    if (!leaves.length) throw new Error("Cannot remove novel instances because their parent graph contains a cycle.");
    for (const id of leaves) {
      remaining.delete(id);
      ordered.push(id);
    }
  }
  return ordered;
}

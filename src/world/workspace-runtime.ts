import { ActorModelStore, deterministicActorProposalSource } from "./actors.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { canonicalEventToPossibility } from "./canon-runtime.js";
import { loadWorldContext, type ScopedWorldArtifacts } from "./context.js";
import { WorldEngine } from "./engine.js";
import { PossibilityTemplateStore } from "./possibility-model.js";
import { WorldRuntime, type NarrativeRender, type PossibilitySource } from "./runtime.js";
import { contextContainsGroundedArtifacts, evidenceBelongsExclusivelyToSource, inferLegacyBranchSourceId } from "./source-scope.js";
import type { EvidenceRef } from "./model.js";

export type WorkspaceWorld = {
  engine: WorldEngine;
  runtime: WorldRuntime;
  actorModels: ActorModelStore;
  possibilityTemplates: PossibilityTemplateStore;
};

export type WorkspaceWorldOpenOptions = {
  sourceId?: string;
  preparedRevisionHash?: string;
  artifacts?: ScopedWorldArtifacts;
};

export async function openWorkspaceWorld(
  workspaceRoot: string,
  render?: NarrativeRender,
  options: WorkspaceWorldOpenOptions = {},
): Promise<WorkspaceWorld> {
  await WorkspaceStore.create(workspaceRoot);
  const { context, contexts } = await loadWorldContext(workspaceRoot, options);
  const engine = new WorldEngine(workspaceRoot, context, (snapshotHash) => contexts.load(snapshotHash));
  const actorModels = new ActorModelStore(workspaceRoot);
  const possibilityTemplates = new PossibilityTemplateStore(workspaceRoot);
  const possibilitySource: PossibilitySource = async ({ branchId, commitId }) => {
    const [commitContext, branch] = await Promise.all([
      engine.contextForCommit(commitId),
      engine.branches.read(branchId),
    ]);
    if (branch.sourceId && commitContext.sourceId && branch.sourceId !== commitContext.sourceId) {
      throw new Error(`Branch source '${branch.sourceId}' does not match committed context '${commitContext.sourceId}'.`);
    }
    const sourceId = branch.sourceId
      ?? commitContext.sourceId
      ?? await inferLegacyBranchSourceId(engine, commitId);
    // An unscoped legacy branch in a multi-novel context has no trustworthy
    // ownership boundary. Disabling automatic possibilities is safer than
    // scheduling canon or background pressure from an unrelated novel.
    if (!sourceId && contextContainsGroundedArtifacts(commitContext)) return [];
    const belongsToActiveWorld = (item: { evidence: readonly EvidenceRef[] }) => sourceId
      ? evidenceBelongsExclusivelyToSource(item.evidence, sourceId)
      : item.evidence.length === 0;
    const templates = (commitContext.possibilityTemplates ?? await possibilityTemplates.list())
      .filter(belongsToActiveWorld)
      .map((template) => ({ ...template, branchId, evaluatedAtCommit: commitId }));
    const events = [...(commitContext.events?.values() ?? [])]
      .filter(belongsToActiveWorld);
    const canonical = events.map((event) => canonicalEventToPossibility(
      event,
      branchId,
      commitId,
      commitContext.eventRelations ?? [],
    ));
    const byId = new Map(canonical.map((possibility) => [possibility.id, possibility]));
    for (const template of templates) {
      if (template.id.startsWith("canon-")) {
        throw new Error(`Possibility template ${template.id} uses the reserved canonical-derived namespace`);
      }
      if (byId.has(template.id)) {
        throw new Error(`Duplicate possibility id ${template.id} would shadow a canonical-derived possibility`);
      }
      byId.set(template.id, template);
    }
    return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  };
  const runtime = new WorldRuntime(
    engine,
    possibilitySource,
    render,
    deterministicActorProposalSource(engine, actorModels),
  );
  return { engine, runtime, actorModels, possibilityTemplates };
}

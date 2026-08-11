import { ActorModelStore, deterministicActorProposalSource } from "./actors.js";
import { canonicalEventToPossibility } from "./canon-runtime.js";
import { loadWorldContext } from "./context.js";
import { WorldEngine } from "./engine.js";
import { PossibilityTemplateStore } from "./possibility-model.js";
import { WorldRuntime, type NarrativeRender, type PossibilitySource } from "./runtime.js";

export type WorkspaceWorld = {
  engine: WorldEngine;
  runtime: WorldRuntime;
  actorModels: ActorModelStore;
  possibilityTemplates: PossibilityTemplateStore;
};

export async function openWorkspaceWorld(workspaceRoot: string, render?: NarrativeRender): Promise<WorkspaceWorld> {
  const { canon, context } = await loadWorldContext(workspaceRoot);
  const engine = new WorldEngine(workspaceRoot, context);
  const actorModels = new ActorModelStore(workspaceRoot);
  const possibilityTemplates = new PossibilityTemplateStore(workspaceRoot);
  const possibilitySource: PossibilitySource = async ({ branchId, commitId }) => {
    const [events, templates] = await Promise.all([
      canon.listEvents(),
      possibilityTemplates.materialize(branchId, commitId),
    ]);
    const canonical = events.map((event) => canonicalEventToPossibility(event, branchId, commitId));
    const byId = new Map([...canonical, ...templates].map((possibility) => [possibility.id, possibility]));
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

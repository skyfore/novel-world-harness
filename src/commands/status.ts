import path from "node:path";
import { ActorModelStore } from "../world/actors.js";
import { CompilerBatchStore } from "../compiler/batches.js";
import { SegmentStore } from "../compiler/segments.js";
import { loadConfig } from "../config/load.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { InitialWorldStore } from "../world/initial.js";
import { PossibilityTemplateStore } from "../world/possibility-model.js";

export async function statusCommand(configPath: string): Promise<void> {
  await loadConfig(configPath);
  const root = path.dirname(path.resolve(configPath));
  const store = await WorkspaceStore.create(root);
  const project = await store.readProject();
  if (!project) {
    console.log("Project has no local harness state. Run nwh ingest first.");
    return;
  }

  const sources = await store.listSources();
  const segments = new SegmentStore(root);
  const batches = new CompilerBatchStore(root);
  const sourceRows = await Promise.all(sources.map(async (source) => {
    const [manifest, progress] = await Promise.all([
      segments.readManifest(source.id),
      batches.read(source.id),
    ]);
    return {
      source: source.sourcePath,
      id: source.id,
      bytes: source.bytes,
      segments: manifest?.segments.length ?? 0,
      completedBatches: progress.completedBatchIds.length,
    };
  }));

  const proposals = new ProposalStore(root);
  const canon = new CanonicalModelStore(root);
  const actors = new ActorModelStore(root);
  const [pending, accepted, rejected, entities, claims, events, rules, initialWorld, goals, models, possibilities] = await Promise.all([
    proposals.list("pending"),
    proposals.list("accepted"),
    proposals.list("rejected"),
    canon.listEntities(),
    canon.listClaims(),
    canon.listEvents(),
    canon.listRules(),
    new InitialWorldStore(root).get(),
    actors.listGoals(),
    actors.listModels(),
    new PossibilityTemplateStore(root).list(),
  ]);

  console.log(`Project: ${project.name} (${project.id})`);
  console.table(sourceRows);
  console.table([
    { area: "proposals", pending: pending.length, accepted: accepted.length, rejected: rejected.length },
    { area: "canonical", entities: entities.length, claims: claims.length, events: events.length, rules: rules.length },
    { area: "runtime inputs", initialWorld: initialWorld ? 1 : 0, goals: goals.length, models: models.length, possibilities: possibilities.length },
  ]);
  console.log("Use `nwh audit` for evidence integrity and consistency checks; readiness is not inferred from artifact counts.");
}

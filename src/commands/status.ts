import path from "node:path";
import { ActorModelStore } from "../world/actors.js";
import { CompilerBatchStore } from "../compiler/batches.js";
import { SegmentStore } from "../compiler/segments.js";
import { loadOptionalConfig } from "../config/load.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { InitialWorldStore } from "../world/initial.js";
import { PossibilityTemplateStore } from "../world/possibility-model.js";
import { inspectPreparation } from "../workflow/prepare.js";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";

export async function statusCommand(configPath: string): Promise<void> {
  const config = await loadOptionalConfig(configPath);
  const root = path.dirname(path.resolve(configPath));
  const store = await WorkspaceStore.create(root);
  const project = await store.readProject();

  const sources = await store.listSources();
  const segments = new SegmentStore(root);
  const batches = new CompilerBatchStore(root);
  const preparedCache = new PreparedNovelCache(root);
  const sourceRows = await Promise.all(sources.map(async (source) => {
    const [manifest, progress, cached] = await Promise.all([
      segments.readManifest(source.id),
      batches.read(source.id),
      preparedCache.lookup(source),
    ]);
    return {
      source: source.sourcePath,
      id: source.id,
      bytes: source.bytes,
      md5: cached.contentMd5,
      preparedCache: cached.status === "already-cached" ? "ready" : "missing",
      preparedRevision: cached.bundleHash?.slice(0, 12) ?? "-",
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

  if (project) console.log(`Project: ${project.name} (${project.id})`);
  else if (config) console.log(`Project: ${config.project.name} (no NWH state)`);
  else console.log(`Project: ${path.basename(root) || "novel-world"} (no config or NWH state)`);
  console.log(`State: ${store.stateDir}`);
  console.table(sourceRows);
  console.table([
    { area: "proposals", pending: pending.length, accepted: accepted.length, rejected: rejected.length },
    { area: "canonical", entities: entities.length, claims: claims.length, events: events.length, rules: rules.length },
    { area: "runtime inputs", initialWorld: initialWorld ? 1 : 0, goals: goals.length, models: models.length, possibilities: possibilities.length },
  ]);
  console.log("Use `nwh audit` for evidence integrity and consistency checks; readiness is not inferred from artifact counts.");
  const preparation = await inspectPreparation(root);
  console.log(`Preparation: ${preparation.stage}`);
  console.log(`Next: ${preparation.next}`);
}

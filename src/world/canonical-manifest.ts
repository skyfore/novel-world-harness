import { ActorModelStore } from "./actors.js";
import { canonicalJson, contentHash } from "./canonical.js";
import { CanonicalModelStore } from "./canonical-model.js";
import { InitialWorldStore } from "./initial.js";
import { PossibilityTemplateStore } from "./possibility-model.js";

export type CanonicalManifest = {
  version: 1;
  entities: Array<{ id: string; hash: string }>;
  claims: Array<{ id: string; hash: string }>;
  events: Array<{ id: string; hash: string }>;
  rules: Array<{ id: string; hash: string }>;
  initialWorldHash?: string;
  goals: Array<{ id: string; hash: string }>;
  characterModels: Array<{ actorId: string; hash: string }>;
  possibilities: Array<{ id: string; hash: string }>;
};

export async function buildCanonicalManifest(workspaceRoot: string): Promise<{
  manifest: CanonicalManifest;
  hash: string;
}> {
  const canon = new CanonicalModelStore(workspaceRoot);
  const actorStore = new ActorModelStore(workspaceRoot);
  const possibilityStore = new PossibilityTemplateStore(workspaceRoot);
  const [entities, claims, events, rules, initialWorld, goals, models, possibilities] = await Promise.all([
    canon.listEntities(),
    canon.listClaims(),
    canon.listEvents(),
    canon.listRules(),
    new InitialWorldStore(workspaceRoot).get(),
    actorStore.listGoals(),
    actorStore.listModels(),
    possibilityStore.list(),
  ]);

  const manifest: CanonicalManifest = {
    version: 1,
    entities: entities.map((item) => ({ id: item.id, hash: contentHash(item) })).sort(byId),
    claims: claims.map((item) => ({ id: item.id, hash: contentHash(item) })).sort(byId),
    events: events.map((item) => ({ id: item.id, hash: contentHash(item) })).sort(byId),
    rules: rules.map((item) => ({ id: item.id, hash: contentHash(item) })).sort(byId),
    ...(initialWorld ? { initialWorldHash: contentHash(initialWorld) } : {}),
    goals: goals.map((item) => ({ id: item.id, hash: contentHash(item) })).sort(byId),
    characterModels: models.map((item) => ({ actorId: item.actorId, hash: contentHash(item) })).sort((left, right) => left.actorId.localeCompare(right.actorId)),
    possibilities: possibilities.map((item) => ({ id: item.id, hash: contentHash(item) })).sort(byId),
  };
  return { manifest, hash: contentHash(JSON.parse(canonicalJson(manifest))) };
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

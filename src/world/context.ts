import { CanonicalModelStore } from "./canonical-model.js";
import type { WorldModelContext } from "./engine.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "./state.js";

export async function loadWorldContext(workspaceRoot: string): Promise<{
  canon: CanonicalModelStore;
  context: WorldModelContext;
}> {
  const canon = new CanonicalModelStore(workspaceRoot);
  const [entities, claims, rules] = await Promise.all([
    canon.listEntities(),
    canon.listClaims(),
    canon.listRules(),
  ]);
  const context: WorldModelContext = {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    claims: new Map(claims.map((claim) => [claim.id, claim])),
    rules: new Map(rules.map((rule) => [rule.id, rule])),
    stateSchema: new StateSchemaRegistry(DEFAULT_STATE_FIELDS),
  };
  return { canon, context };
}


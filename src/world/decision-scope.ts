import { AsyncLocalStorage } from "node:async_hooks";
import { contentHash } from "./canonical.js";

/** Host audit identity. Never serialized into the actor-visible prompt. */
export type DecisionScope = Readonly<{
  branchId: string;
  headCommitId: string;
  actorId: string;
  candidateHash?: string;
}>;
const scopes = new AsyncLocalStorage<DecisionScope>();
export function withDecisionScope<T>(scope: DecisionScope, action: () => T): T {
  return scopes.run(Object.freeze({ ...scope }), action);
}
export function currentDecisionScope(): DecisionScope | undefined {
  const scope = scopes.getStore();
  return scope ? { ...scope } : undefined;
}
export function decisionScopeHash(scope: DecisionScope): string {
  return contentHash({ version: "decision-scope/v1", ...scope });
}

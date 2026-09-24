import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ModelRequestBudget, type ModelRequestLimits } from "./model-request-budget.js";
import { currentRuntimeHooks } from "./hooks.js";

/** Aggregate protection, independent of the stricter per-adapter limits. Not tokenizer capacity. */
export const PLAY_MODEL_REQUEST_LIMITS: ModelRequestLimits = Object.freeze({
  maxModelCalls: 128, maxRequestBytes: 512_000, maxTotalPayloadBytes: 32_000_000,
});
export type PlayModelBudgetScope = Readonly<{ id: string; budget: ModelRequestBudget }>;
const scopes = new AsyncLocalStorage<PlayModelBudgetScope>();
export function currentPlayModelBudget(): PlayModelBudgetScope | undefined { return scopes.getStore(); }

/**
 * The host owns this lifetime. Nested orchestration and rendering inherit it;
 * only a new actual user input may deliberately open an independent scope.
 * Detached callbacks retain a CLOSED gate, never a fresh or unrelated budget.
 */
export async function withPlayModelBudget<T>(
  operation: () => Promise<T>,
  options: { id?: string; budget?: ModelRequestBudget; newScope?: boolean } = {},
): Promise<T> {
  const parent = currentPlayModelBudget();
  if (parent && !options.newScope) {
    parent.budget.assertUsable();
    if (options.budget && options.budget !== parent.budget) throw new Error("Nested play cannot replace the host model budget.");
    return operation();
  }
  const budget = options.budget ?? new ModelRequestBudget(PLAY_MODEL_REQUEST_LIMITS);
  budget.assertUsable();
  const scope = Object.freeze({ id: options.id ?? randomUUID(), budget });
  let succeeded = false;
  try {
    return await scopes.run(scope, async () => {
      const result = await operation();
      succeeded = true;
      return result;
    });
  } finally {
    budget.close();
    const report = budget.report();
    await currentRuntimeHooks().emit({
      type: "model.budget", name: "play.model-budget", status: succeeded && !report.blocked ? "succeeded" : "failed",
      metadata: {
        budgetId: scope.id, ...report.usage, blocked: report.blocked,
        maxModelCalls: report.limits.maxModelCalls, maxRequestBytes: report.limits.maxRequestBytes,
        maxTotalPayloadBytes: report.limits.maxTotalPayloadBytes,
        providerUsageReports: report.providerUsage.reports, inputTokens: report.providerUsage.input,
        outputTokens: report.providerUsage.output, cacheReadTokens: report.providerUsage.cacheRead,
        cacheWriteTokens: report.providerUsage.cacheWrite, reportedTotalTokens: report.providerUsage.totalTokens,
        reportedCost: report.providerUsage.cost,
      },
    });
  }
}

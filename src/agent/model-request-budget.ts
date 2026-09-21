import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ModelRequestBudget } from "../runtime/model-request-budget.js";
export * from "../runtime/model-request-budget.js";

/**
 * Install outside ExtensionRunner: it catches extension errors and continues.
 * Direct agent callbacks propagate our rejection to Pi's normal failed turn.
 * No transport/API implementation is replaced, and payload contents are not logged.
 */
export function installModelRequestBudget(
  agent: Pick<AgentSession["agent"], "streamFunction" | "onPayload">,
  budget: ModelRequestBudget | readonly ModelRequestBudget[],
): void {
  const budgets = [...new Set(Array.isArray(budget) ? budget : [budget as ModelRequestBudget])];
  const stream = agent.streamFunction;
  const onPayload = agent.onPayload;
  agent.streamFunction = (model, context, options) => {
    for (const gate of budgets) gate.assertUsable();
    for (const gate of budgets) gate.beginCall(context);
    return stream(model, context, options);
  };
  agent.onPayload = async (payload, model) => {
    const transformed = await onPayload?.(payload, model);
    const admitted = transformed === undefined ? payload : transformed;
    for (const gate of budgets) gate.assertUsable();
    for (const gate of budgets) gate.admitPayload(admitted);
    return admitted;
  };
}

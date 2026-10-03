import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RequestObserver } from "./request-observation.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { ModelRequestBudget } from "../runtime/model-request-budget.js";
export * from "../runtime/model-request-budget.js";

/**
 * Install outside ExtensionRunner: it catches extension errors and continues.
 * Direct agent callbacks propagate our rejection to Pi's normal failed turn.
 * No transport/API implementation is replaced. The optional observer owns
 * durable, redacted request snapshots; budget accounting stores counters only.
 */
export function installModelRequestBudget(
  agent: Pick<AgentSession["agent"], "streamFunction" | "onPayload">,
  budget: ModelRequestBudget | readonly ModelRequestBudget[],
  observeRequest?: RequestObserver,
): void {
  const budgets = [...new Set(Array.isArray(budget) ? budget : [budget as ModelRequestBudget])];
  const stream = agent.streamFunction;
  const onPayload = agent.onPayload;
  const payloadScope = new AsyncLocalStorage<{ admitted: boolean }>();
  const admit = async (payload: unknown, model: Parameters<typeof agent.streamFunction>[0]) => {
    await observeRequest?.({ phase: "provider-payload", value: payload, model });
    for (const gate of budgets) gate.assertUsable();
    for (const gate of budgets) gate.admitPayload(payload);
    const scope = payloadScope.getStore();
    if (scope) scope.admitted = true;
    return payload;
  };
  agent.streamFunction = (model, context, options) => {
    for (const gate of budgets) gate.assertUsable();
    for (const gate of budgets) gate.beginCall(context);
    const dispatch = () => {
      const result = stream(model, context, {
        ...options,
        onPayload: (payload, requestModel) => payloadScope.run({ admitted: false }, async () => {
          const transformed = await options?.onPayload?.(payload, requestModel);
          const final = transformed === undefined ? payload : transformed;
          // Ordinary turns invoke agent.onPayload; summaries bypass it. Each
          // physical payload (including provider retries) is charged exactly once.
          return payloadScope.getStore()!.admitted ? final : admit(final, requestModel);
        }),
      });
      const observe = (events: Awaited<typeof result>) => {
        void events?.result().then(message => {
          for (const gate of budgets) gate.observeUsage(message.usage);
        });
        return events;
      };
      return result instanceof Promise ? result.then(observe) : observe(result);
    };
    return observeRequest
      ? observeRequest({ phase: "context", value: context, model }).then(dispatch)
      : dispatch();
  };
  agent.onPayload = async (payload, model) => {
    const transformed = await onPayload?.(payload, model);
    const admitted = transformed === undefined ? payload : transformed;
    return admit(admitted, model);
  };
}

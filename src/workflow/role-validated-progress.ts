import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ModelRequestBudget } from "../runtime/model-request-budget.js";
import { contentHash } from "../world/canonical.js";
import type { RoleWorkInvocation } from "./role-review-bounded.js";

/** Milestones come from the existing host validators, never model assertions.
 * At most one draft, restoration and terminal receipt per immutable subtask
 * can renew a window. Rewording a draft or rereading a page earns nothing. */
export function roleProgressTools(work: RoleWorkInvocation, budget: ModelRequestBudget, recoveryActive: () => boolean): ToolDefinition[] {
  const taskHash = work.logicalTaskHash ?? contentHash(work.prompt);
  return work.tools.map(tool => ({ ...tool, async execute(...args: Parameters<typeof tool.execute>) {
    const result = await tool.execute(...args);
    if (result.isError) return result;
    const values = result.content.flatMap(item => {
      if (item.type !== "text") return [];
      try { return [JSON.parse(item.text) as Record<string,unknown>]; } catch { return []; }
    });
    if (tool.name.startsWith("preview_role_") && values.some(value => value?.valid === true)) {
      budget.recordValidatedProgress(`draft:${taskHash}`);
    }
    if (tool.name === "read_role_session_context" && recoveryActive()
      && values.some(value => value?.complete === true && value.taskHash === taskHash)) {
      budget.recordValidatedProgress(`restored:${taskHash}`);
    }
    if (tool.name.startsWith("propose_role_") && work.complete()) {
      budget.recordValidatedProgress(`receipt:${taskHash}`);
    }
    return result;
  } }));
}

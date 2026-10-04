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
    // A read earns nothing by itself. Recheck the retained, unchanged proposal
    // against the same host validator after its access dependencies change,
    // so validation does not require another charged model round. This shares
    // the ONE draft key with explicit previews and cannot revive a hard stop.
    if (tool.name.startsWith("read_role_") && work.revalidateDraft) {
      const draft = work.revalidateDraft();
      if (draft?.valid && budget.recordValidatedProgress(`draft:${taskHash}`)) {
        result.content.push({type:"text",text:JSON.stringify({hostDraftPreview:{...draft,committed:false,semanticSupport:"not-verified",
          guidance:"The retained draft now passes the same preflight after evidence delivery. Its first draft milestone was recorded; review and submit it through the original proposal tool. This is not a receipt or semantic certification."}})});
      }
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertNwhContextEdits, branchContainsNwhPrivateContext, branchHasUntrustedSummary, contextPolicyMarker,
  projectCompletedNwhMessages, projectNwhModelMessages, projectNwhSummaryEntries, NWH_CONTEXT_POLICY_MARKER } from "./context-policy.js";

/** Shared by interactive and isolated Pi sessions, including provider summaries. */
export function registerNwhContextProjection(pi: ExtensionAPI, compilerTurnActive: () => boolean = () => false): void {
  pi.on("session_before_compact", (event, ctx) => {
    assertNwhContextEdits(event.branchEntries);
    let sessionContainsPrivateContext = branchContainsNwhPrivateContext(event.branchEntries);
    try {
      sessionContainsPrivateContext ||= branchContainsNwhPrivateContext(ctx.sessionManager.getEntries());
    } catch {
      // Synthetic embeddings may expose only the branch supplied by Pi.
    }
    const dropSummaries = branchHasUntrustedSummary(event.branchEntries, sessionContainsPrivateContext);
    const history = projectCompletedNwhMessages(
      event.preparation.messagesToSummarize,
      false,
      dropSummaries,
    );
    const prefix = projectCompletedNwhMessages(
      event.preparation.turnPrefixMessages,
      history.state.compilerSpan,
      dropSummaries,
    );
    event.preparation.messagesToSummarize = history.messages;
    event.preparation.turnPrefixMessages = prefix.messages;
    if (dropSummaries) event.preparation.previousSummary = undefined;
    if (!history.messages.length && !prefix.messages.length && !event.preparation.previousSummary) {
      return {
        compaction: {
          summary: `No ordinary model-visible history was compacted. NWH private entries were excluded by context policy v2.`,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details: { nwhContextPolicyVersion: 2, privateEntriesExcluded: true },
        },
      };
    }
  });

  pi.on("session_compact", (event) => {
    pi.appendEntry(
      NWH_CONTEXT_POLICY_MARKER,
      contextPolicyMarker(event.compactionEntry.id, "compaction"),
    );
  });

  pi.on("session_before_tree", (event, ctx) => {
    let branch = event.preparation.entriesToSummarize;
    let sessionContainsPrivateContext = branchContainsNwhPrivateContext(branch);
    try {
      branch = ctx.sessionManager.getBranch();
      sessionContainsPrivateContext ||= branchContainsNwhPrivateContext(ctx.sessionManager.getEntries());
    } catch {
      // Synthetic embedding contexts may not provide a session manager.
    }
    assertNwhContextEdits(branch);
    const projected = new Map(projectNwhSummaryEntries(branch, sessionContainsPrivateContext).map(entry => [entry.id, entry]));
    // Pi 1.0 retains an alias to this array in navigateTree. Replacing the
    // property leaves the summarizer's original input intact; mutate it.
    const entries = event.preparation.entriesToSummarize;
    entries.splice(0, entries.length, ...entries.flatMap(entry => projected.has(entry.id) ? [projected.get(entry.id)!] : []));
  });

  pi.on("session_tree", (event) => {
    if (!event.summaryEntry) return;
    pi.appendEntry(
      NWH_CONTEXT_POLICY_MARKER,
      contextPolicyMarker(event.summaryEntry.id, "branch"),
    );
  });

  pi.on("context", (event, ctx) => {
    let dropSummaries = false;
    try {
      const branch = ctx.sessionManager.getBranch();
      dropSummaries = branchHasUntrustedSummary(
        branch,
        branchContainsNwhPrivateContext(ctx.sessionManager.getEntries()),
      );
    } catch {
      // A context can be synthetic in embedding tests. The real Pi runtime
      // always supplies a read-only session manager.
    }
    const messages = projectNwhModelMessages(
      event.messages,
      compilerTurnActive(),
      dropSummaries,
    );
    if (messages.length === event.messages.length && messages.every((message, index) => message === event.messages[index])) return;
    return { messages };
  });

}

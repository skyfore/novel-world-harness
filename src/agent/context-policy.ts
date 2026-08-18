import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const NWH_CONTEXT_POLICY_VERSION = 2;
export const NWH_CONTEXT_POLICY_MARKER = "nwh-context-policy";

export const COMPILER_CONTEXT_TYPES = new Set([
  "nwh-compiler-batch",
  "nwh-prepare-all-batch",
  "nwh-prepare-all-initial-world",
  "nwh-prepare-all-reconciliation",
]);

export const DISPLAY_ONLY_CONTEXT_TYPES = new Set([
  "nwh-play",
  "nwh-narrator",
]);

export type NwhContextMessage = {
  role: string;
  customType?: string;
  details?: unknown;
};

type ProjectionState = {
  compilerSpan: boolean;
};

function isCompilerBoundary(message: NwhContextMessage): boolean {
  return message.role === "custom"
    && Boolean(message.customType && COMPILER_CONTEXT_TYPES.has(message.customType));
}

function isDisplayOnlyMessage(message: NwhContextMessage): boolean {
  return message.role === "custom"
    && Boolean(message.customType && DISPLAY_ONLY_CONTEXT_TYPES.has(message.customType));
}

function isSummaryMessage(message: NwhContextMessage): boolean {
  return message.role === "compactionSummary" || message.role === "branchSummary";
}

export function projectCompletedNwhMessages<T extends NwhContextMessage>(
  messages: readonly T[],
  initialCompilerSpan = false,
  dropSummaries = false,
): { messages: T[]; state: ProjectionState } {
  let compilerSpan = initialCompilerSpan;
  const projected: T[] = [];
  for (const message of messages) {
    if (isDisplayOnlyMessage(message)) continue;
    if (dropSummaries && isSummaryMessage(message)) continue;
    if (isCompilerBoundary(message)) {
      const details = message.details && typeof message.details === "object"
        ? message.details as Record<string, unknown>
        : undefined;
      if (details?.excludePreviousUser === true && projected.at(-1)?.role === "user") projected.pop();
      compilerSpan = true;
      continue;
    }
    if (compilerSpan && (message.role === "assistant" || message.role === "toolResult")) continue;
    compilerSpan = false;
    projected.push(message);
  }
  return { messages: projected, state: { compilerSpan } };
}

/**
 * Produces the exact model-visible projection for an NWH turn. Display-only
 * player transcript entries are never model context. A live compiler turn sees
 * only its latest hidden evidence boundary; completed compiler spans disappear.
 */
export function projectNwhModelMessages<T extends NwhContextMessage>(
  messages: readonly T[],
  compilerTurnActive: boolean,
  dropSummaries = false,
): T[] {
  if (compilerTurnActive) {
    const boundary = messages.findLastIndex(isCompilerBoundary);
    // A compiler turn without its host evidence marker is malformed. Returning
    // prior ordinary conversation here would silently replace a missing
    // evidence boundary with unrelated transcript context, so fail closed.
    if (boundary < 0) return [];
    const active = messages.slice(boundary);
    return active.filter((message) => !isDisplayOnlyMessage(message) && !(dropSummaries && isSummaryMessage(message)));
  }
  return projectCompletedNwhMessages(messages, false, dropSummaries).messages;
}

function markerTargetIds(entries: readonly SessionEntry[]): Set<string> {
  const targets = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== NWH_CONTEXT_POLICY_MARKER) continue;
    const data = entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
      ? entry.data as Record<string, unknown>
      : undefined;
    if (data?.version === NWH_CONTEXT_POLICY_VERSION && typeof data.summaryEntryId === "string") {
      targets.add(data.summaryEntryId);
    }
  }
  return targets;
}

export function branchContainsNwhPrivateContext(entries: readonly SessionEntry[]): boolean {
  return entries.some((entry) => (entry.type === "custom_message" || entry.type === "custom")
    && (COMPILER_CONTEXT_TYPES.has(entry.customType) || DISPLAY_ONLY_CONTEXT_TYPES.has(entry.customType)));
}

/** True when a persisted Pi-generated summary predates the NWH projection hook. */
export function branchHasUntrustedSummary(
  entries: readonly SessionEntry[],
  sessionContainsPrivateContext = branchContainsNwhPrivateContext(entries),
): boolean {
  if (!sessionContainsPrivateContext) return false;
  const marked = markerTargetIds(entries);
  const latestCompactionIndex = entries.findLastIndex((entry) => entry.type === "compaction");
  const latestCompaction = latestCompactionIndex >= 0 ? entries[latestCompactionIndex] : undefined;
  if (latestCompaction && !marked.has(latestCompaction.id)) return true;
  // Pi's active context keeps only the latest compaction plus entries after
  // it. Older branch summaries are no longer model-visible and must not make a
  // newly safe compaction unusable forever.
  return entries.slice(latestCompactionIndex + 1)
    .some((entry) => entry.type === "branch_summary" && !marked.has(entry.id));
}

/**
 * Projects raw branch entries before Pi's tree summarizer sees them. This closes
 * the path that bypasses the ordinary `context` event entirely.
 */
export function projectNwhSummaryEntries(
  entries: readonly SessionEntry[],
  sessionContainsPrivateContext = branchContainsNwhPrivateContext(entries),
): SessionEntry[] {
  if (!sessionContainsPrivateContext) return [...entries];
  const markedSummaries = markerTargetIds(entries);
  let compilerSpan = false;
  const projected: SessionEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === NWH_CONTEXT_POLICY_MARKER) continue;
    if (entry.type === "custom_message" || entry.type === "custom") {
      if (DISPLAY_ONLY_CONTEXT_TYPES.has(entry.customType)) continue;
      if (COMPILER_CONTEXT_TYPES.has(entry.customType)) {
        const rawDetails = entry.type === "custom_message"
          ? entry.details
          : entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
            ? (entry.data as Record<string, unknown>).details
            : undefined;
        const details = rawDetails && typeof rawDetails === "object"
          ? rawDetails as Record<string, unknown>
          : undefined;
        if (details?.excludePreviousUser === true) {
          const prior = projected.at(-1);
          if (prior?.type === "message" && prior.message.role === "user") projected.pop();
        }
        compilerSpan = true;
        continue;
      }
      compilerSpan = false;
      projected.push(entry);
      continue;
    }
    if (entry.type === "message") {
      if (compilerSpan && (entry.message.role === "assistant" || entry.message.role === "toolResult")) continue;
      compilerSpan = false;
      projected.push(entry);
      continue;
    }
    if ((entry.type === "compaction" || entry.type === "branch_summary") && !markedSummaries.has(entry.id)) {
      continue;
    }
    projected.push(entry);
  }
  return projected;
}

export type ContextPolicyMarker = {
  version: typeof NWH_CONTEXT_POLICY_VERSION;
  summaryEntryId: string;
  summaryKind: "compaction" | "branch";
};

export function contextPolicyMarker(
  summaryEntryId: string,
  summaryKind: ContextPolicyMarker["summaryKind"],
): ContextPolicyMarker {
  return { version: NWH_CONTEXT_POLICY_VERSION, summaryEntryId, summaryKind };
}

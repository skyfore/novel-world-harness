import { contentHash } from "../world/canonical.js";
import { assessEntryState, ENTRY_CONTRACT_VERSION, type EntryState } from "../world/entry-contract.js";
import type { EntryAgencyCatalog } from "../world/entry-agency.js";
import { DEFAULT_STATE_FIELDS } from "../world/state.js";

/** Read-only derived diagnostics for the existing repair/requirement handoff.
 * No new ledger, independent requirement, authorization or retry is created. */
export function diagnoseEntryRepair(input: {
  sourceId: string; entry: EntryState; catalog: EntryAgencyCatalog; writablePointers: readonly string[];
  consumed?: boolean; catalogScope: "canonical-catalog" | "frozen-repair-scope";
}) {
  const subjectHash = contentHash({ sourceId: input.sourceId, entry: input.entry,
    entities: [...input.catalog.entities].sort(([a], [b]) => a.localeCompare(b)),
    actions: [...(input.catalog.actionSchemas ?? [])].sort(([a], [b]) => a.localeCompare(b)),
    processes: [...(input.catalog.processTemplates ?? [])].sort(([a], [b]) => a.localeCompare(b)),
    acquisitions: [...(input.catalog.acquisitions ?? [])].sort(([a], [b]) => a.localeCompare(b)),
    contractVersion: ENTRY_CONTRACT_VERSION, writablePointers: [...input.writablePointers].sort(), catalogScope: input.catalogScope });
  const actors = [...new Set((input.entry.participantPresence ?? []).map(p => p.entityId))];
  const assessments = actors.map(actor => assessEntryState(actor, input.entry, { ...input.catalog, sourceId: input.sourceId }));
  type Gap = { id: string; kind: "scope-conflict" | "source-or-representation-review" | "mechanism-review" | "consumed-stage"; certainty: "proven" | "review-required"; pointer?: string; actorId?: string; diagnostics: string[]; recovery: string };
  const gaps: Gap[] = [];
  const add = (gap: Omit<Gap, "id">) => gaps.push({ id: contentHash({ subjectHash, ...gap }), ...gap });
  const writable = (pointer: string) => input.writablePointers.some(allowed => pointer === allowed || pointer.startsWith(allowed + "/") || allowed.startsWith(pointer + "/"));
  const needs = (pointer: string, diagnostics: string[], actorId?: string) => add({
    kind: writable(pointer) ? "source-or-representation-review" : "scope-conflict", certainty: writable(pointer) ? "review-required" : "proven", pointer, ...(actorId ? { actorId } : {}), diagnostics,
    recovery: writable(pointer)
      ? "Inspect original evidence and the registered state-field definitions. A model may propose a supported correction only under an unconsumed grant; no default values, renamed identity or unchanged retry. Unsupported meaning remains an unmapped requirement."
      : "This missing entry condition needs a field outside the exact write scope. Preserve the plan and stop dispatch; host review must resolve the scope dependency through the existing repair ledger, without silently adding permissions." });
  if (!actors.length) needs("/participantPresence", ["ENTRY_PRESENCE_MISSING"]);
  // One grounded entry suffices here. Per-major-role obligations are checked
  // by the roster evaluator, not inferred from incidental co-present actors.
  for (const assessment of assessments) if (!assessments.some(item => item.state === "grounded") && assessment.state === "blocked") {
    const explicitLivePresence = input.entry.participantPresence?.some(p => p.entityId === assessment.actorId && ["physical", "remote"].includes(p.mode));
    const presence = assessment.issues.filter(issue => issue.path === "participantPresence" && !explicitLivePresence);
    if (presence.length) needs("/participantPresence", presence.map(issue => `${issue.code}: ${issue.message}`), assessment.actorId);
    const state = assessment.issues.filter(issue => issue.path?.startsWith("delta."));
    if (state.length) needs("/delta", state.map(issue => `${issue.code}: ${issue.message}`), assessment.actorId);
    const dependencies = assessment.issues.filter(issue => !presence.includes(issue) && !state.includes(issue));
    if (dependencies.length) add({ kind: "source-or-representation-review", certainty: "review-required", actorId: assessment.actorId,
      diagnostics: dependencies.map(issue => `${issue.code}: ${issue.message}`),
      recovery: "Inspect this actor's exact identity/agency/channel dependencies in the same source. Missing or quarantined catalog data cannot be corrected by an invented state delta. Check the retained dependency authority; this diagnostic does not grant entity or mechanism writes." });
  }
  add({ kind: "mechanism-review", certainty: "review-required", diagnostics: ["ENTRY_ACTION_NOT_EVALUATED", "ENTRY_DRIVER_NOT_EVALUATED"],
    recovery: "Context grounding does not prove a legal action or autonomous world driver. Independently probe the frozen entry with its active goals, disclosed mechanisms and exact preconditions. A missing dependency in this readable catalog is not proof that the source has no such mechanism. These probes do not expand the current write scope." });
  if (input.consumed) add({ kind: "consumed-stage", certainty: "proven", diagnostics: ["ENTRY_REPAIR_STAGE_CONSUMED"],
    recovery: "Keep the original invocation, response, budget and failed receipt. Do not redispatch, rotate authorization, reset counters or resume the parent. This changed capability contract requires host dependency review and fresh independent evaluation, not reuse of the old verdict." });
  return { contractVersion: ENTRY_CONTRACT_VERSION, subjectHash, catalogScope: input.catalogScope, writablePointers: [...input.writablePointers],
    stateFieldDefinitions: DEFAULT_STATE_FIELDS.filter(field => field.entryContext).map(field => structuredClone(field)),
    assessments, gaps, executionAuthority: false, certificationGranted: false,
    dispatch: input.consumed || gaps.some(gap => gap.kind === "scope-conflict") ? "blocked" : "requires-existing-authority-and-source-review",
    wholeSourceSatisfiability: "not-established" };
}

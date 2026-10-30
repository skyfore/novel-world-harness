import { entryAgencyIssues, type EntryAgencyCatalog } from "./entry-agency.js";
import { applyStateDelta, DEFAULT_STATE_FIELDS, emptyWorldState, StateSchemaRegistry } from "./state.js";
import type { EntryProjectionSeed, KnowledgeDelta, ParticipantPresence, StateDelta, StateValue, ValidationIssue } from "./model.js";

export const ENTRY_CONTRACT_VERSION = "entry-capability/v2";
export type EntryState = { delta: StateDelta; participantPresence?: readonly ParticipantPresence[]; knowledge?: KnowledgeDelta; projectionSeed?: EntryProjectionSeed };
export type EntryStateAssessment = {
  contractVersion: typeof ENTRY_CONTRACT_VERSION;
  actorId: string;
  state: "grounded" | "blocked";
  fields: string[];
  issues: ValidationIssue[];
  actionProof: "required";
};

function contextFields(values: Record<string, StateValue>, registry: StateSchemaRegistry): string[] {
  return Object.entries(values).filter(([field, value]) => {
    const spec = registry.get(field);
    const dimension = spec.entryContext ?? DEFAULT_STATE_FIELDS.find(item => item.key === field)?.entryContext;
    return dimension && value !== null && (typeof value !== "string" || value.trim().length > 0);
  }).map(([field]) => field).sort();
}

/** Conservative regression comparison when no catalog is available. This
 * never authorizes an entry; proposal/entry boundaries perform full validation. */
export function entryDeltaRetainsContext(delta: StateDelta, actorId: string): boolean {
  const values: Record<string, StateValue> = {};
  for (const op of delta.operations) if ("entityId" in op && op.entityId === actorId) {
    if (op.op === "set") values[op.field] = op.value;
    else if (op.op === "unset") delete values[op.field];
    else if (op.op === "adjust-number" && typeof values[op.field] === "number") values[op.field] = Number(values[op.field]) + op.amount;
  }
  try { return values["character.alive"] !== false && contextFields(values, new StateSchemaRegistry(DEFAULT_STATE_FIELDS)).length > 0; }
  catch { return false; }
}

/** Context grounding only. Actual action and autonomous-driver proofs are
 * separate obligations. The number/names of off-scene characters are irrelevant. */
export function assessEntryState(actorId: string, entry: EntryState, catalog: EntryAgencyCatalog,
  registry = new StateSchemaRegistry(DEFAULT_STATE_FIELDS)): EntryStateAssessment {
  const issues = entryAgencyIssues(actorId, entry, catalog);
  let fields: string[] = [];
  try {
    // Project in order: set(null), unset and final alive=false cannot retain a
    // witness from an earlier operation. Unknown numeric adjustments also fail.
    const state = applyStateDelta(emptyWorldState("entry-contract"), { version: 1,
      operations: entry.delta.operations.filter(op => "entityId" in op && op.entityId === actorId) }, registry, catalog.entities, new Map());
    if (state.values[actorId]?.["character.alive"] === false) issues.push({ code: "ENTRY_ACTOR_DEAD", path: "delta.operations", message: "The final entry state explicitly marks this actor dead." });
    fields = contextFields(state.values[actorId] ?? {}, registry);
  } catch (error) {
    issues.push({ code: "ENTRY_STATE_INVALID", path: "delta.operations", message: String(error) });
  }
  if (!fields.length) issues.push({ code: "ENTRY_CONTEXT_MISSING", path: "delta.operations",
    message: "No final source-grounded operational context is represented for this entry actor. Alive, prose and observations alone are insufficient. Inspect the same-source state-field catalog and evidence; submit one supported correction within scope, otherwise stop for capability/source review. Do not invent a location, plan or number, or retry unchanged." });
  return { contractVersion: ENTRY_CONTRACT_VERSION, actorId, state: issues.length ? "blocked" : "grounded", fields, issues, actionProof: "required" };
}

export function groundedEntryActorIds(entry: EntryState, catalog: EntryAgencyCatalog, registry?: StateSchemaRegistry): Set<string> {
  return new Set((entry.participantPresence ?? []).filter(item => assessEntryState(item.entityId, entry, catalog, registry).state === "grounded").map(item => item.entityId));
}

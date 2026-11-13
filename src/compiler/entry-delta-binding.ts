import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { canonicalEventSchema } from "../world/model.js";
import { eventExecutionSchema } from "../world/event-execution.js";
import { BODILY_STATE_FIELDS } from "../world/bodily-state.js";
import { entryDeltaRetainsContext } from "../world/entry-contract.js";
import { ENTRY_STATE_FIELDS, entryStateEditSchema } from "./entry-state.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const entryDeltaBindingEditSchema = z.object({ canonicalDeltaHash: hash, executionDeltaHash: hash,
  bindings: z.array(entryStateEditSchema.shape.set.element.omit({ field: true, value: true }).extend({ index: z.number().int().nonnegative() })).max(32),
}).strict();
export type EntryDeltaBindingEdit = z.infer<typeof entryDeltaBindingEditSchema>;
type Baseline = { kind: string; id: string; revisionHash: string; payload: unknown };
const stop = (reason: string) => prerequisiteStop(`${reason}. Inspect requirements inspect-identity-repairs for the same source/task and copy summary.consumerRevalidation.reviews[].ref once; inspect both returned ownerRefs. Preserve the exact event, execution and negative review. Missing, conflicting or changed ownership requires host review; no guessed IDs, new values, changed cut or unchanged retry.`);

export function entryDeltaBindingContext(scope: { actorId: string; eventId: string; baselines: readonly Baseline[] }) {
  const events = scope.baselines.filter(b => b.kind === "canonical-event"), bindings = scope.baselines.filter(b => b.kind === "event-execution");
  if (scope.baselines.length !== 2 || events.length !== 1 || bindings.length !== 1
    || scope.baselines.some(b => contentHash(b.payload) !== b.revisionHash)) throw stop("Entry delta binding requires two exact owner revisions");
  const eventBaseline = events[0]!, bindingBaseline = bindings[0]!;
  const event = canonicalEventSchema.parse(eventBaseline.payload), binding = eventExecutionSchema.parse(bindingBaseline.payload);
  const entries = event.characterEntryCheckpoints?.filter(e => e.actorId === scope.actorId);
  if (event.id !== scope.eventId || eventBaseline.id !== event.id || bindingBaseline.id !== binding.id
    || binding.canonicalEventId !== event.id || binding.actorId !== scope.actorId || binding.entryCheckpoint?.actorId !== scope.actorId
    || entries?.length !== 1 || entries[0]!.admission || binding.entryCheckpoint.admission)
    throw stop("Entry delta binding cannot bypass ambiguous ownership or a blocked entry");
  return { event, binding, sourceEntry: entries[0]!, eventBaseline, bindingBaseline };
}

/** Copies an independently reviewed canonical intention/bodily delta into its
 * execution overlay. This never edits the occurrence or invents state values. */
export function lowerEntryDeltaBinding<T extends Baseline>(scope: { actorId: string; eventId: string; baselines: readonly T[] }, raw: EntryDeltaBindingEdit) {
  const edit = entryDeltaBindingEditSchema.parse(raw), { binding, sourceEntry } = entryDeltaBindingContext(scope);
  const delta = sourceEntry.delta, old = binding.entryCheckpoint!.delta;
  if (contentHash(delta) !== edit.canonicalDeltaHash || contentHash(old) !== edit.executionDeltaHash || contentHash(delta) === contentHash(old)
    || !entryDeltaRetainsContext(delta, scope.actorId)) throw stop("Binding must replace a divergent delta with exact grounded source context");
  if (contentHash(edit.bindings.map(b => b.index).sort((a, b) => a - b)) !== contentHash(delta.operations.map((_, i) => i)))
    throw stop("Every copied operation requires its own source evidence exactly once");
  for (const op of delta.operations) {
    const bodily = "field" in op ? BODILY_STATE_FIELDS.find(f => f.key === op.field) : undefined;
    if (op.op !== "set" || op.entityId !== scope.actorId || !ENTRY_STATE_FIELDS.includes(op.field) || typeof op.value !== "string"
      || !op.value.trim() || bodily && !bodily.allowedValues!.includes(op.value)) throw stop("Binding can copy only actor-local intentions or qualitative bodily state");
  }
  const b = scope.baselines.find(b => b.kind === "event-execution")!;
  return [{ ...b, kind: "event-execution" as const, payload: eventExecutionSchema.parse({ ...binding,
    entryCheckpoint: { ...binding.entryCheckpoint!, delta } }) }];
}

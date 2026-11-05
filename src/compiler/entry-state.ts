import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { canonicalEventSchema } from "../world/model.js";
import { BODILY_STATE_FIELDS } from "../world/bodily-state.js";
import { entryDeltaRetainsContext } from "../world/entry-contract.js";
import { modelTextSelectorSchema } from "./text-anchors.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const entryStateEditSchema = z.object({
  remove: z.array(z.object({ index: z.number().int().nonnegative(), operationHash: hash }).strict()).max(32),
  set: z.array(z.object({ field: z.string(), value: z.string().trim().min(1).max(1500),
    strength: z.enum(["explicit", "strong-inference"]), evidence: z.array(modelTextSelectorSchema).min(1).max(8),
    rationale: z.string().trim().min(1).max(1000),
  }).strict()).max(8),
}).strict();
export type EntryStateEdit = z.infer<typeof entryStateEditSchema>;
export const ENTRY_STATE_FIELDS = ["character.plan", ...BODILY_STATE_FIELDS.map(f => f.key)];
const stop = (message: string) => prerequisiteStop(`${message}. Inspect the same source/task with requirements inspect-identity-repairs, copy consumerRevalidation.reviews[].ref once and inspect its exact owning event. Preserve the entry cut, source and original negative review. Scope, revision or unsupported context failures require host review; no guessed state, widened write or unchanged retry.`);

/** Pure proposal lowering. No identity, provider, novel or commitment authority.
 * Only actor-local intentional/qualitative bodily state can change. */
export function lowerEntryState<T extends { kind: string; id: string; payload: unknown; revisionHash: string }>(
  scope: { actorId: string; eventId: string; baselines: readonly T[] }, raw: EntryStateEdit,
) {
  const edit = entryStateEditSchema.parse(raw), b = scope.baselines[0];
  if (scope.baselines.length !== 1 || b?.kind !== "canonical-event" || b.id !== scope.eventId || contentHash(b.payload) !== b.revisionHash)
    throw stop("State repair requires its exact single reviewed event revision");
  const event = canonicalEventSchema.parse(b.payload), entries = event.characterEntryCheckpoints?.filter(e => e.actorId === scope.actorId);
  if (event.id !== scope.eventId || entries?.length !== 1 || entries[0]!.admission)
    throw stop("State repair cannot bypass an absent, ambiguous or explicitly blocked entry");
  const entry = entries[0]!, removed = new Set(edit.remove.map(r => r.index)), fields = new Set(edit.set.map(s => s.field));
  if (removed.size !== edit.remove.length || fields.size !== edit.set.length || !removed.size && !fields.size)
    throw stop("State repair needs unique removals/fields and a material change");
  for (const r of edit.remove) {
    const op = entry.delta.operations[r.index];
    if (!op || contentHash(op) !== r.operationHash || !("entityId" in op) || op.entityId !== scope.actorId
      || !("field" in op) || !ENTRY_STATE_FIELDS.includes(op.field)) throw stop("Removal escaped the exact reviewed actor state operation");
  }
  const retained = entry.delta.operations.filter((_, i) => !removed.has(i));
  for (const s of edit.set) {
    const spec = BODILY_STATE_FIELDS.find(f => f.key === s.field);
    if (!ENTRY_STATE_FIELDS.includes(s.field) || spec && !spec.allowedValues!.includes(s.value)
      || retained.some(op => "entityId" in op && op.entityId === scope.actorId && "field" in op && op.field === s.field))
      throw stop("Replacement must use a supported value and explicitly remove an old write to the same field");
  }
  const delta = { version: 1 as const, operations: [...retained, ...edit.set.map(s => ({ op: "set" as const, entityId: scope.actorId, field: s.field, value: s.value }))] };
  if (contentHash(delta) === contentHash(entry.delta) || !entryDeltaRetainsContext(delta, scope.actorId))
    throw stop("Repair must change the state and retain grounded operational context; source insufficiency remains blocked");
  return [{ ...b, kind: "canonical-event" as const, payload: canonicalEventSchema.parse({ ...event,
    characterEntryCheckpoints: event.characterEntryCheckpoints!.map(e => e.actorId === scope.actorId ? { ...e, delta } : e) }) }];
}

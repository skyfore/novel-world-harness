import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { canonicalEventSchema } from "../world/model.js";
import { modelTextSelectorSchema } from "./text-anchors.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";

export const entryWordingEditSchema = z.object({ fields: z.array(z.object({
  field: z.enum(["readerSetup", "actorObservation"]), value: z.string().trim().min(1).max(1500),
  strength: z.enum(["explicit", "strong-inference"]), evidence: z.array(modelTextSelectorSchema).min(1).max(8),
  rationale: z.string().trim().min(1).max(1000),
}).strict()).max(2) }).strict();
export type EntryWordingEdit = z.infer<typeof entryWordingEditSchema>;
const stop = (reason: string) => prerequisiteStop(`${reason}. Inspect requirements inspect-identity-repairs with the same source/task, copy summary.consumerRevalidation.reviews[].ref once and inspect its owning event. Preserve the exact before-event cut and original negative review. Revision, scope or unsupported wording requires host review; no guessed evidence, world-state change or unchanged retry.`);

/** Compiler entry descriptions are source-bound assertions. Correcting prose
 * never changes state, knowledge, presence, identity, time or event outcomes. */
export function lowerEntryWording<T extends { kind: string; id: string; payload: unknown; revisionHash: string }>(
  scope: { actorId: string; eventId: string; baselines: readonly T[] }, raw: EntryWordingEdit,
) {
  const edit = entryWordingEditSchema.parse(raw), b = scope.baselines[0];
  if (scope.baselines.length !== 1 || b?.kind !== "canonical-event" || b.id !== scope.eventId || contentHash(b.payload) !== b.revisionHash)
    throw stop("Wording repair requires its exact single reviewed event revision");
  const event = canonicalEventSchema.parse(b.payload), entries = event.characterEntryCheckpoints?.filter(e => e.actorId === scope.actorId);
  if (event.id !== scope.eventId || entries?.length !== 1 || entries[0]!.admission)
    throw stop("Wording repair cannot bypass an absent, ambiguous or explicitly blocked entry");
  const fields = new Set(edit.fields.map(f => f.field));
  if (!fields.size || fields.size !== edit.fields.length || edit.fields.some(f => f.value === entries[0]![f.field]))
    throw stop("Wording repair requires unique fields and a material change to each selected field");
  const entry = { ...entries[0]!, ...Object.fromEntries(edit.fields.map(f => [f.field, f.value])) };
  return [{ ...b, kind: "canonical-event" as const, payload: canonicalEventSchema.parse({ ...event,
    characterEntryCheckpoints: event.characterEntryCheckpoints!.map(e => e.actorId === scope.actorId ? entry : e) }) }];
}

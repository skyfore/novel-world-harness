import crypto from "node:crypto";
import { z } from "zod";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import type { WorldEngine } from "./engine.js";
import { idSchema, type Entity } from "./model.js";
import { branchCanonResolution, deriveReadHorizon, rangeWithinHorizon, type ReadHorizon } from "./read-horizon.js";

/** Default number of a character's own earlier lines offered as voice reference (design 4.6). */
export const VOICE_REFERENCE_LIMIT = 6;
export const VOICE_REFERENCE_MAX_CHARACTERS = 240;

/**
 * Exact source quotations whose speaker mention resolves to a character,
 * frozen with the revision. Pointers only; text is read from the immutable
 * source and verified against its hash. Entries without `basis` come from
 * compiled quotation annotations; `lexical-cue` entries are host-attributed
 * direct speech ("…”路明非说") that no annotation covers, kept as a
 * presentation-only fallback behind the annotated lines.
 */
export const voiceIndexSchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  entries: z.array(z.object({
    actorId: idSchema,
    quotationId: idSchema,
    startByte: z.number().int().nonnegative(),
    endByte: z.number().int().positive(),
    exactHash: z.string().regex(/^[a-f0-9]{64}$/),
    basis: z.literal("lexical-cue").optional(),
  }).strict()),
}).strict();
export type VoiceIndex = z.infer<typeof voiceIndexSchema>;
export type VoiceReference = { text: string };

type Quotation = { annotationType: string; id: string; speakerMentionId?: string; anchor?: { startByte: number; endByte: number; exactHash: string } };
type Resolution = { id: string; mentionId: string; status: string; entityId?: string; supersedesResolutionId?: string };
type LexicalCue = { speechStartByte: number; speechEndByte: number; entityId: string };

export function buildVoiceIndex(input: {
  sourceId: string;
  annotations: readonly Quotation[];
  entityResolutions: readonly Resolution[];
  entities: readonly Pick<Entity, "id" | "kind">[];
  /** Host speaker cues over the same immutable source; used only where no quotation annotation overlaps. */
  lexical?: { cues: readonly LexicalCue[]; source: Uint8Array };
}): VoiceIndex {
  const characters = new Set(input.entities.filter((entity) => entity.kind === "character").map((entity) => entity.id));
  const superseded = new Set(input.entityResolutions.flatMap((resolution) => resolution.supersedesResolutionId ? [resolution.supersedesResolutionId] : []));
  const speakers = new Map<string, string>();
  for (const resolution of [...input.entityResolutions].sort((a, b) => a.id.localeCompare(b.id))) {
    if (superseded.has(resolution.id) || !["resolved", "new-entity"].includes(resolution.status) || !resolution.entityId) continue;
    if (characters.has(resolution.entityId)) speakers.set(resolution.mentionId, resolution.entityId);
  }
  const entries = input.annotations
    .filter((annotation) => annotation.annotationType === "quotation" && annotation.speakerMentionId && annotation.anchor && speakers.has(annotation.speakerMentionId))
    .map((annotation) => ({ actorId: speakers.get(annotation.speakerMentionId!)!, quotationId: annotation.id,
      startByte: annotation.anchor!.startByte, endByte: annotation.anchor!.endByte, exactHash: annotation.anchor!.exactHash }));
  const quoted = input.annotations.flatMap((annotation) => annotation.annotationType === "quotation" && annotation.anchor ? [annotation.anchor] : []);
  const lexical = input.lexical ? input.lexical.cues
    .filter((cue) => characters.has(cue.entityId) && cue.speechEndByte <= input.lexical!.source.byteLength
      && !quoted.some((anchor) => anchor.startByte < cue.speechEndByte && cue.speechStartByte < anchor.endByte))
    .map((cue) => ({ actorId: cue.entityId, quotationId: `lexq-${cue.speechStartByte}`, startByte: cue.speechStartByte, endByte: cue.speechEndByte,
      exactHash: crypto.createHash("sha256").update(input.lexical!.source.subarray(cue.speechStartByte, cue.speechEndByte)).digest("hex"), basis: "lexical-cue" as const }))
    : [];
  return { version: 1, sourceId: input.sourceId, entries: [...entries, ...lexical].sort((a, b) => a.startByte - b.startByte || a.quotationId.localeCompare(b.quotationId)) };
}

/**
 * A character's latest lines that end within the read horizon and avoid any
 * unresolved event's mention: words they have already said at this point of
 * the story, so they carry no future knowledge. Text must match its frozen
 * hash. Annotated lines come first; lexical-cue lines only fill what is left.
 */
export function selectVoiceReferences(input: { index: VoiceIndex; actorId: string; horizon: ReadHorizon; source: Uint8Array; limit?: number; maxCharacters?: number }): VoiceReference[] {
  const limit = input.limit ?? VOICE_REFERENCE_LIMIT, maxCharacters = input.maxCharacters ?? VOICE_REFERENCE_MAX_CHARACTERS;
  const buffer = Buffer.from(input.source.buffer, input.source.byteOffset, input.source.byteLength);
  const chosen: Array<{ startByte: number; text: string }> = [];
  for (const lexicalPass of [false, true]) {
    for (const entry of [...input.index.entries].reverse()) {
      if (chosen.length >= limit) break;
      if ((entry.basis === "lexical-cue") !== lexicalPass) continue;
      if (entry.actorId !== input.actorId || entry.endByte > buffer.byteLength || !rangeWithinHorizon(input.horizon, entry.startByte, entry.endByte)) continue;
      const bytes = buffer.subarray(entry.startByte, entry.endByte);
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== entry.exactHash) continue;
      const text = bytes.toString("utf8").trim();
      if (!text) continue;
      const characters = Array.from(text);
      chosen.push({ startByte: entry.startByte, text: characters.length > maxCharacters ? `${characters.slice(0, maxCharacters - 1).join("")}…` : text });
    }
  }
  return chosen.sort((a, b) => a.startByte - b.startByte).map(({ text }) => ({ text }));
}

/** Voice references for one character at one committed head of a frozen-timeline branch. */
export async function branchVoiceReferences(input: { engine: WorldEngine; sourceId?: string; actorId: string; atCommit: string }): Promise<VoiceReference[]> {
  const context = await input.engine.contextForCommit(input.atCommit);
  if (!context.timeline || !context.voiceIndex || !input.sourceId || context.voiceIndex.sourceId !== input.sourceId) return [];
  const source = await (await WorkspaceStore.create(input.engine.workspaceRoot)).getSource(input.sourceId);
  if (!source) return [];
  const projection = await input.engine.projections.project(input.atCommit);
  const resolution = branchCanonResolution(projection.history.map((entry) => entry.event));
  const horizon = deriveReadHorizon(context.timeline, resolution.resolved, resolution.superseded);
  return selectVoiceReferences({ index: context.voiceIndex, actorId: input.actorId, horizon, source: await readSourceMaterial(input.engine.workspaceRoot, source) });
}

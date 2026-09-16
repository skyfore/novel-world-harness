import { z } from "zod";

export type LockedUtterance = {
  /** Derived from immutable event identity and its zero-based utterance index. */
  utteranceId?: string;
  speaker: string;
  addressees: string[];
  text: string;
  mode: "verbatim";
};

export function committedUtteranceId(eventId: string, index: number): string {
  if (!eventId || !Number.isSafeInteger(index) || index < 0) throw new Error("Invalid committed utterance identity");
  return `${eventId}:${index}`;
}

export const narrationBlocksSchema = z.object({
  version: z.literal("narration-blocks-v1"),
  blocks: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("prose"), text: z.string().min(1).max(12_000) }).strict(),
    z.object({ kind: z.literal("committed-utterance"), utteranceId: z.string().min(1).max(500) }).strict(),
  ])).min(1).max(256),
}).strict();
export type NarrationBlocks = z.infer<typeof narrationBlocksSchema>;

export function assertLockedUtteranceIds(locked: readonly LockedUtterance[]): void {
  if (locked.some(item => !item.utteranceId) || new Set(locked.map(item => item.utteranceId)).size !== locked.length) {
    throw new Error("Narration requires unique host-provided utterance IDs; stop for host frame review, do not retry or invent IDs.");
  }
}

/** All-or-nothing rendering. Never search or deduplicate dialogue by its text. */
export function renderNarrationBlocks(input: unknown, locked: readonly LockedUtterance[]): string {
  const document = narrationBlocksSchema.parse(input);
  assertLockedUtteranceIds(locked);
  const output: string[] = [];
  let index = 0;
  let proseRun = "";
  for (const block of document.blocks) {
    if (block.kind === "prose") {
      proseRun += block.text;
      if (locked.some(item => item.text && proseRun.includes(item.text))) {
        throw new Error("Narration prose copies locked dialogue or an overlapping short utterance. Rewrite that prose block once; retain every committed-utterance block and never delete a legitimate repeated utterance.");
      }
      if (locked.some(item => proseRun.includes(item.utteranceId!))) throw new Error("Narration prose exposes an internal utterance ID. Rewrite that prose block once without IDs.");
      output.push(block.text);
      continue;
    }
    proseRun = "";
    const expected = locked[index];
    if (!expected || expected.utteranceId !== block.utteranceId) {
      throw new Error("Narration has an unknown, duplicate, or out-of-order utterance ID. Copy resolvedAct.lockedUtterances[].utteranceId in supplied order, exactly once each; make at most one corrected rendering, never guess IDs or repeat the action.");
    }
    output.push(expected.text);
    index++;
  }
  if (index !== locked.length) throw new Error("Narration omitted a committed utterance. Copy every resolvedAct.lockedUtterances[].utteranceId in supplied order exactly once; correct the rendering once, never repeat the action.");
  return output.join("");
}

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildVoiceIndex, selectVoiceReferences } from "../src/world/voice-references.js";

const lines = [
  "「早上好。」", "「今天要下雨。」", "「别管我。」", "「那就这样吧。」", "「我们走。」",
  "「再说一遍？」", "「好吧。」", "「明天见。」", `「${"很长的一句话".repeat(60)}」`, "「未来的台词。」",
];
const text = lines.join("\n");
const source = Buffer.from(text, "utf8");
const anchorOf = (line: string) => {
  const startByte = Buffer.byteLength(text.slice(0, text.indexOf(line)), "utf8");
  const endByte = startByte + Buffer.byteLength(line, "utf8");
  return { startByte, endByte, exactHash: crypto.createHash("sha256").update(source.subarray(startByte, endByte)).digest("hex") };
};
const quotation = (id: string, line: string, speakerMentionId?: string) => ({ annotationType: "quotation", id, ...(speakerMentionId ? { speakerMentionId } : {}), anchor: anchorOf(line) });
const resolution = (id: string, mentionId: string, entityId: string, status = "resolved", supersedesResolutionId?: string) =>
  ({ id, mentionId, status, entityId, ...(supersedesResolutionId ? { supersedesResolutionId } : {}) });

describe("NPC voice references", () => {
  const entities = [{ id: "mira", kind: "character" as const }, { id: "ren", kind: "character" as const }, { id: "radio", kind: "artifact" as const }];

  it("indexes only quotations whose speaker resolves to a character", () => {
    const index = buildVoiceIndex({
      sourceId: "src", entities,
      annotations: [quotation("q1", lines[0]!, "m-mira"), quotation("q2", lines[1]!, "m-radio"), quotation("q3", lines[2]!, "m-unknown"), quotation("q4", lines[3]!), quotation("q5", lines[4]!, "m-ren"), { annotationType: "entity-mention", id: "m-mira" }],
      entityResolutions: [resolution("r1", "m-mira", "mira"), resolution("r2", "m-radio", "radio"), resolution("r3", "m-unknown", "mira", "ambiguous"), resolution("r4", "m-ren", "mira"), resolution("r5", "m-ren", "ren", "resolved", "r4")],
    });
    expect(index.entries.map((entry) => [entry.quotationId, entry.actorId])).toEqual([["q1", "mira"], ["q5", "ren"]]);
  });

  it("selects the character's latest lines before the read horizon, bounded, verified and avoiding prolepsis", () => {
    const annotations = lines.map((line, index) => quotation(`q${index}`, line, index === 4 ? "m-ren" : "m-mira"));
    const index = buildVoiceIndex({ sourceId: "src", entities, annotations, entityResolutions: [resolution("r1", "m-mira", "mira"), resolution("r2", "m-ren", "ren")] });
    const horizonByte = anchorOf(lines[9]!).startByte;
    const prolepsis = anchorOf(lines[6]!);
    const selected = selectVoiceReferences({ index, actorId: "mira", source, horizon: { horizonByte, frozenByDivergence: false, excludedRanges: [[prolepsis.startByte, prolepsis.endByte]] } });
    // Line 9 is beyond the horizon, line 6 is an unresolved event's mention, line 4 belongs to Ren.
    expect(selected).toHaveLength(6);
    expect(selected.map((reference) => reference.text).slice(0, 5)).toEqual([lines[1], lines[2], lines[3], lines[5], lines[7]]);
    expect(Array.from(selected.at(-1)!.text)).toHaveLength(240);
    expect(selected.at(-1)!.text.endsWith("…")).toBe(true);
    expect(selected.some((reference) => reference.text === lines[9])).toBe(false);
    const tampered = { ...index, entries: index.entries.map((entry) => entry.quotationId === "q8" ? { ...entry, exactHash: "0".repeat(64) } : entry) };
    expect(selectVoiceReferences({ index: tampered, actorId: "mira", source, horizon: { horizonByte, frozenByDivergence: false, excludedRanges: [] }, limit: 1 }).map((reference) => reference.text)).toEqual([lines[7]]);
  });
});

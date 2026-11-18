import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCanonTimeline } from "../src/world/canon-timeline.js";
import type { CanonicalEvent, EventRelation } from "../src/world/model.js";
import { buildLeadInReferences, MAX_TOTAL_REFERENCE_CHARACTERS } from "../src/world/narrative-source.js";
import { branchCanonResolution, deriveReadHorizon, rangeWithinHorizon } from "../src/world/read-horizon.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const event = (id: string): CanonicalEvent => ({ id, title: id, participants: [], storyTime: { kind: "unknown" }, preconditions: [], observedOutcome: { version: 1, operations: [] }, evidence: [], causalParents: [], confidence: 1 });

/** Events anchored at the given [start, end) mention extents. */
function timeline(extents: Record<string, Array<[number, number]>>, relations: EventRelation[] = []) {
  const annotations = Object.entries(extents).map(([id, ranges]) => ({ annotationType: "event-mention" as const, id: `m-${id}`, triggerAnchor: { startByte: ranges[0]![0], endByte: ranges[0]![0] + 1 }, extentAnchors: ranges.map(([startByte, endByte]) => ({ startByte, endByte })) }));
  const eventResolutions = Object.keys(extents).map((id) => ({ id: `r-${id}`, status: "resolved", canonicalEventId: id, eventMentionIds: [`m-${id}`] }));
  return buildCanonTimeline({ sourceId: "src", events: Object.keys(extents).map(event), relations, annotations, eventResolutions });
}

describe("read horizon", () => {
  it("bounds usable prose at the next unresolved event and excludes prolepsis", () => {
    // "omen" is foreshadowed at byte 50 (a prolepsis) but evidence places it after "meeting".
    const before: EventRelation = { id: "meeting-before-omen", fromEventId: "meeting", toEventId: "omen", type: "before", operationality: "non-operational", status: "inferred", confidence: 1, evidence: [] };
    const line = timeline({ opening: [[0, 20]], meeting: [[100, 140]], omen: [[200, 220], [50, 60]] }, [before]);
    expect(line.entries.map((entry) => entry.eventId)).toEqual(["opening", "meeting", "omen"]);
    const horizon = deriveReadHorizon(line, new Set(["opening"]));
    expect(horizon).toMatchObject({ horizonByte: 100, frozenByDivergence: false });
    expect(horizon.excludedRanges).toEqual([[50, 60], [100, 140], [200, 220]]);
    expect(rangeWithinHorizon(horizon, 0, 40)).toBe(true);
    expect(rangeWithinHorizon(horizon, 60, 95)).toBe(true);
    expect(rangeWithinHorizon(horizon, 40, 55)).toBe(false);
    expect(rangeWithinHorizon(horizon, 95, 120)).toBe(false);
    const allResolved = deriveReadHorizon(line, new Set(["opening", "meeting", "omen"]));
    expect(allResolved.horizonByte).toBe(Number.MAX_SAFE_INTEGER);
    expect(allResolved.excludedRanges).toEqual([]);
  });

  it("freezes at the first divergence even after later canon resolves", () => {
    const line = timeline({ a: [[0, 10]], b: [[100, 110]], c: [[200, 210]], d: [[300, 310]] });
    const horizon = deriveReadHorizon(line, new Set(["a", "c"]), new Set(["b"]));
    expect(horizon).toMatchObject({ horizonByte: 100, frozenByDivergence: true });
    expect(rangeWithinHorizon(horizon, 150, 190)).toBe(false);
    expect(branchCanonResolution([{ realizesCanonicalEventIds: ["a"] }, { supersedesCanonicalEventIds: ["b"] }, { canonicalAdaptation: { adaptedFromCanonicalEventId: "c" } }]))
      .toEqual({ resolved: new Set(["a", "c"]), superseded: new Set(["b"]) });
  });
});

describe("scene lead-in prose", () => {
  it("takes whole paragraphs before the horizon within the chapter, nearest first, avoiding prolepsis and unknown names", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-lead-in-")); roots.push(root);
    const text = [
      "Prologue: the old tower.",
      "第二章 雨夜",
      "Rain fell over the harbor.",
      "Mira mentioned the stranger once.",
      "The lamps flickered along the quay.",
      "A boat slid into the dark water.",
      "The bell rang at midnight.",
    ].join("\n") + "\n";
    const fixture = await createEvidenceFixture(root, text);
    const byteOf = (fragment: string) => Buffer.from(text.slice(0, text.indexOf(fragment)), "utf8").byteLength;
    const horizonByte = byteOf("The bell rang");
    const boat = [byteOf("A boat"), byteOf("The bell rang")] as [number, number];
    const horizon = { horizonByte, frozenByDivergence: false, excludedRanges: [] as Array<[number, number]> };
    const all = await buildLeadInReferences({ workspaceRoot: root, sourceId: fixture.source.id, horizon });
    expect(all.map((reference) => reference.text).join("\n")).toBe("Rain fell over the harbor.\nMira mentioned the stranger once.\nThe lamps flickered along the quay.\nA boat slid into the dark water.");
    expect(all.every((reference) => reference.authority === "presentation-only" && reference.safety === "read-horizon-prior-text" && reference.endByte <= horizonByte)).toBe(true);
    // A prolepsis range is skipped; an unavailable name stops the walk backwards.
    const guarded = await buildLeadInReferences({ workspaceRoot: root, sourceId: fixture.source.id, horizon: { ...horizon, excludedRanges: [boat] }, forbiddenNames: ["Mira"] });
    expect(guarded.map((reference) => reference.text)).toEqual(["The lamps flickered along the quay."]);
    // Committed references keep priority over the shared budget.
    const exhausted = await buildLeadInReferences({ workspaceRoot: root, sourceId: fixture.source.id, horizon, used: { references: 4, characters: 100 } });
    expect(exhausted).toEqual([]);
    const tight = await buildLeadInReferences({ workspaceRoot: root, sourceId: fixture.source.id, horizon, used: { references: 1, characters: MAX_TOTAL_REFERENCE_CHARACTERS - 40 } });
    expect(tight.map((reference) => reference.text)).toEqual(["A boat slid into the dark water."]);
  });
});

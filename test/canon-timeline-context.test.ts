import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleCanonTimeline, buildCanonTimeline, type TimelineBundle } from "../src/world/canon-timeline.js";
import { contentHash } from "../src/world/canonical.js";
import { WorldContextStore, type ScopedWorldArtifacts } from "../src/world/context.js";
import type { CanonicalEvent } from "../src/world/model.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const span = (line: number) => ({ span: { sourceId: "src", startLine: line, endLine: line, startByte: line * 10, endByte: line * 10 + 5, quoteHash: `q${line}` }, strength: "explicit" as const });
const event = (id: string, line: number): CanonicalEvent => ({
  id, title: id, participants: [], storyTime: { kind: "unknown" }, preconditions: [],
  observedOutcome: { version: 1, operations: [] }, evidence: [span(line)], causalParents: [], confidence: 1,
});

function artifacts(events: CanonicalEvent[]): ScopedWorldArtifacts {
  return {
    entities: [], propositions: [], attributions: [], claims: [], events, eventParticipations: [], eventRelations: [],
    spatialRelations: [], sceneOccurrences: [], eventFrames: [], actionSchemas: [], rules: [], goals: [], models: [], possibilities: [],
  };
}

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-timeline-context-"));
  roots.push(root);
  return root;
}

describe("canonical timeline in world contexts", () => {
  it("freezes the timeline into a prepared snapshot and restores it on load", async () => {
    const root = await tempRoot();
    const events = [event("second", 5), event("first", 2)];
    const timeline = buildCanonTimeline({ sourceId: "src", events, relations: [] });
    const store = new WorldContextStore(root);
    const context = await store.capturePrepared("src", contentHash("revision"), { ...artifacts(events), timeline });
    expect(context.timeline?.entries.map((entry) => entry.eventId)).toEqual(["first", "second"]);
    const reloaded = await store.load(context.canonicalSnapshotHash!);
    expect(reloaded.timeline).toEqual(timeline);
  });

  it("keeps legacy snapshots without a timeline", async () => {
    const root = await tempRoot();
    const context = await new WorldContextStore(root).capturePrepared("src", contentHash("legacy"), artifacts([event("only", 1)]));
    expect(context.timeline).toBeUndefined();
  });

  it("rejects a timeline that does not cover the snapshot's events", async () => {
    const root = await tempRoot();
    const timeline = buildCanonTimeline({ sourceId: "src", events: [event("only", 1)], relations: [] });
    await expect(new WorldContextStore(root).capturePrepared("src", contentHash("bad"), { ...artifacts([event("only", 1), event("extra", 2)]), timeline }))
      .rejects.toThrow(/TIMELINE_EVENT_MISSING/);
    await expect(new WorldContextStore(root).capturePrepared("other", contentHash("bad"), { ...artifacts([]), timeline: { ...timeline, entries: [] } }))
      .rejects.toThrow(/TIMELINE_SOURCE_MISMATCH/);
  });

  it("prefers the bundle's frozen timeline and derives one for legacy bundles", () => {
    const events = [event("b", 4), event("a", 1)];
    const legacy: TimelineBundle = { source: { id: "src" }, canonical: { events, eventRelations: [] } };
    const derived = bundleCanonTimeline(legacy);
    expect(derived.entries.map((entry) => entry.eventId)).toEqual(["a", "b"]);
    expect(bundleCanonTimeline(legacy)).toBe(derived);
    const frozen = { ...derived, entries: [...derived.entries] };
    expect(bundleCanonTimeline({ ...legacy, canonical: { ...legacy.canonical, timeline: frozen } })).toBe(frozen);
  });
});

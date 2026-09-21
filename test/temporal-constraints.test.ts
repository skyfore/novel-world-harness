import { describe, expect, it } from "vitest";
import { TemporalConstraints } from "../src/world/temporal-constraints.js";
import { validateEventRelationCatalog } from "../src/world/event-relations.js";
import { deriveEntryCut } from "../src/world/entry-cut.js";
import type { CanonicalEvent, EventRelation, StoryTime } from "../src/world/model.js";
const event = (id: string, storyTime: StoryTime = { kind: "unknown" }): CanonicalEvent => ({ id, title: id, participants: [], storyTime, preconditions: [], observedOutcome: { version: 1, operations: [] }, evidence: [], causalParents: [], confidence: 1 });
const rel = (a: string, type: EventRelation["type"], b: string): EventRelation => ({ id: `${a}-${type}-${b}`, fromEventId: a, toEventId: b, type, operationality: "non-operational", status: "inferred", confidence: 1, evidence: [] });
const catalog = (...ids: string[]) => new Map(ids.map(id => [id, event(id)]));

describe("transitive interval constraints", () => {
  it.each([["Ada", "hall", "exit"], ["宁", "房间", "清晨"]])("derives order through containment without inventing order among peers: %s", (a,b,c) => {
    const events = catalog(a,b,c,"peer");
    const relations = [rel(a,"during",b), rel("peer","during",b), rel(b,"before",c)];
    const graph = new TemporalConstraints(events, relations);
    expect(graph.issues).toEqual([]);
    expect(graph.definitelyBefore(a,c)).toBe(true);
    expect(graph.definitelyBefore(a,"peer")).toBe(false);
    expect(new TemporalConstraints(new Map([...events].reverse()), [...relations].reverse()).order([...events.keys()])).toEqual(graph.order([...events.keys()]));
  });
  it("rejects indirect order/overlap contradictions through the production catalog validator", () => {
    const events = catalog("a","b","c");
    expect(validateEventRelationCatalog({ events, relations: [rel("a","before","b"), rel("b","before","c"), rel("a","overlaps","c")] }))
      .toContainEqual(expect.objectContaining({ code: "TEMPORAL_CONSTRAINT_CONTRADICTION" }));
  });
  it("detects a containment contradiction invisible to pairwise anchor checks", () => {
    const events = catalog("a","box","later");
    const graph = new TemporalConstraints(events, [rel("box","contains","a"),rel("box","before","later"),rel("later","before","a")]);
    expect(graph.issues[0]?.code).toBe("TEMPORAL_CONSTRAINT_CONTRADICTION");
    expect(graph.definitelyBefore("a","later")).toBe(false);
  });
  it("rejects transitive disagreement with numeric anchors but never mixes time scales", () => {
    const events = catalog("a","b","c");
    events.set("a",event("a",{kind:"ordinal",label:"late",orderHint:10}));
    events.set("c",event("c",{kind:"ordinal",label:"early",orderHint:1}));
    expect(new TemporalConstraints(events,[rel("a","before","b"),rel("b","before","c")]).issues).not.toEqual([]);
    events.set("c",event("c",{kind:"exact",value:"2020-01-01",precision:"day"}));
    expect(new TemporalConstraints(events,[]).definitelyBefore("a","c")).toBe(false);
  });
  it("ignores contested relations and free-text temporal offsets", () => {
    const events = catalog("a","b");
    events.set("a",event("a",{kind:"relative",anchorEventId:"b",relation:"after",offset:"many years"}));
    expect(new TemporalConstraints(events,[]).definitelyBefore("b","a")).toBe(false);
    const relations = [rel("a","before","b"), {...rel("b","before","a"),status:"contested" as const}];
    expect(new TemporalConstraints(events,relations).issues).toEqual([]);
  });
  it("uses proven relative anchors and interval order in the real entry cut", () => {
    const events = catalog("opening","inside","frame","entry");
    events.set("opening",event("opening",{kind:"relative",anchorEventId:"frame",relation:"before"}));
    const relations = [rel("inside","during","frame"),rel("frame","before","entry")];
    const cut = deriveEntryCut({ events: [...events.values()], relations, beforeEventId:"entry", baselineEventId:"opening" });
    expect(cut.issues).toEqual([]);
    expect(cut.completedEventIds).toContain("inside");
    expect(cut.replayEventIds).toContain("inside");
  });
  it("keeps symmetric overlap distinct from containment, and handles equal boundaries", () => {
    const events = catalog("a","b","c");
    const graph = new TemporalConstraints(events,[rel("a","overlaps","b"),rel("b","before","c")]);
    expect(graph.definitelyBefore("a","c")).toBe(false);
    expect(new TemporalConstraints(events,[rel("a","starts","b"),rel("a","finishes","b")]).issues).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";
import { DEFAULT_COMPLETENESS_POLICY, measureWorldCompleteness } from "../src/compiler/world-completeness.js";
import { formatCompletenessTable } from "../src/commands/novel-completeness.js";

const lines = ["\t“我们走。”路明非说。\n", "\t诺诺点头，“好。”\n", "\t风吹过走廊。\n", "\t“这是什么？”路明非问。\n"];
const text = lines.join("");
const source = Buffer.from(text, "utf8");
const byteOf = (needle: string, from = 0) => Buffer.byteLength(text.slice(0, text.indexOf(needle, from)), "utf8");
const anchor = (needle: string, from = 0) => {
  const startByte = byteOf(needle, from);
  return { version: 1, sourceId: "src", startByte, endByte: startByte + Buffer.byteLength(needle, "utf8"), startLine: 1, endLine: 1, exactHash: "0".repeat(64) };
};
const unitAnchors = lines.map((line, index) => anchor(line, index === 0 ? 0 : text.indexOf(line)));
const units = unitAnchors.map((unitAnchor, index) => ({ version: 1, id: `u${index}`, sourceId: "src", kind: "sentence", anchor: unitAnchor, ordinal: index, proposedBy: "deterministic", confidence: 1, evidenceAssertionIds: [] }));
const derivation = { runId: "run", worker: "test", ontologyVersion: "observation-v1" };
const span = (startByte: number, endByte: number) => ({ span: { sourceId: "src", startByte, endByte, startLine: 1, endLine: 1, quoteHash: "0".repeat(64) }, strength: "explicit" });

function bundle(): PreparedNovelBundle {
  const record = (unitId: string, status: string) => ({ version: 1, unitId, status, annotationIds: [], evidenceAssertionIds: [], reviewedBy: "model", reviewedAt: "2026-11-18T00:00:00.000Z", batchIds: [] });
  return {
    source: { id: "src" },
    admission: null,
    canonical: {
      entities: [
        { id: "lu", kind: "character", canonicalName: "路明非", aliases: [], evidence: [] },
        { id: "nono", kind: "character", canonicalName: "诺诺", aliases: [], evidence: [] },
        { id: "hall", kind: "location", canonicalName: "走廊", aliases: [], evidence: [] },
      ],
      events: [{ id: "e1", title: "走", participants: ["lu"], preconditions: [], causalParents: [], confidence: 1, evidence: [], storyTime: { kind: "ordinal", label: "1" },
        observedOutcome: { version: 1, operations: [{ op: "set", entityId: "lu", field: "character.location", value: "hall" }] } }],
      eventParticipations: [{ id: "p1", eventId: "e1", entityId: "lu", role: "agent", presence: "physical", confidence: 1, evidence: [] }],
      sceneOccurrences: [{ ontologyVersion: "scene-occurrence-v1", id: "s1", discourseSegmentIds: ["ds1"], eventIds: ["e1"], locationId: "hall", viewpointActorIds: [], presentActorIds: ["lu"],
        entryConditions: [], exitConditions: [], evidence: [span(unitAnchors[0]!.startByte, unitAnchors[1]!.endByte)] }],
      spatialRelations: [], semanticEffects: [], eventExecutions: [], acquisitions: [], goals: [],
      propositions: [], eventRelations: [], normTemplates: [], processTemplates: [], possibilities: [], rules: [], actionSchemas: [],
      models: [{ actorId: "lu", traits: { brave: 0.5 }, decisionBiases: {}, evidence: [] }],
      initialWorld: { delta: { version: 1, operations: [] }, participantPresence: [{ entityId: "lu", mode: "physical" }] },
    },
    compilerSnapshot: {
      structure: { units, baseUnitIds: units.map((unit) => unit.id) },
      annotations: [
        { version: 1, id: "m1", sourceId: "src", derivation, annotationType: "entity-mention", anchor: anchor("路明非"), surface: "路明非", form: "proper", kindCandidates: ["character"], confidence: 1 },
        { version: 1, id: "m2", sourceId: "src", derivation, annotationType: "entity-mention", anchor: anchor("诺诺"), surface: "诺诺", form: "proper", kindCandidates: ["character"], confidence: 1 },
        { version: 1, id: "q1", sourceId: "src", derivation, annotationType: "quotation", anchor: anchor("“我们走。”"), mode: "direct", speakerMentionId: "m1", addresseeMentionIds: [], attributionConfidence: 1 },
        { version: 1, id: "ds1", sourceId: "src", derivation, annotationType: "discourse-segment", kind: "scene", anchors: [unitAnchors[0]], confidence: 1 },
        { version: 1, id: "em1", sourceId: "src", derivation, annotationType: "event-mention", triggerAnchor: anchor("走"), trigger: "走", extentAnchors: [unitAnchors[0]],
          eventTypeCandidates: ["movement"], participantMentionIds: ["m1"], salience: "major", confidence: 1 },
      ],
      entityResolutions: [
        { id: "r1", mentionId: "m1", status: "resolved", entityId: "lu" },
        { id: "r2", mentionId: "m2", status: "resolved", entityId: "nono" },
      ],
      eventResolutions: [{ id: "er1", eventMentionIds: ["em1"], status: "new-event", canonicalEventId: "e1", supersedesResolutionIds: [] }],
      evidenceBindings: [],
      accounting: { records: [record("u0", "represented"), record("u1", "background-only"), record("u2", "background-only"), record("u3", "duplicate-description")] },
      roleRoster: null,
    },
  } as unknown as PreparedNovelBundle;
}

describe("world-model completeness", () => {
  const policy = { ...DEFAULT_COMPLETENESS_POLICY, speakingLineThreshold: 1 };
  const report = measureWorldCompleteness(bundle(), source, { policy });
  const byId = new Map(report.measures.map((item) => [item.id, item]));

  it("counts source-derived denominators and exposes units whose disposition hides speech or names", () => {
    expect(byId.get("source.accounted")).toMatchObject({ numerator: 4, total: 4, status: "satisfied" });
    // Unit 1 hides unannotated speech (its name is annotated); unit 3 hides speech and a name; unit 2 has no signal.
    expect(byId.get("source.hidden-units")).toMatchObject({ numerator: 2, status: "gap" });
    expect(report.queues.hiddenUnits.ranges.map((range) => [range.startByte, range.speech, range.names]))
      .toEqual([[unitAnchors[1]!.startByte, 1, 0], [unitAnchors[3]!.startByte, 1, 1]]);
    expect(byId.get("observation.speech-annotated")).toMatchObject({ numerator: 1, total: 3, denominator: "source", status: "gap" });
    expect(byId.get("observation.speech-attributed")).toMatchObject({ numerator: 3, total: 3, status: "satisfied",
      note: "1 by compiled quotation annotations, 2 by host lexical cue only." });
    expect(byId.get("observation.names-annotated")).toMatchObject({ numerator: 2, total: 3 });
  });

  it("checks scene presence, space and character depth against who actually speaks", () => {
    expect(byId.get("scenes.speakers-present")).toMatchObject({ numerator: 1, total: 2, status: "gap" });
    expect(report.queues.absentSpeakers).toEqual([{ sceneId: "s1", actorId: "nono", lines: 1 }]);
    expect(byId.get("space.locations-on-graph")).toMatchObject({ numerator: 0, total: 1, status: "gap" });
    expect(report.queues.locationsOffGraph).toEqual(["hall"]);
    expect(report.speakingCharacters.map((item) => [item.actorId, item.lines, item.depth])).toEqual([["lu", 2, true], ["nono", 1, false]]);
    expect(byId.get("characters.speaking-with-disposition")).toMatchObject({ numerator: 1, total: 2 });
    expect(byId.get("events.effectful")).toMatchObject({ numerator: 1, total: 1, status: "satisfied" });
  });

  it("reports a missing denominator as unknown, never as a pass", () => {
    expect(byId.get("characters.roster-reviewed")!.status).toBe("unknown");
    expect(byId.get("agency.speaking-enterable")!.status).toBe("unknown");
    expect(byId.get("knowledge.acquisition-paths")).toMatchObject({ total: 0, ratio: null, status: "unknown" });
    expect(report.summary.unknown).toBeGreaterThanOrEqual(3);
    expect(formatCompletenessTable(report).split("\n")[0]).toContain("unknown");
  });
});

describe("world-model completeness v2 layers", () => {
  const policy = { ...DEFAULT_COMPLETENESS_POLICY, speakingLineThreshold: 1, loreTermThreshold: 2, rosterPairScenes: 2 };
  const v2Text = "\t第二天，“走吧。”明非说。他想起“言灵”。\n\t“好。”诺诺说，“言灵是真的。”\n";
  const v2Source = Buffer.from(v2Text, "utf8");
  const at = (needle: string) => {
    const startByte = Buffer.byteLength(v2Text.slice(0, v2Text.indexOf(needle)), "utf8");
    return { version: 1, sourceId: "src", startByte, endByte: startByte + Buffer.byteLength(needle, "utf8"), startLine: 1, endLine: 1, exactHash: "0".repeat(64) };
  };
  const [line1, line2] = v2Text.split(/(?<=\n)/u);
  function v2Bundle(extra: { relation?: boolean; concept?: boolean; precondition?: boolean } = {}): PreparedNovelBundle {
    const base = bundle() as unknown as { canonical: Record<string, unknown>; compilerSnapshot: Record<string, unknown> };
    const units = [line1!, line2!].map((line, index) => ({ version: 1, id: `v${index}`, sourceId: "src", kind: "sentence", anchor: at(line), ordinal: index, proposedBy: "deterministic", confidence: 1, evidenceAssertionIds: [] }));
    const scene = (id: string, line: string) => ({ ontologyVersion: "scene-occurrence-v1", id, discourseSegmentIds: [], eventIds: ["e1"], locationUnknown: { reason: "unstated" }, viewpointActorIds: [], presentActorIds: ["lu", "nono"],
      entryConditions: [], exitConditions: [], evidence: [span(at(line).startByte, at(line).endByte)] });
    return {
      ...base,
      canonical: {
        ...base.canonical,
        entities: [
          { id: "lu", kind: "character", canonicalName: "路明非", aliases: [], evidence: [] },
          { id: "nono", kind: "character", canonicalName: "诺诺", aliases: [], evidence: [] },
          { id: "man", kind: "character", canonicalName: "男人", aliases: [], evidence: [] },
          ...(extra.concept ? [{ id: "yanling", kind: "concept", canonicalName: "言灵", aliases: [], evidence: [] }] : []),
        ],
        events: [{ id: "e1", title: "走", participants: ["lu"], preconditions: extra.precondition ? [{ kind: "exists", entityId: "lu" }] : [], causalParents: [], confidence: 1,
          evidence: [], storyTime: { kind: "ordinal", label: "1" }, observedOutcome: { version: 1, operations: [{ op: "set", entityId: "lu", field: "character.mood", value: "calm" }] } }],
        sceneOccurrences: [scene("s1", line1!), scene("s2", line2!)],
        propositions: extra.relation ? [{ id: "p-rel", subjectEntityId: "lu", relationId: "friend-of", object: { kind: "entity", entityId: "nono" }, polarity: "positive" }] : [],
      },
      compilerSnapshot: {
        ...base.compilerSnapshot,
        structure: { units, baseUnitIds: units.map((unit) => unit.id) },
        annotations: [
          { version: 1, id: "m1", sourceId: "src", derivation, annotationType: "entity-mention", anchor: at("明非"), surface: "明非", form: "proper", kindCandidates: ["character"], confidence: 1 },
          { version: 1, id: "m2", sourceId: "src", derivation, annotationType: "entity-mention", anchor: at("诺诺"), surface: "诺诺", form: "proper", kindCandidates: ["character"], confidence: 1 },
          { version: 1, id: "em1", sourceId: "src", derivation, annotationType: "event-mention", triggerAnchor: at("走"), trigger: "走", extentAnchors: [at(line1!)],
            eventTypeCandidates: ["movement"], participantMentionIds: ["m1"], salience: "major", confidence: 1 },
        ],
        entityResolutions: [
          { id: "r1", mentionId: "m1", status: "resolved", entityId: "lu", aliasType: "nickname" },
          { id: "r2", mentionId: "m2", status: "resolved", entityId: "nono" },
        ],
        eventResolutions: [{ id: "er1", eventMentionIds: ["em1"], status: "new-event", canonicalEventId: "e1", supersedesResolutionIds: [] }],
        accounting: { records: [] },
      },
    } as unknown as PreparedNovelBundle;
  }
  const measuresOf = (report: ReturnType<typeof measureWorldCompleteness>) => new Map(report.measures.map((item) => [item.id, item]));

  it("measures aliases, generic names, roster relations, time anchors, conditions, autonomy and lore", () => {
    const report = measureWorldCompleteness(v2Bundle(), v2Source, { policy });
    const byId = measuresOf(report);
    expect(byId.get("identity.aliases-attached")).toMatchObject({ numerator: 1, total: 2, status: "gap" });
    expect(report.queues.unattachedAliases).toEqual([{ entityId: "lu", surface: "明非", mentions: 1 }]);
    expect(byId.get("identity.generic-names")).toMatchObject({ numerator: 1, status: "gap" });
    expect(report.roster).toMatchObject({ reviewed: false });
    // Provisional roster: the denominator exists but cannot pass without review.
    expect(byId.get("relations.roster-pairs")).toMatchObject({ numerator: 0, total: 1, status: "unknown" });
    expect(report.queues.rosterPairs).toEqual([{ subject: "pair:lu|nono", scenes: 2 }]);
    expect(byId.get("time.anchored-events")).toMatchObject({ numerator: 0, total: 1, status: "gap" });
    expect(report.queues.unanchoredEvents).toEqual(["e1"]);
    expect(byId.get("causality.conditioned-key-events")).toMatchObject({ numerator: 0, total: 1, status: "unknown" });
    expect(byId.get("possibility.autonomous-templates")).toMatchObject({ numerator: 0, status: "gap" });
    expect(byId.get("lore.terms-grounded")).toMatchObject({ numerator: 0, total: 1, status: "gap" });
    expect(report.queues.ungroundedTerms.map((term) => term.surface)).toEqual(["言灵"]);
    expect(byId.get("cost.per-source-kb")).toMatchObject({ status: "info" });
  });

  it("accepts artifacts or explicit reviewed dispositions, and a reviewed roster makes roster measures decidable", () => {
    const roster = { reviewed: true, actorIds: ["lu", "nono"] };
    const withArtifacts = measuresOf(measureWorldCompleteness(v2Bundle({ relation: true, concept: true, precondition: true }), v2Source, { policy, roster }));
    expect(withArtifacts.get("relations.roster-pairs")).toMatchObject({ numerator: 1, total: 1, status: "satisfied" });
    expect(withArtifacts.get("causality.conditioned-key-events")).toMatchObject({ numerator: 1, status: "satisfied" });
    expect(withArtifacts.get("lore.terms-grounded")).toMatchObject({ numerator: 1, status: "satisfied" });
    expect(withArtifacts.get("characters.roster-reviewed")).toMatchObject({ status: "satisfied" });
    const dispositions = [
      { measureId: "relations.roster-pairs", subject: "pair:lu|nono", verdict: "not-stated" as const, rationale: "No relation is stated." },
      { measureId: "causality.conditioned-key-events", subject: "event:e1", verdict: "unconditioned" as const, rationale: "Nothing gates it." },
      { measureId: "lore.terms-grounded", subject: "term:言灵", verdict: "narration-only" as const, rationale: "Mentioned only." },
    ];
    const withDispositions = measuresOf(measureWorldCompleteness(v2Bundle(), v2Source, { policy, roster, dispositions }));
    expect(withDispositions.get("relations.roster-pairs")!.status).toBe("satisfied");
    expect(withDispositions.get("causality.conditioned-key-events")!.status).toBe("satisfied");
    expect(withDispositions.get("lore.terms-grounded")!.status).toBe("satisfied");
  });

  it("limits source denominators and artifacts to a scope with the same implementation", () => {
    const scope = { startByte: at(line2!).startByte, endByte: at(line2!).endByte };
    const report = measureWorldCompleteness(v2Bundle(), v2Source, { policy, scope });
    const byId = measuresOf(report);
    expect(report.scope).toEqual(scope);
    expect(byId.get("observation.speech-annotated")).toMatchObject({ total: 2 });
    expect(byId.get("observation.names-annotated")!.total).toBeLessThanOrEqual(1);
    expect(byId.get("time.anchored-events")).toMatchObject({ total: 0, status: "unknown" });
    expect(byId.get("events.typed-agent")).toMatchObject({ total: 0 });
    expect(byId.get("lore.terms-grounded")).toMatchObject({ total: 1 });
  });
});

describe("gap-loop queues and reviewed exceptions", () => {
  const policy = { ...DEFAULT_COMPLETENESS_POLICY, speakingLineThreshold: 1 };
  const measuresOf = (report: ReturnType<typeof measureWorldCompleteness>) => new Map(report.measures.map((item) => [item.id, item]));

  it("bounds queues by default, keeps their totals, and lets the gap loop read the whole tail", () => {
    const longSource = Buffer.from(text + "路明非来了。".repeat(60), "utf8");
    const bounded = measureWorldCompleteness(bundle(), longSource, { policy });
    expect(bounded.queues.unannotatedNames.total).toBe(61);
    expect(bounded.queues.unannotatedNames.ranges).toHaveLength(50);
    const whole = measureWorldCompleteness(bundle(), longSource, { policy, queueLimit: Number.POSITIVE_INFINITY });
    expect(whole.queues.unannotatedNames.ranges).toHaveLength(61);
    expect(whole.queues.unannotatedNames.ranges.at(-1)!.startByte).toBeGreaterThan(bounded.queues.unannotatedNames.ranges.at(-1)!.startByte);
  });

  it("closes ratio-measure items by reviewed exceptions without counting them as facts; narration-only segments count as covered", () => {
    // Same byte length as 诺诺: the second line's reply now has no speaker cue.
    const anonymous = Buffer.from(text.replace("诺诺点头", "有人点头"), "utf8");
    const base = measureWorldCompleteness(bundle(), anonymous, { policy });
    const unattributed = base.queues.unattributedSpeech.ranges;
    expect(unattributed.length).toBeGreaterThan(0);
    const before = measuresOf(base).get("observation.speech-attributed")!;
    const dispositions = unattributed.map((range) => ({ measureId: "observation.speech-attributed", subject: `speech:${range.startByte}`, verdict: "unknown" as const, rationale: "The text does not say who answers." }));
    const reviewed = measureWorldCompleteness(bundle(), anonymous, { policy, dispositions });
    expect(reviewed.queues.unattributedSpeech.ranges).toEqual([]);
    expect(measuresOf(reviewed).get("observation.speech-attributed")).toMatchObject({ numerator: before.numerator, total: before.total });

    // Narrative outside every scene: u2..u3. A segment reviewed as narration only covers it.
    const withSegment = bundle() as unknown as { compilerSnapshot: { annotations: unknown[] } };
    withSegment.compilerSnapshot.annotations.push({ version: 1, id: "ds2", sourceId: "src", derivation, annotationType: "discourse-segment", kind: "narrator-commentary", anchors: [unitAnchors[2], unitAnchors[3]], confidence: 1 });
    const uncovered = measureWorldCompleteness(withSegment as unknown as PreparedNovelBundle, source, { policy });
    expect(measuresOf(uncovered).get("scenes.narrative-covered")!.status).toBe("gap");
    expect(uncovered.queues.narrativeOutsideScenes.ranges).toEqual([{ startByte: unitAnchors[2]!.startByte, endByte: unitAnchors[3]!.endByte }]);
    const covered = measureWorldCompleteness(withSegment as unknown as PreparedNovelBundle, source, { policy,
      dispositions: [{ measureId: "scenes.narrative-covered", subject: "segment:ds2", verdict: "narration-only", rationale: "Narrator commentary, no staged occurrence." }] });
    expect(measuresOf(covered).get("scenes.narrative-covered")).toMatchObject({ status: "satisfied" });
    expect(covered.queues.narrativeOutsideScenes.ranges).toEqual([]);
  });

  it("counts an event mention reviewed as non-referential as resolved", () => {
    const withHabit = bundle() as unknown as { compilerSnapshot: { annotations: unknown[]; eventResolutions: unknown[] } };
    withHabit.compilerSnapshot.annotations.push({ version: 1, id: "em2", sourceId: "src", derivation, annotationType: "event-mention", triggerAnchor: anchor("吹"), trigger: "吹", extentAnchors: [unitAnchors[2]],
      eventTypeCandidates: ["other"], participantMentionIds: [], salience: "minor", confidence: 1 });
    const open = measureWorldCompleteness(withHabit as unknown as PreparedNovelBundle, source, { policy });
    expect(measuresOf(open).get("observation.event-mentions-resolved")).toMatchObject({ numerator: 1, total: 2, status: "gap" });
    expect(open.queues.unresolvedEventMentions.mentions.map((item) => item.mentionId)).toEqual(["em2"]);
    withHabit.compilerSnapshot.eventResolutions.push({ id: "er2", eventMentionIds: ["em2"], status: "non-referential", supersedesResolutionIds: [] });
    const reviewed = measureWorldCompleteness(withHabit as unknown as PreparedNovelBundle, source, { policy });
    expect(measuresOf(reviewed).get("observation.event-mentions-resolved")).toMatchObject({ numerator: 2, total: 2, status: "satisfied" });
  });

  it("keeps missing majors named by the roster review in the denominator until they are modelled or reviewed", () => {
    const roster = { reviewed: true, actorIds: ["lu"], missing: ["诺诺", "白鸦"] };
    const report = measureWorldCompleteness(bundle(), source, { policy, roster });
    // 诺诺 matches an entity and joins the roster; 白鸦 has no entity yet and still counts.
    expect(report.roster.actorIds.sort()).toEqual(["lu", "nono"]);
    expect(measuresOf(report).get("characters.roster-modelled")).toMatchObject({ numerator: 0, total: 3, status: "gap" });
    expect(report.queues.rosterUnmodelled.map((item) => item.subject)).toEqual(["actor:lu", "actor:nono", "missing:白鸦"]);
    const dispositions = report.queues.rosterUnmodelled.map((item) => ({ measureId: "characters.roster-modelled", subject: item.subject, verdict: "not-stated" as const, rationale: "Reviewed." }));
    expect(measuresOf(measureWorldCompleteness(bundle(), source, { policy, roster, dispositions })).get("characters.roster-modelled")).toMatchObject({ numerator: 3, status: "satisfied" });
    // Without a review the roster measure cannot fail: it is unknown.
    expect(measuresOf(measureWorldCompleteness(bundle(), source, { policy })).get("characters.roster-modelled")!.status).toBe("unknown");
  });

  it("drops a time expression the observation review rejected from the time denominator", () => {
    const v2Text = "\t第二天，“走吧。”路明非说。\n";
    const v2Source = Buffer.from(v2Text, "utf8");
    const base = bundle() as unknown as { canonical: { events: Array<{ evidence: unknown[] }> }; compilerSnapshot: { annotations: Array<Record<string, unknown>>; eventResolutions: unknown[] } };
    const line = { version: 1, sourceId: "src", startByte: 0, endByte: v2Source.byteLength, startLine: 1, endLine: 1, exactHash: "0".repeat(64) };
    base.compilerSnapshot.annotations = base.compilerSnapshot.annotations.filter((item) => item.id === "em1").map((item) => ({ ...item, extentAnchors: [line] }));
    const timed = measureWorldCompleteness(base as unknown as PreparedNovelBundle, v2Source, { policy });
    expect(measuresOf(timed).get("time.anchored-events")).toMatchObject({ total: 1, status: "gap" });
    const time = Buffer.byteLength("\t", "utf8");
    const rejected = measureWorldCompleteness(base as unknown as PreparedNovelBundle, v2Source, { policy, handled: { times: [{ startByte: time, endByte: time + Buffer.byteLength("第二天", "utf8") }] } });
    expect(measuresOf(rejected).get("time.anchored-events")).toMatchObject({ total: 0 });
  });
});

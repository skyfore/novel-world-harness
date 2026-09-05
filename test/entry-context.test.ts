import { describe, expect, it } from "vitest";
import type { PreparedNovelBundle } from "../src/compiler/prepared-cache.js";
import {
  deriveCharacterEntryOptions,
  deriveCharacterEntrySeed,
  formatReaderEntryContext,
} from "../src/world/entry-context.js";

const evidence = (startLine: number) => [{
  span: { sourceId: "source", startLine, endLine: startLine, quoteHash: `quote-${startLine}` },
  strength: "explicit" as const,
}];

function bundle(): PreparedNovelBundle {
  return {
    version: 1,
    source: { id: "source", contentMd5: "a".repeat(32), contentSha256: "source".padEnd(64, "0") },
    segmenterVersion: 6,
    batchIds: [],
    canonical: {
      entities: [
        { id: "opening-actor", kind: "character", canonicalName: "Opening Actor", aliases: [], evidence: evidence(1) },
        { id: "later-actor", kind: "character", canonicalName: "Later Actor", aliases: [], evidence: evidence(20) },
        { id: "letter-signer", kind: "character", canonicalName: "Letter Signer", aliases: [], evidence: evidence(10) },
        { id: "letter", kind: "artifact", canonicalName: "Letter", aliases: [], evidence: evidence(10) },
        { id: "hall", kind: "location", canonicalName: "The Hall", aliases: [], evidence: evidence(20) },
      ],
      claims: [],
      rules: [],
      goals: [],
      models: [],
      possibilities: [],
      initialWorld: {
        version: 1,
        readerSetup: "At the opening tower, Opening Actor is preparing to leave while an unresolved threshold makes the departure urgent.",
        readerContext: {
          version: 1,
          focalActorId: "opening-actor",
          facts: [
            { id: "focal", kind: "focal-identity", summary: "Opening Actor is preparing to leave the tower.", temporalClass: "at-checkpoint", basis: "checkpoint-state", entityIds: ["opening-actor"], focalKnowledgeClaimIds: [], dependsOnFactIds: [] },
            { id: "place", kind: "time-place", summary: "The opening takes place at the tower threshold.", temporalClass: "at-checkpoint", basis: "checkpoint-state", entityIds: ["opening-actor"], focalKnowledgeClaimIds: [], dependsOnFactIds: [] },
            { id: "cause", kind: "causal-premise", summary: "Letter Signer sent the summons that made departure urgent.", temporalClass: "later-discourse-preexisting", basis: "source-narrator-established", entityIds: ["opening-actor", "letter-signer"], focalKnowledgeClaimIds: [], dependsOnFactIds: [] },
            { id: "stance", kind: "actor-stance", summary: "Opening Actor remains ambivalent about answering it.", temporalClass: "at-checkpoint", basis: "checkpoint-state", entityIds: ["opening-actor"], holderEntityId: "opening-actor", stance: "ambivalent", focalKnowledgeClaimIds: [], dependsOnFactIds: ["cause"] },
            { id: "pressure", kind: "immediate-pressure", summary: "The unanswered summons makes the threshold urgent.", temporalClass: "at-checkpoint", basis: "checkpoint-state", entityIds: ["opening-actor"], focalKnowledgeClaimIds: [], dependsOnFactIds: ["cause"] },
          ],
          entityGlosses: [{
            entityId: "letter-signer",
            relationshipToFocal: "the person who summoned Opening Actor",
            whyRelevantNow: "their summons created the present decision",
            factIds: ["cause"],
          }],
          immediateSituation: {
            summary: "Opening Actor must decide whether to cross the threshold in answer to the summons.",
            causalFactIds: ["cause"],
            pressureFactIds: ["pressure"],
            unresolvedFactIds: ["stance", "pressure"],
            outcomePolicy: "withhold-post-checkpoint-outcomes",
          },
        },
        participantPresence: [{ entityId: "opening-actor", mode: "physical" }],
        actorObservations: [{ actorId: "opening-actor", summary: "The tower threshold is directly ahead." }],
        delta: {
          version: 1,
          operations: [{ op: "set", entityId: "opening-actor", field: "character.plan", value: "leave the tower" }],
        },
        checkpoint: {
          mode: "chronological",
          beforeCanonicalEventId: "prologue-change",
          rationale: "Before the first lived transition",
        },
        evidence: evidence(1),
      },
      events: [
        {
          id: "prologue-change",
          title: "The prologue changes the opening situation",
          readerSummary: "Opening Actor crosses the prologue threshold, making departure an immediate problem rather than a distant intention.",
          participants: ["opening-actor"],
          participantPresence: [{ entityId: "opening-actor", mode: "physical" }],
          storyTime: { kind: "ordinal", label: "prologue", orderHint: 0 },
          narrativeContext: { layerId: "main", discourseOrder: 0, mode: "scene", viewpointActorId: "opening-actor" },
          preconditions: [],
          observedOutcome: {
            version: 1,
            operations: [{ op: "set", entityId: "opening-actor", field: "character.momentum", value: 1 }],
          },
          evidence: evidence(4),
          causalParents: [],
          confidence: 1,
        },
        {
          id: "letter-is-read",
          title: "A letter bearing the signer's name is read",
          readerSummary: "Opening Actor reads a letter carrying Letter Signer's name; the document connects them without placing its signer in the room.",
          participants: ["opening-actor", "letter-signer", "letter"],
          participantPresence: [
            { entityId: "opening-actor", mode: "physical" },
            { entityId: "letter-signer", mode: "represented" },
          ],
          storyTime: { kind: "ordinal", label: "letter", orderHint: 1 },
          narrativeContext: { layerId: "main", discourseOrder: 1, mode: "scene", viewpointActorId: "opening-actor" },
          preconditions: [],
          observedOutcome: { version: 1, operations: [] },
          evidence: evidence(10),
          causalParents: ["prologue-change"],
          confidence: 1,
        },
        {
          id: "later-actor-enters",
          title: "Later Actor enters the lived scene",
          readerSummary: "Later Actor answers the summons and enters the hall.",
          participants: ["later-actor"],
          participantPresence: [{ entityId: "later-actor", mode: "physical" }],
          storyTime: { kind: "ordinal", label: "act two", orderHint: 2 },
          narrativeContext: { layerId: "main", discourseOrder: 2, mode: "scene", viewpointActorId: "later-actor" },
          characterEntryCheckpoints: [{
            actorId: "later-actor",
            readerSetup: "After the prologue crossing and the letter, Later Actor stands in the hall at the moment of deciding how to answer the summons.",
            actorObservation: "You are standing in the hall with the summons still unresolved.",
            participantPresence: [{ entityId: "later-actor", mode: "physical" }],
            delta: {
              version: 1,
              operations: [
                { op: "set", entityId: "later-actor", field: "character.location", value: "hall" },
                { op: "set", entityId: "later-actor", field: "character.plan", value: "decide how to answer the summons" },
              ],
            },
          }],
          preconditions: [],
          observedOutcome: {
            version: 1,
            operations: [{ op: "set", entityId: "later-actor", field: "character.plan", value: "answer the summons" }],
          },
          evidence: evidence(20),
          causalParents: ["letter-is-read"],
          confidence: 1,
        },
      ],
    },
  };
}

describe("character entry context", () => {
  it("gives an unread opening-role player a display-only spoiler-free setup", () => {
    const seed = deriveCharacterEntrySeed(bundle(), "opening-actor");
    const rendered = formatReaderEntryContext(seed.readerContext, "Opening Actor");
    expect(seed.readerContext.storySoFar).toEqual([]);
    expect(seed.readerContext.entrySetup).toContain("opening tower");
    expect(seed.actorObservation).toBe("The tower threshold is directly ahead.");
    expect(seed.actorObservations).toEqual([
      { actorId: "opening-actor", summary: "The tower threshold is directly ahead." },
    ]);
    expect(seed.readerContext.orientation).toMatchObject({
      entityGlosses: [{
        name: "Letter Signer",
        relationshipToFocal: "the person who summoned Opening Actor",
      }],
      immediateSituation: { summary: expect.stringContaining("decide whether") },
    });
    expect(seed.readerContext.orientation?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "causal-premise", summary: expect.stringContaining("Letter Signer") }),
      expect.objectContaining({ kind: "actor-stance", holderName: "Opening Actor", stance: "ambivalent" }),
    ]));
    expect(rendered).toContain("departure urgent");
    expect(rendered).toContain("Letter Signer：");
    expect(rendered).not.toContain("故事前情");
    expect(rendered).not.toMatch(/角色知识|committed state|claim|正史事件|编译记录/u);
  });

  it("starts a later role at its first embodied scene without treating a letter signer as present", () => {
    const prepared = bundle();
    const options = deriveCharacterEntryOptions(prepared);
    expect(options.map((option) => option.actorId)).toEqual(["opening-actor", "later-actor"]);
    expect(options.find((option) => option.actorId === "later-actor")?.entry).toMatchObject({
      canonicalEventId: "later-actor-enters",
      discourseOrder: 2,
    });

    const seed = deriveCharacterEntrySeed(prepared, "later-actor");
    expect(seed.realizesCanonicalEventIds).toEqual(["letter-is-read", "prologue-change"]);
    expect(seed.delta.operations).toContainEqual({
      op: "set",
      entityId: "opening-actor",
      field: "character.momentum",
      value: 1,
    });
    expect(seed.delta.operations).toContainEqual({
      op: "set",
      entityId: "later-actor",
      field: "character.location",
      value: "hall",
    });
    expect(seed.delta.operations).not.toContainEqual({
      op: "set",
      entityId: "later-actor",
      field: "character.plan",
      value: "answer the summons",
    });
    expect(seed.actorObservation).toContain("summons still unresolved");
    expect(seed.readerContext.storySoFar.map((beat) => beat.eventId)).toEqual(["prologue-change", "letter-is-read"]);
    const rendered = formatReaderEntryContext(seed.readerContext, "Later Actor");
    expect(rendered).toContain("## 故事前情");
    expect(rendered).toContain("Later Actor 的首次亲历场景");
    expect(rendered).toContain("document connects them without placing its signer in the room");
    expect(rendered).toContain("stands in the hall");
    expect(rendered).not.toMatch(/角色知识|committed state|claim|可核验的亲历场景|编译记录/u);
  });

  it("does not offer a later role when its prior reader recap is incomplete", () => {
    const prepared = bundle();
    delete prepared.canonical.events[0]!.readerSummary;
    expect(deriveCharacterEntryOptions(prepared).map((option) => option.actorId)).toEqual(["opening-actor"]);
  });

  it("derives source-wide entry order from evidence when batch-local discourse ordinals restart", () => {
    const prepared = bundle();
    for (const event of prepared.canonical.events) {
      event.narrativeContext = { ...event.narrativeContext!, discourseOrder: 0 };
    }

    const option = deriveCharacterEntryOptions(prepared)
      .find((candidate) => candidate.actorId === "later-actor");
    const seed = deriveCharacterEntrySeed(prepared, "later-actor");

    expect(option?.entry.discourseOrder).toBe(2);
    expect(seed.readerContext.storySoFar.map((beat) => beat.eventId))
      .toEqual(["prologue-change", "letter-is-read"]);
  });
});

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
        participantPresence: [{ entityId: "opening-actor", mode: "physical" }],
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
    expect(seed.readerContext.storySoFar).toEqual([]);
    expect(seed.readerContext.entrySetup).toContain("opening tower");
    expect(formatReaderEntryContext(seed.readerContext, "Opening Actor")).toContain("departure urgent");
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
    expect(formatReaderEntryContext(seed.readerContext, "Later Actor")).toContain("不等于角色知识");
    expect(formatReaderEntryContext(seed.readerContext, "Later Actor")).toContain("首次可核验的亲历场景");
    expect(formatReaderEntryContext(seed.readerContext, "Later Actor")).toContain("document connects them without placing its signer in the room");
    expect(formatReaderEntryContext(seed.readerContext, "Later Actor")).toContain("stands in the hall");
  });

  it("does not offer a later role when its prior reader recap is incomplete", () => {
    const prepared = bundle();
    delete prepared.canonical.events[0]!.readerSummary;
    expect(deriveCharacterEntryOptions(prepared).map((option) => option.actorId)).toEqual(["opening-actor"]);
  });
});

import { describe, expect, it } from "vitest";
import { characterModelSchema, resolveCharacterModel, type CharacterModel } from "../src/world/actors.js";
import {
  CHARACTER_DIMENSION_IDS,
  modelVisibleCharacterOntology,
  validateCharacterOntologyReferences,
} from "../src/world/character-ontology.js";
import type { EvidenceRef } from "../src/world/model.js";

function evidence(line: number, strength: EvidenceRef["strength"] = "explicit"): EvidenceRef {
  return {
    span: { sourceId: "novel", startLine: line, endLine: line, quoteHash: `quote-${line}` },
    strength,
  };
}

function model(): CharacterModel {
  return {
    actorId: "hero",
    ontologyVersion: "character-v1",
    traits: {},
    decisionBiases: {},
    dispositions: [{
      id: "hero-deliberates",
      actorId: "hero",
      dimensionId: "deliberation",
      value: 0.7,
      scope: { kind: "global" },
      stability: "stable",
      basis: "explicit-characterization",
      status: "supported",
      confidence: 0.9,
      evidence: [evidence(1)],
    }, {
      id: "hero-trusts-rival-after-rescue",
      actorId: "hero",
      dimensionId: "trust-readiness",
      value: 0.6,
      scope: { kind: "context-target", contextId: "physical-danger", targetEntityId: "rival" },
      stability: "situational",
      basis: "inferred-pattern",
      validStoryTime: { kind: "relative", anchorEventId: "rescue", relation: "after" },
      status: "supported",
      confidence: 0.75,
      evidence: [evidence(2, "strong-inference")],
    }, {
      id: "hero-contested-risk",
      actorId: "hero",
      dimensionId: "risk-tolerance",
      value: 0.9,
      scope: { kind: "global" },
      stability: "situational",
      basis: "inferred-pattern",
      status: "contested",
      confidence: 0.5,
      evidence: [evidence(3, "strong-inference")],
      counterEvidence: [evidence(4)],
    }],
    appraisalEpisodes: [{
      id: "hero-fears-rescue",
      actorId: "hero",
      eventId: "rescue",
      interpretationPropositionId: "rescue-is-dangerous",
      basis: "experienced",
      emotion: { label: "fear", intensity: 0.8 },
      affectedGoalIds: ["protect-rival"],
      resultingIntention: "Keep the rival within reach.",
      status: "supported",
      confidence: 0.9,
      evidence: [evidence(5)],
    }, {
      id: "hero-future-relief",
      actorId: "hero",
      eventId: "future-return",
      interpretationPropositionId: "return-is-safe",
      basis: "experienced",
      emotion: { label: "relief", intensity: 0.7 },
      affectedGoalIds: [],
      status: "supported",
      confidence: 0.8,
      evidence: [evidence(6)],
    }],
    developmentEpisodes: [{
      id: "rescue-builds-trust",
      actorId: "hero",
      triggerMode: "experienced",
      triggerEventIds: ["rescue"],
      beforeDispositionIds: ["hero-deliberates"],
      afterDispositionIds: ["hero-trusts-rival-after-rescue"],
      mechanism: "The rival's costly rescue supplies direct evidence of reliability.",
      startsAt: { kind: "relative", anchorEventId: "rescue", relation: "after" },
      decay: { kind: "event-dependent", reversalEventIds: ["future-return"] },
      evidenceStatus: "supported",
      confidence: 0.85,
      evidence: [evidence(7, "strong-inference")],
    }],
    evidence: [evidence(1)],
  };
}

describe("character ontology", () => {
  it("uses a bounded dimension registry and rejects unregistered V2 trait keys", () => {
    expect(CHARACTER_DIMENSION_IDS).toEqual([
      "risk-tolerance",
      "deliberation",
      "affiliation",
      "dominance",
      "norm-adherence",
      "trust-readiness",
      "persistence",
      "openness-to-revision",
    ]);
    expect(characterModelSchema.safeParse({
      ...model(),
      traits: { brave: 0.8 },
    }).success).toBe(false);
    expect(characterModelSchema.safeParse({
      ...model(),
      traits: { "legacy:brave": 0.8 },
    }).success).toBe(true);
    expect(characterModelSchema.safeParse({
      actorId: "hero",
      ontologyVersion: "character-v1",
      traits: {},
      decisionBiases: {},
      evidence: [evidence(1)],
    }).success).toBe(false);
    expect(characterModelSchema.safeParse({
      ...model(),
      dispositions: [{
        ...model().dispositions![0]!,
        basis: "repeated-behavior",
        evidence: [evidence(1, "strong-inference")],
      }],
      appraisalEpisodes: [],
      developmentEpisodes: [],
    }).success).toBe(false);
    expect(characterModelSchema.safeParse({
      ...model(),
      dispositions: [{
        ...model().dispositions![0]!,
        validStoryTime: { kind: "relative", anchorEventId: "rescue", relation: "during" },
      }],
      appraisalEpisodes: [],
      developmentEpisodes: [],
    }).success).toBe(false);
  });

  it("validates actor, target, event, proposition, goal, and disposition reference closure", () => {
    const valid = model();
    const catalog = {
      entities: new Map([["hero", { kind: "character" }], ["rival", { kind: "character" }]]),
      propositions: new Set(["rescue-is-dangerous", "return-is-safe"]),
      events: new Map([
        ["rescue", { participants: ["hero", "rival"] }],
        ["future-return", { participants: ["hero"] }],
      ]),
      goals: new Map([["protect-rival", { actorId: "hero" }]]),
    };
    expect(validateCharacterOntologyReferences(valid, catalog)).toEqual([]);

    const invalid = structuredClone(valid);
    invalid.dispositions![1]!.scope = { kind: "target", targetEntityId: "missing" };
    invalid.appraisalEpisodes![0]!.interpretationPropositionId = "missing-proposition";
    invalid.developmentEpisodes![0]!.afterDispositionIds = ["missing-disposition"];
    expect(validateCharacterOntologyReferences(invalid, catalog)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNKNOWN_DISPOSITION_TARGET" }),
      expect.objectContaining({ code: "UNKNOWN_APPRAISAL_PROPOSITION" }),
      expect.objectContaining({ code: "UNKNOWN_DEVELOPMENT_DISPOSITION" }),
    ]));

    const mentionedOnly = {
      ...catalog,
      events: new Map([
        ["rescue", {
          participants: ["hero", "rival"],
          participantPresence: [{ entityId: "hero", mode: "mentioned" as const }],
        }],
        ["future-return", { participants: ["hero"] }],
      ]),
    };
    expect(validateCharacterOntologyReferences(valid, mentionedOnly)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNAVAILABLE_APPRAISAL_EVENT" }),
      expect.objectContaining({ code: "UNEXPERIENCED_DEVELOPMENT_EVENT" }),
    ]));
  });

  it("projects only committed, experienced, non-contested semantics and strips evidence and stable IDs", () => {
    const effective = resolveCharacterModel(model(), {
      state: { atCommit: "head", logicalTime: { step: 1 }, values: {}, activeRuleIds: [] },
      knownClaimIds: new Set(),
      realizedCanonicalEventIds: new Set(["rescue"]),
      experiencedCanonicalEventIds: new Set(["rescue"]),
    });
    expect(effective.dispositions.map((item) => item.id)).toEqual([
      "hero-trusts-rival-after-rescue",
    ]);
    expect(effective.appraisals.map((item) => item.id)).toEqual(["hero-fears-rescue"]);
    expect(effective.developmentEpisodes.map((item) => item.id)).toEqual(["rescue-builds-trust"]);
    const realizedButNotExperienced = resolveCharacterModel({
      ...model(),
      appraisalEpisodes: [{
        ...model().appraisalEpisodes![0]!,
        basis: "reported",
      }],
      developmentEpisodes: [],
    }, {
      state: { atCommit: "head", logicalTime: { step: 1 }, values: {}, activeRuleIds: [] },
      knownClaimIds: new Set(),
      realizedCanonicalEventIds: new Set(["rescue"]),
      experiencedCanonicalEventIds: new Set(),
    });
    expect(realizedButNotExperienced.appraisals).toEqual([]);

    const visible = modelVisibleCharacterOntology(effective, (entityId) =>
      entityId === "rival" ? "person-002" : undefined);
    expect(visible.dispositions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dimension: "trust-readiness",
        scope: { kind: "context-target", contextId: "physical-danger", target: "person-002" },
      }),
    ]));
    expect(visible.development).toEqual([{
      dimensions: ["trust-readiness"],
      status: "active",
      confidence: 0.85,
    }]);
    const serialized = JSON.stringify(visible);
    expect(serialized).not.toContain("hero-trusts-rival-after-rescue");
    expect(serialized).not.toContain("future-return");
    expect(serialized).not.toContain("quoteHash");
    expect(serialized).not.toContain('"rival"');
    expect(serialized).not.toContain("hero-contested-risk");
    expect(serialized).not.toContain("costly rescue");
    expect(serialized).not.toContain("Keep the rival within reach");
  });

  it("gates after-dispositions on committed development triggers and restores prior policy after reversal", () => {
    const before = resolveCharacterModel(model(), {
      state: { atCommit: "head", logicalTime: { step: 0 }, values: {}, activeRuleIds: [] },
      knownClaimIds: new Set(),
      realizedCanonicalEventIds: new Set(),
      experiencedCanonicalEventIds: new Set(),
    });
    expect(before.dispositions.map((item) => item.id)).toEqual(["hero-deliberates"]);

    const reversed = resolveCharacterModel(model(), {
      state: { atCommit: "head", logicalTime: { step: 2 }, values: {}, activeRuleIds: [] },
      knownClaimIds: new Set(),
      realizedCanonicalEventIds: new Set(["rescue", "future-return"]),
      experiencedCanonicalEventIds: new Set(["rescue"]),
    });
    expect(reversed.dispositions.map((item) => item.id)).toEqual(["hero-deliberates"]);
    expect(reversed.developmentEpisodes).toEqual([]);
  });
});

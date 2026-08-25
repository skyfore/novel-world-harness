import { describe, expect, it } from "vitest";
import { characterModelSchema, resolveCharacterModel, type CharacterModel } from "../src/world/actors.js";
import type { EvidenceAssertion, EvidenceRef, WorldState } from "../src/world/model.js";
import {
  RELATIONSHIP_OBLIGATION_TYPE_IDS,
  RELATIONSHIP_STANCE_DIMENSION_IDS,
  RELATIONSHIP_TYPE_IDS,
  modelVisibleRelationshipOntology,
  validateRelationshipOntologyEvidenceAssertions,
  validateRelationshipOntologyReferences,
} from "../src/world/relationship-ontology.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../src/world/state.js";

function evidence(index: number, strength: EvidenceRef["strength"] = "explicit"): EvidenceRef {
  return {
    span: {
      sourceId: "novel",
      startByte: index * 10,
      endByte: index * 10 + 5,
      startLine: index,
      endLine: index,
      quoteHash: String(index).padStart(64, "a").slice(-64),
    },
    strength,
  };
}

function relationshipModel(): CharacterModel {
  return characterModelSchema.parse({
    actorId: "hero",
    traits: {},
    decisionBiases: {},
    relationshipOntologyVersion: "relationship-v1",
    relationshipStances: [{
      id: "hero-distrusts-rival",
      actorId: "hero",
      relationshipEntityId: "hero-to-rival",
      targetEntityId: "rival",
      dimensionId: "trust",
      value: -0.7,
      stability: "stable",
      basis: "explicit-characterization",
      status: "supported",
      confidence: 0.9,
      evidence: [evidence(1)],
    }, {
      id: "hero-trusts-rival-after-rescue",
      actorId: "hero",
      relationshipEntityId: "hero-to-rival",
      targetEntityId: "rival",
      dimensionId: "trust",
      value: 0.8,
      stability: "situational",
      basis: "inferred-pattern",
      validStoryTime: { kind: "relative", anchorEventId: "rescue", relation: "after" },
      status: "supported",
      confidence: 0.8,
      evidence: [evidence(2, "strong-inference")],
    }],
    relationshipObligations: [{
      id: "hero-protects-rival",
      actorId: "hero",
      relationshipEntityId: "hero-to-rival",
      targetEntityId: "rival",
      typeId: "protect",
      contentPropositionId: "hero-owes-protection",
      priority: 0.7,
      basis: "social-role",
      status: "supported",
      confidence: 0.75,
      evidence: [evidence(3, "strong-inference")],
    }, {
      id: "hero-cooperates-after-rescue",
      actorId: "hero",
      relationshipEntityId: "hero-to-rival",
      targetEntityId: "rival",
      typeId: "cooperate",
      contentPropositionId: "hero-will-cooperate",
      priority: 0.9,
      basis: "inferred-expectation",
      activation: {
        afterExperiencedEventIds: ["rescue"],
        requiresKnowledge: ["rescue-was-costly"],
      },
      resolution: { afterExperiencedEventIds: ["betrayal"] },
      status: "supported",
      confidence: 0.85,
      evidence: [evidence(4, "strong-inference")],
    }],
    relationshipChanges: [{
      id: "rescue-revises-relationship",
      actorId: "hero",
      relationshipEntityId: "hero-to-rival",
      targetEntityId: "rival",
      triggerMode: "experienced",
      triggerEventIds: ["rescue"],
      beforeStanceIds: ["hero-distrusts-rival"],
      afterStanceIds: ["hero-trusts-rival-after-rescue"],
      beforeObligationIds: ["hero-protects-rival"],
      afterObligationIds: ["hero-cooperates-after-rescue"],
      mechanismPropositionId: "rescue-demonstrates-reliability",
      startsAt: { kind: "relative", anchorEventId: "rescue", relation: "after" },
      decay: { kind: "event-dependent", reversalEventIds: ["betrayal"] },
      evidenceStatus: "supported",
      confidence: 0.9,
      evidence: [evidence(5, "strong-inference")],
    }],
    evidence: [evidence(1)],
  });
}

function state(overrides: Partial<Record<string, unknown>> = {}): WorldState {
  return {
    atCommit: "head",
    logicalTime: { step: 1 },
    values: {
      hero: { "character.relationships": ["hero-to-rival"] },
      "hero-to-rival": {
        "relationship.from": "hero",
        "relationship.to": "rival",
        "relationship.type": "friendship",
        "relationship.active": true,
        ...overrides,
      },
    },
    activeRuleIds: [],
  };
}

const catalog = {
  entities: new Map([
    ["hero", { kind: "character" }],
    ["rival", { kind: "character" }],
    ["hero-to-rival", { kind: "relationship" }],
  ]),
  propositions: new Set([
    "hero-owes-protection",
    "hero-will-cooperate",
    "rescue-demonstrates-reliability",
  ]),
  claims: new Set(["rescue-was-costly"]),
  events: new Map([
    ["rescue", {
      participants: ["hero", "rival"],
      participantPresence: [{ entityId: "hero", mode: "physical" as const }],
    }],
    ["betrayal", {
      participants: ["hero", "rival"],
      participantPresence: [{ entityId: "hero", mode: "physical" as const }],
    }],
  ]),
};

describe("directed relationship ontology", () => {
  it("uses controlled relationship, stance, obligation, and world-state vocabularies", () => {
    expect(RELATIONSHIP_TYPE_IDS).toContain("friendship");
    expect(RELATIONSHIP_STANCE_DIMENSION_IDS).toEqual([
      "trust", "affinity", "respect", "perceived-threat", "dependence", "influence",
    ]);
    expect(RELATIONSHIP_OBLIGATION_TYPE_IDS).toContain("repay");
    expect(characterModelSchema.safeParse({
      ...relationshipModel(),
      relationshipOntologyVersion: undefined,
    }).success).toBe(false);
    expect(characterModelSchema.safeParse({
      ...relationshipModel(),
      relationshipStances: [{
        ...relationshipModel().relationshipStances![0]!,
        dimensionId: "chemistry",
      }],
    }).success).toBe(false);

    const registry = new StateSchemaRegistry(DEFAULT_STATE_FIELDS);
    const typeField = registry.get("relationship.type");
    expect(() => registry.validateValue(typeField, "friendship", new Map())).not.toThrow();
    expect(() => registry.validateValue(typeField, "complicated", new Map())).toThrow(/must be one of/);
  });

  it("validates entity, event, proposition, claim, and same-pair closure", () => {
    expect(validateRelationshipOntologyReferences(relationshipModel(), catalog)).toEqual([]);

    const invalid = structuredClone(relationshipModel());
    invalid.relationshipObligations![0]!.contentPropositionId = "missing-proposition";
    invalid.relationshipObligations![1]!.activation!.requiresKnowledge = ["missing-claim"];
    invalid.relationshipChanges![0]!.afterStanceIds = ["missing-stance"];
    expect(validateRelationshipOntologyReferences(invalid, catalog)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNKNOWN_OBLIGATION_PROPOSITION" }),
      expect.objectContaining({ code: "UNKNOWN_RELATIONSHIP_KNOWLEDGE" }),
      expect.objectContaining({ code: "UNKNOWN_RELATIONSHIP_CHANGE_ITEM" }),
    ]));

    const wrongPair = structuredClone(relationshipModel());
    wrongPair.relationshipStances![1]!.targetEntityId = "hero";
    expect(validateRelationshipOntologyReferences(wrongPair, catalog)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SELF_RELATIONSHIP_TARGET" }),
      expect.objectContaining({ code: "RELATIONSHIP_CHANGE_PAIR_MISMATCH" }),
    ]));
  });

  it("derives policy only from committed directed state and lived/known triggers", () => {
    const before = resolveCharacterModel(relationshipModel(), {
      state: state(),
      knownClaimIds: new Set(),
      realizedCanonicalEventIds: new Set(),
      experiencedCanonicalEventIds: new Set(),
    });
    expect(before.relationshipStances.map((item) => item.id)).toEqual(["hero-distrusts-rival"]);
    expect(before.relationshipObligations.map((item) => item.id)).toEqual(["hero-protects-rival"]);
    expect(before.relationshipChanges).toEqual([]);

    const realizedOnly = resolveCharacterModel(relationshipModel(), {
      state: state(),
      knownClaimIds: new Set(["rescue-was-costly"]),
      realizedCanonicalEventIds: new Set(["rescue"]),
      experiencedCanonicalEventIds: new Set(),
    });
    expect(realizedOnly.relationshipStances.map((item) => item.id)).toEqual(["hero-distrusts-rival"]);

    const after = resolveCharacterModel(relationshipModel(), {
      state: state(),
      knownClaimIds: new Set(["rescue-was-costly"]),
      realizedCanonicalEventIds: new Set(["rescue"]),
      experiencedCanonicalEventIds: new Set(["rescue"]),
    });
    expect(after.relationshipStances.map((item) => item.id)).toEqual(["hero-trusts-rival-after-rescue"]);
    expect(after.relationshipObligations.map((item) => item.id)).toEqual(["hero-cooperates-after-rescue"]);
    expect(after.relationshipChanges.map((item) => item.id)).toEqual(["rescue-revises-relationship"]);

    for (const invalidState of [
      state({ "relationship.active": false }),
      state({ "relationship.from": "rival", "relationship.to": "hero" }),
      state({ "relationship.type": "complicated" }),
    ]) {
      const effective = resolveCharacterModel(relationshipModel(), {
        state: invalidState,
        knownClaimIds: new Set(["rescue-was-costly"]),
        realizedCanonicalEventIds: new Set(["rescue"]),
        experiencedCanonicalEventIds: new Set(["rescue"]),
      });
      expect(effective.relationshipStances).toEqual([]);
      expect(effective.relationshipObligations).toEqual([]);
      expect(effective.relationshipChanges).toEqual([]);
    }
  });

  it("restores displaced policy after reversal and strips hidden compiler semantics", () => {
    const effective = resolveCharacterModel(relationshipModel(), {
      state: state(),
      knownClaimIds: new Set(["rescue-was-costly"]),
      realizedCanonicalEventIds: new Set(["rescue", "betrayal"]),
      experiencedCanonicalEventIds: new Set(["rescue", "betrayal"]),
    });
    expect(effective.relationshipStances.map((item) => item.id)).toEqual(["hero-distrusts-rival"]);
    expect(effective.relationshipObligations.map((item) => item.id)).toEqual(["hero-protects-rival"]);

    const visible = modelVisibleRelationshipOntology(effective, (entityId) =>
      entityId === "rival" ? "person-002" : undefined);
    expect(visible).toEqual([expect.objectContaining({
      target: "person-002",
      type: "friendship",
      stances: [expect.objectContaining({ dimension: "trust", value: -0.7 })],
    })]);
    const serialized = JSON.stringify(visible);
    expect(serialized).not.toContain("hero-to-rival");
    expect(serialized).not.toContain("hero-distrusts-rival");
    expect(serialized).not.toContain("quoteHash");
    expect(serialized).not.toContain("rescue-demonstrates-reliability");
    expect(serialized).not.toContain('"rival"');
  });

  it("requires exact assertions to match every embedded relationship evidence ref", () => {
    const reference = evidence(9);
    const model = characterModelSchema.parse({
      actorId: "hero",
      traits: {},
      decisionBiases: {},
      relationshipOntologyVersion: "relationship-v1",
      relationshipStances: [{
        id: "hero-trusts-rival",
        actorId: "hero",
        relationshipEntityId: "hero-to-rival",
        targetEntityId: "rival",
        dimensionId: "trust",
        value: 0.5,
        stability: "situational",
        basis: "explicit-characterization",
        status: "supported",
        confidence: 0.8,
        evidence: [reference],
      }],
      evidence: [reference],
    });
    const assertion: EvidenceAssertion = {
      version: 1,
      id: "relationship-support",
      target: {
        artifactKind: "character-model",
        artifactId: "hero",
        jsonPointer: "/relationshipStances/0/value",
      },
      anchors: [{
        sourceId: "novel",
        startByte: reference.span.startByte!,
        endByte: reference.span.endByte!,
        startLine: 9,
        endLine: 9,
        exactHash: reference.span.quoteHash,
        prefixHash: "b".repeat(64),
        suffixHash: "c".repeat(64),
        contextBytes: 64,
        normalization: "source-bytes-v1",
      }],
      relation: "supports",
      strength: "explicit",
      derivation: { runId: "test", worker: "test", ontologyVersion: "evidence-v1" },
    };
    expect(validateRelationshipOntologyEvidenceAssertions(model, [assertion])).toEqual([]);
    expect(validateRelationshipOntologyEvidenceAssertions(model, [])).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MISSING_EXACT_RELATIONSHIP_SUPPORT" }),
      expect.objectContaining({ code: "RELATIONSHIP_SUPPORT_BINDING_MISMATCH" }),
    ]));
  });
});

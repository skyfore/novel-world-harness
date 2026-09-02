import { describe, expect, it } from "vitest";
import {
  controlledWorldRuleSchema,
  type ControlledWorldRule,
  type Entity,
  type EvidenceAssertion,
  type EvidenceRef,
  type Predicate,
  type WorldRule,
  type WorldState,
} from "../src/world/model.js";
import {
  modelVisibleWorldRules,
  resolveEffectiveWorldRules,
  validateWorldRuleCatalog,
  validateWorldRuleEvidenceAssertions,
} from "../src/world/world-rule-ontology.js";

describe("controlled world-rule ontology", () => {
  it("requires exact support for the rule and every executable/exception item", () => {
    const top = evidence(0, "a");
    const clause = evidence(10, "b");
    const exception = evidence(20, "c");
    const value = rule("garden-ban", {
      evidence: [top],
      clauses: [{
        id: "garden-ban-clause",
        modality: "forbid",
        predicate: locationIs("garden"),
        basis: "explicit",
        status: "supported",
        confidence: 1,
        evidence: [clause],
      }],
      exceptions: [{
        id: "garden-ban-permit",
        appliesWhen: [{ op: "fact-equals", entityId: "hero", field: "character.plan", value: "permit" }],
        basis: "explicit",
        status: "supported",
        confidence: 1,
        evidence: [exception],
      }],
    });
    const assertions = [
      assertion("top-support", "/name", "supports", top),
      assertion("clause-support", "/clauses/0/predicate", "supports", clause),
      assertion("exception-support", "/exceptions/0/appliesWhen/0", "supports", exception),
    ];

    expect(validateWorldRuleEvidenceAssertions(value, assertions)).toEqual([]);
    expect(validateWorldRuleEvidenceAssertions(value, assertions.filter((item) => item.id !== "clause-support")))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MISSING_EXACT_WORLD_RULE_SUPPORT", path: "clauses.0" }),
        expect.objectContaining({ code: "WORLD_RULE_SUPPORT_BINDING_MISMATCH", path: "clauses.0.evidence" }),
      ]));
  });

  it("validates jurisdiction binding and explicit, strictly stronger overrides", () => {
    const lower = rule("garden-ban", { priority: 10, defeasible: true });
    const upper = rule("royal-permit", {
      priority: 20,
      overridesRuleIds: [lower.id],
      clauses: [supportedClause("royal-permit-clause", "require", {
        op: "fact-equals",
        entityId: "hero",
        field: "character.alive",
        value: true,
      })],
    });
    const scoped = rule("garden-custom", {
      scope: "location",
      jurisdictionEntityIds: ["garden"],
      appliesWhen: [locationIs("garden")],
      clauses: [supportedClause("garden-custom-clause", "require", {
        op: "fact-equals",
        entityId: "hero",
        field: "character.alive",
        value: true,
      })],
    });
    const catalog = referenceCatalog([lower, upper, scoped]);

    expect(validateWorldRuleCatalog(catalog.rules.values(), catalog)).toEqual([]);

    const invalidUpper = rule("weak-permit", {
      priority: 10,
      overridesRuleIds: [lower.id],
    });
    const invalidCatalog = referenceCatalog([lower, invalidUpper]);
    expect(validateWorldRuleCatalog(invalidCatalog.rules.values(), invalidCatalog))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "INVALID_RULE_PRIORITY" })]));

    const unbound = rule("unbound-custom", {
      scope: "location",
      jurisdictionEntityIds: ["garden"],
      appliesWhen: [{ op: "fact-equals", entityId: "hero", field: "character.alive", value: true }],
    });
    const unboundCatalog = referenceCatalog([unbound]);
    expect(validateWorldRuleCatalog(unboundCatalog.rules.values(), unboundCatalog))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNBOUND_RULE_JURISDICTION" })]));
  });

  it("applies supported exceptions before explicit override resolution", () => {
    const lower = rule("garden-ban", { priority: 10, defeasible: true });
    const upper = rule("royal-permit", {
      priority: 20,
      overridesRuleIds: [lower.id],
      clauses: [supportedClause("royal-permit-clause", "require", {
        op: "fact-equals",
        entityId: "hero",
        field: "character.alive",
        value: true,
      })],
      exceptions: [{
        id: "permit-revoked",
        appliesWhen: [{ op: "fact-equals", entityId: "hero", field: "character.plan", value: "revoked" }],
        basis: "inferred",
        status: "supported",
        confidence: 0.9,
        evidence: [evidence(60, "e", "strong-inference")],
      }],
    });
    const rules = new Map<string, WorldRule>([[lower.id, lower], [upper.id, upper]]);

    const ordinary = resolveEffectiveWorldRules(rules, state({ "character.alive": true, "character.plan": "valid" }, [lower.id, upper.id]));
    expect(ordinary.effective.map((item) => item.id)).toEqual([upper.id]);
    expect(ordinary.inactive).toContainEqual({ ruleId: lower.id, reason: "overridden", overridingRuleId: upper.id });

    const revoked = resolveEffectiveWorldRules(rules, state({ "character.alive": true, "character.plan": "revoked" }, [lower.id, upper.id]));
    expect(revoked.effective.map((item) => item.id)).toEqual([lower.id]);
    expect(revoked.inactive).toContainEqual({ ruleId: upper.id, reason: "exception", exceptionId: "permit-revoked" });
  });

  it("does not infer an override from priority alone and never executes contested clauses", () => {
    const lower = rule("lower", { priority: 1 });
    const higher = rule("higher", {
      priority: 999,
      clauses: [
        supportedClause("higher-supported", "require", { op: "fact-exists", entityId: "hero", field: "character.alive" }),
        {
          ...supportedClause("higher-contested", "forbid", locationIs("garden")),
          status: "contested",
          counterEvidence: [evidence(70, "f", "strong-inference")],
        },
      ],
    });
    const resolved = resolveEffectiveWorldRules(
      new Map<string, WorldRule>([[lower.id, lower], [higher.id, higher]]),
      state({ "character.alive": true }, [lower.id, higher.id]),
    );

    expect(resolved.effective.map((item) => item.id)).toEqual([higher.id, lower.id]);
    expect(resolved.effective.find((item) => item.id === higher.id)?.forbids).toEqual([]);
  });

  it("keeps engine, unknown knowledge, remote observable, and hidden-entity rules out of actor prompts", () => {
    const publicRule = rule("public-rule");
    const engineRule = rule("engine-rule", { visibility: "engine" });
    const knowledgeRule = rule("knowledge-rule", { visibility: "knowledge", knownByClaimIds: ["claim-law"] });
    const observableRule = rule("observable-rule", {
      scope: "location",
      jurisdictionEntityIds: ["garden"],
      appliesWhen: [locationIs("garden")],
      visibility: "observable",
    });
    const hiddenEntityRule = rule("hidden-entity-rule", {
      clauses: [supportedClause("hidden-entity-clause", "require", {
        op: "fact-equals",
        entityId: "secret-person",
        field: "character.alive",
        value: true,
      })],
    });
    const values = [publicRule, engineRule, knowledgeRule, observableRule, hiddenEntityRule];
    const resolved = resolveEffectiveWorldRules(
      new Map<string, WorldRule>(values.map((item) => [item.id, item])),
      {
        ...state({ "character.location": "garden" }, values.map((item) => item.id)),
        values: {
          hero: { "character.location": "garden" },
          "secret-person": { "character.alive": true },
        },
      },
    );
    const entities = new Map([
      ["hero", { kind: "character" as const }],
      ["garden", { kind: "location" as const }],
      ["secret-person", { kind: "character" as const }],
    ]);
    const baseInput = {
      knownClaimIds: new Set<string>(),
      visibleEntityIds: new Set(["hero", "garden"]),
      observableEntityIds: new Set(["hero", "garden"]),
      entities,
    };

    expect(modelVisibleWorldRules(resolved.effective, baseInput).map((item) => item.name).sort())
      .toEqual(["observable-rule", "public-rule"]);
    expect(modelVisibleWorldRules(resolved.effective, {
      ...baseInput,
      knownClaimIds: new Set(["claim-law"]),
      observableEntityIds: new Set(["hero"]),
    }).map((item) => item.name).sort())
      .toEqual(["knowledge-rule", "public-rule"]);
  });
});

function rule(
  id: string,
  overrides: Partial<ControlledWorldRule> = {},
): ControlledWorldRule {
  const topEvidence = evidence(id.length * 100, "d");
  return controlledWorldRuleSchema.parse({
    ontologyVersion: "world-rule-v2",
    id,
    name: id,
    kind: "social",
    scope: "global",
    jurisdictionEntityIds: [],
    appliesWhen: [],
    visibility: "public",
    knownByClaimIds: [],
    priority: 0,
    defeasible: false,
    overridesRuleIds: [],
    clauses: [supportedClause(`${id}-clause`, "forbid", locationIs("garden"))],
    exceptions: [],
    basis: "explicit",
    status: "supported",
    confidence: 1,
    evidence: [topEvidence],
    ...overrides,
  });
}

function supportedClause(id: string, modality: "require" | "forbid", predicate: Predicate) {
  return {
    id,
    modality,
    predicate,
    basis: "explicit" as const,
    status: "supported" as const,
    confidence: 1,
    evidence: [evidence(id.length * 10, "a")],
  };
}

function referenceCatalog(rules: readonly WorldRule[]) {
  const entities: Entity[] = [
    { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] },
    { id: "garden", kind: "location", canonicalName: "Garden", aliases: [], evidence: [] },
  ];
  return {
    entities: new Map(entities.map((entity) => [entity.id, { kind: entity.kind }])),
    events: new Map<string, unknown>(),
    claims: new Set<string>(),
    rules: new Map(rules.map((item) => [item.id, item])),
  };
}

function locationIs(locationId: string): Predicate {
  return { op: "fact-equals", entityId: "hero", field: "character.location", value: locationId };
}

function state(values: Record<string, boolean | string>, activeRuleIds: string[]): WorldState {
  return {
    atCommit: "head",
    logicalTime: { step: 0, storyTime: { kind: "ordinal", label: "opening", orderHint: 0 } },
    values: { hero: values },
    activeRuleIds,
  };
}

function evidence(startByte: number, hashCharacter: string, strength: EvidenceRef["strength"] = "explicit"): EvidenceRef {
  return {
    span: {
      sourceId: "novel",
      startByte,
      endByte: startByte + 5,
      startLine: startByte + 1,
      endLine: startByte + 1,
      quoteHash: hashCharacter.repeat(64),
    },
    strength,
  };
}

function assertion(
  id: string,
  jsonPointer: string,
  relation: EvidenceAssertion["relation"],
  reference: EvidenceRef,
): EvidenceAssertion {
  return {
    version: 1,
    id,
    target: { artifactKind: "world-rule", artifactId: "garden-ban", jsonPointer },
    anchors: [{
      version: 1,
      sourceId: reference.span.sourceId,
      startByte: reference.span.startByte!,
      endByte: reference.span.endByte!,
      startLine: reference.span.startLine,
      endLine: reference.span.endLine,
      exactHash: reference.span.quoteHash,
      prefixHash: "0".repeat(64),
      suffixHash: "1".repeat(64),
      contextBytes: 64,
      normalization: "source-bytes-v1",
    }],
    relation,
    strength: reference.strength,
    ...(reference.strength === "explicit" ? {} : { interpretation: "The passage supports this rule semantic." }),
    derivation: { runId: "run", worker: "test", ontologyVersion: "evidence-v1" },
  };
}

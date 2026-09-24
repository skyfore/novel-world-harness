import { describe, expect, it } from "vitest";
import { actorDecisionViewSchema } from "../src/world/actor-decision-view.js";
import { createActorContextAccess } from "../src/agent/actor-context-retrieval.js";
import { DecisionContextBudgetError } from "../src/agent/decision-context.js";
import { promptJson } from "../src/util/prompt-data.js";

function fixture() {
  return {
    actorId: "actor-self", selfState: { "character.plan": "inspect" },
    scene: { locationId: "entity-hall", presentEntityIds: ["actor-self"] },
    presentEntities: [{ id: "actor-self", kind: "character", name: "A" }],
    referenceableEntities: [{ id: "entity-gate", kind: "location", name: "Gate" }],
    ownedEntityState: { "entity-gate": { "location.open": false } },
    spatialRelations: [], writableEntityIds: ["actor-self"], writableStateFields: [],
    decision: actorDecisionViewSchema.parse({
      goals: [], appraisals: [], relationships: [], obligations: [], norms: [], processes: [],
      constraints: { actions: [], worldRules: [{
        id: "semantic-rule", name: "Gate access", kind: "physical", scope: "global",
        appliesWhen: [], clauses: [{ id: "clause", modality: "require", predicate: { op: "fact-equals", entityId: "entity-gate", field: "location.open", value: true } }],
        exceptions: [], priority: 0, defeasible: false, overridesRuleIds: [], status: "supported", hostChecksRequired: true,
      }] },
    }),
    knowledge: [
      ...Array.from({ length: 50 }, (_, index) => ({ claimId: `claim-${index}`, claim: { predicate: "misc", object: "distractor ".repeat(50) } })),
      { claimId: "claim-gate", claim: { subject: "entity-gate", predicate: "state:location.open", object: false } },
    ],
    archive: [{ text: "distractor ".repeat(4_000) }],
  };
}

describe("decision dependency package", () => {
  it("retains complete disclosed contracts, identities, state and referenced knowledge before optional ranking", () => {
    const context = fixture();
    const access = createActorContextAccess(context, { maxModelChars: 8_000, query: "distractor", sectionPriority: { archive: 0, knowledge: 1, decision: 1000 } });
    expect(access.modelContext.decision).toEqual(context.decision);
    expect(access.modelContext.ownedEntityState).toEqual(context.ownedEntityState);
    expect(access.modelContext.referenceableEntities).toEqual(context.referenceableEntities);
    expect(access.modelContext.knowledge).toContainEqual(context.knowledge.at(-1));
    expect(access.coverage.bounded).toBe(true);
    expect(access.decisionManifest).toMatchObject({ status: "retained", hostChecksRequired: true, maxModelChars: 8_000 });
    expect(access.decisionManifest?.requiredRecordRefs).toContain("knowledge:50");
    expect(promptJson(access.modelContext).length).toBeLessThanOrEqual(8_000);
    expect(promptJson(access.modelContext)).not.toContain("snapshotHash");
  });

  it("stops before inference when the whole visible dependency package cannot fit", () => {
    const context = fixture();
    context.decision.goals = [{ id: "semantic-goal", description: "large ".repeat(2_000), priority: 1, targetIds: [] }];
    try {
      createActorContextAccess(context, { maxModelChars: 8_000 });
      expect.fail("must not silently omit a goal or constraint");
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionContextBudgetError);
      expect((error as DecisionContextBudgetError).manifest).toMatchObject({ status: "blocked", hostChecksRequired: true });
      expect((error as Error).message).toContain("Do not drop contracts");
    }
  });

  it("binds manifests to the visible snapshot without modifying or expanding actor scope", () => {
    const context = fixture();
    const before = structuredClone(context);
    const first = createActorContextAccess(context, { maxModelChars: 8_000 });
    const second = createActorContextAccess(context, { maxModelChars: 8_000 });
    expect(first.decisionManifest).toEqual(second.decisionManifest);
    expect(context).toEqual(before);
    context.ownedEntityState["entity-gate"]["location.open"] = true;
    expect(createActorContextAccess(context, { maxModelChars: 8_000 }).decisionManifest?.snapshotHash).not.toBe(first.decisionManifest?.snapshotHash);
    expect(promptJson(first)).not.toContain("future-canon");
  });

  it("uses exact final prompt size, not the conservative optional-record reserve, for dependency admission", () => {
    const context = fixture();
    context.knowledge = [context.knowledge.at(-1)!];
    context.archive = [];
    context.decision.goals = [{ id: "semantic-goal", description: "x".repeat(3_000), priority: 1, targetIds: [] }];
    const access = createActorContextAccess(context, { maxModelChars: 7_000 });
    expect(access.modelContext.decision).toEqual(context.decision);
    expect(access.decisionManifest?.modelChars).toBeLessThanOrEqual(7_000);
  });

  it("rejects malformed decision data instead of downgrading it to optional prose", () => {
    expect(() => createActorContextAccess({ actorId: "actor-self", decision: { goals: [] } })).toThrow();
  });
});

describe("personal experience dependency closure", () => {
  it.each(["location.open", "state:location.open"])("retains direct and legacy state claims for %s", predicate => {
    const context = fixture();
    context.knowledge[50]!.claim.predicate = predicate;
    const access = createActorContextAccess(context, { maxModelChars: 8_000, query: "distractor" });
    expect(access.modelContext.knowledge).toContainEqual(context.knowledge[50]);
    expect(access.decisionManifest!.dependencyEdges).toContainEqual({ from: "decision:contracts", to: "knowledge:50", reason: "contract-field" });
  });

  it("keeps the content behind a personal experience even when distractors rank higher", () => {
    const context = fixture();
    context.decision.experiences = [{ acquisitionId: "experience-001", claimId: "claim-49", propositionId: "content-001" }];
    context.knowledge[49]!.claim = { predicate: "a-quiet-warning", object: "宁的警告：请绕行。" };
    const access = createActorContextAccess(context, { maxModelChars: 8_000, query: "distractor", sectionPriority: { archive: 0, knowledge: 1000 } });
    expect(access.modelContext.knowledge).toContainEqual(context.knowledge[49]);
    expect(access.decisionManifest!.records).toContainEqual(expect.objectContaining({ ref: "knowledge:49", selected: true, reason: "required-dependency" }));
    expect(access.decisionManifest!.records).toContainEqual(expect.objectContaining({ ref: "archive:0", selected: false, reason: "omitted-budget" }));
    expect(access.decisionManifest!.modelUtf8Bytes).toBe(Buffer.byteLength(promptJson(access.modelContext), "utf8"));
    expect(access.decisionManifest!.modelUtf8Bytes).toBeGreaterThan(access.decisionManifest!.modelChars!);
    expect(access.modelContext).not.toHaveProperty("dependencyEdges");
  });

  it("stops rather than giving the model an orphan experience handle", () => {
    const context = fixture();
    context.decision.experiences = [{ acquisitionId: "experience-001", claimId: "absent-claim", propositionId: "content-001" }];
    expect(() => createActorContextAccess(context, { maxModelChars: 8_000 })).toThrow(/no matching knowledge content/);
  });
});

describe("candidate and host scope binding", () => {
  it("retains exact candidate knowledge dependencies before ranking", () => {
    const context = { ...fixture(), intendedCandidate: { title: "Follow the quiet warning", participants: [], preconditions: [], proposedDelta: { version: 1, operations: [] }, requiresKnowledge: ["claim-49"], forbidsKnowledge: [] } };
    context.knowledge[49]!.claim.predicate = "a-quiet-warning";
    const access = createActorContextAccess(context, { maxModelChars: 8_000, query: "distractor" });
    expect(access.modelContext.intendedCandidate).toEqual(context.intendedCandidate);
    expect(access.modelContext.knowledge).toContainEqual(context.knowledge[49]);
    expect(access.decisionManifest!.dependencyEdges).toContainEqual({ from: "intendedCandidate", to: "knowledge:49", reason: "candidate-knowledge" });
    context.intendedCandidate.requiresKnowledge = ["absent-claim"];
    expect(() => createActorContextAccess(context)).toThrow(/Stop inference/);
  });

  it("keeps concurrent branch/head/candidate identities in host audit only", async () => {
    const { withDecisionScope, currentDecisionScope } = await import("../src/world/decision-scope.js");
    const scopes = [
      { branchId: "branch-a", headCommitId: "head-a", actorId: "actor-a", candidateHash: "candidate-a" },
      { branchId: "branch-b", headCommitId: "head-b", actorId: "actor-b", candidateHash: "candidate-b" },
    ];
    const results = await Promise.all(scopes.map(scope => withDecisionScope(scope, async () => {
      await Promise.resolve();
      const access = createActorContextAccess(fixture(), { maxModelChars: 8_000 });
      expect(access.decisionManifest!.scope).toEqual(scope);
      expect(JSON.stringify(access.modelContext)).not.toContain(scope.headCommitId);
      expect(JSON.stringify(access.modelContext)).not.toContain(scope.candidateHash);
      return access.decisionManifest!;
    })));
    expect(results[0]!.scopeHash).not.toBe(results[1]!.scopeHash);
    expect(results[0]!.snapshotHash).toBe(results[1]!.snapshotHash);
    expect(currentDecisionScope()).toBeUndefined();
  });
});

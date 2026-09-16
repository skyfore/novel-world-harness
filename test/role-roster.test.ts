import { describe, expect, it } from "vitest";
import { buildRoleRoster, majorRoleCandidates, validateRoleRoster, validateRosterReview, reviewedRoleDevelopmentRequirements, validateRoleDevelopmentExpectations, roleRosterSchema, type RoleRosterReview } from "../src/compiler/role-roster.js";
import type { SourceAnnotation } from "../src/compiler/annotations.js";
import type { Entity } from "../src/world/model.js";

const hero: Entity = { id: "hero", kind: "character", canonicalName: "Hero", aliases: ["The Courier"], evidence: [{ span: { sourceId: "source", startByte: 0, endByte: 5, startLine: 1, endLine: 1, quoteHash: "a".repeat(64) }, strength: "explicit" }] };
const missing = { id: "mention-missing", annotationType: "entity-mention", sourceId: "source", surface: "The Regent", kindCandidates: ["character"], derivation: { runId: "extraction" } } as SourceAnnotation;
const input = { sourceId: "source", sourceSha256: "b".repeat(64), unitIds: ["unit-1", "unit-2"], entities: [hero], annotations: [missing], resolutions: [] };

describe("independent role roster", () => {
  it("retains an unresolved major person in the denominator even without an entity or playable entry", () => {
    const roster = buildRoleRoster(input);
    expect(roster.candidates).toHaveLength(2);
    const review = (runId: string): RoleRosterReview => ({ runId, subjectHash: roster.subjectHash, reviewedUnitIds: [...input.unitIds],
      entries: roster.candidates.map((candidate) => ({ candidateId: candidate.id, importance: "major", rationale: "Carries a central causal arc", basisUnitIds: ["unit-1"] })) });
    roster.reviews = [review("review-1"), review("review-2")];
    expect(majorRoleCandidates(roster)).toHaveLength(2);
    expect(validateRoleRoster(roster)).toContainEqual(expect.objectContaining({ code: "ROSTER_MAJOR_IDENTITY_UNRESOLVED" }));
    const omitted = review("review-3"); omitted.entries.pop();
    expect(validateRosterReview({ ...roster, reviews: [] }, omitted)).toContainEqual(expect.objectContaining({ code: "ROSTER_DENOMINATOR_MISMATCH" }));
  });

  it("rejects stale identity reviews, extractor self-review and incomplete source coverage", () => {
    const roster = buildRoleRoster(input);
    const changed = buildRoleRoster({ ...input, entities: [{ ...hero, aliases: ["The Regent"] }] });
    const review: RoleRosterReview = { runId: "extraction", subjectHash: changed.subjectHash, reviewedUnitIds: ["unit-1"], entries: roster.candidates.map((candidate) => ({ candidateId: candidate.id, importance: "major", rationale: "Central", basisUnitIds: ["unit-1"] })) };
    expect(validateRosterReview(roster, review).map((x) => x.code)).toEqual(expect.arrayContaining(["ROSTER_STALE_REVIEW", "ROSTER_INDEPENDENT_REVIEW_REQUIRED", "ROSTER_FULL_SOURCE_REVIEW_REQUIRED"]));
    expect(validateRoleRoster(roster).map((x) => x.code)).toContain("ROSTER_REVIEW_INCOMPLETE");
  });

  it("retains a major person discovered only by independent full-source review", () => {
    const roster = buildRoleRoster({ ...input, annotations: [] });
    roster.reviews = ["first", "second"].map((runId) => ({ runId, subjectHash: roster.subjectHash, reviewedUnitIds: input.unitIds,
      entries: roster.candidates.map((candidate) => ({ candidateId: candidate.id, importance: "major", rationale: "Central", basisUnitIds: ["unit-1"] })),
      missingMajorCharacters: runId === "second" ? [{ name: "The late queen", rationale: "Determines the ending", basisUnitIds: ["unit-2"] }] : [],
    }));
    expect(majorRoleCandidates(roster).map((role) => role.name)).toEqual(["Hero", "The late queen"]);
    expect(validateRoleRoster(roster)).toContainEqual(expect.objectContaining({ code: "ROSTER_MAJOR_IDENTITY_UNRESOLVED" }));
  });
});


describe("source-reviewed development requirements", () => {
  const create = () => {
    const roster = buildRoleRoster({ ...input, annotations: [] });
    roster.reviews = ["review-1", "review-2"].map(runId => ({ version: 2, runId, subjectHash: roster.subjectHash,
      reviewedUnitIds: input.unitIds, entries: roster.candidates.map(candidate => ({ candidateId: candidate.id,
        importance: "major", rationale: "Central", basisUnitIds: ["unit-1"],
        developmentExpectation: { kind: "stable", rationale: "Source supports continuity", basisUnitIds: input.unitIds },
      })),
    }));
    return roster;
  };

  it("retains legacy omissions, insufficient evidence and reviewer disagreements as unknown", () => {
    const roster = create();
    expect(reviewedRoleDevelopmentRequirements(roster)[0]?.status).toBe("stable");
    const stable = reviewedRoleDevelopmentRequirements(roster)[0]!;
    delete roster.reviews[0]!.version;
    expect(reviewedRoleDevelopmentRequirements(roleRosterSchema.parse(roster))[0]?.status).toBe("unknown");
    roster.reviews[0]!.version = 2;
    roster.reviews[0]!.entries[0]!.developmentExpectation = { kind: "unknown", rationale: "Evidence insufficient", basisUnitIds: ["unit-1"] };
    expect(validateRoleDevelopmentExpectations(roster)).toContainEqual(expect.objectContaining({ path: stable.id, code: "ROSTER_DEVELOPMENT_EXPECTATION_UNKNOWN" }));
    roster.reviews[0]!.entries[0]!.developmentExpectation = { kind: "changes", rationale: "Changed choice under comparable pressure", changes: [{ dimensionId: "trust-readiness", direction: "increase", rationale: "Becomes willing to trust", beforeUnitIds: ["unit-1"], afterUnitIds: ["unit-2"] }] };
    const conflict = reviewedRoleDevelopmentRequirements(roster)[0]!;
    expect(conflict.status).toBe("unknown");
    expect(conflict.id).toBe(stable.id);
    expect(conflict.revisionHash).not.toBe(stable.revisionHash);
    expect(conflict.reviews.map(review => review.expectation?.kind)).toEqual(["changes", "stable"]);
    roster.reviews[1]!.entries[0]!.developmentExpectation = structuredClone(roster.reviews[0]!.entries[0]!.developmentExpectation);
    roster.reviews[1]!.entries[0]!.importance = "supporting";
    expect(reviewedRoleDevelopmentRequirements(roster)).toHaveLength(1);
    expect(reviewedRoleDevelopmentRequirements(roster)[0]?.status).toBe("changes");
    expect(reviewedRoleDevelopmentRequirements(roster)[0]?.reviews).toHaveLength(2);
  });

  it("rejects missing or foreign evidence and does not infer an omitted person's development", () => {
    const roster = create();
    const first = roster.reviews[0]!;
    delete first.entries[0]!.developmentExpectation;
    expect(validateRosterReview({ ...roster, reviews: [] }, first)).toContainEqual(expect.objectContaining({ code: "ROSTER_DEVELOPMENT_EXPECTATION_REQUIRED" }));
    first.entries[0]!.developmentExpectation = { kind: "changes", rationale: "Changed", changes: [{ dimensionId: "trust-readiness", direction: "increase", rationale: "Changed", beforeUnitIds: ["unit-1"], afterUnitIds: ["foreign-unit"] }] };
    expect(validateRosterReview({ ...roster, reviews: [] }, first)).toContainEqual(expect.objectContaining({ code: "ROSTER_UNKNOWN_EVIDENCE_UNIT" }));
    expect(reviewedRoleDevelopmentRequirements(roster)[0]?.status).toBe("unknown");
    first.missingMajorCharacters = [{ name: "The Queen", rationale: "Drives the ending", basisUnitIds: ["unit-2"] }];
    const omitted = reviewedRoleDevelopmentRequirements(roster).find(requirement => !requirement.actorId)!;
    expect(omitted.status).toBe("unknown");
    expect(omitted.reviews.every(review => review.expectation === null)).toBe(true);
  });
});

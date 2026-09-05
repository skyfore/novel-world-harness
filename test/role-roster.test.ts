import { describe, expect, it } from "vitest";
import { buildRoleRoster, majorRoleCandidates, validateRoleRoster, validateRosterReview, type RoleRosterReview } from "../src/compiler/role-roster.js";
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
});

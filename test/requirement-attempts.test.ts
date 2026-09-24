import { expect, it } from "vitest";
import { coreRoleAttemptReports, linkCoreRoleAttemptProposals, coreRoleAttemptSchema } from "../src/compiler/requirement-attempts.js";
import { contentHash } from "../src/world/canonical.js";

it("links independent capability attempts only to the matching typed proposal", () => {
  const hash = contentHash("fixture"), target = "character:ada";
  const requirements = ["ontology", "development", "opening-driver"].map(capability => ({ id: `${target}:${capability}`, target, capability })) as Parameters<typeof coreRoleAttemptReports>[0]["requirements"];
  const scope = { definitionRevision: hash, specHash: hash, requirements: requirements.map(item => ({ id: `role-ada:${item.capability}`, targetRef: target, capability: item.capability, definitionHash: contentHash(item) })) };
  const attempts = coreRoleAttemptReports({ batchId: "repair-one", scope, requirements, reviews: [{ target, disposition: "proposed", summary: "Partial attempt", evidence_segment_ids: ["source-part-one"],
    requirement_reviews: requirements.map(item => ({ requirementId: item.id, disposition: item.capability === "opening-driver" ? "proposed" : "capability-gap", summary: "Report this capability only" })),
  }] });
  const proposal = (proposalId: string, actorId: string, executable: boolean) => ({ ref: { store: "world" as const, proposalId, hash }, kind: "character-goal", payload: {
    id: proposalId, actorId, ...(executable ? { candidateAction: { proposedDelta: { operations: [{ op: "set", entityId: actorId, field: "character.location", value: "door" }] } } } : {}),
  } });
  const linked = linkCoreRoleAttemptProposals(attempts, requirements, [proposal("static-goal", "ada", false), proposal("other-actor-goal", "bo", true), proposal("ada-driver", "ada", true)]);
  expect(linked.map(item => item.proposalRefs.map(ref => ref.proposalId))).toEqual([[], [], ["ada-driver"]]);
  expect(linked.map(item => item.modelOutcome)).toEqual(["capability-gap", "capability-gap", "proposed"]);
  expect(linked[0]!.evidenceRefs).toEqual(["source-segment:source-part-one"]);
  expect(() => coreRoleAttemptSchema.parse({ ...linked[2], modelOutcome: "satisfied" })).toThrow();
});

it("does not invent independent bindings for reports outside the registered target or capability", () => {
  const hash = contentHash("scope"), requirement = { id: "character:ada:ontology", target: "character:ada", capability: "ontology" as const };
  const input = { batchId: "repair", scope: { definitionRevision: hash, specHash: hash, requirements: [{ id: "role-bo:ontology", definitionHash: hash, targetRef: "character:bo", capability: "ontology" }] }, requirements: [requirement],
    reviews: [{ target: requirement.target, disposition: "capability-gap" as const, summary: "No model", evidence_segment_ids: ["part"], requirement_reviews: [{ requirementId: requirement.id, disposition: "capability-gap" as const, summary: "No model" }] }],
  };
  expect(coreRoleAttemptReports(input)).toEqual([]);
  input.reviews[0]!.requirement_reviews[0]!.requirementId = "guessed";
  expect(() => coreRoleAttemptReports(input)).toThrow("escapes its frozen plan");
});

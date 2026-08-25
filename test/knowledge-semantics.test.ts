import { describe, expect, it } from "vitest";
import {
  knowledgeOperationSchema,
  type Attribution,
  type Claim,
  type Proposition,
} from "../src/world/model.js";
import {
  findKnowledgeDeltas,
  validateKnowledgeSemanticReferences,
} from "../src/world/knowledge-semantics.js";

const claim: Claim = {
  id: "gate-open-claim",
  subject: "gate",
  predicate: "open",
  object: true,
  epistemicType: "explicit-fact",
  evidence: [],
};

const proposition: Proposition = {
  id: "gate-open",
  subjectEntityId: "gate",
  relationId: "open",
  object: { kind: "literal", value: true },
  polarity: "positive",
  modality: "asserted",
  evidence: [],
};

const attribution: Attribution = {
  id: "alice-reports-gate-open",
  propositionId: "gate-open",
  holderKind: "character",
  holderEntityId: "alice",
  attitude: "reports",
  certainty: 1,
  evidence: [],
};

describe("knowledge semantic bridge", () => {
  it("preserves legacy claim-keyed operations while requiring complete semantic provenance when opted in", () => {
    expect(knowledgeOperationSchema.safeParse({
      op: "learn",
      actorId: "bob",
      claimId: "gate-open-claim",
      status: "knows",
      confidence: 1,
    }).success).toBe(true);

    expect(knowledgeOperationSchema.safeParse({
      op: "learn",
      actorId: "bob",
      claimId: "gate-open-claim",
      propositionId: "gate-open",
      status: "knows",
      confidence: 1,
    }).success).toBe(false);
    expect(knowledgeOperationSchema.safeParse({
      op: "learn",
      actorId: "bob",
      claimId: "gate-open-claim",
      propositionId: "gate-open",
      attributionId: "alice-reports-gate-open",
      acquisitionMode: "deceived-misattributed",
      status: "knows",
      confidence: 1,
    }).success).toBe(false);
  });

  it("detects claim/proposition projection drift and incoherent acquisition sources", () => {
    const catalog = {
      claims: new Map([[claim.id, { ...claim, predicate: "closed" }]]),
      propositions: new Map([[proposition.id, proposition]]),
      attributions: new Map([[attribution.id, attribution]]),
    };
    const errors = validateKnowledgeSemanticReferences({
      op: "learn",
      actorId: "bob",
      claimId: claim.id,
      propositionId: proposition.id,
      attributionId: attribution.id,
      acquisitionMode: "told",
      sourceActorId: "charlie",
      status: "believes",
      confidence: 0.8,
    }, catalog, "knowledge.operations.0");

    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "KNOWLEDGE_PROJECTION_MISMATCH" }),
      expect.objectContaining({ code: "TOLD_SOURCE_ATTRIBUTION_MISMATCH" }),
    ]));

    const readErrors = validateKnowledgeSemanticReferences({
      op: "learn",
      actorId: "bob",
      claimId: claim.id,
      propositionId: proposition.id,
      attributionId: attribution.id,
      acquisitionMode: "read",
      status: "believes",
      confidence: 0.8,
    }, { ...catalog, claims: new Map([[claim.id, claim]]) }, "knowledge.operations.0");
    expect(readErrors).toContainEqual(expect.objectContaining({ code: "READ_SOURCE_ATTRIBUTION_MISMATCH" }));

    const lossyErrors = validateKnowledgeSemanticReferences({
      op: "learn",
      actorId: "bob",
      claimId: claim.id,
      propositionId: proposition.id,
      acquisitionMode: "inferred",
      status: "believes",
      confidence: 0.5,
    }, {
      claims: new Map([[claim.id, claim]]),
      propositions: new Map([[proposition.id, {
        ...proposition,
        polarity: "negative",
        modality: "possible",
      }]]),
      attributions: new Map(),
    }, "knowledge.operations.0");
    expect(lossyErrors.filter((error) => error.code === "KNOWLEDGE_PROJECTION_MISMATCH")).toHaveLength(2);
  });

  it("locates knowledge deltas inside supported compiler payload shapes", () => {
    const payload = {
      nested: {
        proposedKnowledge: {
          version: 1,
          operations: [{
            op: "learn",
            actorId: "bob",
            claimId: "gate-open-claim",
            status: "heard",
            confidence: 0.5,
          }],
        },
      },
    };
    expect(findKnowledgeDeltas(payload)).toEqual([
      expect.objectContaining({ path: "nested.proposedKnowledge" }),
    ]);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerProposalService, validateCompilerProposalClosure } from "../src/compiler/proposals.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { CompilerCommitService } from "../src/compiler/validator.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-compiler-"));
  roots.push(root);
  const source = await createEvidenceFixture(root, "曹操，字孟德\n北门\nUnknown person appears\n");
  return { root, proposals: new CompilerProposalService(root), commits: new CompilerCommitService(root), evidence: source.evidence };
}

describe("CompilerCommitService", () => {
  it("commits an evidence-backed entity after deterministic validation", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "entity-cao",
      payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: ["孟德"], evidence: evidence("曹操，字孟德") },
      generatedBy: { worker: "test" },
    });
    const validation = await commits.accept("entity", "entity-cao");
    expect(validation.accepted).toBe(true);
    await expect(commits.canon.getEntity("cao-cao")).resolves.toMatchObject({ canonicalName: "曹操" });
  });

  it("keeps entity names and aliases pending when they are absent from verified evidence", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "entity-inferred-cao",
      payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: ["孟德"], evidence: evidence("Unknown person appears") },
      generatedBy: { worker: "test" },
    });

    const validation = await commits.accept("entity", "entity-inferred-cao");
    expect(validation.accepted).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNSUPPORTED_ENTITY_CANONICAL_NAME", path: "canonicalName" }),
      expect.objectContaining({ code: "UNSUPPORTED_ENTITY_ALIAS", path: "aliases.0" }),
    ]));
    await expect(commits.canon.getEntity("cao-cao")).rejects.toThrow();
  });

  it("accepts an evidence-backed entity without inventing aliases", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "entity-no-alias",
      payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: evidence("曹操") },
      generatedBy: { worker: "test" },
    });

    const validation = await commits.accept("entity", "entity-no-alias");
    expect(validation.accepted).toBe(true);
    expect(validation.warnings).toEqual([]);
  });

  it("accepts a Chinese personal name explicitly composed from surname and given name", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-compiler-composed-name-"));
    roots.push(root);
    const source = await createEvidenceFixture(root, "此人复姓诸葛，名亮，字孔明，号卧龙先生。\n");
    const proposals = new CompilerProposalService(root);
    const commits = new CompilerCommitService(root);
    await proposals.submit("entity", {
      proposalId: "entity-zhuge-liang",
      payload: {
        id: "zhuge-liang",
        kind: "character",
        canonicalName: "诸葛亮",
        aliases: ["孔明", "卧龙先生"],
        evidence: source.evidence("此人复姓诸葛，名亮，字孔明，号卧龙先生。"),
      },
      generatedBy: { worker: "test" },
    });

    const validation = await commits.accept("entity", "entity-zhuge-liang");
    expect(validation.accepted).toBe(true);
    await expect(commits.canon.getEntity("zhuge-liang")).resolves.toMatchObject({ canonicalName: "诸葛亮" });
  });

  it("keeps an invalid event pending when it references an unknown participant", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("canonical-event", {
      proposalId: "bad-event",
      payload: {
        id: "event-1",
        title: "Unknown person appears",
        participants: ["missing-person"],
        storyTime: { kind: "unknown" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        evidence: evidence("Unknown person appears"),
        causalParents: [],
        confidence: 1,
      },
      generatedBy: { worker: "test" },
    });
    const validation = await commits.accept("canonical-event", "bad-event");
    expect(validation.accepted).toBe(false);
    expect(validation.errors.some((error) => error.code === "UNKNOWN_PARTICIPANT")).toBe(true);
    await expect(commits.canon.getEvent("event-1")).rejects.toThrow();
    await expect(commits.proposals.read("pending", "bad-event", (await import("../src/world/model.js")).canonicalEventSchema)).resolves.toMatchObject({ id: "bad-event" });
  });

  it("requires exactly character-scoped event presence during canonical validation", async () => {
    const { proposals, commits, evidence } = await fixture();
    for (const [proposalId, id, kind, name, quote] of [
      ["presence-cao", "cao-cao", "character", "曹操", "曹操"],
      ["presence-gate", "north-gate", "location", "北门", "北门"],
    ] as const) {
      await proposals.submit("entity", {
        proposalId,
        payload: { id, kind, canonicalName: name, aliases: [], evidence: evidence(quote) },
        generatedBy: { worker: "test" },
      });
    }
    expect((await commits.acceptAllValid()).blocked).toEqual([]);
    await proposals.submit("canonical-event", {
      proposalId: "invalid-presence-event",
      payload: {
        id: "cao-at-gate",
        title: "曹操来到北门",
        participants: ["cao-cao", "north-gate"],
        participantPresence: [{ entityId: "north-gate", mode: "physical" }],
        storyTime: { kind: "unknown" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        evidence: evidence("曹操，字孟德\n北门"),
        causalParents: [],
        confidence: 1,
      },
      generatedBy: { worker: "test" },
    });

    const validation = await commits.accept("canonical-event", "invalid-presence-event");
    expect(validation.accepted).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_PARTICIPANT_PRESENCE" }),
      expect.objectContaining({ code: "MISSING_PARTICIPANT_PRESENCE" }),
    ]));
  });

  it("rejects a later-character checkpoint that has presence but no actionable pre-event state", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "entry-cao",
      payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: evidence("曹操") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "entry-cao")).accepted).toBe(true);
    await proposals.submit("canonical-event", {
      proposalId: "inactionable-entry-event",
      payload: {
        id: "cao-appears",
        title: "曹操 appears",
        readerSummary: "曹操 appears at the northern gate.",
        participants: ["cao-cao"],
        participantPresence: [{ entityId: "cao-cao", mode: "physical" }],
        characterEntryCheckpoints: [{
          actorId: "cao-cao",
          readerSetup: "曹操 is about to enter the scene.",
          actorObservation: "You can see the northern gate.",
          participantPresence: [{ entityId: "cao-cao", mode: "physical" }],
          delta: {
            version: 1,
            operations: [{ op: "set", entityId: "cao-cao", field: "character.alive", value: true }],
          },
        }],
        storyTime: { kind: "unknown" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        evidence: evidence("曹操"),
        causalParents: [],
        confidence: 1,
      },
      generatedBy: { worker: "test" },
    });

    const validation = await commits.accept("canonical-event", "inactionable-entry-event");
    expect(validation.accepted).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: "INACTIONABLE_CHARACTER_ENTRY" }));
  });

  it("rejects an empty opening snapshot that cannot produce a playable character", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "opening-cao",
      payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: evidence("曹操") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "opening-cao")).accepted).toBe(true);
    await proposals.submit("initial-world", {
      proposalId: "empty-opening",
      payload: {
        version: 1,
        delta: { version: 1, operations: [] },
        evidence: evidence("曹操"),
      },
      generatedBy: { worker: "test" },
    });

    const validation = await commits.accept("initial-world", "empty-opening");
    expect(validation.accepted).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: "UNPLAYABLE_INITIAL_WORLD" }));
  });

  it("rejects an alive-only opening inventory for a multi-character source", async () => {
    const { proposals, commits, evidence } = await fixture();
    for (const [proposalId, id, name] of [
      ["opening-cao", "cao-cao", "曹操"],
      ["opening-stranger", "stranger", "Unknown person"],
    ] as const) {
      await proposals.submit("entity", {
        proposalId,
        payload: { id, kind: "character", canonicalName: name, aliases: [], evidence: evidence(name) },
        generatedBy: { worker: "test" },
      });
      expect((await commits.accept("entity", proposalId)).accepted).toBe(true);
    }
    await proposals.submit("initial-world", {
      proposalId: "alive-inventory-opening",
      payload: {
        version: 1,
        delta: {
          version: 1,
          operations: [
            { op: "set", entityId: "cao-cao", field: "character.alive", value: true },
            { op: "set", entityId: "stranger", field: "character.alive", value: true },
          ],
        },
        evidence: evidence("曹操"),
      },
      generatedBy: { worker: "test" },
    });

    const validation = await commits.accept("initial-world", "alive-inventory-opening");
    expect(validation.accepted).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: "INACTIONABLE_INITIAL_WORLD" }));
  });

  it("rejects character IDs stored as relationship references in an initial world", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "relationship-owner-cao",
      payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: evidence("曹操") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "relationship-owner-cao")).accepted).toBe(true);
    await proposals.submit("initial-world", {
      proposalId: "invalid-relationship-opening",
      payload: {
        version: 1,
        delta: {
          version: 1,
          operations: [
            { op: "set", entityId: "cao-cao", field: "character.alive", value: true },
            { op: "set", entityId: "cao-cao", field: "character.relationships", value: ["cao-cao"] },
          ],
        },
        evidence: evidence("曹操"),
      },
      generatedBy: { worker: "test" },
    });

    const validation = await commits.accept("initial-world", "invalid-relationship-opening");
    expect(validation.accepted).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: "INVALID_RELATIONSHIP_REFERENCE",
      path: "delta.operations.1.value.0",
    }));
  });

  it("validates goal phase anchors, targets, and every action pattern at the commit boundary", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "goal-cao",
      payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: evidence("曹操") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "goal-cao")).accepted).toBe(true);
    await proposals.submit("character-goal", {
      proposalId: "bad-goal",
      payload: {
        id: "reach-missing-gate",
        actorId: "cao-cao",
        description: "Reach a later gate",
        priority: 0.8,
        requiresKnowledge: [],
        targetIds: ["missing-gate"],
        activation: {
          preconditions: [],
          afterCanonicalEventIds: ["missing-event"],
        },
        actionPatterns: [{
          title: "Address a missing person",
          participants: ["missing-person"],
          preconditions: [],
          proposedDelta: { version: 1, operations: [] },
        }],
        evidence: evidence("曹操"),
      },
      generatedBy: { worker: "test" },
    });

    const validation = await commits.accept("character-goal", "bad-goal");
    expect(validation.accepted).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNKNOWN_GOAL_TARGET" }),
      expect.objectContaining({ code: "UNKNOWN_GOAL_EVENT" }),
      expect.objectContaining({ code: "UNKNOWN_GOAL_PARTICIPANT" }),
    ]));
  });

  it("rejects a canonical child whose story time precedes its causal parent", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "time-cao",
      payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: evidence("曹操") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "time-cao")).accepted).toBe(true);
    await proposals.submit("canonical-event", {
      proposalId: "future-parent",
      payload: {
        id: "future-parent-event",
        title: "Later parent",
        participants: ["cao-cao"],
        participantPresence: [{ entityId: "cao-cao", mode: "physical" }],
        storyTime: { kind: "exact", value: "2050", precision: "year" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        evidence: evidence("曹操"),
        causalParents: [],
        confidence: 1,
      },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("canonical-event", "future-parent")).accepted).toBe(true);
    await proposals.submit("canonical-event", {
      proposalId: "past-child",
      payload: {
        id: "past-child-event",
        title: "Earlier child",
        participants: ["cao-cao"],
        participantPresence: [{ entityId: "cao-cao", mode: "physical" }],
        storyTime: { kind: "exact", value: "1950", precision: "year" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        evidence: evidence("曹操"),
        causalParents: ["future-parent-event"],
        confidence: 1,
      },
      generatedBy: { worker: "test" },
    });

    const validation = await commits.accept("canonical-event", "past-child");
    expect(validation.accepted).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: "TEMPORAL_CAUSAL_REGRESSION" }));
  });

  it("keeps an event with an unknown observed-knowledge claim pending", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "entity-cao",
      payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: evidence("曹操") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "entity-cao")).accepted).toBe(true);
    await proposals.submit("canonical-event", {
      proposalId: "knowledge-event",
      payload: {
        id: "cao-learns-secret",
        title: "曹操得知秘密",
        participants: ["cao-cao"],
        storyTime: { kind: "unknown" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        observedKnowledge: { version: 1, operations: [{ op: "learn", actorId: "cao-cao", claimId: "missing-claim", status: "knows", confidence: 1 }] },
        evidence: evidence("曹操"),
        causalParents: [],
        confidence: 1,
      },
      generatedBy: { worker: "test" },
    });
    const validation = await commits.accept("canonical-event", "knowledge-event");
    expect(validation.accepted).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: "UNKNOWN_KNOWLEDGE_CLAIM" }));
  });

  it("rejects meta-knowledge claims in favor of deterministic knowledge deltas", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "entity-cao",
      payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: evidence("曹操") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "entity-cao")).accepted).toBe(true);
    await expect(proposals.submit("claim", {
      proposalId: "cao-does-not-know",
      payload: { id: "cao-does-not-know", subject: "cao-cao", predicate: "does-not-know", object: "secret", epistemicType: "interpretation", evidence: evidence("曹操") },
      generatedBy: { worker: "test" },
    })).rejects.toThrow("KnowledgeDelta");
  });

  it("does not misreport a blocked canonical proposal as staging", async () => {
    const { proposals, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "place",
      payload: { id: "north-gate", kind: "location", canonicalName: "北门", aliases: [], evidence: evidence("北门") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("world-rule", {
      proposalId: "bad-rule",
      payload: {
        id: "bad-rule",
        name: "Location uses a character-only field",
        scope: "location",
        appliesWhen: [{ op: "fact-exists", entityId: "north-gate", field: "character.alive" }],
        evidence: evidence("曹操"),
      },
      generatedBy: { worker: "test" },
    });

    const result = await convergeWorldProposals(roots.at(-1)!);
    expect(result.canonical.blocked).toMatchObject([{ id: "bad-rule", kind: "world-rule" }]);
    expect(result.canonical.blocked[0]?.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INERT_WORLD_RULE" }),
      expect.objectContaining({ code: "INVALID_PREDICATE_FIELD" }),
    ]));
    expect(result.staging).not.toContainEqual({ id: "bad-rule", kind: "world-rule" });
  });

  it("rejects self-forbidding rules at the deterministic commit boundary", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "gate",
      payload: { id: "north-gate", kind: "location", canonicalName: "北门", aliases: [], evidence: evidence("北门") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "gate")).accepted).toBe(true);
    const condition = { op: "fact-equals" as const, entityId: "north-gate", field: "location.open", value: true };
    await proposals.submit("world-rule", {
      proposalId: "self-forbidding-rule",
      payload: {
        id: "self-forbidding-rule",
        name: "门开时禁止门开",
        scope: "location",
        appliesWhen: [condition],
        forbids: [condition],
        evidence: evidence("曹操"),
      },
      generatedBy: { worker: "test" },
    });

    const validation = await commits.accept("world-rule", "self-forbidding-rule");
    expect(validation.accepted).toBe(false);
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: "SELF_FORBIDDING_WORLD_RULE" }));
  });

  it("deterministically selects the newest active proposal for one logical artifact", async () => {
    const { proposals, commits, evidence } = await fixture();
    for (const proposalId of ["entity-cao-first", "entity-cao-second"]) {
      await proposals.submit("entity", {
        proposalId,
        payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: evidence("曹操") },
        generatedBy: { worker: "test" },
      });
    }

    const result = await commits.acceptAllValid();
    expect(result.accepted).toEqual([{ id: "entity-cao-second", kind: "entity" }]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.errors).toContainEqual(expect.objectContaining({ code: "SUPERSEDED_LOGICAL_PROPOSAL" }));
    await expect(commits.canon.getEntity("cao-cao")).resolves.toMatchObject({ id: "cao-cao" });
    await expect(commits.acceptAllValid()).resolves.toMatchObject({ accepted: [], blocked: [] });
    await expect(commits.proposals.list("rejected")).resolves.toContainEqual(expect.objectContaining({ id: "entity-cao-first" }));
  });

  it("commits event dependencies in topological order with observable progress", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "entity-cao",
      payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: evidence("曹操") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("canonical-event", {
      proposalId: "child-submitted-first",
      payload: {
        id: "event-child",
        title: "Second event",
        participants: ["cao-cao"],
        participantPresence: [{ entityId: "cao-cao", mode: "physical" }],
        storyTime: { kind: "relative", anchorEventId: "event-parent", relation: "after" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        evidence: evidence("曹操"),
        causalParents: ["event-parent"],
        confidence: 1,
      },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("canonical-event", {
      proposalId: "parent-submitted-second",
      payload: {
        id: "event-parent",
        title: "First event",
        participants: ["cao-cao"],
        participantPresence: [{ entityId: "cao-cao", mode: "physical" }],
        storyTime: { kind: "unknown" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        evidence: evidence("曹操"),
        causalParents: [],
        confidence: 1,
      },
      generatedBy: { worker: "test" },
    });
    const progress: number[] = [];

    const result = await commits.acceptAllValid(undefined, (item) => progress.push(item.processed));
    expect(result.blocked).toEqual([]);
    expect(result.accepted.map((item) => item.id)).toEqual(["entity-cao", "parent-submitted-second", "child-submitted-first"]);
    expect(progress.at(-1)).toBe(3);
    await expect(commits.canon.getEvent("event-child")).resolves.toMatchObject({ causalParents: ["event-parent"] });
  });

  it("reports causal cycles without repeatedly rescanning pending events", async () => {
    const { proposals, commits, evidence } = await fixture();
    for (const [proposalId, id, parent] of [
      ["cycle-a", "event-a", "event-b"],
      ["cycle-b", "event-b", "event-a"],
    ] as const) {
      await proposals.submit("canonical-event", {
        proposalId,
        payload: {
          id,
          title: id,
          participants: [],
          storyTime: { kind: "unknown" },
          preconditions: [],
          observedOutcome: { version: 1, operations: [] },
          evidence: evidence("曹操"),
          causalParents: [parent],
          confidence: 1,
        },
        generatedBy: { worker: "test" },
      });
    }

    const result = await commits.acceptAllValid();
    expect(result.blocked).toHaveLength(2);
    expect(result.blocked.every((item) => item.errors.some((error) => error.code === "CAUSAL_CYCLE"))).toBe(true);
  });

  it("commits proposition content before attribution without promoting either to world state", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("attribution", {
      proposalId: "cao-reports-gate",
      payload: {
        id: "cao-reports-gate",
        propositionId: "gate-open",
        holderKind: "character",
        holderEntityId: "cao-cao",
        attitude: "reports",
        certainty: 0.9,
        evidence: evidence("曹操，字孟德\n北门"),
      },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("proposition", {
      proposalId: "gate-open-proposition",
      payload: {
        id: "gate-open",
        subjectEntityId: "north-gate",
        relationId: "open",
        object: { kind: "literal", value: true },
        polarity: "positive",
        modality: "asserted",
        evidence: evidence("北门"),
      },
      generatedBy: { worker: "test" },
    });
    for (const [proposalId, id, kind, canonicalName, quote] of [
      ["entity-cao", "cao-cao", "character", "曹操", "曹操"],
      ["entity-gate", "north-gate", "location", "北门", "北门"],
    ] as const) {
      await proposals.submit("entity", {
        proposalId,
        payload: { id, kind, canonicalName, aliases: [], evidence: evidence(quote) },
        generatedBy: { worker: "test" },
      });
    }

    const result = await commits.acceptAllValid();

    expect(result.blocked).toEqual([]);
    expect(result.accepted.map((item) => item.kind)).toEqual(["entity", "entity", "proposition", "attribution"]);
    await expect(commits.canon.getProposition("gate-open")).resolves.toMatchObject({ relationId: "open" });
    await expect(commits.canon.getAttribution("cao-reports-gate")).resolves.toMatchObject({ attitude: "reports" });
    expect(await commits.canon.listClaims()).toEqual([]);
    expect(await commits.canon.listEvents()).toEqual([]);
  });

  it("commits a same-pass claim, proposition, attribution, and semantic knowledge event in dependency order", async () => {
    const { proposals, commits, evidence } = await fixture();
    for (const [proposalId, id, kind, canonicalName, quote] of [
      ["entity-cao", "cao-cao", "character", "曹操", "曹操"],
      ["entity-gate", "north-gate", "location", "北门", "北门"],
    ] as const) {
      await proposals.submit("entity", {
        proposalId,
        payload: { id, kind, canonicalName, aliases: [], evidence: evidence(quote) },
        generatedBy: { worker: "test" },
      });
    }
    await proposals.submit("claim", {
      proposalId: "gate-open-claim-proposal",
      payload: {
        id: "gate-open-claim",
        subject: "north-gate",
        predicate: "open",
        object: true,
        epistemicType: "explicit-fact",
        evidence: evidence("北门"),
      },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("proposition", {
      proposalId: "gate-open-proposition",
      payload: {
        id: "gate-open",
        subjectEntityId: "north-gate",
        relationId: "open",
        object: { kind: "literal", value: true },
        polarity: "positive",
        modality: "asserted",
        evidence: evidence("北门"),
      },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("attribution", {
      proposalId: "narrator-reports-gate",
      payload: {
        id: "narrator-reports-gate",
        propositionId: "gate-open",
        holderKind: "narrator",
        attitude: "reports",
        certainty: 1,
        evidence: evidence("北门"),
      },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("canonical-event", {
      proposalId: "knowledge-event",
      payload: {
        id: "cao-remembers-gate-open",
        title: "曹操记起北门状态",
        participants: ["cao-cao"],
        participantPresence: [{ entityId: "cao-cao", mode: "physical" }],
        storyTime: { kind: "unknown" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        observedKnowledge: {
          version: 1,
          operations: [{
            op: "learn",
            actorId: "cao-cao",
            claimId: "gate-open-claim",
            propositionId: "gate-open",
            attributionId: "narrator-reports-gate",
            acquisitionMode: "remembered",
            status: "knows",
            confidence: 1,
          }],
        },
        evidence: evidence("曹操，字孟德\n北门"),
        causalParents: [],
        confidence: 1,
      },
      generatedBy: { worker: "test" },
    });

    const result = await commits.acceptAllValid();
    expect(result.blocked).toEqual([]);
    expect(result.accepted.map((item) => item.kind)).toEqual([
      "entity",
      "entity",
      "claim",
      "proposition",
      "attribution",
      "canonical-event",
    ]);
    await expect(commits.canon.getEvent("cao-remembers-gate-open")).resolves.toMatchObject({
      observedKnowledge: {
        operations: [expect.objectContaining({
          propositionId: "gate-open",
          attributionId: "narrator-reports-gate",
          acquisitionMode: "remembered",
        })],
      },
    });
  });

  it("commits a same-pass event before its typed participation records", async () => {
    const { proposals, commits, evidence } = await fixture();
    await commits.canon.putEntity({ id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: evidence("曹操") });
    await commits.canon.putEntity({ id: "north-gate", kind: "location", canonicalName: "北门", aliases: [], evidence: evidence("北门") });
    await proposals.submit("canonical-event", {
      proposalId: "arrival-event",
      payload: {
        id: "cao-arrives-at-gate",
        title: "曹操来到北门",
        participants: ["cao-cao", "north-gate"],
        participantPresence: [{ entityId: "cao-cao", mode: "physical" }],
        storyTime: { kind: "unknown" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        evidence: evidence("曹操，字孟德\n北门"),
        causalParents: [],
        confidence: 1,
      },
      generatedBy: { worker: "test" },
    });
    for (const [proposalId, payload] of [
      ["arrival-cao-role", {
        id: "cao-arrives-at-gate-cao",
        eventId: "cao-arrives-at-gate",
        entityId: "cao-cao",
        role: "agent",
        presence: "physical",
        confidence: 1,
        evidence: evidence("曹操"),
      }],
      ["arrival-gate-role", {
        id: "cao-arrives-at-gate-gate",
        eventId: "cao-arrives-at-gate",
        entityId: "north-gate",
        role: "destination",
        confidence: 1,
        evidence: evidence("北门"),
      }],
    ] as const) {
      await proposals.submit("event-participation", {
        proposalId,
        payload,
        generatedBy: { worker: "test" },
      });
    }

    const result = await commits.acceptAllValid();
    expect(result.blocked).toEqual([]);
    expect(result.accepted.map((item) => item.kind)).toEqual([
      "canonical-event",
      "event-participation",
      "event-participation",
    ]);
    await expect(commits.canon.listEventParticipations()).resolves.toHaveLength(2);
  });

  it("blocks batch closure until typed roles project every legacy participant", async () => {
    const { root, proposals, commits, evidence } = await fixture();
    await commits.canon.putEntity({ id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: evidence("曹操") });
    await commits.canon.putEntity({ id: "north-gate", kind: "location", canonicalName: "北门", aliases: [], evidence: evidence("北门") });
    await commits.canon.putEvent({
      id: "cao-at-gate",
      title: "曹操在北门",
      participants: ["cao-cao", "north-gate"],
      participantPresence: [{ entityId: "cao-cao", mode: "physical" }],
      storyTime: { kind: "unknown" },
      preconditions: [],
      observedOutcome: { version: 1, operations: [] },
      evidence: evidence("曹操，字孟德\n北门"),
      causalParents: [],
      confidence: 1,
    });
    await proposals.submit("event-participation", {
      proposalId: "cao-at-gate-cao-role",
      payload: {
        id: "cao-at-gate-cao",
        eventId: "cao-at-gate",
        entityId: "cao-cao",
        role: "agent",
        presence: "physical",
        confidence: 1,
        evidence: evidence("曹操"),
      },
      generatedBy: { worker: "test" },
    });

    const partial = await validateCompilerProposalClosure(
      root,
      ["cao-at-gate-cao-role"],
    );
    expect(partial.some((message) => message.includes("INCOMPLETE_EVENT_PARTICIPATION"))).toBe(true);

    await proposals.submit("event-participation", {
      proposalId: "cao-at-gate-gate-role",
      payload: {
        id: "cao-at-gate-gate",
        eventId: "cao-at-gate",
        entityId: "north-gate",
        role: "location",
        confidence: 1,
        evidence: evidence("北门"),
      },
      generatedBy: { worker: "test" },
    });
    await expect(validateCompilerProposalClosure(
      root,
      ["cao-at-gate-cao-role", "cao-at-gate-gate-role"],
    )).resolves.toEqual([]);
  });

  it("commits a same-pass event before its independently evidenced causal relation", async () => {
    const { proposals, commits, evidence } = await fixture();
    await commits.canon.putEvent({
      id: "first-event",
      title: "曹操出现",
      participants: [],
      storyTime: { kind: "ordinal", label: "first", orderHint: 1 },
      preconditions: [],
      observedOutcome: { version: 1, operations: [] },
      evidence: evidence("曹操"),
      causalParents: [],
      confidence: 1,
    });
    await proposals.submit("canonical-event", {
      proposalId: "second-event-proposal",
      payload: {
        id: "second-event",
        title: "北门随后出现",
        participants: [],
        storyTime: { kind: "ordinal", label: "second", orderHint: 2 },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        evidence: evidence("北门"),
        causalParents: ["first-event"],
        confidence: 1,
      },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("event-relation", {
      proposalId: "first-enables-second-proposal",
      payload: {
        id: "first-enables-second",
        fromEventId: "first-event",
        toEventId: "second-event",
        type: "enables",
        status: "explicit",
        confidence: 1,
        mechanism: "The first event establishes the condition for the second.",
        evidence: evidence("曹操，字孟德\n北门"),
      },
      generatedBy: { worker: "test" },
    });

    const result = await commits.acceptAllValid();
    expect(result.blocked).toEqual([]);
    expect(result.accepted.map((item) => item.kind)).toEqual(["canonical-event", "event-relation"]);
    await expect(commits.canon.getEventRelation("first-enables-second")).resolves.toMatchObject({
      type: "enables",
      fromEventId: "first-event",
      toEventId: "second-event",
    });
  });

  it("rejects event relations with unknown endpoints", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("event-relation", {
      proposalId: "orphan-relation",
      payload: {
        id: "orphan-relation",
        fromEventId: "missing-first",
        toEventId: "missing-second",
        type: "before",
        status: "explicit",
        confidence: 1,
        evidence: evidence("曹操"),
      },
      generatedBy: { worker: "test" },
    });

    const result = await commits.accept("event-relation", "orphan-relation");
    expect(result.accepted).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNKNOWN_RELATION_SOURCE_EVENT" }),
      expect.objectContaining({ code: "UNKNOWN_RELATION_TARGET_EVENT" }),
    ]));
  });

  it("rejects a single accepted event relation that would make the canonical temporal graph cyclic", async () => {
    const { proposals, commits, evidence } = await fixture();
    for (const id of ["event-a", "event-b", "event-c"]) {
      await commits.canon.putEvent({
        id,
        title: id,
        participants: [],
        storyTime: { kind: "unknown" },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        evidence: evidence("曹操"),
        causalParents: [],
        confidence: 1,
      });
    }
    for (const [proposalId, relationId, fromEventId, toEventId] of [
      ["a-before-b-proposal", "a-before-b", "event-a", "event-b"],
      ["b-before-c-proposal", "b-before-c", "event-b", "event-c"],
    ] as const) {
      await proposals.submit("event-relation", {
        proposalId,
        payload: {
          id: relationId,
          fromEventId,
          toEventId,
          type: "before",
          status: "explicit",
          confidence: 1,
          evidence: evidence("曹操"),
        },
        generatedBy: { worker: "test" },
      });
      expect((await commits.accept("event-relation", proposalId)).accepted).toBe(true);
    }
    await proposals.submit("event-relation", {
      proposalId: "c-before-a-proposal",
      payload: {
        id: "c-before-a",
        fromEventId: "event-c",
        toEventId: "event-a",
        type: "before",
        status: "explicit",
        confidence: 1,
        evidence: evidence("曹操"),
      },
      generatedBy: { worker: "test" },
    });

    const result = await commits.accept("event-relation", "c-before-a-proposal");
    expect(result.accepted).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "TEMPORAL_RELATION_CYCLE" }));
    await expect(commits.canon.getEventRelation("c-before-a")).rejects.toThrow("not found");
  });

  it("rejects invalid proposition references and epistemic relations", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "entity-cao",
      payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: evidence("曹操") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "entity-cao")).accepted).toBe(true);
    await proposals.submit("proposition", {
      proposalId: "unknown-nested-proposition",
      payload: {
        id: "cao-expects-news",
        subjectEntityId: "cao-cao",
        relationId: "expects",
        object: { kind: "proposition", propositionId: "missing-news" },
        polarity: "positive",
        modality: "possible",
        evidence: evidence("曹操"),
      },
      generatedBy: { worker: "test" },
    });

    const validation = await commits.accept("proposition", "unknown-nested-proposition");
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: "UNKNOWN_NESTED_PROPOSITION" }));
    await expect(proposals.submit("proposition", {
      proposalId: "meta-proposition",
      payload: {
        id: "cao-knows",
        subjectEntityId: "cao-cao",
        relationId: "knows",
        object: { kind: "literal", value: "secret" },
        polarity: "positive",
        modality: "asserted",
        evidence: evidence("曹操"),
      },
      generatedBy: { worker: "test" },
    })).rejects.toThrow("Attribution");
  });

  it("rejects attribution holder/type mismatches and cross-proposition source chains", async () => {
    const { proposals, commits, evidence } = await fixture();
    for (const [proposalId, id, kind, canonicalName, quote] of [
      ["entity-cao", "cao-cao", "character", "曹操", "曹操"],
      ["entity-gate", "north-gate", "location", "北门", "北门"],
    ] as const) {
      await proposals.submit("entity", {
        proposalId,
        payload: { id, kind, canonicalName, aliases: [], evidence: evidence(quote) },
        generatedBy: { worker: "test" },
      });
    }
    for (const [proposalId, id, value] of [
      ["prop-open", "gate-open", true],
      ["prop-closed", "gate-closed", false],
    ] as const) {
      await proposals.submit("proposition", {
        proposalId,
        payload: {
          id,
          subjectEntityId: "north-gate",
          relationId: "open",
          object: { kind: "literal", value },
          polarity: "positive",
          modality: "asserted",
          evidence: evidence("北门"),
        },
        generatedBy: { worker: "test" },
      });
    }
    expect((await commits.acceptAllValid()).blocked).toEqual([]);
    await proposals.submit("attribution", {
      proposalId: "bad-character-holder",
      payload: {
        id: "bad-character-holder",
        propositionId: "gate-open",
        holderKind: "character",
        holderEntityId: "north-gate",
        attitude: "believes",
        certainty: 0.5,
        evidence: evidence("北门"),
      },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("attribution", "bad-character-holder")).errors)
      .toContainEqual(expect.objectContaining({ code: "INVALID_ATTRIBUTION_HOLDER" }));
    await proposals.submit("attribution", {
      proposalId: "source-attribution",
      payload: {
        id: "source-attribution",
        propositionId: "gate-open",
        holderKind: "character",
        holderEntityId: "cao-cao",
        attitude: "asserts",
        certainty: 1,
        evidence: evidence("曹操，字孟德\n北门"),
      },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("attribution", "source-attribution")).accepted).toBe(true);
    await proposals.submit("attribution", {
      proposalId: "mismatched-chain",
      payload: {
        id: "mismatched-chain",
        propositionId: "gate-closed",
        holderKind: "narrator",
        attitude: "reports",
        certainty: 0.8,
        sourceAttributionId: "source-attribution",
        evidence: evidence("曹操，字孟德\n北门"),
      },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("attribution", "mismatched-chain")).errors)
      .toContainEqual(expect.objectContaining({ code: "ATTRIBUTION_CHAIN_MISMATCH" }));
  });

  it("reports proposition and attribution dependency cycles deterministically", async () => {
    const { proposals, commits, evidence } = await fixture();
    await proposals.submit("entity", {
      proposalId: "entity-cao",
      payload: { id: "cao-cao", kind: "character", canonicalName: "曹操", aliases: [], evidence: evidence("曹操") },
      generatedBy: { worker: "test" },
    });
    for (const [proposalId, id, nested] of [
      ["prop-a", "proposition-a", "proposition-b"],
      ["prop-b", "proposition-b", "proposition-a"],
    ] as const) {
      await proposals.submit("proposition", {
        proposalId,
        payload: {
          id,
          subjectEntityId: "cao-cao",
          relationId: "considers",
          object: { kind: "proposition", propositionId: nested },
          polarity: "positive",
          modality: "possible",
          evidence: evidence("曹操"),
        },
        generatedBy: { worker: "test" },
      });
    }

    const result = await commits.acceptAllValid();
    expect(result.accepted).toEqual([{ id: "entity-cao", kind: "entity" }]);
    expect(result.blocked).toHaveLength(2);
    expect(result.blocked.every((item) => item.errors.some((error) => error.code === "PROPOSITION_DEPENDENCY_CYCLE"))).toBe(true);
  });
});

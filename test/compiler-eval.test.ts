import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compilerGoldSchema, evaluateCompilerAgainstGold } from "../src/eval/compiler-eval.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { readSourceMaterial } from "../src/storage/source-material-store.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { SourceAnnotationStore, type SourceAnnotation } from "../src/compiler/annotations.js";
import { EntityResolutionStore, type IdentityResolution } from "../src/compiler/entity-resolution.js";
import { EventResolutionStore, type EventResolution } from "../src/compiler/event-resolution.js";
import { ActorModelStore } from "../src/world/actors.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("compiler gold evaluation", () => {
  it("computes precision/recall from explicit expected identities and causal edges", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-eval-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] });
    await canon.putEntity({ id: "extra", kind: "character", canonicalName: "Extra", aliases: [], evidence: [] });
    await canon.putEvent({
      id: "event-a",
      title: "A",
      participants: ["hero"],
      storyTime: { kind: "unknown" },
      preconditions: [],
      observedOutcome: { version: 1, operations: [] },
      evidence: [],
      causalParents: [],
      confidence: 1,
    });
    await canon.putEvent({
      id: "event-b",
      title: "B",
      participants: ["hero"],
      storyTime: { kind: "unknown" },
      preconditions: [],
      observedOutcome: { version: 1, operations: [] },
      evidence: [],
      causalParents: ["event-a"],
      confidence: 1,
    });

    const report = await evaluateCompilerAgainstGold(root, {
      version: 1,
      name: "tiny-gold",
      expectedEntityIds: ["hero", "missing"],
      expectedEventIds: ["event-a", "event-b"],
      expectedCausalEdges: [{ from: "event-a", to: "event-b" }],
    });
    expect(report.entities.precision).toBe(0.5);
    expect(report.entities.recall).toBe(0.5);
    expect(report.entities.missing).toEqual(["missing"]);
    expect(report.entities.unexpected).toEqual(["extra"]);
    expect(report.events.f1).toBe(1);
    expect(report.causalEdges.f1).toBe(1);
    expect(report.goldVersion).toBe(1);
    expect(report.semanticLayers.mentions.status).toBe("not-annotated");
    expect(report.unavailableDimensions).toEqual([]);
  });

  it("evaluates an annotated layered denominator against persisted semantic stores", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-eval-layered-"));
    roots.push(root);
    const report = await evaluateCompilerAgainstGold(root, {
      version: 2,
      name: "layered-gold",
      canonical: { expectedEntityIds: ["hero"], expectedEventIds: ["arrival"] },
      semantic: {
        mentions: [
          { id: "mention-hero", kind: "entity", span: { sourceId: "source-a", startByte: 0, endByte: 4 } },
          { id: "mention-arrival", kind: "event", span: { sourceId: "source-a", startByte: 5, endByte: 12 } },
        ],
        entityClusters: [{ id: "entity-hero", mentionIds: ["mention-hero"], canonicalEntityId: "hero" }],
        eventClusters: [{ id: "event-arrival", mentionIds: ["mention-arrival"], canonicalEventId: "arrival" }],
        eventParticipants: [{
          id: "participant-arrival-hero",
          eventClusterId: "event-arrival",
          entityClusterId: "entity-hero",
          role: "agent",
        }],
      },
    });

    expect(report.goldVersion).toBe(2);
    expect(report.entities.recall).toBe(0);
    expect(report.semanticLayers.mentions).toMatchObject({
      status: "evaluated",
      expected: 2,
      actual: 0,
      recall: 0,
    });
    expect(report.semanticLayers.entityResolution.status).toBe("evaluated");
    expect(report.semanticLayers.eventRelations.status).toBe("not-annotated");
    expect(report.unavailableDimensions).toEqual([]);
  });

  it("matches mentions, resolutions, discourse, event semantics, knowledge, effects, and character evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-eval-semantic-complete-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(
      root,
      "Hero tells Friend to run. Friend leaves for Road.\n",
    );
    const bytes = await readSourceMaterial(root, fixture.source);
    const anchor = (quote: string, occurrence = 0) => {
      const needle = Buffer.from(quote);
      let startByte = -1;
      let cursor = 0;
      for (let index = 0; index <= occurrence; index += 1) {
        startByte = bytes.indexOf(needle, cursor);
        cursor = startByte + needle.length;
      }
      return textAnchorForByteRange(fixture.source.id, bytes, startByte, startByte + needle.length);
    };
    const span = (quote: string, occurrence = 0) => {
      const selected = anchor(quote, occurrence);
      return { sourceId: selected.sourceId, startByte: selected.startByte, endByte: selected.endByte };
    };
    const derivation = {
      runId: "eval-run",
      worker: "test",
      ontologyVersion: "observation-v1" as const,
    };
    const annotations: SourceAnnotation[] = [
      {
        version: 1, annotationType: "entity-mention", id: "mention-hero", sourceId: fixture.source.id,
        anchor: anchor("Hero"), surface: "Hero", form: "proper", kindCandidates: ["character"],
        confidence: 1, derivation,
      },
      {
        version: 1, annotationType: "entity-mention", id: "mention-friend", sourceId: fixture.source.id,
        anchor: anchor("Friend"), surface: "Friend", form: "proper", kindCandidates: ["character"],
        confidence: 1, derivation,
      },
      {
        version: 1, annotationType: "event-mention", id: "mention-tell", sourceId: fixture.source.id,
        triggerAnchor: anchor("tells"), trigger: "tells", extentAnchors: [anchor("Hero tells Friend to run.")],
        eventTypeCandidates: ["communication"], participantMentionIds: ["mention-hero", "mention-friend"],
        salience: "major", confidence: 1, derivation,
      },
      {
        version: 1, annotationType: "event-mention", id: "mention-leave", sourceId: fixture.source.id,
        triggerAnchor: anchor("leaves"), trigger: "leaves", extentAnchors: [anchor("Friend leaves for Road.")],
        eventTypeCandidates: ["movement"], participantMentionIds: ["mention-friend"],
        salience: "major", confidence: 1, derivation,
      },
      {
        version: 1, annotationType: "quotation", id: "quote-run", sourceId: fixture.source.id,
        anchor: anchor("to run"), mode: "indirect", speakerMentionId: "mention-hero",
        addresseeMentionIds: ["mention-friend"], attributionConfidence: 1,
        interpretation: "Hero tells Friend to run.", derivation,
      },
    ];
    await new SourceAnnotationStore(root).replaceCurrent(fixture.source.id, annotations);
    const resolutionDerivation = {
      runId: "eval-run",
      worker: "test",
      ontologyVersion: "entity-resolution-v1" as const,
    };
    const identity = (id: string, mentionId: string, entityId: string): IdentityResolution => ({
      version: 1,
      id,
      sourceId: fixture.source.id,
      mentionId,
      status: "resolved",
      entityId,
      candidates: [{
        entityId,
        confidence: 1,
        basisMentionIds: [mentionId],
        evidenceAssertionIds: [],
        rationale: "Exact named identity.",
      }],
      rationale: "Exact named identity.",
      derivation: resolutionDerivation,
    });
    await new EntityResolutionStore(root).replaceCurrent(fixture.source.id, [
      identity("resolve-hero", "mention-hero", "hero"),
      identity("resolve-friend", "mention-friend", "friend"),
    ]);
    const eventDerivation = {
      runId: "eval-run",
      worker: "test",
      ontologyVersion: "event-resolution-v1" as const,
    };
    const eventResolution = (id: string, mentionId: string, eventId: string): EventResolution => ({
      version: 1,
      id,
      sourceId: fixture.source.id,
      eventMentionIds: [mentionId],
      status: "resolved",
      canonicalEventId: eventId,
      relation: "coreference",
      candidates: [{
        canonicalEventId: eventId,
        relation: "coreference",
        confidence: 1,
        basisEventMentionIds: [mentionId],
        evidenceAssertionIds: [],
        rationale: "Exact event trigger.",
      }],
      supersedesResolutionIds: [],
      rationale: "Exact event trigger.",
      derivation: eventDerivation,
    });
    await new EventResolutionStore(root).replaceCurrent(fixture.source.id, [
      eventResolution("resolve-tell", "mention-tell", "tell"),
      eventResolution("resolve-leave", "mention-leave", "leave"),
    ]);

    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") });
    await canon.putEntity({ id: "friend", kind: "character", canonicalName: "Friend", aliases: [], evidence: fixture.evidence("Friend") });
    await canon.putEntity({ id: "road", kind: "location", canonicalName: "Road", aliases: [], evidence: fixture.evidence("Road") });
    await canon.putProposition({
      id: "prop-run", subjectEntityId: "friend", relationId: "should-run",
      object: { kind: "literal", value: true }, polarity: "positive", modality: "asserted",
      evidence: fixture.evidence("run"),
    });
    await canon.putAttribution({
      id: "attr-run", propositionId: "prop-run", holderKind: "character", holderEntityId: "hero",
      attitude: "asserts", certainty: 1, quotationIds: ["quote-run"], evidence: fixture.evidence("to run"),
    });
    await canon.putEvent({
      id: "tell", title: "Hero tells Friend to run", participants: ["hero", "friend"],
      storyTime: { kind: "ordinal", label: "first", orderHint: 1 }, preconditions: [],
      observedOutcome: { version: 1, operations: [] },
      observedKnowledge: { version: 1, operations: [{
        op: "learn", actorId: "friend", claimId: "claim-run", propositionId: "prop-run",
        attributionId: "attr-run", acquisitionMode: "told", status: "heard", confidence: 1,
        sourceActorId: "hero",
      }] },
      evidence: fixture.evidence("Hero tells Friend to run."), causalParents: [], confidence: 1,
    });
    await canon.putEvent({
      id: "leave", title: "Friend leaves", participants: ["friend"],
      storyTime: { kind: "ordinal", label: "second", orderHint: 2 }, preconditions: [],
      observedOutcome: { version: 1, operations: [{ op: "set", entityId: "friend", field: "character.location", value: "road" }] },
      evidence: fixture.evidence("Friend leaves for Road."), causalParents: ["tell"], confidence: 1,
    });
    await canon.putEventParticipation({
      id: "leave-friend-agent", eventId: "leave", entityId: "friend", role: "agent",
      confidence: 1, evidence: fixture.evidence("Friend leaves"),
    });
    await canon.putEventRelation({
      id: "tell-causes-leave", fromEventId: "tell", toEventId: "leave", type: "causes",
      status: "explicit", confidence: 1, evidence: fixture.evidence("Hero tells Friend to run. Friend leaves"),
    });
    await new ActorModelStore(root).putGoal({
      id: "goal-leave", actorId: "friend", description: "Friend leaves for Road.", priority: 1,
      requiresKnowledge: [], evidence: fixture.evidence("Friend leaves"),
    });

    const report = await evaluateCompilerAgainstGold(root, {
      version: 2,
      name: "complete-semantic-gold",
      canonical: {
        expectedEntityIds: ["hero", "friend", "road"],
        expectedEventIds: ["tell", "leave"],
        expectedCausalEdges: [{ from: "tell", to: "leave" }],
        expectedGoalIds: ["goal-leave"],
      },
      semantic: {
        mentions: [
          { id: "g-hero", kind: "entity", type: "character", span: span("Hero") },
          { id: "g-friend", kind: "entity", type: "character", span: span("Friend") },
          { id: "g-tell", kind: "event", type: "communication", span: span("tells") },
          { id: "g-leave", kind: "event", type: "movement", span: span("leaves") },
          { id: "g-quote", kind: "quotation", type: "indirect", span: span("to run") },
        ],
        entityClusters: [
          { id: "g-hero-cluster", mentionIds: ["g-hero"], canonicalEntityId: "hero" },
          { id: "g-friend-cluster", mentionIds: ["g-friend"], canonicalEntityId: "friend" },
        ],
        eventClusters: [
          { id: "g-tell-cluster", mentionIds: ["g-tell"], canonicalEventId: "tell" },
          { id: "g-leave-cluster", mentionIds: ["g-leave"], canonicalEventId: "leave" },
        ],
        quotations: [{
          id: "g-quotation", span: span("to run"), speakerEntityClusterId: "g-hero-cluster",
          addresseeEntityClusterIds: ["g-friend-cluster"],
        }],
        eventParticipants: [{
          id: "g-participant", eventClusterId: "g-leave-cluster",
          entityClusterId: "g-friend-cluster", role: "agent",
        }],
        eventRelations: [{
          id: "g-relation", fromEventClusterId: "g-tell-cluster", toEventClusterId: "g-leave-cluster",
          type: "causes", evidenceSpans: [span("Hero tells Friend to run. Friend leaves")],
        }],
        propositions: [{
          id: "g-prop", subjectEntityClusterId: "g-friend-cluster", predicate: "should-run",
          polarity: "positive", modality: "asserted", holderEntityClusterId: "g-hero-cluster",
          evidenceSpans: [span("run")],
        }],
        knowledge: [{
          id: "g-knowledge", actorEntityClusterId: "g-friend-cluster", propositionId: "g-prop",
          status: "heard", acquisition: "told",
        }],
        stateEffects: [{
          id: "g-effect", eventClusterId: "g-leave-cluster", op: "set",
          entityClusterId: "g-friend-cluster", field: "character.location",
        }],
        characterAssertions: [{
          id: "g-goal", actorEntityClusterId: "g-friend-cluster", kind: "goal",
          evidenceSpans: [span("Friend leaves")],
        }],
      },
    });

    for (const metric of Object.values(report.semanticLayers)) {
      expect(metric.status).toBe("evaluated");
      expect(metric.precision).toBe(1);
      expect(metric.recall).toBe(1);
    }
    expect(report.unavailableDimensions).toEqual([]);
    expect(report.macroF1).toBe(1);
  });

  it("rejects layered gold with dangling semantic references", () => {
    expect(() => compilerGoldSchema.parse({
      version: 2,
      name: "invalid-layered-gold",
      semantic: {
        entityClusters: [{ id: "hero", mentionIds: ["missing-mention"] }],
      },
    })).toThrow(/Unknown mention 'missing-mention'/);
  });
});

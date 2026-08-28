import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SourceAnnotationStore, SOURCE_ANNOTATION_ONTOLOGY_VERSION } from "../src/compiler/annotations.js";
import {
  ENTITY_RESOLUTION_ONTOLOGY_VERSION,
  EntityResolutionStore,
} from "../src/compiler/entity-resolution.js";
import {
  EVENT_RESOLUTION_ONTOLOGY_VERSION,
  EventResolutionStore,
} from "../src/compiler/event-resolution.js";
import {
  backfillLegacyProposalRejectionDiagnostics,
  recoverLegacyCompilerState,
} from "../src/compiler/legacy-recovery.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { CanonicalModelStore, ProposalStore } from "../src/world/canonical-model.js";
import { canonicalEventSchema } from "../src/world/model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("legacy compiler recovery", () => {
  it("backfills an honest current re-evaluation without inventing a historical reason", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-legacy-diagnostics-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero waits.\n");
    const proposals = new CompilerProposalService(root);
    await proposals.submit("entity", {
      proposalId: "legacy-valid-entity",
      payload: {
        id: "hero",
        kind: "character",
        canonicalName: "Hero",
        aliases: [],
        evidence: fixture.evidence("Hero"),
      },
      generatedBy: { worker: "old-compiler" },
    });
    const store = new ProposalStore(root);
    await store.transition("legacy-valid-entity", "pending", "rejected");

    expect(await backfillLegacyProposalRejectionDiagnostics(root, fixture.source.id)).toBe(1);
    await expect(store.readRejection("legacy-valid-entity")).resolves.toMatchObject({
      errors: [
        expect.objectContaining({ code: "LEGACY_REJECTION_DIAGNOSTIC_UNAVAILABLE" }),
        expect.objectContaining({ code: "LEGACY_CURRENTLY_VALID_IN_ISOLATION" }),
      ],
    });
    expect(await backfillLegacyProposalRejectionDiagnostics(root, fixture.source.id)).toBe(0);
  });

  it("recovers quotation-traced system and misclassified narrator attributions as new revisions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-legacy-system-attribution-"));
    roots.push(root);
    const content = "NORMA reports: Gate open.\nHero thinks: Stay quiet.\n";
    const fixture = await createEvidenceFixture(root, content);
    const bytes = Buffer.from(content, "utf8");
    const anchor = (quote: string) => {
      const startByte = bytes.indexOf(Buffer.from(quote, "utf8"));
      return textAnchorForByteRange(fixture.source.id, bytes, startByte, startByte + Buffer.byteLength(quote));
    };
    const derivation = {
      runId: "legacy-system-batch",
      worker: "old-compiler",
      ontologyVersion: SOURCE_ANNOTATION_ONTOLOGY_VERSION,
    } as const;
    const annotations = new SourceAnnotationStore(root);
    await annotations.stage(fixture.source.id, {
      version: 1,
      id: "proposal-mention-norma",
      annotationType: "entity-mention",
      payload: {
        version: 1,
        id: "mention-norma",
        sourceId: fixture.source.id,
        annotationType: "entity-mention",
        anchor: anchor("NORMA"),
        surface: "NORMA",
        form: "proper",
        kindCandidates: ["other"],
        confidence: 1,
        derivation,
      },
      generatedBy: { worker: "old-compiler" },
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    await annotations.stage(fixture.source.id, {
      version: 1,
      id: "proposal-quotation-norma",
      annotationType: "quotation",
      payload: {
        version: 1,
        id: "quotation-norma",
        sourceId: fixture.source.id,
        annotationType: "quotation",
        anchor: anchor("NORMA reports: Gate open."),
        mode: "direct",
        speakerMentionId: "mention-norma",
        addresseeMentionIds: [],
        attributionConfidence: 1,
        derivation,
      },
      generatedBy: { worker: "old-compiler" },
      createdAt: "2025-01-01T00:00:01.000Z",
    });
    await annotations.stage(fixture.source.id, {
      version: 1,
      id: "proposal-mention-hero",
      annotationType: "entity-mention",
      payload: {
        version: 1,
        id: "mention-hero",
        sourceId: fixture.source.id,
        annotationType: "entity-mention",
        anchor: anchor("Hero"),
        surface: "Hero",
        form: "proper",
        kindCandidates: ["character"],
        confidence: 1,
        derivation,
      },
      generatedBy: { worker: "old-compiler" },
      createdAt: "2025-01-01T00:00:02.000Z",
    });
    await annotations.stage(fixture.source.id, {
      version: 1,
      id: "proposal-quotation-hero",
      annotationType: "quotation",
      payload: {
        version: 1,
        id: "quotation-hero",
        sourceId: fixture.source.id,
        annotationType: "quotation",
        anchor: anchor("Hero thinks: Stay quiet."),
        mode: "indirect",
        speakerMentionId: "mention-hero",
        addresseeMentionIds: [],
        attributionConfidence: 1,
        interpretation: "Hero wants to stay quiet.",
        derivation,
      },
      generatedBy: { worker: "old-compiler" },
      createdAt: "2025-01-01T00:00:03.000Z",
    });
    await annotations.commitProposals(fixture.source.id, [
      "proposal-mention-norma",
      "proposal-quotation-norma",
      "proposal-mention-hero",
      "proposal-quotation-hero",
    ]);

    const canon = new CanonicalModelStore(root);
    await canon.putEntity({
      id: "norma",
      kind: "other",
      canonicalName: "NORMA",
      aliases: [],
      evidence: fixture.evidence("NORMA"),
    });
    await canon.putEntity({
      id: "gate",
      kind: "location",
      canonicalName: "Gate",
      aliases: [],
      evidence: fixture.evidence("Gate"),
    });
    await canon.putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: fixture.evidence("Hero"),
    });
    await canon.putProposition({
      id: "gate-open",
      subjectEntityId: "gate",
      relationId: "open",
      object: { kind: "literal", value: true },
      polarity: "positive",
      modality: "asserted",
      evidence: fixture.evidence("Gate open"),
    });
    await canon.putProposition({
      id: "hero-stays-quiet",
      subjectEntityId: "hero",
      relationId: "plans",
      object: { kind: "literal", value: "stay quiet" },
      polarity: "positive",
      modality: "asserted",
      evidence: fixture.evidence("Stay quiet"),
    });
    const identities = new EntityResolutionStore(root);
    await identities.stage(fixture.source.id, {
      version: 1,
      id: "proposal-resolve-norma",
      payload: {
        version: 1,
        id: "resolve-norma",
        sourceId: fixture.source.id,
        mentionId: "mention-norma",
        status: "resolved",
        entityId: "norma",
        candidates: [{
          entityId: "norma",
          confidence: 1,
          basisMentionIds: ["mention-norma"],
          evidenceAssertionIds: [],
          rationale: "The quotation explicitly identifies NORMA as its source.",
        }],
        aliasType: "name",
        rationale: "The proper-name mention resolves to the modeled system entity.",
        derivation: {
          runId: "legacy-system-batch",
          worker: "old-compiler",
          ontologyVersion: ENTITY_RESOLUTION_ONTOLOGY_VERSION,
        },
      },
      generatedBy: { worker: "old-compiler" },
      createdAt: "2025-01-01T00:00:04.000Z",
    });
    await identities.stage(fixture.source.id, {
      version: 1,
      id: "proposal-resolve-hero",
      payload: {
        version: 1,
        id: "resolve-hero",
        sourceId: fixture.source.id,
        mentionId: "mention-hero",
        status: "resolved",
        entityId: "hero",
        candidates: [{
          entityId: "hero",
          confidence: 1,
          basisMentionIds: ["mention-hero"],
          evidenceAssertionIds: [],
          rationale: "The internal discourse explicitly names Hero.",
        }],
        aliasType: "name",
        rationale: "The proper-name mention resolves to Hero.",
        derivation: {
          runId: "legacy-system-batch",
          worker: "old-compiler",
          ontologyVersion: ENTITY_RESOLUTION_ONTOLOGY_VERSION,
        },
      },
      generatedBy: { worker: "old-compiler" },
      createdAt: "2025-01-01T00:00:05.000Z",
    });
    await identities.commitProposals(fixture.source.id, [
      "proposal-resolve-norma",
      "proposal-resolve-hero",
    ]);

    const proposals = new CompilerProposalService(root);
    await proposals.submit("attribution", {
      proposalId: "legacy-norma-attribution",
      payload: {
        id: "norma-reports-gate-open",
        propositionId: "gate-open",
        holderKind: "character",
        holderEntityId: "norma",
        attitude: "reports",
        certainty: 1,
        quotationIds: ["quotation-norma"],
        evidence: fixture.evidence("NORMA reports: Gate open."),
      },
      generatedBy: { worker: "old-compiler" },
    });
    await proposals.submit("attribution", {
      proposalId: "legacy-narrator-attribution",
      payload: {
        id: "hero-believes-quiet",
        propositionId: "hero-stays-quiet",
        holderKind: "narrator",
        attitude: "believes",
        certainty: 1,
        quotationIds: ["quotation-hero"],
        evidence: fixture.evidence("Hero thinks: Stay quiet."),
      },
      generatedBy: { worker: "old-compiler" },
    });
    const proposalStore = new ProposalStore(root);
    await proposalStore.transition("legacy-norma-attribution", "pending", "rejected");
    await proposalStore.transition("legacy-narrator-attribution", "pending", "rejected");

    const dryRun = await recoverLegacyCompilerState(root, fixture.source.id, {
      includeGraphArtifacts: false,
    });
    expect(dryRun.plan.artifacts).toHaveLength(2);
    expect(dryRun.plan.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceProposalId: "legacy-norma-attribution",
        kind: "attribution",
        transformations: [expect.stringContaining("from character to system")],
      }),
      expect.objectContaining({
        sourceProposalId: "legacy-narrator-attribution",
        kind: "attribution",
        transformations: [expect.stringContaining("quotation-resolved character hero")],
      }),
    ]));

    const applied = await recoverLegacyCompilerState(root, fixture.source.id, {
      apply: true,
      includeGraphArtifacts: false,
    });
    expect(applied.blocked).toEqual([]);
    expect(applied.accepted).toHaveLength(2);
    await expect(canon.getAttribution("norma-reports-gate-open")).resolves.toMatchObject({
      holderKind: "system",
      holderEntityId: "norma",
    });
    await expect(canon.getAttribution("hero-believes-quiet")).resolves.toMatchObject({
      holderKind: "character",
      holderEntityId: "hero",
    });
  });

  it("recovers a dangling resolved event as a new revision and preserves an unbound mention as unresolved", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-legacy-event-recovery-"));
    roots.push(root);
    const content = "Hero arrives at the gate.\nWatcher waits.\n";
    const fixture = await createEvidenceFixture(root, content);
    const bytes = Buffer.from(content, "utf8");
    const anchor = (quote: string) => {
      const startByte = bytes.indexOf(Buffer.from(quote, "utf8"));
      return textAnchorForByteRange(fixture.source.id, bytes, startByte, startByte + Buffer.byteLength(quote));
    };
    const derivation = {
      runId: "legacy-batch",
      worker: "old-compiler",
      ontologyVersion: SOURCE_ANNOTATION_ONTOLOGY_VERSION,
    } as const;
    const annotations = new SourceAnnotationStore(root);
    await annotations.stage(fixture.source.id, {
      version: 1,
      id: "proposal-mention-hero",
      annotationType: "entity-mention",
      payload: {
        version: 1,
        id: "mention-hero",
        sourceId: fixture.source.id,
        annotationType: "entity-mention",
        anchor: anchor("Hero"),
        surface: "Hero",
        form: "proper",
        kindCandidates: ["character"],
        confidence: 1,
        derivation,
      },
      generatedBy: { worker: "old-compiler" },
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    await annotations.stage(fixture.source.id, {
      version: 1,
      id: "proposal-mention-watcher",
      annotationType: "entity-mention",
      payload: {
        version: 1,
        id: "mention-watcher",
        sourceId: fixture.source.id,
        annotationType: "entity-mention",
        anchor: anchor("Watcher"),
        surface: "Watcher",
        form: "nominal",
        kindCandidates: ["character"],
        confidence: 0.5,
        derivation,
      },
      generatedBy: { worker: "old-compiler" },
      createdAt: "2025-01-01T00:00:01.000Z",
    });
    await annotations.stage(fixture.source.id, {
      version: 1,
      id: "proposal-mention-arrival",
      annotationType: "event-mention",
      payload: {
        version: 1,
        id: "mention-arrival",
        sourceId: fixture.source.id,
        annotationType: "event-mention",
        triggerAnchor: anchor("arrives"),
        trigger: "arrives",
        extentAnchors: [anchor("Hero arrives at the gate.")],
        eventTypeCandidates: ["movement"],
        participantMentionIds: ["mention-hero"],
        salience: "major",
        confidence: 1,
        derivation,
      },
      generatedBy: { worker: "old-compiler" },
      createdAt: "2025-01-01T00:00:02.000Z",
    });
    await annotations.commitProposals(fixture.source.id, [
      "proposal-mention-hero",
      "proposal-mention-watcher",
      "proposal-mention-arrival",
    ]);

    const canon = new CanonicalModelStore(root);
    await canon.putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: fixture.evidence("Hero"),
    });
    await canon.putEntity({
      id: "gate",
      kind: "location",
      canonicalName: "gate",
      aliases: [],
      evidence: fixture.evidence("gate"),
    });

    const identities = new EntityResolutionStore(root);
    await identities.stage(fixture.source.id, {
      version: 1,
      id: "proposal-resolve-hero",
      payload: {
        version: 1,
        id: "resolve-hero",
        sourceId: fixture.source.id,
        mentionId: "mention-hero",
        status: "resolved",
        entityId: "hero",
        candidates: [{
          entityId: "hero",
          confidence: 1,
          basisMentionIds: ["mention-hero"],
          evidenceAssertionIds: [],
          rationale: "The exact proper name identifies Hero.",
        }],
        aliasType: "name",
        rationale: "The source explicitly names Hero.",
        derivation: {
          runId: "legacy-batch",
          worker: "old-compiler",
          ontologyVersion: ENTITY_RESOLUTION_ONTOLOGY_VERSION,
        },
      },
      generatedBy: { worker: "old-compiler" },
      createdAt: "2025-01-01T00:00:03.000Z",
    });
    await identities.commitProposals(fixture.source.id, ["proposal-resolve-hero"]);

    const eventResolutions = new EventResolutionStore(root);
    await eventResolutions.stage(fixture.source.id, {
      version: 1,
      id: "proposal-resolve-arrival",
      payload: {
        version: 1,
        id: "resolve-arrival",
        sourceId: fixture.source.id,
        eventMentionIds: ["mention-arrival"],
        status: "new-event",
        canonicalEventId: "hero-arrives",
        relation: "coreference",
        candidates: [{
          canonicalEventId: "hero-arrives",
          relation: "coreference",
          confidence: 1,
          basisEventMentionIds: ["mention-arrival"],
          evidenceAssertionIds: [],
          rationale: "The mention grounds one new arrival event.",
        }],
        supersedesResolutionIds: [],
        rationale: "The explicit movement mention creates the canonical arrival event.",
        derivation: {
          runId: "legacy-batch",
          worker: "old-compiler",
          ontologyVersion: EVENT_RESOLUTION_ONTOLOGY_VERSION,
        },
      },
      generatedBy: { worker: "old-compiler" },
      createdAt: "2025-01-01T00:00:04.000Z",
    });
    await eventResolutions.commitProposals(fixture.source.id, ["proposal-resolve-arrival"]);

    const proposals = new CompilerProposalService(root);
    await proposals.submit("canonical-event", {
      proposalId: "legacy-arrival-event",
      payload: {
        id: "hero-arrives",
        title: "Hero arrives at the gate",
        participants: ["hero"],
        participantPresence: [{ entityId: "hero", mode: "physical" }],
        characterEntryCheckpoints: [{
          actorId: "hero",
          readerSetup: "Hero is about to arrive.",
          actorObservation: "Hero sees the gate.",
          participantPresence: [{ entityId: "hero", mode: "physical" }],
          delta: { version: 1, operations: [] },
        }],
        storyTime: { kind: "unknown" },
        preconditions: [],
        observedOutcome: {
          version: 1,
          operations: [{ op: "set", entityId: "hero", field: "character.location", value: "gate" }],
        },
        evidence: fixture.evidence("Hero arrives at the gate."),
        causalParents: [],
        confidence: 1,
      },
      generatedBy: { worker: "old-compiler" },
    });
    const proposalStore = new ProposalStore(root);
    await proposalStore.transition("legacy-arrival-event", "pending", "rejected");

    const dryRun = await recoverLegacyCompilerState(root, fixture.source.id, {
      includeGraphArtifacts: false,
    });
    expect(dryRun.plan.missingCanonicalEventIds).toEqual(["hero-arrives"]);
    expect(dryRun.plan.artifacts).toEqual([
      expect.objectContaining({
        sourceProposalId: "legacy-arrival-event",
        kind: "canonical-event",
        transformations: [expect.stringContaining("Removed 1 empty")],
      }),
    ]);
    expect(dryRun.plan.unresolvedMentionIds).toEqual(["mention-watcher"]);
    await expect(canon.getEvent("hero-arrives")).rejects.toThrow();

    const applied = await recoverLegacyCompilerState(root, fixture.source.id, {
      apply: true,
      includeGraphArtifacts: false,
    });
    expect(applied.accepted).toHaveLength(1);
    expect(applied.blocked).toEqual([]);
    await expect(canon.getEvent("hero-arrives")).resolves.toMatchObject({
      id: "hero-arrives",
      characterEntryCheckpoints: [],
    });
    await expect(identities.currentForMention(fixture.source.id, "mention-watcher")).resolves.toMatchObject({
      status: "unresolved",
      candidates: [],
    });
    await expect(proposalStore.readRejection("legacy-arrival-event")).resolves.toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "LEGACY_REJECTION_DIAGNOSTIC_UNAVAILABLE" }),
      ]),
    });
    const acceptedEvent = applied.accepted[0]!;
    await expect(proposalStore.read("accepted", acceptedEvent.id, canonicalEventSchema)).resolves.toMatchObject({
      payload: { id: "hero-arrives", characterEntryCheckpoints: [] },
    });
  });
});

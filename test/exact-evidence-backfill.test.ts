import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backfillLegacyExactEvidence } from "../src/compiler/exact-evidence-backfill.js";
import { SourceAnnotationStore } from "../src/compiler/annotations.js";
import { EntityResolutionStore } from "../src/compiler/entity-resolution.js";
import { EvidenceAssertionStore } from "../src/compiler/evidence-assertions.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { contentHash } from "../src/world/canonical.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import type { EvidenceAssertion } from "../src/world/model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("legacy exact-evidence backfill", () => {
  it("derives only typed projections that already have exact-bound semantic donors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-exact-backfill-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero opens the gate.\n");
    const evidence = fixture.evidence("Hero opens the gate.");
    const span = evidence[0]!.span;
    const sourceBytes = await fs.readFile(path.join(root, fixture.source.sourcePath));
    const anchor = textAnchorForByteRange(fixture.source.id, sourceBytes, span.startByte!, span.endByte!);
    const canon = new CanonicalModelStore(root);
    const proposition = {
      id: "prop-gate-open",
      subjectEntityId: "gate",
      relationId: "is-open",
      object: { kind: "literal" as const, value: true },
      polarity: "positive" as const,
      modality: "asserted" as const,
      evidence,
    };
    const claim = {
      id: "claim-gate-open",
      subject: "gate",
      predicate: "is-open",
      object: true,
      epistemicType: "explicit-fact" as const,
      evidence,
    };
    const unsupported = {
      id: "claim-unsupported",
      subject: "sky",
      predicate: "is-green",
      object: true,
      epistemicType: "inference" as const,
      evidence,
    };
    const event = {
      id: "event-open-gate",
      title: "Hero opens the gate",
      readerSummary: "Hero opens the gate.",
      participants: ["hero", "gate"],
      storyTime: { kind: "unknown" as const },
      preconditions: [],
      observedOutcome: { version: 1 as const, operations: [] },
      evidence,
      causalParents: [],
      confidence: 1,
    };
    const participation = {
      id: "part-open-hero",
      eventId: event.id,
      entityId: "hero",
      role: "agent" as const,
      presence: "physical" as const,
      confidence: 1,
      evidence,
    };
    await canon.putProposition(proposition);
    await canon.putClaim(claim);
    await canon.putClaim(unsupported);
    await canon.putEvent(event);
    await canon.putEventParticipation(participation);
    const assertions = new EvidenceAssertionStore(root);
    const donor = (kind: string, id: string, pointer: string): EvidenceAssertion => ({
      version: 1,
      id: `donor-${id}`,
      target: { artifactKind: kind, artifactId: id, jsonPointer: pointer },
      anchors: [anchor],
      relation: "supports",
      strength: "explicit",
      derivation: { runId: "test", worker: "test", ontologyVersion: "evidence-v1" },
    });
    await assertions.replaceForArtifact("proposition", proposition.id, contentHash(proposition), [
      donor("proposition", proposition.id, "/object/value"),
    ]);
    await assertions.replaceForArtifact("canonical-event", event.id, contentHash(event), [
      donor("canonical-event", event.id, "/readerSummary"),
    ]);

    const result = await backfillLegacyExactEvidence(root, fixture.source.id, "repair-test");

    expect(result.created).toEqual(expect.arrayContaining([
      `claim:${claim.id}`,
      `event-participation:${participation.id}`,
    ]));
    await expect(assertions.listForArtifact("claim", claim.id)).resolves.toEqual([
      expect.objectContaining({ target: expect.objectContaining({ jsonPointer: "/object" }) }),
    ]);
    await expect(assertions.listForArtifact("event-participation", participation.id)).resolves.toEqual([
      expect.objectContaining({ target: expect.objectContaining({ jsonPointer: "/role" }) }),
    ]);
    await expect(assertions.listForArtifact("claim", unsupported.id)).resolves.toEqual([]);
    expect(result.skipped).toContain(`claim:${unsupported.id}`);
  });

  it("uses only explicit knowledge gates or resolved matching quotations as legacy claim donors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-exact-backfill-claim-donors-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(
      root,
      "May reports: Mission complete, Norton dead, Hero survived.\nThe map shows Library to central control room to ice cellar.\n",
    );
    const sourceBytes = await fs.readFile(path.join(root, fixture.source.sourcePath));
    const exactAnchor = (text: string) => {
      const start = sourceBytes.indexOf(Buffer.from(text));
      return textAnchorForByteRange(fixture.source.id, sourceBytes, start, start + Buffer.byteLength(text));
    };
    const quoteText = "Mission complete, Norton dead, Hero survived.";
    const mapText = "Library to central control room to ice cellar";
    const quoteEvidence = fixture.evidence(quoteText);
    const mapEvidence = fixture.evidence(mapText);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({
      id: "may",
      kind: "character",
      canonicalName: "May",
      aliases: [],
      evidence: fixture.evidence("May"),
    });
    const reportClaim = {
      id: "claim-may-report",
      subject: "may",
      predicate: "mission-report",
      object: quoteText,
      epistemicType: "character-claim" as const,
      speaker: "may",
      evidence: quoteEvidence,
    };
    const mapClaim = {
      id: "claim-underground-map",
      subject: "campus",
      predicate: "underground-map",
      object: mapText,
      epistemicType: "narrator-claim" as const,
      evidence: mapEvidence,
    };
    await canon.putClaim(reportClaim);
    await canon.putClaim(mapClaim);
    await canon.putSpatialRelation({
      ontologyVersion: "spatial-v1",
      id: "route-library-cellar",
      kind: "route",
      basis: "explicit",
      visibility: "knowledge",
      knownByClaimIds: [mapClaim.id],
      establishedByEventIds: [],
      retiredByEventIds: [],
      requires: [],
      blockedWhen: [],
      status: "supported",
      confidence: 1,
      evidence: mapEvidence,
      fromLocationId: "library",
      toLocationId: "ice-cellar",
      direction: "one-way",
      modes: ["foot"],
    });
    await new SourceAnnotationStore(root).replaceCurrent(fixture.source.id, [{
      version: 1,
      id: "mention-may",
      sourceId: fixture.source.id,
      annotationType: "entity-mention",
      anchor: exactAnchor("May"),
      surface: "May",
      form: "proper",
      kindCandidates: ["character"],
      confidence: 1,
      derivation: { runId: "test", worker: "test", ontologyVersion: "observation-v1" },
    }, {
      version: 1,
      id: "quotation-may-report",
      sourceId: fixture.source.id,
      annotationType: "quotation",
      anchor: exactAnchor(quoteText),
      mode: "direct",
      speakerMentionId: "mention-may",
      addresseeMentionIds: [],
      attributionConfidence: 1,
      derivation: { runId: "test", worker: "test", ontologyVersion: "observation-v1" },
    }]);
    await new EntityResolutionStore(root).replaceCurrent(fixture.source.id, [{
      version: 1,
      id: "resolution-may",
      sourceId: fixture.source.id,
      mentionId: "mention-may",
      status: "resolved",
      entityId: "may",
      candidates: [{
        entityId: "may",
        confidence: 1,
        basisMentionIds: ["mention-may"],
        evidenceAssertionIds: [],
        rationale: "Exact canonical name.",
      }],
      rationale: "The quotation speaker is May.",
      derivation: { runId: "test", worker: "test", ontologyVersion: "entity-resolution-v1" },
    }]);
    const assertions = new EvidenceAssertionStore(root);
    await assertions.replaceForArtifact("spatial-relation", "route-library-cellar", contentHash(
      (await canon.listSpatialRelations()).find((item) => item.id === "route-library-cellar")!,
    ), [donorAssertion("spatial-relation", "route-library-cellar", "/direction", exactAnchor(mapText))]);

    const result = await backfillLegacyExactEvidence(root, fixture.source.id, "repair-test");

    expect(result.created).toEqual(expect.arrayContaining([
      `claim:${reportClaim.id}`,
      `claim:${mapClaim.id}`,
    ]));
    await expect(assertions.listForArtifact("claim", reportClaim.id)).resolves.toHaveLength(1);
    await expect(assertions.listForArtifact("claim", mapClaim.id)).resolves.toHaveLength(1);
  });
});

function donorAssertion(kind: string, id: string, pointer: string, anchor: ReturnType<typeof textAnchorForByteRange>): EvidenceAssertion {
  return {
    version: 1,
    id: `donor-${id}`,
    target: { artifactKind: kind, artifactId: id, jsonPointer: pointer },
    anchors: [anchor],
    relation: "supports",
    strength: "explicit",
    derivation: { runId: "test", worker: "test", ontologyVersion: "evidence-v1" },
  };
}

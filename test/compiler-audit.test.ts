import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditCompiler } from "../src/compiler/audit.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { SegmentStore, segmentSource } from "../src/compiler/segments.js";
import { resolveTextAnchor } from "../src/compiler/text-anchors.js";
import { ensureSourceStructure } from "../src/compiler/structure.js";
import { CompilerCommitService } from "../src/compiler/validator.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("compiler audit", () => {
  it("reports verified inventory without inventing unknown semantic coverage", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-audit-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "# Chapter 1\nHero appears.\n");
    const workspace = await WorkspaceStore.create(root);
    const source = await workspace.getSource(fixture.source.id);
    const manifest = await segmentSource(root, source!);
    await new SegmentStore(root).write(manifest);
    await ensureSourceStructure(root, source!);

    const proposals = new CompilerProposalService(root);
    const commits = new CompilerCommitService(root);
    await proposals.submit("entity", {
      proposalId: "hero",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero appears.") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "hero")).accepted).toBe(true);

    const report = await auditCompiler(root);
    expect(report.sources.registered).toBe(1);
    expect(report.sources.segmented).toBe(1);
    expect(report.canonical.entities).toBe(1);
    expect(report.evidence.invalidReferences).toBe(0);
    expect(report.evidence.validBindingRatio).toBe(1);
    expect(report.coverage.entityResolution).toBeNull();
    expect(report.coverage.majorEventResolution).toBeNull();
    expect(report.coverage.epistemicCoverage).toBeNull();
    expect(report.readiness).toMatchObject({
      policyVersion: "baseline-v1",
      structural: "ready",
      evidence: "unknown",
      accounting: "unknown",
      resolution: "unknown",
      semantic: "unknown",
      runtime: "not-ready",
      publication: "not-ready",
    });
    expect(report.readiness.unknownDimensions).toEqual(expect.arrayContaining([
      "accounting",
      "evidence",
      "resolution",
      "semantic",
    ]));
  });

  it("reports evidence readiness only when canonical artifacts have valid exact bindings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-audit-exact-evidence-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero appears.\n");
    const segment = (await new SegmentStore(root).list(fixture.source.id))[0]!;
    const payload = {
      id: "hero",
      kind: "character" as const,
      canonicalName: "Hero",
      aliases: [],
      evidence: fixture.evidence("Hero appears."),
    };
    const anchor = await resolveTextAnchor(root, segment, {
      segment_id: segment.id,
      exact: "Hero",
      target_path: "/canonicalName",
      relation: "supports",
      strength: "explicit",
    });
    const proposals = new CompilerProposalService(root);
    await proposals.submit("entity", {
      proposalId: "hero-exact",
      payload,
      evidenceAssertions: [{
        version: 1,
        id: "evidence-hero-name",
        target: { artifactKind: "entity", artifactId: "hero", jsonPointer: "/canonicalName" },
        anchors: [anchor],
        relation: "supports",
        strength: "explicit",
        derivation: { runId: "audit-test", worker: "test", ontologyVersion: "evidence-v1" },
      }],
      generatedBy: { worker: "test" },
    });
    expect((await new CompilerCommitService(root).accept("entity", "hero-exact")).accepted).toBe(true);

    const report = await auditCompiler(root, { sourceId: fixture.source.id });
    expect(report.evidence).toMatchObject({
      assertionsChecked: 1,
      artifactsWithExactEvidence: 1,
      invalidAssertions: 0,
      exactBindingRatio: 1,
    });
    expect(report.readiness.evidence).toBe("ready");
  });

  it("accounts for proposition attribution and semantic knowledge provenance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-audit-epistemic-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero reports that the Gate is open.\n");
    const evidence = fixture.evidence("Hero reports that the Gate is open.");
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence });
    await canon.putEntity({ id: "gate", kind: "location", canonicalName: "Gate", aliases: [], evidence });
    await canon.putClaim({
      id: "gate-open-claim",
      subject: "gate",
      predicate: "open",
      object: true,
      epistemicType: "character-claim",
      speaker: "hero",
      evidence,
    });
    await canon.putProposition({
      id: "gate-open",
      subjectEntityId: "gate",
      relationId: "open",
      object: { kind: "literal", value: true },
      polarity: "positive",
      modality: "asserted",
      evidence,
    });
    await canon.putAttribution({
      id: "hero-reports-gate-open",
      propositionId: "gate-open",
      holderKind: "character",
      holderEntityId: "hero",
      attitude: "reports",
      certainty: 1,
      evidence,
    });
    await canon.putEvent({
      id: "hero-reports-gate-open",
      title: "Hero reports that the gate is open",
      participants: [],
      storyTime: { kind: "ordinal", label: "report", orderHint: 1 },
      preconditions: [],
      observedOutcome: { version: 1, operations: [] },
      evidence,
      causalParents: [],
      confidence: 1,
    });
    await canon.putEvent({
      id: "hero-infers-gate-open",
      title: "Hero forms a belief about the gate",
      participants: ["hero"],
      participantPresence: [{ entityId: "hero", mode: "physical" }],
      storyTime: { kind: "ordinal", label: "inference", orderHint: 2 },
      preconditions: [],
      observedOutcome: { version: 1, operations: [] },
      observedKnowledge: {
        version: 1,
        operations: [{
          op: "learn",
          actorId: "hero",
          claimId: "gate-open-claim",
          propositionId: "gate-open",
          attributionId: "hero-reports-gate-open",
          acquisitionMode: "inferred",
          status: "believes",
          confidence: 0.8,
        }],
      },
      evidence,
      causalParents: ["hero-reports-gate-open"],
      confidence: 1,
    });
    await canon.putEventParticipation({
      id: "hero-infers-gate-open-hero",
      eventId: "hero-infers-gate-open",
      entityId: "hero",
      role: "experiencer",
      presence: "physical",
      confidence: 1,
      evidence,
    });
    await canon.putEventRelation({
      id: "report-causes-inference",
      fromEventId: "hero-reports-gate-open",
      toEventId: "hero-infers-gate-open",
      type: "causes",
      status: "explicit",
      confidence: 1,
      mechanism: "The report supplies the content from which the belief is formed.",
      evidence,
    });

    const report = await auditCompiler(root, { sourceId: fixture.source.id });
    expect(report.epistemic).toMatchObject({
      propositions: 1,
      attributions: 1,
      quotationLinkedAttributions: 0,
      knowledgeOperations: 1,
      semanticKnowledgeOperations: 1,
      acquisitionModes: { inferred: 1 },
      invalidTraces: 0,
      errors: [],
    });
    expect(report.coverage.epistemicCoverage).toBe(1);
    expect(report.eventSemantics).toMatchObject({
      participations: 1,
      eventsWithTypedParticipation: 1,
      legacyParticipantSlots: 1,
      typedParticipantSlots: 1,
      validationIssues: 0,
      errors: [],
      relations: 1,
      causalRelations: 1,
      legacyCausalEdges: 1,
      typedCausalEdges: 1,
      relationValidationIssues: 0,
      relationErrors: [],
    });
    expect(report.canonical.eventParticipations).toBe(1);
    expect(report.canonical.eventRelations).toBe(1);
    expect(report.coverage.typedEventParticipation).toBe(1);
    expect(report.coverage.typedCausalRelations).toBe(1);
  });

  it("can audit one source without inheriting another source's changed file or artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-audit-source-"));
    roots.push(root);
    const selected = await createEvidenceFixture(root, "Selected hero appears.\n", "selected.txt");
    const foreign = await createEvidenceFixture(root, "Foreign hero appears.\n", "foreign.txt");
    const proposals = new CompilerProposalService(root);
    const commits = new CompilerCommitService(root);
    await proposals.submit("entity", {
      proposalId: "selected-hero",
      payload: { id: "selected-hero", kind: "character", canonicalName: "Selected Hero", aliases: [], evidence: selected.evidence("Selected hero appears.") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("entity", {
      proposalId: "foreign-hero",
      payload: { id: "foreign-hero", kind: "character", canonicalName: "Foreign Hero", aliases: [], evidence: foreign.evidence("Foreign hero appears.") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "selected-hero")).accepted).toBe(true);
    expect((await commits.accept("entity", "foreign-hero")).accepted).toBe(true);
    await fs.writeFile(path.join(root, foreign.source.sourcePath), "Foreign source changed.\n", "utf8");

    const report = await auditCompiler(root, { sourceId: selected.source.id });
    expect(report.sources).toMatchObject({ registered: 1, changedSinceIngest: [] });
    expect(report.canonical.entities).toBe(1);
    expect(report.evidence.invalidReferences).toBe(0);
    expect(report.notes[0]).toContain(`scoped to source ${selected.source.id}`);
  });

  it("flags a large canon compiled as disconnected unconditional roots instead of treating every episode as immediately reachable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-audit-graph-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero crosses ten successive story beats.\n");
    const proposals = new CompilerProposalService(root);
    const commits = new CompilerCommitService(root);
    await proposals.submit("entity", {
      proposalId: "graph-hero",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "graph-hero")).accepted).toBe(true);

    for (let index = 1; index <= 10; index += 1) {
      const proposalId = `root-event-${index}`;
      await proposals.submit("canonical-event", {
        proposalId,
        payload: {
          id: `event-${index}`,
          title: `Independent story beat ${index}`,
          participants: ["hero"],
          participantPresence: [{ entityId: "hero", mode: "physical" }],
          storyTime: { kind: "ordinal", label: `beat-${index}`, orderHint: index },
          preconditions: [],
          observedOutcome: { version: 1, operations: [] },
          evidence: fixture.evidence("Hero crosses ten successive story beats."),
          causalParents: [],
          confidence: 1,
        },
        generatedBy: { worker: "test" },
      });
      expect((await commits.accept("canonical-event", proposalId)).accepted).toBe(true);
    }

    const report = await auditCompiler(root, { sourceId: fixture.source.id });
    expect(report.consistency.causalGraphValid).toBe(true);
    expect(report.consistency.narrativeGraphNavigable).toBe(false);
    expect(report.consistency.unconditionalRootEvents).toHaveLength(10);
    expect(report.consistency.causalComponents).toBe(10);
    expect(report.coverage.causalityConsistency).toBe(0);
    expect(report.notes).toContainEqual(expect.stringContaining("dominated by unconditional disconnected roots"));
  });

  it("blocks novel-scale output that has plot records but no executable effects or character growth", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-audit-semantics-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero lives through a long sequence.\n");
    const evidence = fixture.evidence("Hero lives through a long sequence.");
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence });
    for (let index = 1; index <= 20; index += 1) {
      await canon.putEvent({
        id: `semantic-event-${index}`,
        title: `Story record ${index}`,
        participants: ["hero"],
        storyTime: { kind: "ordinal", label: `beat-${index}`, orderHint: index },
        preconditions: [],
        observedOutcome: { version: 1, operations: [] },
        evidence,
        causalParents: index === 1 ? [] : [`semantic-event-${index - 1}`],
        confidence: 1,
      });
    }

    const report = await auditCompiler(root, { sourceId: fixture.source.id });
    expect(report.consistency.semanticReady).toBe(false);
    expect(report.coverage).toMatchObject({
      timelineAnchoring: 1,
      eventEffectExplicitness: 0,
      characterDevelopmentCoverage: 0,
      participantPresenceCoverage: 0,
      readerSummaryCoverage: 0,
      autonomousDriverCoverage: 0,
    });
    expect(report.consistency.semanticIssues).toEqual(expect.arrayContaining([
      expect.stringContaining("typed state or knowledge effect"),
      expect.stringContaining("phase-bounded goals or development phases"),
      expect.stringContaining("participant slots declare"),
      expect.stringContaining("source-grounded reader recap"),
      expect.stringContaining("no executable actor goal or non-canonical autonomous possibility"),
    ]));
    expect(report.readiness.semantic).toBe("not-ready");
    expect(report.readiness.publication).toBe("not-ready");
    expect(report.readiness.blockingIssues).toEqual(expect.arrayContaining([
      expect.stringContaining("typed state or knowledge effect"),
    ]));
  });
});

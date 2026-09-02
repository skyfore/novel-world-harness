import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMPILER_PIPELINE_VERSION, CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { invalidatePreparationArtifacts, parseOrdinalSelection, reparseCommand } from "../src/commands/reparse.js";
import { ActorModelStore } from "../src/world/actors.js";
import { CanonicalModelStore, ProposalStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { inspectPreparation } from "../src/workflow/prepare.js";
import { canonicalJson, contentHash } from "../src/world/canonical.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { SourceAnnotationStore, annotationAnchors } from "../src/compiler/annotations.js";
import { EntityResolutionStore } from "../src/compiler/entity-resolution.js";
import { SourceAccountingStore } from "../src/compiler/source-accounting.js";
import { ensureSourceStructure } from "../src/compiler/structure.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { EvidenceAssertionStore } from "../src/compiler/evidence-assertions.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("explicit prepared-novel reparsing", () => {
  it("reparses selected detected chapters into a new revision while old branches stay pinned", async () => {
    const root = await temporaryRoot("nwh-reparse-");
    const cacheRoot = await temporaryRoot("nwh-reparse-cache-");
    const fixture = await createEvidenceFixture(root, "# One\nHero waits.\n# Two\nVillain waits.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    expect(batches.map((batch) => batch.chapterOrdinal)).toEqual([1, 2, 1, 2, 1, 2]);
    const chapterOneBatches = batches.filter((batch) => batch.chapterOrdinal === 1);
    const chapterTwoBatches = batches.filter((batch) => batch.chapterOrdinal === 2);
    const chapterOneSemantic = chapterOneBatches.find((batch) => batch.semanticStage === "semantic")!;
    const chapterTwoSemantic = chapterTwoBatches.find((batch) => batch.semanticStage === "semantic")!;
    const chapterTwoExecutable = chapterTwoBatches.find((batch) => batch.semanticStage === "executable")!;
    const proposals = new CompilerProposalService(root);
    await proposals.submit("entity", {
      proposalId: "hero-v1",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: chapterOneSemantic.evidence },
      generatedBy: { worker: "test", compilerBatchId: chapterOneSemantic.id },
    });
    await proposals.submit("entity", {
      proposalId: "villain-v1",
      payload: { id: "villain", kind: "character", canonicalName: "Villain", aliases: [], evidence: chapterTwoSemantic.evidence },
      generatedBy: { worker: "test", compilerBatchId: chapterTwoSemantic.id },
    });
    await proposals.submit("character-goal", {
      proposalId: "villain-goal-v1",
      payload: { id: "villain-goal", actorId: "villain", description: "Wait", priority: 0.5, requiresKnowledge: [], evidence: chapterTwoExecutable.evidence },
      generatedBy: { worker: "test", compilerBatchId: chapterTwoExecutable.id },
    });
    await proposals.submit("initial-world", {
      proposalId: "opening-v1",
      payload: {
        version: 1,
        participantPresence: [{ entityId: "hero", mode: "physical" }],
        delta: {
          version: 1,
          operations: [
            { op: "set", entityId: "hero", field: "character.alive", value: true },
            { op: "set", entityId: "hero", field: "character.plan", value: "wait" },
          ],
        },
        evidence: chapterOneSemantic.evidence,
      },
      generatedBy: { worker: "test", compilerBatchId: `opening-${chapterOneSemantic.id}` },
    });
    await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));
    await convergeWorldProposals(root, fixture.source.id);
    const cache = new PreparedNovelCache(root, cacheRoot);
    const first = await cache.publish(fixture.source);
    const initial = await new InitialWorldStore(root).get();
    if (!initial) throw new Error("missing test initial world");
    const before = await openWorkspaceWorld(root);
    const oldHead = await before.engine.createBranch("old", "old", initial.delta, initial.knowledge);
    await fs.rm(path.join(root, fixture.source.sourcePath));
    await new CanonicalModelStore(root).removeCurrent("entities", "villain");
    await new ActorModelStore(root).removeGoal("villain-goal");
    await new CompilerBatchStore(root).markIncomplete(fixture.source.id, chapterTwoBatches.map((batch) => batch.id));
    const progressMessages: string[] = [];

    const result = await reparseCommand({
      root,
      configPath: path.join(root, "missing.yaml"),
      sourceId: fixture.source.id,
      chapters: "2",
      cacheRoot,
      onProgress: (message) => progressMessages.push(message),
    }, {
      async compileSource(options) {
        expect(options.batchIds).toEqual(chapterTwoBatches.map((batch) => batch.id));
        expect(options.promptTransform?.("evidence", chapterTwoSemantic)).toContain("detected chapter 2");
        await proposals.submit("entity", {
          proposalId: "villain-v2-reparse-test",
          payload: { id: "villain", kind: "character", canonicalName: "Villain", aliases: ["Villain"], evidence: chapterTwoSemantic.evidence },
          generatedBy: { worker: "test", compilerBatchId: chapterTwoSemantic.id },
        });
        await proposals.submit("character-goal", {
          proposalId: "villain-goal-v2-reparse-test",
          payload: { id: "villain-goal", actorId: "villain", description: "Act", priority: 0.8, requiresKnowledge: [], evidence: chapterTwoExecutable.evidence },
          generatedBy: { worker: "test", compilerBatchId: chapterTwoExecutable.id },
        });
        for (const batch of chapterTwoBatches) await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);
      },
    });

    expect(result.chapters).toEqual([2]);
    expect(progressMessages).toContainEqual(expect.stringContaining("Detected an interrupted reparse"));
    expect(progressMessages).toContainEqual(expect.stringContaining("baseline restored"));
    expect(result.previousBundleHash).toBe(first.bundleHash);
    expect(result.activeBundleHash).not.toBe(first.bundleHash);
    await expect(new CanonicalModelStore(root).getEntity("hero")).resolves.toMatchObject({ aliases: [] });
    await expect(new CanonicalModelStore(root).getEntity("villain")).resolves.toMatchObject({ aliases: ["Villain"] });
    await expect(new ActorModelStore(root).listGoals("villain")).resolves.toEqual([expect.objectContaining({ description: "Act" })]);

    const reopened = await openWorkspaceWorld(root);
    const oldContext = await reopened.engine.contextForCommit(oldHead);
    expect(oldContext.entities.get("villain")?.aliases).toEqual([]);
    expect(oldContext.actorGoals?.find((goal) => goal.id === "villain-goal")?.description).toBe("Wait");
    const newHead = await reopened.engine.createBranch("new", "new", initial.delta, initial.knowledge);
    const newContext = await reopened.engine.contextForCommit(newHead);
    expect(newContext.entities.get("villain")?.aliases).toEqual(["Villain"]);
    expect(newContext.actorGoals?.find((goal) => goal.id === "villain-goal")?.description).toBe("Act");

    await cache.activate(fixture.source, first.bundleHash!);
    await expect(new CanonicalModelStore(root).getEntity("villain")).resolves.toMatchObject({ aliases: [] });
    await expect(new ActorModelStore(root).listGoals("villain")).resolves.toEqual([expect.objectContaining({ description: "Wait" })]);

    await new CompilerBatchStore(root).markIncomplete(fixture.source.id, [chapterOneBatches[0]!.id]);
    await expect(reparseCommand({
      root,
      configPath: path.join(root, "missing.yaml"),
      sourceId: fixture.source.id,
      chapters: "2",
      cacheRoot,
    })).rejects.toThrow("outside the selected scope (chapter(s) 1)");
  });

  it("parses ordinal selections strictly", () => {
    expect(parseOrdinalSelection("1,3-4", [1, 2, 3, 4], "--chapters")).toEqual([1, 3, 4]);
    expect(() => parseOrdinalSelection("4-2", [1, 2, 3, 4], "--chapters")).toThrow("invalid range");
    expect(() => parseOrdinalSelection("5", [1, 2, 3, 4], "--chapters")).toThrow("unavailable");
  });

  it("bootstraps an honest rollback revision from a complete legacy checkpoint before first reparse", async () => {
    const root = await temporaryRoot("nwh-reparse-legacy-bootstrap-");
    const cacheRoot = await temporaryRoot("nwh-reparse-legacy-bootstrap-cache-");
    const fixture = await createEvidenceFixture(root, "# Opening\nHero waits.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    const batch = batches[0]!;
    const proposals = new CompilerProposalService(root);
    await proposals.submit("entity", {
      proposalId: "legacy-bootstrap-hero",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: batch.evidence },
      generatedBy: { worker: "test", compilerBatchId: batch.id },
    });
    await proposals.submit("initial-world", {
      proposalId: "legacy-bootstrap-opening",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
        evidence: batch.evidence,
      },
      generatedBy: { worker: "test", compilerBatchId: `opening-${batch.id}` },
    });
    const batchStore = new CompilerBatchStore(root);
    await batchStore.replaceCompleted(fixture.source.id, batches.map((candidate) => candidate.id));
    await convergeWorldProposals(root, fixture.source.id);
    await fs.writeFile(path.join(batchStore.root, `${fixture.source.id}.json`), `${JSON.stringify({
      version: 1,
      pipelineVersion: COMPILER_PIPELINE_VERSION - 1,
      sourceId: fixture.source.id,
      completedBatchIds: batches.map((candidate) => candidate.id),
      updatedAt: new Date(0).toISOString(),
    }, null, 2)}\n`);
    const progressMessages: string[] = [];
    const cache = new PreparedNovelCache(root, cacheRoot);

    await expect(reparseCommand({
      root,
      configPath: path.join(root, "missing.yaml"),
      sourceId: fixture.source.id,
      all: true,
      cacheRoot,
      onProgress: (message) => progressMessages.push(message),
    }, {
      async compileSource() {
        throw new Error("simulated provider failure after legacy bootstrap");
      },
    })).rejects.toThrow("simulated provider failure after legacy bootstrap");

    expect(progressMessages).toContainEqual(expect.stringContaining("Preserved the complete pipeline"));
    expect(progressMessages).toContainEqual(expect.stringContaining("Legacy rollback baseline materialized"));
    const revisions = await cache.listRevisions(fixture.source);
    expect(revisions).toEqual([expect.objectContaining({ active: true })]);
    await expect(cache.lookup(fixture.source)).resolves.toMatchObject({
      bundleHash: revisions[0]!.bundleHash,
      requiresReparse: true,
    });
    const bundle = JSON.parse(await fs.readFile(path.join(revisions[0]!.cachePath, "bundle.json"), "utf8")) as Record<string, unknown>;
    expect(bundle).not.toHaveProperty("compilerFingerprint");
    const restoredProgress = await batchStore.read(fixture.source.id);
    expect(restoredProgress.completedBatchIds.toSorted()).toEqual(batches.map((candidate) => candidate.id).toSorted());
    await expect(new CanonicalModelStore(root).getEntity("hero")).resolves.toMatchObject({ canonicalName: "Hero" });
  });

  it("does not bootstrap a rollback revision from an incomplete legacy checkpoint", async () => {
    const root = await temporaryRoot("nwh-reparse-incomplete-legacy-");
    const cacheRoot = await temporaryRoot("nwh-reparse-incomplete-legacy-cache-");
    const fixture = await createEvidenceFixture(root, "# Opening\nHero waits.\n");
    const batchStore = new CompilerBatchStore(root);
    await fs.mkdir(batchStore.root, { recursive: true });
    await fs.writeFile(path.join(batchStore.root, `${fixture.source.id}.json`), `${JSON.stringify({
      version: 1,
      pipelineVersion: COMPILER_PIPELINE_VERSION - 1,
      sourceId: fixture.source.id,
      completedBatchIds: [],
      updatedAt: new Date(0).toISOString(),
    }, null, 2)}\n`);

    await expect(reparseCommand({
      root,
      configPath: path.join(root, "missing.yaml"),
      sourceId: fixture.source.id,
      all: true,
      cacheRoot,
    })).rejects.toThrow("no active prepared revision is available as a rollback baseline");
    await expect(new PreparedNovelCache(root, cacheRoot).listRevisions(fixture.source)).resolves.toEqual([]);
  });

  it("invalidates chapter-local semantic dependencies backed by exact quote subspans", async () => {
    const root = await temporaryRoot("nwh-reparse-semantic-dependencies-");
    const fixture = await createEvidenceFixture(root, "# One\nHero waits.\n# Two\nVillain acts.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    const chapterOneEvidence = fixture.evidence("Hero waits.");
    const exactChapterTwoEvidence = fixture.evidence("Villain acts.");
    const canon = new CanonicalModelStore(root);
    const actors = new ActorModelStore(root);

    await canon.putProposition({
      id: "villain-acts",
      subjectEntityId: "villain",
      relationId: "acts",
      object: { kind: "literal", value: true },
      polarity: "positive",
      modality: "asserted",
      evidence: exactChapterTwoEvidence,
    });
    await canon.putAttribution({
      id: "narrator-villain-acts",
      propositionId: "villain-acts",
      holderKind: "narrator",
      attitude: "asserts",
      certainty: 1,
      evidence: exactChapterTwoEvidence,
    });
    const event = (id: string, evidence: typeof exactChapterTwoEvidence) => ({
      id,
      title: id,
      participants: ["villain"],
      storyTime: { kind: "ordinal" as const, label: id, orderHint: id === "villain-decides" ? 1 : 2 },
      preconditions: [],
      observedOutcome: { version: 1 as const, operations: [] },
      evidence,
      causalParents: id === "villain-acts-event" ? ["villain-decides"] : [],
      confidence: 1,
    });
    await canon.putEvent(event("villain-decides", exactChapterTwoEvidence));
    await canon.putEvent(event("villain-acts-event", exactChapterTwoEvidence));
    await canon.putEventParticipation({
      id: "villain-acts-agent",
      eventId: "villain-acts-event",
      entityId: "villain",
      role: "agent",
      confidence: 1,
      evidence: exactChapterTwoEvidence,
    });
    await canon.putEventRelation({
      id: "decision-causes-action",
      fromEventId: "villain-decides",
      toEventId: "villain-acts-event",
      type: "causes",
      operationality: "necessary",
      status: "explicit",
      confidence: 1,
      evidence: exactChapterTwoEvidence,
    });
    await canon.putSceneOccurrence({
      ontologyVersion: "scene-occurrence-v1",
      id: "villain-action-scene",
      discourseSegmentIds: ["chapter-two-discourse"],
      eventIds: ["villain-decides", "villain-acts-event"],
      viewpointActorIds: ["villain"],
      presentActorIds: ["villain"],
      entryConditions: [],
      exitConditions: [],
      evidence: exactChapterTwoEvidence,
    });
    await canon.putEventFrame({
      ontologyVersion: "event-frame-v1",
      id: "villain-action-frame",
      name: "Villain acts",
      temporalShape: "instant",
      roles: [{
        id: "agent",
        label: "agent",
        semanticRole: "agent",
        allowedEntityKinds: ["character"],
        minCardinality: 1,
        maxCardinality: 1,
        presence: "physical",
      }],
      evidence: exactChapterTwoEvidence,
    });
    await canon.putActionSchema({
      ontologyVersion: "action-schema-v1",
      id: "villain-action-schema",
      name: "Villain action",
      roles: [{ id: "agent", label: "agent", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }],
      parameters: [],
      preconditions: [],
      stateEffects: [],
      effectEnvelope: {
        maxStateOperations: 1,
        allowedStateFields: ["character.plan"],
        allowsKnowledge: false,
        allowsTimeAdvance: false,
        allowsSceneTransition: false,
      },
      induction: { kind: "source-pattern", supportingEventIds: ["villain-decides", "villain-acts-event"] },
      evidence: exactChapterTwoEvidence,
    });
    await canon.putActionConstraint({
      ontologyVersion: "action-constraint-v1",
      id: "villain-action-constraint",
      name: "Villain must be alive before acting",
      actionPattern: { kind: "schema", schemaId: "villain-action-schema" },
      appliesWhen: [],
      clauses: [{
        id: "villain-alive",
        timing: "before",
        modality: "require",
        predicate: { op: "fact-equals", entity: { kind: "actor" }, field: "character.alive", value: true },
      }],
      exceptions: [],
      priority: 1,
      defeasible: true,
      overridesConstraintIds: [],
      status: "supported",
      visibility: "public",
      induction: { kind: "source-pattern", supportingEventIds: ["villain-acts-event"] },
      evidence: exactChapterTwoEvidence,
    });
    await canon.putNormTemplate({
      ontologyVersion: "norm-template-v1",
      id: "villain-action-norm",
      name: "Villain is obliged to act",
      modality: "obligation",
      actionPattern: { kind: "schema", schemaId: "villain-action-schema" },
      appliesWhen: [],
      exceptions: [],
      reparations: [],
      priority: 1,
      defeasible: true,
      overridesTemplateIds: [],
      status: "supported",
      visibility: "public",
      knownByClaimIds: [],
      induction: { kind: "source-pattern", supportingEventIds: ["villain-decides", "villain-acts-event"] },
      evidence: exactChapterTwoEvidence,
    });
    await canon.putProcessTemplate({
      ontologyVersion: "process-template-v1",
      id: "villain-action-process",
      name: "Villain decision to action",
      ownerRoles: [{ id: "agent", label: "agent", allowedEntityKinds: ["character"], minCardinality: 1, maxCardinality: 1 }],
      phases: [{ id: "decided", label: "Decided", terminal: false }, { id: "acted", label: "Acted", terminal: true }],
      initialPhaseId: "decided",
      transitions: [{ fromPhaseId: "decided", toPhaseId: "acted", minimumProgress: 1 }],
      outcomeIds: ["acted"],
      visibility: "observable",
      induction: { kind: "source-pattern", supportingEventIds: ["villain-decides", "villain-acts-event"] },
      evidence: exactChapterTwoEvidence,
    });
    await actors.putModel({
      actorId: "villain",
      traits: {},
      decisionBiases: {},
      ontologyVersion: "character-v1",
      dispositions: [{
        id: "villain-risk",
        actorId: "villain",
        dimensionId: "risk-tolerance",
        value: 0.5,
        scope: { kind: "context", contextId: "physical-danger" },
        stability: "situational",
        basis: "explicit-characterization",
        status: "supported",
        confidence: 1,
        evidence: exactChapterTwoEvidence,
      }],
      evidence: exactChapterTwoEvidence,
    });
    await canon.putProposition({
      id: "cross-chapter-proposition",
      subjectEntityId: "hero",
      relationId: "opposes",
      object: { kind: "entity", entityId: "villain" },
      polarity: "positive",
      modality: "asserted",
      evidence: [...chapterOneEvidence, ...exactChapterTwoEvidence],
    });

    const invalidated = await invalidatePreparationArtifacts(root, fixture.source.id, [batches[1]!], false);

    expect(invalidated).toBe(13);
    await expect(canon.getProposition("villain-acts")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(canon.getAttribution("narrator-villain-acts")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(canon.getEvent("villain-decides")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(canon.getEvent("villain-acts-event")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(canon.getEventParticipation("villain-acts-agent")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(canon.getEventRelation("decision-causes-action")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(canon.getSceneOccurrence("villain-action-scene")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(canon.getEventFrame("villain-action-frame")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(canon.getActionSchema("villain-action-schema")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(canon.getActionConstraint("villain-action-constraint")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(canon.getNormTemplate("villain-action-norm")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(canon.getProcessTemplate("villain-action-process")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(actors.listModels()).resolves.toEqual([]);
    await expect(canon.getProposition("cross-chapter-proposition")).resolves.toMatchObject({ id: "cross-chapter-proposition" });
  });

  it("invalidates current observations, resolutions, accounting, and exact bindings with a whole-source reparse", async () => {
    const root = await temporaryRoot("nwh-reparse-compiler-metadata-");
    const content = "Hero waits.\n";
    const fixture = await createEvidenceFixture(root, content);
    const batch = (await prepareCompilerBatches(root, fixture.source))
      .find((candidate) => candidate.purpose === "source-review")!;
    const bytes = Buffer.from(content, "utf8");
    const heroStart = bytes.indexOf(Buffer.from("Hero"));
    const heroAnchor = textAnchorForByteRange(fixture.source.id, bytes, heroStart, heroStart + 4);
    const annotation = {
      version: 1 as const,
      id: "mention-hero-reparse",
      sourceId: fixture.source.id,
      annotationType: "entity-mention" as const,
      anchor: heroAnchor,
      surface: "Hero",
      form: "proper" as const,
      kindCandidates: ["character" as const],
      confidence: 1,
      derivation: {
        runId: "reparse-metadata-test",
        worker: "test",
        ontologyVersion: "observation-v1" as const,
      },
    };
    const annotationStore = new SourceAnnotationStore(root);
    await annotationStore.replaceCurrent(fixture.source.id, [annotation]);
    await new EntityResolutionStore(root).replaceCurrent(fixture.source.id, [{
      version: 1,
      id: "resolve-hero-reparse",
      sourceId: fixture.source.id,
      mentionId: annotation.id,
      status: "resolved",
      entityId: "hero",
      candidates: [{
        entityId: "hero",
        confidence: 1,
        basisMentionIds: [annotation.id],
        evidenceAssertionIds: ["assert-hero-reparse"],
        rationale: "Exact named mention.",
      }],
      rationale: "Exact named mention.",
      derivation: {
        runId: "reparse-metadata-test",
        worker: "test",
        ontologyVersion: "entity-resolution-v1",
      },
    }]);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: fixture.evidence("Hero"),
    });
    const hero = await canon.getEntity("hero");
    const assertion = {
      version: 1 as const,
      id: "assert-hero-reparse",
      target: { artifactKind: "entity", artifactId: "hero", jsonPointer: "/canonicalName" },
      anchors: [heroAnchor],
      relation: "supports" as const,
      strength: "explicit" as const,
      derivation: {
        runId: "reparse-metadata-test",
        worker: "test",
        ontologyVersion: "evidence-v1" as const,
      },
    };
    const exactEvidence = new EvidenceAssertionStore(root);
    await exactEvidence.replaceForArtifact("entity", "hero", contentHash(hero), [assertion]);
    const segments = await new SegmentStore(root).list(fixture.source.id);
    const accounting = new SourceAccountingStore(root);
    await accounting.recordBatchReview({
      source: fixture.source,
      structure: await ensureSourceStructure(root, fixture.source),
      batchId: batch.id,
      reviews: segments.map((segment) => ({
        segment,
        disposition: "proposed" as const,
        summary: "The named character is represented.",
      })),
      evidenceAssertions: [assertion],
      annotations: [{ id: annotation.id, anchors: annotationAnchors(annotation) }],
    });

    await expect(invalidatePreparationArtifacts(root, fixture.source.id, [batch], true)).resolves.toBe(4);
    await expect(annotationStore.list(fixture.source.id)).resolves.toEqual([]);
    await expect(new EntityResolutionStore(root).list(fixture.source.id)).resolves.toEqual([]);
    await expect(accounting.read(fixture.source.id)).resolves.toBeNull();
    await expect(exactEvidence.bindingForArtifact("entity", "hero")).resolves.toBeNull();
    await expect(canon.getEntity("hero")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rebuilds the whole source and opening state, retaining the prior revision", async () => {
    const root = await temporaryRoot("nwh-reparse-all-");
    const cacheRoot = await temporaryRoot("nwh-reparse-all-cache-");
    const fixture = await createEvidenceFixture(root, "# Opening\nHero waits.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    const batch = batches.find((candidate) => candidate.semanticStage === "semantic")!;
    const proposals = new CompilerProposalService(root);
    await proposals.submit("entity", {
      proposalId: "hero-all-v1",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: batch.evidence },
      generatedBy: { worker: "test", compilerBatchId: batch.id },
    });
    await proposals.submit("initial-world", {
      proposalId: "opening-all-v1",
      payload: { version: 1, delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] }, evidence: batch.evidence },
      generatedBy: { worker: "test", compilerBatchId: `opening-${batch.id}` },
    });
    await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, batches.map((candidate) => candidate.id));
    await convergeWorldProposals(root, fixture.source.id);
    const cache = new PreparedNovelCache(root, cacheRoot);
    const first = await cache.publish(fixture.source);

    const result = await reparseCommand({
      root,
      configPath: path.join(root, "missing.yaml"),
      sourceId: fixture.source.id,
      all: true,
      cacheRoot,
    }, {
      async compileSource(options) {
        expect(options.batchIds).toEqual(batches.map((candidate) => candidate.id));
        await proposals.submit("entity", {
          proposalId: "hero-all-v2-reparse-test",
          payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: ["Hero"], evidence: batch.evidence },
          generatedBy: { worker: "test", compilerBatchId: batch.id },
        });
        await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, batches.map((candidate) => candidate.id));
      },
      async finishPreparation(options) {
        expect(options.reparseBaselineBundleHash).toBe(first.bundleHash);
        await convergeWorldProposals(root, fixture.source.id);
        await proposals.submit("initial-world", {
          proposalId: "opening-all-v2-reparse-test",
          payload: { version: 1, delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] }, evidence: batch.evidence },
          generatedBy: { worker: "test", compilerBatchId: `opening-${batch.id}` },
        });
        await convergeWorldProposals(root, fixture.source.id);
        await new PreparedNovelCache(root, options.cacheRoot).publish(fixture.source);
        return inspectPreparation(root, { sourceId: fixture.source.id });
      },
    });

    expect(result.previousBundleHash).toBe(first.bundleHash);
    expect(result.activeBundleHash).not.toBe(first.bundleHash);
    await expect(new CanonicalModelStore(root).getEntity("hero")).resolves.toMatchObject({ aliases: ["Hero"] });
    await expect(new InitialWorldStore(root).get()).resolves.not.toBeNull();
    const revisions = await cache.listRevisions(fixture.source);
    expect(revisions).toHaveLength(2);
    expect(revisions.find((revision) => revision.bundleHash === first.bundleHash)?.active).toBe(false);
    expect(revisions.find((revision) => revision.bundleHash === result.activeBundleHash)?.active).toBe(true);

    await expect(reparseCommand({
      root,
      configPath: path.join(root, "missing.yaml"),
      sourceId: fixture.source.id,
      chapters: "1",
      cacheRoot,
    }, {
      async compileSource() {
        await proposals.submit("entity", {
          proposalId: "hero-dynamic-boundary-reparse-test",
          payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: ["unfinished"], evidence: batch.evidence },
          generatedBy: { worker: "test", compilerBatchId: `boundary-${fixture.source.id}-dynamic` },
        });
        throw new Error("simulated compiler failure");
      },
    })).rejects.toThrow(`rolled back to ${result.activeBundleHash}`);
    await expect(cache.lookup(fixture.source)).resolves.toMatchObject({ bundleHash: result.activeBundleHash });
    await expect(new CanonicalModelStore(root).getEntity("hero")).resolves.toMatchObject({ aliases: ["Hero"] });
    await expect(new InitialWorldStore(root).get()).resolves.not.toBeNull();
    await expect(new ProposalStore(root).list("pending", fixture.source.id)).resolves.toEqual([]);
    await expect(new ProposalStore(root).list("rejected", fixture.source.id)).resolves.toContainEqual(
      expect.objectContaining({ id: "hero-dynamic-boundary-reparse-test" }),
    );
  });

  it("keeps an incompatible active fingerprint intact when a semantic-upgrade reparse fails", async () => {
    const root = await temporaryRoot("nwh-reparse-legacy-rollback-");
    const cacheRoot = await temporaryRoot("nwh-reparse-legacy-rollback-cache-");
    const fixture = await createEvidenceFixture(root, "# Opening\nHero waits.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    const batch = batches.find((candidate) => candidate.semanticStage === "semantic")!;
    const proposals = new CompilerProposalService(root);
    await proposals.submit("entity", {
      proposalId: "legacy-rollback-hero",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: batch.evidence },
      generatedBy: { worker: "test", compilerBatchId: batch.id },
    });
    await proposals.submit("initial-world", {
      proposalId: "legacy-rollback-opening",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
        evidence: batch.evidence,
      },
      generatedBy: { worker: "test", compilerBatchId: `opening-${batch.id}` },
    });
    await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, batches.map((candidate) => candidate.id));
    await convergeWorldProposals(root, fixture.source.id);
    const cache = new PreparedNovelCache(root, cacheRoot);
    const current = await cache.publish(fixture.source);
    const legacyBundle = JSON.parse(await fs.readFile(path.join(current.cachePath, "bundle.json"), "utf8")) as Record<string, unknown>;
    delete legacyBundle.compilerFingerprint;
    const legacyHash = contentHash(legacyBundle);
    const cacheBase = path.join(cacheRoot, current.contentMd5);
    const legacyRevision = path.join(cacheBase, "revisions", legacyHash);
    await fs.mkdir(legacyRevision, { recursive: true });
    await fs.writeFile(path.join(legacyRevision, "bundle.json"), `${canonicalJson(legacyBundle)}\n`);
    await fs.writeFile(path.join(legacyRevision, "manifest.json"), `${canonicalJson({
      version: 1,
      contentMd5: current.contentMd5,
      contentSha256: fixture.source.contentSha256,
      sourceId: fixture.source.id,
      bundleHash: legacyHash,
      createdAt: new Date(0).toISOString(),
    })}\n`);
    await fs.writeFile(path.join(cacheBase, "active.json"), `${canonicalJson({
      version: 1,
      contentMd5: current.contentMd5,
      bundleHash: legacyHash,
      updatedAt: new Date(0).toISOString(),
    })}\n`);

    await expect(reparseCommand({
      root,
      configPath: path.join(root, "missing.yaml"),
      sourceId: fixture.source.id,
      all: true,
      cacheRoot,
    }, {
      async compileSource() { throw new Error("simulated provider failure"); },
    })).rejects.toThrow(`rolled back to ${legacyHash}`);

    await expect(cache.lookup(fixture.source)).resolves.toMatchObject({
      bundleHash: legacyHash,
      requiresReparse: true,
    });
    expect((await cache.listRevisions(fixture.source)).filter((revision) => revision.active))
      .toEqual([expect.objectContaining({ bundleHash: legacyHash })]);
  });
});

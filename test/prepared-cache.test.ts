import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { BoundaryCalibrationStore } from "../src/compiler/boundary-calibration.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { canonicalJson, contentHash } from "../src/world/canonical.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { ChapterSplitPlanStore, evaluateChapterSplitPlan } from "../src/compiler/chapter-split.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";
import { ActorModelStore } from "../src/world/actors.js";
import { EvidenceAssertionStore } from "../src/compiler/evidence-assertions.js";
import { SourceAnnotationStore, annotationAnchors } from "../src/compiler/annotations.js";
import { EntityResolutionStore } from "../src/compiler/entity-resolution.js";
import { EventResolutionStore } from "../src/compiler/event-resolution.js";
import { SourceAccountingStore } from "../src/compiler/source-accounting.js";
import { ensureSourceStructure } from "../src/compiler/structure.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("versioned prepared novel cache", () => {
  it("refuses to publish controlled character semantics without exact per-item evidence", async () => {
    const cacheRoot = await temporaryRoot("nwh-prepared-character-evidence-cache-");
    const sourceRoot = await temporaryRoot("nwh-prepared-character-evidence-source-");
    const fixture = await createEvidenceFixture(sourceRoot, "Hero waits and carefully weighs the danger.\n");
    const evidence = fixture.evidence("Hero waits and carefully weighs the danger.");
    await new CanonicalModelStore(sourceRoot).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence,
    });
    await new InitialWorldStore(sourceRoot).put({
      version: 1,
      delta: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
      },
      evidence,
    });
    await new ActorModelStore(sourceRoot).putModel({
      actorId: "hero",
      ontologyVersion: "character-v1",
      traits: {},
      decisionBiases: {},
      dispositions: [{
        id: "hero-deliberates",
        actorId: "hero",
        dimensionId: "deliberation",
        value: 0.8,
        scope: { kind: "global" },
        stability: "stable",
        basis: "explicit-characterization",
        status: "supported",
        confidence: 0.9,
        evidence,
      }],
      evidence,
    });
    const batches = await prepareCompilerBatches(sourceRoot, fixture.source);
    await new CompilerBatchStore(sourceRoot).replaceCompleted(
      fixture.source.id,
      batches.map((batch) => batch.id),
    );

    await expect(new PreparedNovelCache(sourceRoot, cacheRoot).publish(fixture.source))
      .rejects.toThrow("has no exact evidence binding");
  });

  it("refuses to publish a controlled world rule without exact per-clause evidence", async () => {
    const cacheRoot = await temporaryRoot("nwh-prepared-world-rule-evidence-cache-");
    const sourceRoot = await temporaryRoot("nwh-prepared-world-rule-evidence-source-");
    const fixture = await createEvidenceFixture(sourceRoot, "Hero must remain alive by the old law.\n");
    const evidence = fixture.evidence("Hero must remain alive by the old law.");
    const canon = new CanonicalModelStore(sourceRoot);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence });
    await canon.putRule({
      ontologyVersion: "world-rule-v2",
      id: "old-law",
      name: "The old law protects Hero",
      kind: "social",
      scope: "global",
      jurisdictionEntityIds: [],
      appliesWhen: [],
      visibility: "public",
      knownByClaimIds: [],
      priority: 1,
      defeasible: true,
      overridesRuleIds: [],
      clauses: [{
        id: "old-law-requirement",
        modality: "require",
        predicate: { op: "fact-equals", entityId: "hero", field: "character.alive", value: true },
        basis: "explicit",
        status: "supported",
        confidence: 1,
        evidence,
      }],
      exceptions: [],
      basis: "explicit",
      status: "supported",
      confidence: 1,
      evidence,
    });
    await new InitialWorldStore(sourceRoot).put({
      version: 1,
      delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
      evidence,
    });
    const batches = await prepareCompilerBatches(sourceRoot, fixture.source);
    await new CompilerBatchStore(sourceRoot).replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));

    await expect(new PreparedNovelCache(sourceRoot, cacheRoot).publish(fixture.source))
      .rejects.toThrow("controlled world rule old-law has no exact evidence binding");
  });

  it("restores accepted model-inferred title metadata across different upload filenames", async () => {
    const cacheRoot = await temporaryRoot("nwh-prepared-title-cache-");
    const sourceRoot = await temporaryRoot("nwh-prepared-title-source-");
    const content = "The Hidden City\n\nHero waits at the opening.\n";
    const fixture = await createEvidenceFixture(sourceRoot, content, "publisher-upload.txt");
    await (await WorkspaceStore.create(sourceRoot)).restoreSourceTitleInference(fixture.source.id, {
      version: 1,
      sourceId: fixture.source.id,
      title: "The Hidden City",
      evidence: fixture.evidence("The Hidden City")[0]!,
      generatedBy: {
        worker: "propose_novel_title",
        provider: "test",
        model: "semantic-title-model",
        compilerBatchId: `batch-${fixture.source.id}-00001-title`,
      },
      inferredAt: new Date().toISOString(),
    });
    const proposals = new CompilerProposalService(sourceRoot);
    await proposals.submit("entity", {
      proposalId: "title-cache-hero",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("initial-world", {
      proposalId: "title-cache-opening",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
        evidence: fixture.evidence("Hero waits at the opening."),
      },
      generatedBy: { worker: "test" },
    });
    const batches = await prepareCompilerBatches(sourceRoot, fixture.source);
    await new CompilerBatchStore(sourceRoot).replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));
    await convergeWorldProposals(sourceRoot, fixture.source.id);
    const published = await new PreparedNovelCache(sourceRoot, cacheRoot).publish(fixture.source);
    const bundle = JSON.parse(await fs.readFile(path.join(published.cachePath, "bundle.json"), "utf8")) as {
      source: { titleInference?: { title: string } };
    };
    expect(bundle.source.titleInference?.title).toBe("The Hidden City");

    const restoredRoot = await temporaryRoot("nwh-prepared-title-restored-");
    const restoredFixture = await createEvidenceFixture(restoredRoot, content, "opaque-mirror-name.md");
    expect(restoredFixture.source.title).toBe("opaque-mirror-name.md");
    await expect(new PreparedNovelCache(restoredRoot, cacheRoot).restore(restoredFixture.source))
      .resolves.toMatchObject({ status: "restored", bundleHash: published.bundleHash });
    await expect((await WorkspaceStore.create(restoredRoot)).getSource(restoredFixture.source.id)).resolves.toMatchObject({
      title: "The Hidden City",
      titleInference: { title: "The Hidden City", generatedBy: { model: "semantic-title-model" } },
      sourcePath: "opaque-mirror-name.md",
    });
  });

  it("restores the validated chapter split plan with its deterministic batch layout", async () => {
    const cacheRoot = await temporaryRoot("nwh-prepared-chapter-split-cache-");
    const sourceRoot = await temporaryRoot("nwh-prepared-chapter-split-source-");
    const content = ":: 1 :: Opening\nAlice waits.\n\n:: 2 :: Next\nAlice leaves.\n";
    const fixture = await createEvidenceFixture(sourceRoot, content);
    const evaluation = await evaluateChapterSplitPlan(sourceRoot, fixture.source, {
      mode: "custom",
      rule: {
        prefix: ":: ",
        numberStyle: "arabic",
        suffix: " ::",
        caseSensitive: true,
        allowLeadingWhitespace: false,
        allowTrailingText: true,
      },
      examples: [
        { line: 1, text: ":: 1 :: Opening" },
        { line: 4, text: ":: 2 :: Next" },
      ],
      reason: "Two exact author headings establish the split form.",
    }, { compilerBatchId: `structure-${fixture.source.id}-v1`, provider: "test", model: "split" });
    await new ChapterSplitPlanStore(sourceRoot).write(evaluation.plan);

    const proposals = new CompilerProposalService(sourceRoot);
    await proposals.submit("entity", {
      proposalId: "split-alice",
      payload: { id: "alice", kind: "character", canonicalName: "Alice", aliases: [], evidence: fixture.evidence("Alice") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("initial-world", {
      proposalId: "split-opening",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "alice", field: "character.alive", value: true }] },
        evidence: fixture.evidence("Alice waits."),
      },
      generatedBy: { worker: "test" },
    });
    const sourceBatches = await prepareCompilerBatches(sourceRoot, fixture.source);
    expect(sourceBatches.map((batch) => batch.purpose)).toEqual([
      "structure-discovery",
      "source-review",
      "source-review",
    ]);
    await new CompilerBatchStore(sourceRoot).replaceCompleted(fixture.source.id, sourceBatches.map((batch) => batch.id));
    await convergeWorldProposals(sourceRoot, fixture.source.id);
    const published = await new PreparedNovelCache(sourceRoot, cacheRoot).publish(fixture.source);

    const restoredRoot = await temporaryRoot("nwh-prepared-chapter-split-restored-");
    const restoredFixture = await createEvidenceFixture(restoredRoot, content);
    await expect(new ChapterSplitPlanStore(restoredRoot).read(restoredFixture.source.id)).resolves.toBeNull();
    await expect(new PreparedNovelCache(restoredRoot, cacheRoot).restore(restoredFixture.source))
      .resolves.toMatchObject({ status: "restored", bundleHash: published.bundleHash });
    await expect(new ChapterSplitPlanStore(restoredRoot).read(restoredFixture.source.id)).resolves.toMatchObject({
      mode: "custom",
      rule: { prefix: ":: ", suffix: " ::" },
    });
    const restoredBatches = await prepareCompilerBatches(restoredRoot, restoredFixture.source);
    expect(restoredBatches.map((batch) => batch.id)).toEqual(sourceBatches.map((batch) => batch.id));
    await expect(new CompilerBatchStore(restoredRoot).read(restoredFixture.source.id)).resolves.toMatchObject({
      completedBatchIds: sourceBatches.map((batch) => batch.id).sort(),
    });
  });

  it("restores exact compiler observations, resolutions, accounting, and evidence bindings from a v2 revision", async () => {
    const cacheRoot = await temporaryRoot("nwh-prepared-compiler-snapshot-cache-");
    const sourceRoot = await temporaryRoot("nwh-prepared-compiler-snapshot-source-");
    const content = "Hero enters the village.\n";
    const fixture = await createEvidenceFixture(sourceRoot, content);
    const bytes = Buffer.from(content, "utf8");
    const anchor = (exact: string) => {
      const selected = Buffer.from(exact, "utf8");
      const startByte = bytes.indexOf(selected);
      if (startByte < 0) throw new Error(`Missing snapshot-test quote: ${exact}`);
      return textAnchorForByteRange(fixture.source.id, bytes, startByte, startByte + selected.byteLength);
    };
    const heroAnchor = anchor("Hero");
    const entersAnchor = anchor("enters");
    const sentenceAnchor = anchor("Hero enters the village.");
    const annotationDerivation = {
      runId: "snapshot-run",
      worker: "snapshot-test",
      ontologyVersion: "observation-v1" as const,
    };
    const annotations = [{
      version: 1 as const,
      id: "mention-hero",
      sourceId: fixture.source.id,
      annotationType: "entity-mention" as const,
      anchor: heroAnchor,
      surface: "Hero",
      form: "proper" as const,
      kindCandidates: ["character" as const],
      confidence: 1,
      derivation: annotationDerivation,
    }, {
      version: 1 as const,
      id: "mention-enters",
      sourceId: fixture.source.id,
      annotationType: "event-mention" as const,
      triggerAnchor: entersAnchor,
      trigger: "enters",
      extentAnchors: [sentenceAnchor],
      eventTypeCandidates: ["movement" as const],
      participantMentionIds: ["mention-hero"],
      salience: "major" as const,
      confidence: 1,
      derivation: annotationDerivation,
    }];
    const annotationStore = new SourceAnnotationStore(sourceRoot);
    await annotationStore.replaceCurrent(fixture.source.id, annotations);
    const entityResolution = {
      version: 1 as const,
      id: "resolve-hero",
      sourceId: fixture.source.id,
      mentionId: "mention-hero",
      status: "resolved" as const,
      entityId: "hero",
      candidates: [{
        entityId: "hero",
        confidence: 1,
        basisMentionIds: ["mention-hero"],
        evidenceAssertionIds: ["assert-hero-name"],
        rationale: "The exact proper name identifies Hero.",
      }],
      rationale: "The exact proper name identifies Hero.",
      derivation: {
        runId: "snapshot-run",
        worker: "snapshot-test",
        ontologyVersion: "entity-resolution-v1" as const,
      },
    };
    await new EntityResolutionStore(sourceRoot).replaceCurrent(fixture.source.id, [entityResolution]);
    const eventResolution = {
      version: 1 as const,
      id: "resolve-entry",
      sourceId: fixture.source.id,
      eventMentionIds: ["mention-enters"],
      status: "resolved" as const,
      canonicalEventId: "entry",
      relation: "coreference" as const,
      candidates: [{
        canonicalEventId: "entry",
        relation: "coreference" as const,
        confidence: 1,
        basisEventMentionIds: ["mention-enters"],
        evidenceAssertionIds: [],
        rationale: "The trigger denotes the canonical entry event.",
      }],
      supersedesResolutionIds: [],
      rationale: "The trigger denotes the canonical entry event.",
      derivation: {
        runId: "snapshot-run",
        worker: "snapshot-test",
        ontologyVersion: "event-resolution-v1" as const,
      },
    };
    await new EventResolutionStore(sourceRoot).replaceCurrent(fixture.source.id, [eventResolution]);

    const evidence = fixture.evidence("Hero enters the village.");
    const canon = new CanonicalModelStore(sourceRoot);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence });
    await canon.putEvent({
      id: "entry",
      title: "Hero enters the village",
      participants: ["hero"],
      participantPresence: [{ entityId: "hero", mode: "physical" }],
      storyTime: { kind: "ordinal", label: "first", orderHint: 1 },
      preconditions: [],
      observedOutcome: { version: 1, operations: [] },
      evidence,
      causalParents: [],
      confidence: 1,
    });
    await new InitialWorldStore(sourceRoot).put({
      version: 1,
      delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
      evidence,
    });
    const hero = await canon.getEntity("hero");
    const assertion = {
      version: 1 as const,
      id: "assert-hero-name",
      target: { artifactKind: "entity", artifactId: "hero", jsonPointer: "/canonicalName" },
      anchors: [heroAnchor],
      relation: "supports" as const,
      strength: "explicit" as const,
      derivation: {
        runId: "snapshot-run",
        worker: "snapshot-test",
        ontologyVersion: "evidence-v1" as const,
      },
    };
    await new EvidenceAssertionStore(sourceRoot).replaceForArtifact(
      "entity",
      "hero",
      contentHash(hero),
      [assertion],
    );
    const batches = await prepareCompilerBatches(sourceRoot, fixture.source);
    const segments = await new SegmentStore(sourceRoot).list(fixture.source.id);
    await new SourceAccountingStore(sourceRoot).recordBatchReview({
      source: fixture.source,
      structure: await ensureSourceStructure(sourceRoot, fixture.source),
      batchId: batches.find((batch) => batch.purpose === "source-review")!.id,
      reviews: segments.map((segment) => ({
        segment,
        disposition: "proposed" as const,
        summary: "The sentence is represented by exact observations and canonical artifacts.",
      })),
      evidenceAssertions: [assertion],
      annotations: annotations.map((annotation) => ({
        id: annotation.id,
        anchors: annotationAnchors(annotation),
      })),
    });
    await new CompilerBatchStore(sourceRoot).replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));

    const annotationSnapshot = await annotationStore.list(fixture.source.id);
    const entityResolutionSnapshot = await new EntityResolutionStore(sourceRoot).list(fixture.source.id);
    const eventResolutionSnapshot = await new EventResolutionStore(sourceRoot).list(fixture.source.id);
    const accountingSnapshot = await new SourceAccountingStore(sourceRoot).read(fixture.source.id);
    const structureSnapshot = await ensureSourceStructure(sourceRoot, fixture.source);
    const bindingSnapshot = await new EvidenceAssertionStore(sourceRoot).bindingForArtifact("entity", "hero");
    const published = await new PreparedNovelCache(sourceRoot, cacheRoot).publish(fixture.source);
    const rawBundle = JSON.parse(await fs.readFile(path.join(published.cachePath, "bundle.json"), "utf8")) as {
      version: number;
      compilerSnapshot?: unknown;
    };
    expect(rawBundle).toMatchObject({ version: 2, compilerSnapshot: expect.any(Object) });

    const restoredRoot = await temporaryRoot("nwh-prepared-compiler-snapshot-restored-");
    const restoredFixture = await createEvidenceFixture(restoredRoot, content, "renamed-copy.md");
    await expect(new PreparedNovelCache(restoredRoot, cacheRoot).restore(restoredFixture.source))
      .resolves.toMatchObject({ status: "restored", bundleHash: published.bundleHash });
    expect(canonicalJson(await new SourceAnnotationStore(restoredRoot).list(restoredFixture.source.id)))
      .toBe(canonicalJson(annotationSnapshot));
    expect(canonicalJson(await new EntityResolutionStore(restoredRoot).list(restoredFixture.source.id)))
      .toBe(canonicalJson(entityResolutionSnapshot));
    expect(canonicalJson(await new EventResolutionStore(restoredRoot).list(restoredFixture.source.id)))
      .toBe(canonicalJson(eventResolutionSnapshot));
    expect(canonicalJson(await new SourceAccountingStore(restoredRoot).read(restoredFixture.source.id)))
      .toBe(canonicalJson(accountingSnapshot));
    expect(canonicalJson(await ensureSourceStructure(restoredRoot, restoredFixture.source)))
      .toBe(canonicalJson(structureSnapshot));
    expect(canonicalJson(await new EvidenceAssertionStore(restoredRoot).bindingForArtifact("entity", "hero")))
      .toBe(canonicalJson(bindingSnapshot));

    // A legacy revision cannot reproduce metadata it never stored. Activating
    // it must clear newer compiler metadata rather than silently mixing eras.
    const legacyBundle = JSON.parse(
      await fs.readFile(path.join(published.cachePath, "bundle.json"), "utf8"),
    ) as Record<string, unknown>;
    legacyBundle.version = 1;
    delete legacyBundle.compilerSnapshot;
    const legacyHash = contentHash(legacyBundle);
    const legacyDirectory = path.join(path.dirname(published.cachePath), legacyHash);
    await fs.mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(legacyDirectory, "bundle.json"), `${canonicalJson(legacyBundle)}\n`);
    await fs.writeFile(path.join(legacyDirectory, "manifest.json"), `${canonicalJson({
      version: 1,
      contentMd5: fixture.source.contentMd5,
      contentSha256: fixture.source.contentSha256,
      sourceId: fixture.source.id,
      bundleHash: legacyHash,
      createdAt: new Date().toISOString(),
    })}\n`);
    await (await WorkspaceStore.create(sourceRoot)).restoreSourceTitleInference(fixture.source.id, {
      version: 1,
      sourceId: fixture.source.id,
      title: "Temporary Newer Title",
      evidence: fixture.evidence("Hero")[0]!,
      generatedBy: { worker: "propose_novel_title", compilerBatchId: "snapshot-title-batch" },
      inferredAt: new Date().toISOString(),
    });
    await expect(new PreparedNovelCache(sourceRoot, cacheRoot).activate(fixture.source, legacyHash))
      .resolves.toMatchObject({ status: "activated", bundleHash: legacyHash });
    await expect(annotationStore.list(fixture.source.id)).resolves.toEqual([]);
    await expect(new EntityResolutionStore(sourceRoot).list(fixture.source.id)).resolves.toEqual([]);
    await expect(new EventResolutionStore(sourceRoot).list(fixture.source.id)).resolves.toEqual([]);
    await expect(new SourceAccountingStore(sourceRoot).read(fixture.source.id)).resolves.toBeNull();
    await expect(new EvidenceAssertionStore(sourceRoot).bindingForArtifact("entity", "hero")).resolves.toBeNull();
    const legacyRestoredSource = await (await WorkspaceStore.create(sourceRoot)).getSource(fixture.source.id);
    expect(legacyRestoredSource).toMatchObject({ title: "novel.txt" });
    expect(legacyRestoredSource).not.toHaveProperty("titleInference");
  });

  it("stores only deterministic source batches after a transient boundary calibration", async () => {
    const cacheRoot = await temporaryRoot("nwh-prepared-boundary-cache-");
    const sourceRoot = await temporaryRoot("nwh-prepared-boundary-source-");
    const content = "Chapter 1\nAlice raises the key and\n\nChapter 2\nopens the gate.\n";
    const fixture = await createEvidenceFixture(sourceRoot, content);
    const regular = await prepareCompilerBatches(sourceRoot, fixture.source);
    expect(regular).toHaveLength(2);
    await new BoundaryCalibrationStore(sourceRoot).request({
      sourceId: fixture.source.id,
      leftSegmentId: regular[0]!.segmentIds[0]!,
      rightSegmentId: regular[1]!.segmentIds[0]!,
      requestedByBatchId: regular[0]!.id,
      requestedBySegmentId: regular[0]!.segmentIds[0]!,
      direction: "next",
      reason: "The action crosses the split.",
    });
    const withCalibration = await prepareCompilerBatches(sourceRoot, fixture.source);
    expect(withCalibration.map((batch) => batch.purpose)).toEqual([
      "source-review",
      "source-review",
      "boundary-calibration",
    ]);

    const proposals = new CompilerProposalService(sourceRoot);
    await proposals.submit("entity", {
      proposalId: "boundary-alice",
      payload: { id: "alice", kind: "character", canonicalName: "Alice", aliases: [], evidence: fixture.evidence("Alice") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("initial-world", {
      proposalId: "boundary-opening",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "alice", field: "character.alive", value: true }] },
        evidence: fixture.evidence("Alice raises the key"),
      },
      generatedBy: { worker: "test" },
    });
    await new CompilerBatchStore(sourceRoot).replaceCompleted(
      fixture.source.id,
      withCalibration.map((batch) => batch.id),
    );
    await convergeWorldProposals(sourceRoot, fixture.source.id);
    const published = await new PreparedNovelCache(sourceRoot, cacheRoot).publish(fixture.source);
    const bundle = JSON.parse(await fs.readFile(path.join(published.cachePath, "bundle.json"), "utf8")) as { batchIds: string[] };
    expect(bundle.batchIds).toEqual(regular.map((batch) => batch.id).sort());

    const restoredRoot = await temporaryRoot("nwh-prepared-boundary-restored-");
    const restoredFixture = await createEvidenceFixture(restoredRoot, content);
    await expect(new PreparedNovelCache(restoredRoot, cacheRoot).restore(restoredFixture.source))
      .resolves.toMatchObject({ status: "restored", bundleHash: published.bundleHash });
  });

  it("refuses to create from an active bundle after newer accepted source artifacts make it stale", async () => {
    const cacheRoot = await temporaryRoot("nwh-prepared-fresh-cache-");
    const sourceRoot = await temporaryRoot("nwh-prepared-fresh-source-");
    const fixture = await createEvidenceFixture(sourceRoot, "Hero waits at the opening.\n");
    const proposals = new CompilerProposalService(sourceRoot);
    await proposals.submit("entity", {
      proposalId: "fresh-hero",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("initial-world", {
      proposalId: "fresh-opening",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
        evidence: fixture.evidence("Hero waits at the opening."),
      },
      generatedBy: { worker: "test" },
    });
    const batches = await prepareCompilerBatches(sourceRoot, fixture.source);
    await new CompilerBatchStore(sourceRoot).replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));
    await convergeWorldProposals(sourceRoot, fixture.source.id);
    const cache = new PreparedNovelCache(sourceRoot, cacheRoot);
    const published = await cache.publish(fixture.source);
    await expect(cache.loadFreshActive(fixture.source)).resolves.toMatchObject({ bundleHash: published.bundleHash });

    const canon = new CanonicalModelStore(sourceRoot);
    const hero = await canon.getEntity("hero");
    const revisedHero = { ...hero, aliases: ["The Hero"] };
    await canon.putEntity(revisedHero);
    const heroBinding = await new EvidenceAssertionStore(sourceRoot).bindingForArtifact("entity", "hero");
    await new EvidenceAssertionStore(sourceRoot).replaceForArtifact(
      "entity",
      "hero",
      contentHash(revisedHero),
      heroBinding?.assertions ?? [],
    );

    await expect(cache.loadFreshActive(fixture.source)).rejects.toThrow("stale relative to accepted workspace artifacts");
    await expect(cache.loadFreshActive(fixture.source)).rejects.toThrow("entities differ");
    const revised = await cache.publish(fixture.source);
    await expect(cache.loadFreshActive(fixture.source)).resolves.toMatchObject({ bundleHash: revised.bundleHash });
  });

  it("reuses active MD5 revisions while immutable revisions and branches remain independent", async () => {
    const cacheRoot = await temporaryRoot("nwh-prepared-cache-");
    const sourceRoot = await temporaryRoot("nwh-prepared-source-");
    const content = "Hero waits at the opening.\n";
    const fixture = await createEvidenceFixture(sourceRoot, content);
    const proposals = new CompilerProposalService(sourceRoot);
    await proposals.submit("entity", {
      proposalId: "entity-hero",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") },
      generatedBy: { worker: "test" },
    });
    await proposals.submit("initial-world", {
      proposalId: "opening-world",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
        evidence: fixture.evidence("Hero waits at the opening."),
      },
      generatedBy: { worker: "test" },
    });
    const batches = await prepareCompilerBatches(sourceRoot, fixture.source);
    await new CompilerBatchStore(sourceRoot).replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));
    const convergence = await convergeWorldProposals(sourceRoot, fixture.source.id);
    expect(convergence.canonical.accepted).toHaveLength(2);

    const sourceCache = new PreparedNovelCache(sourceRoot, cacheRoot);
    const published = await sourceCache.publish(fixture.source);
    expect(published).toMatchObject({ status: "published", contentMd5: fixture.source.contentMd5 });
    const cachedBundlePath = path.join(published.cachePath, "bundle.json");
    const immutableBaseline = await fs.readFile(cachedBundlePath, "utf8");
    expect((await fs.stat(cachedBundlePath)).mode & 0o222).toBe(0);
    await fs.rm(path.join(sourceRoot, fixture.source.sourcePath));
    await expect(sourceCache.lookup(fixture.source)).resolves.toMatchObject({
      status: "already-cached",
      bundleHash: published.bundleHash,
    });

    const reusedRoot = await temporaryRoot("nwh-prepared-reuse-");
    const reusedFixture = await createEvidenceFixture(reusedRoot, content, "same-content-different-name.md");
    const restored = await new PreparedNovelCache(reusedRoot, cacheRoot).restore(reusedFixture.source);
    expect(restored).toMatchObject({ status: "restored", contentMd5: published.contentMd5, bundleHash: published.bundleHash });
    await expect(new CanonicalModelStore(reusedRoot).getEntity("hero")).resolves.toMatchObject({ aliases: [] });
    await expect(new InitialWorldStore(reusedRoot).get()).resolves.toMatchObject({ delta: { operations: [expect.objectContaining({ value: true })] } });
    const reusedBatches = await prepareCompilerBatches(reusedRoot, reusedFixture.source);
    await expect(new CompilerBatchStore(reusedRoot).read(reusedFixture.source.id)).resolves.toMatchObject({
      completedBatchIds: reusedBatches.map((batch) => batch.id).sort(),
    });

    const initial = await new InitialWorldStore(reusedRoot).get();
    if (!initial) throw new Error("restored initial world missing");
    const { engine } = await openWorkspaceWorld(reusedRoot);
    await engine.createBranch("main", "main", initial.delta, initial.knowledge);
    await engine.createBranch("alternate", "alternate", initial.delta, initial.knowledge);
    const mainHead = await engine.branches.readHead("main");
    await engine.commitProposal({
      proposalId: "hero-falls",
      branchId: "main",
      expectedParentCommit: mainHead,
      source: "player",
      actorId: "hero",
      title: "Hero falls",
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: false }] },
      causalParents: [],
      evidence: fixture.evidence("Hero"),
    });
    expect((await engine.projector.project(await engine.branches.readHead("main"))).values.hero?.["character.alive"]).toBe(false);
    expect((await engine.projector.project(await engine.branches.readHead("alternate"))).values.hero?.["character.alive"]).toBe(true);
    expect(await fs.readFile(cachedBundlePath, "utf8")).toBe(immutableBaseline);

    const originalEntity = await new CanonicalModelStore(sourceRoot).getEntity("hero");
    const revisedEntity = { ...originalEntity, aliases: ["Hero"] };
    await new CanonicalModelStore(sourceRoot).putEntity(revisedEntity);
    const originalBinding = await new EvidenceAssertionStore(sourceRoot).bindingForArtifact("entity", "hero");
    await new EvidenceAssertionStore(sourceRoot).replaceForArtifact(
      "entity",
      "hero",
      contentHash(revisedEntity),
      originalBinding?.assertions ?? [],
    );
    const revised = await sourceCache.publish(fixture.source, {
      lineage: {
        operation: "repair",
        parentBundleHash: published.bundleHash!,
        runId: "repair-history-test",
      },
    });
    expect(revised).toMatchObject({ status: "published", contentMd5: published.contentMd5 });
    expect(revised.bundleHash).not.toBe(published.bundleHash);
    expect(await fs.readFile(cachedBundlePath, "utf8")).toBe(immutableBaseline);
    await expect(sourceCache.listRevisions(fixture.source)).resolves.toEqual([
      expect.objectContaining({ bundleHash: published.bundleHash, active: false }),
      expect.objectContaining({
        bundleHash: revised.bundleHash,
        active: true,
        lineage: {
          operation: "repair",
          parentBundleHash: published.bundleHash,
          runId: "repair-history-test",
        },
      }),
    ]);
    await expect(sourceCache.loadRevision(fixture.source, revised.bundleHash!)).resolves.toMatchObject({
      bundle: {
        lineage: {
          operation: "repair",
          parentBundleHash: published.bundleHash,
          runId: "repair-history-test",
        },
      },
    });

    await new PreparedNovelCache(reusedRoot, cacheRoot).activate(reusedFixture.source, revised.bundleHash!);
    const reopened = await openWorkspaceWorld(reusedRoot);
    const oldMainHead = await reopened.engine.branches.readHead("main");
    expect((await reopened.engine.contextForCommit(oldMainHead)).entities.get("hero")?.aliases).toEqual([]);
    const latestHead = await reopened.engine.createBranch("latest", "latest", initial.delta, initial.knowledge);
    expect((await reopened.engine.contextForCommit(latestHead)).entities.get("hero")?.aliases).toEqual(["Hero"]);

    const thirdRoot = await temporaryRoot("nwh-prepared-third-");
    const thirdFixture = await createEvidenceFixture(thirdRoot, content);
    await expect(new PreparedNovelCache(thirdRoot, cacheRoot).restore(thirdFixture.source)).resolves.toMatchObject({ status: "restored" });
    await expect(new CanonicalModelStore(thirdRoot).getEntity("hero")).resolves.toMatchObject({ aliases: ["Hero"] });

    await sourceCache.activate(fixture.source, published.bundleHash!);
    const fourthRoot = await temporaryRoot("nwh-prepared-fourth-");
    const fourthFixture = await createEvidenceFixture(fourthRoot, content);
    await expect(new PreparedNovelCache(fourthRoot, cacheRoot).restore(fourthFixture.source)).resolves.toMatchObject({ status: "restored" });
    await expect(new CanonicalModelStore(fourthRoot).getEntity("hero")).resolves.toMatchObject({ aliases: [] });

    const legacyCacheRoot = await temporaryRoot("nwh-prepared-legacy-");
    const legacyDirectory = path.join(legacyCacheRoot, published.contentMd5);
    await fs.mkdir(legacyDirectory, { mode: 0o700 });
    await fs.copyFile(path.join(published.cachePath, "bundle.json"), path.join(legacyDirectory, "bundle.json"));
    await fs.copyFile(path.join(published.cachePath, "manifest.json"), path.join(legacyDirectory, "manifest.json"));
    await fs.chmod(legacyDirectory, 0o500);
    const legacyCache = new PreparedNovelCache(sourceRoot, legacyCacheRoot);
    await expect(legacyCache.lookup(fixture.source)).resolves.toMatchObject({ status: "already-cached", cachePath: legacyDirectory });
    await expect(legacyCache.publish(fixture.source)).resolves.toMatchObject({ status: "already-cached", bundleHash: published.bundleHash });
    await expect(legacyCache.listRevisions(fixture.source)).resolves.toEqual([
      expect.objectContaining({ bundleHash: published.bundleHash, active: true }),
    ]);

    const semanticLegacyRoot = await temporaryRoot("nwh-prepared-semantic-legacy-");
    const semanticLegacyBase = path.join(semanticLegacyRoot, published.contentMd5);
    const currentBundle = JSON.parse(await fs.readFile(path.join(published.cachePath, "bundle.json"), "utf8")) as Record<string, unknown>;
    delete currentBundle.compilerFingerprint;
    const legacyCanonical = currentBundle.canonical as Record<string, unknown>;
    delete legacyCanonical.propositions;
    delete legacyCanonical.attributions;
    delete legacyCanonical.eventParticipations;
    delete legacyCanonical.eventRelations;
    const legacyHash = contentHash(currentBundle);
    const semanticLegacyRevision = path.join(semanticLegacyBase, "revisions", legacyHash);
    await fs.mkdir(semanticLegacyRevision, { recursive: true });
    await fs.writeFile(path.join(semanticLegacyRevision, "bundle.json"), `${canonicalJson(currentBundle)}\n`);
    await fs.writeFile(path.join(semanticLegacyRevision, "manifest.json"), `${canonicalJson({
      version: 1,
      contentMd5: published.contentMd5,
      contentSha256: fixture.source.contentSha256,
      sourceId: fixture.source.id,
      bundleHash: legacyHash,
      createdAt: new Date(0).toISOString(),
    })}\n`);
    await fs.writeFile(path.join(semanticLegacyBase, "active.json"), `${canonicalJson({
      version: 1,
      contentMd5: published.contentMd5,
      bundleHash: legacyHash,
      updatedAt: new Date(0).toISOString(),
    })}\n`);
    await expect(new PreparedNovelCache(sourceRoot, semanticLegacyRoot).lookup(fixture.source)).resolves.toMatchObject({
      status: "miss",
      bundleHash: legacyHash,
      requiresReparse: true,
      reason: expect.stringContaining("incompatible semantic pipeline"),
    });
  });
});

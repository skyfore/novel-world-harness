import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { pinBranchPreparationContexts, WorldContextStore } from "../src/world/context.js";
import { WorldEngine } from "../src/world/engine.js";
import { ActorModelStore } from "../src/world/actors.js";
import { canonicalJson, contentHash } from "../src/world/canonical.js";
import { DEFAULT_STATE_FIELDS } from "../src/world/state.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("CanonicalModelStore revisions", () => {
  it("moves a logical ref to a new immutable revision without deleting history", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-canon-revision-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] });
    const first = await canon.currentRevision("entities", "hero");
    expect(first).not.toBeNull();

    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: ["The Hero"], evidence: [] });
    const second = await canon.currentRevision("entities", "hero");
    expect(second).not.toBeNull();
    expect(second?.hash).not.toBe(first?.hash);
    expect((await canon.getEntity("hero")).aliases).toEqual(["The Hero"]);

    const revisions = await canon.listRevisions("entities", "hero");
    expect(revisions).toHaveLength(2);
    expect(revisions.map((revision) => revision.hash)).toContain(first?.hash);
    expect(revisions.map((revision) => revision.hash)).toContain(second?.hash);
    await expect(canon.getEntityRevision("hero", first!.hash)).resolves.toMatchObject({ aliases: [] });
  });

  it("pins proposition content and attribution separately from mutable canonical refs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-semantic-context-revision-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    const contexts = new WorldContextStore(root, canon);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] });
    await canon.putProposition({
      id: "hero-ready",
      subjectEntityId: "hero",
      relationId: "ready",
      object: { kind: "literal", value: true },
      polarity: "positive",
      modality: "asserted",
      evidence: [],
    });
    await canon.putAttribution({
      id: "narrator-hero-ready",
      propositionId: "hero-ready",
      holderKind: "narrator",
      attitude: "asserts",
      certainty: 1,
      evidence: [],
    });
    const first = await contexts.captureCurrent();

    await canon.putProposition({
      id: "hero-ready",
      subjectEntityId: "hero",
      relationId: "ready",
      object: { kind: "literal", value: false },
      polarity: "positive",
      modality: "asserted",
      evidence: [],
    });
    const latest = await contexts.captureCurrent();
    const pinned = await contexts.load(first.canonicalSnapshotHash!);

    expect(pinned.propositions?.get("hero-ready")?.object).toEqual({ kind: "literal", value: true });
    expect(pinned.attributions?.get("narrator-hero-ready")?.propositionId).toBe("hero-ready");
    expect(latest.propositions?.get("hero-ready")?.object).toEqual({ kind: "literal", value: false });
    expect(pinned.claims?.size).toBe(0);
  });

  it("pins typed event and spatial revisions and refuses an incomplete runtime projection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-event-participation-context-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    const contexts = new WorldContextStore(root, canon);
    const spatialEvidence = [{
      span: {
        sourceId: "source",
        startLine: 1,
        endLine: 1,
        startByte: 0,
        endByte: 4,
        quoteHash: "d".repeat(64),
      },
      strength: "explicit" as const,
    }];
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] });
    await canon.putEntity({ id: "gate", kind: "location", canonicalName: "Gate", aliases: [], evidence: [] });
    await canon.putEntity({ id: "courtyard", kind: "location", canonicalName: "Courtyard", aliases: [], evidence: [] });
    await canon.putEvent({
      id: "gate-opens",
      title: "The gate opens",
      participants: [],
      storyTime: { kind: "ordinal", label: "opening", orderHint: 1 },
      preconditions: [],
      observedOutcome: { version: 1, operations: [] },
      evidence: [],
      causalParents: [],
      confidence: 1,
    });
    await canon.putEvent({
      id: "hero-enters-gate",
      title: "Hero enters the gate",
      participants: ["hero", "gate"],
      participantPresence: [{ entityId: "hero", mode: "physical" }],
      storyTime: { kind: "ordinal", label: "entry", orderHint: 2 },
      preconditions: [],
      observedOutcome: { version: 1, operations: [] },
      evidence: [],
      causalParents: ["gate-opens"],
      confidence: 1,
    });
    await canon.putEventParticipation({
      id: "hero-enters-gate-hero",
      eventId: "hero-enters-gate",
      entityId: "hero",
      role: "agent",
      presence: "physical",
      confidence: 1,
      evidence: [],
    });
    await canon.putEventRelation({
      id: "gate-opens-enables-entry",
      fromEventId: "gate-opens",
      toEventId: "hero-enters-gate",
      type: "enables",
      status: "inferred",
      confidence: 0.9,
      mechanism: "Opening the gate makes entry possible.",
      evidence: [],
    });
    await canon.putEventParticipation({
      id: "hero-enters-gate-gate",
      eventId: "hero-enters-gate",
      entityId: "gate",
      role: "destination",
      confidence: 1,
      evidence: [],
    });
    await canon.putSpatialRelation({
      ontologyVersion: "spatial-v1",
      id: "gate-courtyard-route",
      kind: "route",
      fromLocationId: "gate",
      toLocationId: "courtyard",
      direction: "two-way",
      modes: ["foot"],
      duration: { minimum: 5, unit: "minute" },
      basis: "explicit",
      visibility: "public",
      knownByClaimIds: [],
      establishedByEventIds: [],
      retiredByEventIds: [],
      requires: [],
      blockedWhen: [],
      status: "supported",
      confidence: 1,
      evidence: spatialEvidence,
    });

    const first = await contexts.captureCurrent();
    const stored = JSON.parse(await fs.readFile(path.join(contexts.root, `${first.canonicalSnapshotHash}.json`), "utf8")) as { version: number };
    expect(stored.version).toBe(7);
    expect(first.events?.get("hero-enters-gate")?.participants).toEqual(["hero", "gate"]);
    expect(first.eventParticipations).toContainEqual(expect.objectContaining({ id: "hero-enters-gate-hero", role: "agent" }));
    expect(first.eventRelations).toContainEqual(expect.objectContaining({ id: "gate-opens-enables-entry", type: "enables" }));
    expect(first.spatialRelations).toContainEqual(expect.objectContaining({
      id: "gate-courtyard-route",
      duration: { minimum: 5, unit: "minute" },
    }));

    await canon.putEventParticipation({
      id: "hero-enters-gate-hero",
      eventId: "hero-enters-gate",
      entityId: "hero",
      role: "experiencer",
      presence: "physical",
      confidence: 0.8,
      evidence: [],
    });
    await canon.putEventRelation({
      id: "gate-opens-enables-entry",
      fromEventId: "gate-opens",
      toEventId: "hero-enters-gate",
      type: "causes",
      status: "inferred",
      confidence: 0.7,
      mechanism: "The opened gate directly causes the entry opportunity.",
      evidence: [],
    });
    await canon.putSpatialRelation({
      ontologyVersion: "spatial-v1",
      id: "gate-courtyard-route",
      kind: "route",
      fromLocationId: "gate",
      toLocationId: "courtyard",
      direction: "two-way",
      modes: ["foot"],
      duration: { minimum: 10, unit: "minute" },
      basis: "explicit",
      visibility: "public",
      knownByClaimIds: [],
      establishedByEventIds: [],
      retiredByEventIds: [],
      requires: [],
      blockedWhen: [],
      status: "supported",
      confidence: 1,
      evidence: spatialEvidence,
    });
    const latest = await contexts.captureCurrent();
    const pinned = await contexts.load(first.canonicalSnapshotHash!);
    expect(latest.eventParticipations).toContainEqual(expect.objectContaining({ role: "experiencer" }));
    expect(pinned.eventParticipations).toContainEqual(expect.objectContaining({ role: "agent" }));
    expect(latest.eventRelations).toContainEqual(expect.objectContaining({ type: "causes" }));
    expect(pinned.eventRelations).toContainEqual(expect.objectContaining({ type: "enables" }));
    expect(latest.spatialRelations).toContainEqual(expect.objectContaining({ duration: { minimum: 10, unit: "minute" } }));
    expect(pinned.spatialRelations).toContainEqual(expect.objectContaining({ duration: { minimum: 5, unit: "minute" } }));

    await canon.removeCurrent("event-participations", "hero-enters-gate-gate");
    await expect(contexts.captureCurrent()).rejects.toThrow("INCOMPLETE_EVENT_PARTICIPATION");
  });

  it("pins branch projection to the canonical snapshot captured at genesis", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-context-snapshot-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    const contexts = new WorldContextStore(root, canon);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] });
    const firstContext = await contexts.captureCurrent();
    const firstEngine = new WorldEngine(root, firstContext, (hash) => contexts.load(hash));
    const head = await firstEngine.createBranch("original", "Original", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    });

    await canon.putEntity({ id: "hero", kind: "artifact", canonicalName: "Hero relic", aliases: [], evidence: [] });
    const latestContext = await contexts.captureCurrent();
    expect(latestContext.canonicalSnapshotHash).not.toBe(firstContext.canonicalSnapshotHash);
    const reopened = new WorldEngine(root, latestContext, (hash) => contexts.load(hash));

    await expect(reopened.projector.project(head)).resolves.toMatchObject({ values: { hero: { "character.alive": true } } });
    await expect(reopened.contextForCommit(head)).resolves.toMatchObject({ canonicalSnapshotHash: firstContext.canonicalSnapshotHash });
    expect((await reopened.contextForCommit(head)).entities.get("hero")?.kind).toBe("character");
    await expect(reopened.createBranch("latest", "Latest", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    })).rejects.toThrow("does not apply to artifact");
  });

  it("pins actor policy for legacy version-1 branch snapshots before current policy changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-legacy-context-snapshot-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    const actors = new ActorModelStore(root);
    const contexts = new WorldContextStore(root, canon);
    const evidence = [{
      span: { sourceId: "source", startLine: 1, endLine: 1, startByte: 0, endByte: 4, quoteHash: "a".repeat(64) },
      strength: "explicit" as const,
    }];
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] });
    await actors.putGoal({ id: "hero-goal", actorId: "hero", description: "Old policy", priority: 0.5, requiresKnowledge: [], evidence });
    await actors.putGoal({ id: "foreign-goal", actorId: "foreign-actor", description: "Foreign policy", priority: 1, requiresKnowledge: [], evidence });
    const heroRef = await canon.currentRevision("entities", "hero");
    if (!heroRef) throw new Error("missing hero revision");
    const legacySnapshot = {
      version: 1 as const,
      entities: [heroRef],
      claims: [],
      events: [],
      rules: [],
      stateFields: DEFAULT_STATE_FIELDS,
    };
    const legacyHash = contentHash(legacySnapshot);
    await fs.mkdir(contexts.root, { recursive: true });
    await fs.writeFile(path.join(contexts.root, `${legacyHash}.json`), `${canonicalJson(legacySnapshot)}\n`);
    const engine = new WorldEngine(root, await contexts.load(legacyHash), (hash) => contexts.load(hash));
    const head = await engine.createBranch("legacy", "Legacy");

    expect(await pinBranchPreparationContexts(root)).toBe(1);
    await actors.putGoal({ id: "hero-goal", actorId: "hero", description: "New policy", priority: 0.8, requiresKnowledge: [], evidence });
    const reopened = new WorldEngine(root, await contexts.captureCurrent(), (hash) => contexts.load(hash));
    expect((await reopened.contextForCommit(head)).actorGoals?.[0]?.description).toBe("Old policy");
    expect((await reopened.contextForCommit(head)).actorGoals?.map((goal) => goal.id)).toEqual(["hero-goal"]);
    expect(reopened.context.actorGoals?.find((goal) => goal.id === "hero-goal")?.description).toBe("New policy");
  });

  it("loads an unpinned legacy snapshot without injecting current global policy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-legacy-context-fail-closed-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    const actors = new ActorModelStore(root);
    const contexts = new WorldContextStore(root, canon);
    const evidence = [{
      span: { sourceId: "current-source", startLine: 1, endLine: 1, startByte: 0, endByte: 4, quoteHash: "b".repeat(64) },
      strength: "explicit" as const,
    }];
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] });
    await actors.putGoal({ id: "current-goal", actorId: "hero", description: "Must not enter legacy context", priority: 1, requiresKnowledge: [], evidence });
    await actors.putModel({ actorId: "hero", traits: { mustNotEnter: 1 }, decisionBiases: {}, evidence });
    const heroRef = await canon.currentRevision("entities", "hero");
    if (!heroRef) throw new Error("missing hero revision");
    const legacySnapshot = {
      version: 1 as const,
      entities: [heroRef],
      claims: [],
      events: [],
      rules: [],
      stateFields: DEFAULT_STATE_FIELDS,
    };
    const legacyHash = contentHash(legacySnapshot);
    await fs.mkdir(contexts.root, { recursive: true });
    await fs.writeFile(path.join(contexts.root, `${legacyHash}.json`), `${canonicalJson(legacySnapshot)}\n`);

    const loaded = await contexts.load(legacyHash);
    expect(loaded.actorGoals).toEqual([]);
    expect(loaded.actorModels?.size).toBe(0);
    expect(loaded.possibilityTemplates).toEqual([]);
  });

  it("rejects a hash-valid source-scoped snapshot that references a foreign-source artifact", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-context-source-integrity-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    const contexts = new WorldContextStore(root, canon);
    const foreignEvidence = [{
      span: { sourceId: "novel-b", startLine: 1, endLine: 1, startByte: 0, endByte: 4, quoteHash: "c".repeat(64) },
      strength: "explicit" as const,
    }];
    await canon.putEntity({
      id: "foreign-hero",
      kind: "character",
      canonicalName: "Foreign Hero",
      aliases: [],
      evidence: foreignEvidence,
    });
    const foreignRef = await canon.currentRevision("entities", "foreign-hero");
    if (!foreignRef) throw new Error("missing foreign entity revision");
    const invalidScopedSnapshot = {
      version: 3 as const,
      sourceId: "novel-a",
      entities: [foreignRef],
      claims: [],
      events: [],
      rules: [],
      actorGoals: [],
      actorModels: [],
      possibilities: [],
      stateFields: DEFAULT_STATE_FIELDS,
    };
    const snapshotHash = contentHash(invalidScopedSnapshot);
    await fs.mkdir(contexts.root, { recursive: true });
    await fs.writeFile(path.join(contexts.root, `${snapshotHash}.json`), `${canonicalJson(invalidScopedSnapshot)}\n`);

    await expect(contexts.load(snapshotHash)).rejects.toThrow(
      "World snapshot artifact foreign-hero is not exclusively grounded in active novel source novel-a",
    );
  });
});

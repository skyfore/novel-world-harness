import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { PlayApplicationService } from "../src/application/play-service.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { choosePlayExperience } from "../src/world/play-choice.js";
import { listPlayableCharacters, selectPlayExperience } from "../src/world/play-experience.js";
import { createWorldBranch } from "../src/world/instance.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { projectActorScene } from "../src/world/scene.js";
import { readFrozenWorldBase } from "../src/world/base.js";
import { buildPlayOpeningFrame, playSceneChoicePrompt, playScenePrompt, playerSceneModelFrame } from "../src/world/play-opening.js";
import { WebEventBroker } from "../src/web/event-stream.js";
import { OperationManager } from "../src/web/operation-manager.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("character-specific play entry", () => {
  it("creates a new immutable branch at a later character's first embodied scene with reader-only prior context", async () => {
    const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-entry-cache-"));
    const publisherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-entry-publisher-"));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-entry-player-"));
    roots.push(cacheRoot, publisherRoot, root);
    const content = "Hero crosses the prologue.\nA letter is read.\nLater enters the hall.\n";
    const published = await createEvidenceFixture(publisherRoot, content, "novel.txt");
    const canon = new CanonicalModelStore(publisherRoot);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: published.evidence("Hero") });
    await canon.putEntity({ id: "later", kind: "character", canonicalName: "Later", aliases: [], evidence: published.evidence("Later") });
    await canon.putEntity({ id: "hall", kind: "location", canonicalName: "The Hall", aliases: [], evidence: published.evidence("hall") });
    await canon.putEvent({
      id: "prologue-crossing",
      title: "Hero crosses the prologue",
      readerSummary: "Hero crosses the prologue threshold, setting the later summons in motion.",
      participants: ["hero"],
      participantPresence: [{ entityId: "hero", mode: "physical" }],
      storyTime: { kind: "ordinal", label: "prologue", orderHint: 0 },
      narrativeContext: { layerId: "main", discourseOrder: 0, mode: "scene", viewpointActorId: "hero" },
      preconditions: [],
      observedOutcome: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.momentum", value: 1 }],
      },
      evidence: published.evidence("Hero crosses the prologue."),
      causalParents: [],
      confidence: 1,
    });
    await canon.putEvent({
      id: "later-enters",
      title: "Later enters the hall",
      readerSummary: "Later enters the hall and answers the summons.",
      participants: ["later"],
      participantPresence: [{ entityId: "later", mode: "physical" }],
      storyTime: { kind: "ordinal", label: "first act", orderHint: 1 },
      narrativeContext: { layerId: "main", discourseOrder: 1, mode: "scene", viewpointActorId: "later" },
      characterEntryCheckpoints: [{
        actorId: "later",
        readerSetup: "The prologue crossing has led to a summons; Later is at the hall before deciding how to answer it.",
        actorObservation: "You are at the hall with the summons still unanswered.",
        participantPresence: [{ entityId: "later", mode: "physical" }],
        delta: {
          version: 1,
          operations: [
            { op: "set", entityId: "later", field: "character.location", value: "hall" },
            { op: "set", entityId: "later", field: "character.plan", value: "decide how to answer" },
          ],
        },
      }],
      preconditions: [],
      observedOutcome: {
        version: 1,
        operations: [{ op: "set", entityId: "later", field: "character.plan", value: "answer the summons" }],
      },
      evidence: published.evidence("Later enters the hall."),
      causalParents: ["prologue-crossing"],
      confidence: 1,
    });
    await new InitialWorldStore(publisherRoot).put({
      version: 1,
      readerSetup: "Hero stands at the prologue threshold, just before the crossing that opens the novel.",
      participantPresence: [{ entityId: "hero", mode: "physical" }],
      delta: {
        version: 1,
        operations: [
          { op: "set", entityId: "hero", field: "character.plan", value: "cross the gate" },
          { op: "set", entityId: "later", field: "character.alive", value: true },
        ],
      },
      checkpoint: {
        mode: "chronological",
        storyTime: { kind: "ordinal", label: "prologue", orderHint: 0 },
        beforeCanonicalEventId: "prologue-crossing",
        rationale: "Immediately before the prologue's first transition",
      },
      evidence: published.evidence("Hero crosses the prologue."),
    });
    const batches = await prepareCompilerBatches(publisherRoot, published.source);
    await new CompilerBatchStore(publisherRoot).replaceCompleted(published.source.id, batches.map((batch) => batch.id));
    const revision = await new PreparedNovelCache(publisherRoot, cacheRoot).publish(published.source);

    const local = await createEvidenceFixture(root, content, "novel.txt");
    await createWorldBranch(root, "main", undefined, local.source.id, cacheRoot);
    const openingWorld = await openWorkspaceWorld(root);
    const openingBranch = await openingWorld.engine.branches.read("main");
    const openingCommit = await openingWorld.engine.objects.getCommit(openingBranch.headCommitId);
    const openingGenesis = await openingWorld.engine.objects.getEvent(openingCommit.eventHashes[0]!);
    expect(openingGenesis.participantPresence).toEqual([{ entityId: "hero", mode: "physical" }]);
    const originalOpening = await buildPlayOpeningFrame(
      root,
      "main",
      "hero",
      local.source.id,
      undefined,
      cacheRoot,
    );
    expect(originalOpening.readerPrelude).toMatchObject({
      authority: "reader-orientation-only",
      entryTitle: "小说开场",
      entrySetup: "Hero stands at the prologue threshold, just before the crossing that opens the novel.",
    });
    await expect(listPlayableCharacters(root, { branchId: "main", source: local.source.id })).resolves.toMatchObject({
      characters: [{ id: "hero" }],
    });
    const webEvents = new WebEventBroker();
    const webOperations = new OperationManager(webEvents);
    const webPlay = new PlayApplicationService({
      root,
      events: webEvents,
      operations: webOperations,
      preparedCacheRoot: cacheRoot,
    });
    await expect(webPlay.listCharacters("main", local.source.id)).resolves.toMatchObject({
      characters: [
        { id: "hero", availability: "current-head" },
        { id: "later", availability: "entry-checkpoint", entryKind: "canonical-scene" },
      ],
    });
    const sourceRoles = await webPlay.listSourceRoles(local.source.id);
    expect(sourceRoles).toMatchObject({
      sourceId: local.source.id,
      preparedRevisionHash: revision.bundleHash,
      roles: [
        { id: "hero", entryKind: "opening" },
        { id: "later", entryKind: "canonical-scene" },
      ],
    });
    await expect(webPlay.startFreshPlay({
      sourceId: local.source.id,
      preparedRevisionHash: "0".repeat(64),
      actorId: "hero",
      clientRequestId: "fresh-hero-stale-base",
    })).rejects.toMatchObject({
      statusCode: 409,
      detail: { code: "FROZEN_BASE_MOVED", retry: { copyField: "preparedRevisionHash" } },
    });

    const firstHeroPlay = await webPlay.startFreshPlay({
      sourceId: local.source.id,
      preparedRevisionHash: revision.bundleHash,
      actorId: "hero",
      clientRequestId: "fresh-hero-one",
    });
    const repeatedFirstHeroPlay = await webPlay.startFreshPlay({
      sourceId: local.source.id,
      preparedRevisionHash: revision.bundleHash,
      actorId: "hero",
      clientRequestId: "fresh-hero-one",
    });
    const secondHeroPlay = await webPlay.startFreshPlay({
      sourceId: local.source.id,
      preparedRevisionHash: revision.bundleHash,
      actorId: "hero",
      clientRequestId: "fresh-hero-two",
    });
    expect(repeatedFirstHeroPlay.reused).toBe(true);
    expect(repeatedFirstHeroPlay.instance.branchId).toBe(firstHeroPlay.instance.branchId);
    expect(repeatedFirstHeroPlay.session.session.id).toBe(firstHeroPlay.session.session.id);
    expect(firstHeroPlay.instance.branchId).not.toBe(secondHeroPlay.instance.branchId);
    expect(firstHeroPlay.session.session.conversationId).not.toBe(secondHeroPlay.session.session.conversationId);
    await expect(openingWorld.engine.branches.read(firstHeroPlay.instance.branchId)).resolves.toMatchObject({
      entryActorId: "hero",
    });
    await expect(openingWorld.engine.branches.read(secondHeroPlay.instance.branchId)).resolves.toMatchObject({
      entryActorId: "hero",
    });
    expect(firstHeroPlay.base).toEqual(secondHeroPlay.base);
    expect(firstHeroPlay.base).toEqual({
      version: 1,
      sourceId: local.source.id,
      sourceContentSha256: local.source.contentSha256,
      preparedRevisionHash: revision.bundleHash,
      canonicalSnapshotHash: firstHeroPlay.base.canonicalSnapshotHash,
    });
    expect(Object.isFrozen(await readFrozenWorldBase(root, firstHeroPlay.instance.branchId))).toBe(true);
    const mainHeadBeforeFreshMove = await openingWorld.engine.branches.readHead("main");
    const secondHeadBeforeFreshMove = secondHeroPlay.instance.headCommitId;
    const firstOpening = await buildPlayOpeningFrame(
      root,
      firstHeroPlay.instance.branchId,
      "hero",
      local.source.id,
      firstHeroPlay.session.session.conversationId,
      cacheRoot,
    );
    expect(firstOpening.readerPrelude).toEqual({
      authority: "reader-orientation-only",
      entryTitle: "小说开场",
      entrySetup: "Hero stands at the prologue threshold, just before the crossing that opens the novel.",
      storySoFar: [],
    });
    const openingModelFrame = playerSceneModelFrame(firstOpening);
    expect(openingModelFrame).toMatchObject({
      narrativeContract: {
        person: "third",
        focalCharacter: "Hero",
        narratorAddressesPlayer: false,
      },
    });
    expect(playScenePrompt(openingModelFrame, "opening")).toContain("Hero stands at the prologue threshold");
    expect(playerSceneModelFrame(firstOpening, "blocked")).not.toHaveProperty("readerPrelude");
    expect(playScenePrompt(openingModelFrame, "blocked")).not.toContain("Hero stands at the prologue threshold");
    expect(playSceneChoicePrompt(openingModelFrame, "opening")).not.toContain("Hero stands at the prologue threshold");

    const freshWorld = await openWorkspaceWorld(root);
    const firstMove = await freshWorld.engine.commitProposal({
      proposalId: "first-hero-shouts",
      branchId: firstHeroPlay.instance.branchId,
      expectedParentCommit: firstHeroPlay.instance.headCommitId,
      source: "player",
      title: "Hero calls into the threshold",
      actorObservations: [{ actorId: "hero", summary: "Hero hears the call carry across the threshold." }],
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "wait for an answer" }],
      },
      causalParents: [],
      evidence: [],
    });
    await expect(freshWorld.engine.branches.readHead(firstHeroPlay.instance.branchId)).resolves.toBe(firstMove.newHead);
    await expect(freshWorld.engine.branches.readHead(secondHeroPlay.instance.branchId)).resolves.toBe(secondHeadBeforeFreshMove);
    await expect(freshWorld.engine.branches.readHead("main")).resolves.toBe(mainHeadBeforeFreshMove);
    expect((await freshWorld.engine.projector.project(secondHeadBeforeFreshMove)).values.hero?.["character.plan"]).toBe("cross the gate");
    expect((await freshWorld.engine.projector.project(firstMove.newHead)).values.hero?.["character.plan"]).toBe("wait for an answer");
    expect(await readFrozenWorldBase(root, firstHeroPlay.instance.branchId)).toEqual(firstHeroPlay.base);

    const webLater = await webPlay.createSession({
      branchId: "main",
      sourceId: local.source.id,
      actorId: "later",
      clientRequestId: "web-later-entry",
    });
    expect(webLater.session).toMatchObject({
      id: expect.stringMatching(/^play-[0-9a-f-]{36}$/),
      actorId: "later",
    });
    expect(webLater.session.branchId).not.toBe("main");
    const laterOpening = await buildPlayOpeningFrame(
      root,
      webLater.session.branchId,
      "later",
      local.source.id,
      webLater.session.conversationId,
      cacheRoot,
    );
    expect(laterOpening.readerPrelude).toMatchObject({
      authority: "reader-orientation-only",
      entrySetup: "The prologue crossing has led to a summons; Later is at the hall before deciding how to answer it.",
      storySoFar: [{ title: "Hero crosses the prologue", participantNames: ["Hero"] }],
    });
    await selectPlayExperience(root, { branchId: "main", character: "hero", source: local.source.id });
    const selection = await choosePlayExperience(root, {
      source: local.source.id,
      branchId: "main",
      character: "Later",
      instanceMode: "switch",
      preparedCacheRoot: cacheRoot,
    }, async () => { throw new Error("an explicit grounded character should not require a prompt"); });
    expect(selection).toMatchObject({
      actor: { id: "later" },
      readerContext: {
        entryCanonicalEventId: "later-enters",
        storySoFar: [{ eventId: "prologue-crossing" }],
      },
    });
    expect(selection!.session.branchId).not.toBe("main");

    const { engine } = await openWorkspaceWorld(root);
    const branch = await engine.branches.read(selection!.session.branchId);
    expect(branch.preparedRevisionHash).toBe(revision.bundleHash);
    const genesis = await engine.objects.getCommit(branch.headCommitId);
    const event = await engine.objects.getEvent(genesis.eventHashes[0]!);
    expect(event.participantPresence).toEqual([{ entityId: "later", mode: "physical" }]);
    expect(event.actorObservations).toEqual([{ actorId: "later", summary: "You are at the hall with the summons still unanswered." }]);
    expect(event.realizesCanonicalEventIds).toContain("prologue-crossing");
    expect(event.realizesCanonicalEventIds).not.toContain("later-enters");
    const state = await engine.projector.project(branch.headCommitId);
    expect(state.values.hero?.["character.momentum"]).toBe(1);
    expect(state.values.later?.["character.location"]).toBe("hall");
    expect(state.values.later?.["character.plan"]).toBe("decide how to answer");
    expect(state.values.later?.["character.plan"]).not.toBe("answer the summons");
    const scene = await projectActorScene(engine, "later", branch.headCommitId, local.source.id);
    expect(scene.label).toBe("The Hall");
    expect(scene.recentEvents).toContainEqual(expect.objectContaining({
      title: "You are at the hall with the summons still unanswered.",
    }));
    webOperations.shutdown();
  });
});

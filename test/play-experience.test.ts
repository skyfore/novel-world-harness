import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import {
  inspectPlayExperience,
  listPlayableCharacters,
  performPlayTurn,
  selectPlayExperience,
} from "../src/world/play-experience.js";
import { workspaceStateDir } from "../src/agent/runtime-paths.js";
import { KnowledgeProjector } from "../src/world/knowledge.js";
import { PlayConversationStore } from "../src/world/play-conversation.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("play experience catalog", () => {
  it("turns a player's direct narrative cue into a separately validated immediate world event", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-response-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(
      root,
      "路明非拆开信封。卡塞尔学院邀请路明非参加面试。\n",
      "dragon-opening.txt",
    );
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({
      id: "lu-mingfei",
      kind: "character",
      canonicalName: "路明非",
      aliases: [],
      evidence: fixture.evidence("路明非"),
    });
    await canon.putEntity({
      id: "interview-letter",
      kind: "artifact",
      canonicalName: "卡塞尔学院面试邀请信",
      aliases: ["信封"],
      evidence: fixture.evidence("信封"),
    });
    await canon.putEntity({
      id: "cassell-college",
      kind: "institution",
      canonicalName: "卡塞尔学院",
      aliases: [],
      evidence: fixture.evidence("卡塞尔学院"),
    });
    await canon.putClaim({
      id: "cassell-invites-lu",
      subject: "cassell-college",
      predicate: "邀请参加面试",
      object: "lu-mingfei",
      epistemicType: "explicit-fact",
      evidence: fixture.evidence("卡塞尔学院邀请路明非参加面试"),
    });
    await canon.putEvent({
      id: "lu-receives-interview-letter",
      title: "路明非收到卡塞尔学院的面试邀请信",
      participants: ["lu-mingfei", "interview-letter", "cassell-college"],
      storyTime: { kind: "ordinal", label: "opening" },
      preconditions: [{ op: "fact-equals", entityId: "lu-mingfei", field: "character.alive", value: true }],
      observedOutcome: {
        version: 1,
        operations: [
          { op: "set", entityId: "interview-letter", field: "artifact.owner", value: "lu-mingfei" },
          { op: "set", entityId: "interview-letter", field: "artifact.delivered", value: true },
        ],
      },
      observedKnowledge: {
        version: 1,
        operations: [{
          op: "learn",
          actorId: "lu-mingfei",
          claimId: "cassell-invites-lu",
          status: "knows",
          confidence: 1,
        }],
      },
      evidence: fixture.evidence("卡塞尔学院邀请路明非参加面试"),
      causalParents: [],
      confidence: 1,
    });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "lu-mingfei", field: "character.alive", value: true }],
    }, undefined, fixture.source.id);

    let offeredResponseTitle: string | undefined;
    const outcome = await performPlayTurn({
      root,
      branchId: "main",
      actorId: "lu-mingfei",
      utterance: "我拿起那个信封，拆开看看里面写了什么。",
      advanceActors: 0,
      advanceBackground: 0,
      translator: () => ({
        title: "路明非拆开信封",
        intent: {
          kind: "act",
          summary: "拆开指向自己的信封并阅读内容",
          controlledAct: {
            eventTitle: "路明非拆开信封",
            actorObservation: "你拿起信封，拆开封口，准备阅读里面的文字。",
          },
          desiredEffect: "看清信里的内容并知道寄信方的来意",
          targets: [{ kind: "described", description: "那个信封" }],
        },
        participants: [],
        preconditions: [],
        proposedDelta: { version: 1, operations: [] },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      }),
      worldResponseResolver: (input) => {
        expect(input.candidate.intent?.desiredEffect).toContain("信里的内容");
        expect(input.eligibleResponses).toHaveLength(1);
        offeredResponseTitle = input.eligibleResponses[0]?.title;
        return { decision: "select", possibilityId: input.eligibleResponses[0]!.possibilityId };
      },
    });

    expect(outcome.result.accepted).toBe(true);
    expect(outcome.result.contextBefore.referenceableEntities.map((entity) => entity.id)).not.toContain("interview-letter");
    expect(outcome.result.contextBefore.knowledge).toEqual([]);
    expect(offeredResponseTitle).toBe("路明非收到卡塞尔学院的面试邀请信");
    expect(outcome.worldResponseCandidates).toEqual([
      expect.objectContaining({
        title: "路明非收到卡塞尔学院的面试邀请信",
        knowledgeEffects: [expect.stringContaining("路明非 learns")],
      }),
    ]);
    expect(outcome.worldResponseEvents).toEqual([
      expect.objectContaining({
        title: "路明非收到卡塞尔学院的面试邀请信",
        possibilityId: "canon-lu-receives-interview-letter",
      }),
    ]);
    expect(outcome.finalHead).not.toBe(outcome.result.newHead);
    expect(outcome.logicalStep).toBe(2);
    const reopened = await openWorkspaceWorld(root);
    const state = await reopened.engine.projector.project(outcome.finalHead);
    expect(state.values["interview-letter"]).toMatchObject({
      "artifact.owner": "lu-mingfei",
      "artifact.delivered": true,
    });
    const knowledge = await new KnowledgeProjector(reopened.engine).view("lu-mingfei", outcome.finalHead);
    expect(knowledge.knowledge).toContainEqual(expect.objectContaining({
      fact: expect.objectContaining({ claimId: "cassell-invites-lu", status: "knows" }),
    }));
    const responseEvent = await reopened.engine.objects.getEvent(outcome.worldResponseEvents[0]!.eventHash);
    expect(responseEvent.realizesCanonicalEventIds).toEqual(["lu-receives-interview-letter"]);

    const auditDirectory = path.join(workspaceStateDir(root), "world", "v1", "play", "turns", "main");
    const [auditFile] = await fs.readdir(auditDirectory);
    const audit = JSON.parse(await fs.readFile(path.join(auditDirectory, auditFile!), "utf8")) as Record<string, unknown>;
    expect(audit).toMatchObject({
      worldResponseResolution: { decision: "select", possibilityId: "canon-lu-receives-interview-letter" },
      worldResponseCandidates: [expect.objectContaining({ title: "路明非收到卡塞尔学院的面试邀请信" })],
      worldResponseEvents: [expect.objectContaining({ title: "路明非收到卡塞尔学院的面试邀请信" })],
    });
  });

  it("lists novels, filters branch-pinned characters by source, and reports durable progress", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-experience-"));
    roots.push(root);
    const first = await createEvidenceFixture(root, "Hero waits. Witness listens.\n", "first.txt");
    const second = await createEvidenceFixture(root, "Rival waits.\n", "second.txt");
    await (await WorkspaceStore.create(root)).ensureProject({ name: "Two Stories", language: "en" });
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: first.evidence("Hero") });
    await canon.putEntity({ id: "witness", kind: "character", canonicalName: "Witness", aliases: [], evidence: first.evidence("Witness") });
    await canon.putEntity({ id: "rival", kind: "character", canonicalName: "Rival", aliases: [], evidence: second.evidence("Rival") });
    const { engine } = await openWorkspaceWorld(root);
    await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "rival", field: "character.alive", value: true },
      ],
    });

    const before = await inspectPlayExperience(root);
    expect(before.project?.name).toBe("Two Stories");
    expect(before.novels.map((source) => source.title)).toEqual(["first.txt", "second.txt"]);
    expect(before.instances).toEqual([
      expect.objectContaining({ branchId: "main", logicalStep: 0, commitCount: 1, eventCount: 1, active: false }),
    ]);
    await expect(listPlayableCharacters(root, { source: first.source.title })).resolves.toMatchObject({
      branchId: "main",
      source: { id: first.source.id },
      characters: [
        { id: "hero", canonicalName: "Hero" },
      ],
    });

    await expect(selectPlayExperience(root, {
      branchId: "main",
      source: first.source.id,
      character: "Witness",
    })).rejects.toThrow("Available: Hero (hero)");

    const selection = await selectPlayExperience(root, { branchId: "main", source: first.source.id, character: "Hero" });
    expect(selection.session).toMatchObject({ branchId: "main", sourceId: first.source.id, actorId: "hero" });
    expect(selection.readinessWarnings).toEqual([]);
    expect(selection.readinessDiagnostics).toContainEqual(expect.stringContaining("当前位置尚未写入"));
    const outcome = await performPlayTurn({
      root,
      branchId: "main",
      actorId: "hero",
      utterance: "I ask Rival to wait.",
      advanceBackground: 0,
      translator: (input) => {
        expect(input.context.referenceableEntities.map((entity) => entity.id)).not.toContain("rival");
        return {
          title: "Hero waits",
          participants: [],
          preconditions: [],
          proposedDelta: { version: 1, operations: [] },
          requiresKnowledge: [],
          forbidsKnowledge: [],
        };
      },
    });
    expect(outcome.auditId).toMatch(/^turn-/);
    const auditDirectory = path.join(workspaceStateDir(root), "world", "v1", "play", "turns", "main");
    const auditFiles = await fs.readdir(auditDirectory);
    expect(auditFiles).toHaveLength(1);
    const audit = JSON.parse(await fs.readFile(path.join(auditDirectory, auditFiles[0]!), "utf8")) as Record<string, unknown>;
    expect(audit).toMatchObject({
      id: outcome.auditId,
      accepted: true,
      stage: "committed",
      utterance: "I ask Rival to wait.",
      origin: "cli",
    });
    const rejected = await performPlayTurn({
      root,
      branchId: "main",
      actorId: "hero",
      utterance: "Act on an impossible condition.",
      translator: () => ({
        title: "Unsupported action",
        participants: [],
        preconditions: [{ op: "fact-equals", entityId: "hero", field: "character.alive", value: false }],
        proposedDelta: { version: 1, operations: [] },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      }),
    });
    expect(rejected.result.accepted).toBe(false);
    expect(await new PlayConversationStore(root).list("main")).toEqual([
      expect.objectContaining({ text: "I ask Rival to wait.", status: "accepted", role: "player" }),
      expect.objectContaining({ text: "Act on an impossible condition.", status: "rejected", role: "player" }),
    ]);
    const allAuditFiles = await fs.readdir(auditDirectory);
    const rejectedAudits = await Promise.all(allAuditFiles.map(async (file) =>
      JSON.parse(await fs.readFile(path.join(auditDirectory, file), "utf8")) as {
        id: string;
        issues: Array<{ code: string }>;
        candidate?: { preconditions: unknown[] };
      }));
    expect(rejectedAudits.find((entry) => entry.id === rejected.auditId)).toMatchObject({
      issues: [expect.objectContaining({ code: "PLAYER_PRECONDITION_UNSATISFIED" })],
      candidate: { preconditions: [expect.objectContaining({ field: "character.alive", value: false })] },
    });

    const after = await inspectPlayExperience(root);
    expect(after.instances).toEqual([
      expect.objectContaining({
        branchId: "main",
        logicalStep: 1,
        commitCount: 2,
        eventCount: 2,
        active: true,
        sourceId: first.source.id,
        sourceTitle: first.source.title,
        actorId: "hero",
        actorName: "Hero",
        sessionAtHead: true,
        lastEventTitle: "Attempted player intent (not an asserted outcome): I ask Rival to wait.",
      }),
    ]);
  });

  it("requires an explicit instance when multiple branches exist and no resume state is saved", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-experience-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: [] });
    await canon.putEntity({ id: "rival", kind: "character", canonicalName: "Rival", aliases: [], evidence: [] });
    const { engine, runtime } = await openWorkspaceWorld(root);
    const mainHead = await engine.createBranch("alpha", "Alpha", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "rival", field: "character.alive", value: true },
      ],
    });
    await runtime.forkBranch("alpha", mainHead, "beta", "Beta");

    await expect(selectPlayExperience(root, { character: "hero" })).rejects.toThrow("Choose an instance");
    await expect(selectPlayExperience(root, { branchId: "alpha", character: "hero" })).resolves.toMatchObject({ actor: { id: "hero" } });
    await expect(selectPlayExperience(root, { branchId: "beta", character: "rival" })).resolves.toMatchObject({ actor: { id: "rival" } });
    await expect(selectPlayExperience(root, { branchId: "alpha" })).rejects.toThrow("Choose a character");

    const catalog = await inspectPlayExperience(root);
    expect(catalog.instances.find((instance) => instance.branchId === "alpha")).toMatchObject({ actorId: "hero", active: false });
    expect(catalog.instances.find((instance) => instance.branchId === "beta")).toMatchObject({ actorId: "rival", active: true });
  });

  it("reports persisted novel ownership and preserves it across forks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-experience-source-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero waits.\n", "owned-novel.txt");
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: fixture.evidence("Hero"),
    });
    const { engine, runtime } = await openWorkspaceWorld(root);
    const head = await engine.createBranch("owned", "Owned", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    }, undefined, fixture.source.id);
    await runtime.forkBranch("owned", head, "forked", "Forked");

    const catalog = await inspectPlayExperience(root);
    expect(catalog.instances).toEqual(expect.arrayContaining([
      expect.objectContaining({ branchId: "owned", sourceId: fixture.source.id, sourceTitle: fixture.source.title }),
      expect.objectContaining({ branchId: "forked", sourceId: fixture.source.id, sourceTitle: fixture.source.title }),
    ]));
  });
});

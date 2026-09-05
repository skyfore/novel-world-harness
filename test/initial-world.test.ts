import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { CompilerCommitService, CompilerValidator } from "../src/compiler/validator.js";
import { loadWorldContext } from "../src/world/context.js";
import { WorldEngine } from "../src/world/engine.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { KnowledgeProjector } from "../src/world/knowledge.js";
import { BranchStore } from "../src/world/store.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { worldCreateCommand } from "../src/commands/world.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("canonical initial world", () => {
  it("does not silently create an empty playable branch without an accepted initial world", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-initial-missing-"));
    roots.push(root);
    await expect(worldCreateCommand(root, "main")).rejects.toThrow("No accepted initial world");
  });

  it("requires an explicit source before creating a branch in a multi-novel workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-initial-source-scope-"));
    roots.push(root);
    const first = await createEvidenceFixture(root, "First novel.\n", "first.txt");
    await createEvidenceFixture(root, "Second novel.\n", "second.txt");
    const seedPath = path.join(root, "seed.json");
    await fs.writeFile(seedPath, JSON.stringify({ version: 1, operations: [] }), "utf8");

    await expect(worldCreateCommand(root, "ambiguous", seedPath))
      .rejects.toThrow("Multiple sources are registered; specify --source");
    await expect(worldCreateCommand(root, "first", seedPath, first.source.id)).resolves.toBeUndefined();
    await expect(new BranchStore(root).read("first"))
      .resolves.toMatchObject({ sourceId: first.source.id });
  });

  it("requires canonical entities before accepting the seed and replays it as genesis", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-initial-"));
    roots.push(root);
    const source = await createEvidenceFixture(root, "Hero (H) waits at the opening.\n");
    const proposals = new CompilerProposalService(root);
    const commits = new CompilerCommitService(root);

    await proposals.submit("initial-world", {
      proposalId: "initial",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
        knowledge: {
          version: 1,
          operations: [{ op: "learn", actorId: "hero", claimId: "opening-claim", status: "knows", confidence: 1 }],
        },
        evidence: source.evidence("Hero (H) waits at the opening."),
      },
      generatedBy: { worker: "test" },
    });
    const blocked = await commits.accept("initial-world", "initial");
    expect(blocked.accepted).toBe(false);

    await proposals.submit("entity", {
      proposalId: "hero-entity",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: ["H"], evidence: source.evidence("Hero (H)") },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("entity", "hero-entity")).accepted).toBe(true);
    await proposals.submit("claim", {
      proposalId: "opening-claim-proposal",
      payload: {
        id: "opening-claim",
        subject: "hero",
        predicate: "is present at the opening",
        object: true,
        epistemicType: "explicit-fact",
        evidence: source.evidence("Hero (H) waits at the opening."),
      },
      generatedBy: { worker: "test" },
    });
    expect((await commits.accept("claim", "opening-claim-proposal")).accepted).toBe(true);
    expect((await commits.accept("initial-world", "initial")).accepted).toBe(true);

    const initial = await new InitialWorldStore(root).get();
    expect(initial?.delta.operations).toHaveLength(1);
    const { context } = await loadWorldContext(root);
    const engine = new WorldEngine(root, context);
    const head = await engine.createBranch("main", "Main", initial!.delta, initial!.knowledge);
    expect((await engine.projector.project(head)).values.hero?.["character.alive"]).toBe(true);
    expect((await new KnowledgeProjector(engine).view("hero", head)).knowledge)
      .toMatchObject([{ fact: { claimId: "opening-claim", status: "knows" } }]);
  });

  it("commits source-grounded opening perception into Genesis", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-initial-observation-"));
    roots.push(root);
    const source = await createEvidenceFixture(root, "Hero watches a grey avatar flicker.\n");
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: source.evidence("Hero"),
    });
    await new InitialWorldStore(root).put({
      version: 1,
      participantPresence: [{ entityId: "hero", mode: "physical" }],
      actorObservations: [{ actorId: "hero", summary: "Hero sees the grey avatar flicker." }],
      delta: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.plan", value: "watch the screen" }],
      },
      evidence: source.evidence("Hero watches a grey avatar flicker."),
    });

    await worldCreateCommand(root, "main", undefined, source.source.id);
    const { engine } = await loadWorldContext(root).then((context) => ({
      engine: new WorldEngine(root, context.context),
    }));
    const head = await engine.branches.readHead("main");
    const commit = await engine.objects.getCommit(head);
    const genesis = await engine.objects.getEvent(commit.eventHashes[0]!);
    expect(genesis.actorObservations).toEqual([
      { actorId: "hero", summary: "Hero sees the grey avatar flicker." },
    ]);
  });

  it("rejects a Longzu-style first-use character name that has no unread-reader gloss", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-initial-first-use-gloss-"));
    roots.push(root);
    const source = await createEvidenceFixture(root, "路明非还在等。陈雯雯是他的同学。\n");
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "road", kind: "character", canonicalName: "路明非", aliases: [], evidence: source.evidence("路明非") });
    await canon.putEntity({ id: "chen-wenwen", kind: "character", canonicalName: "陈雯雯", aliases: [], evidence: source.evidence("陈雯雯") });
    const payload = {
      version: 1 as const,
      readerContext: {
        version: 1 as const,
        focalActorId: "road",
        facts: [
          { id: "focal", kind: "focal-identity" as const, summary: "路明非是开场焦点人物。", temporalClass: "at-checkpoint" as const, basis: "checkpoint-state" as const, entityIds: ["road"], focalKnowledgeClaimIds: [], dependsOnFactIds: [] },
          { id: "place", kind: "time-place" as const, summary: "路明非正在家里等待。", temporalClass: "at-checkpoint" as const, basis: "checkpoint-state" as const, entityIds: ["road"], focalKnowledgeClaimIds: [], dependsOnFactIds: [] },
          { id: "cause", kind: "causal-premise" as const, summary: "陈雯雯的消息使他开始等待。", temporalClass: "before-checkpoint" as const, basis: "source-narrator-established" as const, entityIds: ["road", "chen-wenwen"], focalKnowledgeClaimIds: [], dependsOnFactIds: [] },
          { id: "stance", kind: "actor-stance" as const, summary: "路明非对等待结果心情复杂。", temporalClass: "at-checkpoint" as const, basis: "checkpoint-state" as const, entityIds: ["road"], holderEntityId: "road", stance: "ambivalent" as const, focalKnowledgeClaimIds: [], dependsOnFactIds: [] },
          { id: "pressure", kind: "immediate-pressure" as const, summary: "The unanswered message remains unresolved.", temporalClass: "at-checkpoint" as const, basis: "checkpoint-state" as const, entityIds: ["road"], focalKnowledgeClaimIds: [], dependsOnFactIds: ["cause"] },
        ],
        entityGlosses: [],
        immediateSituation: {
          summary: "Road is still waiting for an answer.",
          causalFactIds: ["cause"],
          pressureFactIds: ["pressure"],
          unresolvedFactIds: ["pressure"],
          outcomePolicy: "withhold-post-checkpoint-outcomes" as const,
        },
      },
      participantPresence: [{ entityId: "road", mode: "physical" as const }],
      delta: { version: 1 as const, operations: [{ op: "set" as const, entityId: "road", field: "character.plan", value: "wait" }] },
      evidence: source.evidence("路明非还在等。"),
    };
    const validator = new CompilerValidator(canon);
    const missingGloss = await validator.validate("initial-world", payload);
    expect(missingGloss.errors).toContainEqual(expect.objectContaining({
      code: "MISSING_READER_CHARACTER_GLOSS",
      message: expect.stringContaining("chen-wenwen"),
    }));

    const complete = await validator.validate("initial-world", {
      ...payload,
      readerContext: {
        ...payload.readerContext,
        entityGlosses: [{
          entityId: "chen-wenwen",
          relationshipToFocal: "路明非的同学",
          whyRelevantNow: "her message created the current wait",
          factIds: ["cause"],
        }],
      },
    });
    expect(complete.errors.find((issue) => issue.code === "MISSING_READER_CHARACTER_GLOSS")).toBeUndefined();
  });
});

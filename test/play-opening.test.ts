import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import {
  assertPlaySceneNarration,
  buildPlayOpeningFrame,
  playSceneRequestForEntry,
  playScenePrompt,
  renderPlaySceneFailure,
  resolvePlayScenePurpose,
} from "../src/world/play-opening.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("player opening narration", () => {
  it("maps entry intent to intuitive scene timing", () => {
    expect(playSceneRequestForEntry("play")).toBe("auto");
    expect(playSceneRequestForEntry("create")).toBe("opening");
    expect(playSceneRequestForEntry("switch")).toBe("orientation");
    expect(playSceneRequestForEntry("continue")).toBe("continue");
    expect(playSceneRequestForEntry("resume")).toBe("continue");
    expect(playSceneRequestForEntry("startup", false)).toBe("none");
    expect(playSceneRequestForEntry("startup", true)).toBe("auto");

    expect(resolvePlayScenePurpose("auto", { logicalStep: 0, selectionChanged: true, hadPreviousSelection: false })).toBe("opening");
    expect(resolvePlayScenePurpose("auto", { logicalStep: 4, selectionChanged: true, hadPreviousSelection: false })).toBe("orientation");
    expect(resolvePlayScenePurpose("auto", { logicalStep: 4, selectionChanged: false, hadPreviousSelection: true })).toBeUndefined();
    expect(resolvePlayScenePurpose("auto", { logicalStep: 4, selectionChanged: true, hadPreviousSelection: true })).toBe("orientation");
    expect(resolvePlayScenePurpose("continue", { logicalStep: 4, selectionChanged: true, hadPreviousSelection: false })).toBeUndefined();
    expect(resolvePlayScenePurpose("continue", { logicalStep: 4, selectionChanged: false, hadPreviousSelection: true })).toBeUndefined();
    expect(resolvePlayScenePurpose("continue", { logicalStep: 4, selectionChanged: true, hadPreviousSelection: true })).toBe("orientation");
    expect(resolvePlayScenePurpose("orientation", { logicalStep: 4, selectionChanged: false, hadPreviousSelection: true })).toBeUndefined();
    expect(resolvePlayScenePurpose("turn", { logicalStep: 4, selectionChanged: false, hadPreviousSelection: true })).toBe("turn");
  });

  it("builds an actor-scoped committed frame without moving the branch head", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-play-opening-"));
    roots.push(root);
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({ id: "hero", kind: "character", canonicalName: "福贵", aliases: [], evidence: [] });
    await canon.putEntity({ id: "rival", kind: "character", canonicalName: "旁人", aliases: [], evidence: [] });
    await canon.putEntity({ id: "hall", kind: "location", canonicalName: "前厅", aliases: [], evidence: [] });
    await canon.putClaim({
      id: "hall-is-quiet",
      subject: "hall",
      predicate: "is quiet",
      object: true,
      epistemicType: "explicit-fact",
      evidence: [],
    });
    const { engine } = await openWorkspaceWorld(root);
    const genesis = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [
        { op: "set", entityId: "hero", field: "character.alive", value: true },
        { op: "set", entityId: "hero", field: "character.location", value: "hall" },
        { op: "set", entityId: "rival", field: "character.alive", value: true },
      ],
    }, {
      version: 1,
      operations: [{ op: "learn", actorId: "hero", claimId: "hall-is-quiet", status: "knows", confidence: 1 }],
    });
    const committed = await engine.commitProposal({
      proposalId: "hero-waits",
      branchId: "main",
      expectedParentCommit: genesis,
      source: "background",
      title: "福贵在前厅等待",
      participants: ["hero"],
      proposedTime: { kind: "unknown" },
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      causalParents: [],
      evidence: [],
    });

    const frame = await buildPlayOpeningFrame(root, "main", "hero");

    expect(frame).toMatchObject({
      branchId: "main",
      commitId: committed.newHead,
      logicalStep: 1,
      actor: { id: "hero", name: "福贵" },
      selfState: { "character.location": "hall" },
      knowledge: [expect.objectContaining({ claimId: "hall-is-quiet" })],
      recentVisibleEvents: [{ title: "福贵在前厅等待", step: 1 }],
    });
    expect(frame.presentEntities.map((entity) => entity.id)).toEqual(["hero"]);
    expect(frame.visibleEntities.map((entity) => entity.id)).toEqual(["hero"]);
    expect(frame.referenceableEntities.map((entity) => entity.id)).toEqual(["hall", "hero"]);
    expect(JSON.stringify(frame)).not.toContain("rival");
    expect(renderPlaySceneFailure(frame)).toContain("/scene");
    expect(renderPlaySceneFailure(frame)).toContain("没有推进世界");
    expect(renderPlaySceneFailure(frame, "turn")).toContain("行动已经提交");
    expect(renderPlaySceneFailure(frame, "turn")).toContain("不必重复");
    expect(playScenePrompt(frame, "opening")).toContain("complete information visible to the character");
    expect(playScenePrompt(frame, "opening")).toContain("Open the playable story");
    expect(playScenePrompt(frame, "orientation")).toContain("not necessarily the beginning");
    expect(playScenePrompt(frame, "turn")).toContain("action was accepted and committed");
    expect(playScenePrompt({
      ...frame,
      turnResolution: {
        kind: "unresolved",
        utterance: "试图做一件无法可靠解释的事",
        actorVisibleSummary: "请求没有成为世界事件。",
      },
    }, "recovery")).toContain("did not become an in-world event");
    expect(() => assertPlaySceneNarration("你现在是福贵。故事开始。你要做什么？")).toThrow("underspecified");
    expect(assertPlaySceneNarration("风从门缝里挤进来，带着一点凉意。你听见近处细碎的响动，却还不能确定那意味着什么。眼前没有替你写好的决定，只有这个尚未被行动改变的片刻。你可以先观察周围，也可以整理脑中的念头，或者径直尝试自己最想做的事——下一步由你来定。")).toContain("下一步由你来定");
    const streamed = "\n风从门缝里挤进来，带着一点凉意。你听见近处细碎的响动，却还不能确定那意味着什么。眼前没有替你写好的决定，只有这个尚未被行动改变的片刻。你可以先观察周围，也可以整理脑中的念头，或者径直尝试自己最想做的事——下一步由你来定。\n";
    expect(assertPlaySceneNarration(streamed)).toBe(streamed);
    await expect(engine.branches.readHead("main")).resolves.toBe(committed.newHead);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MaintenanceApplicationService } from "../src/application/maintenance-service.js";
import { TraceStore } from "../src/trace/store.js";
import { WorkspaceStore } from "../src/storage/workspace-store.js";
import { WebEventBroker } from "../src/web/event-stream.js";
import { OperationManager } from "../src/web/operation-manager.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { PlayConversationStore } from "../src/world/play-conversation.js";
import { PlaySessionStore } from "../src/world/play-session.js";
import { openWorkspaceWorld } from "../src/world/workspace-runtime.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function workspace(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("Web maintenance effect manifests", () => {
  it("blocks a parent instance, rejects stale previews, and preserves detached traces", async () => {
    const root = await workspace("nwh-web-maintenance-instance-");
    const fixture = await createEvidenceFixture(root, "Hero waits.\n", "instance-preview.txt");
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: fixture.evidence("Hero"),
    });
    const { engine, runtime } = await openWorkspaceWorld(root);
    const head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    }, undefined, fixture.source.id);
    await runtime.forkBranch("main", head, "child", "Child");
    const sessions = new PlaySessionStore(root);
    const childSession = await sessions.write({ branchId: "child", sourceId: fixture.source.id, actorId: "hero", lastCommitId: head });
    const conversations = new PlayConversationStore(root);
    await conversations.append({ branchId: "child", actorId: "hero", atCommit: head, role: "player", status: "accepted", text: "first" });
    const traces = new TraceStore(root);
    const trace = await traces.createRun({ kind: "player-move", sourceId: fixture.source.id, branchId: "child", playSessionId: childSession.id });
    await traces.finishRun(trace.id, "succeeded");
    const events = new WebEventBroker();
    const service = new MaintenanceApplicationService({ root, events, operations: new OperationManager(events), traceStore: traces });

    await expect(service.previewInstance("main")).resolves.toMatchObject({
      executable: false,
      blockers: [expect.stringContaining("child instance 'child'")],
    });
    const first = await service.previewInstance("child");
    expect(first).toMatchObject({ executable: true, target: { confirmation: "child" } });
    expect(first.effects).toContainEqual(expect.objectContaining({ id: "play-sessions", disposition: "modify", count: 1 }));
    expect(first.effects).toContainEqual(expect.objectContaining({ id: "conversation", disposition: "preserve", count: 1 }));
    expect(first.effects).toContainEqual(expect.objectContaining({ id: "trace-runs", disposition: "preserve", count: 1 }));

    await conversations.append({ branchId: "child", actorId: "hero", atCommit: head, role: "player", status: "accepted", text: "second" });
    await expect(service.removeInstance("child", {
      effectHash: first.effectHash,
      confirmation: "child",
      clientRequestId: "remove-child-stale",
    })).rejects.toMatchObject({ detail: { code: "REMOVAL_PREVIEW_STALE" } });

    const current = await service.previewInstance("child");
    const removed = await service.removeInstance("child", {
      effectHash: current.effectHash,
      confirmation: "child",
      clientRequestId: "remove-child-current",
    });
    expect(removed).toMatchObject({
      action: "remove-instance",
      removed: { branches: 1, sessions: 0, conversationMessages: 0 },
      tracesPreserved: true,
    });
    await expect(engine.branches.read("child")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(sessions.getById(childSession.id)).resolves.toMatchObject({ status: "detached" });
    await expect(conversations.list("child")).resolves.toHaveLength(2);
    await expect(traces.getRun(trace.id)).resolves.toMatchObject({ id: trace.id, branchId: "child" });
  });

  it("resets source-scoped analysis, then removes the novel while retaining source bytes and traces", async () => {
    const root = await workspace("nwh-web-maintenance-novel-");
    const cacheRoot = path.join(root, "prepared-cache");
    const fixture = await createEvidenceFixture(root, "Hero waits.\n", "novel-preview.txt");
    const canonical = new CanonicalModelStore(root);
    await canonical.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") });
    const { engine } = await openWorkspaceWorld(root);
    const head = await engine.createBranch("main", "Main", {
      version: 1,
      operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
    }, undefined, fixture.source.id);
    const session = await new PlaySessionStore(root).write({ branchId: "main", sourceId: fixture.source.id, actorId: "hero", lastCommitId: head });
    const traces = new TraceStore(root);
    const trace = await traces.createRun({ kind: "scene-narration", sourceId: fixture.source.id, branchId: "main", playSessionId: session.id });
    await traces.finishRun(trace.id, "succeeded");
    const events = new WebEventBroker();
    const service = new MaintenanceApplicationService({ root, events, operations: new OperationManager(events), traceStore: traces, cacheRoot });

    const analysis = await service.previewAnalysis(fixture.source.id);
    expect(analysis.effects).toContainEqual(expect.objectContaining({ id: "canonical-artifacts", count: 1, disposition: "modify" }));
    expect(analysis.effects).toContainEqual(expect.objectContaining({ id: "branches", count: 1, disposition: "preserve" }));
    const reset = await service.resetAnalysis(fixture.source.id, {
      effectHash: analysis.effectHash,
      confirmation: fixture.source.id,
      clientRequestId: "reset-analysis-1",
    });
    expect(reset).toMatchObject({ action: "reset-analysis", removed: { canonicalArtifacts: 1, branches: 0 } });
    await expect(engine.branches.read("main")).resolves.toMatchObject({ id: "main" });
    await expect((await WorkspaceStore.create(root)).getSource(fixture.source.id)).resolves.toMatchObject({ id: fixture.source.id });

    const novel = await service.previewNovel(fixture.source.id);
    expect(novel.effects).toContainEqual(expect.objectContaining({ id: "source-material", disposition: "preserve", count: 1 }));
    expect(novel.effects).toContainEqual(expect.objectContaining({ id: "play-sessions", disposition: "modify", count: 1 }));
    expect(novel.effects).toContainEqual(expect.objectContaining({ id: "conversation", disposition: "preserve" }));
    const removed = await service.removeNovel(fixture.source.id, {
      effectHash: novel.effectHash,
      confirmation: fixture.source.id,
      clientRequestId: "remove-novel-1",
    });
    expect(removed).toMatchObject({ action: "remove-novel", removed: { branches: 1, sourceRegistrations: 1 }, immutableSourcePreserved: true });
    await expect((await WorkspaceStore.create(root)).getSource(fixture.source.id)).resolves.toBeNull();
    await expect(new PlaySessionStore(root).getById(session.id)).resolves.toMatchObject({ status: "detached" });
    await expect(traces.getRun(trace.id)).resolves.toMatchObject({ id: trace.id, sourceId: fixture.source.id });
  });
});

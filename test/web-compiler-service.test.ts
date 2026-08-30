import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PreparationApplicationService } from "../src/application/preparation-service.js";
import { InstanceApplicationService } from "../src/application/instance-service.js";
import { ProposalApplicationService } from "../src/application/proposal-service.js";
import { SourceApplicationService } from "../src/application/source-service.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { TraceStore } from "../src/trace/store.js";
import { WebEventBroker } from "../src/web/event-stream.js";
import { OperationManager } from "../src/web/operation-manager.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
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

describe("Web source registration", () => {
  it("registers pasted or browser-read content through immutable workspace stores", async () => {
    const root = await workspace("nwh-web-source-");
    const events = new WebEventBroker();
    const service = new SourceApplicationService({ root, events });
    const request = {
      title: "城南旧事.txt",
      content: "英子站在城门边。\n",
      clientRequestId: "register-1",
    };

    const created = await service.register(request);

    expect(created).toMatchObject({
      reused: false,
      source: { title: "城南旧事.txt", sourcePath: "content:城南旧事.txt" },
      preparation: { stage: "compile", nextAction: "compile" },
    });
    expect(created.segmentCount).toBeGreaterThan(0);
    expect(created.structuralUnitCount).toBeGreaterThan(0);
    await expect(service.register(request)).resolves.toMatchObject({ reused: true, source: { id: created.source.id } });
    const restarted = new SourceApplicationService({ root, events: new WebEventBroker() });
    await expect(restarted.register(request)).resolves.toMatchObject({ reused: true, source: { id: created.source.id } });
    await expect(restarted.register({ ...request, content: "different", clientRequestId: request.clientRequestId }))
      .rejects.toThrow("already used with different input");
    expect(events.replayAfter().at(-1)?.data).toMatchObject({ sourceId: created.source.id });
  });
});

describe("Web preparation operations", () => {
  it("runs compiler work behind an idempotent operation and links the durable trace", async () => {
    const root = await workspace("nwh-web-prepare-");
    const fixture = await createEvidenceFixture(root, "Hero opens the gate.\n");
    const events = new WebEventBroker();
    const operations = new OperationManager(events);
    const traces = new TraceStore(root);
    const service = new PreparationApplicationService({
      root,
      events,
      operations,
      traceStore: traces,
      dependencies: {
        async compileSource(options) {
          const batches = await prepareCompilerBatches(root, fixture.source);
          for (const batch of batches) await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);
          options.onStatus?.("test compiler ready");
          options.onModelToolCall?.("propose_entity", { proposal_id: "hero-web" });
          await new CompilerProposalService(root).submit("entity", {
            proposalId: "hero-web",
            payload: {
              id: "hero",
              kind: "character",
              canonicalName: "Hero",
              aliases: [],
              evidence: fixture.evidence("Hero opens the gate."),
            },
            generatedBy: { worker: "web-test", compilerBatchId: batches[0]!.id },
          });
          options.onModelToolResult?.("propose_entity", { proposalId: "hero-web" }, false);
          options.onProgress?.("test compiler checkpointed");
        },
      },
    });

    await expect(service.inspect(fixture.source.id)).resolves.toMatchObject({ stage: "compile" });
    const accepted = await service.start(fixture.source.id, {
      mode: "all",
      clientRequestId: "prepare-1",
    });
    const completed = await operations.wait(accepted.operation.id);

    expect(completed).toMatchObject({
      kind: "prepare",
      status: "succeeded",
      commitBoundaryCrossed: true,
      result: {
        stage: "review",
        proposalCounts: { pending: 1 },
      },
    });
    expect(completed.runId).toBeTruthy();
    await expect(traces.getRun(completed.runId!)).resolves.toMatchObject({
      kind: "prepare",
      status: "succeeded",
      sourceId: fixture.source.id,
      operationId: completed.id,
    });
    const replay = await service.start(fixture.source.id, {
      mode: "all",
      clientRequestId: "prepare-1",
    });
    expect(replay).toMatchObject({ reused: true, operation: { id: completed.id } });
  });
});

describe("Web proposal review", () => {
  it("bounds large inbox responses and resumes them from an opaque snapshot cursor", async () => {
    const root = await workspace("nwh-web-proposal-pages-");
    const fixture = await createEvidenceFixture(root, "A witness waits.\n");
    const compiler = new CompilerProposalService(root);
    for (let index = 0; index < 85; index += 1) {
      const suffix = String(index).padStart(3, "0");
      await compiler.submit("entity", {
        proposalId: `entity-witness-${suffix}`,
        payload: {
          id: `witness-${suffix}`,
          kind: "character",
          canonicalName: `Witness ${suffix}`,
          aliases: [],
          evidence: fixture.evidence("witness"),
        },
        generatedBy: { worker: "pagination-test" },
      });
    }
    const service = new ProposalApplicationService({ root, events: new WebEventBroker() });
    const first = await service.listPage(fixture.source.id);
    expect(first.items).toHaveLength(75);
    expect(first.page).toMatchObject({ offset: 0, loaded: 75, total: 85 });
    expect(first.page.nextCursor).toBeTruthy();
    const second = await service.listPage(fixture.source.id, { cursor: first.page.nextCursor! });
    expect(second.items).toHaveLength(10);
    expect(second.page).toMatchObject({ offset: 75, loaded: 85, total: 85, nextCursor: null });
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(85);
    await expect(service.listPage(fixture.source.id, { cursor: "not-a-cursor" }))
      .rejects.toMatchObject({ detail: { code: "PROPOSAL_PAGE_CURSOR_INVALID", retry: { copyField: "page.nextCursor", maxAttempts: 1 } } });
  });

  it("shows complete envelopes and preserves validation-backed accept/reject history", async () => {
    const root = await workspace("nwh-web-proposals-");
    const fixture = await createEvidenceFixture(root, "林岐来到前厅。阿宁留在门外。\n");
    const compiler = new CompilerProposalService(root);
    await compiler.submit("entity", {
      proposalId: "entity-linqi-web",
      payload: {
        id: "linqi",
        kind: "character",
        canonicalName: "林岐",
        aliases: [],
        evidence: fixture.evidence("林岐来到前厅。"),
      },
      generatedBy: { worker: "web-test" },
    });
    await compiler.submit("entity", {
      proposalId: "entity-aning-web",
      payload: {
        id: "aning",
        kind: "character",
        canonicalName: "阿宁",
        aliases: [],
        evidence: fixture.evidence("阿宁留在门外。"),
      },
      generatedBy: { worker: "web-test" },
    });
    const service = new ProposalApplicationService({ root, events: new WebEventBroker() });

    await expect(service.list(fixture.source.id)).resolves.toEqual([
      expect.objectContaining({ id: "entity-aning-web", status: "pending" }),
      expect.objectContaining({ id: "entity-linqi-web", status: "pending" }),
    ]);
    const firstPage = await service.listPage(fixture.source.id, { limit: 1 });
    expect(firstPage).toMatchObject({
      items: [expect.objectContaining({ id: "entity-aning-web" })],
      page: { offset: 0, loaded: 1, total: 2 },
    });
    expect(firstPage.page.nextCursor).toBeTruthy();
    await expect(service.listPage(fixture.source.id, { limit: 1, cursor: firstPage.page.nextCursor! })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "entity-linqi-web" })],
      page: { offset: 1, loaded: 2, total: 2, nextCursor: null },
    });
    await expect(service.get("entity-linqi-web")).resolves.toMatchObject({
      summary: { kind: "entity", status: "pending" },
      envelope: { payload: { canonicalName: "林岐" } },
      rejection: null,
    });

    const acceptRequest = { clientRequestId: "accept-1" };
    const accepted = await service.accept("entity-linqi-web", acceptRequest);
    expect(accepted).toMatchObject({ accepted: true, status: "accepted", reused: false });
    await expect(service.listPage(fixture.source.id, { limit: 1, cursor: firstPage.page.nextCursor! }))
      .resolves.toMatchObject({ page: { snapshotId: firstPage.page.snapshotId } });
    const freshListingService = new ProposalApplicationService({ root, events: new WebEventBroker() });
    await expect(freshListingService.listPage(fixture.source.id, { limit: 1, cursor: firstPage.page.nextCursor! }))
      .rejects.toMatchObject({ detail: { code: "PROPOSAL_PAGE_CURSOR_STALE" } });
    await expect(service.accept("entity-linqi-web", acceptRequest))
      .resolves.toMatchObject({ accepted: true, reused: true });

    const rejectRequest = {
      reason: "人物指代仍需人工核对。",
      clientRequestId: "reject-1",
    };
    const rejected = await service.reject("entity-aning-web", rejectRequest);
    expect(rejected).toMatchObject({ accepted: false, status: "rejected", reused: false });
    await expect(service.get("entity-aning-web", "rejected")).resolves.toMatchObject({
      rejection: { errors: [{ code: "WEB_USER_REJECTED", message: "人物指代仍需人工核对。" }] },
    });
    const restarted = new ProposalApplicationService({ root, events: new WebEventBroker() });
    await expect(restarted.accept("entity-linqi-web", acceptRequest)).resolves.toMatchObject({ accepted: true, reused: true });
    await expect(restarted.reject("entity-aning-web", rejectRequest)).resolves.toMatchObject({ status: "rejected", reused: true });
  });
});

describe("Web world instances", () => {
  it("publishes a prepared revision, creates a branch, exposes history, and forks from a selected commit", async () => {
    const root = await workspace("nwh-web-instance-");
    const cacheRoot = await workspace("nwh-web-instance-cache-");
    const fixture = await createEvidenceFixture(root, "Hero waits at the gate.\n");
    const evidence = fixture.evidence("Hero waits at the gate.");
    await new CanonicalModelStore(root).putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence,
    });
    await new InitialWorldStore(root).put({
      version: 1,
      delta: {
        version: 1,
        operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }],
      },
      evidence,
    });
    const batches = await prepareCompilerBatches(root, fixture.source);
    await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, batches.map((batch) => batch.id));
    const service = new InstanceApplicationService({ root, cacheRoot, events: new WebEventBroker() });

    const createRequest = {
      sourceId: fixture.source.id,
      branchId: "main",
      clientRequestId: "instance-create-1",
    };
    const created = await service.create(createRequest);

    expect(created).toMatchObject({
      created: true,
      reused: false,
      usedCanonicalInitial: true,
      instance: { branchId: "main", sourceId: fixture.source.id, logicalStep: 0 },
    });
    expect(created.preparedRevisionHash).toMatch(/^[a-f0-9]{64}$/);
    const detail = await service.get("main");
    expect(detail.history).toEqual([
      expect.objectContaining({
        id: created.instance.headCommitId,
        logicalStep: 0,
        eventCount: 1,
        events: [expect.objectContaining({ title: "Genesis" })],
      }),
    ]);

    const forkRequest = {
      newBranchId: "what-if",
      name: "What if",
      fromCommit: detail.history[0]!.id,
      clientRequestId: "fork-1",
    };
    const forked = await service.fork("main", forkRequest);
    expect(forked).toMatchObject({
      created: true,
      reused: false,
      parentBranchId: "main",
      forkCommitId: detail.history[0]!.id,
      instance: { branchId: "what-if", parentBranchId: "main" },
    });
    const restarted = new InstanceApplicationService({ root, cacheRoot, events: new WebEventBroker() });
    await expect(restarted.create(createRequest)).resolves.toMatchObject({ reused: true, instance: { branchId: "main" } });
    await expect(restarted.fork("main", forkRequest)).resolves.toMatchObject({ reused: true, instance: { branchId: "what-if" } });
  });
});

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
    await expect(service.register({ ...request, content: "different", clientRequestId: request.clientRequestId }))
      .rejects.toThrow("already used with different source content");
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
        pending: [expect.objectContaining({ id: "hero-web", status: "pending" })],
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
    await expect(service.get("entity-linqi-web")).resolves.toMatchObject({
      summary: { kind: "entity", status: "pending" },
      envelope: { payload: { canonicalName: "林岐" } },
      rejection: null,
    });

    const accepted = await service.accept("entity-linqi-web", { clientRequestId: "accept-1" });
    expect(accepted).toMatchObject({ accepted: true, status: "accepted", reused: false });
    await expect(service.accept("entity-linqi-web", { clientRequestId: "accept-1" }))
      .resolves.toMatchObject({ accepted: true, reused: true });

    const rejected = await service.reject("entity-aning-web", {
      reason: "人物指代仍需人工核对。",
      clientRequestId: "reject-1",
    });
    expect(rejected).toMatchObject({ accepted: false, status: "rejected", reused: false });
    await expect(service.get("entity-aning-web", "rejected")).resolves.toMatchObject({
      rejection: { errors: [{ code: "WEB_USER_REJECTED", message: "人物指代仍需人工核对。" }] },
    });
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

    const created = await service.create({
      sourceId: fixture.source.id,
      branchId: "main",
      clientRequestId: "instance-create-1",
    });

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

    const forked = await service.fork("main", {
      newBranchId: "what-if",
      name: "What if",
      fromCommit: detail.history[0]!.id,
      clientRequestId: "fork-1",
    });
    expect(forked).toMatchObject({
      created: true,
      reused: false,
      parentBranchId: "main",
      forkCommitId: detail.history[0]!.id,
      instance: { branchId: "what-if", parentBranchId: "main" },
    });
    await expect(service.fork("main", {
      newBranchId: "what-if",
      name: "What if",
      fromCommit: detail.history[0]!.id,
      clientRequestId: "fork-1",
    })).resolves.toMatchObject({ reused: true, instance: { branchId: "what-if" } });
  });
});

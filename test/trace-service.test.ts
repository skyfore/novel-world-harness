import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TraceApplicationService } from "../src/application/trace-service.js";
import { TraceRecorder } from "../src/trace/recorder.js";
import { contextSnapshotSchema } from "../src/trace/schema.js";
import { TraceStore } from "../src/trace/store.js";
import { createWebHost, type NwhWebHost } from "../src/web/host.js";
import { WebApplicationError } from "../src/web/errors.js";

const roots: string[] = [];
const apps: NwhWebHost[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-trace-service-"));
  roots.push(root);
  return root;
}

async function seedTrace(root: string) {
  const store = new TraceStore(root);
  const recorder = await TraceRecorder.start(store, {
    id: "run-inspect-1",
    rootSpanId: "span-root-1",
    kind: "player-move",
    sourceId: "source-1",
    branchId: "branch-1",
    playSessionId: "play-1",
    playerMoveId: "move-1",
    operationId: "operation-1",
    previousHead: "commit-before",
    storyTimeBefore: { logicalStep: 4 },
    startedAt: "2026-08-30T00:00:00.000Z",
  });
  const partRef = await recorder.putBlob("Open the red door.", "text/plain; charset=utf-8");
  const messagesRef = await recorder.putBlob([
    { role: "system", content: "Interpret only actor-visible information." },
    { role: "user", content: "Open the red door." },
  ]);
  const payloadRef = await recorder.putBlob({
    model: "fake-model",
    authorization: "[REDACTED]",
    messages: [{ role: "user", content: "Open the red door." }],
  });
  const parametersRef = await recorder.putBlob({
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  });
  const snapshotRef = await recorder.putBlob(contextSnapshotSchema.parse({
    version: 1,
    callId: "call-1",
    invocationName: "interpret-player-action",
    assemblyVersion: "nwh-context/v1",
    providerId: "fake-provider",
    modelId: "fake-model",
    thinkingLevel: "medium",
    parts: [{
      id: "player-utterance",
      label: "Player utterance",
      kind: "player.utterance",
      role: "user",
      authority: "untrusted-player",
      sourceRefs: [],
      contentRef: partRef,
      charCount: 18,
      estimatedTokens: 5,
      disposition: "included",
      logicalMessageIndexes: [1],
    }],
    tools: [{
      name: "propose_player_action",
      description: "Propose a typed player action.",
      parametersRef,
    }],
    logicalMessagesRef: messagesRef,
    providerPayloadRef: payloadRef,
    logicalContextHash: messagesRef.sha256,
    providerPayloadHash: payloadRef.sha256,
    estimatedInputTokens: 24,
  }));

  await recorder.record("context.finalized", {
    invocationName: "interpret-player-action",
    requestAttempt: 1,
  }, recorder.rootContext, {
    callId: "call-1",
    blobRef: snapshotRef,
    observedAt: "2026-08-30T00:00:00.900Z",
  });
  await recorder.record("llm.request.started", {
    requestAttempt: 1,
    providerId: "fake-provider",
    modelId: "fake-model",
  }, recorder.rootContext, {
    callId: "call-1",
    observedAt: "2026-08-30T00:00:01.000Z",
  });
  await recorder.record("llm.retry", {
    attempt: 1,
    maxAttempts: 2,
    delayMs: 50,
  }, recorder.rootContext, {
    callId: "call-1",
    observedAt: "2026-08-30T00:00:01.100Z",
  });
  const toolInputRef = await recorder.putBlob({ title: "Open the red door" });
  await recorder.record("tool.call.started", {
    toolName: "propose_player_action",
  }, recorder.rootContext, {
    callId: "call-1",
    toolCallId: "tool-1",
    blobRef: toolInputRef,
    observedAt: "2026-08-30T00:00:01.150Z",
  });
  const progressRef = await recorder.putBlob({ stage: "validating" });
  await recorder.record("tool.call.progress", {
    toolName: "propose_player_action",
  }, recorder.rootContext, {
    callId: "call-1",
    toolCallId: "tool-1",
    blobRef: progressRef,
    observedAt: "2026-08-30T00:00:01.175Z",
  });
  const toolResultRef = await recorder.putBlob({ accepted: true });
  await recorder.record("tool.call.completed", {
    toolName: "propose_player_action",
  }, recorder.rootContext, {
    callId: "call-1",
    toolCallId: "tool-1",
    blobRef: toolResultRef,
    observedAt: "2026-08-30T00:00:01.200Z",
  });
  const responseHeadersRef = await recorder.putBlob({ "content-type": "text/event-stream" });
  await recorder.record("llm.response.started", {
    httpStatus: 200,
  }, recorder.rootContext, {
    callId: "call-1",
    blobRef: responseHeadersRef,
    observedAt: "2026-08-30T00:00:01.250Z",
  });
  const deltaRef = await recorder.putBlob("Opening.", "text/plain; charset=utf-8");
  await recorder.record("llm.response.delta", { charCount: 8 }, recorder.rootContext, {
    callId: "call-1",
    blobRef: deltaRef,
    observedAt: "2026-08-30T00:00:01.400Z",
  });
  const responseRef = await recorder.putBlob({
    role: "assistant",
    content: [{ type: "text", text: "Opening." }],
    stopReason: "stop",
  });
  await recorder.record("llm.response.completed", {
    stopReason: "stop",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 10,
      cacheWrite: 5,
      reasoning: 3,
      totalTokens: 135,
      cost: 0.03,
    },
  }, recorder.rootContext, {
    callId: "call-1",
    blobRef: responseRef,
    observedAt: "2026-08-30T00:00:01.900Z",
  });
  const validationRef = await recorder.putBlob({ accepted: true, issues: [] });
  const validation = await recorder.record("validation.completed", {
    accepted: true,
  }, recorder.rootContext, {
    blobRef: validationRef,
    observedAt: "2026-08-30T00:00:02.000Z",
  });
  await recorder.link({
    finalHead: "commit-after",
    eventHash: "event-hash-1",
    auditId: "audit-1",
    presentationMessageIds: ["message-1", "message-2"],
    storyTimeAfter: { logicalStep: 5 },
  });
  await recorder.finish("succeeded", {
    finalHead: "commit-after",
    endedAt: "2026-08-30T00:00:02.100Z",
  });
  return { store, validationSeq: validation.seq };
}

describe("TraceApplicationService", () => {
  it("projects runs, expanded call context, tools, responses, usage, and timing", async () => {
    const root = await workspace();
    const { store, validationSeq } = await seedTrace(root);
    const service = new TraceApplicationService(store);

    await expect(service.listRuns({ playSessionId: "play-1", status: "succeeded" })).resolves.toEqual([
      expect.objectContaining({
        id: "run-inspect-1",
        counts: { llmRequests: 1, toolCalls: 1, retries: 1 },
        finalHead: "commit-after",
      }),
    ]);
    const run = await service.getRun("run-inspect-1");
    expect(run.callIds).toEqual(["call-1"]);
    expect(run.manifest).toMatchObject({
      previousHead: "commit-before",
      finalHead: "commit-after",
      storyTimeBefore: { logicalStep: 4 },
      storyTimeAfter: { logicalStep: 5 },
    });
    expect(await service.getEvents("run-inspect-1", validationSeq - 1)).toEqual([
      expect.objectContaining({ seq: validationSeq, type: "validation.completed" }),
      expect.objectContaining({ type: "run.succeeded" }),
    ]);
    await expect(service.getEventPayload("run-inspect-1", validationSeq)).resolves.toMatchObject({
      runId: "run-inspect-1",
      seq: validationSeq,
      content: { accepted: true, issues: [] },
    });

    const call = await service.getCall("call-1");
    expect(call).toMatchObject({
      runId: "run-inspect-1",
      callId: "call-1",
      invocationName: "interpret-player-action",
      startedAt: "2026-08-30T00:00:01.000Z",
      firstResponseAt: "2026-08-30T00:00:01.250Z",
      endedAt: "2026-08-30T00:00:01.900Z",
      timeToFirstResponseMs: 250,
      durationMs: 900,
      counts: { requests: 1, retries: 1, tools: 1 },
      usage: { input: 100, output: 20, reasoning: 3, totalTokens: 135, cost: 0.03 },
      contexts: [{
        requestAttempt: 1,
        parts: [expect.objectContaining({ id: "player-utterance", content: "Open the red door." })],
        availableTools: [expect.objectContaining({
          name: "propose_player_action",
          parameters: expect.objectContaining({ type: "object" }),
        })],
        logicalMessages: expect.arrayContaining([expect.objectContaining({ role: "system" })]),
        providerPayload: expect.objectContaining({ authorization: "[REDACTED]" }),
      }],
      tools: [{
        toolCallId: "tool-1",
        name: "propose_player_action",
        status: "completed",
        input: { title: "Open the red door" },
        progress: [{ stage: "validating" }],
        result: { accepted: true },
      }],
    });
    expect(call.responses.map((response) => response.status)).toEqual(["started", "delta", "completed"]);
    expect(call.responses.at(-1)?.content).toMatchObject({ role: "assistant", stopReason: "stop" });
  });

  it("returns bounded recovery guidance for unknown run, event, payload, and call identifiers", async () => {
    const root = await workspace();
    const { store } = await seedTrace(root);
    const service = new TraceApplicationService(store);

    await expect(service.getRun("run-missing")).rejects.toMatchObject({
      statusCode: 404,
      detail: {
        code: "TRACE_RUN_NOT_FOUND",
        retry: { discoveryEndpoint: "/api/v1/runs", copyField: "[].id", maxAttempts: 1 },
      },
    });
    await expect(service.getEventPayload("run-inspect-1", 999)).rejects.toMatchObject({
      statusCode: 404,
      detail: { code: "TRACE_EVENT_NOT_FOUND", retry: { copyField: "[].seq", maxAttempts: 1 } },
    });
    await expect(service.getEventPayload("run-inspect-1", 1)).rejects.toMatchObject({
      statusCode: 404,
      detail: { code: "TRACE_EVENT_PAYLOAD_NOT_FOUND", retry: { kind: "none" } },
    });
    const callError = service.getCall("call-missing", "run-inspect-1");
    await expect(callError).rejects.toBeInstanceOf(WebApplicationError);
    await expect(callError).rejects.toMatchObject({
      statusCode: 404,
      detail: { code: "TRACE_CALL_NOT_FOUND", retry: { copyField: "callIds[]", maxAttempts: 1 } },
    });
  });
});

describe("Trace Web API", () => {
  it("serves filtered runs, ledgers, payloads, and expanded call inspection", async () => {
    const root = await workspace();
    const { store, validationSeq } = await seedTrace(root);
    const app = await createWebHost({
      root,
      traceStore: store,
      serveStatic: false,
      modelCatalogService: { read: async () => ({ providers: [], models: [] }) },
    });
    apps.push(app);

    const bootstrap = await app.inject({ method: "GET", url: "/api/v1/bootstrap" });
    expect(bootstrap.json()).toMatchObject({
      features: expect.arrayContaining([{ id: "trace", status: "available", phase: 1 }]),
    });
    const runs = await app.inject({
      method: "GET",
      url: "/api/v1/runs?sessionId=play-1&kind=player-move&status=succeeded&limit=10",
    });
    expect(runs.statusCode).toBe(200);
    expect(runs.json()).toEqual([expect.objectContaining({ id: "run-inspect-1" })]);

    const run = await app.inject({ method: "GET", url: "/api/v1/runs/run-inspect-1" });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ callIds: ["call-1"], manifest: { finalHead: "commit-after" } });
    const events = await app.inject({
      method: "GET",
      url: `/api/v1/runs/run-inspect-1/events?afterSeq=${validationSeq - 1}`,
    });
    expect(events.json()).toEqual([
      expect.objectContaining({ seq: validationSeq, type: "validation.completed" }),
      expect.objectContaining({ type: "run.succeeded" }),
    ]);
    const payload = await app.inject({
      method: "GET",
      url: `/api/v1/runs/run-inspect-1/events/${validationSeq}/payload`,
    });
    expect(payload.json()).toMatchObject({ content: { accepted: true, issues: [] } });
    const call = await app.inject({
      method: "GET",
      url: "/api/v1/calls/call-1/context?runId=run-inspect-1",
    });
    expect(call.statusCode).toBe(200);
    expect(call.json()).toMatchObject({
      callId: "call-1",
      contexts: [{ providerPayload: { authorization: "[REDACTED]" } }],
      tools: [{ toolCallId: "tool-1", status: "completed" }],
    });

    const badCursor = await app.inject({ method: "GET", url: "/api/v1/runs/run-inspect-1/events?afterSeq=-1" });
    expect(badCursor.statusCode).toBe(400);
    expect(badCursor.json()).toMatchObject({ code: "INVALID_REQUEST" });
    const missing = await app.inject({ method: "GET", url: "/api/v1/runs/run-missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "TRACE_RUN_NOT_FOUND", retry: { maxAttempts: 1 } });
  });
});

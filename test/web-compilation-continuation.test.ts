import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PreparationApplicationService } from "../src/application/preparation-service.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { TraceStore } from "../src/trace/store.js";
import { WebEventBroker } from "../src/web/event-stream.js";
import { OperationManager } from "../src/web/operation-manager.js";
import { runCompileLoop } from "../src/runtime/compile-loop/supervisor.js";
import { inspectCompileLoop } from "../src/runtime/compile-loop/state.js";
import * as childProcess from "../src/runtime/compile-loop/process.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture(playable = false) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-web-continuation-")); roots.push(base);
  const root = path.join(base, "checkout"); await fs.mkdir(root);
  vi.stubEnv("NWH_HOME", path.join(base, "state"));
  const f = await createEvidenceFixture(root, "Ada waits in the hall.\nA visitor remains unidentified.\n");
  const batches = await prepareCompilerBatches(root, f.source);
  await new CompilerBatchStore(root).replaceCompleted(f.source.id, batches.map(b => b.id));
  await new CanonicalModelStore(root).putEntity({ id: "ada", kind: "character", canonicalName: "Ada", aliases: [], evidence: f.evidence("Ada") });
  await new InitialWorldStore(root).put({ version: 1, evidence: f.evidence("Ada waits in the hall."), delta: { version: 1,
    operations: [{ op: "set", entityId: "ada", field: "character.alive", value: playable }] } });
  const events = new WebEventBroker(), operations = new OperationManager(events), traceStore = new TraceStore(root);
  return { ...f, root, events, operations, traceStore };
}

it.each([false, true])("continues repair/delivery through the full supervised command, preserving source, signal and request idempotence (playable=%s)", async playable => {
  const f = await fixture(playable), compileNovel = vi.fn(async () => {
    expect(await f.traceStore.peekRuns({ status: "running" })).toEqual([]);
    throw new Error("NOVEL_SUPERVISION_BLOCKED: exact retained prerequisite");
  });
  const compileSource = vi.fn(), compileOpening = vi.fn();
  const service = new PreparationApplicationService({ ...f, dependencies: { compileNovel, compileSource, compileOpening } });
  expect((await service.inspect(f.source.id)).stage).toBe(playable ? "create-branch" : "repair");
  const request = { mode: "all" as const, clientRequestId: "continue-original-compilation" };
  const accepted = await service.start(f.source.id, request), result = await f.operations.wait(accepted.operation.id);
  expect(result).toMatchObject({ status: "failed", commitBoundaryCrossed: true });
  expect(compileNovel).toHaveBeenCalledExactlyOnceWith({ root: f.root, sourceId: f.source.id,
    signal: expect.any(AbortSignal), onProgress: expect.any(Function) });
  expect(compileSource).not.toHaveBeenCalled(); expect(compileOpening).not.toHaveBeenCalled();
  expect(await service.start(f.source.id, request)).toMatchObject({ reused: true, operation: { id: result.id } });
  expect(compileNovel).toHaveBeenCalledOnce();
  expect(result.runId).toBeUndefined();
  expect(await f.traceStore.peekRuns()).toEqual([]);
});

it("the real Web continuation preserves a supervisor BREAK and all counters before any model or worker dispatch", async () => {
  const f = await fixture();
  // Create an ordinary retained host stop through the real supervisor. The
  // offline child only supplies an unverified-source diagnostic, never a grant.
  const stopped = await runCompileLoop({ request: { root: f.root, sourceId: f.source.id }, sourceHash: f.source.contentSha256,
    engineerModel: "gpt-5.6-sol", signal: new AbortController().signal, onProgress() {},
    runner: async input => {
      await fs.writeFile(input.args.at(-1)!, JSON.stringify({ compilerLock: { present: false }, sources: [{ sourceId: f.source.id,
        sourceSha256: f.source.contentSha256, sourceIntegrity: "unknown" }], compilation: [] }));
      return { code: 0, signal: null, error: null, timedOut: false, cancelled: false };
    } });
  expect(stopped.phase).toBe("BREAK");
  const supervision = inspectCompileLoop(f.root, f.source.id)!, stateFile = path.join(supervision.directory, "state.json");
  const before = await fs.readFile(stateFile, "utf8");
  const worker = vi.spyOn(childProcess, "runLoopChild"), model = vi.spyOn(PiAgentSession, "create");
  const service = new PreparationApplicationService(f), snapshot = await service.inspect(f.source.id);
  expect(snapshot.repairReasons).toContain(`BREAK: ${stopped.reason}`);
  const accepted = await service.start(f.source.id, { mode: "all", clientRequestId: "cannot-renew-break" });
  const result = await f.operations.wait(accepted.operation.id);
  expect(result).toMatchObject({ status: "failed", error: { message: expect.stringContaining("COMPILE_LOOP_RETAINED_STOP") } });
  expect(worker).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled();
  expect(await fs.readFile(stateFile, "utf8")).toBe(before);
  expect(inspectCompileLoop(f.root, f.source.id)).toEqual(supervision);
});

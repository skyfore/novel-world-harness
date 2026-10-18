import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileNovelCommand, inspectNovelCompilation, type CompileNovelOptions } from "../../commands/compile-novel.js";
import { withCompilerSignals } from "../../util/compiler-signals.js";
import { RuntimeHooks, withRuntimeHooks } from "../hooks.js";
import { redactTraceSecrets } from "../../trace/redaction.js";
import { read, save } from "./state.js";
import { verifyNovelDelivery, type NovelDelivery } from "./delivery.js";
import { TraceStore } from "../../trace/store.js";

export type WorkerRequest = Omit<CompileNovelOptions, "signal" | "onProgress"> & { sourceId: string };
export type WorkerResult = { status: "succeeded" | "failed"; error?: string; delivery?: NovelDelivery };

/** A separate executable prevents a verified source repair from using stale ESM modules. */
export async function compileLoopWorker(operation: string, requestFile: string, output: string, resultFile?: string) {
  const request = read<WorkerRequest>(requestFile);
  if (operation === "inspect") {
    const snapshot = await inspectNovelCompilation(request.root, request.sourceId), traces = new TraceStore(request.root);
    const latest = (await traces.peekRuns({ sourceId: request.sourceId, kind: "prepare", limit: 1 }))[0];
    const work = latest ? (await traces.peekEvents(latest.id)).findLast(e => e.data?.phase === "role-review-work") : undefined;
    save(output, { ...snapshot, supervisionTrace: latest ? { runId: latest.id, status: latest.status, error: latest.error,
      workId: work?.data?.workId, planHash: work?.data?.planHash } : null }); return;
  }
  if (operation === "verify") {
    const result = read<WorkerResult>(resultFile!);
    save(output, result.delivery ? await verifyNovelDelivery(request.root, request.sourceId, result.delivery)
      : { verified: false, reason: "Worker supplied no full delivery" });
    return;
  }
  if (operation !== "work") throw new Error("Unknown compiler loop worker operation");
  await withCompilerSignals(async signal => {
    const auditController = new AbortController();
    const workerSignal = AbortSignal.any([signal, auditController.signal]);
    let auditError: unknown;
    const hooks = new RuntimeHooks({ onError: ({ error }) => { throw error; } });
    let events = 0;
    hooks.subscribe(event => {
      try {
        if (++events > 50_000) throw new Error("COMPILE_LOOP_HOOK_LIMIT: preserve the worker and inspect the retained diagnostics.");
        appendFileSync(`${output}.hooks.jsonl`, JSON.stringify(redactTraceSecrets(event)) + "\n", { mode: 0o600 });
      } catch (error) { auditError = error; auditController.abort(error); throw error; }
    });
    try {
      const run = await withRuntimeHooks(hooks, () => compileNovelCommand({ ...request, signal: workerSignal }));
      if (auditError) throw auditError;
      if (!run?.completed) throw new Error("The full compiler did not complete all delivery phases");
      save(output, { status: "succeeded", delivery: { runId: run.id, candidateBundleHash: run.bundleHash,
        branchId: run.branchId, completed: run.completed } } satisfies WorkerResult);
    } catch (error) {
      save(output, { status: "failed", error: String(error) } satisfies WorkerResult);
      throw error;
    }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  compileLoopWorker(process.argv[2]!, process.argv[3]!, process.argv[4]!, process.argv[5]).catch(error => {
    console.error(String(error)); process.exitCode = 1;
  });
}

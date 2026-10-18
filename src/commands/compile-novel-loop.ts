import path from "node:path";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { ingestWorkspaceSource } from "./ingest.js";
import { resolveNovelSource } from "../world/play-experience.js";
import { compileNovelCommand, type CompileNovelOptions } from "./compile-novel.js";
import { runCompileLoop } from "../runtime/compile-loop/supervisor.js";
import type { WorkerRequest } from "../runtime/compile-loop/worker.js";
import { loadOptionalConfig } from "../config/load.js";
import { existsSync } from "node:fs";
import { compileLoopDirectory, read } from "../runtime/compile-loop/state.js";

export type SupervisedCompileOptions = CompileNovelOptions & {
  loop?: boolean; engineerModel?: string; loopHistory?: string; loopResolution?: string; loopResume?: string; loopHostPatch?: string;
};

/** Public CLI default; phase commands and the explicit diagnostic opt-out retain their single invocation semantics. */
export async function compileNovelWithLoop(options: SupervisedCompileOptions) {
  if (options.phase || options.loop === false) return compileNovelCommand(options);
  const root = path.resolve(options.root);
  let source: SourceDocument;
  if (options.novelPath) {
    source = await withWorkspaceOperationLock(root, "compiler", async () => {
      const config = await loadOptionalConfig(options.configPath ?? path.join(root, "novel-harness.yaml"));
      const result = await ingestWorkspaceSource(root, options.novelPath!, config?.project);
      if (options.sourceId && options.sourceId !== result.document.id) throw new Error("NOVEL_SOURCE_CONFLICT: source file and ID differ; select the original registered source.");
      return result.document;
    });
  } else {
    const workspace = WorkspaceStore.openReadOnly(root), sources = await workspace.listSources();
    if (options.sourceId) source = await resolveNovelSource(workspace, options.sourceId);
    else if (sources.length === 1) source = sources[0]!;
    else throw new Error(`Select one source with --source or a novel path. Registered sources: ${sources.map(s => s.id).join(", ") || "none"}.`);
  }
  const directory = compileLoopDirectory(root, source.id), policyFile = path.join(directory, "policy.json");
  const retained = existsSync(policyFile) ? read<{ request: WorkerRequest; engineerModel: string }>(policyFile) : undefined;
  const explicit: WorkerRequest = { root, sourceId: source.id, model: options.model,
    configPath: options.configPath ? path.resolve(root, options.configPath) : undefined, branchId: options.branchId,
    rebuild: options.rebuild || retained?.request.rebuild, cacheRoot: options.cacheRoot,
    evaluationPlanFile: options.evaluationPlanFile ? path.resolve(root, options.evaluationPlanFile) : undefined,
    evaluationPlanHash: options.evaluationPlanHash, upstreamRepairPlan: options.upstreamRepairPlan,
    upstreamRepairFinishFile: options.upstreamRepairFinishFile ? path.resolve(root, options.upstreamRepairFinishFile) : undefined };
  const request = { ...retained?.request, ...Object.fromEntries(Object.entries(explicit).filter(([, value]) => value !== undefined)) } as WorkerRequest;
  const state = await runCompileLoop({ request, sourceHash: source.contentSha256,
    engineerModel: options.engineerModel ?? retained?.engineerModel ?? "gpt-5.6-sol", signal: options.signal ?? new AbortController().signal,
    legacyState: options.loopHistory, resolution: options.loopResolution, resumeStateHash: options.loopResume, hostPatchHash: options.loopHostPatch, onProgress: options.onProgress });
  if (state.phase !== "DONE") throw new Error(`NOVEL_SUPERVISION_BLOCKED: ${state.reason}\nProgress and the engineering incident are retained. Inspect nwh compile-novel status --source ${source.id}; do not reset counters or retry unchanged.`);
  return state;
}

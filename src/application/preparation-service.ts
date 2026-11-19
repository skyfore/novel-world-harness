import path from "node:path";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { TraceStore } from "../trace/store.js";
import {
  operationAcceptedSchema,
  prepareNovelRequestSchema,
  type OperationAccepted,
  type PrepareNovelRequest,
  type PreparationSnapshot,
} from "../web/contracts.js";
import { WebEventBroker } from "../web/event-stream.js";
import { webError } from "../web/errors.js";
import { OperationManager, type OperationRunContext } from "../web/operation-manager.js";
import { readPreparationSnapshot } from "./preparation-projection.js";
import { compileNovelWithLoop, type SupervisedCompileOptions } from "../commands/compile-novel-loop.js";
import { inspectCompileLoop } from "../runtime/compile-loop/state.js";
import { FULL_COMPILATION_PHASES, NovelCompilationRunStore, type NovelCompilationPhase } from "../workflow/novel-compilation.js";

/**
 * Browser preparation drives the same slim compile chain as the CLI
 * (iteration 02): "all" runs the full chain (supervised), "next" runs the
 * next unfinished phase once. Every pipeline scope is an isolated model job.
 */
export interface PreparationDependencies {
  compileNovel(options: SupervisedCompileOptions): Promise<unknown>;
}

const defaultDependencies: PreparationDependencies = {
  compileNovel: compileNovelWithLoop,
};

export interface PreparationApplicationServiceOptions {
  root: string;
  operations: OperationManager;
  events: WebEventBroker;
  traceStore: TraceStore;
  configPath?: string;
  model?: string;
  dependencies?: Partial<PreparationDependencies>;
}

/** The first phase of the full chain whose latest receipt is not completed. */
export async function nextCompilationPhase(root: string, sourceId: string): Promise<NovelCompilationPhase> {
  const run = await new NovelCompilationRunStore(root).read(sourceId);
  const latest = new Map<string, string>();
  for (const receipt of run?.history ?? []) latest.set(receipt.phase, receipt.status);
  return FULL_COMPILATION_PHASES.find((phase) => latest.get(phase) !== "completed") ?? "branch";
}

export class PreparationApplicationService {
  readonly root: string;
  private readonly dependencies: PreparationDependencies;

  constructor(private readonly options: PreparationApplicationServiceOptions) {
    this.root = path.resolve(options.root);
    this.dependencies = { ...defaultDependencies, ...options.dependencies };
  }

  inspect(sourceId: string, branchId?: string): Promise<PreparationSnapshot> {
    return readPreparationSnapshot(this.root, sourceId, branchId);
  }

  async start(sourceId: string, inputValue: PrepareNovelRequest): Promise<OperationAccepted> {
    const input = prepareNovelRequestSchema.parse(inputValue);
    const existing = this.options.operations.findByClientRequest("prepare", sourceId, input.clientRequestId);
    if (!existing) {
      await this.requireSource(sourceId);
      this.assertNoActiveCompilerOperation(sourceId);
    }
    const accepted = this.options.operations.start({ kind: "prepare", scopeId: sourceId, clientRequestId: input.clientRequestId, request: input,
      run: (context) => this.runPreparation(sourceId, input, context) });
    return operationAcceptedSchema.parse(accepted);
  }

  private async runPreparation(sourceId: string, input: PrepareNovelRequest, context: OperationRunContext): Promise<PreparationSnapshot> {
    context.signal.throwIfAborted();
    this.assertSupervisorAllowsPreparation(sourceId);
    const progress = new PreparationProgress(context);
    const phase = input.mode === "next" ? await nextCompilationPhase(this.root, sourceId) : undefined;
    progress.phase(phase ? `compiling-${phase}` : "continuing-novel-compilation");
    // Scope receipts and committed proposals are durable; cancelling never implies rollback.
    progress.markMutation("novel-compilation-dispatch");
    await this.dependencies.compileNovel({ root: this.root, sourceId,
      ...(this.options.configPath ? { configPath: this.options.configPath } : {}),
      ...(input.model ?? this.options.model ? { model: input.model ?? this.options.model } : {}),
      ...(input.branchId ? { branchId: input.branchId } : {}),
      ...(phase ? { phase, loop: false } : {}),
      signal: context.signal, onProgress: (message) => progress.log(message) });
    progress.flush();
    const result = await this.inspect(sourceId, input.branchId);
    this.options.events.publish("catalog.invalidated", { reason: "preparation-finished", sourceId, stage: result.stage }, { operationId: context.operationId });
    return result;
  }

  private assertSupervisorAllowsPreparation(sourceId: string): void {
    const supervision = inspectCompileLoop(this.root, sourceId);
    if (supervision?.phase === "BREAK") throw new Error(`COMPILE_LOOP_RETAINED_STOP: ${supervision.reason}. Inspect nwh compile-novel plan --source ${sourceId} and resolve the original host condition before resuming the retained supervisor. Browser preparation cannot renew consumed stages or budgets; do not retry unchanged.`);
  }

  private async requireSource(sourceId: string): Promise<void> {
    const workspace = await WorkspaceStore.create(this.root);
    if (await workspace.getSource(sourceId)) return;
    throw webError(404, "SOURCE_NOT_FOUND", `Unknown novel source '${sourceId}'.`, {
      kind: "after-refresh",
      discoveryEndpoint: "/api/v1/novels",
      copyField: "id",
      maxAttempts: 1,
    });
  }

  private assertNoActiveCompilerOperation(sourceId: string): void {
    const active = this.options.operations.list().find((operation) =>
      operation.kind === "prepare"
      && operation.status !== "succeeded"
      && operation.status !== "failed"
      && operation.status !== "cancelled"
      && operation.status !== "interrupted");
    if (!active) return;
    throw webError(409, "PREPARATION_ALREADY_RUNNING", `Preparation operation '${active.id}' is already active for source '${active.scopeId}'.`, {
      kind: "after-refresh",
      discoveryEndpoint: `/api/v1/operations/${encodeURIComponent(active.id)}`,
      copyField: "id",
      maxAttempts: 1,
    }, { requestedSourceId: sourceId, activeSourceId: active.scopeId });
  }
}

class PreparationProgress {
  private readonly logs: string[] = [];
  private mutationMarked = false;

  constructor(private readonly context: OperationRunContext) {}

  log(message: string): void {
    this.logs.push(message);
    if (this.logs.length > 80) this.logs.splice(0, this.logs.length - 80);
    this.phase("working", { lastMessage: message });
  }

  phase(phase: string, extra: Record<string, unknown> = {}): void {
    this.context.update(phase, {
      logs: [...this.logs],
      ...extra,
    });
  }

  markMutation(reason: string, extra: Record<string, unknown> = {}): void {
    if (this.mutationMarked) return;
    this.mutationMarked = true;
    this.context.markCommitBoundary({ mutationReason: reason, ...extra });
  }

  flush(): void {
    this.phase("checkpointed");
  }
}

function traceError(error: unknown) {
  return {
    code: error instanceof Error && error.name === "AbortError" ? "OPERATION_CANCELLED" : "PREPARATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

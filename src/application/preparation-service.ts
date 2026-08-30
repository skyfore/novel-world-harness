import path from "node:path";
import { compileCommand, type CompileCommandOptions } from "../commands/compile.js";
import { compileSourceCommand, type CompileSourceOptions } from "../commands/compile-source.js";
import { INITIAL_WORLD_PROMPT } from "../commands/prepare-all.js";
import { prepareOpeningWorldCompilerBatch, proposeMinimalOpeningWorld, type CompilerBatch } from "../compiler/batches.js";
import { rejectPendingCompilerBatchProposals } from "../compiler/proposals.js";
import {
  ENTITY_RESOLUTION_PROPOSAL_TOOL_NAMES,
  EVENT_RESOLUTION_PROPOSAL_TOOL_NAMES,
  SOURCE_ANNOTATION_PROPOSAL_TOOL_NAMES,
} from "../compiler/proposal-tools.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { TraceRecorder } from "../trace/recorder.js";
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
import { inspectPreparation } from "../workflow/prepare.js";
import { readPreparationSnapshot } from "./preparation-projection.js";

const OPENING_DISABLED_TOOLS = [
  "propose_state_delta",
  ...SOURCE_ANNOTATION_PROPOSAL_TOOL_NAMES,
  ...ENTITY_RESOLUTION_PROPOSAL_TOOL_NAMES,
  ...EVENT_RESOLUTION_PROPOSAL_TOOL_NAMES,
] as const;

export interface PreparationDependencies {
  compileSource(options: CompileSourceOptions): Promise<void>;
  compileOpening(options: CompileCommandOptions): Promise<void>;
  prepareOpeningBatch(root: string, source: Parameters<typeof prepareOpeningWorldCompilerBatch>[1]): ReturnType<typeof prepareOpeningWorldCompilerBatch>;
  proposeFallback(root: string, source: Parameters<typeof proposeMinimalOpeningWorld>[1]): Promise<string>;
  rejectBatchProposals(root: string, batchId: string): Promise<string[]>;
}

const defaultDependencies: PreparationDependencies = {
  compileSource: compileSourceCommand,
  compileOpening: compileCommand,
  prepareOpeningBatch: prepareOpeningWorldCompilerBatch,
  proposeFallback: proposeMinimalOpeningWorld,
  rejectBatchProposals: rejectPendingCompilerBatchProposals,
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
    if (existing) {
      return this.options.operations.start({
        kind: "prepare",
        scopeId: sourceId,
        clientRequestId: input.clientRequestId,
        request: input,
        run: async () => { throw new Error("An idempotent operation must not be executed twice."); },
      });
    }
    await this.requireSource(sourceId);
    this.assertNoActiveCompilerOperation(sourceId);
    const recorder = await TraceRecorder.start(this.options.traceStore, {
      kind: "prepare",
      sourceId,
    });
    try {
      const accepted = this.options.operations.start({
        kind: "prepare",
        scopeId: sourceId,
        clientRequestId: input.clientRequestId,
        request: input,
        runId: recorder.manifest.id,
        run: (context) => this.runWithTrace(recorder, sourceId, input, context),
      });
      if (accepted.reused) {
        await recorder.finish("cancelled", {}, {
          code: "IDEMPOTENT_OPERATION_REUSED",
          message: "A concurrent request reused an existing operation; this unused trace was closed without executing.",
          retryable: false,
        });
        return accepted;
      }
      await recorder.link({ operationId: accepted.operation.id });
      return operationAcceptedSchema.parse(accepted);
    } catch (error) {
      await recorder.finish("failed", {}, traceError(error)).catch(() => undefined);
      throw error;
    }
  }

  private async runWithTrace(
    recorder: TraceRecorder,
    sourceId: string,
    input: PrepareNovelRequest,
    context: OperationRunContext,
  ): Promise<PreparationSnapshot> {
    try {
      const result = await this.runPreparation(recorder, sourceId, input, context);
      await recorder.finish("succeeded");
      this.options.events.publish("catalog.invalidated", {
        reason: "preparation-finished",
        sourceId,
        stage: result.stage,
      }, { operationId: context.operationId, runId: recorder.manifest.id });
      return result;
    } catch (error) {
      const cancelled = context.signal.aborted && !context.commitBoundaryCrossed;
      await recorder.finish(
        cancelled ? "cancelled" : context.commitBoundaryCrossed ? "interrupted" : "failed",
        {},
        traceError(error),
      ).catch(() => undefined);
      throw error;
    }
  }

  private async runPreparation(
    recorder: TraceRecorder,
    sourceId: string,
    input: PrepareNovelRequest,
    context: OperationRunContext,
  ): Promise<PreparationSnapshot> {
    context.signal.throwIfAborted();
    const workspace = await WorkspaceStore.create(this.root);
    const source = await workspace.getSource(sourceId);
    if (!source) throw new Error(`Unknown source id: ${sourceId}`);
    const before = await inspectPreparation(this.root, { sourceId, ...(input.branchId ? { branchId: input.branchId } : {}) });
    const progress = new PreparationProgress(context);
    progress.log(`Preparation stage is '${before.stage}'.`);

    if (before.stage === "compile") {
      const stage = await recorder.child(recorder.rootContext, input.mode === "next" ? "Compile next evidence batch" : "Compile remaining evidence batches", "compiler");
      try {
        progress.phase("compiling", {
          completedBatches: before.completedBatches,
          totalBatches: before.totalBatches,
        });
        await this.dependencies.compileSource({
          root: this.root,
          configPath: this.options.configPath ?? path.join(this.root, "novel-harness.yaml"),
          allowMissingConfig: true,
          sourceId,
          ...(input.model ?? this.options.model ? { model: input.model ?? this.options.model } : {}),
          maxBatches: input.mode === "next" ? 1 : undefined,
          resume: true,
          signal: context.signal,
          traceParent: stage,
          ...progress.callbacks(),
        });
        progress.markMutation("compiler-checkpoint", {
          completedMode: input.mode,
        });
        progress.flush();
        await recorder.finishStage(stage, { mode: input.mode });
      } catch (error) {
        await recorder.failStage(stage, error);
        throw error;
      }
      if (input.mode === "next") return this.inspect(sourceId, input.branchId);
    }

    let inspection = await inspectPreparation(this.root, { sourceId, ...(input.branchId ? { branchId: input.branchId } : {}) });
    if (inspection.stage === "needs-initial-world") {
      const stage = await recorder.child(recorder.rootContext, "Generate opening-world proposal", "compiler");
      const openingBatch = await this.dependencies.prepareOpeningBatch(this.root, source);
      progress.phase("generating-initial-world", { compilerBatchId: openingBatch.id });
      try {
        await this.dependencies.compileOpening({
          root: this.root,
          configPath: this.options.configPath ?? path.join(this.root, "novel-harness.yaml"),
          allowMissingConfig: true,
          ...(input.model ?? this.options.model ? { model: input.model ?? this.options.model } : {}),
          saveSession: false,
          prompt: `${INITIAL_WORLD_PROMPT}\n\n${openingBatch.prompt}`,
          segmentIds: openingBatch.segmentIds,
          compilerBatchId: openingBatch.id,
          sourceId,
          includeLocalTools: false,
          disabledProposalTools: [...OPENING_DISABLED_TOOLS],
          signal: context.signal,
          trace: openingTrace(stage, openingBatch),
          ...progress.callbacks(),
        });
      } catch (error) {
        context.signal.throwIfAborted();
        const rejected = await this.dependencies.rejectBatchProposals(this.root, openingBatch.id);
        progress.log(`Opening-world model pass failed; rejected ${rejected.length} partial proposal(s) before deterministic fallback.`);
      }
      context.signal.throwIfAborted();
      inspection = await inspectPreparation(this.root, { sourceId, ...(input.branchId ? { branchId: input.branchId } : {}) });
      if (inspection.stage === "needs-initial-world" && inspection.pending.length === 0) {
        const fallbackId = await this.dependencies.proposeFallback(this.root, source);
        progress.markMutation("fallback-proposal", { proposalId: fallbackId });
        await recorder.record("validation.completed", {
          outcome: "fallback-proposal-created",
          proposalId: fallbackId,
          authority: "proposal-only",
        }, stage);
        progress.log(`Created restricted opening-world fallback proposal '${fallbackId}'.`);
      }
      progress.flush();
      await recorder.finishStage(stage, { compilerBatchId: openingBatch.id });
    } else if (["review", "repair", "create-branch", "ready"].includes(inspection.stage)) {
      progress.phase(`barrier-${inspection.stage}`, { stage: inspection.stage });
      progress.log(`No model call was started because '${inspection.stage}' is a browser decision barrier.`);
    }

    return this.inspect(sourceId, input.branchId);
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
  private modelTextTail = "";
  private modelTextCharacters = 0;
  private thinkingCharacters = 0;
  private lastTextPublish = 0;
  private mutationMarked = false;

  constructor(private readonly context: OperationRunContext) {}

  callbacks(): Pick<CompileSourceOptions,
    "onProgress" | "onStatus" | "onModelText" | "onModelThinking" | "onModelToolCall" | "onModelToolResult"> {
    return {
      onProgress: (message) => this.log(message),
      onStatus: (message) => this.phase("waiting-for-model", { statusMessage: message }),
      onModelText: (delta) => {
        this.modelTextCharacters += delta.length;
        this.modelTextTail = `${this.modelTextTail}${delta}`.slice(-8_000);
        const now = Date.now();
        if (now - this.lastTextPublish >= 200 || this.modelTextCharacters % 2_048 < delta.length) {
          this.lastTextPublish = now;
          this.phase("receiving-model-output");
        }
      },
      onModelThinking: (delta) => {
        this.thinkingCharacters += delta.length;
      },
      onModelToolCall: (name) => {
        this.log(`Tool call: ${name}`);
        this.phase("running-tool", { currentTool: name });
      },
      onModelToolResult: (name, _result, isError) => {
        this.log(`Tool ${name} ${isError ? "failed" : "completed"}.`);
        if (!isError && compilerToolMutates(name)) this.markMutation("compiler-tool", { currentTool: name });
      },
    };
  }

  log(message: string): void {
    this.logs.push(message);
    if (this.logs.length > 80) this.logs.splice(0, this.logs.length - 80);
    this.phase("working", { lastMessage: message });
  }

  phase(phase: string, extra: Record<string, unknown> = {}): void {
    this.context.update(phase, {
      logs: [...this.logs],
      modelTextCharacters: this.modelTextCharacters,
      modelTextTail: this.modelTextTail,
      hiddenReasoningCharacters: this.thinkingCharacters,
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

function compilerToolMutates(name: string): boolean {
  return name.startsWith("propose_")
    || name === "configure_chapter_split"
    || name === "withdraw_compiler_proposal"
    || name === "replace_boundary_proposal"
    || name === "defer_boundary_artifact"
    || name === "finish_compiler_batch";
}

function openingTrace(parent: Parameters<typeof TraceRecorder.prototype.child>[0], batch: CompilerBatch): NonNullable<CompileCommandOptions["trace"]> {
  return {
    parent,
    invocationName: "opening-world compiler",
    metadata: {
      sourceId: batch.sourceId,
      compilerBatchId: batch.id,
      startLine: batch.startLine,
      endLine: batch.endLine,
      segmentIds: batch.segmentIds,
    },
    parts: [{
      id: `compiler.opening.${batch.id}`,
      label: "Opening-world evidence and proposal policy",
      kind: "compiler.batch",
      role: "user",
      authority: "untrusted-source",
      content: `${INITIAL_WORLD_PROMPT}\n\n${batch.prompt}`,
      sourceRefs: batch.evidence.map((reference) => ({
        sourceId: reference.span.sourceId,
        ...(reference.span.startByte !== undefined ? { startByte: reference.span.startByte } : {}),
        ...(reference.span.endByte !== undefined ? { endByte: reference.span.endByte } : {}),
        label: `lines ${reference.span.startLine}-${reference.span.endLine}`,
      })),
    }],
  };
}

function traceError(error: unknown) {
  return {
    code: error instanceof Error && error.name === "AbortError" ? "OPERATION_CANCELLED" : "PREPARATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

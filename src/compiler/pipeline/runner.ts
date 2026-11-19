import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";
import { PIPELINE_SYSTEM_PROMPT, type StageAgent } from "./agent.js";
import { PipelineStore, addUsage, emptyUsage, type GateResult, type PipelineRange, type ScopeReceipt } from "./store.js";
import { pipelineTool, withHostLock } from "./tooling.js";
import { loadPipelineView, type PipelineView } from "./view.js";

export const PIPELINE_MODEL_STAGES = ["census", "observation", "identity", "scenes", "world", "roster", "opening", "gaps"] as const;
export type PipelineModelStage = typeof PIPELINE_MODEL_STAGES[number];

/** Scopes failing their gate this many times are held for host review; the stage continues with other scopes. */
export const MAX_SCOPE_ATTEMPTS = 2;

export type ScopePlan = { id: string; range: PipelineRange; items: string[]; title: string };

export type StageContext = {
  root: string;
  sourceId: string;
  /** Prefix compile: only source bytes before this offset are in play. */
  limit: number;
  agent: StageAgent;
  store: PipelineStore;
  runId: string;
  generatedBy: { provider?: string; model?: string };
  signal?: AbortSignal;
  report: (message: string) => void;
  /** Scopes of one stage that may run side by side (non-overlapping ranges only). Default 1. */
  concurrency?: number;
  /** Per-stage model provenance when stages route to different profiles (design 5.9). */
  stageGeneratedBy?: Partial<Record<PipelineModelStage, { provider?: string; model?: string }>>;
};

export type ScopeSession = { finished: boolean; lastGate?: GateResult; calls: number };

export type StageDefinition = {
  stage: PipelineModelStage;
  /** Scopes depend on the previous scope's result (observation windows continue segments); never run them side by side. */
  sequential?: boolean;
  /** Host-derived scopes inside the prefix. */
  plan(ctx: StageContext, view: PipelineView): ScopePlan[] | Promise<ScopePlan[]>;
  /** Host work that needs no model (deterministic candidates, decision expansion). */
  prepare?(ctx: StageContext, scope: ScopePlan): Promise<void>;
  prompt(ctx: StageContext, view: PipelineView, scope: ScopePlan, previous?: GateResult): string;
  tools(ctx: StageContext, scope: ScopePlan, session: ScopeSession): ToolDefinition[];
  /** Commit staged model work so the gate sees it; returns blocking issues to show the model. */
  commit?(ctx: StageContext, scope: ScopePlan): Promise<string[]>;
  /** The gate: the same completeness measures, limited to this scope. */
  gate(ctx: StageContext, view: PipelineView, scope: ScopePlan): GateResult | Promise<GateResult>;
};

export type StageRunSummary = { stage: PipelineModelStage; completed: string[]; held: string[]; skipped: string[]; usage: ReturnType<typeof emptyUsage> };

export function gateOf(checks: GateResult["checks"]): GateResult {
  return { passed: checks.every((check) => check.passed), checks };
}

function finishTool(definition: StageDefinition, ctx: StageContext, scope: ScopePlan, session: ScopeSession): ToolDefinition {
  return pipelineTool({
    name: "finish_scope",
    label: "Finish scope",
    description: "Commit this scope's work and run its gate. Returns every failing check; fix them and call again. The scope completes only when the gate passes.",
    parameters: Type.Object({}, { additionalProperties: false }),
    input: z.object({}).strict(),
    async execute() {
      session.calls += 1;
      const issues = definition.commit ? await definition.commit(ctx, scope) : [];
      const gate = await definition.gate(ctx, await loadPipelineView(ctx.root, ctx.sourceId), scope);
      session.lastGate = gate;
      session.finished = gate.passed && issues.length === 0;
      return { passed: session.finished, commitIssues: issues, failing: gate.checks.filter((check) => !check.passed), passing: gate.checks.filter((check) => check.passed).map((check) => check.id) };
    },
  });
}

function receiptBase(scope: ScopePlan, stage: string, previous?: ScopeReceipt): ScopeReceipt {
  return previous ?? { id: scope.id, stage, range: scope.range, items: scope.items, status: "running", attempts: 0, usage: emptyUsage(), traceRunIds: [], startedAt: new Date().toISOString() };
}

const overlapping = (left: PipelineRange, right: PipelineRange) => left.startByte < right.endByte && right.startByte < left.endByte;

/**
 * Run one stage over its scopes. A completed scope whose gate still passes is
 * skipped; a held scope is left for host review or the gap loop. Each attempt
 * is a fresh isolated agent run; after the agent returns the host commits and
 * re-runs the gate itself, so a model cannot finish a scope by assertion.
 *
 * With `concurrency` above 1, scopes whose source ranges do not overlap run
 * side by side (design 5.8: unrelated items in parallel); a whole-source
 * scope runs alone. Host work is serialised by `withHostLock`.
 */
export async function runStage(definition: StageDefinition, ctx: StageContext, options: { scopeIds?: readonly string[]; maxAttempts?: number; concurrency?: number } = {}): Promise<StageRunSummary> {
  const summary: StageRunSummary = { stage: definition.stage, completed: [], held: [], skipped: [], usage: emptyUsage() };
  const stageCtx: StageContext = ctx.stageGeneratedBy?.[definition.stage] ? { ...ctx, generatedBy: ctx.stageGeneratedBy[definition.stage]! } : ctx;
  const plan = await definition.plan(stageCtx, await loadPipelineView(ctx.root, ctx.sourceId));
  const selected = options.scopeIds ? plan.filter((scope) => options.scopeIds!.includes(scope.id)) : plan;
  const maxAttempts = options.maxAttempts ?? MAX_SCOPE_ATTEMPTS;
  const concurrency = definition.sequential ? 1 : Math.max(1, options.concurrency ?? ctx.concurrency ?? 1);
  const pending = [...selected];
  const active = new Map<string, { range: PipelineRange; done: Promise<void> }>();
  let failure: unknown;
  while ((pending.length || active.size) && failure === undefined) {
    ctx.signal?.throwIfAborted();
    const index = active.size < concurrency ? pending.findIndex((scope) => ![...active.values()].some((running) => overlapping(running.range, scope.range))) : -1;
    if (index >= 0) {
      const scope = pending.splice(index, 1)[0]!;
      const done = runScope(definition, stageCtx, scope, maxAttempts, summary).catch((error: unknown) => { failure ??= error; }).finally(() => { active.delete(scope.id); });
      active.set(scope.id, { range: scope.range, done });
      continue;
    }
    await Promise.race([...active.values()].map((running) => running.done));
  }
  await Promise.all([...active.values()].map((running) => running.done));
  if (failure !== undefined) throw failure;
  return summary;
}

async function runScope(definition: StageDefinition, ctx: StageContext, scope: ScopePlan, maxAttempts: number, summary: StageRunSummary): Promise<void> {
  ctx.signal?.throwIfAborted();
  const previous = await ctx.store.receipt(scope.id);
  if (previous?.status === "held") { summary.held.push(scope.id); return; }
  let gate = await withHostLock(async () => {
    await definition.prepare?.(ctx, scope);
    return definition.gate(ctx, await loadPipelineView(ctx.root, ctx.sourceId), scope);
  });
  if (gate.passed) {
    if (previous?.status !== "completed") await withHostLock(() => ctx.store.writeReceipt({ ...receiptBase(scope, definition.stage, previous), status: "completed", gate, finishedAt: new Date().toISOString() }));
    summary.skipped.push(scope.id);
    return;
  }
  let receipt = receiptBase(scope, definition.stage, previous?.status === "completed" ? { ...previous, attempts: 0 } : previous);
  while (!gate.passed && receipt.attempts < maxAttempts) {
    receipt = { ...receipt, status: "running", attempts: receipt.attempts + 1 };
    const started = receipt;
    await withHostLock(() => ctx.store.writeReceipt(started));
    ctx.report(`${definition.stage} ${scope.id} (${scope.title}): attempt ${receipt.attempts}/${maxAttempts}`);
    const session: ScopeSession = { finished: false, calls: 0 };
    const view = await loadPipelineView(ctx.root, ctx.sourceId);
    const tools = [...definition.tools(ctx, scope, session), finishTool(definition, ctx, scope, session)];
    try {
      const result = await ctx.agent.run({ sourceId: ctx.sourceId, stage: definition.stage, scopeId: scope.id, systemPrompt: PIPELINE_SYSTEM_PROMPT,
        prompt: definition.prompt(ctx, view, scope, receipt.attempts > 1 ? gate : undefined), tools, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      receipt.usage = addUsage(receipt.usage, result.usage);
      summary.usage = addUsage(summary.usage, result.usage);
      if (result.traceRunId) receipt.traceRunIds = [...receipt.traceRunIds, result.traceRunId];
      delete receipt.error;
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      receipt.error = error instanceof Error ? error.message.slice(0, 4_000) : String(error);
    }
    gate = await withHostLock(async () => {
      const issues = definition.commit ? await definition.commit(ctx, scope) : [];
      const checked = await definition.gate(ctx, await loadPipelineView(ctx.root, ctx.sourceId), scope);
      return issues.length ? gateOf([...checked.checks, { id: "commit", passed: false, detail: issues.slice(0, 20).join("; ") }]) : checked;
    });
    receipt = { ...receipt, gate };
    const attempted = receipt;
    await withHostLock(() => ctx.store.writeReceipt(attempted));
  }
  const finishedAt = new Date().toISOString();
  if (gate.passed) {
    const completed = { ...receipt, status: "completed" as const, gate, finishedAt };
    await withHostLock(() => ctx.store.writeReceipt(completed));
    summary.completed.push(scope.id);
  } else {
    const held = { ...receipt, status: "held" as const, gate, finishedAt };
    await withHostLock(() => ctx.store.writeReceipt(held));
    summary.held.push(scope.id);
    ctx.report(`${definition.stage} ${scope.id}: held for host review after ${receipt.attempts} attempts (${gate.checks.filter((check) => !check.passed).map((check) => check.id).join(", ")})`);
  }
}

/** Re-open a held scope (after host review) so the next run attempts it again; the review is kept on the receipt. */
export async function releaseHeldScope(store: PipelineStore, scopeId: string, note?: string): Promise<void> {
  const receipt = await store.receipt(scopeId);
  if (!receipt || receipt.status !== "held") throw new Error(`Scope ${scopeId} is not held.`);
  const release = { at: new Date().toISOString(), attempts: receipt.attempts, ...(note ? { note } : {}) };
  await store.writeReceipt({ ...receipt, status: "running", attempts: 0, releases: [...(receipt.releases ?? []), release] });
}

/** Release held scopes by id, by stage, or all of them. Returns the released ids. */
export async function releaseHeldScopes(store: PipelineStore, selection: { scopeIds?: readonly string[]; stage?: string; all?: boolean }, note?: string): Promise<string[]> {
  const held = (await store.receipts()).filter((receipt) => receipt.status === "held");
  if (selection.scopeIds?.length) {
    const unknown = selection.scopeIds.filter((id) => !held.some((receipt) => receipt.id === id));
    if (unknown.length) throw new Error(`Not held: ${unknown.join(", ")}. List held scopes with compile-novel status.`);
  }
  const chosen = held.filter((receipt) => selection.all || selection.scopeIds?.includes(receipt.id) || (selection.stage && receipt.stage === selection.stage));
  if (!selection.all && !selection.scopeIds?.length && !selection.stage) throw new Error("Choose --scope <id>, --stage <stage> or --all.");
  for (const receipt of chosen) await releaseHeldScope(store, receipt.id, note);
  return chosen.map((receipt) => receipt.id);
}

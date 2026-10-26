import fs from "node:fs/promises";
import { appendFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { getAgentDir, ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PiAgentSession, type PiAgentSessionOptions } from "../agent/pi-session.js";
import { losslessContextInstructions } from "../agent/lossless-json-context.js";
import { ModelRequestBudget, type ModelRequestLimits } from "../runtime/model-request-budget.js";
import { withCompilerSignals } from "../util/compiler-signals.js";
import { TraceStore } from "../trace/store.js";
import { TraceRecorder } from "../trace/recorder.js";
import { contentHash } from "../world/canonical.js";
import { prerequisiteStop } from "../compiler/role-source-prerequisites.js";
import { assertIdentitySubmissionTurn, type IdentitySessionContract } from "../compiler/identity-session-integrity.js";
import { sealIdentityUpstreamSession } from "../compiler/identity-upstream-session.js";

export const retainPiArtifact = async (file: string, value: unknown) => {
  try { await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || contentHash(JSON.parse(await fs.readFile(file, "utf8"))) !== contentHash(value)) throw error;
  }
};
export async function assertPiSubscription(root: string) {
  const runtime = await ModelRuntime.create({ authPath: getAgentDir() + "/auth.json", modelsPath: getAgentDir() + "/models.json", refreshOnCreate: false });
  if ((await runtime.checkAuth("openai-codex"))?.type !== "oauth" || !runtime.getProvider("openai-codex")?.auth?.oauth?.isSubscription
    || !runtime.getModel("openai-codex", "gpt-6.1-sol")) throw prerequisiteStop("Required Pi subscription unavailable; no provider fallback or new invocation");
  if ((await new TraceStore(root).peekRuns({ status: "running", limit: 1 })).length) throw prerequisiteStop("An original trace is unsettled; inspect its owning operation, do not dispatch or retry");
}

/** Shared transport for a new receipt-bound stage. No recovery path replays a
 * consumed invocation; callers may only recover its sealed original result. */
export async function runReceiptBoundPiStage<T>(options: {
  root: string; sourceId: string; directory: string; stage: string; scopeHash: string; originalBudgetHash: string;
  priorUsage: { modelCalls: number; totalPayloadBytes: number }; limits: ModelRequestLimits; contract: IdentitySessionContract;
  continuationHash?: string;
  budgetAmendmentHash?: string;
  assertOriginal: () => Promise<void>;
  run: (factory: (args: PiAgentSessionOptions) => Promise<PiAgentSession>, trace: TraceRecorder, budget: ModelRequestBudget, signal: AbortSignal) => Promise<T>;
}) {
  const { root, sourceId, directory, stage, scopeHash, contract } = options;
  await options.assertOriginal();
  try { await fs.writeFile(path.join(directory, `${stage}.invocation.json`), JSON.stringify({ scopeHash, stage, pid: process.pid,
    ...(options.continuationHash ? { continuationHash: options.continuationHash } : {}),
    ...(options.budgetAmendmentHash ? { budgetAmendmentHash: options.budgetAmendmentHash } : {}) }), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw prerequisiteStop("This receipt-bound Pi invocation is consumed; inspect its original checkpoint and failure, never redispatch or rename the stage"); throw error; }
  const budget = new ModelRequestBudget(options.limits, { save: state => {
    const file = path.join(directory, `${stage}.budget.json`);
    writeFileSync(file + ".tmp", JSON.stringify({ scopeHash, stage, originalBudgetHash: options.originalBudgetHash, limits: options.limits,
      ...(options.budgetAmendmentHash ? { budgetAmendmentHash: options.budgetAmendmentHash } : {}),
      priorUsage: options.priorUsage, state, cumulative: { modelCalls: options.priorUsage.modelCalls + state.usage.modelCalls,
        totalPayloadBytes: options.priorUsage.totalPayloadBytes + state.usage.totalPayloadBytes } }), { flag: "wx", mode: 0o600 });
    renameSync(file + ".tmp", file);
  } });
  const requests = path.join(directory, `${stage}.requests.jsonl`), messages = path.join(directory, `${stage}.messages.jsonl`);
  await fs.writeFile(requests, "", { flag: "wx", mode: 0o600 }); await fs.writeFile(messages, "", { flag: "wx", mode: 0o600 });
  const trace = await TraceRecorder.start(new TraceStore(root), { kind: "prepare", sourceId,
    operationId: `receipt-bound-${scopeHash}-${stage}${options.continuationHash ? "-continuation" : ""}` });
  let session: PiAgentSession | undefined, prompt: string | undefined, fatal: unknown, sequence = 0;
  const observe = (phase: string, value: unknown) => fs.appendFile(requests, JSON.stringify({ phase, value }) + "\n");
  try {
    const value = await withCompilerSignals(signal => options.run(async args => {
      session = await PiAgentSession.create({ ...args, model: "openai-codex/gpt-6.1-sol", requestBudget: budget,
        additionalTools: args.additionalTools?.map(t => ({ ...t, execute: async (...a: Parameters<typeof t.execute>) => { if (fatal) throw fatal; return t.execute(...a); } })) as ToolDefinition[],
        systemPromptOverride: losslessContextInstructions + (args.systemPromptOverride ?? ""), piAgentDir: getAgentDir(), saveSession: true,
        runtimeDir: path.join(directory, "sessions", stage), includeProjectInstructions: false, includeLocalTools: false, includeNwhExtension: false,
        trackLastOpenedSession: false, autoCompaction: false, losslessJsonReadTools: [...contract.readTools],
        onLosslessContext: value => observe("original-context", value), onRequestObservation: ({ phase, value }) => observe(phase, value),
        trace: { parent: trace.rootContext, invocationName: stage, parts: [] },
        onEvent: event => { if (event.type === "message_end") {
          try { appendFileSync(messages, JSON.stringify({ sequence: ++sequence, message: event.message }) + "\n"); if (event.message.role === "assistant") assertIdentitySubmissionTurn(event.message, contract.terminalTool); }
          catch (error) { fatal ??= error; }
        } }, beforeModelRequest: async () => { if (fatal) throw fatal; await options.assertOriginal(); } });
      if (session.model !== "openai-codex/gpt-6.1-sol") throw prerequisiteStop("Pi provider changed; no fallback");
      const actual = session.promptWithReport.bind(session);
      session.promptWithReport = async (text, config) => {
        prompt = text;
        await fs.writeFile(path.join(directory, `${stage}.input.json`), JSON.stringify(JSON.parse(text), null, 2), { flag: "wx", mode: 0o600 });
        await trace.record("stage.started", { phase: stage, scopeHash, inputHash: contentHash(JSON.parse(text)), sessionId: session!.id, subscription: true });
        return actual(text, config);
      };
      return session;
    }, trace, budget, signal));
    if (fatal) throw fatal;
    if (!session?.sessionFile || !prompt) throw prerequisiteStop("Pi returned no complete saved session; preserve its invocation, no replay");
    await options.assertOriginal(); budget.close(); await session.dispose();
    const checkpoint = await sealIdentityUpstreamSession(root, directory, stage, { planHash: scopeHash, sessionId: session.id, sessionFile: session.sessionFile,
      traceRunId: trace.manifest.id, contract, prompt, usage: budget.snapshot(), providerUsage: budget.report().providerUsage });
    await trace.finish("succeeded");
    return { value, sessionId: session.id, traceRunId: trace.manifest.id, sessionCheckpointHash: contentHash(checkpoint), inputHash: contentHash(JSON.parse(prompt)) };
  } catch (error) {
    if (!trace.manifest.endedAt) await trace.finish("failed").catch(() => {});
    await retainPiArtifact(path.join(directory, `${stage}.failure.json`), { reason: String(error), sessionId: session?.id, sessionFile: session?.sessionFile, usage: budget.report() });
    throw error;
  } finally { budget.close(); await session?.dispose(); }
}

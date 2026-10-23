import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, fauxThinking, fauxText } from "@earendil-works/pi-ai";
import { PiAgentSession } from "../../src/agent/pi-session.js";
import { contentHash as h } from "../../src/world/canonical.js";
import { SegmentStore } from "../../src/compiler/segments.js";
import { identityStages } from "../../src/compiler/identity-requirements.js";
import { runIdentityRequirements } from "../../src/workflow/identity-requirements.js";
import * as service from "../../src/compiler/identity-requirement-service.js";
import { identityFixture } from "./identity-fixture.js";
import { roleDependencyFixture } from "./role-dependency-fixture.js";
import { semanticScopeSelectors } from "../../src/compiler/role-semantic-scope.js";
import { mockPiProvider } from "./pi-provider.js";
import { digest } from "../../src/runtime/compile-loop/workspace.js";
import { decodeJsonValues, LOSSLESS_CONTEXT_PROTOCOL } from "../../src/agent/lossless-json-context.js";

export async function realIdentityFixture(large = false, failFirstConsumer = false, consumerCount = 48) {
  const controls = { failFirstConsumer, exhaustRecovery: false, submitWithReads: false, discoverOperationHashes: false };
  let parent: any;
  const bytes = Buffer.from("Ada waits.\n" + (large ? Array.from({ length: 2800 }, (_, i) => `${i}:未核实的人物关系必须保留未知，不能推断同一身份。\n`).join("") : ""));
  const upstream = await roleDependencyFixture(failFirstConsumer ? (root, source) => {
    parent = { phase: "BREAK", root, sourceId: source.id, sourceHash: source.contentSha256, childPid: null,
      workers: 21, repairs: 20, commands: 83, failures: { original: 2 }, pending: { key: "original" } };
    return digest(parent);
  } : h("BREAK"), bytes.toString()), { root } = upstream, source = upstream.f;
  let f = identityFixture();
  let serialized = JSON.stringify(f).replaceAll(f.intent.taskId, upstream.review.taskId).replaceAll(f.intent.taskId.slice(0, 32), upstream.review.taskId.slice(0, 32))
    .replaceAll('"src"', JSON.stringify(source.source.id)).replaceAll('"seg"', JSON.stringify(source.segmentId));
  f.inventory.originalQuestionIds.forEach((id, i) => { serialized = serialized.replaceAll(id, upstream.scope.questions[i]!.questionId); });
  f = JSON.parse(serialized);
  const p = f.p;
  p.review = upstream.review; p.prerequisites = upstream.prepared.prerequisites; p.representations = upstream.prepared.representations;
  p.bytes = bytes; p.manifest = await new SegmentStore(root).readManifest(source.source.id);
  // Every required segment is retained, even when the source fixture is paged.
  p.intent.requiredSourceSegmentIds = p.manifest.segments.map((s: { id: string }) => s.id);
  p.intent.sourceHash = source.source.contentSha256;
  Object.assign(p.intent, { revisionHash: upstream.review.revisionHash, parentStateHash: upstream.scope.parentStateHash,
    originalPlanHash: upstream.scope.planHash, originalBudgetHash: upstream.scope.originalBudgetHash });
  const auditBudgetFile = path.join(root, "audit-budget.json"), priorBudgetFile = path.join(root, "prior-budget.json");
  const audit = { hash: p.intent.originalBudgetHash, planHash: p.intent.originalPlanHash, state: { usage: { modelCalls: 19, totalPayloadBytes: 1000 } } };
  const prior = { state: { usage: { modelCalls: 124, totalPayloadBytes: 11000 } } };
  await fs.writeFile(auditBudgetFile, JSON.stringify(audit)); await fs.writeFile(priorBudgetFile, JSON.stringify(prior));
  p.intent.priorUsage.budgetFilesHash = h({ audit, budgets: [{ file: priorBudgetFile, value: prior }] });
  const operations = p.semantic[0].output.operations;
  for (const operation of operations) {
    const payload = JSON.parse(operation.payloadJson); payload.sourceId = source.source.id; payload.id = operation.id;
    operation.payloadJson = JSON.stringify(payload);
  }
  const semanticPlan = { ...upstream.proposal, operations };
  semanticPlan.questions[0]!.criteria[0]!.route = "typed-repair";
  semanticPlan.questions[0]!.criteria[0]!.operationSlots = [1, 2, 3];
  const check = { phase: "semantic-scope-check", revisionHash: upstream.review.revisionHash, proposalHash: h(semanticPlan),
    judgments: upstream.scope.questions.map(q => ({ questionId: q.questionId, verdict: "supported", rationale: "Retain uncertainty", evidence: upstream.evidence })),
    operationJudgments: [1, 2, 3].map(slot => ({ slot, verdict: "supported", rationale: "Retain uncertainty" })), consumerVerdict: "supported", consumerRationale: "Keep blocked" };
  p.semantic = [];
  for (const output of [semanticPlan, check]) p.semantic.push({ taskId: upstream.review.taskId, revisionHash: upstream.review.revisionHash,
    phase: output.phase, output, inputHash: h(output.phase), evidence: semanticScopeSelectors(output as any).map(selector => ({ selector, anchor: upstream.prepared.prerequisites[0].evidence[0].anchor })),
    sessionId: `prior-${output.phase}`, traceRunId: `prior-${output.phase}`, provider: "openai-codex", model: "gpt-6.1-sol", subscription: true,
    predecessorRecordHash: p.semantic.length ? h(p.semantic.at(-1)) : null });
  const history = await upstream.ledger.history();
  for (const payload of [{ kind: "role-dependency-review", review: upstream.review }, ...p.semantic.map((record: unknown) => ({ kind: "role-semantic-scope", record }))]) {
    const identity = { version: 1 as const, sourceId: source.source.id, sequence: history.length, predecessorHash: history.at(-1)!.hash, payload };
    history.push({ ...identity, hash: h(identity) } as any);
  }
  await upstream.ledger.restoreJournal(history, bytes);
  p.intent.requirementPrefix = { length: history.length, head: history.at(-1)!.hash };
  p.intent.retainedConditionsHash = h({ questions: semanticPlan.questions, consumer: semanticPlan.consumer });
  if (large) {
    const boundary = Array.from({ length: 160 }, (_, i) => `原始边界${i}：不得根据文字重合认定身份，必须保留尚未查明的来源关系。`).join("");
    p.inventory.consumers = Array.from({ length: consumerCount }, (_, i) => ({ ref: `event/consumer-${i}`, revisionHash: h(i),
      payload: { id: `consumer-${i}`, retainedBoundary: boundary, uniqueEvidence: Array.from({ length: 22 }, (_, j) => `${i}-${j}:完整事件证据，身份尚未确定。`).join("") },
      reason: "typed-consumer", dependencies: [] }));
    p.intent.consumerShards = Array.from({ length: Math.ceil(consumerCount / 48) }, (_, index) => ({ index,
      refs: p.inventory.consumers.slice(index * 48, (index + 1) * 48).map((c: { ref: string }) => c.ref) }));
    p.inventory.candidateIds = Array.from({ length: 78 }, (_, i) => `role-${i}-${h(i)}`);
    p.inventory.sourcePages = Array.from({ length: 73 }, (_, i) => i);
  }
  p.intent.inventoryHash = h(p.inventory);
  p.intent.semanticRecordHashes = p.semantic.map(h);
  const outputs = identityStages(p.intent).map(({ phase, shard }, i) => {
    const out: any = structuredClone(f.records[i % 2 + (i >= 2 ? 2 : 0)]!.output);
    out.phase = phase; out.intentHash = h(p.intent); out.retainedConditionsHash = p.intent.retainedConditionsHash;
    if (i >= 2) {
      out.shard = shard; out.inventoryHash = h(p.inventory);
      const consumers = p.inventory.consumers.filter((c: { ref: string }) => p.intent.consumerShards[shard!].refs.includes(c.ref));
      out.consumers = consumers.map((c: { ref: string; revisionHash: string }, j: number) => phase === "identity-consumers"
        ? { ref: c.ref, revisionHash: c.revisionHash, disposition: "revalidate-required", rationale: `${j}：` + "待核验".repeat(66), requiredAction: "保留阻塞".repeat(25) }
        : { ref: c.ref, verdict: "supported", rationale: `${j}：独立验收保留原始边界。` });
      if (phase === "identity-consumers") {
        Object.assign(out, { candidateIds: p.inventory.candidateIds, sourcePages: p.inventory.sourcePages, originalQuestionIds: p.inventory.originalQuestionIds });
        out.bindings.forEach((b: any, i: number) => { b.payloadHash = h(JSON.parse(operations[i].payloadJson)); });
      }
    }
    return out;
  });
  for (let i = 0; i < outputs.length; i++) {
    if ("proposalHash" in outputs[i]) outputs[i].proposalHash = h(outputs[i - 1]);
    if ("definitionHash" in outputs[i]) outputs[i].definitionHash = h(outputs[0]);
  }
  vi.spyOn(service, "prepareIdentityRequirements").mockResolvedValue(p);
  // The pre-existing upstream compiler history and authentication are fixtures.
  // Session execution, source reads/anchors, budgets, traces, record verifier,
  // ledger publication and all subsequent acceptance remain real.
  const runtimeCreate = ModelRuntime.create.bind(ModelRuntime);
  vi.spyOn(ModelRuntime, "create").mockImplementation(async options => options?.authPath === getAgentDir() + "/auth.json"
    ? { checkAuth: async () => ({ type: "oauth" }), getProvider: () => ({ auth: { oauth: { isSubscription: true } } }), getModel: () => ({}) } as any
    : runtimeCreate(options));
  const create = PiAgentSession.create.bind(PiAgentSession), transports: Awaited<ReturnType<typeof mockPiProvider>>[] = [];
  vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
    const stageName = path.basename(options.runtimeDir!), ordinal = identityStages(p.intent).findIndex(s => s.stage === stageName);
    const stageDirectory = path.dirname(path.dirname(options.runtimeDir!));
    const session = await create({ ...options, model: undefined, piAgentDir: path.join(stageDirectory, "pi") });
    const plan = JSON.parse(await fs.readFile(path.join(stageDirectory, `${stageName}.context-plan.json`), "utf8"));
    const fail = ordinal === 2 && controls.failFirstConsumer;
    if (fail) controls.failFirstConsumer = false;
    transports.push(await mockPiProvider(session, { provider: "openai-codex", modelId: "gpt-6.1-sol", response: (_context, index) => {
      if (fail || (ordinal === 2 && controls.exhaustRecovery)) return fauxAssistantMessage([
        ...(fail && index === 4 ? [fauxText("完整但超出上下文的合成推理记录".repeat(20000))] : []),
        ...(index === 0 ? plan.readPlan.map((r: any, i: number) => fauxToolCall(r.name, r.arguments, { id: `old-${index}-${i}` }))
          : [fauxToolCall("read_identity_dependencies", { collection: "dependencies", offset: 0 }, { id: `repeat-${index}` })]),
      ], { stopReason: "toolUse" });
      const discover = ordinal === 2 && controls.discoverOperationHashes;
      if (discover && index === 1) return fauxAssistantMessage([
        fauxToolCall("read_identity_dependencies", { collection: "dependencies", offset: 0 }, { id: "discover-operation-hashes" }),
      ], { stopReason: "toolUse" });
      if (index > (discover ? 2 : 1)) throw new Error(`Unexpected additional provider call: ${JSON.stringify(_context.messages.slice(-3))}`);
      const output = JSON.parse(JSON.stringify(outputs[ordinal]));
      if (index > 0) {
        const envelopes = _context.messages.flatMap(m => {
          if (m.role !== "user" && m.role !== "toolResult") return [];
          return (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content)
            .flatMap(b => b.type === "text" ? [JSON.parse(b.text)] : []);
        });
        const values: any[] = envelopes[0]?.$nwhContext === LOSSLESS_CONTEXT_PROTOCOL
          ? decodeJsonValues(envelopes[0].dictionary, envelopes.map(e => e.value)) : envelopes;
        if (output.phase.startsWith("identity-definition") && values.some(v => v.operationPayloadHashes))
          throw new Error("Blind definition received frozen operation hashes");
        if (output.phase === "identity-consumers") {
          // Copy identifiers only from actual provider-visible tool results;
          // an out-of-band fixture hash would mask a broken host contract.
          const hashes = (discover ? values.slice(-1) : values.slice(1)).flatMap(v => v.operationPayloadHashes ?? []);
          for (const binding of output.bindings) {
            const matches = hashes.filter(v => v.slot === binding.slot);
            if (!matches.length || matches.some(v => v.payloadHash !== matches[0].payloadHash))
              throw new Error("Consumer cannot discover its exact operation payloadHash");
            binding.payloadHash = matches[0].payloadHash;
          }
        }
      }
      const calls = index === 0 ? plan.readPlan.map((r: any, i: number) => fauxToolCall(r.name, r.arguments, { id: `read-${ordinal}-${i}` }))
        : [fauxToolCall("submit_identity_requirements", output, { id: `submit-${ordinal}` })];
      if (controls.submitWithReads && ordinal === 0 && index === 0)
        calls.push(fauxToolCall("submit_identity_requirements", JSON.parse(JSON.stringify(outputs[ordinal])), { id: "submit-without-seeing-results" }));
      return fauxAssistantMessage([{ ...fauxThinking("synthetic provider state"), thinkingSignature: `opaque-${ordinal}-${index}` }, ...calls], { stopReason: "toolUse" });
    } }));
    return session;
  });
  return { root, p, outputs, transports, controls, parent, auditBudgetFile, priorBudgetFile, run: () => runIdentityRequirements({ root, input: {} as any,
    authorizationRef: p.intent.authorizationRef, priorUsage: p.intent.priorUsage, expectedIntentHash: h(p.intent), assertOriginal: async () => {} }) };
}

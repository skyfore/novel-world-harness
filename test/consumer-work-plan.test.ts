import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { contentHash as h } from "../src/world/canonical.js";
import { ModelRequestBudget, type ModelRequestBudgetState } from "../src/runtime/model-request-budget.js";
import { createConsumerWorkPlan, consumerWorkInput, consumerArtifactView, consumerWorkPreflight,
  consumerWorkBudgetPolicy, verifyConsumerWorkProgress, consumerWorkFailure, type ConsumerWorkBaseInput } from "../src/compiler/consumer-work-plan.js";
import type { ConsumerRevalidationScope } from "../src/compiler/identity-consumer-revalidation-model.js";

function fixture(withRoster = false, text = "Ada waits. Later, Ada leaves.") {
  const bytes = Buffer.from(text), scope = { sourceHash: createHash("sha256").update(bytes).digest("hex"),
    sourceId: "src", ref: "entry/ada/arrival", authorizationRef: "original user authorization" } as ConsumerRevalidationScope;
  const roster = { sourceId: "src", sourceSha256: scope.sourceHash, unitIds: Array.from({ length: 11000 }, (_, i) => `unit-sentence-${h(i).slice(0, 24)}`),
    extractionRunIds: ["run-1"], candidates: [{ id: "ada", name: "Ada", unresolvedIdentity: true }], reviews: [],
    unknownSemanticField: { text: "Keep all unrecognized semantic fields." } };
  const catalog = withRoster ? [{ kind: "role-roster", id: "src", revisionHash: h(roster), payload: roster, current: false,
    aliases: ["roster/src"], evidenceRole: "retained-role-roster" as const }] : [];
  const input = { scopeHash: h(scope), requiredSourceSegmentIds: ["s1"], artifactReadRefs: catalog.map(c => ({ ref: "role-roster:src", revisionHash: c.revisionHash })),
    denominator: { total: 536, refs: Array.from({ length: 536 }, (_, i) => `entry/${i}`), candidateIds: ["ada"], sourcePages: [0, 1], originalQuestionIds: [h("question")] },
    originalQuestions: [{ question: "Who is Ada?" }], originalSemanticScope: { preserve: "unresolved" } } as unknown as ConsumerWorkBaseInput;
  const segments = [{ id: "s1", startByte: 0, endByte: 10 }, { id: "s2", startByte: 10, endByte: bytes.length }];
  const args = { scope, stage: "consumer-revalidation" as const, input, catalog, bytes, segments,
    priorUsage: { modelCalls: 358, totalPayloadBytes: 86593651 } };
  return { args, roster, plan: createConsumerWorkPlan(args) };
}

it("keeps the full denominator and roster locally while delivering all semantic fields and exact source ranges", () => {
  const { plan, args, roster } = fixture(true), before = h(args), input = consumerWorkInput(plan);
  expect(plan.scenario).toBe("shared-dependencies");
  expect(input.artifactReadRefs[0]).toMatchObject({ ref: "role-roster:src", delivery: "initial-evidence-packet" });
  expect(input.artifactReadRefs[0]).not.toHaveProperty("readMode");
  expect(input.evidencePacket.sources).toEqual([{ id: "s1", startByte: 0, endByte: 10, text: "Ada waits.", textHash: h("Ada waits.") }]);
  const view = input.evidencePacket.artifacts[0]!;
  expect(view.payload).toMatchObject({ candidates: roster.candidates, unknownSemanticField: roster.unknownSemanticField, reviews: [] });
  expect(view.inventories?.unitIds).toEqual({ policy: "ordered-inventory/v1", count: 11000, hash: h(roster.unitIds) });
  expect(plan.artifacts[0]!.payload).toEqual(roster);
  expect(input.denominator.refs).toMatchObject({ count: 536, hash: h(plan.baseInput.denominator.refs) });
  expect(input.execution.priorUsage).toEqual(args.priorUsage); expect(h(args)).toBe(before);
  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(10_000);
  const changed = structuredClone(plan.artifacts[0]!); (changed.payload as typeof roster).unitIds.reverse();
  expect(() => consumerArtifactView(changed)).toThrow(/payload changed/);
  expect(consumerArtifactView({ ...changed, revisionHash: h(changed.payload) }).inventories?.unitIds.hash).not.toBe(view.inventories?.unitIds.hash);
});

it("delivers decisive proposal evidence and exact repair dependencies to the independent checker", () => {
  const { args } = fixture();
  const payload = { id: "ada", status: "unresolved" }, artifact = { kind: "entity", id: "ada", payload, revisionHash: h(payload), current: true };
  const input = { ...args.input, proposal: { phase: "consumer-revalidation", evidence: [{ segment_id: "s2", exact: "Later" }],
    initialWorldRepair: { segmentIds: ["s2"], readableRefs: [{ kind: "entity", id: "ada", revisionHash: h(payload) }] } } } as ConsumerWorkBaseInput;
  const plan = createConsumerWorkPlan({ ...args, stage: "consumer-revalidation-check", input, catalog: [artifact] });
  expect(plan.scenario).toBe("cross-segment"); expect(plan.sources.map(s => s.id)).toEqual(["s1", "s2"]);
  expect(plan.artifacts).toEqual([artifact]);
  expect(() => createConsumerWorkPlan({ ...args, input, catalog: [] })).toThrow(/Missing planned dependency/);
  expect(() => createConsumerWorkPlan({ ...args, bytes: Buffer.from("changed") })).toThrow(/source or scope changed/);
  expect(() => createConsumerWorkPlan({ ...args, extraSources: ["missing"] })).toThrow(/Invalid complete source range/);
});

it("rejects an oversized complete work packet before dispatch instead of hiding evidence behind pagination", () => {
  const { args } = fixture(false, "字".repeat(180000));
  args.segments = [{ id: "s1", startByte: 0, endByte: args.bytes.length }];
  const plan = createConsumerWorkPlan(args), preflight = consumerWorkPreflight(plan, "system prompt", []);
  expect(preflight).toMatchObject({ status: "context-blocked", modelDispatchAllowed: false, independentCheckRequired: true });
  expect(consumerWorkInput(plan).evidencePacket.sources[0]!.text).toBe("字".repeat(180000));
  expect(preflight.requiredBytes).toBeGreaterThan(preflight.maxRequestBytes);
});

it("persists one validated draft milestone while repeats and raw reads still exhaust the progress window", () => {
  const { plan } = fixture(); let state: ModelRequestBudgetState | undefined;
  const budget = new ModelRequestBudget(plan.limits, { save: value => { state = value; } }, consumerWorkBudgetPolicy);
  const messages: Array<{ role: string; toolName?: string; isError?: boolean; content?: unknown }> = [];
  for (let i = 0; i < 12; i++) { budget.beginCall({}); messages.push({ role: "assistant" }); }
  expect(budget.recordValidatedProgress(`draft:${plan.workKey}`)).toBe(true);
  messages.push({ role: "toolResult", toolName: "preview_consumer_revalidation", isError: false, content: [{ type: "text", text: '{"valid":true}' }] });
  for (let i = 0; i < 12; i++) {
    budget.beginCall({}); messages.push({ role: "assistant" });
    expect(budget.recordValidatedProgress(`draft:${plan.workKey}`)).toBe(false);
  }
  expect(() => verifyConsumerWorkProgress(plan, state!, messages)).not.toThrow();
  const tampered = structuredClone(state!); tampered.progress!.lastProgressCall++;
  expect(() => verifyConsumerWorkProgress(plan, tampered, messages)).toThrow(/progress differs/);
  expect(() => budget.beginCall({})).toThrow(/no new validated progress/);
  expect(state!.usage.modelCalls).toBe(24);
  const resumed = new ModelRequestBudget(plan.limits, { initial: state!, save() {} }, consumerWorkBudgetPolicy);
  expect(() => resumed.beginCall({})).toThrow(/retained hard stop/);
});

it("separates external refusal, context limits and no-progress without inventing a semantic verdict or retry grant", () => {
  expect(consumerWorkFailure("Codex error: The usage limit has been reached")).toMatchObject({ kind: "external-wait", retryable: false, preservedUsage: true, semanticVerdict: "not-established" });
  expect(consumerWorkFailure("request too large", "request-size").kind).toBe("context-blocked");
  expect(consumerWorkFailure("no progress", "no-progress").kind).toBe("no-progress");
});

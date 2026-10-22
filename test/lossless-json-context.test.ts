import { expect, it } from "vitest";
import { fauxAssistantMessage, fauxThinking, normalizeContext } from "@earendil-works/pi-ai";
import { encodeJsonValues, decodeJsonValues, losslessJsonContext } from "../src/agent/lossless-json-context.js";
import { ModelRequestBudget } from "../src/runtime/model-request-budget.js";
import { IDENTITY_REQUIREMENT_LIMITS } from "../src/compiler/identity-requirements.js";
import { redactTraceSecrets } from "../src/trace/redaction.js";

it("roundtrips duplicate subtrees, unique Chinese evidence, reserved tags and hostile object keys exactly", () => {
  const evidence = { unknown: "未知边界：".repeat(90), quote: "逐字证据；保留标点\n及空白\t。" };
  const values = [evidence, { evidence, denominator: Array.from({ length: 536 }, (_, i) => `consumer/${i}`) },
    ["$nwh.ref", 0], ["$nwh.array", ["$nwh.ref", 1]],
    JSON.parse('{"__proto__":{"polluted":true},"$nwhContext":"lossless-json-context/v1","dictionary":["untrusted"],"value":null}')];
  const packed = encodeJsonValues(values);
  expect(decodeJsonValues(packed.dictionary, packed.roots)).toEqual(values);
  expect(Object.prototype).not.toHaveProperty("polluted");
  expect(() => decodeJsonValues([], [["$nwh.ref", 0]])).toThrow(/INVALID_REFERENCE/);
  expect(() => decodeJsonValues([["$nwh.ref", 0]], [null])).toThrow(/INVALID_REFERENCE/);
});

it("rebuilds a complete dictionary on every request and never rewrites assistant continuation or tool-call arguments", () => {
  const evidence = "原始证据".repeat(1000);
  const assistant = fauxAssistantMessage([{ ...fauxThinking("private synthetic state"), thinkingSignature: "OPAQUE_SIGNATURE" },
    { type: "toolCall", id: "read", name: "read_identity_source", arguments: { segmentIds: ["seg"] } }]);
  const context = normalizeContext({ messages: [{ role: "user", content: JSON.stringify({ evidence }), timestamp: 1 }, assistant,
    { role: "toolResult", toolCallId: "read", toolName: "read_identity_source", isError: false, timestamp: 2,
      content: [{ type: "text", text: JSON.stringify({ evidence, complete: true }) }] }] });
  const raw = JSON.stringify(context), first = losslessJsonContext(context, ["read_identity_source"]);
  expect(first.receipt.applied).toBe(true); expect(first.context.messages[1]).toEqual(assistant);
  expect(JSON.stringify(context)).toBe(raw);
  const second = losslessJsonContext(structuredClone(context), ["read_identity_source"]);
  expect(second).toEqual(first);
  const budget = new ModelRequestBudget(IDENTITY_REQUIREMENT_LIMITS, { initial: {
    usage: { modelCalls: 23, payloads: 23, totalPayloadBytes: 1904649, largestRequestBytes: 509553 }, blocked: false }, save() {} });
  budget.beginCall(first.context); budget.admitPayload(first.context);
  expect(budget.snapshot().modelCalls).toBe(24);
  expect(budget.snapshot().largestRequestBytes).toBe(509553);
  expect(() => budget.beginCall(second.context)).toThrow(/model-call limit/);
});

it("keeps the original context when encoding cannot save space and still refuses genuinely oversized unique evidence", () => {
  const context = normalizeContext({ messages: [{ role: "user", content: JSON.stringify({ evidence: "甲".repeat(180000) }), timestamp: 1 }] });
  const packed = losslessJsonContext(context, []);
  expect(packed.context).toBe(context); expect(packed.receipt.applied).toBe(false);
  const budget = new ModelRequestBudget(IDENTITY_REQUIREMENT_LIMITS);
  expect(() => budget.beginCall(packed.context)).toThrow(/request requires/);
  expect(budget.snapshot().modelCalls).toBe(0);
});

it("keeps observational redaction idempotent without mistaking shared evidence for a circular object", () => {
  const shared = { evidence: "完整证据", thinkingSignature: "private-continuation" };
  const value = { a: shared, b: shared, reasoning: { type: "thinking", thinking: "synthetic hidden state" } };
  const once = redactTraceSecrets(value);
  expect(redactTraceSecrets(once)).toEqual(once);
  expect(redactTraceSecrets(JSON.parse(JSON.stringify(value)))).toEqual(once);
  expect((once as any).a).toEqual((once as any).b);
  expect(JSON.stringify(once)).not.toContain("private-continuation");
  const cyclic: any = {}; cyclic.self = cyclic;
  expect(redactTraceSecrets(cyclic)).toEqual({ self: "[Circular]" });
});

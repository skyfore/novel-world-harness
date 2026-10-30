import { expect, it } from "vitest";
import { fauxAssistantMessage, fauxThinking, fauxToolCall, normalizeContext } from "@earendil-works/pi-ai";
import { encodeJsonValues, decodeJsonValues, jsonDictionaryProfile, losslessJsonContext } from "../src/agent/lossless-json-context.js";
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

it("records compact ID sharing explicitly while reconstructing historical requests with their original profile", () => {
  const ids = Array.from({ length: 300 }, (_, i) => `original-source-identity-${String(i).padStart(20, "0")}`);
  const value = { denominator: ids, dependencies: ids.map((ref, i) => ({ ref, index: i })), retained: [...ids].reverse() };
  const context = normalizeContext({ messages: [{ role: "user", content: JSON.stringify(value), timestamp: 1 }] });
  const legacy = losslessJsonContext(context, []), compact = losslessJsonContext(context, [], "compact/v1");
  expect(jsonDictionaryProfile(legacy.context)).toBeUndefined();
  expect(jsonDictionaryProfile(compact.context)).toBe("compact/v1");
  expect(compact.receipt.encodedBytes).toBeLessThan(legacy.receipt.encodedBytes);
  for (const wire of [legacy, compact]) {
    expect(losslessJsonContext(context, [], jsonDictionaryProfile(wire.context))).toEqual(wire);
    const user = wire.context.messages.find(m => m.role === "user")!;
    const text = typeof user.content === "string" ? user.content : user.content.find(c => c.type === "text")!.text;
    const envelope = JSON.parse(text);
    expect(envelope.$nwhContext ? decodeJsonValues(envelope.dictionary, [envelope.value], envelope.dictionaryProfile) : [envelope]).toEqual([value]);
  }
  const repeatedArrays = normalizeContext({ messages: [{ role: "user", content: JSON.stringify({ a: ids, b: ids }), timestamp: 1 }] });
  const selected = losslessJsonContext(repeatedArrays, [], "compact/v1");
  expect(selected).toEqual(losslessJsonContext(repeatedArrays, [], jsonDictionaryProfile(selected.context)));
  expect(selected.receipt.encodedBytes).toBeLessThanOrEqual(losslessJsonContext(repeatedArrays, []).receipt.encodedBytes);
  const hostile = [["$nwh.front-coded", [[0, "literal"]]], ["$nwh.array", ["$nwh.front-coded", []]]];
  for (const profile of [undefined, "compact/v1"] as const) {
    const encoded = encodeJsonValues(hostile, profile ? 24 : 80, profile);
    expect(decodeJsonValues(encoded.dictionary, encoded.roots, profile)).toEqual(hostile);
  }
  expect(() => decodeJsonValues([], [["$nwh.front-coded", [[1, "missing prefix"]]]], "compact/v1")).toThrow(/INVALID_FRONT_CODE/);
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

it("keeps old JSON envelopes stable as new evidence arrives and reconstructs each message independently", () => {
  const evidence = { text: "完整原文".repeat(600), ids: Array.from({ length: 80 }, (_, i) => `source-unit-${i}`) };
  const initial = normalizeContext({ messages: [{ role: "user", content: JSON.stringify({ a: evidence, b: evidence }), timestamp: 1 }] });
  const first = losslessJsonContext(initial, ["read"], "message/v1");
  const extended = normalizeContext({ messages: [...initial.messages, fauxAssistantMessage([fauxToolCall("read", { ref: "second" }, { id: "read-2" })], { stopReason: "toolUse" }),
    { role: "toolResult", toolCallId: "read-2", toolName: "read", isError: false, timestamp: 2,
      content: [{ type: "text", text: JSON.stringify({ a: evidence, c: evidence, different: "new evidence" }) }] }] });
  const next = losslessJsonContext(extended, ["read"], "message/v1");
  expect(next.context.messages[0]).toEqual(first.context.messages[0]);
  expect(jsonDictionaryProfile(next.context)).toBe("message/v1");
  expect(losslessJsonContext(extended, ["read"], jsonDictionaryProfile(next.context))).toEqual(next);
  for (const index of [0, 2]) {
    const original = extended.messages[index]!, packed = next.context.messages[index]!;
    const text = typeof packed.content === "string" ? packed.content : packed.content.find(c => c.type === "text")!.text;
    const originalText = typeof original.content === "string" ? original.content : original.content.find(c => c.type === "text")!.text;
    const wire = JSON.parse(text);
    expect(decodeJsonValues(wire.dictionary, [wire.value], "message/v1")[0]).toEqual(JSON.parse(originalText));
  }
  expect(next.context.messages[1]).toEqual(extended.messages[1]);
  const tiny = normalizeContext({ messages: [{ role: "user", content: "{}", timestamp: 1 }] });
  const marked = losslessJsonContext(tiny, [], "message/v1");
  expect(jsonDictionaryProfile(marked.context)).toBe("message/v1");
  expect(losslessJsonContext(tiny, [], jsonDictionaryProfile(marked.context))).toEqual(marked);
});

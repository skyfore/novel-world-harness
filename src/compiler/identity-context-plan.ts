import { normalizeContext, type Tool, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { losslessJsonContext } from "../agent/lossless-json-context.js";
import { contentHash } from "../world/canonical.js";
import { identitySelectors, IDENTITY_REQUIREMENT_LIMITS, type IdentityRecord } from "./identity-requirements.js";
import type { PreparedIdentityRequirements } from "./identity-requirement-service.js";
import { identityStageCatalog, identityConsumerView, type identityStageInput } from "../workflow/identity-requirements.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import type { ModelRequestUsage } from "../runtime/model-request-budget.js";

export const identityReadTools = ["read_identity_source", "read_identity_dependencies"] as const;

/** Plan the complete mandatory evidence, including the independent check's
 * actual proposal, BEFORE the first paid call. The frozen shard is not split or
 * reduced. An intrinsically oversized set is an explicit host stop, not a
 * consumed trial invocation or a reason to omit evidence. Runtime budgets still
 * admit every actual context/payload, including optional reads and reasoning. */
export function identityContextPlan(p: PreparedIdentityRequirements, input: ReturnType<typeof identityStageInput>,
  previous: IdentityRecord[], system: string, tools: Tool[], inherited: ModelRequestUsage) {
  const reads: { name: string; arguments: ToolCall["arguments"]; value: unknown }[] = [];
  const batches = <T>(values: T[], maximum: number, bytes: (values: T[]) => number, emit: (values: T[]) => void) => {
    let batch: T[] = [];
    for (const value of values) {
      if (batch.length && (batch.length === maximum || bytes([...batch, value]) > 240000)) { emit(batch); batch = []; }
      batch.push(value);
      if (bytes(batch) > 240000) throw prerequisiteStop("A complete identity evidence item exceeds the read contract; preserve its bytes and denominator, no provider dispatch or retry");
    }
    if (batch.length) emit(batch);
  };
  const sourceIds = [...new Set([...input.requiredSourceSegmentIds,
    ...(input.phase.endsWith("-check") ? identitySelectors(previous.at(-1)!.output).map(e => e.segment_id) : [])])];
  const source = sourceIds.map(id => {
    const s = p.manifest.segments.find(s => s.id === id);
    if (!s) throw prerequisiteStop("Mandatory identity evidence segment is missing; inspect original manifest, no guessed ID or dispatch");
    return { id, text: Buffer.from(p.bytes).subarray(s.startByte, s.endByte).toString("utf8"), complete: true };
  });
  batches(source, 8, values => values.reduce((sum, s) => sum + Buffer.byteLength(s.text), 0), segments => reads.push({
    name: "read_identity_source", arguments: { segmentIds: segments.map(s => s.id), offset: 0 }, value: { segments } }));
  const dependencies = identityStageCatalog(p, input.phase);
  const groups = [{ collection: "dependencies", refs: input.requiredDependencyRefs, values: dependencies },
    ...(!input.phase.startsWith("identity-definition") ? [{ collection: "consumers", refs: p.intent.consumerShards[input.shard!]!.refs,
      // Preserve the existing reader contract. Its mechanical roster provenance
      // inventories are frozen by hash; every semantic/evidence field is intact.
      values: p.inventory.consumers.map(c => ({ ...c, payload: identityConsumerView(c.ref, c.payload) })) }] : [])];
  for (const { collection, refs, values } of groups) {
    const selected = refs.map(ref => {
      const value = values.find(c => c.ref === ref);
      if (!value) throw prerequisiteStop("Mandatory identity dependency is missing from its frozen catalog; no guessed ref or dispatch");
      return value;
    });
    batches(selected, 32, items => Buffer.byteLength(JSON.stringify(items)), items => reads.push({ name: "read_identity_dependencies",
      arguments: { collection, refs: items.map(c => c.ref), offset: 0 }, value: { items } }));
  }
  const base = normalizeContext({ messages: [{ role: "system", content: system, toolsAdded: tools, timestamp: 0 },
    { role: "user", content: JSON.stringify(input), timestamp: 0 }] });
  const assistant: AssistantMessage = { role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6.1-sol",
    content: reads.map((r, i) => ({ type: "toolCall", name: r.name, arguments: r.arguments, id: `mandatory-${i}` })),
    stopReason: "toolUse", timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const complete = normalizeContext({ messages: [...base.messages, assistant, ...reads.map((r, i) => ({ role: "toolResult" as const,
    toolCallId: `mandatory-${i}`, toolName: r.name, isError: false, timestamp: 0,
    content: [{ type: "text" as const, text: JSON.stringify(r.value) }] }))] });
  const initial = losslessJsonContext(base, identityReadTools), all = losslessJsonContext(complete, identityReadTools);
  // This is a necessary lower bound, not a promise about arbitrary model output.
  // Both sizes are durably reported so an unexpected actual stop is explainable.
  const allowed = all.receipt.encodedBytes <= IDENTITY_REQUIREMENT_LIMITS.maxRequestBytes
    && inherited.modelCalls + 2 <= IDENTITY_REQUIREMENT_LIMITS.maxModelCalls
    && inherited.totalPayloadBytes + initial.receipt.encodedBytes + all.receipt.encodedBytes <= IDENTITY_REQUIREMENT_LIMITS.maxTotalPayloadBytes;
  return { version: 1, inputHash: contentHash(input), readPlan: reads.map(({ value, ...r }) => ({ ...r, valueHash: contentHash(value) })),
    requiredEvidenceHash: contentHash(reads), inherited, limits: IDENTITY_REQUIREMENT_LIMITS,
    initial: initial.receipt, complete: all.receipt, allowed };
}

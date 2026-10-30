import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { entitySchema } from "../world/model.js";
import { TraceStore } from "../trace/store.js";
import { consumerRepairDirectory, type ConsumerRepairRecord } from "./identity-consumer-repair-model.js";
import { prepareConsumerRepair } from "./identity-consumer-repair.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { resolveTextSelectorAnchor } from "./text-anchors.js";
import { verifyIdentitySessionEvidence } from "./identity-session-integrity.js";
import { IDENTITY_REQUIREMENT_LIMITS } from "./identity-requirements.js";
import { upstreamRepairRevisionFields } from "./upstream-repair-plan.js";

export function validateConsumerRepairRevision(record: ConsumerRepairRecord, baseline: unknown) {
  if (record.output.phase !== "consumer-repair-plan" || record.output.operation.mode !== "revision") return;
  const op = record.output.operation, before = entitySchema.parse(baseline), after = entitySchema.parse(JSON.parse(op.payloadJson));
  if (contentHash(before) !== record.intent.revisionHash || before.id !== after.id || before.kind !== after.kind
    || contentHash(before.agencyProfile ?? null) !== contentHash(after.agencyProfile ?? null))
    throw prerequisiteStop("Entity repair changed stable identity, kind or operational capabilities; no write or retry");
  const changed = upstreamRepairRevisionFields("entity").filter(field => contentHash((before as any)[field] ?? null) !== contentHash((after as any)[field] ?? null)).map(f => `/${f}`).sort();
  if (!changed.length || contentHash(changed) !== contentHash([...op.pointers].sort()))
    throw prerequisiteStop("Entity repair pointers do not match the actual complete diff; preserve the proposal, no inferred scope or retry");
}

/** Read-only planning proof: exact source/baseline, single fresh Pi session,
 * original independent conditions, complete transcript and actual budget. This
 * deliberately provides no upstream write authority or repair acceptance. */
export async function verifyConsumerRepairRecord(root: string, record: ConsumerRepairRecord, frozen?: Awaited<ReturnType<typeof prepareConsumerRepair>>) {
  const { intent } = record, directory = consumerRepairDirectory(root, intent), stage = record.output.phase;
  const p = frozen ?? await prepareConsumerRepair(root, intent.sourceId, intent.taskId, intent.ref, intent.authorizationRef);
  if (contentHash(p.intent) !== contentHash(intent)) throw prerequisiteStop("Consumer repair changed its retained original state; no retry");
  const read = async (name: string) => JSON.parse(await fs.readFile(path.join(directory, `${stage}.${name}.json`), "utf8"));
  const [input, invocation, session, checkpoint, budget, proposal, admission] = await Promise.all([read("input"), read("invocation"), read("session"), read("session-checkpoint"), read("budget"), read("proposal"), read("admission")]);
  const { consumerRepairInput } = await import("../workflow/identity-consumer-repair.js");
  const expected = consumerRepairInput(p, p.prior, stage === "consumer-repair-check");
  // This is a historical read-only capability observation. Its exact value is
  // already bound by inputHash and every original provider request. A later
  // implementation must not rewrite the observed gap or invalidate its proof.
  // Actual write authority always uses a separate current typed repair plan.
  expected.capability = input.capability;
  if (contentHash(input) !== contentHash(expected) || record.inputHash !== contentHash(input)
    || invocation.inputHash !== record.inputHash || invocation.intentHash !== contentHash(intent) || invocation.promptHash !== contentHash(JSON.stringify(input))
    || contentHash(proposal) !== contentHash(record.output) || contentHash(checkpoint) !== record.sessionCheckpointHash
    || checkpoint.status !== "complete" || checkpoint.sessionId !== record.sessionId || checkpoint.inputHash !== record.inputHash
    || session.sessionId !== record.sessionId || session.inputHash !== record.inputHash || session.model !== `${record.provider}/${record.model}`
    || session.sessionFile !== checkpoint.sessionFile || checkpoint.sessionFile !== await fs.realpath(checkpoint.sessionFile)
    || !checkpoint.sessionFile.startsWith(path.join(directory, "sessions", stage) + path.sep)
    || contentHash(budget.limits) !== contentHash(IDENTITY_REQUIREMENT_LIMITS) || budget.intentHash !== contentHash(intent)
    || budget.originalBudgetHash !== intent.originalBudgetHash || contentHash(budget.priorUsage) !== contentHash(intent.priorUsage)
    || budget.state.blocked || budget.state.failure || contentHash(budget.state.usage) !== contentHash(checkpoint.usage)
    || admission.inputHash !== record.inputHash || !admission.allowed)
    throw prerequisiteStop("Consumer repair lost its single-use input, complete checkpoint or original budget; no registration or retry");
  const [transcript, requests, messages] = await Promise.all([fs.readFile(checkpoint.sessionFile, "utf8"), fs.readFile(path.join(directory, `${stage}.requests.jsonl`), "utf8"), fs.readFile(path.join(directory, `${stage}.messages.jsonl`), "utf8")]);
  if (contentHash(transcript) !== checkpoint.transcriptHash || contentHash(requests) !== checkpoint.requestsHash || contentHash(messages) !== checkpoint.messagesHash)
    throw prerequisiteStop("Consumer repair evidence changed after sealing; retain it, no registration or retry");
  const proof = verifyIdentitySessionEvidence(transcript, root, record, JSON.stringify(input), requests, messages);
  const sizes = proof.payloads.map(p => Buffer.byteLength(JSON.stringify(p))), usage = checkpoint.usage;
  if (contentHash(proof.transcript) !== contentHash(checkpoint.transcript) || proof.transcript.responses !== usage.modelCalls
    || sizes.length !== usage.payloads || sizes.reduce((a, b) => a + b, 0) !== usage.totalPayloadBytes
    || Math.max(...sizes, ...proof.contexts.map(c => Buffer.byteLength(JSON.stringify(c)))) !== usage.largestRequestBytes
    || usage.modelCalls > IDENTITY_REQUIREMENT_LIMITS.maxModelCalls || usage.largestRequestBytes > IDENTITY_REQUIREMENT_LIMITS.maxRequestBytes
    || usage.totalPayloadBytes > IDENTITY_REQUIREMENT_LIMITS.maxTotalPayloadBytes)
    throw prerequisiteStop("Consumer repair actual provider requests disagree with the budget; retain every charge, no retry");
  const run = await new TraceStore(root).getRun(record.traceRunId);
  if (run.status !== "succeeded" || run.sourceId !== intent.sourceId || run.operationId !== `identity-consumer-repair-${intent.findingId}-${stage}`)
    throw prerequisiteStop("Consumer repair has no exact successful system trace");
  const observed = messages.trimEnd().split("\n").map(line => JSON.parse(line).message);
  const delivered = new Set<string>(), refs = new Set<string>();
  const outstanding = new Map<string, any>();
  for (const m of observed) {
    if (m.role === "assistant") for (const call of m.content.filter((b: any) => b.type === "toolCall")) {
      if (!["read_identity_source", "read_identity_dependencies", "submit_identity_requirements"].includes(call.name)) throw prerequisiteStop("Consumer repair used a foreign or write tool");
      if (call.name === "submit_identity_requirements" && (input.requiredSourceSegmentIds.some((id: string) => !delivered.has(id))
        || input.requiredDependencyRefs.some((ref: string) => !refs.has(ref)))) throw prerequisiteStop("Consumer repair submitted before complete mandatory reads");
      outstanding.set(call.id, call);
    }
    if (m.role === "toolResult") {
      const call = outstanding.get(m.toolCallId); outstanding.delete(m.toolCallId);
      if (m.isError) continue;
      const value = JSON.parse(m.content.find((b: any) => b.type === "text").text);
      if (call.name === "read_identity_source" && call.arguments.segmentIds) for (const id of call.arguments.segmentIds) {
        const s = p.prepared.manifest.segments.find(s => s.id === id), actual = value.segments?.find((s: any) => s.id === id);
        if (!s || actual?.complete !== true || actual.text !== Buffer.from(p.prepared.bytes).subarray(s.startByte, s.endByte).toString("utf8")) throw prerequisiteStop("Consumer repair source read was incomplete or changed");
        delivered.add(id);
      }
      if (call.name === "read_identity_dependencies" && call.arguments.refs) for (const ref of call.arguments.refs) {
        const c = p.prepared.inventory.consumers.find(c => c.ref === ref), actual = value.items?.find((c: any) => c.ref === ref);
        const dependencies = p.prepared.graph.nodes.find(n => `${n.kind}/${n.id}` === ref)?.dependsOn ?? [];
        if (!c || contentHash(actual) !== contentHash({ ...c, dependencies })) throw prerequisiteStop("Consumer repair dependency read lost its exact payload or pointers");
        refs.add(ref);
      }
    }
  }
  const anchors = await Promise.all(record.output.evidence.map(async selector => {
    const segment = p.prepared.manifest.segments.find(s => s.id === selector.segment_id);
    if (!segment || !delivered.has(segment.id)) throw prerequisiteStop("Consumer repair cites unread source evidence");
    return { selector, anchor: await resolveTextSelectorAnchor(root, segment, selector) };
  }));
  if (contentHash(anchors) !== contentHash(record.evidence)) throw prerequisiteStop("Consumer repair evidence anchors changed");
  validateConsumerRepairRevision(record, p.handoff.selected.payload);
  return { verified: true as const, executionAuthority: false as const };
}

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { consumerRevalidationDirectory, type ConsumerRevalidationRecord, type ConsumerRevalidationScope } from "./identity-consumer-revalidation-model.js";
import { bindingRecoveryDirectory } from "./consumer-review-binding.js";
import { CONSUMER_WORK_POLICY, consumerWorkDirectory, consumerWorkInput, consumerWorkProviderDirectory, type ConsumerWorkPlan } from "./consumer-work-plan.js";
import { consumerEvidenceReads, type ConsumerEvidenceMessage } from "./consumer-evidence-coverage.js";
import { parseSegmentManifest } from "./segments.js";
import { identityRequirementDirectory } from "./identity-requirements.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { resolveTextSelectorAnchor, type ModelTextSelector } from "./text-anchors.js";

/** A record selects its actual execution segment, independently of the latest
 * host state. Never fall back to an earlier segment when a proof is missing. */
export function consumerWorkRecordDirectory(root: string, record: ConsumerRevalidationRecord) {
  if (!record.executionPlanHash || record.bindingRecoveryHash && record.providerResumptionHash)
    throw prerequisiteStop("Consumer record has no unique work execution. Inspect the same source/task/ref retained record and recovery proof; no guessed directory, fallback or retry");
  const base = consumerWorkDirectory(consumerRevalidationDirectory(root, record.scope));
  return record.providerResumptionHash ? consumerWorkProviderDirectory(base, record.output.phase)
    : record.bindingRecoveryHash ? bindingRecoveryDirectory(base) : base;
}

export async function readConsumerWorkRecordPlan(root: string, record: ConsumerRevalidationRecord) {
  const directory = consumerWorkRecordDirectory(root, record);
  const plan = JSON.parse(await fs.readFile(path.join(directory, `${record.output.phase}.plan.json`), "utf8")) as ConsumerWorkPlan;
  if (contentHash(plan) !== record.executionPlanHash || plan.scopeHash !== contentHash(record.scope)
    || plan.stage !== record.output.phase || plan.policy !== CONSUMER_WORK_POLICY
    || plan.bindingRecoveryHash !== record.bindingRecoveryHash || plan.providerResumptionHash !== record.providerResumptionHash)
    throw prerequisiteStop("Recorded consumer work lost its exact sealed plan. Inspect the same source/task/ref execution proof; preserve history, no registration, fallback or retry");
  return { directory, plan };
}

export async function readConsumerWorkMessages(directory: string, stage: string, expectedHash?: string) {
  const raw = await fs.readFile(path.join(directory, `${stage}.messages.jsonl`), "utf8");
  if (!raw.endsWith("\n") || expectedHash && contentHash(raw) !== expectedHash)
    throw prerequisiteStop("Consumer work messages changed or are incomplete. Inspect the same source/task/ref original session and journals; no registration, redispatch or retry");
  const messages = raw.trimEnd().split("\n").map(line => JSON.parse(line).message) as ConsumerEvidenceMessage[];
  return { raw, messages };
}

/** This bound snapshot is also used by discovery. Dispatch/registration still
 * require the full session, trace and budget verifiers; it grants no authority. */
export async function readConsumerWorkRecordEvidence(root: string, record: ConsumerRevalidationRecord) {
  const work = await readConsumerWorkRecordPlan(root, record);
  const [input, journal] = await Promise.all([
    fs.readFile(path.join(work.directory, `${record.output.phase}.input.json`), "utf8").then(JSON.parse),
    readConsumerWorkMessages(work.directory, record.output.phase),
  ]);
  if (contentHash(input) !== record.inputHash || contentHash(input) !== contentHash(consumerWorkInput(work.plan)))
    throw prerequisiteStop("Consumer work evidence lost its exact input. Inspect the same source/task/ref execution proof; no fallback, registration or retry");
  return { ...work, input, ...journal, reads: consumerEvidenceReads(journal.messages) };
}

type EntryRepairSource = Pick<ConsumerRevalidationScope, "sourceId" | "sourceHash" | "taskId">;
async function originalEntryRepairSource(root: string, { sourceId, sourceHash, taskId }: EntryRepairSource) {
  const source = await WorkspaceStore.openReadOnly(root).getSource(sourceId);
  const frozen = JSON.parse(await fs.readFile(path.join(identityRequirementDirectory(root, sourceId, taskId), "context.json"), "utf8"));
  const manifest = parseSegmentManifest(frozen.manifest);
  if (!source || source.contentSha256 !== sourceHash || manifest.sourceId !== sourceId || manifest.sourceSha256 !== sourceHash)
    throw prerequisiteStop("Reviewed entry evidence lost its original source or segment manifest. Preserve both receipts and stop for host storage repair without retrying");
  return { manifest, bytes: await readSourceMaterial(root, source) };
}

/** Freeze the actual proposal and check deliveries, including completed reads
 * outside their initial packets. Preserve the original proposal input hash. */
export async function entryRepairParentContext(root: string, parents: ConsumerRevalidationRecord[]) {
  const [proposal, check] = parents;
  if (parents.length !== 2 || proposal?.output.phase !== "consumer-revalidation" || check?.output.phase !== "consumer-revalidation-check"
    || contentHash(proposal.scope) !== contentHash(check.scope) || check.predecessorRecordHash !== contentHash(proposal))
    throw prerequisiteStop("Entry repair needs both sealed reviews of the same consumer. Inspect the original source/task/ref and its receipts. Stop without retrying an incomplete or changed pair");
  const [first, second] = await Promise.all([readConsumerWorkRecordEvidence(root, proposal), readConsumerWorkRecordEvidence(root, check)]);
  const supplied = new Set(first.plan.sources.map(s => s.id));
  const additionalIds = new Set([...first.reads.sourceIds, ...second.plan.sources.map(s => s.id), ...second.reads.sourceIds]);
  const additionalSources: ConsumerWorkPlan["sources"] = [];
  for (const id of supplied) additionalIds.delete(id);
  if (additionalIds.size) {
    const { manifest, bytes } = await originalEntryRepairSource(root, proposal.scope);
    for (const segment of manifest.segments) {
      if (!additionalIds.delete(segment.id)) continue;
      const { id, startByte, endByte } = segment, slice = bytes.subarray(startByte, endByte);
      if (endByte > bytes.length || createHash("sha256").update(slice).digest("hex") !== segment.textSha256)
        throw prerequisiteStop("Reviewed segment bytes differ from the frozen manifest. Preserve the original receipts and stop for host storage repair without retrying");
      const text = slice.toString("utf8");
      additionalSources.push({ id, startByte, endByte, text, textHash: contentHash(text) });
    }
    if (additionalIds.size) throw prerequisiteStop("A sealed entry review references a segment missing from its original manifest. Preserve the receipts and stop for host repair without retrying");
  }
  return { originalInput: first.input, additionalSources, negativeJudgments: parents.map(r => r.output) };
}

type DeliveredSource = { id: string; text: string; startByte?: number; endByte?: number; textHash?: string };
export async function resolveEntryRepairEvidence(root: string, scope: EntryRepairSource,
  context: { originalInput: { evidencePacket: { sources: DeliveredSource[] } }; additionalSources?: ConsumerWorkPlan["sources"] },
  selectors: ModelTextSelector[], stop: (reason: string) => Error) {
  const { manifest, bytes } = await originalEntryRepairSource(root, scope);
  const delivered = new Map([...context.originalInput.evidencePacket.sources, ...context.additionalSources ?? []].map(s => [s.id, s]));
  return Promise.all(selectors.map(async selector => {
    const packet = delivered.get(selector.segment_id);
    if (!packet) throw stop("Selector escaped the supplied original evidence. Copy context.originalInput.evidencePacket.sources[].id or context.additionalSources[].id once");
    const segment = manifest.segments.find(s => s.id === packet.id);
    // Historical packets may retain only the segment ID and its complete text.
    const ranged = packet.startByte !== undefined || packet.endByte !== undefined;
    if (!segment || ranged && (segment.startByte !== packet.startByte || segment.endByte !== packet.endByte)
      || bytes.subarray(segment.startByte, segment.endByte).toString("utf8") !== packet.text
      || packet.textHash !== undefined && contentHash(packet.text) !== packet.textHash)
      throw stop("The delivered text no longer matches its original source range. Stop for host storage repair without retrying");
    return { selector, anchor: await resolveTextSelectorAnchor(root, segment, selector) };
  }));
}

import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { consumerRevalidationDirectory, type ConsumerRevalidationRecord } from "./identity-consumer-revalidation-model.js";
import { bindingRecoveryDirectory } from "./consumer-review-binding.js";
import { CONSUMER_WORK_POLICY, consumerWorkDirectory, consumerWorkInput, consumerWorkProviderDirectory, type ConsumerWorkPlan } from "./consumer-work-plan.js";
import { consumerEvidenceReads, type ConsumerEvidenceMessage } from "./consumer-evidence-coverage.js";

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

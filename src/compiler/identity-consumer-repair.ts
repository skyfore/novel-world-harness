import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { contentHash } from "../world/canonical.js";
import { RequirementLedger, type LedgerRecord } from "./requirement-ledger.js";
import { buildIdentityRepairHandoff } from "./identity-repair-handoff.js";
import { prepareIdentityRequirements } from "./identity-requirement-service.js";
import { identityRequirementDirectory } from "./identity-requirements.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { consumerRepairIntentSchema, inheritedConsumerRepairUsage, type ConsumerRepairIntent } from "./identity-consumer-repair-model.js";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Reconstruct existing definitions and a supported recorded finding, never ask
 * the model to define new requirements or treat a retired review as a write grant. */
export async function prepareConsumerRepair(root: string, sourceId: string, taskId: string, ref: string, authorizationRef: string) {
  const ledger = new RequirementLedger(root, sourceId), history = await ledger.history();
  const identity = await ledger.identityRequirements(taskId), old = identity[0]?.intent;
  const dependency = (await ledger.roleDependencyReviews()).find(r => r.taskId === taskId);
  if (!old || !dependency) throw prerequisiteStop("Unknown consumer repair task. Use requirements inspect-identity-repairs with the same --source, copy tasks[].taskId once; do not guess or retry unchanged");
  const prepared = await prepareIdentityRequirements(root, { scope: dependency.scope, upstreamPlanHash: dependency.upstream.planHash,
    authorizationRef: dependency.authorizationRef }, old.authorizationRef, old.priorUsage);
  const handoff = buildIdentityRepairHandoff(prepared, identity, { taskId, ref, limit: 1 });
  if (!("selected" in handoff) || !handoff.selected || !ref.startsWith("entity/")) throw prerequisiteStop("This repair entry requires a discovered entity ref; copy items[].ref into --ref once in the same source/task");
  const finding = handoff.selected.recordedAssessment;
  if (!finding || finding.disposition !== "additional-repair-required" || finding.independentReview?.verdict !== "supported" || !finding.checkRecordHash)
    throw prerequisiteStop("Consumer repair requires an original independently supported additional-repair finding; no inferred scope");
  const directory = identityRequirementDirectory(root, sourceId, taskId), retainedFiles: ConsumerRepairIntent["retainedFiles"] = [], budgets: { path: string; hash: string; value: unknown }[] = [];
  async function scan(dir: string) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (dir === directory && entry.name === "consumer-repairs") continue;
      const file = path.join(dir, entry.name), name = path.relative(directory, file);
      if (entry.isSymbolicLink() || name.endsWith(".tmp") || name.endsWith(".pending")) throw prerequisiteStop("Original identity history is unsettled; preserve it, no repair dispatch");
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(file), value = { path: name, hash: digest(bytes) }; retainedFiles.push(value);
        if (name.endsWith(".budget.json")) budgets.push({ ...value, value: JSON.parse(bytes.toString("utf8")) });
      }
    }
  }
  await scan(directory);
  const prior = history.flatMap(r => r.payload.kind === "identity-consumer-repair" && r.payload.record.intent.findingId === finding.findingId ? [r.payload.record] : []);
  const definition = identity[0]!.output;
  if (definition.phase !== "identity-definition") throw prerequisiteStop("Original independent definition missing");
  const intent = consumerRepairIntentSchema.parse({ version: 1, policy: "identity-consumer-repair/v1", sourceId, sourceHash: old.sourceHash,
    taskId, identityIntentHash: contentHash(old), findingId: finding.findingId, proposalRecordHash: finding.proposalRecordHash, checkRecordHash: finding.checkRecordHash,
    ref, revisionHash: handoff.selected.revisionHash, definitionHash: contentHash(definition), requirementIds: definition.requirements.map(r => r.id),
    inventoryHash: old.inventoryHash, graphHash: prepared.inventory.graphHash, baselineManifestHash: handoff.baselineManifestHash,
    conditionHash: contentHash(finding.requiredAction), requirementPrefix: prior[0]?.intent.requirementPrefix ?? { length: history.length, head: history.at(-1)!.hash },
    authorizationRef, originalBudgetHash: old.originalBudgetHash, priorUsage: inheritedConsumerRepairUsage(budgets, identity), retainedFiles });
  if (prior.length && contentHash(intent) !== contentHash(prior[0]!.intent)) throw prerequisiteStop("Original consumer repair intent changed; no new scope or budget");
  if (history[intent.requirementPrefix.length - 1]?.hash !== intent.requirementPrefix.head || history.slice(intent.requirementPrefix.length).some(r => r.payload.kind !== "identity-consumer-repair" || r.payload.record.intent.findingId !== intent.findingId))
    throw prerequisiteStop("Requirement ledger changed outside this repair; inspect both original states, no retry or repinning");
  return { intent, prepared, identity, handoff, prior };
}

export function consumerRepairRecords(history: LedgerRecord[], taskId: string) {
  return history.flatMap(r => r.payload.kind === "identity-consumer-repair" && r.payload.record.intent.taskId === taskId ? [r.payload.record] : []);
}

/** Between requests the compiler lock protects the current catalog. Check the
 * immutable original files and append-only scope without replaying all old Pi
 * trace verifiers on every paid request; full preparation runs at registration. */
export async function assertConsumerRepairRetainedState(root: string, intent: ConsumerRepairIntent) {
  const directory = identityRequirementDirectory(root, intent.sourceId, intent.taskId);
  for (const file of intent.retainedFiles) {
    const target = path.resolve(directory, file.path);
    if (!target.startsWith(directory + path.sep) || await fs.realpath(target) !== target
      || digest(await fs.readFile(target)) !== file.hash) throw prerequisiteStop("Retained identity evidence or failed budget changed; no further dispatch, reset or retry");
  }
  const history = await new RequirementLedger(root, intent.sourceId).history();
  if (history[intent.requirementPrefix.length - 1]?.hash !== intent.requirementPrefix.head
    || history.slice(intent.requirementPrefix.length).some(r => r.payload.kind === "identity-consumer-revalidation"
      ? r.payload.record.scope.taskId !== intent.taskId || r.payload.record.scope.identityIntentHash !== intent.identityIntentHash
      : r.payload.kind !== "identity-consumer-repair" || contentHash(r.payload.record.intent) !== contentHash(intent)))
    throw prerequisiteStop("Consumer repair requirement prefix changed outside this exact finding; stop without repinning");
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileLoopDirectory, read } from "./state.js";
import { digest } from "./workspace.js";
import { dedicatedRegistryPath, captureRecordTree, fileHash } from "./dedicated-session.js";
import { contentHash } from "../../world/canonical.js";
import type { PrerequisiteLoopSpec } from "./prerequisite-supervisor.js";

export function prerequisiteHandoffPaths(root: string, sourceId: string, taskId: string) {
  const parent = compileLoopDirectory(root, sourceId), identity = path.join(parent, "prerequisites", taskId, "identity-requirements");
  const registry = dedicatedRegistryPath(root, sourceId);
  return { parent, identity, directory: path.join(identity, "consumer-review/engineering"), registry,
    locks: [path.join(path.dirname(parent), "supervisor.lock"), path.join(path.dirname(registry), "supervisor.lock")] };
}

/** Structural host authority only. Semantic/domain eligibility is independently
 * checked by the reviewed, OS-read-only domain preflight before Pi dispatch. */
export function verifyPrerequisiteHandoff(spec: PrerequisiteLoopSpec) {
  const p = prerequisiteHandoffPaths(spec.root, spec.sourceId, spec.taskId);
  if (spec.directory !== p.directory || spec.parentStateFile !== path.join(p.parent, "state.json")
    || spec.registryFile !== p.registry || digest(spec.ownershipLocks) !== digest(p.locks)) throw new Error("PREREQUISITE_HANDOFF_PATH_CHANGED: use the original canonical task/owner paths; no alternate directory or lock set.");
  for (const [file, expected] of Object.entries(spec.retainedFiles)) {
    if (!fs.lstatSync(file).isFile() || fileHash(file) !== expected) throw new Error(`PREREQUISITE_HISTORY_CHANGED: ${file}`);
  }
  for (const file of [spec.workerRequestFile, spec.authorizationFile, spec.incidentFile, spec.parentStateFile]) {
    if (spec.retainedFiles[file] !== fileHash(file)) throw new Error("PREREQUISITE_UNPINNED_AUTHORITY: every authority/request must be frozen before dispatch.");
  }
  // Every original prerequisite file is protected, not just caller-selected examples.
  for (const [name, hash] of Object.entries(captureRecordTree(p.identity))) {
    if (!name.startsWith("consumer-review/engineering/") && spec.retainedFiles[path.join(p.identity, name)] !== hash) throw new Error("PREREQUISITE_HISTORY_OMITTED: freeze all original task files.");
  }
  const parent = read<Record<string, any>>(spec.parentStateFile), request = read<Record<string, any>>(spec.workerRequestFile);
  const intent = read<Record<string, any>>(path.join(p.identity, "intent.json"));
  const stopped = read<Record<string, any>>(path.join(p.identity, "consumer-review/state.json"));
  const start = read<Record<string, any>>(path.join(p.identity, "consumer-review/start.json"));
  const authorization = read<Record<string, any>>(spec.authorizationFile);
  const inherited = { workers: parent.workers, repairs: parent.repairs, commands: parent.commands, failures: parent.failures };
  if (digest(parent) !== spec.parentStateHash || parent.phase !== "BREAK" || parent.childPid !== null || parent.root !== spec.root
    || parent.sourceId !== spec.sourceId || digest(inherited) !== digest(spec.inherited) || parent.failures?.[parent.pending?.key] !== 2
    || intent.taskId !== spec.taskId || intent.sourceId !== spec.sourceId || intent.sourceHash !== parent.sourceHash || intent.parentStateHash !== spec.parentStateHash
    || request.root !== spec.root || request.taskId !== spec.taskId || request.sourceId !== spec.sourceId || request.identityDirectory !== p.identity
    || request.parentStateHash !== spec.parentStateHash || request.expectedIntentHash !== contentHash(intent)
    || request.originalIncidentHash !== spec.incidentHash || request.originalIncidentFile !== spec.incidentFile
    || contentHash(request.priorUsage) !== contentHash(intent.priorUsage)
    || stopped.phase !== "BREAK" || stopped.childPid !== null || stopped.stage !== "identity-consumers-0"
    || stopped.taskId !== spec.taskId || stopped.intentHash !== contentHash(intent) || stopped.traceRunId !== request.failedTraceRunId
    || digest(stopped) !== request.stoppedStateHash || start.taskId !== spec.taskId || start.intentHash !== contentHash(intent)
    || authorization.taskId !== spec.taskId || authorization.originalParentStateHash !== spec.parentStateHash
    || authorization.latestOriginThreadId !== request.authorization?.originThreadId
    || spec.authorizationRef !== authorization.latestUserCorrection || request.authorizationRef !== intent.authorizationRef
    || authorization.budgetIncreaseAuthorized !== false || authorization.newSemanticGrant !== false || authorization.originalParentMayResume !== false
    || fileHash(spec.authorizationFile) !== spec.authorizationHash || fileHash(spec.incidentFile) !== spec.incidentHash) throw new Error("PREREQUISITE_HANDOFF_AUTHORITY_CHANGED: exact parent, intent, stop, authorization and inherited counters are required.");
  const budget = read<Record<string, any>>(path.join(p.identity, "identity-consumers-0.budget.json"));
  const incident = read<Record<string, any>>(spec.incidentFile);
  if (incident.readOnly !== true || incident.sourceId !== spec.sourceId || incident.taskId !== spec.taskId
    || incident.intentHash !== contentHash(intent) || incident.parentStateHash !== spec.parentStateHash
    || incident.stateHash !== digest(stopped) || incident.continuationHash !== stopped.continuationHash
    || incident.trace?.id !== stopped.traceRunId || incident.trace.status !== "failed"
    || incident.trace.counts?.llmRequests !== budget.state.usage.modelCalls || incident.trace.requests !== budget.state.usage.modelCalls
    || !Array.isArray(incident.trace.payloadBytes) || incident.trace.payloadBytes.length !== budget.state.usage.payloads
    || incident.trace.payloadBytes.reduce((n: number, bytes: number) => n + bytes, 0) !== budget.state.usage.totalPayloadBytes
    || ["taskId", "phase", "stage", "originalBudgetHash", "limits", "state", "cumulative"].some(key => contentHash(incident.budget?.[key]) !== contentHash(budget[key]))) {
    throw new Error("PREREQUISITE_FAILED_CHARGE_CHANGED: original incident observations independently bind every consumed call and byte; repinning the request cannot reduce them.");
  }
  const limits = { maxModelCalls: 24, maxRequestBytes: 512000, maxTotalPayloadBytes: 12288000 };
  const proof = read<Record<string, any>>(path.join(p.identity, "consumer-review/intent.json"));
  if (proof.intentHash !== contentHash(intent) || start.continuationHash !== contentHash(proof) || stopped.continuationHash !== contentHash(proof)
    || !proof.authorizationRef || request.consumerAuthorizationRef !== proof.authorizationRef
    || ![".", "host-recovery"].includes(proof.stoppedDirectory)
    || digest(read(path.join(p.identity, proof.stoppedDirectory, "state.json"))) !== proof.stoppedStateHash
    || contentHash(["identity-definition", "identity-definition-check"].map(s => contentHash(read(path.join(p.identity, `${s}.record.json`))))) !== contentHash(proof.recordHashes)) throw new Error("PREREQUISITE_CONSUMER_PROOF_CHANGED: bind the exact original continuation and definition records.");
  for (const [name, expected] of Object.entries(proof.retainedFiles ?? {})) {
    if (!/^(?:host-recovery\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
      || fileHash(path.join(p.identity, name)) !== expected || spec.retainedFiles[path.join(p.identity, name)] !== expected) throw new Error("PREREQUISITE_CONSUMER_HISTORY_CHANGED: retain the original proof's exact bytes.");
  }
  for (const name of ["intent.json", "identity-definition.budget.json", "identity-definition-check.budget.json", path.join(proof.stoppedDirectory, "state.json").replace(/^\.\//, "")]) {
    if (!proof.retainedFiles?.[name]) throw new Error("PREREQUISITE_CONSUMER_HISTORY_OMITTED");
  }
  // Recompute the original ordered charge inventory, not just its aggregate.
  const budgetFiles = request.priorBudgetFiles;
  if (!Array.isArray(budgetFiles) || !budgetFiles.length || new Set(budgetFiles).size !== budgetFiles.length
    || typeof request.auditBudgetFile !== "string" || !spec.retainedFiles[request.auditBudgetFile]
    || budgetFiles.some(f => typeof f !== "string" || !spec.retainedFiles[f])) throw new Error("PREREQUISITE_BUDGET_LINEAGE_MISSING");
  const audit = read<Record<string, any>>(request.auditBudgetFile), budgets = budgetFiles.map((file: string) => ({ file, value: read<Record<string, any>>(file) }));
  const prior = { modelCalls: audit.state.usage.modelCalls + budgets.reduce((n, b) => n + b.value.state.usage.modelCalls, 0),
    totalPayloadBytes: audit.state.usage.totalPayloadBytes + budgets.reduce((n, b) => n + b.value.state.usage.totalPayloadBytes, 0),
    budgetFilesHash: contentHash({ audit, budgets }) };
  if (audit.hash !== intent.originalBudgetHash || audit.planHash !== intent.originalPlanHash || contentHash(prior) !== contentHash(intent.priorUsage)) throw new Error("PREREQUISITE_BUDGET_LINEAGE_CHANGED: original charge distribution and inventory remain binding.");
  const total = { modelCalls: prior.modelCalls, totalPayloadBytes: prior.totalPayloadBytes };
  for (const stage of ["identity-definition", "identity-definition-check", "identity-consumers-0"]) {
    const charge = read<Record<string, any>>(path.join(p.identity, `${stage}.budget.json`));
    if (charge.taskId !== spec.taskId || charge.stage !== stage || charge.phase !== (stage === "identity-consumers-0" ? "identity-consumers" : stage)
      || charge.intentHash !== contentHash(intent) || charge.originalBudgetHash !== intent.originalBudgetHash
      || contentHash(charge.priorUsage) !== contentHash(prior) || contentHash(charge.limits) !== contentHash(limits)) throw new Error("PREREQUISITE_STAGE_BUDGET_SCOPE_CHANGED");
    total.modelCalls += charge.state.usage.modelCalls; total.totalPayloadBytes += charge.state.usage.totalPayloadBytes;
    if (contentHash(total) !== contentHash(charge.cumulative)) throw new Error("PREREQUISITE_STAGE_BUDGET_DISTRIBUTION_CHANGED");
  }
  if (budget.state.blocked !== true || budget.state.failure?.code !== "request-size" || contentHash(budget.limits) !== contentHash(limits)
    || contentHash(budget) !== request.originalBudgetHash || contentHash(budget.state.usage) !== contentHash(request.originalUsage)
    || contentHash(total) !== contentHash(budget.cumulative) || contentHash(total) !== contentHash(request.cumulativeBeforeRecovery)
    || budget.state.usage.modelCalls <= 0 || budget.state.usage.modelCalls >= limits.maxModelCalls
    || budget.state.usage.totalPayloadBytes >= limits.maxTotalPayloadBytes) throw new Error("PREREQUISITE_BUDGET_CHANGED: preserve actual inherited usage and the original finite limits.");
  const host = { hostname: os.hostname(), bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), pidNamespace: fs.readlinkSync("/proc/self/ns/pid") };
  if (contentHash(proof.host) !== contentHash(host)) throw new Error("PREREQUISITE_OWNER_HOST_CHANGED: inspect on the original host, never infer PID death from another namespace.");
  if (!Number.isSafeInteger(start.pid) || start.pid <= 0) throw new Error("PREREQUISITE_OWNER_UNKNOWN");
  try { process.kill(start.pid, 0); throw new Error("PREREQUISITE_OWNER_ALIVE"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  if (fs.existsSync(`/proc/${start.pid}`)) throw new Error("PREREQUISITE_OWNER_STILL_PRESENT");
  return p;
}

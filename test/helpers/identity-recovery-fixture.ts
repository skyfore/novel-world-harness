import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { realIdentityFixture } from "./identity-real-fixture.js";
import { contentHash as h } from "../../src/world/canonical.js";
import { digest } from "../../src/runtime/compile-loop/workspace.js";
import { captureRecordTree, fileHash } from "../../src/runtime/compile-loop/dedicated-session.js";
import { prerequisiteHandoffPaths, verifyPrerequisiteHandoff } from "../../src/runtime/compile-loop/prerequisite-handoff.js";
import { identityRecoveryHost } from "../../src/compiler/identity-definition-recovery.js";
import { RequirementLedger } from "../../src/compiler/requirement-ledger.js";
import { TraceStore } from "../../src/trace/store.js";
import { prepareIdentityContextRecovery } from "../../src/workflow/identity-consumer-context-recovery.js";
import type { PrerequisiteLoopSpec } from "../../src/runtime/compile-loop/prerequisite-supervisor.js";
import type { runLoopChild } from "../../src/runtime/compile-loop/process.js";

/** Real failed Pi invocation + real registered definitions. Only the provider,
 * historical domain preparation, and external engineering child processes are
 * fixture boundaries. No recovery inspector, verifier, ledger or gate is mocked. */
export async function identityRecoveryFixture() {
  const f = await realIdentityFixture(false, true), { root, p } = f;
  await expect(f.run()).rejects.toThrow(/request requires/);
  const { intent } = p, paths = prerequisiteHandoffPaths(root, intent.sourceId, intent.taskId);
  const write = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
  const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
  await write(path.join(paths.parent, "state.json"), f.parent);
  const originalState = await read(path.join(paths.identity, "state.json"));
  const budget = await read(path.join(paths.identity, "identity-consumers-0.budget.json"));
  expect(budget.state.usage.modelCalls).toBe(5);
  const records = await new RequirementLedger(root, intent.sourceId).identityRequirements(intent.taskId);
  expect(records).toHaveLength(2);
  await fs.mkdir(path.join(paths.identity, "host-recovery"));
  const definitionStop = { phase: "BREAK", stage: "identity-definition-check", intentHash: h(intent), childPid: null };
  await write(path.join(paths.identity, "host-recovery/state.json"), definitionStop);
  const continuation = { intentHash: h(intent), stoppedStateHash: digest(definitionStop), stoppedDirectory: "host-recovery", authorizationRef: "Original consumer continuation",
    recordHashes: records.map(h), host: await identityRecoveryHost(), retainedFiles: Object.fromEntries(Object.entries(captureRecordTree(paths.identity))
      .filter(([name]) => !name.startsWith("identity-consumers-") && (/^[^/]+$/.test(name) || name === "host-recovery/state.json"))) };
  await fs.mkdir(path.join(paths.identity, "consumer-review"));
  await write(path.join(paths.identity, "consumer-review/intent.json"), continuation);
  const stop = { ...originalState, continuationHash: h(continuation) };
  await write(path.join(paths.identity, "consumer-review/state.json"), stop);
  await write(path.join(paths.identity, "consumer-review/start.json"), { taskId: intent.taskId, intentHash: h(intent), pid: 2147483647, continuationHash: h(continuation) });
  const incidentFile = path.join(root, "incident.json"), authorizationFile = path.join(root, "authorization.json"), workerRequestFile = path.join(root, "request.json");
  const traces = new TraceStore(root), run = await traces.peekRun(stop.traceRunId), events = await traces.peekEvents(stop.traceRunId);
  await write(incidentFile, { readOnly: true, sourceId: intent.sourceId, taskId: intent.taskId, intentHash: h(intent), parentStateHash: digest(f.parent),
    stateHash: digest(stop), continuationHash: h(continuation), budget,
    trace: { id: run.id, status: run.status, counts: run.counts, requests: run.counts.llmRequests,
      payloadBytes: events.filter(e => e.type === "llm.request.payload").map(e => e.blobRef!.byteLength) } });
  const engineerId = "00000000-0000-4000-8000-000000000001", reviewerId = "00000000-0000-4000-8000-000000000002";
  await write(authorizationFile, { taskId: intent.taskId, originalParentStateHash: digest(f.parent), latestOriginThreadId: engineerId,
    latestUserCorrection: "Repair bounded context without increasing budgets", budgetIncreaseAuthorized: false, newSemanticGrant: false, originalParentMayResume: false });
  const request = { root, sourceId: intent.sourceId, taskId: intent.taskId, identityDirectory: paths.identity,
    input: { scope: p.review.scope, upstreamPlanHash: p.review.upstream.planHash, authorizationRef: p.review.authorizationRef },
    parentStateHash: digest(f.parent), expectedIntentHash: h(intent), originalIncidentHash: fileHash(incidentFile), originalIncidentFile: incidentFile,
    priorUsage: intent.priorUsage, stoppedStateHash: digest(stop), failedTraceRunId: run.id, authorizationRef: intent.authorizationRef,
    consumerAuthorizationRef: continuation.authorizationRef, auditBudgetFile: f.auditBudgetFile, priorBudgetFiles: [f.priorBudgetFile],
    authorization: { originThreadId: engineerId }, originalBudgetHash: h(budget), originalUsage: budget.state.usage, cumulativeBeforeRecovery: budget.cumulative };
  await write(workerRequestFile, request);
  await fs.mkdir(path.dirname(paths.registry), { recursive: true });
  await write(paths.registry, { threadId: engineerId });
  const retainedFiles = Object.fromEntries(Object.entries(captureRecordTree(paths.identity)).map(([file, hash]) => [path.join(paths.identity, file), hash]));
  for (const file of [incidentFile, authorizationFile, workerRequestFile, f.auditBudgetFile, f.priorBudgetFile, path.join(paths.parent, "state.json")]) retainedFiles[file] = fileHash(file);
  const spec: PrerequisiteLoopSpec = { version: 1, root, taskId: intent.taskId, sourceId: intent.sourceId, directory: paths.directory,
    registryFile: paths.registry, ownershipLocks: paths.locks, retainedFiles, parentStateFile: path.join(paths.parent, "state.json"), parentStateHash: digest(f.parent),
    authorizationRef: "Repair bounded context without increasing budgets", incidentFile, incidentHash: fileHash(incidentFile), authorizationFile, authorizationHash: fileHash(authorizationFile),
    inherited: { workers: 21, repairs: 20, commands: 83, failures: { original: 2 } }, engineerModel: "gpt-5.6-sol",
    workerEntry: "src/workflow/identity-consumer-context-recovery.ts", workerRequestFile, deadline: Date.now() + 3600000 };
  verifyPrerequisiteHandoff(spec);
  await fs.mkdir(paths.directory);
  await write(path.join(paths.directory, "spec.json"), spec);
  await write(path.join(paths.directory, "start.json"), { pid: 2147483647 });
  await write(path.join(paths.directory, "state.json"), { phase: "BREAK", childPid: null, workerDispatches: 0, commands: 1, engineeringTurns: 1,
    updatedAt: new Date(Date.now() - 1000).toISOString(), engineerThreadId: engineerId });
  const proof = await prepareIdentityContextRecovery(root, intent.sourceId, intent.taskId, "Later explicit immutable-evidence reconstruction authorization", []);
  const calls: string[] = [];
  const runner: typeof runLoopChild = async options => {
    const label = path.basename(options.prefix).replace(/^\d+-/, ""); calls.push(label); options.onSpawn?.(2147483646);
    if (label === "review") {
      expect(options.codexFilePolicy).toBe("read-only");
      expect(options.args).not.toContain("resume");
      options.onLine?.(JSON.stringify({ type: "thread.started", thread_id: reviewerId }));
      await write(options.args[options.args.indexOf("--output-last-message") + 1]!, {
        architecturePreserved: true, checksPreserved: true, addressesFailure: true, reason: "Fixture independent source review" });
    } else expect(options.readOnlyRootDirectory).toBe(options.prefix + ".sandbox");
    await fs.writeFile(options.prefix + ".stdout.jsonl", "fixture external check passed\n");
    return { code: 0, signal: null, error: null, timedOut: false, cancelled: false };
  };
  return { ...f, paths, spec, request, proof, budget, calls, runner, records };
}

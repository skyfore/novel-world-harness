import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { contentHash as h } from "../src/world/canonical.js";
import { createConsumerWorkPlan, consumerWorkDirectory, type ConsumerWorkBaseInput } from "../src/compiler/consumer-work-plan.js";
import { consumerRevalidationDirectory, consumerRevalidationScopeSchema } from "../src/compiler/identity-consumer-revalidation-model.js";
import { settleInterruptedConsumerWork, verifyConsumerWorkInterruption } from "../src/compiler/consumer-work-interruption.js";
import { prepareWorkProviderResumption } from "../src/compiler/consumer-work-provider-resumption.js";
import { inspectReceiptStageActivity } from "../src/compiler/receipt-stage-status.js";
import { WorkspaceOperationLock, inspectProcessLiveness } from "../src/util/workspace-lock.js";
import { TraceStore } from "../src/trace/store.js";
import { identityFixture } from "./helpers/identity-fixture.js";
import { captureRecordTree } from "../src/runtime/compile-loop/dedicated-session.js";

it.runIf(process.platform === "linux")("settles an actually killed Pi host, retains its charged request, and derives exactly one bounded continuation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-killed-consumer-"));
  const bytes = Buffer.from("Ada waits."), f = identityFixture(), sourceHash = createHash("sha256").update(bytes).digest("hex");
  const scope = consumerRevalidationScopeSchema.parse({ version: 1, sourceId: "src", sourceHash, taskId: f.intent.taskId,
    identityIntentHash: h(f.intent), inventoryHash: f.intent.inventoryHash, definitionHash: h(f.records[0]!.output), requirementIds: f.intent.targets.map(t => t.requirementId),
    ref: "event/consumer", originalRevisionHash: h("old"), currentRevisionHash: h("current"), upstreamPlanHash: h("plan"), receiptFingerprint: h("receipt"),
    acceptanceHash: h("acceptance"), parentStateHash: f.intent.parentStateHash, originalBudgetHash: f.intent.originalBudgetHash, authorizationRef: "original loop",
    priorUsage: { modelCalls: 177, totalPayloadBytes: 400000 }, priorBudgetFiles: [{ path: path.join(root, "prior-budget.json"), hash: h({ modelCalls: 177 }) }], executionPolicy: "consumer-work/v1",
    requirementPrefix: { length: 1, head: h("ledger") } });
  const directory = consumerRevalidationDirectory(root, scope), old = consumerWorkDirectory(directory), stage = "consumer-revalidation";
  const input = { scope: { sourceId: "src" }, scopeHash: h(scope), requiredSourceSegmentIds: ["seg"], artifactReadRefs: [],
    denominator: { total: 2, refs: [scope.ref, "event/another"], candidateIds: [], sourcePages: [0], originalQuestionIds: [] } } as unknown as ConsumerWorkBaseInput;
  const plan = createConsumerWorkPlan({ scope, stage, input, catalog: [], bytes, segments: [{ id: "seg", startByte: 0, endByte: bytes.length }], priorUsage: scope.priorUsage });
  await fs.mkdir(old, { recursive: true });
  await fs.writeFile(path.join(root, "prior-budget.json"), JSON.stringify({ modelCalls: 177 }));
  await fs.writeFile(path.join(directory, "scope.json"), JSON.stringify(scope));
  await fs.writeFile(path.join(old, `${stage}.plan.json`), JSON.stringify(plan));
  const child = spawn(process.execPath, ["--import", "tsx", "test/helpers/interrupted-consumer-child.ts", root, old], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let error = ""; child.stderr.on("data", data => { error += data.toString(); });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    const deadline = Date.now() + 15000;
    while (!await fs.stat(path.join(root, "request-sent")).catch(() => null)) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`Child did not start request: ${error}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const lock = await WorkspaceOperationLock.inspect(root);
    expect(await inspectProcessLiveness(lock.owner)).toBe("alive");
    expect(await inspectProcessLiveness({ ...lock.owner!, host: { ...lock.owner!.host!, pidNamespace: "foreign" } })).toBe("unknown");
    await expect(WorkspaceOperationLock.recover(root, lock.owner!.token)).rejects.toThrow(/still alive/);
    // Let asynchronous observational trace writes finish before a hard kill.
    await new Promise(resolve => setTimeout(resolve, 150));
    child.kill("SIGKILL"); await exited;
    expect(await inspectProcessLiveness(lock.owner)).toBe("exited");
    const invocation = JSON.parse(await fs.readFile(path.join(old, `${stage}.invocation.json`), "utf8"));
    const activity = await inspectReceiptStageActivity(root, "src", `receipt-bound-${h(scope)}-${stage}-work-v1`, invocation);
    expect(activity).toMatchObject({ state: "orphaned", processLiveness: "exited" });
    const recovered = await WorkspaceOperationLock.recover(root, lock.owner!.token);
    const args = { root, directory, stage, lockRecovery: recovered.archivePath, authorizationRef: "user:fix and restart" } as const;
    const before = captureRecordTree(old);
    expect(await settleInterruptedConsumerWork({ ...args, inspect: true })).toMatchObject({ status: "settlement-ready" });
    expect(captureRecordTree(old)).toEqual(before);
    const settled = await settleInterruptedConsumerWork(args);
    if (!("providerResumption" in settled)) throw Error("missing continuation");
    const request = settled.providerResumption!;
    expect((await new TraceStore(root).peekRun(request.failedTraceRunId)).status).toBe("interrupted");
    const after = captureRecordTree(old);
    for (const [file, hash] of Object.entries(before)) expect(after[file]).toBe(hash);
    const failure = JSON.parse(await fs.readFile(path.join(old, `${stage}.failure.json`), "utf8"));
    expect(await verifyConsumerWorkInterruption(root, old, plan, failure)).toMatchObject({ providerUsage: "unknown", semanticJudgment: "none" });
    const resume = await prepareWorkProviderResumption(root, scope, { plan, directory: old }, request);
    expect(resume.recovery.policy).toBe("consumer-work-interruption-resumption/v1");
    expect(resume.plan.priorUsage.modelCalls).toBe(178);
    expect(resume.plan.limits.maxModelCalls).toBe(11);
    expect(resume.plan.limits.maxTotalPayloadBytes).toBe(plan.limits.maxTotalPayloadBytes - failure.usage.usage.totalPayloadBytes);
    expect(resume.plan.budgetPolicy?.modelCallsMode).toBe("enforce");
    await expect(prepareWorkProviderResumption(root, scope, resume, request)).rejects.toThrow();
    const budgetFile = path.join(old, `${stage}.budget.json`), original = await fs.readFile(budgetFile, "utf8");
    const budget = JSON.parse(original); budget.state.usage.modelCalls = 0;
    await fs.writeFile(budgetFile, JSON.stringify(budget));
    await expect(prepareWorkProviderResumption(root, scope, { plan, directory: old }, request)).rejects.toThrow();
    await fs.writeFile(budgetFile, original);
    await fs.writeFile(path.join(old, `${stage}.proposal.json`), "{}");
    await expect(settleInterruptedConsumerWork({ ...args, inspect: true })).rejects.toThrow(/already submitted/);
  } finally { child.kill("SIGKILL"); await exited; await fs.rm(root, { recursive: true, force: true }); }
}, 30000);

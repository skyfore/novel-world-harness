import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash as h } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { UpstreamRepairLedger } from "./upstream-repair-ledger.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import type { UpstreamRepairPlan } from "./upstream-repair-plan.js";
import { createCompilerProposalToolset } from "./proposal-tools.js";
import { upstreamRepairSlotContext } from "./upstream-repair-staging.js";
import { verifyFailedIdentitySession } from "./identity-session-integrity.js";
import { identityUpstreamSessionContract, verifyIdentityUpstreamSession } from "./identity-upstream-session.js";
import { IDENTITY_CORRECTION_LIMITS, IDENTITY_CORRECTION_STAGE, identityCorrectionContract, identityCorrectionIntentSchema,
  readIdentityCorrectionIntent, validateIdentityEvidenceCorrection, type IdentityCorrectionIntent } from "./identity-upstream-correction-model.js";
import type { IdentityUpstreamSlotRecord } from "./identity-requirement-acceptance.js";

const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const present = async (file: string) => fs.stat(file).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return false; throw e; });
const toolContract = (root: string) => {
  const tool = createCompilerProposalToolset(root).tools.find(t => t.name === "propose_initial_world")!;
  return { originalArgumentSchema: tool.parameters, originalToolGuidelines: tool.promptGuidelines ?? [] };
};
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const identityCorrectionProofSchema = z.object({ planHash: hash, intentHash: hash, inputHash: hash, outputHash: hash,
  sessionId: z.string().min(1), traceRunId: z.string().min(1), sessionCheckpointHash: hash }).strict();

export async function assertIdentityCorrectionRetained(root: string, plan: UpstreamRepairPlan, directory: string, intent: IdentityCorrectionIntent) {
  const state = await new UpstreamRepairLedger(root, plan.sourceScope.sourceId).inspect();
  const attempt = state.attempts.find(a => a.attemptRef === intent.failedAttemptRef);
  const failure = state.records.find(r => r.payload.kind === "attempt-failed" && r.payload.attemptRef === intent.failedAttemptRef);
  if (intent.planHash !== plan.planHash || intent.taskId !== plan.identityRequirements?.taskId
    || state.records[intent.ledgerPrefix.length - 1]?.hash !== intent.ledgerPrefix.head
    || !attempt?.failed || attempt.staged || attempt.validatedHash || attempt.started.planHash !== plan.planHash
    || attempt.started.modelSessionRef !== intent.failedSessionRef || attempt.started.proposalId !== intent.proposalId
    || attempt.started.inputHash !== intent.originalInputHash || h(attempt.started.toolInput) !== intent.originalInputHash
    || !failure || h(failure) !== intent.failureRecordHash)
    throw prerequisiteStop("Correction lost its original failed attempt, plan or ledger prefix; preserve all evidence, no dispatch or retry");
  for (const file of intent.retainedFiles) {
    const location = path.resolve(directory, file.path);
    if (!location.startsWith(directory + path.sep) || await fs.realpath(location) !== location || h(await fs.readFile(location, "utf8")) !== file.hash)
      throw prerequisiteStop("Original failed slot or retained staged dependency changed; preserve both versions, no correction or retry");
  }
  const start = await read(path.join(directory, "start.json")), budget = await read(path.join(directory, "singleton.budget.json"));
  if (h(start.plan) !== h(plan) || h(start.origin) !== intent.originHash || start.origin.originalBudgetHash !== intent.originalBudgetHash
    || budget.originHash !== intent.originHash || budget.originalBudgetHash !== intent.originalBudgetHash || h(budget.cumulative) !== h(intent.priorUsage))
    throw prerequisiteStop("Correction allowance lost the original failed budget lineage; no charge reset or dispatch");
  const failureFile = await read(path.join(directory, "singleton.failure.json")), traces = new TraceStore(root);
  const runs = await traces.peekRunsByOperation(plan.sourceScope.sourceId, `identity-upstream-${intent.taskId}-singleton`);
  if (runs.length !== 1 || h({ run: runs[0], events: await traces.peekEvents(runs[0]!.id) }) !== intent.traceHash
    || !state.modelSessions.some(s => s.sessionRef === intent.failedSessionRef && s.closed && !s.chargedFailure)
    || !failureFile.sessionId)
    throw prerequisiteStop("Original failed Pi trace or settled reservation changed; no correction or retry");
  return { state, attempt, failure: failure.payload };
}

/** Read-only admission before allocating a new, explicit correction allowance.
 * This is intentionally limited to a settled field-evidence failure. */
export async function prepareIdentityUpstreamCorrection(root: string, plan: UpstreamRepairPlan, directory: string,
  request: { failedAttemptRef: string; authorizationRef: string }) {
  const existing = await readIdentityCorrectionIntent(directory);
  if (existing) {
    if (existing.failedAttemptRef !== request.failedAttemptRef || existing.authorizationRef !== request.authorizationRef)
      throw prerequisiteStop("The single correction authority is already bound; inspect correction.intent.json, no renamed or renewed retry");
    await assertIdentityCorrectionRetained(root, plan, directory, existing);
    return existing;
  }
  const ledger = new UpstreamRepairLedger(root, plan.sourceScope.sourceId), state = await ledger.inspect();
  const current = state.plans.find(p => p.plan.planHash === plan.planHash), attempt = state.attempts.find(a => a.attemptRef === request.failedAttemptRef);
  const failure = state.records.find(r => r.payload.kind === "attempt-failed" && r.payload.attemptRef === request.failedAttemptRef);
  if (!plan.identityRequirements?.consumerRevalidation || current?.state !== "needs-host-review" || current.finishIntent
    || current.hostCorrections?.length || state.modelSessions.some(s => !s.closed) || state.attempts.some(a => !a.staged && !a.failed)
    || !attempt?.failed || attempt.staged || attempt.validatedHash || !attempt.started.modelSessionRef
    || attempt.started.planHash !== plan.planHash || attempt.started.artifactKind !== "initial-world" || attempt.started.artifactId !== "singleton"
    || state.attempts.findLast(a => a.started.planHash === plan.planHash && a.started.artifactId === "singleton")?.attemptRef !== request.failedAttemptRef
    || failure?.payload.kind !== "attempt-failed"
    || !failure.payload.diagnostic.split("\n\n<nwh-tool-recovery>")[0]!.split("; ").every(d => d.startsWith("MISSING_OPENING_FIELD_EVIDENCE at /"))
    || await present(path.join(directory, "acceptance.invocation.json")) || await present(path.join(directory, "singleton.record.json"))
    || await present(path.join(directory, "singleton.session-checkpoint.json")))
    throw prerequisiteStop("Correction requires the latest settled initial-world field-evidence failure before finish or acceptance. Inspect inspect-identity-repairs for this source/task, copy lastFailure.attemptRef once; no guessing, replay or budget reset");
  const start = await read(path.join(directory, "start.json")), old = await read(path.join(directory, "singleton.input.json"));
  if (h(start.plan) !== h(plan) || start.order.at(-1)?.id !== "singleton") throw prerequisiteStop("Correction lost its frozen plan/order; no retry");
  const context = await upstreamRepairSlotContext(root, plan.sourceScope.sourceId, plan.planHash, { kind: "initial-world", id: "singleton" });
  if (h(context) !== h(old.context) || old.proposalId !== attempt.started.proposalId)
    throw prerequisiteStop("Failed slot dependencies changed; do not refreeze another context or retry");
  const { verifyIdentityUpstreamSlotTrace, verifyInvocationBudget, IDENTITY_UPSTREAM_SLOT_LIMITS } = await import("./identity-requirement-acceptance.js");
  for (const target of start.order.slice(0, -1)) await verifyIdentityUpstreamSlotTrace(root, plan, await read(path.join(directory, `${target.id}.record.json`)));
  const failureFile = await read(path.join(directory, "singleton.failure.json")), budget = await read(path.join(directory, "singleton.budget.json"));
  const traces = new TraceStore(root), runs = await traces.peekRunsByOperation(plan.sourceScope.sourceId,
    `identity-upstream-${plan.identityRequirements!.taskId}-singleton`), run = runs[0];
  if (runs.length !== 1 || run?.status !== "failed" || !run.endedAt || run.counts.retries
    || !failureFile.sessionFile?.startsWith(path.join(directory, "sessions", "singleton") + path.sep)
    || await fs.realpath(failureFile.sessionFile) !== failureFile.sessionFile)
    throw prerequisiteStop("Failed slot lacks its unique settled original Pi trace/session; no correction or retry");
  const events = await traces.peekEvents(run.id), terminal = events.findLast(e => e.type === "tool.call.started" && e.data?.toolName === "propose_initial_world");
  await verifyInvocationBudget(root, plan, "singleton", events, IDENTITY_UPSTREAM_SLOT_LIMITS);
  const args = terminal?.blobRef ? await traces.peekBlob(terminal.blobRef) as { proposal_json: string } : undefined;
  if (!args || h(JSON.parse(args.proposal_json)) !== attempt.started.inputHash
    || !events.some(e => e.type === "tool.call.failed" && e.toolCallId === terminal!.toolCallId)
    || events.some(e => e.type.startsWith("world.commit.") || e.type === "llm.response.failed")
    || events.filter(e => e.type === "llm.request.started").some(e => e.data?.providerId !== "openai-codex" || e.data?.modelId !== "gpt-6.1-sol")
    || !events.some(e => e.type === "stage.started" && e.data?.sessionId === failureFile.sessionId && e.data?.inputHash === h(JSON.stringify(old))))
    throw prerequisiteStop("Failed slot differs from its actual original Pi proposal; no correction or retry");
  const proof = verifyFailedIdentitySession(await fs.readFile(failureFile.sessionFile, "utf8"), root,
    { sessionId: failureFile.sessionId, provider: "openai-codex", model: "gpt-6.1-sol", output: args }, JSON.stringify(old),
    await fs.readFile(path.join(directory, "singleton.requests.jsonl"), "utf8"), await fs.readFile(path.join(directory, "singleton.messages.jsonl"), "utf8"),
    identityUpstreamSessionContract("initial-world"));
  const sizes = proof.payloads.map(v => Buffer.byteLength(JSON.stringify(v))), usage = budget.state.usage;
  if (proof.transcript.responses !== usage.modelCalls || sizes.length !== usage.payloads || sizes.reduce((a, b) => a + b, 0) !== usage.totalPayloadBytes
    || Math.max(...sizes, ...proof.contexts.map(c => Buffer.byteLength(JSON.stringify(c)))) !== usage.largestRequestBytes
    || h(failureFile.usage.usage) !== h(usage)) throw prerequisiteStop("Failed slot charge differs from actual Pi requests; retain original budget, no correction");
  const files = ["start.json", "authorization.json"];
  for (const target of start.order) {
    for (const suffix of ["invocation.json", "input.json", "budget.json", "messages.jsonl", "requests.jsonl", "record.json", "session-checkpoint.json", "failure.json"])
      if (await present(path.join(directory, `${target.id}.${suffix}`))) files.push(`${target.id}.${suffix}`);
    const session = await read(path.join(directory, `${target.id}.${target.id === "singleton" ? "failure" : "session-checkpoint"}.json`));
    files.push(path.relative(directory, session.sessionFile));
  }
  return identityCorrectionIntentSchema.parse({ version: 1, policy: "initial-world-field-evidence-correction/v1", planHash: plan.planHash,
    taskId: plan.identityRequirements.taskId, target: { kind: "initial-world", id: "singleton" }, failedAttemptRef: request.failedAttemptRef,
    failedSessionRef: attempt.started.modelSessionRef, proposalId: attempt.started.proposalId, authorizationRef: request.authorizationRef,
    originalBudgetHash: start.origin.originalBudgetHash, originHash: h(start.origin), priorUsage: budget.cumulative, limits: IDENTITY_CORRECTION_LIMITS,
    originalInputHash: attempt.started.inputHash, failureRecordHash: h(failure), contextHash: h(context), toolContractHash: h(toolContract(root)),
    traceHash: h({ run, events }), ledgerPrefix: { length: state.records.length, head: state.records.at(-1)!.hash },
    retainedFiles: await Promise.all(files.sort().map(async file => ({ path: file, hash: h(await fs.readFile(path.join(directory, file), "utf8")) }))) });
}

export async function identityCorrectionInput(root: string, plan: UpstreamRepairPlan, directory: string, intent: IdentityCorrectionIntent) {
  const { attempt, failure } = await assertIdentityCorrectionRetained(root, plan, directory, intent);
  const old = await read(path.join(directory, "singleton.input.json")), contract = toolContract(root);
  if (h(contract) !== intent.toolContractHash) throw prerequisiteStop("Correction tool contract changed since authorization; preserve original intent, no dispatch");
  return { task: "Correct only evidence_selectors of the exact failed Pi proposal. Preserve its payload, source scope and proposal ID. Read the original context before the sole submission. This retains a draft for normal host validation and independent acceptance; it writes no world truth.",
    intent, failedProposal: attempt.started.toolInput, diagnostic: failure, context: old.context, ...contract };
}

/** A read-only Pi draft has a retained receipt, never a fabricated successful
 * model staging reservation. The separate host attempt is linked explicitly. */
export async function verifyIdentityCorrectionProof(root: string, plan: UpstreamRepairPlan, directory: string) {
  const intent = await readIdentityCorrectionIntent(directory);
  if (!intent) throw prerequisiteStop("Missing original correction authority; no inferred recovery");
  const { attempt, failure } = await assertIdentityCorrectionRetained(root, plan, directory, intent);
  const proof = identityCorrectionProofSchema.parse(await read(path.join(directory, "correction.proof.json")));
  const input = await read(path.join(directory, `${IDENTITY_CORRECTION_STAGE}.input.json`)), proposal = await read(path.join(directory, `${IDENTITY_CORRECTION_STAGE}.proposal.json`));
  const context = await read(path.join(directory, `${IDENTITY_CORRECTION_STAGE}.context.json`));
  const checkpoint = await verifyIdentityUpstreamSession(root, directory, IDENTITY_CORRECTION_STAGE, proof, identityCorrectionContract);
  if (proof.planHash !== plan.planHash || proof.intentHash !== h(intent) || proof.inputHash !== h(input) || proof.outputHash !== h(proposal)
    || h(input.intent) !== h(intent) || input.contextHash !== h(context) || input.readTool !== identityCorrectionContract.readTools[0]
    || h(context.intent) !== h(intent) || h(context.failedProposal) !== intent.originalInputHash || h(context.context) !== intent.contextHash || h(context.diagnostic) !== h(failure)
    || h({ originalArgumentSchema: context.originalArgumentSchema, originalToolGuidelines: context.originalToolGuidelines }) !== intent.toolContractHash
    || h(JSON.parse(checkpoint.output.proposal_json)) !== h(proposal)) throw prerequisiteStop("Correction proof changed its original input, proposal or Pi receipt; no staging or retry");
  validateIdentityEvidenceCorrection(attempt.started.toolInput, proposal);
  const store = new TraceStore(root), run = await store.peekRun(proof.traceRunId), events = await store.peekEvents(proof.traceRunId);
  const { verifyInvocationBudget } = await import("./identity-requirement-acceptance.js");
  const invocation = await verifyInvocationBudget(root, plan, IDENTITY_CORRECTION_STAGE, events, IDENTITY_CORRECTION_LIMITS);
  const submitted = events.filter(e => e.type === "tool.call.completed" && e.data?.toolName === identityCorrectionContract.terminalTool);
  const call = submitted.length === 1 ? events.find(e => e.type === "tool.call.started" && e.toolCallId === submitted[0]!.toolCallId) : undefined;
  const reads = events.filter(e => e.type === "tool.call.completed" && e.data?.toolName === identityCorrectionContract.readTools[0]);
  const provenance = events.filter(e => e.type === "stage.started" && e.data?.phase === "identity-upstream-slot");
  if (invocation.correctionIntentHash !== h(intent) || run.status !== "succeeded" || !run.endedAt || run.sourceId !== plan.sourceScope.sourceId || run.counts.retries
    || run.operationId !== `identity-upstream-${intent.taskId}-${IDENTITY_CORRECTION_STAGE}` || !call?.blobRef || !reads.length || reads.some(e => e.seq >= call.seq)
    || h(await store.peekBlob(call.blobRef)) !== h(checkpoint.output)
    || provenance.length !== 1 || provenance[0]!.data?.sessionId !== proof.sessionId || provenance[0]!.data?.planHash !== plan.planHash
    || provenance[0]!.data?.inputHash !== h(JSON.stringify(input)) || provenance[0]!.data?.subscription !== true
    || events.some(e => e.type.startsWith("world.commit.") || e.type === "llm.response.failed" || e.type === "tool.call.failed"
      || (e.type === "tool.call.started" && ![...identityCorrectionContract.readTools, identityCorrectionContract.terminalTool].includes(String(e.data?.toolName)))
      || (e.type === "llm.request.started" && (e.data?.providerId !== "openai-codex" || e.data?.modelId !== "gpt-6.1-sol"))))
    throw prerequisiteStop("Correction lacks complete actual read-only Pi provenance; no host staging or retry");
  for (const event of reads) {
    const result = event.blobRef ? await store.peekBlob(event.blobRef) as { content?: Array<{ type: string; text?: string }> } : undefined;
    const text = result?.content?.filter(c => c.type === "text").map(c => c.text ?? "").join("");
    if (!text || h(JSON.parse(text)) !== h(context)) throw prerequisiteStop("Correction did not receive the complete original context; no partial-read acceptance or retry");
  }
  return { proof, intent, proposal };
}

export async function verifyIdentityCorrectedSlot(root: string, plan: UpstreamRepairPlan, directory: string, record: IdentityUpstreamSlotRecord) {
  const { proof, intent, proposal } = await verifyIdentityCorrectionProof(root, plan, directory);
  const state = await new UpstreamRepairLedger(root, plan.sourceScope.sourceId).inspect(), attempt = state.attempts.find(a => a.attemptRef === record.attemptRef);
  const grant = state.plans.find(p => p.plan.planHash === plan.planHash)?.hostCorrections?.find(c => c.failedAttemptRef === intent.failedAttemptRef);
  const staged = state.records.find(r => r.payload.kind === "attempt-staged" && r.payload.attemptRef === record.attemptRef)?.payload;
  if (record.correctionHash !== h(proof) || record.planHash !== plan.planHash || h(record.target) !== h(intent.target)
    || record.sessionRef !== intent.failedSessionRef || record.sessionId !== proof.sessionId || record.traceRunId !== proof.traceRunId
    || record.sessionCheckpointHash !== proof.sessionCheckpointHash || record.proposalId !== intent.proposalId
    || !attempt?.staged || attempt.failed || !attempt.validatedHash || attempt.started.modelSessionRef
    || attempt.started.planHash !== plan.planHash || attempt.started.artifactKind !== intent.target.kind || attempt.started.artifactId !== intent.target.id
    || attempt.started.proposalId !== intent.proposalId || h(attempt.started.toolInput) !== h(proposal) || attempt.started.inputHash !== h(proposal)
    || grant?.inputHash !== h(proposal) || grant.auditRef !== `pi-identity-correction:${h(proof)}`
    || staged?.kind !== "attempt-staged" || staged.proposalHash !== record.proposalHash)
    throw prerequisiteStop("Host correction is detached from the actual Pi draft, original failed slot or exact staged receipt; no acceptance or retry");
}

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash as h } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import type { UpstreamRepairPlan } from "./upstream-repair-plan.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { readIdentityEntryContractRecovery, assertIdentityEntryContractRecovery } from "./identity-finish-contract-recovery.js";
import { readIdentityFinishRevision, FINISH_REVISION_ACCEPTANCE } from "./identity-finish-revision.js";
import { identityUpstreamGraph, identityUpstreamEvidence, verifyIdentityAcceptanceRejection } from "./identity-requirement-acceptance.js";

export const EVIDENCE_ACCEPTANCE_STAGE = "finish-revision-evidence-acceptance";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.object({ version: z.literal(1), policy: z.literal("identity-acceptance-evidence-recovery/v1"),
  planHash: hash, contractRecoveryHash: hash, authorizationRef: z.string().trim().min(1),
  rejectedInputHash: hash, rejectedRecordHash: hash, graphHash: hash, evidenceHash: hash,
  traceRunId: z.string(), traceHash: hash,
  limits: z.object({ maxModelCalls: z.number().int().positive(), maxRequestBytes: z.number().int().positive(), maxTotalPayloadBytes: z.number().int().positive() }).strict(),
  retainedFiles: z.array(z.object({ path: z.string(), hash }).strict()).min(1),
}).strict();
export type IdentityAcceptanceEvidenceRecovery = z.infer<typeof schema>;
const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const maybe = async (file: string) => { try { return await read(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } };
export async function readAcceptanceEvidenceRecovery(directory: string) {
  const value = await maybe(path.join(directory, `${EVIDENCE_ACCEPTANCE_STAGE}.intent.json`));
  return value ? schema.parse(value) : null;
}

export async function assertAcceptanceEvidenceRecovery(root: string, plan: UpstreamRepairPlan, directory: string, recovery: IdentityAcceptanceEvidenceRecovery) {
  const original = await readIdentityEntryContractRecovery(directory), revision = await readIdentityFinishRevision(directory);
  if (!original || !revision || recovery.planHash !== plan.planHash || h(original) !== recovery.contractRecoveryHash || original.authorizationRef !== recovery.authorizationRef)
    throw prerequisiteStop("Acceptance evidence recovery lost its explicitly authorized contract transition; no renewed authority");
  await assertIdentityEntryContractRecovery(root, plan, directory, original);
  for (const file of recovery.retainedFiles) {
    const location = path.resolve(directory, file.path);
    if (!location.startsWith(directory + path.sep) || await fs.realpath(location) !== location || h(await fs.readFile(location, "utf8")) !== file.hash)
      throw prerequisiteStop("Acceptance evidence recovery changed the retained negative review or budget; no dispatch or retry");
  }
  const budget = await read(path.join(directory, `${FINISH_REVISION_ACCEPTANCE}.budget.json`));
  const remaining = { ...revision.acceptanceLimits, maxModelCalls: revision.acceptanceLimits.maxModelCalls - budget.state.usage.modelCalls,
    maxTotalPayloadBytes: revision.acceptanceLimits.maxTotalPayloadBytes - budget.state.usage.totalPayloadBytes };
  const traces = new TraceStore(root);
  if (remaining.maxModelCalls < 2 || remaining.maxTotalPayloadBytes <= 0 || h(remaining) !== h(recovery.limits)
    || h({ run: await traces.peekRun(recovery.traceRunId), events: await traces.peekEvents(recovery.traceRunId) }) !== recovery.traceHash)
    throw prerequisiteStop("Acceptance evidence recovery lost its original remaining allowance or trace; no reset or retry");
}

/** Host transport correction only: reveal already staged, hash-bound field
 * evidence. No proposal changes and no override of the retained negative verdict. */
export async function prepareAcceptanceEvidenceRecovery(root: string, plan: UpstreamRepairPlan, directory: string,
  request: { rejectedInputHash: string; authorizationRef: string }) {
  const existing = await readAcceptanceEvidenceRecovery(directory);
  if (existing) {
    if (existing.rejectedInputHash !== request.rejectedInputHash || existing.authorizationRef !== request.authorizationRef)
      throw prerequisiteStop("Acceptance evidence recovery is already bound; no renamed authority or second recovery");
    await assertAcceptanceEvidenceRecovery(root, plan, directory, existing); return existing;
  }
  const original = await readIdentityEntryContractRecovery(directory), revision = await readIdentityFinishRevision(directory);
  if (!original || !revision || !request.authorizationRef || request.authorizationRef !== original.authorizationRef)
    throw prerequisiteStop("Acceptance evidence correction requires the same explicit entry-contract recovery authorization; no implicit grant");
  if (await maybe(path.join(directory, `${EVIDENCE_ACCEPTANCE_STAGE}.invocation.json`)))
    throw prerequisiteStop("Acceptance evidence correction is consumed; preserve the actual result, no redispatch");
  const record = await verifyIdentityAcceptanceRejection(root, plan);
  const input = await read(path.join(directory, `${FINISH_REVISION_ACCEPTANCE}.input.json`));
  if (record.inputHash !== request.rejectedInputHash)
    throw prerequisiteStop("Copy finishRevisionProgress.acceptanceEvidenceRecoveryCandidate.rejectedInputHash from inspect-identity-repairs in this source/task once; no guessed input or unchanged retry");
  const graph = await identityUpstreamGraph(root, plan), evidence = await identityUpstreamEvidence(root, plan, graph);
  if (input.stagedEvidence !== undefined || !evidence.some(e => Array.isArray(e.evidenceAssertions) && e.evidenceAssertions.length)
    || h(graph) !== record.graphHash)
    throw prerequisiteStop("Acceptance recovery requires omitted existing field evidence on the identical graph; no unchanged semantic retry or new proposal");
  const budget = await read(path.join(directory, `${FINISH_REVISION_ACCEPTANCE}.budget.json`));
  const checkpoint = await read(path.join(directory, `${FINISH_REVISION_ACCEPTANCE}.session-checkpoint.json`));
  const traces = new TraceStore(root);
  const files = ["record.json", "input.json", "proposal.json", "invocation.json", "budget.json", "session-checkpoint.json", "messages.jsonl", "requests.jsonl"]
    .map(suffix => `${FINISH_REVISION_ACCEPTANCE}.${suffix}`);
  files.push(path.relative(directory, checkpoint.sessionFile));
  const value = schema.parse({ version: 1, policy: "identity-acceptance-evidence-recovery/v1", planHash: plan.planHash,
    contractRecoveryHash: h(original), authorizationRef: request.authorizationRef, rejectedInputHash: record.inputHash,
    rejectedRecordHash: h(record), graphHash: record.graphHash, evidenceHash: h(evidence), traceRunId: record.traceRunId,
    traceHash: h({ run: await traces.peekRun(record.traceRunId), events: await traces.peekEvents(record.traceRunId) }),
    limits: { ...revision.acceptanceLimits, maxModelCalls: revision.acceptanceLimits.maxModelCalls - budget.state.usage.modelCalls,
      maxTotalPayloadBytes: revision.acceptanceLimits.maxTotalPayloadBytes - budget.state.usage.totalPayloadBytes },
    retainedFiles: await Promise.all(files.map(async file => ({ path: file, hash: h(await fs.readFile(path.join(directory, file), "utf8")) }))) });
  await assertAcceptanceEvidenceRecovery(root, plan, directory, value); return value;
}

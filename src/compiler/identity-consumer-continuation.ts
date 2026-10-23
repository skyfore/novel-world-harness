import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { digest } from "../runtime/compile-loop/workspace.js";
import { TraceStore } from "../trace/store.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { identityRecoveryHost } from "./identity-definition-recovery.js";
import { identityConsumersReviewable, identityDefinitionGaps, identityRecordSchema, identityRequirementDirectory, identityStages } from "./identity-requirements.js";
import { verifyIdentityRecord } from "./identity-requirement-trace.js";
import type { PreparedIdentityRequirements } from "./identity-requirement-service.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const identityConsumerContinuationSchema = z.object({
  version: z.literal(1), policy: z.literal("identity-consumer-gap-review/v1"), intentHash: hash,
  stoppedStateHash: hash, stoppedDirectory: z.enum([".", "host-recovery"]), recordHashes: z.array(hash).length(2),
  originalPid: z.number().int().positive(),
  host: z.object({ hostname: z.string().min(1), bootId: z.string().min(1), pidNamespace: z.string().min(1) }).strict(),
  reviewedFixRef: z.string().min(1), authorizationRef: z.string().min(1),
  retainedFiles: z.record(z.string().regex(/^(?:host-recovery\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/), hash),
}).strict();
export type IdentityConsumerContinuation = z.infer<typeof identityConsumerContinuationSchema>;

async function assertExited(pid: number) {
  try { process.kill(pid, 0); throw prerequisiteStop("Original identity owner is still alive"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw prerequisiteStop("Cannot prove original identity owner exited"); }
  try { await fs.stat(`/proc/${pid}`); throw prerequisiteStop("Original identity PID remains present"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}

/** Does not rerun, re-register or reclassify either consumed definition record.
 * The only next work is the original unconsumed read-only consumer shard list. */
export async function inspectIdentityConsumerContinuation(root: string, p: PreparedIdentityRequirements, raw: IdentityConsumerContinuation) {
  const proof = identityConsumerContinuationSchema.parse(raw), intentHash = contentHash(p.intent);
  if (proof.intentHash !== intentHash || contentHash(await identityRecoveryHost()) !== contentHash(proof.host)) throw prerequisiteStop("Consumer continuation changed intent or owning-host namespace");
  const directory = identityRequirementDirectory(root, p.intent.sourceId, p.intent.taskId);
  const read = async (name: string) => JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
  const names: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === "consumer-review") continue; // single-use reservation is checked by the runner
    if (entry.isDirectory() && entry.name === "host-recovery") {
      for (const child of await fs.readdir(path.join(directory, entry.name), { withFileTypes: true })) {
        if (!child.isFile()) throw prerequisiteStop("Unexpected entry in retained identity recovery");
        names.push(`${entry.name}/${child.name}`);
      }
    } else if (entry.isFile()) names.push(entry.name);
    else throw prerequisiteStop("Unexpected entry in retained identity files");
  }
  const required = ["start.json", "state.json", "intent.json", "inventory.json", "context.json", "provider.json", "hooks.jsonl",
    ...["identity-definition", "identity-definition-check"].flatMap(stage => ["invocation", "input", "proposal", "record", "budget"].map(s => `${stage}.${s}.json`)),
    ...(proof.stoppedDirectory === "host-recovery" ? ["start.json", "state.json", "intent.json", "hooks.jsonl", "registration-receipt.json"].map(n => `host-recovery/${n}`) : [])];
  if (required.some(n => !proof.retainedFiles[n]) || contentHash(names.sort()) !== contentHash(Object.keys(proof.retainedFiles).sort())) throw prerequisiteStop("Consumer continuation must freeze every original file without omissions or later stages");
  for (const [name, expected] of Object.entries(proof.retainedFiles)) {
    const file = path.join(directory, name);
    if (!(await fs.lstat(file)).isFile() || createHash("sha256").update(await fs.readFile(file)).digest("hex") !== expected) throw prerequisiteStop(`Retained identity file changed: ${name}`);
  }
  const state = await read(path.join(proof.stoppedDirectory, "state.json")), start = await read(path.join(proof.stoppedDirectory, "start.json"));
  const originalStart = await read("start.json"), invocation = await read("identity-definition-check.invocation.json");
  if (digest(state) !== proof.stoppedStateHash || state.phase !== "BREAK" || state.stage !== "identity-definition-check" || state.childPid !== null || state.traceRunId !== null
    || state.reason !== String(prerequisiteStop("Independent definition retains a gap or negative review; no consumer dispatch and no definition retry"))
    || state.intentHash !== intentHash || start.intentHash !== intentHash || start.taskId !== p.intent.taskId || start.pid !== proof.originalPid
    || invocation.pid !== proof.originalPid || originalStart.intentHash !== intentHash || originalStart.taskId !== p.intent.taskId
    || !Number.isSafeInteger(originalStart.pid) || originalStart.pid <= 0) throw prerequisiteStop("Consumer continuation requires the exact settled legacy definition-gap stop");
  await assertExited(proof.originalPid); await assertExited(originalStart.pid);
  const records = await Promise.all(["identity-definition", "identity-definition-check"].map(async s => identityRecordSchema.parse(await read(`${s}.record.json`))));
  const ledger = new RequirementLedger(root, p.intent.sourceId), registered = await ledger.identityRequirements(p.intent.taskId);
  if (contentHash(records.map(contentHash)) !== contentHash(proof.recordHashes) || contentHash(registered) !== contentHash(records)
    || !identityConsumersReviewable(records) || !identityDefinitionGaps(records[0]!.output).length) throw prerequisiteStop("Original supported uncertainty definitions and exact registrations required; no negative-review override");
  const { bytes, ...context } = p;
  if (contentHash(await read("intent.json")) !== intentHash || contentHash(await read("inventory.json")) !== p.intent.inventoryHash
    || contentHash(await read("context.json")) !== contentHash({ ...context, sourceBytesBase64: Buffer.from(bytes).toString("base64") })) throw prerequisiteStop("Current identity source, frozen scope or consumer inventory changed");
  const traces = new TraceStore(root), index = JSON.parse(await fs.readFile(traces.indexPath, "utf8")) as { runs: { id: string }[] };
  const runs = await Promise.all(index.runs.map(r => traces.peekRun(r.id)));
  const remainingStages = identityStages(p.intent).slice(2);
  if (runs.some(r => r.status === "running") || remainingStages.some(({ stage }) => names.some(n => n.startsWith(stage + "."))
    || runs.some(r => r.sourceId === p.intent.sourceId && r.operationId === `identity-requirements-${p.intent.taskId}-${stage}`))) throw prerequisiteStop("A trace is unsettled or a consumer stage was already invoked; no redispatch");
  let modelCalls = 0, totalPayloadBytes = 0;
  for (const [i, record] of records.entries()) {
    await verifyIdentityRecord(root, record, records.slice(0, i), p);
    const budget = await read(`${record.stage}.budget.json`);
    modelCalls += budget.state.usage.modelCalls; totalPayloadBytes += budget.state.usage.totalPayloadBytes;
  }
  const cumulative = { modelCalls: p.intent.priorUsage.modelCalls + modelCalls, totalPayloadBytes: p.intent.priorUsage.totalPayloadBytes + totalPayloadBytes };
  if (state.newModelCalls !== modelCalls || state.cumulativeModelCalls !== cumulative.modelCalls) throw prerequisiteStop("Stopped identity cumulative budget differs from its retained traces");
  return { proof, records, usage: { modelCalls, totalPayloadBytes }, cumulative, remainingStages };
}

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { digest } from "../runtime/compile-loop/workspace.js";
import { TraceStore } from "../trace/store.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { identityRecordSchema, identityRequirementDirectory, identityStages } from "./identity-requirements.js";
import { verifyIdentityRecord } from "./identity-requirement-trace.js";
import type { PreparedIdentityRequirements } from "./identity-requirement-service.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const identityDefinitionRecoverySchema = z.object({
  version: z.literal(1), policy: z.literal("identity-definition-host-accounting/v1"),
  intentHash: hash, stoppedStateHash: hash, recordHash: hash,
  originalPid: z.number().int().positive(),
  host: z.object({ hostname: z.string().min(1), bootId: z.string().min(1), pidNamespace: z.string().min(1) }).strict(),
  reviewedFixRef: z.string().min(1),
  // Host-only proof, never sent to Pi. These are exact original file bytes.
  retainedFiles: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/), hash),
}).strict();
export type IdentityDefinitionRecovery = z.infer<typeof identityDefinitionRecoverySchema>;

export async function identityRecoveryHost() {
  if (process.platform !== "linux") throw prerequisiteStop("Identity recovery requires the original Linux owning host");
  return { hostname: os.hostname(), bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
    pidNamespace: await fs.readlink("/proc/self/ns/pid") };
}

/** Read-only, narrowly bounded recovery of a successfully completed first Pi
 * stage rejected during host registration. No provider retry or semantic change.
 * Original failures, state, input, proposal, trace and budget remain immutable. */
export async function inspectIdentityDefinitionRecovery(root: string, p: PreparedIdentityRequirements, raw: IdentityDefinitionRecovery) {
  const proof = identityDefinitionRecoverySchema.parse(raw), intentHash = contentHash(p.intent);
  if (proof.intentHash !== intentHash || contentHash(await identityRecoveryHost()) !== contentHash(proof.host)) {
    throw prerequisiteStop("Identity recovery scope or owning-host namespace changed; absence in another PID view is not proof");
  }
  try { process.kill(proof.originalPid, 0); throw prerequisiteStop("Original identity owner is still alive; no recovery"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw prerequisiteStop("Cannot prove original identity owner exited"); }
  // ESRCH is the only admissible result; /proc recheck also fails closed on PID reuse.
  try { await fs.stat(`/proc/${proof.originalPid}`); throw prerequisiteStop("Original identity owner PID remains present; no recovery"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const directory = identityRequirementDirectory(root, p.intent.sourceId, p.intent.taskId);
  const read = async (name: string) => JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
  const required = ["start.json", "state.json", "intent.json", "inventory.json", "context.json", "provider.json", "hooks.jsonl",
    ...["invocation", "input", "proposal", "record", "budget"].map(s => `identity-definition.${s}.json`)];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (entries.some(e => !e.isFile() && !(e.isDirectory() && e.name === "host-recovery"))) throw prerequisiteStop("Unexpected identity recovery filesystem entry");
  const names = entries.filter(e => e.isFile()).map(e => e.name).sort();
  if (required.some(name => !proof.retainedFiles[name]) || contentHash(names) !== contentHash(Object.keys(proof.retainedFiles).sort())) {
    throw prerequisiteStop("Identity recovery must freeze every original file; unexpected stage, temporary write or omission");
  }
  for (const [name, expected] of Object.entries(proof.retainedFiles)) {
    const file = path.join(directory, name);
    if (!(await fs.lstat(file)).isFile() || createHash("sha256").update(await fs.readFile(file)).digest("hex") !== expected) {
      throw prerequisiteStop(`Retained identity file changed: ${name}`);
    }
  }
  const state = await read("state.json"), start = await read("start.json"), invocation = await read("identity-definition.invocation.json");
  const record = identityRecordSchema.parse(await read("identity-definition.record.json"));
  if (digest(state) !== proof.stoppedStateHash || state.phase !== "BREAK" || state.stage !== "identity-definition" || state.childPid !== null
    || state.reason !== String(prerequisiteStop("Identity record lacks actual bounded Pi subscription provenance"))
    || state.intentHash !== intentHash || state.traceRunId !== record.traceRunId || contentHash(record) !== proof.recordHash
    || start.taskId !== p.intent.taskId || start.intentHash !== intentHash || start.pid !== proof.originalPid || invocation.pid !== proof.originalPid
    || record.phase !== "identity-definition" || record.stage !== "identity-definition" || record.predecessorRecordHash !== null
    || contentHash(await read("provider.json")) !== contentHash({ provider: "openai-codex", model: "gpt-6.1-sol", subscription: true, credentialType: "oauth" })) {
    throw prerequisiteStop("Only the retained successful definition with its exact host-accounting stop is recoverable");
  }
  const ledger = new RequirementLedger(root, p.intent.sourceId), traces = new TraceStore(root);
  if ((await ledger.identityRequirements(p.intent.taskId)).length || (await traces.peekRuns({ status: "running", limit: 100 })).length) {
    throw prerequisiteStop("Identity registration already consumed or a trace remains unsettled; no recovery retry");
  }
  const priorRuns = await traces.peekAllRuns({ sourceId: p.intent.sourceId, kind: "prepare" });
  for (const { stage } of identityStages(p.intent).slice(1)) {
    if (names.some(name => name.startsWith(stage + ".")) || priorRuns
      .some(run => run.operationId === `identity-requirements-${p.intent.taskId}-${stage}`)) {
      throw prerequisiteStop("A later fixed identity stage was already invoked; this recovery cannot redispatch it");
    }
  }
  await verifyIdentityRecord(root, record, [], p);
  const budget = await read("identity-definition.budget.json");
  return { proof, record, usage: budget.state.usage as { modelCalls: number; totalPayloadBytes: number },
    cumulative: budget.cumulative, remainingStages: identityStages(p.intent).slice(1) };
}

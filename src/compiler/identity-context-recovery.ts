import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { digest } from "../runtime/compile-loop/workspace.js";
import { captureRecordTree } from "../runtime/compile-loop/dedicated-session.js";
import { prerequisiteLoopSpecSchema } from "../runtime/compile-loop/prerequisite-supervisor.js";
import { verifyPrerequisiteHandoff } from "../runtime/compile-loop/prerequisite-handoff.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { identityContextRecoveryDirectory, identityRequirementDirectory, identityRecordSchema,
  identityConsumersReviewable, identityStages } from "./identity-requirements.js";
import { verifyIdentityRecord, identityRequestUsageMatches } from "./identity-requirement-trace.js";
import type { PreparedIdentityRequirements } from "./identity-requirement-service.js";
import type { ModelRequestBudgetState } from "../runtime/model-request-budget.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const legacyIdentityContextRecoverySchema = z.object({
  version: z.literal(1), policy: z.literal("identity-context-reconstruction/v1"),
  taskId: hash, sourceId: z.string().min(1), intentHash: hash,
  originalSpecHash: hash, engineeringStateHash: hash, failedTraceHash: hash,
  authorizationRef: z.string().trim().min(1), authorizedAt: z.string().datetime(),
  // Explicit host decision: the lost provider transcript is NOT reconstructed.
  mode: z.literal("reread-immutable-evidence-with-remaining-budget"),
  retainedEngineeringFiles: z.record(z.string().min(1), hash),
}).strict();
export const identityContextRecoverySchema = z.discriminatedUnion("version", [legacyIdentityContextRecoverySchema,
  legacyIdentityContextRecoverySchema.extend({ version: z.literal(2),
    // Explicit, immutable imports of EVERY intervening engineering attempt.
    // Labels only assert the archived producer's budgetLineage. The host derives
    // charges from its scoped predecessor chain, never from this declaration.
    engineeringHistory: z.array(z.object({ directory: z.string().min(1), stateFile: z.string().min(1),
      files: z.record(z.string().min(1), hash), accounting: z.enum(["local", "cumulative"]) }).strict()),
  }).strict()]);
export type IdentityContextRecovery = z.infer<typeof identityContextRecoverySchema>;

/** The old in-memory transcript cannot be recovered from redacted trace views.
 * A later explicit host authorization permits ONE changed read-only invocation
 * of the SAME stage/shard, with all original charges and fresh evidence gates.
 * This never authorizes a semantic correction, another grant, or parent resume. */
export async function inspectIdentityContextRecovery(root: string, p: PreparedIdentityRequirements,
  raw: IdentityContextRecovery, options: { consumed?: boolean; historyOnly?: boolean } = {}) {
  const parsed = identityContextRecoverySchema.safeParse(raw);
  if (!parsed.success) throw prerequisiteStop("Unsupported recovery proof. Preserve the original authority, stop and charges; inspect requirements inspect-identity-repairs for the same source/task. An unsupported or retired recovery format is inspection-only, not a reason to rewrite its version, redispatch or renew a grant");
  const proof = parsed.data, intent = p.intent;
  const directory = identityRequirementDirectory(root, intent.sourceId, intent.taskId);
  const engineering = path.join(directory, "consumer-review", "engineering");
  const recoveryDirectory = identityContextRecoveryDirectory(root, intent.sourceId, intent.taskId);
  const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
  const spec = prerequisiteLoopSpecSchema.parse(await read(path.join(engineering, "spec.json")));
  if (proof.taskId !== intent.taskId || proof.sourceId !== intent.sourceId || proof.intentHash !== contentHash(intent)
    || proof.originalSpecHash !== digest(spec) || spec.root !== root || spec.taskId !== intent.taskId
    || spec.sourceId !== intent.sourceId) throw prerequisiteStop("Context recovery must bind the original task, source and supervisor spec");
  verifyPrerequisiteHandoff(spec);
  const stopped = await read(path.join(engineering, "state.json"));
  if (digest(stopped) !== proof.engineeringStateHash || stopped.phase !== "BREAK" || stopped.childPid !== null
    || stopped.workerDispatches !== 0 || Date.parse(proof.authorizedAt) <= Date.parse(stopped.updatedAt))
    throw prerequisiteStop("Context reconstruction requires a later explicit host authorization and the exact settled engineering stop");
  const files = Object.fromEntries(Object.entries(captureRecordTree(engineering)).filter(([name]) => !name.startsWith("host-recovery/")));
  if (contentHash(files) !== contentHash(proof.retainedEngineeringFiles))
    throw prerequisiteStop("Original engineering history changed or was omitted; do not repin or retry");
  const owner = await read(path.join(engineering, "start.json"));
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw prerequisiteStop("Original engineering owner is unknown; verify on the owning host before recovery");
  try { process.kill(owner.pid, 0); throw prerequisiteStop("Original engineering owner is still alive"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
  const request = await read(spec.workerRequestFile);
  const budget = await read(path.join(directory, "identity-consumers-0.budget.json"));
  const originalInput = await read(path.join(directory, "identity-consumers-0.input.json"));
  const trace = new TraceStore(root), run = await trace.peekRun(request.failedTraceRunId);
  const events = await trace.peekEvents(run.id);
  if (contentHash({ run, events }) !== proof.failedTraceHash || run.status !== "failed" || !run.endedAt
    || run.sourceId !== intent.sourceId || run.operationId !== `identity-requirements-${intent.taskId}-identity-consumers-0`
    || run.counts.retries || budget.state.failure?.code !== "request-size")
    throw prerequisiteStop("Context recovery requires the exact settled read-only request-size failure");
  const requests = events.filter(e => e.type === "llm.request.started");
  const payloads = events.filter(e => e.type === "llm.request.payload");
  const failures = events.filter(e => e.type === "llm.response.failed");
  // Pi records the locally refused sixth step as a failed response even though
  // beginCall rejected it before transport. That exact zero-usage refusal is
  // not an uncertain paid call, and must remain visible in the original trace.
  const localRefusal = failures.length === 1 && failures.every(e =>
    e.callId && !requests.some(r => r.callId === e.callId) && !payloads.some(r => r.callId === e.callId)
    && e.data?.errorMessage === budget.state.failure.message
    && e.data?.providerId === "openai-codex" && e.data?.modelId === "gpt-6.1-sol"
    && e.seq > Math.max(...events.filter(r => r.type === "llm.response.completed").map(r => r.seq))
    && e.data?.usage && Object.values(e.data.usage as Record<string, unknown>).length > 0
    && Object.values(e.data.usage as Record<string, unknown>).every(value => value === 0));
  if (!identityRequestUsageMatches(budget.state.usage, payloads.map(e => e.blobRef?.byteLength ?? -1), requests.length)
    || requests.some(e => e.data?.providerId !== "openai-codex" || e.data?.modelId !== "gpt-6.1-sol"
      || !e.callId || events.filter(end => end.type === "llm.response.completed" && end.callId === e.callId && end.seq > e.seq).length !== 1)
    || (failures.length > 0 && !localRefusal)
    || events.some(e => e.type === "tool.call.failed" || e.type.startsWith("world.commit.")
      || (e.type === "tool.call.started" && !["read_identity_source", "read_identity_dependencies"].includes(String(e.data?.toolName)))))
    throw prerequisiteStop("Unsettled calls, tool failures, semantic submission or writes forbid context reconstruction");
  for (const start of events.filter(e => e.type === "tool.call.started")) {
    if (!start.toolCallId || events.filter(end => end.type === "tool.call.completed" && end.toolCallId === start.toolCallId
      && end.seq > start.seq && end.data?.isError !== true).length !== 1) throw prerequisiteStop("Original read tool has no settled successful receipt");
  }
  const records = await Promise.all(["identity-definition", "identity-definition-check"].map(async stage =>
    identityRecordSchema.parse(await read(path.join(directory, `${stage}.record.json`)))));
  const registered = await new RequirementLedger(root, intent.sourceId).identityRequirements(intent.taskId);
  if (contentHash(registered.slice(0, 2)) !== contentHash(records) || (!options.historyOnly && registered.length !== 2)
    || !identityConsumersReviewable(records)) throw prerequisiteStop("Original independent definitions changed or a consumer stage was already registered");
  for (const [i, record] of records.entries()) await verifyIdentityRecord(root, record, records.slice(0, i), p);
  const { identityStageInput } = await import("../workflow/identity-requirements.js");
  if (contentHash(originalInput) !== contentHash(identityStageInput(p, "identity-consumers", records, 0))
    || contentHash(await read(path.join(directory, "inventory.json"))) !== intent.inventoryHash)
    throw prerequisiteStop("Original source, consumer partition or immutable stage input changed");
  for (const { stage } of identityStages(intent).slice(2)) {
    for (const suffix of stage === "identity-consumers-0" ? ["proposal", "record"] : ["invocation", "proposal", "record", "budget"]) {
      try { await fs.stat(path.join(directory, `${stage}.${suffix}.json`)); throw prerequisiteStop("Another consumer stage was consumed or its writes are uncertain"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
  }
  if (!options.consumed && !options.historyOnly) {
    try { await fs.stat(path.join(recoveryDirectory, "start.json")); throw prerequisiteStop("Context recovery already consumed; inspect its exact session receipt, never restart or rename it"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  const index = await trace.peekRuns({ status: "running", limit: 100 });
  if (!options.historyOnly && index.length) throw prerequisiteStop("A model trace is unsettled; do not dispatch another recovery");
  if (!options.historyOnly) {
    // A paid/settled invocation without a proposal file is still consumed.
    // Do not let an incomplete artifact publication create another attempt.
    const all = JSON.parse(await fs.readFile(trace.indexPath, "utf8")) as { runs: { id: string }[] };
    const remaining = new Set(identityStages(intent).slice(2).map(s => `identity-requirements-${intent.taskId}-${s.stage}`));
    for (const item of all.runs) {
      const seen = await trace.peekRun(item.id);
      if (seen.id !== run.id && seen.sourceId === intent.sourceId && remaining.has(seen.operationId ?? ""))
        throw prerequisiteStop("Another consumer invocation already exists, even without output files; no redispatch");
    }
  }
  return { proof, directory: recoveryDirectory, records, budget,
    // The immutable failed state remains on disk. Only this authorized successor
    // starts usable, with exactly the charged old usage; limits are not changed.
    initial: { usage: { ...budget.state.usage }, blocked: false } as ModelRequestBudgetState,
    originalInputHash: contentHash(originalInput), originalSpec: spec, originalRequest: request };
}

export async function readIdentityContextRecovery(root: string, p: PreparedIdentityRequirements, expectedHash: string) {
  const file = path.join(identityContextRecoveryDirectory(root, p.intent.sourceId, p.intent.taskId), "authority.json");
  const proof = identityContextRecoverySchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  if (contentHash(proof) !== expectedHash) throw prerequisiteStop("Context recovery authority changed");
  return inspectIdentityContextRecovery(root, p, proof, { historyOnly: true });
}

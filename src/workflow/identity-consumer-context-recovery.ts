import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { digest } from "../runtime/compile-loop/workspace.js";
import { captureRecordTree } from "../runtime/compile-loop/dedicated-session.js";
import { prerequisiteLoopSpecSchema } from "../runtime/compile-loop/prerequisite-supervisor.js";
import { prepareIdentityRequirements } from "../compiler/identity-requirement-service.js";
import { identityContextRecoverySchema, inspectIdentityContextRecovery, type IdentityContextRecovery } from "../compiler/identity-context-recovery.js";
import { identityContextRecoveryDirectory, identityRequirementDirectory, identityRequirementsReady } from "../compiler/identity-requirements.js";
import { verifyIdentityRecord } from "../compiler/identity-requirement-trace.js";
import { RequirementLedger } from "../compiler/requirement-ledger.js";
import { prerequisiteStop } from "../compiler/role-source-prerequisites.js";
import { TraceStore } from "../trace/store.js";
import { runIdentityRequirements } from "./identity-requirements.js";
import { withIdentityRecoveryHost, inheritedIdentityEngineering } from "../runtime/compile-loop/identity-recovery-host.js";
import { withCompilerSignals } from "../util/compiler-signals.js";

const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
async function original(root: string, sourceId: string, taskId: string) {
  const directory = identityRequirementDirectory(root, sourceId, taskId);
  const engineering = path.join(directory, "consumer-review", "engineering");
  const spec = prerequisiteLoopSpecSchema.parse(await read(path.join(engineering, "spec.json")));
  const request = await read(spec.workerRequestFile);
  if (spec.root !== root || spec.sourceId !== sourceId || spec.taskId !== taskId) throw prerequisiteStop("Use the exact original source/task on its owning host");
  const prepared = await prepareIdentityRequirements(root, request.input, request.authorizationRef, request.priorUsage);
  return { directory, engineering, spec, request, prepared };
}

/** Read-only construction. Authorization text comes from the host's explicit
 * later user request, never a model verdict or an old reusable repair grant. */
export async function prepareIdentityContextRecovery(root: string, sourceId: string, taskId: string, authorizationRef: string,
  engineeringHistory: Extract<IdentityContextRecovery, { version: 2 }>["engineeringHistory"]) {
  const { engineering, spec, request, prepared } = await original(root, sourceId, taskId);
  const traces = new TraceStore(root);
  const proof = identityContextRecoverySchema.parse({
    version: 2, policy: "identity-context-reconstruction/v1", sourceId, taskId, intentHash: contentHash(prepared.intent), engineeringHistory,
    originalSpecHash: digest(spec), engineeringStateHash: digest(await read(path.join(engineering, "state.json"))),
    failedTraceHash: contentHash({ run: await traces.peekRun(request.failedTraceRunId), events: await traces.peekEvents(request.failedTraceRunId) }),
    authorizationRef, authorizedAt: new Date().toISOString(), mode: "reread-immutable-evidence-with-remaining-budget",
    retainedEngineeringFiles: Object.fromEntries(Object.entries(captureRecordTree(engineering)).filter(([name]) => !name.startsWith("host-recovery/"))),
  });
  await inspectIdentityContextRecovery(root, prepared, proof);
  inheritedIdentityEngineering(proof, engineering);
  return proof;
}

export async function identityConsumerContextRecovery(root: string, mode: "inspect" | "run" | "verify",
  raw: IdentityContextRecovery): Promise<{ ready: true; taskId: string; originalIncidentHash: string } | { verified: true; taskId: string; originalIncidentHash: string }> {
  const parsed = identityContextRecoverySchema.safeParse(raw);
  if (!parsed.success) throw prerequisiteStop("The stopped supervisor request is immutable and is not a recovery proof. Prepare a v2 proof bound to that request and all engineering receipts, then use this repository adapter; do not overwrite the old request or launch a temporary worker");
  const proof = parsed.data;
  const { prepared, request, spec } = await original(root, proof.sourceId, proof.taskId);
  const inspected = await inspectIdentityContextRecovery(root, prepared, proof, { historyOnly: mode === "verify" });
  if (mode === "inspect") {
    const usage = inheritedIdentityEngineering(proof, spec.directory);
    if (Date.now() >= spec.deadline || usage.commands + 4 > 24 || usage.engineeringTurns >= 2)
      throw prerequisiteStop("Original recovery deadline or engineering budget exhausted; preserve the stop, no reset or retry");
    return { ready: true as const, taskId: proof.taskId, originalIncidentHash: spec.incidentHash };
  }
  if (mode === "run") {
    await withCompilerSignals(signal => withIdentityRecoveryHost(root, prepared, proof, async permit => {
      await runIdentityRequirements({ root, input: request.input, authorizationRef: request.authorizationRef,
        priorUsage: request.priorUsage, expectedIntentHash: request.expectedIntentHash, recoverContext: proof, recoveryPermit: permit,
        assertOriginal: async () => { await inspectIdentityContextRecovery(root, prepared, proof, { historyOnly: true }); } });
    }, { signal }));
    return identityConsumerContextRecovery(root, "verify", proof);
  }
  const directory = identityContextRecoveryDirectory(root, proof.sourceId, proof.taskId);
  const state = await read(path.join(directory, "state.json"));
  const records = await new RequirementLedger(root, proof.sourceId).identityRequirements(proof.taskId);
  if (state.phase !== "DONE" || state.childPid !== null || state.contextRecoveryHash !== contentHash(proof)
    || !identityRequirementsReady(records)) throw prerequisiteStop("Recovery has no complete independent receipts; preserve its exact stop and persisted session, no redispatch");
  for (const [i, record] of records.entries()) {
    await verifyIdentityRecord(root, record, records.slice(0, i), prepared);
    if (i < inspected.records.length) continue;
    if (record.contextRecoveryHash !== contentHash(proof)) throw prerequisiteStop("Recovery record lost its exact original lineage");
  }
  return { verified: true as const, taskId: proof.taskId, originalIncidentHash: spec.incidentHash };
}

// Fixed successor to the settled supervisor. Its old request remains pinned;
// prepare creates a separate explicit proof. run owns mandatory repository gates.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, input, output] = process.argv.slice(2);
  if (!["prepare", "inspect", "run", "verify"].includes(mode ?? "") || !input || !output) throw new Error("Usage: prepare|inspect|run|verify REQUEST_JSON OUTPUT_JSON");
  const request = await read(input);
  const authorization = mode === "prepare" ? z.object({ sourceId: z.string().min(1), taskId: z.string().regex(/^[a-f0-9]{64}$/),
    authorizationRef: z.string().trim().min(1), engineeringHistory: identityContextRecoverySchema.options[1].shape.engineeringHistory }).strict().parse(request) : undefined;
  const result = authorization ? await prepareIdentityContextRecovery(process.cwd(), authorization.sourceId, authorization.taskId, authorization.authorizationRef, authorization.engineeringHistory)
    : await identityConsumerContextRecovery(process.cwd(), mode as "inspect" | "run" | "verify", request);
  await fs.writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

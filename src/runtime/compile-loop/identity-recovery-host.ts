import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { contentHash } from "../../world/canonical.js";
import { identityContextRecoveryDirectory, identityRequirementsReady, type IdentityRecord } from "../../compiler/identity-requirements.js";
import { RequirementLedger } from "../../compiler/requirement-ledger.js";
import { inspectIdentityContextRecovery, type IdentityContextRecovery } from "../../compiler/identity-context-recovery.js";
import type { PreparedIdentityRequirements } from "../../compiler/identity-requirement-service.js";
import { prerequisiteStop } from "../../compiler/role-source-prerequisites.js";
import { captureWorkspace, fixedTests } from "./workspace.js";
import { captureRecordTree, dedicatedSessionArgs, fileHash } from "./dedicated-session.js";
import { read, save, reviewVerdict } from "./state.js";
import { runLoopChild, type ChildOutcome } from "./process.js";
import { identityEngineeringHistory, identityEngineeringLineage, inheritedIdentityEngineering } from "./identity-engineering-accounting.js";
export { inheritedIdentityEngineering } from "./identity-engineering-accounting.js";

const once = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const success = (r: ChildOutcome) => r.code === 0 && !r.signal && !r.error && !r.cancelled && !r.timedOut;
export const identityRecoveryTests = Object.freeze([...fixedTests, "test/prerequisite-supervisor.test.ts", "test/identity-requirements.test.ts",
  "test/identity-session-persistence.test.ts", "test/identity-recovery-host.test.ts", "test/identity-real-chain.test.ts", "test/lossless-json-context.test.ts",
  "test/identity-recovery-integrity.test.ts", "test/identity-engineering-accounting.test.ts", "test/identity-repair-handoff.test.ts"]);

const permits = new WeakMap<object, { root: string; proofHash: string; gateHash: string; assert: () => Promise<void>; signal: AbortSignal; deadline: number }>();
/** Not constructible by a CLI request or a caller-supplied no-op callback. */
export type IdentityRecoveryPermit = { readonly kind: "identity-recovery-host" };
export async function assertIdentityRecoveryPermit(permit: IdentityRecoveryPermit | undefined, root: string, proof: IdentityContextRecovery) {
  const authority = permit && permits.get(permit);
  if (!authority || authority.root !== root || authority.proofHash !== contentHash(proof))
    throw prerequisiteStop("Context recovery needs the repository host gate; invoke the fixed adapter with its v2 proof, never call the worker directly or retry a consumed host");
  await authority.assert();
  return { signal: authority.signal, deadline: authority.deadline, gateHash: authority.gateHash };
}

/** The only recovery launcher. The old supervisor is settled and immutable;
 * this fixed successor owns its original locks, deadline and remaining command
 * budget. A failed check consumes this host claim too. No /tmp launcher, caller
 * approval callback or model verdict can manufacture a worker permit. */
export async function withIdentityRecoveryHost<T>(root: string, prepared: PreparedIdentityRequirements, raw: IdentityContextRecovery,
  run: (permit: IdentityRecoveryPermit) => Promise<T>, options: { signal: AbortSignal; runner?: typeof runLoopChild }) {
  const inspected = await inspectIdentityContextRecovery(root, prepared, raw), proof = inspected.proof;
  const spec = inspected.originalSpec, engineering = spec.directory;
  const history = identityEngineeringHistory(proof, engineering), inherited = history.usage;
  const directory = path.join(identityContextRecoveryDirectory(root, proof.sourceId, proof.taskId), "host");
  const runner = options.runner ?? runLoopChild, files = captureWorkspace(root), sourceHash = contentHash(files), token = randomUUID();
  const registryHash = fileHash(spec.registryFile);
  const assertTime = () => { options.signal.throwIfAborted(); if (Date.now() >= spec.deadline)
    throw prerequisiteStop("Original engineering deadline expired; retain the stop, never renew a deadline or dispatch another worker"); };
  assertTime();
  // One review + type check + regression command + one worker. No new source
  // repair turn is silently minted by this transport-only successor.
  if (inherited.commands + 4 > 24 || inherited.engineeringTurns >= 2)
    throw prerequisiteStop("Original engineering budget has no room for all mandatory gates and one worker; no partial gates or budget reset");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { once(path.join(directory, "start.json"), { token, pid: process.pid, proofHash: contentHash(proof), sourceHash, inherited, deadline: spec.deadline }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw prerequisiteStop("Repository recovery host already consumed; inspect its state and receipts, never restart or rename it"); throw e; }
  const acquired: string[] = [];
  const state = { version: 1, phase: "GATES", childPid: null as number | null, workerDispatches: 0,
    commands: inherited.commands, engineeringTurns: inherited.engineeringTurns + 1, inherited,
    deadline: spec.deadline, sourceHash, proofHash: contentHash(proof), reason: "", updatedAt: "",
    budgetLineage: identityEngineeringLineage(proof, history.head, inherited, { commands: inherited.commands, engineeringTurns: inherited.engineeringTurns + 1 }),
    completionHash: null as string | null };
  const publish = () => { state.updatedAt = new Date().toISOString(); state.budgetLineage = identityEngineeringLineage(proof, history.head, inherited, state);
    save(path.join(directory, "state.json"), state); };
  let permit: IdentityRecoveryPermit | undefined;
  const assert = async () => {
    assertTime();
    if (contentHash(captureWorkspace(root)) !== sourceHash) throw prerequisiteStop("Reviewed source/tests changed; retain the host stop, no worker dispatch");
    if (fileHash(spec.registryFile) !== registryHash) throw prerequisiteStop("Original engineering registry changed; preserve its owner, no retry");
    if (contentHash(read(path.join(directory, "state.json"))) !== contentHash(state)) throw prerequisiteStop("Recovery host state changed outside its owner");
    for (const lock of acquired) if (read<{ token: string; pid: number }>(lock).token !== token || read<{ pid: number }>(lock).pid !== process.pid)
      throw prerequisiteStop("Recovery ownership changed; do not retry");
    await inspectIdentityContextRecovery(root, prepared, proof, { historyOnly: true });
    inheritedIdentityEngineering(proof, engineering);
  };
  const command = async (label: string, commandName: string, args: string[], stdin?: string, onLine?: (line: string) => void) => {
    await assert();
    if (state.commands >= 24) throw prerequisiteStop("Original engineering command budget exhausted; no retry");
    state.commands++; publish();
    const prefix = path.join(directory, `${state.commands}-${label}`), sandbox = prefix + ".sandbox";
    if (commandName === process.execPath) fs.mkdirSync(sandbox);
    const sealed = captureRecordTree(directory);
    const outcome = await runner({ command: commandName, args, cwd: root, prefix, signal: options.signal,
      timeoutMs: Math.min(commandName === "codex" ? 90 * 60_000 : 5 * 60_000, spec.deadline - Date.now()), stdin, onLine,
      onSpawn(pid) { state.childPid = pid; publish(); sealed["state.json"] = fileHash(path.join(directory, "state.json")); },
      ...(commandName === "codex" ? { codexFilePolicy: "read-only" as const,
        immutablePaths: [engineering, ...spec.ownershipLocks, ...Object.keys(spec.retainedFiles),
          ...(proof.version === 2 ? proof.engineeringHistory.map(r => r.directory) : [])] } : { readOnlyRootDirectory: sandbox }),
    });
    for (const [name, hash] of Object.entries(sealed)) if (fileHash(path.join(directory, name)) !== hash)
      throw prerequisiteStop("Host child changed retained gate evidence; no worker dispatch");
    state.childPid = null; publish();
    once(prefix + ".result.json", { label, command: commandName, args, sourceHash, outcome });
    await assert();
    if (!success(outcome)) throw prerequisiteStop(`Recovery ${label} failed; preserve its logs and charged command, no worker dispatch or retry`);
  };
  try {
    for (const lock of spec.ownershipLocks) { fs.mkdirSync(path.dirname(lock), { recursive: true }); once(lock, { token, pid: process.pid, taskId: spec.taskId }); acquired.push(lock); }
    once(path.join(directory, "proof.json"), proof); once(path.join(directory, "source.json"), files); publish();
    const reviewFile = path.join(directory, "review.json"), schemaFile = path.join(directory, "review.schema.json");
    once(schemaFile, z.toJSONSchema(reviewVerdict));
    let reviewer: string | undefined;
    await command("review", "codex", dedicatedSessionArgs({ workspace: root, sourceId: spec.sourceId, model: spec.engineerModel, effort: "max" },
      null, Date.now(), schemaFile, reviewFile, true),
    `Independently review the current identity recovery implementation and tests. Read AGENTS.md and docs/agent-tool-recovery.md. Do not edit files or dispatch models/workers/other agents. Check lossless complete evidence, original budgets and deadline, mandatory host gates, sealed raw sessions before registration, and real-chain regressions. No semantic novel judgments. Return the strict verdict. Source fingerprint: ${sourceHash}. Original incident: ${spec.incidentFile}.`, line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.type === "thread.started") { const id = z.string().uuid().parse(event.thread_id); if (reviewer && reviewer !== id) throw prerequisiteStop("Reviewer identity changed"); reviewer = id; }
    });
    const verdict = reviewVerdict.parse(read(reviewFile));
    const originalState = read<{ engineerThreadId?: string }>(path.join(engineering, "state.json"));
    if (!reviewer || reviewer === originalState.engineerThreadId || !verdict.addressesFailure || !verdict.architecturePreserved || !verdict.checksPreserved)
      throw prerequisiteStop("Independent source review rejected recovery; preserve the review, no worker dispatch");
    await command("types", process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit"]);
    await command("tests", process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--no-cache", "--configLoader", "runner", ...identityRecoveryTests]);
    const gate = { version: 1, proofHash: contentHash(proof), sourceHash, deadline: spec.deadline, inherited,
      commands: state.commands, engineeringTurns: state.engineeringTurns, reviewer,
      receipts: Object.fromEntries(Object.entries(captureRecordTree(directory)).filter(([name]) => name !== "state.json")) };
    once(path.join(directory, "gate.json"), gate);
    state.commands++; state.workerDispatches = 1; state.phase = "WORKER"; state.childPid = process.pid; publish();
    const checked = async () => {
      await assert();
      if (contentHash(read(path.join(directory, "gate.json"))) !== contentHash(gate) || state.phase !== "WORKER" || state.workerDispatches !== 1 || state.childPid !== process.pid)
        throw prerequisiteStop("Recovery gate or single-use dispatch changed; no retry");
      for (const [file, hash] of Object.entries(gate.receipts)) if (fileHash(path.join(directory, file)) !== hash)
        throw prerequisiteStop("Recovery review/test receipt changed; no retry");
    };
    permit = Object.freeze({ kind: "identity-recovery-host" as const });
    const deadlineSignal = AbortSignal.timeout(Math.min(2 ** 32 - 1, Math.max(1, spec.deadline - Date.now())));
    permits.set(permit, { root, proofHash: contentHash(proof), gateHash: contentHash(gate), assert: checked,
      signal: AbortSignal.any([options.signal, deadlineSignal]), deadline: spec.deadline });
    await checked();
    const result = await run(permit);
    // A returned callback is not completion. Verify the entire durable worker
    // history while this host still owns its live permit, then publish a final
    // receipt. Public readers never accept a live/incomplete WORKER as authority.
    const workerDirectory = identityContextRecoveryDirectory(root, proof.sourceId, proof.taskId);
    const workerState = read<{ phase: string; childPid: number | null; contextRecoveryHash: string }>(path.join(workerDirectory, "state.json"));
    const records = await new RequirementLedger(root, proof.sourceId).identityRequirements(proof.taskId);
    if (workerState.phase !== "DONE" || workerState.childPid !== null || workerState.contextRecoveryHash !== contentHash(proof)
      || !identityRequirementsReady(records) || contentHash(records.slice(0, inspected.records.length)) !== contentHash(inspected.records))
      throw prerequisiteStop("Recovery worker has no complete independent history; retain the consumed host and all records, no final authority or retry");
    const { verifyIdentityRecord } = await import("../../compiler/identity-requirement-trace.js");
    for (const [i, record] of records.entries()) {
      if (i >= inspected.records.length && (record.contextRecoveryHash !== contentHash(proof) || record.contextRecoveryGateHash !== contentHash(gate)))
        throw prerequisiteStop("Recovery worker records lost their exact host lineage; preserve evidence, no retry");
      await verifyIdentityRecord(root, record, records.slice(0, i), prepared, permit);
    }
    await checked();
    if (contentHash(read(path.join(workerDirectory, "state.json"))) !== contentHash(workerState))
      throw prerequisiteStop("Recovery worker state changed during final acceptance; no authority or retry");
    const completion = { version: 1, gateHash: contentHash(gate), proofHash: contentHash(proof), workerStateHash: contentHash(workerState),
      recordHashes: records.map(contentHash), completedAt: new Date().toISOString() };
    once(path.join(directory, "completion.json"), completion);
    assertTime();
    state.phase = "DONE"; state.childPid = null; state.completionHash = contentHash(completion); state.updatedAt = completion.completedAt;
    save(path.join(directory, "state.json"), state); return result;
  } catch (error) { state.phase = "BREAK"; state.childPid = null; state.reason = String(error); publish(); throw error; }
  finally {
    if (permit) permits.delete(permit);
    for (const lock of acquired.reverse()) if (read<{ token: string }>(lock).token === token) fs.unlinkSync(lock);
  }
}

export async function verifyIdentityRecoveryHostReceipt(root: string, proof: IdentityContextRecovery, expectedHash: string | undefined,
  record: IdentityRecord, permit?: IdentityRecoveryPermit) {
  if (permit) {
    const authority = await assertIdentityRecoveryPermit(permit, root, proof);
    if (authority.gateHash !== expectedHash) throw prerequisiteStop("Identity provisional registration belongs to another host gate; no retry");
    return;
  }
  const workerDirectory = identityContextRecoveryDirectory(root, proof.sourceId, proof.taskId), directory = path.join(workerDirectory, "host");
  const gate = read<{ version: number; proofHash: string; sourceHash: string; receipts: Record<string, string>; deadline: number; commands: number;
    inherited: { commands: number; engineeringTurns: number }; engineeringTurns: number }>(path.join(directory, "gate.json"));
  const state = read<{ version: number; phase: string; childPid: number | null; workerDispatches: number; commands: number; engineeringTurns: number;
    updatedAt: string; proofHash: string; sourceHash: string; deadline: number; completionHash: string; budgetLineage: unknown }>(path.join(directory, "state.json"));
  const history = identityEngineeringHistory(proof, path.dirname(workerDirectory));
  const originalDeadline = read<{ deadline: number }>(path.join(path.dirname(workerDirectory), "spec.json")).deadline;
  if (!expectedHash || gate.version !== 1 || state.version !== 1 || !Number.isSafeInteger(gate.deadline) || gate.deadline <= 0
    || contentHash(gate) !== expectedHash || gate.proofHash !== contentHash(proof)
    || contentHash(read(path.join(directory, "source.json"))) !== gate.sourceHash || state.phase !== "DONE" || state.childPid !== null
    || state.proofHash !== gate.proofHash || state.sourceHash !== gate.sourceHash || state.deadline !== gate.deadline
    || contentHash(gate.inherited) !== contentHash(history.usage) || gate.commands !== history.usage.commands + 3
    || gate.engineeringTurns !== history.usage.engineeringTurns + 1 || state.engineeringTurns !== gate.engineeringTurns || state.engineeringTurns > 2
    || contentHash(state.budgetLineage) !== contentHash(identityEngineeringLineage(proof, history.head, history.usage, state))
    || state.workerDispatches !== 1 || state.commands !== gate.commands + 1 || state.commands > 24 || gate.deadline !== originalDeadline
    || !Number.isFinite(Date.parse(state.updatedAt)) || Date.parse(state.updatedAt) > gate.deadline)
    throw prerequisiteStop("Identity record has no completed repository recovery host; WORKER needs its live in-process permit for registration only, never public authority or retry");
  for (const [file, hash] of Object.entries(gate.receipts)) {
    if (path.isAbsolute(file) || file.split(path.sep).includes("..") || fileHash(path.join(directory, file)) !== hash)
      throw prerequisiteStop("Identity recovery gate receipt changed");
  }
  const completion = read<{ version: number; gateHash: string; proofHash: string; completedAt: string; recordHashes: string[]; workerStateHash: string }>(path.join(directory, "completion.json"));
  const records = await new RequirementLedger(root, proof.sourceId).identityRequirements(proof.taskId);
  if (completion.version !== 1 || contentHash(completion) !== state.completionHash || completion.gateHash !== expectedHash
    || completion.proofHash !== contentHash(proof) || completion.completedAt !== state.updatedAt
    || contentHash(completion.recordHashes) !== contentHash(records.map(contentHash)) || !completion.recordHashes.includes(contentHash(record))
    || !identityRequirementsReady(records) || completion.workerStateHash !== contentHash(read(path.join(workerDirectory, "state.json"))))
    throw prerequisiteStop("Identity final host receipt lost its complete worker history; preserve evidence, no authority or retry");
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { contentHash } from "../world/canonical.js";
import { WorldContextStore } from "../world/context.js";
import { WorldEngine, type WorldModelContext } from "../world/engine.js";
import { deriveCharacterEntrySeed, type CharacterEntrySeed } from "../world/entry-context.js";
import { buildActorScopedActionContext } from "../world/player-action.js";
import { WorldRuntime } from "../world/runtime.js";
import { fsckWorld } from "../world/fsck.js";
import { idSchema, validationIssueSchema } from "../world/model.js";
import { majorRoleCandidates, validateRoleRoster, type RoleRoster } from "./role-roster.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";
import { entryDriverWitnessSchema, probeEntryDriver } from "./entry-driver-probe.js";
import { entryActionWitnessSchema, probeEntryAction } from "./entry-action-probe.js";
import { ENTRY_CONTRACT_VERSION } from "../world/entry-contract.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const rolePlayabilitySchema = z.object({
  candidateId: idSchema, name: z.string(), actorId: idSchema.optional(),
  status: z.enum(["ready", "blocked"]), entryCutHash: hashSchema.optional(),
  entryViewHash: hashSchema.optional(),
  driverWitness: entryDriverWitnessSchema.optional(),
  actionWitness: entryActionWitnessSchema.optional(),
  probes: z.array(z.object({ kind: z.enum(["genesis", "decision", "driver", "intent", "wait", "resume", "fork"]), passed: z.boolean() }).strict()),
  issues: z.array(validationIssueSchema),
}).strict();
export type RolePlayability = z.infer<typeof rolePlayabilitySchema>;

export const playabilityManifestSchema = z.object({
  version: z.literal(1), subjectSnapshotHash: hashSchema, rosterHash: hashSchema,
  contractVersion: z.string().optional(),
  roles: z.array(rolePlayabilitySchema), majorTotal: z.number().int().nonnegative(), readyTotal: z.number().int().nonnegative(),
  issues: z.array(validationIssueSchema),
}).strict();
export type PlayabilityManifest = z.infer<typeof playabilityManifestSchema>;

/** Internal candidate evaluation uses the production engine, never a public certificate bypass. */
export async function probeMajorRoleEntries(bundle: PreparedNovelBundle, roster: RoleRoster, subjectSnapshotHash: string): Promise<PlayabilityManifest> {
  const issues = validateRoleRoster(roster), roles: RolePlayability[] = [];
  const candidates = majorRoleCandidates(roster);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-entry-evaluation-"));
  const stateDirectory = workspaceStateDir(scratch);
  try {
    const context = await new WorldContextStore(scratch).capturePrepared(bundle.source.id, subjectSnapshotHash, bundle.canonical);
    const engine = new WorldEngine(scratch, context), runtime = new WorldRuntime(engine, async () => []);
    for (const candidate of candidates) {
      const role: RolePlayability = { candidateId: candidate.id, name: candidate.name, ...(candidate.entityId ? { actorId: candidate.entityId } : {}), status: "blocked", probes: [], issues: [] };
      roles.push(role);
      if (!candidate.entityId) {
        role.issues.push({ code: "MAJOR_ROLE_ENTRY_BLOCKED", message: "Major character has no resolved identity" });
        continue;
      }
      const actorId = candidate.entityId;
      let seed: CharacterEntrySeed;
      try { seed = deriveCharacterEntrySeed(bundle, actorId); }
      catch (error) {
        role.issues.push({ code: "MAJOR_ROLE_ENTRY_BLOCKED", message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const result = await probeEntry({ engine, runtime, context, scratch, bundle, subjectSnapshotHash, actorId, seed, branchId: `probe-${candidate.id}`, name: candidate.name });
      Object.assign(role, {
        status: result.status, entryCutHash: result.entryCutHash, probes: result.probes, issues: result.issues,
        ...(result.entryViewHash ? { entryViewHash: result.entryViewHash } : {}),
        ...(result.driverWitness ? { driverWitness: result.driverWitness } : {}),
        ...(result.actionWitness ? { actionWitness: result.actionWitness } : {}),
      });
    }
    const integrity = await fsckWorld(engine);
    if (!integrity.ok) issues.push(...integrity.issues.filter((x) => x.severity === "error").map((x) => ({ code: x.code, message: x.message })));
  } catch (error) {
    issues.push({ code: "ENTRY_EVALUATION_CONTEXT_INVALID", message: error instanceof Error ? error.message : String(error) });
    for (const candidate of candidates) if (!roles.some((x) => x.candidateId === candidate.id)) roles.push({ candidateId: candidate.id, name: candidate.name, ...(candidate.entityId ? { actorId: candidate.entityId } : {}), status: "blocked", probes: [], issues: [{ code: "ENTRY_EVALUATION_CONTEXT_INVALID", message: "Frozen executable context could not be constructed" }] });
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
    await fs.rm(scratch, { recursive: true, force: true });
  }
  return playabilityManifestSchema.parse({ version: 1, contractVersion: ENTRY_CONTRACT_VERSION, subjectSnapshotHash, rosterHash: contentHash(roster), roles,
    majorTotal: candidates.length, readyTotal: roles.filter((role) => role.status === "ready").length, issues });
}

export type EntryProbeResult = {
  status: "ready" | "blocked";
  entryCutHash: string;
  entryViewHash?: string;
  driverWitness?: RolePlayability["driverWitness"];
  actionWitness?: RolePlayability["actionWitness"];
  probes: RolePlayability["probes"];
  issues: RolePlayability["issues"];
};

export type EntryProbeInput = {
  engine: WorldEngine;
  runtime: WorldRuntime;
  context: WorldModelContext;
  scratch: string;
  bundle: PreparedNovelBundle;
  subjectSnapshotHash: string;
  actorId: string;
  seed: CharacterEntrySeed;
  branchId: string;
  name: string;
};

/**
 * The seven deterministic entry probes (genesis, decision, driver, intent,
 * wait, resume, fork) for one entry seed on the production engine. Reused by
 * whole-roster certification and per-cut admission.
 */
export async function probeEntry(input: EntryProbeInput): Promise<EntryProbeResult> {
  const { engine, runtime, context, scratch, bundle, subjectSnapshotHash, actorId, seed, branchId } = input;
  const result: EntryProbeResult = { status: "blocked", entryCutHash: seed.cut.hash, probes: [], issues: [] };
  try {
    if (!seed.projectionSeed) throw new Error("Entry requires a complete projectionSeed with explicit semantics, processes, norms and active rules, including empty channels");
    const head = await engine.createBranch(branchId, input.name, seed.delta, seed.knowledge, bundle.source.id, subjectSnapshotHash, seed.evidence,
      { ...(seed.storyTime ? { storyTime: seed.storyTime } : {}), elapsedDays: seed.projectionSeed.elapsedDays }, {
        entryActorId: actorId, projectionSeed: seed.projectionSeed, realizesCanonicalEventIds: seed.realizesCanonicalEventIds,
        ...(seed.participantPresence ? { participantPresence: seed.participantPresence } : {}), ...(seed.actorObservations ? { actorObservations: seed.actorObservations } : {}),
      });
    result.probes.push({ kind: "genesis", passed: true });
    const view = await buildActorScopedActionContext(engine, actorId, head, undefined, bundle.source.id);
    if (view.selfState["character.alive"] !== true) throw new Error("Entry actor life status must be explicitly alive at the chosen historical cut");
    result.entryViewHash = contentHash({ selfState: view.selfState, knowledge: view.knowledge, decision: view.decision, scene: view.scene });
    result.probes.push({ kind: "decision", passed: true });
    result.driverWitness = await probeEntryDriver(engine, scratch, { branchId, head, actorId,
      sourceId: bundle.source.id, subjectSnapshotHash, entryCutHash: seed.cut.hash });
    result.probes.push({ kind: "driver", passed: true });
    result.actionWitness = await probeEntryAction(engine, scratch, { branchId, head, actorId,
      sourceId: bundle.source.id, subjectSnapshotHash, entryCutHash: seed.cut.hash });
    result.probes.push({ kind: "intent", passed: true });
    const wait = await engine.commitProposal({ proposalId: `wait-${branchId}`, branchId, actorId, source: "player", expectedParentCommit: result.actionWitness.resultingHead,
      title: "One minute passes", action: { lane: "ad-hoc", actionKindId: "wait", description: "Wait one minute", footprint: { reads: [], writes: [], resources: [] } },
      participants: [actorId], proposedTime: result.actionWitness.event.logicalTime.storyTime ?? { kind: "unknown" }, preconditions: [], causalParents: [], evidence: [],
      proposedDelta: { version: 1, operations: [] }, timeAdvance: { amount: 1, unit: "minute" } });
    if (!wait.report.accepted) throw new Error(wait.report.errors.map((x) => `${x.code}: ${x.message}`).join("; "));
    result.probes.push({ kind: "wait", passed: true });
    const resumed = new WorldEngine(scratch, context);
    const beforeFork = await resumed.projections.project(wait.newHead);
    const fresh = await engine.projections.project(wait.newHead, { fresh: true, useCheckpoints: false });
    if (contentHash(beforeFork) !== contentHash(fresh)) throw new Error("Resume projection differs from uncached replay");
    result.probes.push({ kind: "resume", passed: true });
    await runtime.forkBranch(branchId, wait.newHead, `${branchId}-fork`, "Probe fork");
    if ((await resumed.branches.read(`${branchId}-fork`)).headCommitId !== wait.newHead) throw new Error("Fork did not preserve the exact validated cut");
    result.probes.push({ kind: "fork", passed: true });
    result.status = "ready";
  } catch (error) {
    result.issues.push({ code: "MAJOR_ROLE_ENTRY_BLOCKED", message: error instanceof Error ? error.message : String(error) });
  }
  return result;
}

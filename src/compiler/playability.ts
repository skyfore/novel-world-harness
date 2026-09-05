import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { contentHash } from "../world/canonical.js";
import { WorldContextStore } from "../world/context.js";
import { WorldEngine } from "../world/engine.js";
import { deriveCharacterEntrySeed } from "../world/entry-context.js";
import { buildActorScopedActionContext, playerActionToKnowledgeAwareAction } from "../world/player-action.js";
import { WorldRuntime } from "../world/runtime.js";
import { fsckWorld } from "../world/fsck.js";
import { idSchema, validationIssueSchema } from "../world/model.js";
import { majorRoleCandidates, validateRoleRoster, type RoleRoster } from "./role-roster.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const rolePlayabilitySchema = z.object({
  candidateId: idSchema, name: z.string(), actorId: idSchema.optional(),
  status: z.enum(["ready", "blocked"]), entryCutHash: hashSchema.optional(),
  entryViewHash: hashSchema.optional(),
  probes: z.array(z.object({ kind: z.enum(["genesis", "decision", "intent", "wait", "resume", "fork"]), passed: z.boolean() }).strict()),
  issues: z.array(validationIssueSchema),
}).strict();
export type RolePlayability = z.infer<typeof rolePlayabilitySchema>;

export const playabilityManifestSchema = z.object({
  version: z.literal(1), subjectSnapshotHash: hashSchema, rosterHash: hashSchema,
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
      try {
        if (!candidate.entityId) throw new Error("Major character has no resolved identity");
        const actorId = candidate.entityId;
        const seed = deriveCharacterEntrySeed(bundle, actorId);
        role.entryCutHash = seed.cut.hash;
        if (!seed.projectionSeed) throw new Error("Entry requires a complete projectionSeed with explicit semantics, processes, norms and active rules, including empty channels");
        const branchId = `probe-${candidate.id}`;
        const head = await engine.createBranch(branchId, candidate.name, seed.delta, seed.knowledge, bundle.source.id, subjectSnapshotHash, seed.evidence,
          { ...(seed.storyTime ? { storyTime: seed.storyTime } : {}), elapsedDays: seed.projectionSeed.elapsedDays }, {
            entryActorId: actorId, projectionSeed: seed.projectionSeed, realizesCanonicalEventIds: seed.realizesCanonicalEventIds,
            ...(seed.participantPresence ? { participantPresence: seed.participantPresence } : {}), ...(seed.actorObservations ? { actorObservations: seed.actorObservations } : {}),
          });
        role.probes.push({ kind: "genesis", passed: true });
        const view = await buildActorScopedActionContext(engine, actorId, head, undefined, bundle.source.id);
        if (view.selfState["character.alive"] !== true) throw new Error("Entry actor life status must be explicitly alive at the chosen historical cut");
        if (typeof view.selfState["character.location"] !== "string") throw new Error("Entry actor physical location is unknown");
        if (!view.decision?.goals.length && typeof view.selfState["character.plan"] !== "string") throw new Error("Entry lacks a grounded current goal or plan");
        role.entryViewHash = contentHash({ selfState: view.selfState, knowledge: view.knowledge, decision: view.decision, scene: view.scene });
        role.probes.push({ kind: "decision", passed: true });
        const intent = playerActionToKnowledgeAwareAction({ branchId, actorId, expectedParentCommit: head, utterance: "I consider my next choice", candidate: {
          title: "Consider next choice", participants: [], preconditions: [], requiresKnowledge: [], forbidsKnowledge: [],
          proposedDelta: { version: 1, operations: [{ op: "set", entityId: actorId, field: "character.plan", value: `${String(view.selfState["character.plan"] ?? view.decision!.goals[0]!.description)}; consider the next choice` }] },
        } });
        const action = await engine.commitProposal(intent.proposal);
        if (!action.report.accepted) throw new Error(action.report.errors.map((x) => `${x.code}: ${x.message}`).join("; "));
        role.probes.push({ kind: "intent", passed: true });
        const wait = await engine.commitProposal({ ...intent.proposal, proposalId: `wait-${candidate.id}`, expectedParentCommit: action.newHead,
          title: "One minute passes", action: { lane: "ad-hoc", actionKindId: "wait", description: "Wait one minute", footprint: { reads: [], writes: [], resources: [] } },
          proposedDelta: { version: 1, operations: [] }, timeAdvance: { amount: 1, unit: "minute" } });
        if (!wait.report.accepted) throw new Error(wait.report.errors.map((x) => `${x.code}: ${x.message}`).join("; "));
        role.probes.push({ kind: "wait", passed: true });
        const resumed = new WorldEngine(scratch, context);
        const beforeFork = await resumed.projections.project(wait.newHead);
        const fresh = await engine.projections.project(wait.newHead, { fresh: true, useCheckpoints: false });
        if (contentHash(beforeFork) !== contentHash(fresh)) throw new Error("Resume projection differs from uncached replay");
        role.probes.push({ kind: "resume", passed: true });
        await runtime.forkBranch(branchId, wait.newHead, `${branchId}-fork`, "Probe fork");
        if ((await resumed.branches.read(`${branchId}-fork`)).headCommitId !== wait.newHead) throw new Error("Fork did not preserve the exact validated cut");
        role.probes.push({ kind: "fork", passed: true });
        role.status = "ready";
      } catch (error) {
        role.issues.push({ code: "MAJOR_ROLE_ENTRY_BLOCKED", message: error instanceof Error ? error.message : String(error) });
      }
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
  return playabilityManifestSchema.parse({ version: 1, subjectSnapshotHash, rosterHash: contentHash(roster), roles,
    majorTotal: candidates.length, readyTotal: roles.filter((role) => role.status === "ready").length, issues });
}

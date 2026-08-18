import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { z } from "zod";
import { canonicalJson, contentHash } from "./canonical.js";
import type { WorldEngine } from "./engine.js";
import { actionableKnowledgeClaimIds, KnowledgeProjector } from "./knowledge.js";
import {
  evidenceRefSchema,
  idSchema,
  knowledgeDeltaSchema,
  predicateSchema,
  storyTimeSchema,
  stateDeltaSchema,
  type EventProposal,
  type NarrativeProgress,
  type StoryTime,
  type WorldState,
} from "./model.js";
import { evaluatePredicate } from "./state.js";
import { committedHistory, projectActorScene, realizedCanonicalEvents } from "./scene.js";
import { AmbiguousLegacySourceError, evidenceBelongsExclusivelyToSource, resolveCommitSourceId } from "./source-scope.js";
import { storyTimesOverlap } from "./time.js";

const goalActionSchema = z
  .object({
    title: z.string().min(1),
    participants: z.array(idSchema).optional(),
    preconditions: z.array(predicateSchema),
    proposedDelta: stateDeltaSchema,
    proposedKnowledge: knowledgeDeltaSchema.optional(),
  })
  .strict();

export const characterGoalSchema = z
  .object({
    id: idSchema,
    actorId: idSchema,
    description: z.string().min(1),
    priority: z.number().min(0).max(1),
    requiresKnowledge: z.array(idSchema),
    blockedByKnowledge: z.array(idSchema).optional(),
    targetIds: z.array(idSchema).optional(),
    activation: z
      .object({
        preconditions: z.array(predicateSchema).default([]),
        afterCanonicalEventIds: z.array(idSchema).default([]),
        storyWindow: storyTimeSchema.optional(),
      })
      .strict()
      .optional(),
    completion: z.array(predicateSchema).optional(),
    expiry: z.array(predicateSchema).optional(),
    milestones: z.array(z.object({
      id: idSchema,
      description: z.string().min(1),
      conditions: z.array(predicateSchema),
    }).strict()).optional(),
    candidateAction: goalActionSchema.optional(),
    actionPatterns: z.array(goalActionSchema).optional(),
    evidence: z.array(evidenceRefSchema).min(1),
  })
  .strict();
export type CharacterGoal = z.infer<typeof characterGoalSchema>;

export const characterDevelopmentPhaseSchema = z
  .object({
    id: idSchema,
    label: z.string().trim().min(1),
    activation: z
      .object({
        preconditions: z.array(predicateSchema).default([]),
        afterCanonicalEventIds: z.array(idSchema).default([]),
        afterExperiencedCanonicalEventIds: z.array(idSchema).default([]),
        requiresKnowledge: z.array(idSchema).default([]),
        storyWindow: storyTimeSchema.optional(),
      })
      .strict(),
    traitModifiers: z.record(z.string(), z.number().min(-2).max(2)).default({}),
    decisionBiasModifiers: z.record(z.string(), z.number().min(-2).max(2)).default({}),
    evidence: z.array(evidenceRefSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const activation = value.activation;
    if (!activation.preconditions.length
      && !activation.afterCanonicalEventIds.length
      && !activation.afterExperiencedCanonicalEventIds.length
      && !activation.requiresKnowledge.length
      && !activation.storyWindow) {
      ctx.addIssue({
        code: "custom",
        message: "A development phase must have at least one state, event, knowledge, or story-time trigger",
        path: ["activation"],
      });
    }
  });
export type CharacterDevelopmentPhase = z.infer<typeof characterDevelopmentPhaseSchema>;

export const characterModelSchema = z
  .object({
    actorId: idSchema,
    traits: z.record(z.string(), z.number().min(-1).max(1)),
    decisionBiases: z.record(z.string(), z.number().min(-1).max(1)),
    developmentPhases: z.array(characterDevelopmentPhaseSchema).optional(),
    evidence: z.array(evidenceRefSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.developmentPhases?.map((phase) => phase.id) ?? [];
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "Character development phase IDs must be unique", path: ["developmentPhases"] });
    }
  });
export type CharacterModel = z.infer<typeof characterModelSchema>;

export type EffectiveCharacterModel = {
  actorId: string;
  traits: Record<string, number>;
  decisionBiases: Record<string, number>;
  activePhaseIds: string[];
};

export function resolveCharacterModel(
  model: CharacterModel,
  input: {
    state: WorldState;
    knownClaimIds: ReadonlySet<string>;
    realizedCanonicalEventIds: ReadonlySet<string>;
    experiencedCanonicalEventIds: ReadonlySet<string>;
    storyTime?: StoryTime;
  },
): EffectiveCharacterModel {
  const traits = { ...model.traits };
  const decisionBiases = { ...model.decisionBiases };
  const activePhaseIds: string[] = [];
  for (const phase of model.developmentPhases ?? []) {
    const activation = phase.activation;
    const active = activation.preconditions.every((predicate) => evaluatePredicate(input.state, predicate))
      && activation.afterCanonicalEventIds.every((eventId) => input.realizedCanonicalEventIds.has(eventId))
      && activation.afterExperiencedCanonicalEventIds.every((eventId) => input.experiencedCanonicalEventIds.has(eventId))
      && activation.requiresKnowledge.every((claimId) => input.knownClaimIds.has(claimId))
      && (!activation.storyWindow || goalStoryWindowActive(
        input.storyTime,
        activation.storyWindow,
        input.realizedCanonicalEventIds,
      ));
    if (!active) continue;
    activePhaseIds.push(phase.id);
    applyModifiers(traits, phase.traitModifiers);
    applyModifiers(decisionBiases, phase.decisionBiasModifiers);
  }
  return { actorId: model.actorId, traits, decisionBiases, activePhaseIds };
}

export type GoalActivation = {
  active: boolean;
  complete: boolean;
  expired: boolean;
  reasons: string[];
};

/** True only when a goal can represent change across time, not merely a static wish. */
export function characterGoalHasDevelopmentBoundary(goal: CharacterGoal): boolean {
  return Boolean(
    goal.requiresKnowledge.length
    || goal.blockedByKnowledge?.length
    || goal.activation?.preconditions.length
    || goal.activation?.afterCanonicalEventIds.length
    || goal.activation?.storyWindow
    || goal.completion?.length
    || goal.expiry?.length
    || goal.milestones?.some((milestone) => milestone.conditions.length),
  );
}

export function evaluateCharacterGoal(
  goal: CharacterGoal,
  input: {
    state: WorldState;
    knownClaimIds: ReadonlySet<string>;
    realizedCanonicalEventIds?: ReadonlySet<string>;
    storyTime?: StoryTime;
  },
): GoalActivation {
  const reasons: string[] = [];
  const complete = Boolean(goal.completion?.length && goal.completion.every((predicate) => evaluatePredicate(input.state, predicate)));
  const expired = Boolean(goal.expiry?.some((predicate) => evaluatePredicate(input.state, predicate)));
  if (complete) reasons.push("completion conditions are satisfied");
  if (expired) reasons.push("an expiry condition is satisfied");
  const missingKnowledge = goal.requiresKnowledge.filter((claimId) => !input.knownClaimIds.has(claimId));
  if (missingKnowledge.length) reasons.push(`missing knowledge: ${missingKnowledge.join(", ")}`);
  const blockedKnowledge = (goal.blockedByKnowledge ?? []).filter((claimId) => input.knownClaimIds.has(claimId));
  if (blockedKnowledge.length) reasons.push(`blocked by knowledge: ${blockedKnowledge.join(", ")}`);
  const activationPredicates = goal.activation?.preconditions ?? [];
  const failedActivation = activationPredicates.filter((predicate) => !evaluatePredicate(input.state, predicate));
  if (failedActivation.length) reasons.push(`${failedActivation.length} activation condition(s) are false`);
  const missingParents = (goal.activation?.afterCanonicalEventIds ?? []).filter((eventId) =>
    !input.realizedCanonicalEventIds?.has(eventId));
  if (missingParents.length) reasons.push(`waiting for canonical anchor(s): ${missingParents.join(", ")}`);
  const storyWindowActive = !goal.activation?.storyWindow || goalStoryWindowActive(
    input.storyTime,
    goal.activation.storyWindow,
    input.realizedCanonicalEventIds,
  );
  if (!storyWindowActive) {
    reasons.push("goal story window does not overlap the active scene");
  }
  return {
    active: !complete && !expired && !missingKnowledge.length && !blockedKnowledge.length
      && !failedActivation.length && !missingParents.length
      && storyWindowActive,
    complete,
    expired,
    reasons,
  };
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export type ActorArtifactKind = "goals" | "models";
export type ActorRevisionRef = { id: string; hash: string };
type StoredActorRef = { version: 1; id: string; hash: string; updatedAt: string };

export class ActorModelStore {
  readonly root: string;
  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceStateDir(workspaceRoot), "world", "v1", "canon", "actors");
  }

  async putGoal(input: CharacterGoal): Promise<void> {
    const goal = characterGoalSchema.parse(input);
    await this.put("goals", goal.id, goal);
  }

  async putModel(input: CharacterModel): Promise<void> {
    const model = characterModelSchema.parse(input);
    await this.put("models", model.actorId, model);
  }

  async ensureGoalRevision(input: CharacterGoal): Promise<void> {
    const goal = characterGoalSchema.parse(input);
    await writeImmutable(this.revisionPath("goals", safeId(goal.id), contentHash(goal)), goal);
  }

  async ensureModelRevision(input: CharacterModel): Promise<void> {
    const model = characterModelSchema.parse(input);
    await writeImmutable(this.revisionPath("models", safeId(model.actorId), contentHash(model)), model);
  }

  async listGoals(actorId?: string): Promise<CharacterGoal[]> {
    const all = await this.list("goals", characterGoalSchema);
    return actorId ? all.filter((goal) => goal.actorId === actorId) : all;
  }

  async getModel(actorId: string): Promise<CharacterModel | null> {
    try {
      return await this.get("models", actorId, characterModelSchema);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async listModels(): Promise<CharacterModel[]> {
    return this.list("models", characterModelSchema);
  }

  getGoalRevision(id: string, hash: string): Promise<CharacterGoal> {
    return this.getRevision("goals", id, hash, characterGoalSchema);
  }

  getModelRevision(id: string, hash: string): Promise<CharacterModel> {
    return this.getRevision("models", id, hash, characterModelSchema);
  }

  async currentRevision(kind: ActorArtifactKind, idInput: string): Promise<ActorRevisionRef | null> {
    const id = safeId(idInput);
    const ref = await this.readRef(kind, id);
    if (ref) return { id, hash: ref.hash };
    const legacy = await this.readLegacy(kind, id);
    return legacy === null ? null : { id, hash: contentHash(legacy) };
  }

  async removeGoal(id: string): Promise<void> { await this.removeCurrent("goals", id); }
  async removeModel(actorId: string): Promise<void> { await this.removeCurrent("models", actorId); }

  private async put(kind: ActorArtifactKind, idInput: string, value: unknown): Promise<void> {
    const id = safeId(idInput);
    await this.migrateLegacy(kind, id);
    const hash = contentHash(value);
    await writeImmutable(this.revisionPath(kind, id, hash), value);
    await atomicJson(this.refPath(kind, id), { version: 1, id, hash, updatedAt: new Date().toISOString() } satisfies StoredActorRef);
  }

  private async get<T>(kind: ActorArtifactKind, idInput: string, schema: z.ZodType<T>): Promise<T> {
    const id = safeId(idInput);
    const ref = await this.readRef(kind, id);
    if (ref) return this.getRevision(kind, id, ref.hash, schema);
    const legacy = await this.readLegacy(kind, id);
    if (legacy === null) throw Object.assign(new Error(`Actor ${kind} artifact not found: ${id}`), { code: "ENOENT" });
    return schema.parse(legacy);
  }

  private async getRevision<T>(kind: ActorArtifactKind, idInput: string, hash: string, schema: z.ZodType<T>): Promise<T> {
    const id = safeId(idInput);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid actor artifact revision hash: ${hash}`);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.revisionPath(kind, id, hash), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const legacy = await this.readLegacy(kind, id);
      if (legacy === null || contentHash(legacy) !== hash) {
        throw Object.assign(new Error(`Actor ${kind} revision not found: ${id}@${hash}`), { code: "ENOENT" });
      }
      raw = legacy;
    }
    const value = schema.parse(raw);
    if (contentHash(value) !== hash) throw new Error(`Corrupt actor ${kind} revision ${id}@${hash}`);
    return value;
  }

  private async list<T>(kind: ActorArtifactKind, schema: z.ZodType<T>): Promise<T[]> {
    const ids = new Set<string>();
    for (const directory of [path.join(this.root, kind, "refs"), path.join(this.root, kind)]) {
      try {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(".json")) ids.add(entry.name.slice(0, -5));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const values: T[] = [];
    for (const id of [...ids].sort()) values.push(await this.get(kind, id, schema));
    return values;
  }

  private async removeCurrent(kind: ActorArtifactKind, idInput: string): Promise<void> {
    const id = safeId(idInput);
    await this.migrateLegacy(kind, id);
    await fs.rm(this.refPath(kind, id), { force: true });
  }

  private async migrateLegacy(kind: ActorArtifactKind, id: string): Promise<void> {
    const legacy = await this.readLegacy(kind, id);
    if (legacy === null) return;
    await writeImmutable(this.revisionPath(kind, id, contentHash(legacy)), legacy);
    await fs.rm(this.legacyPath(kind, id), { force: true });
  }

  private refPath(kind: ActorArtifactKind, id: string): string { return path.join(this.root, kind, "refs", `${id}.json`); }
  private revisionPath(kind: ActorArtifactKind, id: string, hash: string): string { return path.join(this.root, kind, "revisions", id, `${hash}.json`); }
  private legacyPath(kind: ActorArtifactKind, id: string): string { return path.join(this.root, kind, `${id}.json`); }

  private async readRef(kind: ActorArtifactKind, id: string): Promise<StoredActorRef | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.refPath(kind, id), "utf8")) as StoredActorRef;
      if (value.version !== 1 || value.id !== id || !/^[a-f0-9]{64}$/.test(value.hash)) throw new Error(`Invalid actor artifact ref: ${kind}/${id}`);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async readLegacy(kind: ActorArtifactKind, id: string): Promise<unknown | null> {
    try { return JSON.parse(await fs.readFile(this.legacyPath(kind, id), "utf8")) as unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
}

async function writeImmutable(filePath: string, value: unknown): Promise<void> {
  const serialized = `${canonicalJson(value)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await fs.readFile(filePath, "utf8")) !== serialized) throw new Error(`Actor artifact revision collision: ${filePath}`);
  }
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

export type ActorProposalCandidate = {
  proposal: EventProposal;
  priority: number;
  goalId: string;
};

export type ActorProposalSource = (input: {
  branchId: string;
  commitId: string;
}) => Promise<readonly ActorProposalCandidate[]> | readonly ActorProposalCandidate[];

export function deterministicActorProposalSource(engine: WorldEngine, actors: ActorModelStore): ActorProposalSource {
  const knowledge = new KnowledgeProjector(engine);
  return async ({ branchId, commitId }) => {
    const candidates: ActorProposalCandidate[] = [];
    const [context, state, history] = await Promise.all([
      engine.contextForCommit(commitId),
      engine.projector.project(commitId),
      committedHistory(engine, commitId),
    ]);
    let activeSourceId: string | undefined;
    try {
      activeSourceId = await resolveCommitSourceId(engine, context, commitId, undefined, "Actor scheduler");
    } catch (error) {
      // Automatic NPC policy has no authority to choose between novels for an
      // unscoped legacy branch. Disable it without turning a valid player
      // commit into a background error.
      if (error instanceof AmbiguousLegacySourceError) return [];
      throw error;
    }
    const belongsToActiveWorld = (evidence: Parameters<typeof evidenceBelongsExclusivelyToSource>[0]) => activeSourceId
      ? evidenceBelongsExclusivelyToSource(evidence, activeSourceId)
      : evidence.length === 0;
    const latestPlayerEvent = [...history].reverse().find((entry) => entry.event.actorId);
    if (!latestPlayerEvent?.event.actorId) {
      const goals = (context.actorGoals ?? await actors.listGoals())
        .filter((goal) => belongsToActiveWorld(goal.evidence));
      for (const goal of goals) {
        const entity = context.entities.get(goal.actorId);
        if (!entity || entity.kind !== "character") continue;
        if (!belongsToActiveWorld(entity.evidence) || !belongsToActiveWorld(goal.evidence)) continue;
        const actorHistory = history.filter((entry) => !entry.event.evidence.length
          || belongsToActiveWorld(entry.event.evidence));
        const realizedCanonicalEventIds = realizedCanonicalEvents(actorHistory);
        const action = goal.candidateAction ?? goal.actionPatterns?.find((pattern) =>
          pattern.preconditions.every((predicate) => evaluatePredicate(state, predicate)));
        if (!action) continue;
        const view = await knowledge.view(goal.actorId, commitId);
        const known = actionableKnowledgeClaimIds(view, activeSourceId);
        if (!evaluateCharacterGoal(goal, {
          state,
          knownClaimIds: known,
          realizedCanonicalEventIds,
          storyTime: state.logicalTime.storyTime,
        }).active || !goalSupportedInCurrentPhase(goal, actorHistory, goal.actorId)) continue;
        candidates.push({
          goalId: goal.id,
          priority: goal.priority,
          proposal: {
            proposalId: `goal-${contentHash({ goalId: goal.id, branchId, commitId }).slice(0, 24)}`,
            branchId,
            expectedParentCommit: commitId,
            source: "actor",
            actorId: goal.actorId,
            title: action.title,
            participants: [...new Set([goal.actorId, ...(action.participants ?? [])])],
            proposedTime: state.logicalTime.storyTime ?? { kind: "unknown" },
            preconditions: action.preconditions,
            proposedDelta: action.proposedDelta,
            ...(action.proposedKnowledge ? { proposedKnowledge: action.proposedKnowledge } : {}),
            causalParents: [],
            evidence: goal.evidence,
            progress: {
              version: 1,
              channels: action.proposedDelta.operations.length ? ["state", "thread", "consequence"] : ["thread", "consequence"],
              threadIds: [`goal-${goal.id}`],
              noveltyKey: `standalone-goal:${goal.id}:${commitId}`,
            },
          },
        });
      }
      return candidates.sort((left, right) => right.priority - left.priority || left.proposal.proposalId.localeCompare(right.proposal.proposalId));
    }
    const initiatingActorId = latestPlayerEvent.event.actorId;
    const scene = await projectActorScene(engine, initiatingActorId, commitId, activeSourceId);
    const localActors = new Set(scene.presentEntityIds);
    localActors.delete(initiatingActorId);
    if (!localActors.size) return candidates;
    const goals = (context.actorGoals ?? await actors.listGoals())
      .filter((goal) => belongsToActiveWorld(goal.evidence));
    const goalActors = new Set<string>();
    for (const goal of goals) {
      const entity = context.entities.get(goal.actorId);
      if (!entity || entity.kind !== "character" || !localActors.has(goal.actorId)) continue;
      if (!belongsToActiveWorld(entity.evidence) || !belongsToActiveWorld(goal.evidence)) continue;
      const actorHistory = history.filter((entry) => !entry.event.evidence.length
        || belongsToActiveWorld(entry.event.evidence));
      const realizedCanonicalEventIds = realizedCanonicalEvents(actorHistory);
      const view = await knowledge.view(goal.actorId, commitId);
      const known = actionableKnowledgeClaimIds(view, activeSourceId);
      const activation = evaluateCharacterGoal(goal, {
        state,
        knownClaimIds: known,
        realizedCanonicalEventIds,
        storyTime: state.logicalTime.storyTime,
      });
      if (!activation.active || !goalSupportedInCurrentPhase(goal, actorHistory, goal.actorId)) continue;
      const proposedAction = goal.candidateAction ?? goal.actionPatterns?.find((pattern) =>
        pattern.preconditions.every((predicate) => evaluatePredicate(state, predicate)));
      const action = proposedAction && actorActionIsLocal(
        proposedAction,
        goal.actorId,
        initiatingActorId,
        localActors,
        state,
        context.entities,
      ) ? proposedAction : undefined;
      const actionParticipants = action?.participants ?? goal.targetIds ?? [initiatingActorId];
      const participants = [...new Set([goal.actorId, ...actionParticipants])]
        .filter((participantId) => participantId === goal.actorId || localActors.has(participantId) || participantId === initiatingActorId);
      const proposalId = `goal-${contentHash({ goalId: goal.id, branchId, commitId }).slice(0, 24)}`;
      const progress: NarrativeProgress = {
        version: 1,
        channels: action && action.proposedDelta.operations.length ? ["state", "thread", "consequence"] : ["relationship", "thread", "consequence"],
        threadIds: [`goal-${goal.id}`],
        noveltyKey: `actor-goal:${goal.id}:${latestPlayerEvent.event.eventId}`,
      };
      candidates.push({
        goalId: goal.id,
        priority: goal.priority,
        proposal: {
          proposalId,
          branchId,
          expectedParentCommit: commitId,
          source: "actor",
          actorId: goal.actorId,
          title: action?.title ?? `${entity.canonicalName}回应当前局势`,
          participants,
          proposedTime: state.logicalTime.storyTime ?? { kind: "unknown" },
          preconditions: action?.preconditions ?? [],
          proposedDelta: action?.proposedDelta ?? { version: 1, operations: [] },
          ...(action?.proposedKnowledge ? { proposedKnowledge: action.proposedKnowledge } : {}),
          causalParents: [latestPlayerEvent.event.eventId],
          evidence: goal.evidence,
          progress,
        },
      });
      goalActors.add(goal.actorId);
    }

    for (const actorId of [...localActors].sort()) {
      if (goalActors.has(actorId)) continue;
      const entity = context.entities.get(actorId);
      const model = context.actorModels
        ? context.actorModels.get(actorId)
        : await actors.getModel(actorId);
      if (!entity || entity.kind !== "character" || !model
        || !belongsToActiveWorld(entity.evidence)
        || !belongsToActiveWorld(model.evidence)) continue;
      candidates.push({
        goalId: `model-${actorId}`,
        priority: 0.2,
        proposal: {
          proposalId: `reaction-${contentHash({ actorId, branchId, commitId }).slice(0, 24)}`,
          branchId,
          expectedParentCommit: commitId,
          source: "actor",
          actorId,
          title: `${entity.canonicalName}对当前变化作出回应`,
          participants: [actorId, initiatingActorId],
          proposedTime: state.logicalTime.storyTime ?? { kind: "unknown" },
          preconditions: [],
          proposedDelta: { version: 1, operations: [] },
          causalParents: [latestPlayerEvent.event.eventId],
          evidence: model.evidence,
          progress: {
            version: 1,
            channels: ["relationship", "consequence"],
            threadIds: [],
            noveltyKey: `actor-reaction:${actorId}:${latestPlayerEvent.event.eventId}`,
          },
        },
      });
    }
    return candidates.sort((left, right) => right.priority - left.priority || left.proposal.proposalId.localeCompare(right.proposal.proposalId));
  };
}

export function goalSupportedInCurrentPhase(
  goal: CharacterGoal,
  history: Awaited<ReturnType<typeof committedHistory>>,
  actorId: string,
): boolean {
  if (goal.activation || goal.requiresKnowledge.length > 0) return true;
  if (history.some((entry) => entry.event.progress?.threadIds.includes(`goal-${goal.id}`))) return true;
  return [...history].reverse().slice(0, 12).some((entry) =>
    entry.event.participants.includes(actorId)
    && entry.event.evidence.some((eventEvidence) => goal.evidence.some((goalEvidence) => evidenceOverlaps(eventEvidence, goalEvidence))));
}

function evidenceOverlaps(
  left: CharacterGoal["evidence"][number],
  right: CharacterGoal["evidence"][number],
): boolean {
  return left.span.sourceId === right.span.sourceId
    && left.span.startLine <= right.span.endLine
    && left.span.endLine >= right.span.startLine;
}

function actorActionIsLocal(
  action: NonNullable<CharacterGoal["candidateAction"]>,
  actorId: string,
  initiatingActorId: string,
  localActors: ReadonlySet<string>,
  state: WorldState,
  entities: ReadonlyMap<string, { kind: string }>,
): boolean {
  const localCharacters = new Set([actorId, initiatingActorId, ...localActors]);
  for (const participantId of action.participants ?? []) {
    if (entities.get(participantId)?.kind === "character" && !localCharacters.has(participantId)) return false;
  }
  const actorLocation = state.values[actorId]?.["character.location"];
  for (const operation of action.proposedDelta.operations) {
    if (operation.op === "activate-rule" || operation.op === "deactivate-rule") return false;
    const targetKind = entities.get(operation.entityId)?.kind;
    if (targetKind === "character" && operation.entityId !== actorId) return false;
    if (targetKind === "artifact" && state.values[operation.entityId]?.["artifact.owner"] !== actorId) return false;
    if (targetKind === "location" && operation.entityId !== actorLocation) return false;
    if (targetKind !== "character" && targetKind !== "artifact" && targetKind !== "location") return false;
    if (operation.op === "set" && typeof operation.value === "string") {
      const referencedKind = entities.get(operation.value)?.kind;
      if (referencedKind === "character" && !localCharacters.has(operation.value)) return false;
    }
    if ((operation.op === "add-member" || operation.op === "remove-member")
      && entities.get(operation.member)?.kind === "character"
      && !localCharacters.has(operation.member)) return false;
  }
  for (const operation of action.proposedKnowledge?.operations ?? []) {
    if (!localCharacters.has(operation.actorId)) return false;
    if (operation.op === "learn" && operation.sourceActorId && !localCharacters.has(operation.sourceActorId)) return false;
  }
  return true;
}

function goalStoryWindowActive(
  current: StoryTime | undefined,
  candidate: StoryTime,
  realizedCanonicalEventIds: ReadonlySet<string> | undefined,
): boolean {
  if (candidate.kind === "unknown") return true;
  if (candidate.kind === "relative") {
    return Boolean(realizedCanonicalEventIds?.has(candidate.anchorEventId));
  }
  if (!current || current.kind === "unknown" || current.kind === "relative") return false;
  if (storyTimesOverlap(current, candidate)) return true;
  // Unnumbered ordinal labels are only comparable by stable normalized label.
  return current.kind === "ordinal"
    && candidate.kind === "ordinal"
    && current.orderHint === undefined
    && candidate.orderHint === undefined
    && current.label.normalize("NFKC").trim().toLocaleLowerCase()
      === candidate.label.normalize("NFKC").trim().toLocaleLowerCase();
}

function applyModifiers(target: Record<string, number>, modifiers: Record<string, number>): void {
  for (const [key, modifier] of Object.entries(modifiers)) {
    target[key] = Math.max(-1, Math.min(1, (target[key] ?? 0) + modifier));
  }
}

function safeId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`Unsafe actor artifact id: ${id}`);
  return id;
}

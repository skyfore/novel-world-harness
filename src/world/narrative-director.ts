import { validateActionKnowledge } from "./action-gate.js";
import { evaluateCharacterGoal, type CharacterGoal } from "./actors.js";
import { contentHash } from "./canonical.js";
import { validateEventProposal, type WorldEngine } from "./engine.js";
import { isActionableKnowledge, KnowledgeProjector } from "./knowledge.js";
import type {
  NarrativeProgress,
  Possibility,
  ProgressChannel,
  StateOperation,
  ValidationIssue,
} from "./model.js";
import {
  buildActorScopedActionContext,
  playerActionToKnowledgeAwareAction,
  playerActionCandidateSchema,
  validatePlayerActionGrounding,
  validatePlayerActionScope,
  validatePlayerActionSpatialScope,
  type ActorScopedActionContext,
  type PlayerActionCandidate,
} from "./player-action.js";
import type { WorldRuntime } from "./runtime.js";
import { committedHistory, projectActorScene, realizedCanonicalEvents, type ActorSceneProjection } from "./scene.js";

export type NarrativeThreadView = {
  id: string;
  kind: "scene" | "goal" | "canon-pressure" | "emergent";
  summary: string;
  participantIds: string[];
  pressure: number;
  stage: number;
};

export type PlayerAffordance = {
  id: string;
  label: string;
  description: string;
  action: string;
  intent: "act" | "observe" | "reflect" | "wait";
  progressChannels: ProgressChannel[];
  threadIds: string[];
  recommended: boolean;
};

export type ResolvedPlayerAffordance = PlayerAffordance & {
  candidate: PlayerActionCandidate;
  authorizedKnowledgeClaimIds: string[];
  progress: NarrativeProgress;
  score: number;
};

export type NarrativeDirection = {
  scene: ActorSceneProjection;
  threads: NarrativeThreadView[];
  affordances: ResolvedPlayerAffordance[];
};

type InternalThread = NarrativeThreadView & {
  linkId: string;
  possibility?: Possibility;
  goal?: CharacterGoal;
};

type AffordanceDraft = Omit<ResolvedPlayerAffordance, "id" | "recommended">;

/**
 * Read-only scene director.  It may rank canon-shaped pressure, actor goals,
 * and emergent scene threads, but it can only return preflighted player
 * capabilities.  It never commits an event and never exposes future canon
 * titles or effects to the narrator frame.
 */
export async function buildNarrativeDirection(
  engine: WorldEngine,
  runtime: WorldRuntime,
  actorId: string,
  commitId: string,
  sourceId?: string,
): Promise<NarrativeDirection> {
  const [context, state, scoped, scene, frontier, history] = await Promise.all([
    engine.contextForCommit(commitId),
    engine.projector.project(commitId),
    buildActorScopedActionContext(engine, actorId, commitId, undefined, sourceId),
    projectActorScene(engine, actorId, commitId, sourceId),
    runtime.refreshFrontier((await engine.objects.getCommit(commitId)).branchId, commitId),
    committedHistory(engine, commitId),
  ]);
  const knownClaimIds = new Set(scoped.knowledge.filter((entry) => entry.status !== "disbelieves").map((entry) => entry.claimId));
  const realizedCanonicalEventIds = realizedCanonicalEvents(history);
  const knownClaimsByActor = new Map<string, ReadonlySet<string>>([[actorId, knownClaimIds]]);
  const localGoalActorIds = [...new Set((context.actorGoals ?? [])
    .map((goal) => goal.actorId)
    .filter((goalActorId) => goalActorId !== actorId && scene.presentEntityIds.includes(goalActorId)))];
  const knowledgeProjector = new KnowledgeProjector(engine);
  await Promise.all(localGoalActorIds.map(async (goalActorId) => {
    const view = await knowledgeProjector.view(goalActorId, commitId);
    knownClaimsByActor.set(goalActorId, new Set(
      view.knowledge
        .filter((entry) => isActionableKnowledge(entry.fact))
        .map((entry) => entry.fact.claimId),
    ));
  }));
  const internalThreads: InternalThread[] = [];
  const latestVisibleEvent = scene.recentEvents.at(-1);

  if (latestVisibleEvent) {
    const inheritedThreadIds = latestVisibleEvent.progress?.threadIds.length
      ? latestVisibleEvent.progress.threadIds
      : [`scene-${latestVisibleEvent.eventId}`];
    for (const linkId of inheritedThreadIds.slice(0, 3)) {
      internalThreads.push({
        id: opaqueThreadId(linkId),
        linkId,
        kind: "scene",
        summary: `“${latestVisibleEvent.title}”留下的局势仍可被下一步行动改变。`,
        participantIds: [...latestVisibleEvent.participantIds],
        pressure: 0.65,
        stage: threadStage(linkId, history),
      });
    }
  }

  for (const goal of context.actorGoals ?? []) {
    if (goal.actorId !== actorId && !scene.presentEntityIds.includes(goal.actorId)) continue;
    const activation = evaluateCharacterGoal(goal, {
      state,
      knownClaimIds: knownClaimsByActor.get(goal.actorId) ?? new Set(),
      realizedCanonicalEventIds,
      storyTime: state.logicalTime.storyTime,
    });
    if (!activation.active || !goalVisibleInCurrentPhase(goal, history, scene.presentEntityIds)) continue;
    const participantIds = [...new Set([goal.actorId, ...(goal.targetIds ?? []), ...(goal.candidateAction?.participants ?? [])])]
      .filter((id) => id === actorId || scoped.referenceableEntities.some((entity) => entity.id === id));
    internalThreads.push({
      id: opaqueThreadId(`goal:${goal.id}`),
      linkId: `goal-${goal.id}`,
      kind: "goal",
      summary: goal.actorId === actorId
        ? `你当前可以推进的目标：${goal.description}`
        : `${context.entities.get(goal.actorId)?.canonicalName ?? "现场人物"}正在对局势施加可感知的行动压力。`,
      participantIds,
      pressure: goal.priority,
      stage: threadStage(`goal-${goal.id}`, history),
      goal,
    });
  }

  for (const entry of frontier.evaluated) {
    if (entry.status !== "eligible" || !entry.possibility.participants.includes(actorId)) continue;
    const otherCharacters = entry.possibility.participants.filter((id) =>
      id !== actorId && context.entities.get(id)?.kind === "character");
    if (otherCharacters.some((id) => !scene.presentEntityIds.includes(id))) continue;
    const named = otherCharacters.map((id) => context.entities.get(id)?.canonicalName).filter(Boolean).join("、");
    internalThreads.push({
      id: opaqueThreadId(`possibility:${entry.possibility.id}`),
      linkId: entry.possibility.id,
      kind: "canon-pressure",
      summary: named
        ? `你与${named}之间存在一个已经具备条件、但尚未被决定的节点。`
        : "当前局势中有一个已经具备条件、但尚未被决定的节点。",
      participantIds: [...entry.possibility.participants],
      pressure: Math.max(0.1, Math.min(1, entry.score || entry.possibility.pressure)),
      stage: threadStage(entry.possibility.id, history),
      possibility: entry.possibility,
    });
  }

  const uniqueThreads = dedupeThreads(internalThreads);
  if (!uniqueThreads.length) {
    uniqueThreads.push({
      id: opaqueThreadId(`emergent:${scene.key}`),
      linkId: `emergent-${contentHash({ actorId, scene: scene.key }).slice(0, 24)}`,
      kind: "emergent",
      summary: "当前场景尚未定向；一次具体行动会建立可继续追踪的新支线。",
      participantIds: [actorId],
      pressure: 0.35,
      stage: threadStage(`emergent-${contentHash({ actorId, scene: scene.key }).slice(0, 24)}`, history),
    });
  }

  const drafts: AffordanceDraft[] = [];
  addCanonicalAffordances(drafts, uniqueThreads, scoped, scene, context.entities, actorId);
  addConversationAffordances(drafts, uniqueThreads, scoped, scene, context.entities, actorId);
  addLocationAffordances(drafts, uniqueThreads, scoped, scene, context.entities, actorId);
  addDiscoverableAffordance(drafts, uniqueThreads, scoped, scene, history, context.claims, actorId);
  addGoalAndPlanAffordances(drafts, uniqueThreads, scoped, scene, actorId);
  addPressureWaitAffordance(drafts, uniqueThreads, scoped, scene, actorId);
  addExplorationAffordances(drafts, uniqueThreads, scoped, scene, actorId);

  const committedNoveltyKeys = new Set(history.flatMap((entry) =>
    entry.event.progress?.noveltyKey ? [entry.event.progress.noveltyKey] : []));
  const preflighted: ResolvedPlayerAffordance[] = [];
  for (const draft of drafts.sort((left, right) => right.score - left.score || left.action.localeCompare(right.action))) {
    if (committedNoveltyKeys.has(draft.progress.noveltyKey)) continue;
    const id = `aff-${contentHash({ at: commitId, action: draft.action, candidate: draft.candidate, progress: draft.progress }).slice(0, 24)}`;
    if (preflighted.some((entry) => entry.progress.noveltyKey === draft.progress.noveltyKey || entry.action === draft.action)) continue;
    const resolved: ResolvedPlayerAffordance = { ...draft, id, recommended: false };
    const issues = await preflightPlayerAffordance(engine, scoped, resolved, commitId);
    if (!issues.length) preflighted.push(resolved);
    if (preflighted.length >= 4) break;
  }

  if (preflighted.length < 2) {
    for (const fallback of fallbackAffordances(uniqueThreads, scoped, scene, actorId)) {
      if (committedNoveltyKeys.has(fallback.progress.noveltyKey)) continue;
      const id = `aff-${contentHash({ at: commitId, action: fallback.action, progress: fallback.progress }).slice(0, 24)}`;
      if (preflighted.some((entry) => entry.action === fallback.action || entry.progress.noveltyKey === fallback.progress.noveltyKey)) continue;
      const resolved: ResolvedPlayerAffordance = { ...fallback, id, recommended: false };
      if (!(await preflightPlayerAffordance(engine, scoped, resolved, commitId)).length) preflighted.push(resolved);
      if (preflighted.length >= 2) break;
    }
  }
  if (!preflighted.length) throw new Error("The scene director could not produce a single executable player affordance.");
  const ranked = preflighted
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map((entry, index) => ({ ...entry, recommended: index === 0 }));
  return {
    scene,
    threads: uniqueThreads.map(({ linkId: _linkId, possibility: _possibility, goal: _goal, ...thread }) => structuredClone(thread)),
    affordances: ranked,
  };
}

export async function resolvePlayerAffordance(
  engine: WorldEngine,
  runtime: WorldRuntime,
  actorId: string,
  commitId: string,
  affordanceId: string,
  sourceId?: string,
): Promise<ResolvedPlayerAffordance | undefined> {
  return (await buildNarrativeDirection(engine, runtime, actorId, commitId, sourceId)).affordances
    .find((affordance) => affordance.id === affordanceId);
}

export function publicPlayerAffordance(affordance: ResolvedPlayerAffordance): PlayerAffordance {
  const { candidate: _candidate, authorizedKnowledgeClaimIds: _claims, progress: _progress, score: _score, ...publicValue } = affordance;
  return structuredClone(publicValue);
}

async function preflightPlayerAffordance(
  engine: WorldEngine,
  scoped: ActorScopedActionContext,
  affordance: ResolvedPlayerAffordance,
  commitId: string,
): Promise<ValidationIssue[]> {
  const authorized = new Set(affordance.authorizedKnowledgeClaimIds);
  const issues = [
    ...validatePlayerActionScope(affordance.candidate, scoped, authorized),
    ...validatePlayerActionGrounding(affordance.candidate, scoped),
    ...await validatePlayerActionSpatialScope(engine, affordance.candidate, scoped.actorId, commitId),
  ];
  if (issues.length) return issues;
  const action = playerActionToKnowledgeAwareAction({
    branchId: (await engine.objects.getCommit(commitId)).branchId,
    actorId: scoped.actorId,
    expectedParentCommit: commitId,
    utterance: affordance.action,
    candidate: affordance.candidate,
  });
  action.proposal.progress = structuredClone(affordance.progress);
  const gate = await validateActionKnowledge(engine, action);
  if (!gate.accepted) return gate.errors;
  const state = await engine.projector.project(commitId);
  const context = await engine.contextForCommit(commitId);
  return validateEventProposal(action.proposal, commitId, state, context).report.errors;
}

function addCanonicalAffordances(
  drafts: AffordanceDraft[],
  threads: readonly InternalThread[],
  scoped: ActorScopedActionContext,
  scene: ActorSceneProjection,
  entities: ReadonlyMap<string, { kind: string; canonicalName: string }>,
  actorId: string,
): void {
  const writable = new Set(scoped.writableEntityIds);
  const referenceable = new Set(scoped.referenceableEntities.map((entity) => entity.id));
  for (const thread of threads) {
    const possibility = thread.possibility;
    if (!possibility?.proposedDelta) continue;
    if (possibility.proposedDelta.operations.some((operation) =>
      operation.op === "activate-rule" || operation.op === "deactivate-rule" || !writable.has(operation.entityId))) continue;
    if ((possibility.proposedKnowledge?.operations ?? []).some((operation) =>
      operation.actorId !== actorId || !scoped.knowledge.some((entry) => entry.claimId === operation.claimId))) continue;
    const transition = describeControllableCanonicalTransition(possibility, scoped, scene, entities, actorId);
    if (!transition) continue;
    const participants = [...new Set([
      ...possibility.participants.filter((id) => id !== actorId && referenceable.has(id)),
      ...transition.participantIds,
    ])];
    const movement = possibility.proposedDelta.operations.find((operation) =>
      operation.op === "set" && operation.entityId === actorId && operation.field === "character.location" && typeof operation.value === "string");
    const progress = progressFor({
      channels: ["state", "thread", "consequence", ...(movement ? ["scene" as const] : [])],
      threadIds: [thread.linkId],
      noveltyKey: `canon-step:${thread.linkId}`,
      ...(movement && movement.op === "set" && typeof movement.value === "string"
        ? { scene: { kind: "arrive" as const, destinationEntityId: movement.value, ...(transition.destinationName ? { label: transition.destinationName } : {}), beat: scene.beat + 1 } }
        : {}),
    });
    drafts.push({
      label: transition.label,
      description: transition.description,
      action: transition.action,
      intent: "act",
      progressChannels: [...progress.channels],
      threadIds: [thread.id],
      candidate: playerActionCandidateSchema.parse({
        title: transition.title,
        participants,
        preconditions: [],
        proposedDelta: possibility.proposedDelta,
        ...(possibility.proposedKnowledge ? { proposedKnowledge: possibility.proposedKnowledge } : {}),
        requiresKnowledge: [],
        forbidsKnowledge: [],
      }),
      authorizedKnowledgeClaimIds: [],
      progress,
      score: 1.2 + thread.pressure,
    });
  }
}

function describeControllableCanonicalTransition(
  possibility: Possibility,
  scoped: ActorScopedActionContext,
  scene: ActorSceneProjection,
  entities: ReadonlyMap<string, { kind: string; canonicalName: string }>,
  actorId: string,
): {
  label: string;
  description: string;
  action: string;
  title: string;
  participantIds: string[];
  destinationName?: string;
} | undefined {
  const operations = possibility.proposedDelta?.operations ?? [];
  if (operations.length !== 1) return undefined;
  const operation = operations[0]!;
  const referenceable = new Set(scoped.referenceableEntities.map((entity) => entity.id));
  const present = new Set(scene.presentEntityIds);
  if (
    operation.op === "set"
    && operation.entityId === actorId
    && operation.field === "character.location"
    && typeof operation.value === "string"
    && referenceable.has(operation.value)
    && entities.get(operation.value)?.kind === "location"
  ) {
    const name = entities.get(operation.value)!.canonicalName;
    return {
      label: `前往${name}推进当前节点`,
      description: "完成一个明确且由你控制的场景转移，使当前故事压力进入下一处接触点。",
      action: `我现在离开这里，前往${name}。`,
      title: `前往${name}`,
      participantIds: [operation.value],
      destinationName: name,
    };
  }
  if (
    (operation.op === "add-member" || operation.op === "remove-member")
    && operation.entityId === actorId
    && (operation.field === "character.relationships" || operation.field === "character.obligations")
    && referenceable.has(operation.member)
  ) {
    const name = entities.get(operation.member)?.canonicalName ?? operation.member;
    const establishing = operation.op === "add-member";
    return {
      label: establishing ? `明确与${name}的牵连` : `解除与${name}的牵连`,
      description: "这是一个可见、可回放的关系选择；选择文本准确说明将写入的变化。",
      action: establishing
        ? `我明确承认自己与${name}在此事上的牵连，并据此行动。`
        : `我明确解除自己与${name}在此事上的牵连，并承担这个决定的后果。`,
      title: establishing ? `与${name}建立牵连` : `解除与${name}的牵连`,
      participantIds: [operation.member],
    };
  }
  if (
    operation.op === "set"
    && entities.get(operation.entityId)?.kind === "artifact"
    && scoped.ownedEntityState[operation.entityId]?.["artifact.owner"] === actorId
    && operation.field === "artifact.owner"
    && typeof operation.value === "string"
    && present.has(operation.value)
    && entities.get(operation.value)?.kind === "character"
  ) {
    const artifact = entities.get(operation.entityId)!.canonicalName;
    const recipient = entities.get(operation.value)!.canonicalName;
    return {
      label: `把${artifact}交给${recipient}`,
      description: "完成一项由你控制、且收受者就在现场的物品转移。",
      action: `我把${artifact}交给${recipient}。`,
      title: `把${artifact}交给${recipient}`,
      participantIds: [operation.entityId, operation.value],
    };
  }
  if (
    operation.op === "set"
    && operation.field === "artifact.delivered"
    && operation.value === true
    && scoped.ownedEntityState[operation.entityId]?.["artifact.owner"] === actorId
  ) {
    const artifact = entities.get(operation.entityId)?.canonicalName ?? operation.entityId;
    return {
      label: `完成${artifact}的交付`,
      description: "完成一项已经具备现场条件的明确交付，不替玩家隐藏真正的状态变化。",
      action: `我现在完成${artifact}的交付。`,
      title: `完成${artifact}的交付`,
      participantIds: [operation.entityId],
    };
  }
  return undefined;
}

function addConversationAffordances(
  drafts: AffordanceDraft[],
  threads: readonly InternalThread[],
  scoped: ActorScopedActionContext,
  scene: ActorSceneProjection,
  entities: ReadonlyMap<string, { kind: string; canonicalName: string }>,
  actorId: string,
): void {
  for (const participantId of scene.presentEntityIds) {
    if (participantId === actorId || entities.get(participantId)?.kind !== "character") continue;
    const name = entities.get(participantId)!.canonicalName;
    const related = threads.filter((thread) => thread.participantIds.includes(participantId));
    const links = (related.length ? related : threads.slice(0, 1));
    const stage = Math.max(0, ...links.map((thread) => thread.stage));
    const relationships = Array.isArray(scoped.selfState["character.relationships"])
      ? scoped.selfState["character.relationships"] as string[]
      : [];
    const operations: StateOperation[] = !relationships.includes(participantId)
      && scoped.writableStateFields.some((field) => field.key === "character.relationships")
      ? [{ op: "add-member", entityId: actorId, field: "character.relationships", member: participantId }]
      : nextMomentumOperation(scoped, actorId);
    const phase = stage <= 0
      ? { label: `主动与${name}交涉`, action: `我主动对${name}开口，明确表达自己的态度，并要求对方回应眼前这件事。` }
      : stage === 1
        ? { label: `追问${name}的明确立场`, action: `我不再停留在寒暄，直接追问${name}对此事的明确立场和下一步打算。` }
        : { label: `向${name}提出具体条件`, action: `我向${name}提出一个必须当场回应的具体条件，把这段交涉推向决定。` };
    const progress = progressFor({
      channels: ["relationship", "thread", "consequence", ...(operations.length ? ["state" as const] : [])],
      threadIds: links.map((thread) => thread.linkId),
      noveltyKey: `talk:${participantId}:${links.map((thread) => thread.linkId).join("+")}:stage-${Math.min(stage, 2)}`,
    });
    drafts.push({
      label: phase.label,
      description: "让同场人物真正回应你的立场，使关系或当前任务发生可追踪的变化。",
      action: phase.action,
      intent: "act",
      progressChannels: [...progress.channels],
      threadIds: links.map((thread) => thread.id),
      candidate: playerActionCandidateSchema.parse({
        title: phase.label,
        participants: [participantId],
        preconditions: [],
        proposedDelta: { version: 1, operations },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      }),
      authorizedKnowledgeClaimIds: [],
      progress,
      score: 1 + Math.max(...links.map((thread) => thread.pressure), 0),
    });
  }
}

function addLocationAffordances(
  drafts: AffordanceDraft[],
  threads: readonly InternalThread[],
  scoped: ActorScopedActionContext,
  scene: ActorSceneProjection,
  entities: ReadonlyMap<string, { kind: string; canonicalName: string }>,
  actorId: string,
): void {
  const links = threads.slice(0, 2);
  for (const location of scoped.referenceableEntities.filter((entity) => entity.kind === "location" && entity.id !== scene.locationId).slice(0, 2)) {
    const name = entities.get(location.id)?.canonicalName ?? location.name;
    const progress = progressFor({
      channels: ["state", "scene", "thread"],
      threadIds: links.map((thread) => thread.linkId),
      noveltyKey: `move:${location.id}`,
      scene: { kind: "arrive", destinationEntityId: location.id, label: name, beat: scene.beat + 1 },
    });
    drafts.push({
      label: `前往${name}`,
      description: "完成明确的场景转移，同时让当前压力继续跟随并产生新的接触面。",
      action: `我离开这里，前往${name}。`,
      intent: "act",
      progressChannels: [...progress.channels],
      threadIds: links.map((thread) => thread.id),
      candidate: playerActionCandidateSchema.parse({
        title: `前往${name}`,
        participants: [location.id],
        preconditions: [],
        proposedDelta: { version: 1, operations: [{ op: "set", entityId: actorId, field: "character.location", value: location.id }] },
        requiresKnowledge: [],
        forbidsKnowledge: [],
      }),
      authorizedKnowledgeClaimIds: [],
      progress,
      score: 0.85,
    });
  }
}

function addDiscoverableAffordance(
  drafts: AffordanceDraft[],
  threads: readonly InternalThread[],
  scoped: ActorScopedActionContext,
  scene: ActorSceneProjection,
  history: Awaited<ReturnType<typeof committedHistory>>,
  claims: ReadonlyMap<string, { id: string; subject: string; evidence: Array<{ span: { sourceId: string; startLine: number; endLine: number } }> }> | undefined,
  actorId: string,
): void {
  if (!claims) return;
  const known = new Set(scoped.knowledge.map((entry) => entry.claimId));
  const referenceable = new Set(scoped.referenceableEntities.map((entity) => entity.id));
  const recentEvidence = history.slice(-8).flatMap((entry) => entry.event.evidence);
  const claim = [...claims.values()].find((candidate) =>
    !known.has(candidate.id)
    && referenceable.has(candidate.subject)
    && candidate.evidence.some((claimEvidence) => recentEvidence.some((eventEvidence) => evidenceOverlaps(claimEvidence, eventEvidence))));
  if (!claim) return;
  const links = threads.slice(0, 2);
  const progress = progressFor({
    channels: ["knowledge", "thread"],
    threadIds: links.map((thread) => thread.linkId),
    noveltyKey: `discover:${claim.id}`,
  });
  drafts.push({
    label: "查明刚才暴露的细节",
    description: "现场已有可验证但你尚未掌握的信息；观察会获得新知识，而不是原地空看。",
    action: "我仔细检查刚才发生的事留下的细节，确认其中真正可以知道的信息。",
    intent: "observe",
    progressChannels: [...progress.channels],
    threadIds: links.map((thread) => thread.id),
    candidate: playerActionCandidateSchema.parse({
      title: "查明当前事件留下的细节",
      participants: scene.presentEntityIds.filter((id) => id !== actorId),
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      proposedKnowledge: { version: 1, operations: [{ op: "learn", actorId, claimId: claim.id, status: "knows", confidence: 1 }] },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    }),
    authorizedKnowledgeClaimIds: [claim.id],
    progress,
    score: 1.05,
  });
}

function addGoalAndPlanAffordances(
  drafts: AffordanceDraft[],
  threads: readonly InternalThread[],
  scoped: ActorScopedActionContext,
  _scene: ActorSceneProjection,
  actorId: string,
): void {
  const ownGoal = threads.find((thread) => thread.kind === "goal" && thread.goal?.actorId === actorId);
  const focus = ownGoal ?? threads[0];
  if (!focus) return;
  const plan = ownGoal?.goal?.description ?? focus.summary;
  const hasPlanField = scoped.writableStateFields.some((field) => field.key === "character.plan");
  const existingPlan = scoped.selfState["character.plan"];
  const maySetPlan = ownGoal
    ? existingPlan !== plan
    : typeof existingPlan !== "string" || !existingPlan.trim();
  const operations: StateOperation[] = hasPlanField && maySetPlan
    ? [{ op: "set", entityId: actorId, field: "character.plan", value: plan }]
    : [];
  if (!operations.length) return;
  const progress = progressFor({
    channels: ["plan", "thread", ...(operations.length ? ["state" as const] : [])],
    threadIds: [focus.linkId],
    noveltyKey: `plan:${focus.linkId}:stage-${focus.stage}`,
  });
  drafts.push({
    label: "确定一个可执行目标",
    description: "把当前线索收束成下一步计划；计划会成为后续行动的持续牵引，而非空泛回想。",
    action: "我不再只是回想，而是根据眼前局势确定一个马上可以执行的目标。",
    intent: "reflect",
    progressChannels: [...progress.channels],
    threadIds: [focus.id],
    candidate: playerActionCandidateSchema.parse({
      title: "形成针对当前局势的行动计划",
      participants: [],
      preconditions: [],
      proposedDelta: { version: 1, operations },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    }),
    authorizedKnowledgeClaimIds: [],
    progress,
    score: 0.72 + focus.pressure / 4,
  });
}

function addPressureWaitAffordance(
  drafts: AffordanceDraft[],
  threads: readonly InternalThread[],
  scoped: ActorScopedActionContext,
  scene: ActorSceneProjection,
  actorId: string,
): void {
  const pressure = threads.find((thread) => thread.pressure >= 0.65 && thread.participantIds.some((id) => id !== actorId && scene.presentEntityIds.includes(id)));
  if (!pressure) return;
  const operations = nextMomentumOperation(scoped, actorId);
  const progress = progressFor({
    channels: ["time-pressure", "thread", "consequence", ...(operations.length ? ["state" as const] : [])],
    threadIds: [pressure.linkId],
    noveltyKey: `wait-pressure:${pressure.linkId}:stage-${pressure.stage}`,
  });
  drafts.push({
    label: "让压力先走一步",
    description: "短暂不行动会触发现有压力或同场人物的回应；没有压力可推进时不会提供此选项。",
    action: "我暂时按住动作，让眼前的压力或对方先暴露下一步。",
    intent: "wait",
    progressChannels: [...progress.channels],
    threadIds: [pressure.id],
    candidate: playerActionCandidateSchema.parse({
      title: "让当前压力先产生后果",
      participants: pressure.participantIds.filter((id) => id !== actorId && scene.presentEntityIds.includes(id)),
      preconditions: [],
      proposedDelta: { version: 1, operations },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    }),
    authorizedKnowledgeClaimIds: [],
    progress,
    score: 0.64 + pressure.pressure / 5,
  });
}

function addExplorationAffordances(
  drafts: AffordanceDraft[],
  threads: readonly InternalThread[],
  _scoped: ActorScopedActionContext,
  scene: ActorSceneProjection,
  actorId: string,
): void {
  const focus = threads[0]!;
  const label = "邻近的开放区域";
  const progress = progressFor({
    channels: ["scene", "thread", "consequence"],
    threadIds: [focus.linkId],
    noveltyKey: `explore:${scene.key}`,
    scene: { kind: "explore", label, beat: scene.beat + 1 },
  });
  drafts.push({
    label: "离开原地寻找新接触点",
    description: "切换到相邻的开放场景；原有任务压力不会消失，但可能形成新的支线。",
    action: "我离开原地，到附近走动，并主动寻找能让当前局势产生变化的人、事或线索。",
    intent: "act",
    progressChannels: [...progress.channels],
    threadIds: [focus.id],
    candidate: playerActionCandidateSchema.parse({
      title: "离开原地并寻找新的接触点",
      participants: [],
      preconditions: [],
      proposedDelta: { version: 1, operations: [] },
      requiresKnowledge: [],
      forbidsKnowledge: [],
    }),
    authorizedKnowledgeClaimIds: [],
    progress,
    score: 0.7,
  });
}

function fallbackAffordances(
  threads: readonly InternalThread[],
  scoped: ActorScopedActionContext,
  scene: ActorSceneProjection,
  actorId: string,
): AffordanceDraft[] {
  const focus = threads[0]!;
  const phase = Math.min(focus.stage, 2);
  const momentumOperations = nextMomentumOperation(scoped, actorId);
  const decisiveCopy = [
    {
      label: "选定处理当前局势的立场",
      description: "明确立场并形成可追踪的行动势头，下一步将据此产生反应。",
      action: "我明确自己处理眼前局势的立场，并立刻用一个具体动作表明它。",
      title: "明确当前支线的行动立场",
    },
    {
      label: "把既定立场变成实际行动",
      description: "沿已经形成的立场再推进一步，让当前线程不能回到原先的静止点。",
      action: "我沿着刚才确定的立场采取下一项实际行动，不让局势退回原点。",
      title: "把当前支线推进到下一阶段",
    },
    {
      label: "迫使当前分歧进入决定阶段",
      description: "停止试探，对当前线程作出会引发回应或转向的决定。",
      action: "我停止试探，对眼前的分歧作出明确决定，要求局势现在就给出回应。",
      title: "迫使当前支线进入决定阶段",
    },
  ][phase]!;
  const advance = progressFor({
    channels: ["thread", "consequence", ...(momentumOperations.length ? ["state" as const] : [])],
    threadIds: [focus.linkId],
    noveltyKey: `decisive-step:${focus.linkId}:stage-${phase}`,
  });
  const redirect = progressFor({
    channels: ["scene", "thread", "consequence"],
    threadIds: [focus.linkId],
    noveltyKey: `redirect:${scene.key}`,
    scene: { kind: "explore", label: "与当前方向不同的邻近区域", beat: scene.beat + 1 },
  });
  return [
    {
      label: decisiveCopy.label,
      description: decisiveCopy.description,
      action: decisiveCopy.action,
      intent: "act",
      progressChannels: [...advance.channels],
      threadIds: [focus.id],
      candidate: playerActionCandidateSchema.parse({ title: decisiveCopy.title, participants: [], preconditions: [], proposedDelta: { version: 1, operations: momentumOperations }, requiresKnowledge: [], forbidsKnowledge: [] }),
      authorizedKnowledgeClaimIds: [],
      progress: advance,
      score: 0.6,
    },
    {
      label: "换一个方向建立支线",
      description: "保留现有压力，同时用真实场景转移打开另一条可追踪路径。",
      action: "我换一个方向离开当前落点，寻找一条不同但可以继续推进的路径。",
      intent: "act",
      progressChannels: [...redirect.channels],
      threadIds: [focus.id],
      candidate: playerActionCandidateSchema.parse({ title: "换一个方向建立新的场景支线", participants: [], preconditions: [], proposedDelta: { version: 1, operations: [] }, requiresKnowledge: [], forbidsKnowledge: [] }),
      authorizedKnowledgeClaimIds: [],
      progress: redirect,
      score: 0.55,
    },
  ];
}

function progressFor(input: Omit<NarrativeProgress, "version">): NarrativeProgress {
  return {
    version: 1,
    ...input,
    channels: [...new Set(input.channels)],
    threadIds: [...new Set(input.threadIds)],
  };
}

function nextMomentumOperation(scoped: ActorScopedActionContext, actorId: string): StateOperation[] {
  if (!scoped.writableStateFields.some((field) => field.key === "character.momentum")) return [];
  const current = typeof scoped.selfState["character.momentum"] === "number"
    ? scoped.selfState["character.momentum"]
    : 0;
  if (!Number.isFinite(current) || current >= 3) return [];
  return [{ op: "set", entityId: actorId, field: "character.momentum", value: Math.min(3, current + 1) }];
}

function threadStage(
  threadId: string,
  history: Awaited<ReturnType<typeof committedHistory>>,
): number {
  return history.reduce((count, entry) =>
    count + (entry.event.progress?.threadIds.includes(threadId) ? 1 : 0), 0);
}

function opaqueThreadId(value: string): string {
  return `thread-${contentHash(value).slice(0, 24)}`;
}

function dedupeThreads(threads: readonly InternalThread[]): InternalThread[] {
  const byLink = new Map<string, InternalThread>();
  for (const thread of [...threads].sort((left, right) => right.pressure - left.pressure || left.linkId.localeCompare(right.linkId))) {
    if (!byLink.has(thread.linkId)) byLink.set(thread.linkId, thread);
  }
  return [...byLink.values()].slice(0, 6);
}

function goalVisibleInCurrentPhase(
  goal: CharacterGoal,
  history: Awaited<ReturnType<typeof committedHistory>>,
  presentEntityIds: readonly string[],
): boolean {
  if (goal.activation || goal.requiresKnowledge.length > 0) return true;
  if (history.some((entry) => entry.event.progress?.threadIds.includes(`goal-${goal.id}`))) return true;
  if (!presentEntityIds.includes(goal.actorId)) return false;
  return history.slice(-12).some((entry) =>
    entry.event.participants.includes(goal.actorId)
    && entry.event.evidence.some((eventEvidence) => goal.evidence.some((goalEvidence) => evidenceOverlaps(eventEvidence, goalEvidence))));
}

function evidenceOverlaps(
  left: { span: { sourceId: string; startLine: number; endLine: number } },
  right: { span: { sourceId: string; startLine: number; endLine: number } },
): boolean {
  return left.span.sourceId === right.span.sourceId
    && left.span.startLine <= right.span.endLine
    && left.span.endLine >= right.span.startLine;
}

import { z } from "zod";
import { commitKnowledgeAwareAction, type KnowledgeAwareAction } from "./action-gate.js";
import { contentHash } from "./canonical.js";
import type { WorldEngine } from "./engine.js";
import { isActionableKnowledge, KnowledgeProjector } from "./knowledge.js";
import {
  claimSchema,
  entityKindSchema,
  eventProposalSchema,
  idSchema,
  knowledgeDeltaSchema,
  knowledgeStatusSchema,
  narrativeProgressSchema,
  predicateSchema,
  stateDeltaSchema,
  stateFieldSpecSchema,
  stateValueSchema,
  type CommitId,
  type Entity,
  type EntityId,
  type EventProposal,
  type NarrativeProgress,
  type ProgressChannel,
  type Predicate,
  type StoryTime,
  type StateFieldSpec,
  type StateValue,
  type ValidationIssue,
  type ValidationReport,
} from "./model.js";
import { NarrativeRenderer } from "./narrative.js";
import type { CanonicalChoiceResolution } from "./runtime.js";
import { committedHistory, projectActorScene } from "./scene.js";

/**
 * The model-facing action shape deliberately omits every authority-bearing
 * EventProposal field. The host supplies identity, branch/head, source, actor,
 * time, causal ancestry, and evidence after this candidate is captured.
 */
export const playerActionCandidateSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    participants: z.array(idSchema).default([]),
    preconditions: z.array(predicateSchema).default([]),
    proposedDelta: stateDeltaSchema,
    proposedKnowledge: knowledgeDeltaSchema.optional(),
    requiresKnowledge: z.array(idSchema).default([]),
    forbidsKnowledge: z.array(idSchema).default([]),
  })
  .strict();
export type PlayerActionCandidate = z.infer<typeof playerActionCandidateSchema>;

const actorScopedClaimSchema = claimSchema.omit({ evidence: true });
const actorScopedKnowledgeSchema = z
  .object({
    claimId: idSchema,
    status: knowledgeStatusSchema,
    confidence: z.number().min(0).max(1),
    sourceActorId: idSchema.optional(),
    claim: actorScopedClaimSchema.optional(),
  })
  .strict();

const actorScopedEntitySchema = z
  .object({
    id: idSchema,
    kind: entityKindSchema,
    name: z.string().min(1),
  })
  .strict();

/**
 * This is the complete serializable context permitted at the player-action
 * model boundary. It contains no WorldState, frontier, canonical event list,
 * character goals/models, source evidence, or unacquired claims.
 */
export const actorScopedActionContextSchema = z
  .object({
    actorId: idSchema,
    atCommit: idSchema,
    selfState: z.record(z.string(), stateValueSchema),
    ownedEntityState: z.record(idSchema, z.record(z.string(), stateValueSchema)),
    knowledge: z.array(actorScopedKnowledgeSchema),
    presentEntities: z.array(actorScopedEntitySchema),
    referenceableEntities: z.array(actorScopedEntitySchema),
    writableEntityIds: z.array(idSchema),
    writableStateFields: z.array(stateFieldSpecSchema),
  })
  .strict();
export type ActorScopedActionContext = z.infer<typeof actorScopedActionContextSchema>;

export type PlayerActionTranslationInput = Readonly<{
  utterance: string;
  context: ActorScopedActionContext;
}>;

export type SafePlayerIntent = "observe" | "reflect" | "wait";

/**
 * Convert a narrow host-owned intent without asking a model to invent state
 * predicates. The progress gate still decides whether the current scene can
 * support it; for example, unpressured waiting is rejected instead of becoming
 * an endless empty commit.
 */
export function deterministicPlayerIntentCandidate(
  intent: SafePlayerIntent,
  input: PlayerActionTranslationInput,
): PlayerActionCandidate {
  const titles: Record<SafePlayerIntent, string> = {
    observe: "观察当前场景",
    reflect: "整理已知线索",
    wait: "短暂等待并留意变化",
  };
  return playerActionCandidateSchema.parse({
    title: titles[intent],
    participants: input.context.presentEntities
      .map((entity) => entity.id)
      .filter((entityId) => entityId !== input.context.actorId),
    preconditions: [],
    proposedDelta: { version: 1, operations: [] },
    requiresKnowledge: [],
    forbidsKnowledge: [],
  });
}

/** A translator may be model-backed, but its only world input is actor-scoped. */
export type PlayerActionTranslator = (
  input: PlayerActionTranslationInput,
) => Promise<unknown> | unknown;

export const playerTurnInputSchema = z
  .object({
    branchId: idSchema,
    sourceId: idSchema.optional(),
    actorId: idSchema,
    utterance: z.string().trim().min(1).max(20_000),
  })
  .strict();
export type PlayerTurnInput = z.infer<typeof playerTurnInputSchema>;

export type PlayerTurnStage = "translation" | "scope" | "knowledge" | "engine" | "committed";

export type PlayerTurnResult = {
  accepted: boolean;
  stage: PlayerTurnStage;
  branchId: string;
  actorId: string;
  previousHead: CommitId;
  newHead: CommitId;
  issues: ValidationIssue[];
  contextBefore: ActorScopedActionContext;
  contextAfter: ActorScopedActionContext;
  renderedText: string;
  candidate?: PlayerActionCandidate;
  proposal?: EventProposal;
  validation?: ValidationReport;
  eventHash?: string;
  progressCertificate?: PlayerProgressCertificate;
};

export type PlayerProgressCertificate = {
  channels: ProgressChannel[];
  threadIds: string[];
  noveltyKey: string;
  effectiveStateOperations: number;
  knowledgeOperations: number;
  sceneChanged: boolean;
};

export type PlayerTurnAuthority = Readonly<{
  intent?: "act" | SafePlayerIntent;
  affordanceId?: string;
  progress?: NarrativeProgress;
  authorizedKnowledgeClaimIds?: readonly string[];
}>;

export type PlayerTurnRender = (input: Readonly<{
  branchId: string;
  commitId: CommitId;
  actorId: EntityId;
}>) => Promise<string> | string;

export type PlayerCanonResolver = (proposal: EventProposal) => Promise<CanonicalChoiceResolution> | CanonicalChoiceResolution;

/**
 * Derive a model-safe view from committed actor knowledge at one commit.
 * Canonical context is used only to resolve names and field types for IDs that
 * are reachable from self state/acquired knowledge or explicitly named by the
 * user. Current WorldState contributes only the ownership fact needed to prove
 * which artifacts the actor may control; no other entity state is exposed.
 */
export async function buildActorScopedActionContext(
  engine: WorldEngine,
  actorId: EntityId,
  commitId: CommitId,
  utterance?: string,
  sourceId?: string,
): Promise<ActorScopedActionContext> {
  const [context, view, worldState, scene] = await Promise.all([
    engine.contextForCommit(commitId),
    new KnowledgeProjector(engine).view(actorId, commitId),
    engine.projector.project(commitId),
    projectActorScene(engine, actorId, commitId, sourceId),
  ]);
  const referenceable = new Set<EntityId>([actorId]);
  const present = new Set<EntityId>([actorId]);
  const writable = new Set<EntityId>([actorId]);
  const ownedEntityState: Record<EntityId, Record<string, StateValue>> = {};
  const visibleKnowledge = sourceId
    ? view.knowledge.filter((entry) => entry.claim?.evidence.some((reference) => reference.span.sourceId === sourceId))
    : view.knowledge;

  for (const participant of scene.presentEntityIds) {
    const entity = context.entities.get(participant);
    if (!entity || !belongsToSource(entity, sourceId)) continue;
    present.add(participant);
    referenceable.add(participant);
  }

  for (const [field, value] of Object.entries(view.selfState)) {
    const spec = context.stateSchema.get(field);
    if (spec.valueType === "entity-ref" && typeof value === "string") addExistingEntity(referenceable, value, context.entities, sourceId);
    if (spec.valueType === "entity-ref-set" && Array.isArray(value)) {
      for (const item of value) addExistingEntity(referenceable, item, context.entities, sourceId);
    }
  }

  for (const entry of visibleKnowledge) {
    if (entry.fact.sourceActorId) addExistingEntity(referenceable, entry.fact.sourceActorId, context.entities, sourceId);
    if (!entry.claim) continue;
    addExistingEntity(referenceable, entry.claim.subject, context.entities, sourceId);
    if (entry.claim.speaker) addExistingEntity(referenceable, entry.claim.speaker, context.entities, sourceId);
    addClaimObjectEntities(referenceable, entry.claim.object, context.entities, sourceId);
  }

  if (utterance) {
    for (const entity of context.entities.values()) {
      if (!belongsToSource(entity, sourceId)) continue;
      if ([entity.canonicalName, ...entity.aliases].some((name) => explicitlyMentions(utterance, name))) {
        referenceable.add(entity.id);
      }
    }
  }

  for (const entity of context.entities.values()) {
    if (entity.kind !== "artifact") continue;
    if (!belongsToSource(entity, sourceId)) continue;
    if (worldState.values[entity.id]?.["artifact.owner"] !== actorId) continue;
    referenceable.add(entity.id);
    writable.add(entity.id);
    ownedEntityState[entity.id] = { "artifact.owner": actorId };
  }

  const referenceableEntities = [...referenceable]
    .map((id) => context.entities.get(id))
    .filter((entity): entity is NonNullable<typeof entity> => Boolean(entity))
    .map((entity) => ({ id: entity.id, kind: entity.kind, name: entity.canonicalName }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const presentEntities = referenceableEntities.filter((entity) => present.has(entity.id));
  const writableKinds = new Set(
    [...writable]
      .map((id) => context.entities.get(id)?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind)),
  );
  const writableStateFields = context.stateSchema
    .list()
    .filter((spec) => spec.appliesTo.some((kind) => writableKinds.has(kind)));
  const knowledge = visibleKnowledge.map((entry) => ({
    claimId: entry.fact.claimId,
    status: entry.fact.status,
    confidence: entry.fact.confidence,
    ...(entry.fact.sourceActorId ? { sourceActorId: entry.fact.sourceActorId } : {}),
    ...(entry.claim
      ? {
          claim: {
            id: entry.claim.id,
            subject: entry.claim.subject,
            predicate: entry.claim.predicate,
            object: structuredClone(entry.claim.object),
            epistemicType: entry.claim.epistemicType,
            ...(entry.claim.speaker ? { speaker: entry.claim.speaker } : {}),
          },
        }
      : {}),
  }));

  return actorScopedActionContextSchema.parse({
    actorId,
    atCommit: commitId,
    selfState: structuredClone(view.selfState),
    ownedEntityState,
    knowledge,
    presentEntities,
    referenceableEntities,
    writableEntityIds: [actorId, ...[...writable].filter((id) => id !== actorId).sort()],
    writableStateFields,
  });
}

/**
 * Fail-closed capability validation for a model candidate. Phase-one player
 * actions may write only the selected character and artifacts currently owned
 * by that character. They may reference only IDs already present in the
 * actor-scoped context and may not alter world rules.
 */
export function validatePlayerActionScope(
  candidateInput: PlayerActionCandidate,
  actorContextInput: ActorScopedActionContext,
  authorizedKnowledgeClaimIds: ReadonlySet<string> = new Set(),
): ValidationIssue[] {
  const candidate = playerActionCandidateSchema.parse(candidateInput);
  const actorContext = actorScopedActionContextSchema.parse(actorContextInput);
  const issues: ValidationIssue[] = [];
  const referenceable = new Set(actorContext.referenceableEntities.map((entity) => entity.id));
  const writable = new Set(actorContext.writableEntityIds);
  const visibleClaims = new Set(actorContext.knowledge.map((entry) => entry.claimId));
  const fieldSpecs = new Map(actorContext.writableStateFields.map((spec) => [spec.key, spec]));
  const entityKinds = new Map(actorContext.referenceableEntities.map((entity) => [entity.id, entity.kind]));

  for (let index = 0; index < candidate.participants.length; index += 1) {
    requireReferenceable(candidate.participants[index]!, `participants.${index}`, referenceable, issues);
  }
  for (let index = 0; index < candidate.preconditions.length; index += 1) {
    validatePredicateScope(candidate.preconditions[index]!, `preconditions.${index}`, writable, referenceable, fieldSpecs, entityKinds, issues);
  }
  for (let index = 0; index < candidate.proposedDelta.operations.length; index += 1) {
    const operation = candidate.proposedDelta.operations[index]!;
    const operationPath = `proposedDelta.operations.${index}`;
    if (operation.op === "activate-rule" || operation.op === "deactivate-rule") {
      issues.push(issue("PLAYER_RULE_MUTATION_FORBIDDEN", "Player action translation cannot activate or deactivate world rules", operationPath));
      continue;
    }
    if (!writable.has(operation.entityId)) {
      issues.push(issue("PLAYER_WRITE_OUT_OF_SCOPE", `Player action cannot write entity ${operation.entityId}`, `${operationPath}.entityId`));
    }
    const spec = fieldSpecs.get(operation.field);
    if (!spec) {
      issues.push(issue("PLAYER_FIELD_OUT_OF_SCOPE", `Player action cannot write field ${operation.field}`, `${operationPath}.field`));
      continue;
    }
    const entityKind = entityKinds.get(operation.entityId);
    if (!entityKind || !spec.appliesTo.includes(entityKind)) {
      issues.push(issue("PLAYER_FIELD_OUT_OF_SCOPE", `Field ${operation.field} does not apply to ${operation.entityId}`, `${operationPath}.field`));
      continue;
    }
    if (operation.op === "set") validateStateValueReferences(operation.value, spec, `${operationPath}.value`, referenceable, issues);
    if (operation.op === "add-member" || operation.op === "remove-member") {
      requireReferenceable(operation.member, `${operationPath}.member`, referenceable, issues);
    }
  }

  for (let index = 0; index < (candidate.proposedKnowledge?.operations.length ?? 0); index += 1) {
    const operation = candidate.proposedKnowledge!.operations[index]!;
    const operationPath = `proposedKnowledge.operations.${index}`;
    if (operation.actorId !== actorContext.actorId) {
      issues.push(issue("PLAYER_KNOWLEDGE_ACTOR_OUT_OF_SCOPE", `Player action cannot mutate knowledge for ${operation.actorId}`, `${operationPath}.actorId`));
    }
    if (!visibleClaims.has(operation.claimId) && !authorizedKnowledgeClaimIds.has(operation.claimId)) {
      issues.push(issue("PLAYER_KNOWLEDGE_CLAIM_OUT_OF_SCOPE", `Claim ${operation.claimId} is not in the actor view`, `${operationPath}.claimId`));
    }
    if (operation.op === "learn" && operation.sourceActorId) {
      requireReferenceable(operation.sourceActorId, `${operationPath}.sourceActorId`, referenceable, issues);
    }
  }

  for (const [field, values] of [
    ["requiresKnowledge", candidate.requiresKnowledge],
    ["forbidsKnowledge", candidate.forbidsKnowledge],
  ] as const) {
    values.forEach((claimId, index) => {
      if (!visibleClaims.has(claimId)) {
        issues.push(issue("PLAYER_KNOWLEDGE_CLAIM_OUT_OF_SCOPE", `Claim ${claimId} is not in the actor view`, `${field}.${index}`));
      }
    });
  }
  return issues;
}

/**
 * A model may condition an action only on actor-visible values that actually
 * exist in the sparse committed projection. Missing fields are unknown, not a
 * license to invent a positive precondition. Known-false preconditions are
 * rejected before the engine so the UI can explain/recover from the proposal
 * without presenting a generic commit failure.
 */
export function validatePlayerActionGrounding(
  candidateInput: PlayerActionCandidate,
  actorContextInput: ActorScopedActionContext,
): ValidationIssue[] {
  const candidate = playerActionCandidateSchema.parse(candidateInput);
  const actorContext = actorScopedActionContextSchema.parse(actorContextInput);
  const values = new Map<string, Readonly<Record<string, StateValue>>>([
    [actorContext.actorId, actorContext.selfState],
    ...Object.entries(actorContext.ownedEntityState),
  ]);
  const issues: ValidationIssue[] = [];
  candidate.preconditions.forEach((predicate, index) => {
    const evaluated = evaluateVisiblePredicate(predicate, values);
    if (!evaluated.known) {
      issues.push(issue(
        "PLAYER_PRECONDITION_UNGROUNDED",
        "Player action precondition depends on a field that is absent from the actor-visible committed state",
        `preconditions.${index}`,
      ));
    } else if (!evaluated.value) {
      issues.push(issue(
        "PLAYER_PRECONDITION_UNSATISFIED",
        "Player action precondition is false in the actor-visible committed state",
        `preconditions.${index}`,
      ));
    }
  });
  return issues;
}

/**
 * Host-only physical interaction gate. Naming an entity makes its identity
 * referenceable, but never proves that a distant character is present. The
 * full projected state is consulted only after model translation and is not
 * returned to the model.
 */
export async function validatePlayerActionSpatialScope(
  engine: WorldEngine,
  candidateInput: PlayerActionCandidate,
  actorId: EntityId,
  commitId: CommitId,
): Promise<ValidationIssue[]> {
  const candidate = playerActionCandidateSchema.parse(candidateInput);
  const [context, state] = await Promise.all([
    engine.contextForCommit(commitId),
    engine.projector.project(commitId),
  ]);
  const interactionCharacters = new Set<EntityId>();
  for (const participant of candidate.participants) {
    if (participant !== actorId && context.entities.get(participant)?.kind === "character") interactionCharacters.add(participant);
  }
  for (const operation of candidate.proposedDelta.operations) {
    if (
      operation.op === "set"
      && operation.field === "artifact.owner"
      && typeof operation.value === "string"
      && operation.value !== actorId
      && context.entities.get(operation.value)?.kind === "character"
    ) {
      interactionCharacters.add(operation.value);
    }
  }
  for (const operation of candidate.proposedKnowledge?.operations ?? []) {
    if (operation.op === "learn" && operation.sourceActorId && operation.sourceActorId !== actorId) {
      interactionCharacters.add(operation.sourceActorId);
    }
  }
  const actorLocation = state.values[actorId]?.["character.location"];
  const present = new Set((await projectActorScene(engine, actorId, commitId)).presentEntityIds);
  const issues: ValidationIssue[] = [];
  for (const characterId of [...interactionCharacters].sort()) {
    const characterLocation = state.values[characterId]?.["character.location"];
    if (typeof actorLocation === "string" && typeof characterLocation === "string" && actorLocation !== characterLocation) {
      issues.push(issue(
        "PLAYER_REMOTE_INTERACTION_FORBIDDEN",
        `Player action cannot physically interact with ${characterId} because committed locations prove that character is elsewhere`,
        "participants",
      ));
    } else if (
      (typeof actorLocation !== "string" || typeof characterLocation !== "string")
      && !present.has(characterId)
    ) {
      issues.push(issue(
        "PLAYER_SPATIAL_CONTEXT_UNKNOWN",
        `Player action cannot yet prove that ${characterId} is present; no contradictory remote location was inferred`,
        "participants",
      ));
    }
  }
  return issues;
}

/** Construct the only EventProposal that may cross the world-engine boundary. */
export function playerActionToKnowledgeAwareAction(input: {
  branchId: string;
  actorId: EntityId;
  expectedParentCommit: CommitId;
  utterance: string;
  candidate: PlayerActionCandidate;
  proposedTime?: StoryTime;
}): KnowledgeAwareAction {
  const candidate = playerActionCandidateSchema.parse(input.candidate);
  const proposalId = `player-${contentHash({
    branchId: input.branchId,
    actorId: input.actorId,
    expectedParentCommit: input.expectedParentCommit,
    utterance: input.utterance,
    candidate,
  }).slice(0, 24)}`;
  const proposal = eventProposalSchema.parse({
    proposalId,
    branchId: input.branchId,
    expectedParentCommit: input.expectedParentCommit,
    source: "player",
    actorId: input.actorId,
    title: candidate.title,
    participants: [...new Set([input.actorId, ...candidate.participants])],
    proposedTime: input.proposedTime ?? { kind: "unknown" },
    preconditions: candidate.preconditions,
    proposedDelta: candidate.proposedDelta,
    ...(candidate.proposedKnowledge ? { proposedKnowledge: candidate.proposedKnowledge } : {}),
    causalParents: [],
    evidence: [],
  });
  return {
    proposal,
    requiresKnowledge: candidate.requiresKnowledge,
    forbidsKnowledge: candidate.forbidsKnowledge,
  };
}

/**
 * One player turn: scoped context -> untrusted translation -> capability gate
 * -> knowledge gate -> deterministic engine validation/commit -> actor render.
 */
export class PlayerTurnService {
  private readonly render: PlayerTurnRender;

  constructor(
    private readonly engine: WorldEngine,
    private readonly translator: PlayerActionTranslator,
    render?: PlayerTurnRender,
    private readonly resolveCanon?: PlayerCanonResolver,
    private readonly beforeCommit?: () => void,
  ) {
    if (render) this.render = render;
    else {
      const renderer = new NarrativeRenderer(engine);
      this.render = ({ branchId, commitId, actorId }) =>
        renderer.render(branchId, commitId, { pointOfView: "actor", actorId });
    }
  }

  async turn(inputValue: PlayerTurnInput, authority: PlayerTurnAuthority = {}): Promise<PlayerTurnResult> {
    const input = playerTurnInputSchema.parse(inputValue);
    const previousHead = await this.engine.branches.readHead(input.branchId);
    const [contextBefore, storyTime, worldContext] = await Promise.all([
      buildActorScopedActionContext(this.engine, input.actorId, previousHead, input.utterance, input.sourceId),
      latestCommittedStoryTime(this.engine, previousHead),
      this.engine.contextForCommit(previousHead),
    ]);
    let translated: unknown;
    try {
      translated = await this.translator(deepFreeze({
        utterance: input.utterance,
        context: structuredClone(contextBefore),
      }));
    } catch (error) {
      return this.rejected(input, previousHead, contextBefore, "translation", [
        issue("PLAYER_ACTION_TRANSLATION_FAILED", error instanceof Error ? error.message : String(error)),
      ]);
    }

    const parsedCandidate = playerActionCandidateSchema.safeParse(translated);
    if (!parsedCandidate.success) {
      return this.rejected(
        input,
        previousHead,
        contextBefore,
        "translation",
        parsedCandidate.error.issues.map((entry) => issue(
          "INVALID_PLAYER_ACTION_CANDIDATE",
          entry.message,
          entry.path.length ? entry.path.join(".") : undefined,
        )),
      );
    }
    const normalization = normalizePlayerCandidate(parsedCandidate.data, contextBefore, worldContext.entities, input.utterance);
    const candidate = normalization.candidate;
    const authorizedKnowledgeClaimIds = new Set(authority.authorizedKnowledgeClaimIds ?? []);
    let action = playerActionToKnowledgeAwareAction({
      branchId: input.branchId,
      actorId: input.actorId,
      expectedParentCommit: previousHead,
      utterance: input.utterance,
      candidate,
      ...(storyTime ? { proposedTime: storyTime } : {}),
    });
    const scopeIssues = validatePlayerActionScope(candidate, contextBefore, authorizedKnowledgeClaimIds);
    if (scopeIssues.length) {
      return this.rejected(input, previousHead, contextBefore, "scope", scopeIssues, candidate, action.proposal);
    }
    const groundingIssues = validatePlayerActionGrounding(candidate, contextBefore);
    if (groundingIssues.length) {
      return this.rejected(input, previousHead, contextBefore, "scope", groundingIssues, candidate, action.proposal);
    }
    const spatialIssues = await validatePlayerActionSpatialScope(this.engine, candidate, input.actorId, previousHead);
    if (spatialIssues.length) {
      return this.rejected(input, previousHead, contextBefore, "scope", spatialIssues, candidate, action.proposal);
    }
    let resolution: CanonicalChoiceResolution = { supersedesCanonicalEventIds: [] };
    if (this.resolveCanon) {
      resolution = await this.resolveCanon(action.proposal);
      const supersedesCanonicalEventIds = [...new Set(resolution.supersedesCanonicalEventIds)].sort();
      if (supersedesCanonicalEventIds.length || resolution.realizedPossibilityId || resolution.causalParentEventIds?.length) {
        action = {
          ...action,
          proposal: eventProposalSchema.parse({
            ...action.proposal,
            causalParents: [...new Set([
              ...action.proposal.causalParents,
              ...(resolution.causalParentEventIds ?? []),
            ])],
            ...(supersedesCanonicalEventIds.length ? { supersedesCanonicalEventIds } : {}),
            ...(resolution.realizedPossibilityId ? { possibilityId: resolution.realizedPossibilityId } : {}),
          }),
        };
      }
    }

    let progress: { value: NarrativeProgress; certificate: PlayerProgressCertificate };
    try {
      progress = await derivePlayerProgress(this.engine, input, candidate, contextBefore, resolution, authority, normalization.generalizedDestinationLabel);
    } catch (error) {
      return this.rejected(input, previousHead, contextBefore, "scope", [
        issue(
          error instanceof PlayerProgressError ? error.code : "INVALID_PLAYER_PROGRESS_AUTHORITY",
          error instanceof Error ? error.message : String(error),
        ),
      ], candidate, action.proposal);
    }
    action = {
      ...action,
      proposal: eventProposalSchema.parse({ ...action.proposal, progress: progress.value }),
    };

    this.beforeCommit?.();
    const committed = await commitKnowledgeAwareAction(this.engine, action);
    if (!committed.gate.accepted) {
      return this.rejected(
        input,
        previousHead,
        contextBefore,
        "knowledge",
        committed.gate.errors,
        candidate,
        action.proposal,
        undefined,
        committed.gate.evaluatedAtCommit,
      );
    }
    if (!committed.result) {
      return this.rejected(
        input,
        previousHead,
        contextBefore,
        "engine",
        [issue("PLAYER_ACTION_COMMIT_MISSING", "Player action passed its gate but produced no engine result")],
        candidate,
        action.proposal,
      );
    }
    if (!committed.result.report.accepted) {
      return this.rejected(
        input,
        previousHead,
        contextBefore,
        "engine",
        committed.result.report.errors,
        candidate,
        action.proposal,
        committed.result.report,
        committed.result.newHead,
      );
    }

    const newHead = committed.result.newHead;
    const contextAfter = await buildActorScopedActionContext(this.engine, input.actorId, newHead, undefined, input.sourceId);
    const renderedText = await this.renderAt(input.branchId, input.actorId, newHead);
    return {
      accepted: true,
      stage: "committed",
      branchId: input.branchId,
      actorId: input.actorId,
      previousHead,
      newHead,
      issues: [...normalization.warnings, ...committed.result.report.warnings],
      contextBefore,
      contextAfter,
      renderedText,
      candidate,
      proposal: action.proposal,
      validation: committed.result.report,
      progressCertificate: progress.certificate,
      ...(committed.result.eventHash ? { eventHash: committed.result.eventHash } : {}),
    };
  }

  private async rejected(
    input: PlayerTurnInput,
    previousHead: CommitId,
    contextBefore: ActorScopedActionContext,
    stage: Exclude<PlayerTurnStage, "committed">,
    initialIssues: ValidationIssue[],
    candidate?: PlayerActionCandidate,
    proposal?: EventProposal,
    validation?: ValidationReport,
    evaluatedHead?: CommitId,
  ): Promise<PlayerTurnResult> {
    const newHead = evaluatedHead ?? (await this.engine.branches.readHead(input.branchId));
    const issues = [...initialIssues];
    if (newHead !== previousHead && !issues.some((entry) => entry.code === "STALE_PARENT")) {
      issues.push(issue("STALE_PARENT", `Player turn began at ${previousHead}, current head is ${newHead}`));
    }
    const contextAfter = newHead === previousHead
      ? contextBefore
      : await buildActorScopedActionContext(this.engine, input.actorId, newHead, undefined, input.sourceId);
    const renderedText = await this.renderAt(input.branchId, input.actorId, newHead);
    return {
      accepted: false,
      stage,
      branchId: input.branchId,
      actorId: input.actorId,
      previousHead,
      newHead,
      issues,
      contextBefore,
      contextAfter,
      renderedText,
      ...(candidate ? { candidate } : {}),
      ...(proposal ? { proposal } : {}),
      ...(validation ? { validation } : {}),
    };
  }

  private async renderAt(branchId: string, actorId: EntityId, commitId: CommitId): Promise<string> {
    const before = await this.engine.branches.readHead(branchId);
    if (before !== commitId) throw new Error(`Cannot render player turn at stale commit ${commitId}; current head is ${before}`);
    const rendered = await this.render(deepFreeze({ branchId, actorId, commitId }));
    const after = await this.engine.branches.readHead(branchId);
    if (after !== before) throw new Error("Player turn renderer mutated branch truth");
    return rendered;
  }
}

class PlayerProgressError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PlayerProgressError";
  }
}

function normalizePlayerCandidate(
  candidateInput: PlayerActionCandidate,
  context: ActorScopedActionContext,
  worldEntities: ReadonlyMap<string, Entity>,
  utterance: string,
): {
  candidate: PlayerActionCandidate;
  warnings: ValidationIssue[];
  generalizedDestinationLabel?: string;
} {
  const candidate = structuredClone(playerActionCandidateSchema.parse(candidateInput));
  const referenceable = new Set(context.referenceableEntities.map((entity) => entity.id));
  const unknownDestinations = new Set<string>();
  for (const operation of candidate.proposedDelta.operations) {
    if (
      operation.op === "set"
      && operation.entityId === context.actorId
      && operation.field === "character.location"
      && typeof operation.value === "string"
      && !referenceable.has(operation.value)
      && !worldEntities.has(operation.value)
    ) unknownDestinations.add(operation.value);
  }
  if (!unknownDestinations.size || !MOVEMENT_PATTERN.test(utterance)) return { candidate, warnings: [] };

  candidate.proposedDelta.operations = candidate.proposedDelta.operations.filter((operation) => !(
    operation.op === "set"
    && operation.entityId === context.actorId
    && operation.field === "character.location"
    && typeof operation.value === "string"
    && unknownDestinations.has(operation.value)
  ));
  candidate.participants = candidate.participants.filter((participantId) => !unknownDestinations.has(participantId));
  const generalizedDestinationLabel = extractMovementLabel(utterance) ?? "一个尚未命名的邻近场景";
  return {
    candidate: playerActionCandidateSchema.parse(candidate),
    warnings: [issue(
      "PLAYER_DESTINATION_GENERALIZED",
      `The requested destination was not a stable canonical entity; it will be committed as the open scene '${generalizedDestinationLabel}' instead of being rejected or invented as canon.`,
      "proposedDelta.operations",
    )],
    generalizedDestinationLabel,
  };
}

async function derivePlayerProgress(
  engine: WorldEngine,
  input: PlayerTurnInput,
  candidate: PlayerActionCandidate,
  context: ActorScopedActionContext,
  resolution: CanonicalChoiceResolution,
  authority: PlayerTurnAuthority,
  generalizedDestinationLabel?: string,
): Promise<{ value: NarrativeProgress; certificate: PlayerProgressCertificate }> {
  const [state, scene, worldContext, history] = await Promise.all([
    engine.projector.project(context.atCommit),
    projectActorScene(engine, input.actorId, context.atCommit, input.sourceId),
    engine.contextForCommit(context.atCommit),
    committedHistory(engine, context.atCommit),
  ]);
  const effectiveOperations = candidate.proposedDelta.operations.filter((operation) => stateOperationChangesState(operation, state));
  const knowledgeOperations = candidate.proposedKnowledge?.operations.length ?? 0;
  const intent = authority.intent ?? inferPlayerIntent(input.utterance);
  let progress: NarrativeProgress;

  if (authority.progress) {
    const parsed = narrativeProgressSchema.parse(structuredClone(authority.progress));
    const channels = new Set(parsed.channels);
    if (effectiveOperations.length) channels.add("state");
    if (knowledgeOperations) channels.add("knowledge");
    const threadIds = [...new Set([...parsed.threadIds, ...(resolution.threadIds ?? [])])];
    if (threadIds.length) channels.add("thread");
    progress = narrativeProgressSchema.parse({
      ...parsed,
      channels: [...channels],
      threadIds,
    });
  } else {
    const channels = new Set<ProgressChannel>();
    if (effectiveOperations.length) channels.add("state");
    if (knowledgeOperations) channels.add("knowledge");
    if (effectiveOperations.some(isResourceOperation)) channels.add("resource");
    if (effectiveOperations.some(isRelationshipOperation)) channels.add("relationship");

    const characterParticipants = candidate.participants.filter((participantId) =>
      participantId !== input.actorId
      && worldContext.entities.get(participantId)?.kind === "character"
      && scene.presentEntityIds.includes(participantId));
    const threadIds = [...new Set(resolution.threadIds ?? [])];
    if (!threadIds.length) {
      const latest = scene.recentEvents.at(-1);
      threadIds.push(...(latest?.progress?.threadIds.length
        ? latest.progress.threadIds
        : [`emergent-${contentHash({ actorId: input.actorId, scene: scene.key }).slice(0, 24)}`]));
    }

    const knownMovement = candidate.proposedDelta.operations.find((operation) =>
      operation.op === "set"
      && operation.entityId === input.actorId
      && operation.field === "character.location"
      && typeof operation.value === "string");
    const movement = Boolean(generalizedDestinationLabel || knownMovement || MOVEMENT_PATTERN.test(input.utterance));
    let sceneTransition: NarrativeProgress["scene"];
    if (movement) {
      channels.add("scene");
      channels.add("consequence");
      const destinationEntityId = knownMovement?.op === "set" && typeof knownMovement.value === "string"
        ? knownMovement.value
        : undefined;
      const label = generalizedDestinationLabel
        ?? (destinationEntityId ? worldContext.entities.get(destinationEntityId)?.canonicalName : undefined)
        ?? extractMovementLabel(input.utterance)
        ?? "当前场景之外的邻近区域";
      sceneTransition = {
        kind: destinationEntityId ? "arrive" : LEAVING_PATTERN.test(input.utterance) ? "depart" : "explore",
        label,
        ...(destinationEntityId ? { destinationEntityId } : {}),
        beat: scene.beat + 1,
      };
    }

    if (intent === "observe" && knowledgeOperations === 0 && !sceneTransition) {
      channels.add("scene");
      sceneTransition = {
        kind: "stay",
        ...(scene.label ? { label: scene.label } : {}),
        beat: scene.beat + 1,
      };
    }
    if (intent === "reflect") channels.add("plan");
    if (intent === "wait") {
      const groundedPressure = Boolean(
        resolution.threadIds?.length
        || scene.presentEntityIds.some((entityId) => entityId !== input.actorId && worldContext.entities.get(entityId)?.kind === "character")
        || scene.recentEvents.at(-1)?.progress?.channels.some((channel) => channel === "time-pressure" || channel === "consequence"),
      );
      if (!groundedPressure) {
        throw new PlayerProgressError(
          "PLAYER_WAIT_WITHOUT_PRESSURE",
          "Waiting can advance a turn only when a committed local character, consequence, or active canonical thread can respond.",
        );
      }
      channels.add("time-pressure");
      channels.add("consequence");
    }
    if (intent === "act" && characterParticipants.length) {
      channels.add("relationship");
      channels.add("consequence");
    }
    if (intent === "act" && ACTION_CONSEQUENCE_PATTERN.test(input.utterance)) channels.add("consequence");
    if (intent !== "observe" && (channels.size > 0 || threadIds.length)) channels.add("thread");

    if (!channels.size || (channels.size === 1 && channels.has("thread"))) {
      throw new PlayerProgressError(
        "PLAYER_ACTION_NO_PROGRESS",
        "The interpreted action would not change state, knowledge, scene, relationship, plan, pressure, or a grounded narrative consequence.",
      );
    }
    const noveltyKey = semanticNoveltyKey({
      intent,
      utterance: input.utterance,
      participantIds: characterParticipants,
      operationKeys: effectiveOperations.map(operationKey),
      knowledgeClaimIds: candidate.proposedKnowledge?.operations.map((operation) => operation.claimId) ?? [],
      threadIds,
      sceneKey: scene.key,
      movementLabel: sceneTransition?.label,
    });
    progress = narrativeProgressSchema.parse({
      version: 1,
      channels: [...channels],
      threadIds,
      noveltyKey,
      ...(sceneTransition ? { scene: sceneTransition } : {}),
    });
  }

  const repeated = history.some((entry) => entry.event.progress?.noveltyKey === progress.noveltyKey);
  if (repeated && effectiveOperations.length === 0 && knowledgeOperations === 0) {
    throw new PlayerProgressError(
      "PLAYER_ACTION_REPEATS_NO_PROGRESS",
      "This action repeats the same unresolved beat without a new state, knowledge, scene, relationship, plan, pressure, or consequence. Choose a different affordance or make the intended change more concrete.",
    );
  }
  const certificate: PlayerProgressCertificate = {
    channels: [...progress.channels],
    threadIds: [...progress.threadIds],
    noveltyKey: progress.noveltyKey,
    effectiveStateOperations: effectiveOperations.length,
    knowledgeOperations,
    sceneChanged: Boolean(progress.scene),
  };
  return { value: progress, certificate };
}

const MOVEMENT_PATTERN = /(?:离开|出门|出去|走走|走去|走向|前往|去往|径直走|赶往|进入|来到|到达|闲逛|漫步|move|walk|leave|go\s+to|head\s+to|enter)/iu;
const LEAVING_PATTERN = /(?:离开|出门|出去|摔门|leave|walk\s+out|go\s+out)/iu;
const ACTION_CONSEQUENCE_PATTERN = /(?:说|问|答|道歉|拒绝|答应|拿|放|给|推|拉|开|关|坐|站|找|查|做|帮|阻止|攻击|敲|喊|追|躲|买|卖|ask|tell|say|apolog|refuse|accept|take|give|open|close|sit|stand|find|help|stop|attack|knock|call|buy|sell)/iu;

function inferPlayerIntent(utterance: string): "act" | SafePlayerIntent {
  const normalized = utterance.normalize("NFKC").trim();
  if (/^(?:我)?(?:先|仔细|悄悄|认真|再)?(?:观察|查看|环顾|打量|倾听|看看)|^(?:i\s+)?(?:look|observe|listen)\b/iu.test(normalized)) return "observe";
  if (/^(?:我)?(?:先|认真|重新|再)?(?:思考|回想|整理思绪|反省|梳理)|^(?:i\s+)?(?:reflect|think|remember)\b/iu.test(normalized)) return "reflect";
  if (/^(?:我)?(?:先|暂时|什么也不做地)?(?:在[^，。！？,.!?]{1,24})?(?:等待|等一会|静候|按兵不动)|^(?:i\s+)?(?:wait|pause)\b/iu.test(normalized)) return "wait";
  return "act";
}

function extractMovementLabel(utterance: string): string | undefined {
  const normalized = utterance.normalize("NFKC").trim();
  const chinese = normalized.match(/(?:前往|去往|走向|赶往|进入|来到|到达|去|到)([^，。！？,.!?]{1,32})/u)?.[1]
    ?? normalized.match(/(街上|路上|城里|城外|村里|村外|附近|茶馆|酒楼|客栈|市场|河边|院外)/u)?.[1];
  const english = normalized.match(/(?:go|head|walk|move)\s+(?:to|toward|into)\s+([^,.!?]{1,40})/iu)?.[1];
  const label = (chinese ?? english)?.trim().replace(/(?:走走|看看|去看看|并.*)$/u, "").trim();
  return label ? label.slice(0, 80) : undefined;
}

function stateOperationChangesState(
  operation: PlayerActionCandidate["proposedDelta"]["operations"][number],
  state: Awaited<ReturnType<WorldEngine["projector"]["project"]>>,
): boolean {
  if (operation.op === "activate-rule") return !state.activeRuleIds.includes(operation.ruleId);
  if (operation.op === "deactivate-rule") return state.activeRuleIds.includes(operation.ruleId);
  const current = state.values[operation.entityId]?.[operation.field];
  if (operation.op === "set") return JSON.stringify(current) !== JSON.stringify(operation.value);
  if (operation.op === "unset") return current !== undefined;
  if (operation.op === "add-member") return !Array.isArray(current) || !current.includes(operation.member);
  return Array.isArray(current) && current.includes(operation.member);
}

function isResourceOperation(operation: PlayerActionCandidate["proposedDelta"]["operations"][number]): boolean {
  return "field" in operation && (operation.field.startsWith("artifact.") || operation.field === "character.inventory");
}

function isRelationshipOperation(operation: PlayerActionCandidate["proposedDelta"]["operations"][number]): boolean {
  return "field" in operation && (operation.field === "character.relationships" || operation.field === "character.obligations");
}

function operationKey(operation: PlayerActionCandidate["proposedDelta"]["operations"][number]): string {
  if (operation.op === "activate-rule" || operation.op === "deactivate-rule") return `rule:${operation.ruleId}`;
  return `${operation.entityId}:${operation.field}:${operation.op}`;
}

function semanticNoveltyKey(input: {
  intent: "act" | SafePlayerIntent;
  utterance: string;
  participantIds: string[];
  operationKeys: string[];
  knowledgeClaimIds: string[];
  threadIds: string[];
  sceneKey: string;
  movementLabel?: string;
}): string {
  const semanticUtterance = input.utterance.normalize("NFKC").toLocaleLowerCase()
    .replace(/[\s，。！？、,.!?;；:："'“”‘’]/g, "")
    .slice(0, 160);
  const category = input.movementLabel
    ? `move:${input.movementLabel.normalize("NFKC").toLocaleLowerCase()}`
    : input.intent === "wait"
      ? "wait"
      : input.intent === "reflect"
        ? "plan"
        : input.intent === "observe"
          ? `observe:${input.knowledgeClaimIds.sort().join("+")}`
          : semanticUtterance;
  return `player:${contentHash({
    intent: input.intent,
    category,
    participants: [...input.participantIds].sort(),
    operations: [...input.operationKeys].sort(),
    claims: [...input.knowledgeClaimIds].sort(),
    threads: [...input.threadIds].sort(),
    scene: input.sceneKey,
  }).slice(0, 32)}`;
}

function validatePredicateScope(
  predicate: Predicate,
  path: string,
  writable: ReadonlySet<string>,
  referenceable: ReadonlySet<string>,
  fieldSpecs: ReadonlyMap<string, StateFieldSpec>,
  entityKinds: ReadonlyMap<string, StateFieldSpec["appliesTo"][number]>,
  issues: ValidationIssue[],
): void {
  if (predicate.op === "all" || predicate.op === "any") {
    predicate.items.forEach((item, index) => validatePredicateScope(item, `${path}.items.${index}`, writable, referenceable, fieldSpecs, entityKinds, issues));
    return;
  }
  if (predicate.op === "not") {
    validatePredicateScope(predicate.item, `${path}.item`, writable, referenceable, fieldSpecs, entityKinds, issues);
    return;
  }
  if (predicate.op === "rule-active") {
    issues.push(issue("PLAYER_RULE_OBSERVATION_FORBIDDEN", "Actor-scoped action translation cannot inspect active world rules", path));
    return;
  }
  if (predicate.op === "after-step" || predicate.op === "before-step") {
    issues.push(issue("PLAYER_LOGICAL_TIME_OBSERVATION_FORBIDDEN", "Actor-scoped action translation cannot inspect engine logical time", path));
    return;
  }
  if (!writable.has(predicate.entityId)) {
    issues.push(issue("PLAYER_PRECONDITION_OUT_OF_SCOPE", `Player action cannot inspect state for ${predicate.entityId}`, `${path}.entityId`));
  }
  const spec = fieldSpecs.get(predicate.field);
  if (!spec) {
    issues.push(issue("PLAYER_FIELD_OUT_OF_SCOPE", `Player action cannot inspect field ${predicate.field}`, `${path}.field`));
    return;
  }
  const entityKind = entityKinds.get(predicate.entityId);
  if (!entityKind || !spec.appliesTo.includes(entityKind)) {
    issues.push(issue("PLAYER_FIELD_OUT_OF_SCOPE", `Field ${predicate.field} does not apply to ${predicate.entityId}`, `${path}.field`));
    return;
  }
  if (predicate.op === "fact-equals") validateStateValueReferences(predicate.value, spec, `${path}.value`, referenceable, issues);
  if (predicate.op === "entity-in") requireReferenceable(predicate.member, `${path}.member`, referenceable, issues);
}

function validateStateValueReferences(
  value: StateValue,
  spec: StateFieldSpec,
  path: string,
  referenceable: ReadonlySet<string>,
  issues: ValidationIssue[],
): void {
  if (spec.valueType === "entity-ref" && typeof value === "string") requireReferenceable(value, path, referenceable, issues);
  if (spec.valueType === "entity-ref-set" && Array.isArray(value)) {
    value.forEach((entityId, index) => requireReferenceable(entityId, `${path}.${index}`, referenceable, issues));
  }
}

function requireReferenceable(
  entityId: string,
  path: string,
  referenceable: ReadonlySet<string>,
  issues: ValidationIssue[],
): void {
  if (!referenceable.has(entityId)) {
    issues.push(issue("PLAYER_ENTITY_OUT_OF_SCOPE", `Entity ${entityId} is not referenceable from the actor view`, path));
  }
}

function addExistingEntity(
  target: Set<EntityId>,
  value: unknown,
  entities: ReadonlyMap<EntityId, Entity>,
  sourceId?: string,
): void {
  if (typeof value !== "string") return;
  const entity = entities.get(value);
  if (entity && belongsToSource(entity, sourceId)) target.add(value);
}

function addClaimObjectEntities(
  target: Set<EntityId>,
  value: unknown,
  entities: ReadonlyMap<EntityId, Entity>,
  sourceId?: string,
): void {
  if (typeof value === "string") addExistingEntity(target, value, entities, sourceId);
  else if (Array.isArray(value)) for (const item of value) addExistingEntity(target, item, entities, sourceId);
}

function belongsToSource(entity: Entity, sourceId?: string): boolean {
  return !sourceId || entity.evidence.some((reference) => reference.span.sourceId === sourceId);
}

const FIRST_PERSON_ENTITY_ALIASES = new Set([
  "我", "我们", "咱", "咱们", "你", "你们", "他", "他们", "她", "她们", "它", "它们",
]);

function explicitlyMentions(utterance: string, name: string): boolean {
  const needle = name.trim().toLocaleLowerCase();
  if (!needle || FIRST_PERSON_ENTITY_ALIASES.has(needle)) return false;
  const haystack = utterance.toLocaleLowerCase();
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const before = index > 0 ? haystack[index - 1] : undefined;
    const afterIndex = index + needle.length;
    const after = afterIndex < haystack.length ? haystack[afterIndex] : undefined;
    const startsAsciiWord = /^[a-z0-9]$/i.test(needle[0]!);
    const endsAsciiWord = /^[a-z0-9]$/i.test(needle[needle.length - 1]!);
    const beforeBoundary = !startsAsciiWord || before === undefined || !/[a-z0-9]/i.test(before);
    const afterBoundary = !endsAsciiWord || after === undefined || !/[a-z0-9]/i.test(after);
    if (beforeBoundary && afterBoundary) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

type VisiblePredicateEvaluation = { known: boolean; value: boolean };

function evaluateVisiblePredicate(
  predicate: Predicate,
  values: ReadonlyMap<string, Readonly<Record<string, StateValue>>>,
): VisiblePredicateEvaluation {
  if (predicate.op === "all" || predicate.op === "any") {
    const items = predicate.items.map((item) => evaluateVisiblePredicate(item, values));
    if (predicate.op === "all") {
      if (items.some((item) => item.known && !item.value)) return { known: true, value: false };
      return items.every((item) => item.known)
        ? { known: true, value: true }
        : { known: false, value: false };
    }
    if (items.some((item) => item.known && item.value)) return { known: true, value: true };
    return items.every((item) => item.known)
      ? { known: true, value: false }
      : { known: false, value: false };
  }
  if (predicate.op === "not") {
    const item = evaluateVisiblePredicate(predicate.item, values);
    return item.known ? { known: true, value: !item.value } : item;
  }
  if (predicate.op === "rule-active" || predicate.op === "after-step" || predicate.op === "before-step") {
    // These are rejected by the capability scope gate and are not visible
    // values that grounding should attempt to reinterpret.
    return { known: true, value: true };
  }
  const entity = values.get(predicate.entityId);
  if (!entity || !Object.hasOwn(entity, predicate.field)) return { known: false, value: false };
  const current = entity[predicate.field];
  if (predicate.op === "fact-exists") return { known: true, value: current !== undefined };
  if (predicate.op === "fact-equals") {
    return { known: true, value: JSON.stringify(current) === JSON.stringify(predicate.value) };
  }
  return {
    known: true,
    value: Array.isArray(current) && current.includes(predicate.member),
  };
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, ...(path ? { path } : {}) };
}

async function latestCommittedStoryTime(engine: WorldEngine, commitId: CommitId): Promise<StoryTime | undefined> {
  const seen = new Set<string>();
  let cursor: CommitId | undefined = commitId;
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`Commit ancestry cycle detected at ${cursor}`);
    seen.add(cursor);
    const commit = await engine.objects.getCommit(cursor);
    if (commit.logicalTime.storyTime && commit.logicalTime.storyTime.kind !== "unknown") {
      return structuredClone(commit.logicalTime.storyTime);
    }
    cursor = commit.parentCommitId;
  }
  return undefined;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

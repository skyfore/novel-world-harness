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
  predicateSchema,
  stateDeltaSchema,
  stateFieldSpecSchema,
  stateValueSchema,
  type CommitId,
  type EntityId,
  type EventProposal,
  type Predicate,
  type StateFieldSpec,
  type StateValue,
  type ValidationIssue,
  type ValidationReport,
} from "./model.js";
import { NarrativeRenderer } from "./narrative.js";

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

/** A translator may be model-backed, but its only world input is actor-scoped. */
export type PlayerActionTranslator = (
  input: PlayerActionTranslationInput,
) => Promise<unknown> | unknown;

export const playerTurnInputSchema = z
  .object({
    branchId: idSchema,
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
};

export type PlayerTurnRender = (input: Readonly<{
  branchId: string;
  commitId: CommitId;
  actorId: EntityId;
}>) => Promise<string> | string;

export type PlayerSupersessionResolver = (proposal: EventProposal) => Promise<readonly string[]> | readonly string[];

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
): Promise<ActorScopedActionContext> {
  const [context, view, worldState] = await Promise.all([
    engine.contextForCommit(commitId),
    new KnowledgeProjector(engine).view(actorId, commitId),
    engine.projector.project(commitId),
  ]);
  const referenceable = new Set<EntityId>([actorId]);
  const writable = new Set<EntityId>([actorId]);
  const ownedEntityState: Record<EntityId, Record<string, StateValue>> = {};

  for (const [field, value] of Object.entries(view.selfState)) {
    const spec = context.stateSchema.get(field);
    if (spec.valueType === "entity-ref" && typeof value === "string") addExistingEntity(referenceable, value, context.entities);
    if (spec.valueType === "entity-ref-set" && Array.isArray(value)) {
      for (const item of value) addExistingEntity(referenceable, item, context.entities);
    }
  }

  for (const entry of view.knowledge) {
    if (entry.fact.sourceActorId) addExistingEntity(referenceable, entry.fact.sourceActorId, context.entities);
    if (!entry.claim) continue;
    addExistingEntity(referenceable, entry.claim.subject, context.entities);
    if (entry.claim.speaker) addExistingEntity(referenceable, entry.claim.speaker, context.entities);
    addClaimObjectEntities(referenceable, entry.claim.object, context.entities);
  }

  if (utterance) {
    for (const entity of context.entities.values()) {
      if ([entity.canonicalName, ...entity.aliases].some((name) => explicitlyMentions(utterance, name))) {
        referenceable.add(entity.id);
      }
    }
  }

  for (const entity of context.entities.values()) {
    if (entity.kind !== "artifact") continue;
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
  const writableKinds = new Set(
    [...writable]
      .map((id) => context.entities.get(id)?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind)),
  );
  const writableStateFields = context.stateSchema
    .list()
    .filter((spec) => spec.appliesTo.some((kind) => writableKinds.has(kind)));
  const knowledge = view.knowledge.map((entry) => ({
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
    if (!visibleClaims.has(operation.claimId)) {
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
  const issues: ValidationIssue[] = [];
  for (const characterId of [...interactionCharacters].sort()) {
    const characterLocation = state.values[characterId]?.["character.location"];
    if (typeof actorLocation !== "string" || typeof characterLocation !== "string" || actorLocation !== characterLocation) {
      issues.push(issue(
        "PLAYER_REMOTE_INTERACTION_FORBIDDEN",
        `Player action cannot physically interact with ${characterId} because that character is not co-located with the selected actor`,
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
    proposedTime: { kind: "unknown" },
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
    private readonly resolveSupersessions?: PlayerSupersessionResolver,
  ) {
    if (render) this.render = render;
    else {
      const renderer = new NarrativeRenderer(engine);
      this.render = ({ branchId, commitId, actorId }) =>
        renderer.render(branchId, commitId, { pointOfView: "actor", actorId });
    }
  }

  async turn(inputValue: PlayerTurnInput): Promise<PlayerTurnResult> {
    const input = playerTurnInputSchema.parse(inputValue);
    const previousHead = await this.engine.branches.readHead(input.branchId);
    const contextBefore = await buildActorScopedActionContext(this.engine, input.actorId, previousHead, input.utterance);
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
    const candidate = parsedCandidate.data;
    let action = playerActionToKnowledgeAwareAction({
      branchId: input.branchId,
      actorId: input.actorId,
      expectedParentCommit: previousHead,
      utterance: input.utterance,
      candidate,
    });
    const scopeIssues = validatePlayerActionScope(candidate, contextBefore);
    if (scopeIssues.length) {
      return this.rejected(input, previousHead, contextBefore, "scope", scopeIssues, candidate, action.proposal);
    }
    const spatialIssues = await validatePlayerActionSpatialScope(this.engine, candidate, input.actorId, previousHead);
    if (spatialIssues.length) {
      return this.rejected(input, previousHead, contextBefore, "scope", spatialIssues, candidate, action.proposal);
    }
    if (this.resolveSupersessions) {
      const supersedesCanonicalEventIds = [...new Set(await this.resolveSupersessions(action.proposal))].sort();
      if (supersedesCanonicalEventIds.length) {
        action = {
          ...action,
          proposal: eventProposalSchema.parse({ ...action.proposal, supersedesCanonicalEventIds }),
        };
      }
    }

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
    const contextAfter = await buildActorScopedActionContext(this.engine, input.actorId, newHead);
    const renderedText = await this.renderAt(input.branchId, input.actorId, newHead);
    return {
      accepted: true,
      stage: "committed",
      branchId: input.branchId,
      actorId: input.actorId,
      previousHead,
      newHead,
      issues: committed.result.report.warnings,
      contextBefore,
      contextAfter,
      renderedText,
      candidate,
      proposal: action.proposal,
      validation: committed.result.report,
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
      : await buildActorScopedActionContext(this.engine, input.actorId, newHead);
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
  entities: ReadonlyMap<EntityId, unknown>,
): void {
  if (typeof value === "string" && entities.has(value)) target.add(value);
}

function addClaimObjectEntities(
  target: Set<EntityId>,
  value: unknown,
  entities: ReadonlyMap<EntityId, unknown>,
): void {
  if (typeof value === "string") addExistingEntity(target, value, entities);
  else if (Array.isArray(value)) for (const item of value) addExistingEntity(target, item, entities);
}

function explicitlyMentions(utterance: string, name: string): boolean {
  const needle = name.trim().toLocaleLowerCase();
  if (!needle) return false;
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

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, ...(path ? { path } : {}) };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

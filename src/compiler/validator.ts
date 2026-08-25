import type { z } from "zod";
import { EvidenceVerifier, validateEntityNameEvidence } from "./evidence.js";
import { ActorModelStore, characterGoalSchema, characterModelSchema, type CharacterGoal, type CharacterModel } from "../world/actors.js";
import { CanonicalCompiler, CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { InitialWorldStore, initialWorldSchema, type InitialWorld } from "../world/initial.js";
import {
  canonicalEventSchema,
  claimSchema,
  entitySchema,
  worldRuleSchema,
  type CanonicalEvent,
  type Claim,
  type Entity,
  type EvidenceAssertion,
  type EvidenceRef,
  type Predicate,
  type StoryTime,
  type ValidationIssue,
  type WorldRule,
} from "../world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../world/state.js";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { isMetaKnowledgePredicate } from "./semantics.js";
import { compilerProposalArtifactId, compilerProposalLogicalIdentity } from "./proposals.js";
import {
  EvidenceAssertionStore,
  evidenceAssertionSourceIds,
  validateEvidenceAssertionTargets,
} from "./evidence-assertions.js";
import { evidenceSourceIds } from "../world/source-scope.js";
import { validateCommittedEntityResolutionTrace } from "./entity-resolution.js";

export type CanonicalProposalKind = "entity" | "claim" | "canonical-event" | "world-rule" | "initial-world" | "character-goal" | "character-model";
export type CompilerValidation = { accepted: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] };
export type CompilerValidationCatalog = {
  entities: Map<string, Entity>;
  claims: Map<string, Claim>;
  events: Map<string, CanonicalEvent>;
  rules: Map<string, WorldRule>;
};
export type CompilerConvergenceProgress = {
  phase: "load" | "canonical" | "complete";
  processed: number;
  total: number;
  accepted: number;
  blocked: number;
  proposalId?: string;
};
export type BatchAcceptResult = {
  accepted: Array<{ id: string; kind: CanonicalProposalKind }>;
  blocked: Array<{ id: string; kind: CanonicalProposalKind; errors: ValidationIssue[] }>;
  staging: Array<{ id: string; kind: string }>;
};

export class CompilerValidator {
  constructor(private readonly canon: CanonicalModelStore, private readonly stateSchema = new StateSchemaRegistry(DEFAULT_STATE_FIELDS)) {}

  async validate(kind: CanonicalProposalKind, payload: unknown): Promise<CompilerValidation> {
    return this.validateWithCatalog(kind, payload, await this.loadCatalog());
  }

  async loadCatalog(): Promise<CompilerValidationCatalog> {
    const [entityList, claimList, eventList, ruleList] = await Promise.all([
      this.canon.listEntities(),
      this.canon.listClaims(),
      this.canon.listEvents(),
      this.canon.listRules(),
    ]);
    return {
      entities: new Map(entityList.map((entity) => [entity.id, entity])),
      claims: new Map(claimList.map((claim) => [claim.id, claim])),
      events: new Map(eventList.map((event) => [event.id, event])),
      rules: new Map(ruleList.map((rule) => [rule.id, rule])),
    };
  }

  validateWithCatalog(kind: CanonicalProposalKind, payload: unknown, catalog: CompilerValidationCatalog): CompilerValidation {
    const { entities, claims, events, rules } = catalog;
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    if (kind === "entity") this.validateEntity(entitySchema.parse(payload), errors);
    if (kind === "claim") this.validateClaim(claimSchema.parse(payload), entities, errors);
    if (kind === "canonical-event") this.validateEvent(canonicalEventSchema.parse(payload), entities, claims, events, rules, errors);
    if (kind === "world-rule") this.validateRule(worldRuleSchema.parse(payload), entities, rules, errors);
    if (kind === "initial-world") this.validateInitialWorld(initialWorldSchema.parse(payload), entities, claims, events, rules, errors);
    if (kind === "character-goal") this.validateGoal(characterGoalSchema.parse(payload), entities, claims, events, rules, errors);
    if (kind === "character-model") this.validateCharacterModel(characterModelSchema.parse(payload), entities, claims, events, rules, errors);
    return { accepted: errors.length === 0, errors, warnings };
  }

  private validateEntity(entity: Entity, errors: ValidationIssue[]): void {
    if (!entity.evidence.length) errors.push(issue("MISSING_EVIDENCE", `Entity ${entity.id} has no source evidence`, "evidence"));
  }

  private validateClaim(claim: Claim, entities: ReadonlyMap<string, Entity>, errors: ValidationIssue[]): void {
    if (!entities.has(claim.subject)) errors.push(issue("UNKNOWN_SUBJECT", `Claim subject ${claim.subject} is not canonical`, "subject"));
    if (claim.speaker && !entities.has(claim.speaker)) errors.push(issue("UNKNOWN_SPEAKER", `Claim speaker ${claim.speaker} is not canonical`, "speaker"));
    if (isMetaKnowledgePredicate(claim.predicate)) {
      errors.push(issue("META_KNOWLEDGE_CLAIM", `Claim ${claim.id} encodes character knowledge in predicate '${claim.predicate}'; use KnowledgeDelta over a base-world claim instead`, "predicate"));
    }
    if (!claim.evidence.length) errors.push(issue("MISSING_EVIDENCE", `Claim ${claim.id} has no source evidence`, "evidence"));
  }

  private validateEvent(
    event: CanonicalEvent,
    entities: ReadonlyMap<string, Entity>,
    claims: ReadonlyMap<string, Claim>,
    events: ReadonlyMap<string, CanonicalEvent>,
    rules: ReadonlyMap<string, WorldRule>,
    errors: ValidationIssue[],
  ): void {
    if (!event.evidence.length) errors.push(issue("MISSING_EVIDENCE", `Event ${event.id} has no source evidence`, "evidence"));
    if (event.observedOutcome.operations.length > 16) {
      errors.push(issue("OVERSIZED_CANONICAL_EVENT", `Event ${event.id} contains more than 16 typed state effects and must be split at a genuine causal boundary`, "observedOutcome.operations"));
    }
    for (const participant of event.participants) if (!entities.has(participant)) errors.push(issue("UNKNOWN_PARTICIPANT", `Unknown event participant ${participant}`, "participants"));
    const presenceActors = new Set<string>();
    for (let index = 0; index < (event.participantPresence?.length ?? 0); index += 1) {
      const presence = event.participantPresence![index]!;
      if (!event.participants.includes(presence.entityId)) {
        errors.push(issue("INVALID_PARTICIPANT_PRESENCE", `Event presence ${presence.entityId} is not an event participant`, `participantPresence.${index}.entityId`));
      }
      if (entities.get(presence.entityId)?.kind !== "character") {
        errors.push(issue("INVALID_PARTICIPANT_PRESENCE", `Event presence ${presence.entityId} is not a canonical character`, `participantPresence.${index}.entityId`));
      }
      if (presenceActors.has(presence.entityId)) {
        errors.push(issue("DUPLICATE_PARTICIPANT_PRESENCE", `Event presence ${presence.entityId} is duplicated`, `participantPresence.${index}.entityId`));
      }
      presenceActors.add(presence.entityId);
    }
    for (let index = 0; index < event.participants.length; index += 1) {
      const participantId = event.participants[index]!;
      if (entities.get(participantId)?.kind === "character" && !presenceActors.has(participantId)) {
        errors.push(issue(
          "MISSING_PARTICIPANT_PRESENCE",
          `Character participant ${participantId} has no explicit event presence mode`,
          `participants.${index}`,
        ));
      }
    }
    for (const parentId of event.causalParents) {
      const parent = events.get(parentId);
      if (!parent) errors.push(issue("UNKNOWN_CAUSAL_PARENT", `Unknown causal parent ${parentId}`, "causalParents"));
      else if (storyTimeDefinitelyBefore(event.storyTime, parent.storyTime)) {
        errors.push(issue("TEMPORAL_CAUSAL_REGRESSION", `Event ${event.id} is temporally earlier than causal parent ${parentId}`, "storyTime"));
      }
    }
    if (event.storyTime.kind === "relative" && !events.has(event.storyTime.anchorEventId)) {
      errors.push(issue("UNKNOWN_TIME_ANCHOR", `Unknown story-time anchor ${event.storyTime.anchorEventId}`, "storyTime.anchorEventId"));
    }
    for (const predicate of event.preconditions) this.validatePredicate(predicate, entities, rules, errors);
    this.validateOperations(event.observedOutcome.operations, entities, rules, errors, "observedOutcome.operations");
    for (let index = 0; index < (event.observedKnowledge?.operations.length ?? 0); index += 1) {
      const operation = event.observedKnowledge!.operations[index]!;
      const actor = entities.get(operation.actorId);
      if (!actor || actor.kind !== "character") errors.push(issue("INVALID_KNOWLEDGE_ACTOR", `Event knowledge actor ${operation.actorId} is not a canonical character`, `observedKnowledge.operations.${index}`));
      if (operation.op === "learn") {
        if (!claims.has(operation.claimId)) errors.push(issue("UNKNOWN_KNOWLEDGE_CLAIM", `Event knowledge references unknown claim ${operation.claimId}`, `observedKnowledge.operations.${index}`));
        if (operation.sourceActorId) {
          const source = entities.get(operation.sourceActorId);
          if (!source || source.kind !== "character") errors.push(issue("INVALID_KNOWLEDGE_SOURCE", `Event knowledge source ${operation.sourceActorId} is not a canonical character`, `observedKnowledge.operations.${index}`));
        }
      }
    }
    const entryActors = new Set<string>();
    for (let index = 0; index < (event.characterEntryCheckpoints?.length ?? 0); index += 1) {
      const checkpoint = event.characterEntryCheckpoints![index]!;
      const prefix = `characterEntryCheckpoints.${index}`;
      const actor = entities.get(checkpoint.actorId);
      if (!actor || actor.kind !== "character") {
        errors.push(issue("INVALID_ENTRY_ACTOR", `Entry actor ${checkpoint.actorId} is not a canonical character`, `${prefix}.actorId`));
      }
      if (!event.participants.includes(checkpoint.actorId)) {
        errors.push(issue("INVALID_ENTRY_ACTOR", `Entry actor ${checkpoint.actorId} must be an event participant`, `${prefix}.actorId`));
      }
      if (entryActors.has(checkpoint.actorId)) {
        errors.push(issue("DUPLICATE_CHARACTER_ENTRY", `Event ${event.id} has multiple entry checkpoints for ${checkpoint.actorId}`, `${prefix}.actorId`));
      }
      entryActors.add(checkpoint.actorId);
      if (checkpoint.delta.operations.length > 16) {
        errors.push(issue("OVERSIZED_CHARACTER_ENTRY", `Entry checkpoint for ${checkpoint.actorId} contains more than 16 state operations`, `${prefix}.delta.operations`));
      }
      if (!checkpoint.delta.operations.some((operation) =>
        "entityId" in operation
        && operation.entityId === checkpoint.actorId
        && ["character.location", "character.plan", "character.momentum"].includes(operation.field))) {
        errors.push(issue("INACTIONABLE_CHARACTER_ENTRY", `Entry checkpoint for ${checkpoint.actorId} must establish that actor's location, plan, or momentum before the event`, `${prefix}.delta.operations`));
      }
      for (let presenceIndex = 0; presenceIndex < checkpoint.participantPresence.length; presenceIndex += 1) {
        const presence = checkpoint.participantPresence[presenceIndex]!;
        if (!event.participants.includes(presence.entityId)) {
          errors.push(issue("INVALID_ENTRY_PRESENCE", `Entry presence ${presence.entityId} is not an event participant`, `${prefix}.participantPresence.${presenceIndex}.entityId`));
        }
        if (entities.get(presence.entityId)?.kind !== "character") {
          errors.push(issue("INVALID_ENTRY_PRESENCE", `Entry presence ${presence.entityId} is not a canonical character`, `${prefix}.participantPresence.${presenceIndex}.entityId`));
        }
      }
      this.validateOperations(checkpoint.delta.operations, entities, rules, errors, `${prefix}.delta.operations`);
      for (let knowledgeIndex = 0; knowledgeIndex < (checkpoint.knowledge?.operations.length ?? 0); knowledgeIndex += 1) {
        const operation = checkpoint.knowledge!.operations[knowledgeIndex]!;
        const knowledgePath = `${prefix}.knowledge.operations.${knowledgeIndex}`;
        const knowledgeActor = entities.get(operation.actorId);
        if (!knowledgeActor || knowledgeActor.kind !== "character") {
          errors.push(issue("INVALID_KNOWLEDGE_ACTOR", `Entry knowledge actor ${operation.actorId} is not a canonical character`, knowledgePath));
        }
        if (operation.op === "learn") {
          if (!claims.has(operation.claimId)) errors.push(issue("UNKNOWN_KNOWLEDGE_CLAIM", `Entry knowledge references unknown claim ${operation.claimId}`, knowledgePath));
          if (operation.sourceActorId) {
            const source = entities.get(operation.sourceActorId);
            if (!source || source.kind !== "character") errors.push(issue("INVALID_KNOWLEDGE_SOURCE", `Entry knowledge source ${operation.sourceActorId} is not a canonical character`, knowledgePath));
          }
        }
      }
    }
  }

  private validateRule(rule: WorldRule, entities: ReadonlyMap<string, Entity>, rules: ReadonlyMap<string, WorldRule>, errors: ValidationIssue[]): void {
    if (!rule.evidence.length) errors.push(issue("MISSING_EVIDENCE", `Rule ${rule.id} has no source evidence`, "evidence"));
    if (!(rule.requires?.length || rule.forbids?.length)) {
      errors.push(issue("INERT_WORLD_RULE", `Rule ${rule.id} has neither requires nor forbids constraints and cannot affect deterministic validation`, "requires"));
    }
    const forbidden = new Set((rule.forbids ?? []).map((predicate) => canonicalJson(predicate)));
    if (rule.appliesWhen.some((predicate) => forbidden.has(canonicalJson(predicate)))) {
      errors.push(issue("SELF_FORBIDDING_WORLD_RULE", `Rule ${rule.id} forbids the same condition that makes it applicable`, "forbids"));
    }
    if ((rule.requires ?? []).some((predicate) => forbidden.has(canonicalJson(predicate)))) {
      errors.push(issue("CONTRADICTORY_WORLD_RULE", `Rule ${rule.id} both requires and forbids the same condition`, "forbids"));
    }
    const visibleRules = new Map(rules);
    visibleRules.set(rule.id, rule);
    for (const predicate of [...rule.appliesWhen, ...(rule.requires ?? []), ...(rule.forbids ?? [])]) this.validatePredicate(predicate, entities, visibleRules, errors);
  }

  private validateInitialWorld(
    initial: InitialWorld,
    entities: ReadonlyMap<string, Entity>,
    claims: ReadonlyMap<string, Claim>,
    events: ReadonlyMap<string, CanonicalEvent>,
    rules: ReadonlyMap<string, WorldRule>,
    errors: ValidationIssue[],
  ): void {
    if (!initial.evidence.length) errors.push(issue("MISSING_EVIDENCE", "Initial world has no source evidence", "evidence"));
    if (initial.checkpoint?.beforeCanonicalEventId && !events.has(initial.checkpoint.beforeCanonicalEventId)) {
      errors.push(issue("UNKNOWN_OPENING_EVENT", `Initial checkpoint references unknown canonical event ${initial.checkpoint.beforeCanonicalEventId}`, "checkpoint.beforeCanonicalEventId"));
    }
    this.validateOperations(initial.delta.operations, entities, rules, errors, "delta.operations");
    for (let index = 0; index < (initial.knowledge?.operations.length ?? 0); index += 1) {
      const operation = initial.knowledge!.operations[index]!;
      const actor = entities.get(operation.actorId);
      if (!actor || actor.kind !== "character") errors.push(issue("INVALID_KNOWLEDGE_ACTOR", `Initial knowledge actor ${operation.actorId} is not a canonical character`, `knowledge.operations.${index}`));
      if (operation.op === "learn") {
        if (!claims.has(operation.claimId)) errors.push(issue("UNKNOWN_KNOWLEDGE_CLAIM", `Initial knowledge references unknown claim ${operation.claimId}`, `knowledge.operations.${index}`));
        if (operation.sourceActorId) {
          const source = entities.get(operation.sourceActorId);
          if (!source || source.kind !== "character") errors.push(issue("INVALID_KNOWLEDGE_SOURCE", `Initial knowledge source ${operation.sourceActorId} is not a canonical character`, `knowledge.operations.${index}`));
        }
      }
    }
    const representedCharacters = new Set<string>();
    const explicitlyDead = new Set<string>();
    const openingPresenceIds = new Set<string>();
    const physicalOpeningIds = new Set<string>();
    for (let index = 0; index < (initial.participantPresence?.length ?? 0); index += 1) {
      const presence = initial.participantPresence![index]!;
      const entity = entities.get(presence.entityId);
      if (!entity || entity.kind !== "character") {
        errors.push(issue("INVALID_OPENING_PRESENCE", `Opening presence ${presence.entityId} is not a canonical character`, `participantPresence.${index}.entityId`));
      }
      if (openingPresenceIds.has(presence.entityId)) {
        errors.push(issue("DUPLICATE_OPENING_PRESENCE", `Opening presence ${presence.entityId} is duplicated`, `participantPresence.${index}.entityId`));
      }
      openingPresenceIds.add(presence.entityId);
      if (presence.mode === "physical") physicalOpeningIds.add(presence.entityId);
    }
    for (const operation of initial.delta.operations) {
      if ("entityId" in operation && entities.get(operation.entityId)?.kind === "character") {
        representedCharacters.add(operation.entityId);
        if (operation.field === "character.alive") {
          if (operation.op === "set" && operation.value === false) explicitlyDead.add(operation.entityId);
          else explicitlyDead.delete(operation.entityId);
        }
      }
    }
    for (const operation of initial.knowledge?.operations ?? []) {
      if (entities.get(operation.actorId)?.kind === "character") representedCharacters.add(operation.actorId);
      if (operation.op === "learn" && operation.sourceActorId && entities.get(operation.sourceActorId)?.kind === "character") {
        representedCharacters.add(operation.sourceActorId);
      }
    }
    if (![...representedCharacters].some((characterId) => !explicitlyDead.has(characterId))) {
      errors.push(issue(
        "UNPLAYABLE_INITIAL_WORLD",
        "Initial world must represent at least one non-dead opening character in committed state or knowledge; an evidence-backed empty or all-dead delta cannot create a playable cast.",
        "delta.operations",
      ));
    }
    const initialSourceIds = new Set(initial.evidence.map((reference) => reference.span.sourceId));
    const sourceCharacterIds = [...entities.values()]
      .filter((entity) => entity.kind === "character")
      .filter((entity) => entity.evidence.some((reference) => initialSourceIds.has(reference.span.sourceId)))
      .map((entity) => entity.id);
    const actionableOpening = initial.delta.operations.some((operation) =>
      "entityId" in operation
      && sourceCharacterIds.includes(operation.entityId)
      && physicalOpeningIds.has(operation.entityId)
      && !explicitlyDead.has(operation.entityId)
      && ["character.location", "character.plan", "character.momentum"].includes(operation.field)
      && (operation.op !== "set" || operation.value !== null));
    if (sourceCharacterIds.length > 1 && !physicalOpeningIds.size) {
      errors.push(issue(
        "MISSING_OPENING_PRESENCE",
        "A multi-character source must explicitly identify at least one physically present opening role; identity, mention, or alive state is not presence.",
        "participantPresence",
      ));
    }
    if (sourceCharacterIds.length > 1 && !actionableOpening) {
      errors.push(issue(
        "INACTIONABLE_INITIAL_WORLD",
        "A multi-character source must establish a bodily present opening role through a grounded location, plan, or momentum; a bare alive inventory cannot create a playable scene.",
        "delta.operations",
      ));
    }
  }

  private validateGoal(
    goal: CharacterGoal,
    entities: ReadonlyMap<string, Entity>,
    claims: ReadonlyMap<string, Claim>,
    events: ReadonlyMap<string, CanonicalEvent>,
    rules: ReadonlyMap<string, WorldRule>,
    errors: ValidationIssue[],
  ): void {
    const actor = entities.get(goal.actorId);
    if (!actor || actor.kind !== "character") errors.push(issue("INVALID_GOAL_ACTOR", `Goal actor ${goal.actorId} is not a canonical character`, "actorId"));
    if (!goal.evidence.length) errors.push(issue("MISSING_EVIDENCE", `Goal ${goal.id} has no source evidence`, "evidence"));
    for (const claimId of [...goal.requiresKnowledge, ...(goal.blockedByKnowledge ?? [])]) {
      if (!claims.has(claimId)) errors.push(issue("UNKNOWN_GOAL_CLAIM", `Goal ${goal.id} references unknown claim ${claimId}`));
    }
    for (let index = 0; index < (goal.targetIds?.length ?? 0); index += 1) {
      if (!entities.has(goal.targetIds![index]!)) errors.push(issue("UNKNOWN_GOAL_TARGET", `Unknown goal target ${goal.targetIds![index]}`, `targetIds.${index}`));
    }
    for (let index = 0; index < (goal.activation?.preconditions.length ?? 0); index += 1) {
      this.validatePredicate(goal.activation!.preconditions[index]!, entities, rules, errors);
    }
    for (let index = 0; index < (goal.activation?.afterCanonicalEventIds.length ?? 0); index += 1) {
      const eventId = goal.activation!.afterCanonicalEventIds[index]!;
      if (!events.has(eventId)) errors.push(issue("UNKNOWN_GOAL_EVENT", `Goal ${goal.id} activates after unknown canonical event ${eventId}`, `activation.afterCanonicalEventIds.${index}`));
    }
    if (goal.activation?.storyWindow?.kind === "relative" && !events.has(goal.activation.storyWindow.anchorEventId)) {
      errors.push(issue("UNKNOWN_GOAL_EVENT", `Goal ${goal.id} story window references unknown canonical event ${goal.activation.storyWindow.anchorEventId}`, "activation.storyWindow.anchorEventId"));
    }
    for (const [path, predicates] of [
      ["completion", goal.completion ?? []],
      ["expiry", goal.expiry ?? []],
    ] as const) {
      predicates.forEach((predicate) => this.validatePredicate(predicate, entities, rules, errors));
      if (predicates.length && predicates.some((predicate) => (goal.activation?.preconditions ?? []).some((activation) => canonicalJson(activation) === canonicalJson(predicate)))) {
        errors.push(issue("GOAL_ACTIVE_AND_COMPLETE", `Goal ${goal.id} uses the same predicate for activation and ${path}`, path));
      }
    }
    for (let milestoneIndex = 0; milestoneIndex < (goal.milestones?.length ?? 0); milestoneIndex += 1) {
      goal.milestones![milestoneIndex]!.conditions.forEach((predicate) => this.validatePredicate(predicate, entities, rules, errors));
    }
    const actions = [
      ...(goal.candidateAction ? [{ path: "candidateAction", value: goal.candidateAction }] : []),
      ...(goal.actionPatterns ?? []).map((value, index) => ({ path: `actionPatterns.${index}`, value })),
    ];
    for (const { path, value } of actions) {
      for (let index = 0; index < (value.participants?.length ?? 0); index += 1) {
        const participant = value.participants![index]!;
        if (!entities.has(participant)) errors.push(issue("UNKNOWN_GOAL_PARTICIPANT", `Unknown goal participant ${participant}`, `${path}.participants.${index}`));
      }
      value.preconditions.forEach((predicate) => this.validatePredicate(predicate, entities, rules, errors));
      this.validateOperations(value.proposedDelta.operations, entities, rules, errors, `${path}.proposedDelta.operations`);
      for (let index = 0; index < (value.proposedKnowledge?.operations.length ?? 0); index += 1) {
        const operation = value.proposedKnowledge!.operations[index]!;
        const knowledgeActor = entities.get(operation.actorId);
        if (!knowledgeActor || knowledgeActor.kind !== "character") errors.push(issue("UNKNOWN_KNOWLEDGE_ACTOR", `Unknown knowledge actor ${operation.actorId}`, `${path}.proposedKnowledge.operations.${index}.actorId`));
        if (!claims.has(operation.claimId)) errors.push(issue("UNKNOWN_KNOWLEDGE_CLAIM", `Unknown knowledge claim ${operation.claimId}`, `${path}.proposedKnowledge.operations.${index}.claimId`));
        if (operation.op === "learn" && operation.sourceActorId) {
          const sourceActor = entities.get(operation.sourceActorId);
          if (!sourceActor || sourceActor.kind !== "character") errors.push(issue("UNKNOWN_KNOWLEDGE_SOURCE", `Unknown knowledge source ${operation.sourceActorId}`, `${path}.proposedKnowledge.operations.${index}.sourceActorId`));
        }
      }
    }
  }

  private validateCharacterModel(
    model: CharacterModel,
    entities: ReadonlyMap<string, Entity>,
    claims: ReadonlyMap<string, Claim>,
    events: ReadonlyMap<string, CanonicalEvent>,
    rules: ReadonlyMap<string, WorldRule>,
    errors: ValidationIssue[],
  ): void {
    const actor = entities.get(model.actorId);
    if (!actor || actor.kind !== "character") errors.push(issue("INVALID_MODEL_ACTOR", `Character model actor ${model.actorId} is not a canonical character`, "actorId"));
    if (!model.evidence.length) errors.push(issue("MISSING_EVIDENCE", `Character model ${model.actorId} has no source evidence`, "evidence"));
    for (let phaseIndex = 0; phaseIndex < (model.developmentPhases?.length ?? 0); phaseIndex += 1) {
      const phase = model.developmentPhases![phaseIndex]!;
      phase.activation.preconditions.forEach((predicate) => this.validatePredicate(predicate, entities, rules, errors));
      for (const eventId of [...phase.activation.afterCanonicalEventIds, ...phase.activation.afterExperiencedCanonicalEventIds]) {
        if (!events.has(eventId)) errors.push(issue("UNKNOWN_DEVELOPMENT_EVENT", `Character phase ${phase.id} references unknown canonical event ${eventId}`, `developmentPhases.${phaseIndex}.activation`));
      }
      for (const claimId of phase.activation.requiresKnowledge) {
        if (!claims.has(claimId)) errors.push(issue("UNKNOWN_DEVELOPMENT_CLAIM", `Character phase ${phase.id} references unknown claim ${claimId}`, `developmentPhases.${phaseIndex}.activation.requiresKnowledge`));
      }
      if (phase.activation.storyWindow?.kind === "relative" && !events.has(phase.activation.storyWindow.anchorEventId)) {
        errors.push(issue("UNKNOWN_DEVELOPMENT_EVENT", `Character phase ${phase.id} story window references unknown canonical event ${phase.activation.storyWindow.anchorEventId}`, `developmentPhases.${phaseIndex}.activation.storyWindow`));
      }
    }
  }

  private validateOperations(operations: CanonicalEvent["observedOutcome"]["operations"], entities: ReadonlyMap<string, Entity>, rules: ReadonlyMap<string, WorldRule>, errors: ValidationIssue[], pathPrefix: string): void {
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index]!;
      try {
        this.stateSchema.validateOperation(operation, entities);
        if ((operation.op === "activate-rule" || operation.op === "deactivate-rule") && !rules.has(operation.ruleId)) errors.push(issue("UNKNOWN_RULE", `Unknown rule ${operation.ruleId}`, `${pathPrefix}.${index}`));
        if (operation.op !== "activate-rule" && operation.op !== "deactivate-rule" && operation.field === "character.relationships") {
          const addedReferences = operation.op === "set" && Array.isArray(operation.value)
            ? operation.value
            : operation.op === "add-member"
              ? [operation.member]
              : [];
          for (let memberIndex = 0; memberIndex < addedReferences.length; memberIndex += 1) {
            const member = addedReferences[memberIndex];
            if (typeof member !== "string" || entities.get(member)?.kind === "relationship") continue;
            errors.push(issue(
              "INVALID_RELATIONSHIP_REFERENCE",
              `character.relationships may reference relationship entities only; ${member} is ${entities.get(member)?.kind ?? "unknown"}`,
              operation.op === "set" ? `${pathPrefix}.${index}.value.${memberIndex}` : `${pathPrefix}.${index}.member`,
            ));
          }
        }
      } catch (error) {
        errors.push(issue("INVALID_STATE_OPERATION", error instanceof Error ? error.message : String(error), `${pathPrefix}.${index}`));
      }
    }
  }

  private validatePredicate(predicate: Predicate, entities: ReadonlyMap<string, Entity>, rules: ReadonlyMap<string, WorldRule>, errors: ValidationIssue[]): void {
    if (predicate.op === "all" || predicate.op === "any") { for (const item of predicate.items) this.validatePredicate(item, entities, rules, errors); return; }
    if (predicate.op === "not") { this.validatePredicate(predicate.item, entities, rules, errors); return; }
    if (predicate.op === "rule-active") { if (!rules.has(predicate.ruleId)) errors.push(issue("UNKNOWN_RULE", `Predicate references unknown rule ${predicate.ruleId}`)); return; }
    if (predicate.op === "after-step" || predicate.op === "before-step"
      || predicate.op === "elapsed-days-gte" || predicate.op === "elapsed-days-lte"
      || predicate.op === "story-time-at-or-after" || predicate.op === "story-time-before") return;
    const entity = entities.get(predicate.entityId);
    if (!entity) { errors.push(issue("UNKNOWN_PREDICATE_ENTITY", `Predicate references unknown entity ${predicate.entityId}`)); return; }
    try {
      const field = this.stateSchema.get(predicate.field);
      if (!field.appliesTo.includes(entity.kind)) errors.push(issue("INVALID_PREDICATE_FIELD", `${predicate.field} does not apply to ${entity.kind}`));
      if (predicate.op === "fact-equals") this.stateSchema.validateValue(field, predicate.value, entities);
      if ((predicate.op === "fact-gte" || predicate.op === "fact-lte") && field.valueType !== "number") {
        errors.push(issue("INVALID_PREDICATE_FIELD", `${predicate.field} is not numeric`));
      }
      if (predicate.op === "entity-in") {
        if (!entities.has(predicate.member)) errors.push(issue("UNKNOWN_PREDICATE_MEMBER", `Unknown member ${predicate.member}`));
        if (field.valueType !== "entity-ref-set") errors.push(issue("INVALID_PREDICATE_FIELD", `${predicate.field} is not a set field`));
      }
    } catch (error) {
      errors.push(issue("INVALID_PREDICATE", error instanceof Error ? error.message : String(error)));
    }
  }
}

export class CompilerCommitService {
  readonly canon: CanonicalModelStore;
  readonly proposals: ProposalStore;
  readonly compiler: CanonicalCompiler;
  readonly validator: CompilerValidator;
  readonly initialWorld: InitialWorldStore;
  readonly actorModels: ActorModelStore;
  readonly exactEvidence: EvidenceAssertionStore;
  private readonly evidence: EvidenceVerifier;
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.canon = new CanonicalModelStore(workspaceRoot);
    this.proposals = new ProposalStore(workspaceRoot);
    this.compiler = new CanonicalCompiler(this.proposals, this.canon);
    this.validator = new CompilerValidator(this.canon);
    this.initialWorld = new InitialWorldStore(workspaceRoot);
    this.actorModels = new ActorModelStore(workspaceRoot);
    this.exactEvidence = new EvidenceAssertionStore(workspaceRoot);
    this.evidence = new EvidenceVerifier(workspaceRoot);
  }

  async accept(kind: CanonicalProposalKind, id: string): Promise<CompilerValidation> {
    const schema = schemaFor(kind);
    const proposal = await this.proposals.read("pending", id, schema);
    const validation = await this.validateProposal(
      id,
      kind,
      proposal.payload,
      proposal.evidence,
      proposal.evidenceAssertions ?? [],
    );
    if (!validation.accepted) return validation;
    await this.commitParsed({
      id,
      kind,
      payload: proposal.payload,
      evidence: proposal.evidence,
      evidenceAssertions: proposal.evidenceAssertions ?? [],
      createdAt: proposal.createdAt,
    });
    return validation;
  }

  async acceptAllValid(
    sourceId?: string,
    onProgress?: (progress: CompilerConvergenceProgress) => void,
  ): Promise<BatchAcceptResult> {
    const accepted: BatchAcceptResult["accepted"] = [];
    const blocked: BatchAcceptResult["blocked"] = [];
    const staging: BatchAcceptResult["staging"] = [];
    const candidates: PendingCanonicalProposal[] = [];
    for (const proposal of await this.proposals.list("pending", sourceId)) {
      if (!isCanonicalKind(proposal.kind)) {
        staging.push({ id: proposal.id, kind: proposal.kind });
        continue;
      }
      const schema = schemaFor(proposal.kind);
      const envelope = await this.proposals.read("pending", proposal.id, schema);
      candidates.push({
        id: proposal.id,
        kind: proposal.kind,
        payload: envelope.payload,
        evidence: envelope.evidence,
        evidenceAssertions: envelope.evidenceAssertions ?? [],
        createdAt: proposal.createdAt,
      });
    }

    const total = candidates.length;
    let processed = 0;
    onProgress?.({ phase: "load", processed, total, accepted: 0, blocked: 0 });
    const deduplicated = selectLogicalCandidates(candidates);
    const eligible = deduplicated.selected;
    for (const { candidate, selectedId, identity } of deduplicated.superseded) {
      await this.proposals.transition(candidate.id, "pending", "rejected");
      blocked.push({
        id: candidate.id,
        kind: candidate.kind,
        errors: [issue("SUPERSEDED_LOGICAL_PROPOSAL", `Proposal is superseded by newer active proposal '${selectedId}' for ${identity}.`)],
      });
      processed += 1;
      onProgress?.({ phase: "canonical", processed, total, accepted: accepted.length, blocked: blocked.length, proposalId: candidate.id });
    }

    const catalog = await this.validator.loadCatalog();
    const processCandidate = async (candidate: PendingCanonicalProposal): Promise<void> => {
      const validation = await this.validateProposal(
        candidate.id,
        candidate.kind,
        candidate.payload,
        candidate.evidence,
        candidate.evidenceAssertions,
        catalog,
      );
      if (!validation.accepted) {
        blocked.push({ id: candidate.id, kind: candidate.kind, errors: validation.errors });
      } else {
        try {
          await this.commitParsed(candidate);
          addToCatalog(catalog, candidate.kind, candidate.payload);
          accepted.push({ id: candidate.id, kind: candidate.kind });
        } catch (error) {
          blocked.push({
            id: candidate.id,
            kind: candidate.kind,
            errors: [issue("COMMIT_CONFLICT", error instanceof Error ? error.message : String(error))],
          });
        }
      }
      processed += 1;
      onProgress?.({ phase: "canonical", processed, total, accepted: accepted.length, blocked: blocked.length, proposalId: candidate.id });
    };

    for (const kind of ["entity", "claim"] as const) {
      for (const candidate of eligible.filter((item) => item.kind === kind)) await processCandidate(candidate);
    }
    await processDependencyKind(
      eligible.filter((item) => item.kind === "world-rule"),
      catalog.rules,
      ruleDependencies,
      processCandidate,
      blocked,
      () => {
        processed += 1;
        onProgress?.({ phase: "canonical", processed, total, accepted: accepted.length, blocked: blocked.length });
      },
      "RULE_DEPENDENCY_CYCLE",
    );
    for (const kind of ["initial-world", "character-model", "character-goal"] as const) {
      for (const candidate of eligible.filter((item) => item.kind === kind)) await processCandidate(candidate);
    }
    await processDependencyKind(
      eligible.filter((item) => item.kind === "canonical-event"),
      catalog.events,
      eventDependencies,
      processCandidate,
      blocked,
      () => {
        processed += 1;
        onProgress?.({ phase: "canonical", processed, total, accepted: accepted.length, blocked: blocked.length });
      },
      "CAUSAL_CYCLE",
    );
    onProgress?.({ phase: "complete", processed, total, accepted: accepted.length, blocked: blocked.length });
    return { accepted, blocked, staging };
  }

  private async validateProposal(
    proposalId: string,
    kind: CanonicalProposalKind,
    payload: unknown,
    envelopeEvidence: readonly EvidenceRef[],
    evidenceAssertions: readonly EvidenceAssertion[],
    catalog?: CompilerValidationCatalog,
  ): Promise<CompilerValidation> {
    const validation = catalog
      ? this.validator.validateWithCatalog(kind, payload, catalog)
      : await this.validator.validate(kind, payload);
    const payloadEvidence = (payload as { evidence?: EvidenceRef[] }).evidence ?? [];
    const inspected = await this.evidence.inspectAll([...payloadEvidence, ...envelopeEvidence]);
    const groundingIssues = kind === "entity" && inspected.valid
      ? validateEntityNameEvidence(entitySchema.parse(payload), inspected.excerpts)
      : [];
    const artifactId = compilerProposalArtifactId(kind, payload, proposalId);
    const targetIssues = validateEvidenceAssertionTargets(kind, artifactId, payload, evidenceAssertions);
    const exactInspection = await this.evidence.inspectAssertions(evidenceAssertions);
    const legacySourceIds = evidenceSourceIds([...payloadEvidence, ...envelopeEvidence]);
    const exactSourceIds = evidenceAssertionSourceIds(evidenceAssertions);
    const mixedSourceIssues = legacySourceIds.length && exactSourceIds.length
      && (legacySourceIds.length !== 1 || exactSourceIds.length !== 1 || legacySourceIds[0] !== exactSourceIds[0])
      ? [issue(
          "EVIDENCE_SOURCE_MISMATCH",
          `Proposal ${proposalId} has legacy evidence from ${legacySourceIds.join(", ")} and exact evidence from ${exactSourceIds.join(", ")}.`,
          "evidenceAssertions",
        )]
      : [];
    const sourceIds = [...new Set([...legacySourceIds, ...exactSourceIds])];
    const resolutionTraceIssues = kind === "entity" && sourceIds.length === 1
      ? (await validateCommittedEntityResolutionTrace(
        this.workspaceRoot,
        sourceIds[0]!,
        entitySchema.parse(payload),
      )).map((message) => issue("MISSING_ENTITY_RESOLUTION_TRACE", message, "id"))
      : [];
    const errors = [
      ...validation.errors,
      ...inspected.issues,
      ...groundingIssues,
      ...targetIssues,
      ...exactInspection.issues,
      ...mixedSourceIssues,
      ...resolutionTraceIssues,
    ];
    return { accepted: errors.length === 0, errors, warnings: validation.warnings };
  }

  private async commitParsed(candidate: PendingCanonicalProposal): Promise<void> {
    const { kind, id, payload } = candidate;
    if (kind === "entity") await this.canon.putEntity(entitySchema.parse(payload));
    else if (kind === "claim") await this.canon.putClaim(claimSchema.parse(payload));
    else if (kind === "canonical-event") await this.canon.putEvent(canonicalEventSchema.parse(payload));
    else if (kind === "world-rule") await this.canon.putRule(worldRuleSchema.parse(payload));
    else if (kind === "initial-world") await this.initialWorld.put(initialWorldSchema.parse(payload));
    else if (kind === "character-goal") await this.actorModels.putGoal(characterGoalSchema.parse(payload));
    else await this.actorModels.putModel(characterModelSchema.parse(payload));
    const artifactId = compilerProposalArtifactId(kind, payload, id);
    await this.exactEvidence.replaceForArtifact(
      kind,
      artifactId,
      contentHash(payload),
      candidate.evidenceAssertions,
    );
    await this.proposals.transition(id, "pending", "accepted");
  }
}

type PendingCanonicalProposal = {
  id: string;
  kind: CanonicalProposalKind;
  payload: unknown;
  evidence: EvidenceRef[];
  evidenceAssertions: EvidenceAssertion[];
  createdAt: string;
};

function selectLogicalCandidates(candidates: readonly PendingCanonicalProposal[]): {
  selected: PendingCanonicalProposal[];
  superseded: Array<{ candidate: PendingCanonicalProposal; selectedId: string; identity: string }>;
} {
  const byIdentity = new Map<string, PendingCanonicalProposal[]>();
  const selected: PendingCanonicalProposal[] = [];
  const superseded: Array<{ candidate: PendingCanonicalProposal; selectedId: string; identity: string }> = [];
  for (const candidate of candidates) {
    const identity = compilerProposalLogicalIdentity(candidate.kind, candidate.payload);
    if (!identity) {
      selected.push(candidate);
      continue;
    }
    byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), candidate]);
  }
  for (const [identity, group] of byIdentity) {
    const ranked = [...group].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const winner = ranked.at(-1)!;
    selected.push(winner);
    for (const candidate of ranked.slice(0, -1)) superseded.push({ candidate, selectedId: winner.id, identity });
  }
  return {
    selected: selected.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
    superseded,
  };
}

async function processDependencyKind<T extends CanonicalEvent | WorldRule>(
  candidates: readonly PendingCanonicalProposal[],
  canonical: ReadonlyMap<string, T>,
  dependencies: (payload: T) => string[],
  process: (candidate: PendingCanonicalProposal) => Promise<void>,
  blocked: BatchAcceptResult["blocked"],
  recordCycle: () => void,
  cycleCode: string,
): Promise<void> {
  const byLogicalId = new Map(candidates.map((candidate) => [(candidate.payload as T).id, candidate]));
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const [id, candidate] of byLogicalId) {
    const localDependencies = [...new Set(dependencies(candidate.payload as T).filter((dependency) => byLogicalId.has(dependency) && !canonical.has(dependency)))];
    indegree.set(id, localDependencies.length);
    for (const dependency of localDependencies) children.set(dependency, [...(children.get(dependency) ?? []), id]);
  }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([id]) => id).sort();
  const visited = new Set<string>();
  while (ready.length) {
    const id = ready.shift()!;
    visited.add(id);
    await process(byLogicalId.get(id)!);
    for (const child of (children.get(id) ?? []).sort()) {
      const next = (indegree.get(child) ?? 1) - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }
  for (const [id, candidate] of byLogicalId) {
    if (visited.has(id)) continue;
    blocked.push({ id: candidate.id, kind: candidate.kind, errors: [issue(cycleCode, `Dependency cycle prevents committing logical artifact ${id}.`)] });
    recordCycle();
  }
}

function ruleDependencies(rule: WorldRule): string[] {
  const dependencies: string[] = [];
  for (const predicate of [...rule.appliesWhen, ...(rule.requires ?? []), ...(rule.forbids ?? [])]) collectRuleDependencies(predicate, dependencies);
  return dependencies;
}

function collectRuleDependencies(predicate: Predicate, dependencies: string[]): void {
  if (predicate.op === "rule-active") dependencies.push(predicate.ruleId);
  else if (predicate.op === "all" || predicate.op === "any") predicate.items.forEach((item) => collectRuleDependencies(item, dependencies));
  else if (predicate.op === "not") collectRuleDependencies(predicate.item, dependencies);
}

function eventDependencies(event: CanonicalEvent): string[] {
  return [...event.causalParents, ...(event.storyTime.kind === "relative" ? [event.storyTime.anchorEventId] : [])];
}

function addToCatalog(catalog: CompilerValidationCatalog, kind: CanonicalProposalKind, payload: unknown): void {
  if (kind === "entity") { const value = entitySchema.parse(payload); catalog.entities.set(value.id, value); }
  if (kind === "claim") { const value = claimSchema.parse(payload); catalog.claims.set(value.id, value); }
  if (kind === "canonical-event") { const value = canonicalEventSchema.parse(payload); catalog.events.set(value.id, value); }
  if (kind === "world-rule") { const value = worldRuleSchema.parse(payload); catalog.rules.set(value.id, value); }
}

function isCanonicalKind(kind: string): kind is CanonicalProposalKind {
  return kind === "entity" || kind === "claim" || kind === "canonical-event" || kind === "world-rule" || kind === "initial-world" || kind === "character-goal" || kind === "character-model";
}
function schemaFor(kind: CanonicalProposalKind): z.ZodTypeAny {
  if (kind === "entity") return entitySchema;
  if (kind === "claim") return claimSchema;
  if (kind === "canonical-event") return canonicalEventSchema;
  if (kind === "initial-world") return initialWorldSchema;
  if (kind === "character-goal") return characterGoalSchema;
  if (kind === "character-model") return characterModelSchema;
  return worldRuleSchema;
}
function issue(code: string, message: string, path?: string): ValidationIssue { return path ? { code, message, path } : { code, message }; }

function storyTimeDefinitelyBefore(left: StoryTime, right: StoryTime): boolean {
  const comparable = (value: StoryTime): { scale: "year" | "ordinal"; min: number; max: number } | undefined => {
    if (value.kind === "ordinal" && typeof value.orderHint === "number") return { scale: "ordinal", min: value.orderHint, max: value.orderHint };
    const values = value.kind === "exact" ? [value.value] : value.kind === "range" ? [value.earliest, value.latest] : [];
    const years = values.flatMap((entry) => [...entry.matchAll(/(?:^|\D)(\d{3,4})(?:s)?(?=\D|$)/g)].map((match) => Number(match[1])));
    return years.length ? { scale: "year", min: Math.min(...years), max: Math.max(...years.map((year) => year + 9)) } : undefined;
  };
  const leftRange = comparable(left);
  const rightRange = comparable(right);
  return Boolean(leftRange && rightRange && leftRange.scale === rightRange.scale && leftRange.max < rightRange.min);
}

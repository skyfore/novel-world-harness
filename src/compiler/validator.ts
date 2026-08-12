import type { z } from "zod";
import { EvidenceVerifier } from "./evidence.js";
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
  type EvidenceRef,
  type Predicate,
  type ValidationIssue,
  type WorldRule,
} from "../world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../world/state.js";
import { canonicalJson } from "../world/canonical.js";
import { isMetaKnowledgePredicate } from "./semantics.js";

export type CanonicalProposalKind = "entity" | "claim" | "canonical-event" | "world-rule" | "initial-world" | "character-goal" | "character-model";
export type CompilerValidation = { accepted: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] };
export type BatchAcceptResult = {
  accepted: Array<{ id: string; kind: CanonicalProposalKind }>;
  blocked: Array<{ id: string; kind: CanonicalProposalKind; errors: ValidationIssue[] }>;
  staging: Array<{ id: string; kind: string }>;
};

export class CompilerValidator {
  constructor(private readonly canon: CanonicalModelStore, private readonly stateSchema = new StateSchemaRegistry(DEFAULT_STATE_FIELDS)) {}

  async validate(kind: CanonicalProposalKind, payload: unknown): Promise<CompilerValidation> {
    const [entityList, claimList, eventList, ruleList] = await Promise.all([
      this.canon.listEntities(),
      this.canon.listClaims(),
      this.canon.listEvents(),
      this.canon.listRules(),
    ]);
    const entities = new Map(entityList.map((entity) => [entity.id, entity]));
    const claims = new Map(claimList.map((claim) => [claim.id, claim]));
    const events = new Map(eventList.map((event) => [event.id, event]));
    const rules = new Map(ruleList.map((rule) => [rule.id, rule]));
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    if (kind === "entity") this.validateEntity(entitySchema.parse(payload), errors, warnings);
    if (kind === "claim") this.validateClaim(claimSchema.parse(payload), entities, errors);
    if (kind === "canonical-event") this.validateEvent(canonicalEventSchema.parse(payload), entities, claims, events, rules, errors);
    if (kind === "world-rule") this.validateRule(worldRuleSchema.parse(payload), entities, rules, errors);
    if (kind === "initial-world") this.validateInitialWorld(initialWorldSchema.parse(payload), entities, claims, rules, errors);
    if (kind === "character-goal") this.validateGoal(characterGoalSchema.parse(payload), entities, claims, rules, errors);
    if (kind === "character-model") this.validateCharacterModel(characterModelSchema.parse(payload), entities, errors);
    return { accepted: errors.length === 0, errors, warnings };
  }

  private validateEntity(entity: Entity, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
    if (!entity.evidence.length) errors.push(issue("MISSING_EVIDENCE", `Entity ${entity.id} has no source evidence`, "evidence"));
    if (!entity.aliases.length) warnings.push(issue("NO_ALIASES", `Entity ${entity.id} has no aliases; this may be valid`));
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
    if (event.observedOutcome.operations.length > 1) {
      errors.push(issue("NON_ATOMIC_CANONICAL_EVENT", `Event ${event.id} contains multiple world-state operations; submit one explicitly narrated transition per canonical event`, "observedOutcome.operations"));
    }
    for (const participant of event.participants) if (!entities.has(participant)) errors.push(issue("UNKNOWN_PARTICIPANT", `Unknown event participant ${participant}`, "participants"));
    for (const parent of event.causalParents) if (!events.has(parent)) errors.push(issue("UNKNOWN_CAUSAL_PARENT", `Unknown causal parent ${parent}`, "causalParents"));
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
    rules: ReadonlyMap<string, WorldRule>,
    errors: ValidationIssue[],
  ): void {
    if (!initial.evidence.length) errors.push(issue("MISSING_EVIDENCE", "Initial world has no source evidence", "evidence"));
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
  }

  private validateGoal(goal: CharacterGoal, entities: ReadonlyMap<string, Entity>, claims: ReadonlyMap<string, Claim>, rules: ReadonlyMap<string, WorldRule>, errors: ValidationIssue[]): void {
    const actor = entities.get(goal.actorId);
    if (!actor || actor.kind !== "character") errors.push(issue("INVALID_GOAL_ACTOR", `Goal actor ${goal.actorId} is not a canonical character`, "actorId"));
    if (!goal.evidence.length) errors.push(issue("MISSING_EVIDENCE", `Goal ${goal.id} has no source evidence`, "evidence"));
    for (const claimId of [...goal.requiresKnowledge, ...(goal.blockedByKnowledge ?? [])]) {
      if (!claims.has(claimId)) errors.push(issue("UNKNOWN_GOAL_CLAIM", `Goal ${goal.id} references unknown claim ${claimId}`));
    }
    if (goal.candidateAction) {
      for (const participant of goal.candidateAction.participants ?? []) if (!entities.has(participant)) errors.push(issue("UNKNOWN_GOAL_PARTICIPANT", `Unknown goal participant ${participant}`));
      for (const predicate of goal.candidateAction.preconditions) this.validatePredicate(predicate, entities, rules, errors);
      this.validateOperations(goal.candidateAction.proposedDelta.operations, entities, rules, errors, "candidateAction.proposedDelta.operations");
      for (const operation of goal.candidateAction.proposedKnowledge?.operations ?? []) {
        if (!entities.has(operation.actorId)) errors.push(issue("UNKNOWN_KNOWLEDGE_ACTOR", `Unknown knowledge actor ${operation.actorId}`));
        if (operation.op === "learn" && !claims.has(operation.claimId)) errors.push(issue("UNKNOWN_KNOWLEDGE_CLAIM", `Unknown knowledge claim ${operation.claimId}`));
      }
    }
  }

  private validateCharacterModel(model: CharacterModel, entities: ReadonlyMap<string, Entity>, errors: ValidationIssue[]): void {
    const actor = entities.get(model.actorId);
    if (!actor || actor.kind !== "character") errors.push(issue("INVALID_MODEL_ACTOR", `Character model actor ${model.actorId} is not a canonical character`, "actorId"));
    if (!model.evidence.length) errors.push(issue("MISSING_EVIDENCE", `Character model ${model.actorId} has no source evidence`, "evidence"));
  }

  private validateOperations(operations: CanonicalEvent["observedOutcome"]["operations"], entities: ReadonlyMap<string, Entity>, rules: ReadonlyMap<string, WorldRule>, errors: ValidationIssue[], pathPrefix: string): void {
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index]!;
      try {
        this.stateSchema.validateOperation(operation, entities);
        if ((operation.op === "activate-rule" || operation.op === "deactivate-rule") && !rules.has(operation.ruleId)) errors.push(issue("UNKNOWN_RULE", `Unknown rule ${operation.ruleId}`, `${pathPrefix}.${index}`));
      } catch (error) {
        errors.push(issue("INVALID_STATE_OPERATION", error instanceof Error ? error.message : String(error), `${pathPrefix}.${index}`));
      }
    }
  }

  private validatePredicate(predicate: Predicate, entities: ReadonlyMap<string, Entity>, rules: ReadonlyMap<string, WorldRule>, errors: ValidationIssue[]): void {
    if (predicate.op === "all" || predicate.op === "any") { for (const item of predicate.items) this.validatePredicate(item, entities, rules, errors); return; }
    if (predicate.op === "not") { this.validatePredicate(predicate.item, entities, rules, errors); return; }
    if (predicate.op === "rule-active") { if (!rules.has(predicate.ruleId)) errors.push(issue("UNKNOWN_RULE", `Predicate references unknown rule ${predicate.ruleId}`)); return; }
    if (predicate.op === "after-step" || predicate.op === "before-step") return;
    const entity = entities.get(predicate.entityId);
    if (!entity) { errors.push(issue("UNKNOWN_PREDICATE_ENTITY", `Predicate references unknown entity ${predicate.entityId}`)); return; }
    try {
      const field = this.stateSchema.get(predicate.field);
      if (!field.appliesTo.includes(entity.kind)) errors.push(issue("INVALID_PREDICATE_FIELD", `${predicate.field} does not apply to ${entity.kind}`));
      if (predicate.op === "fact-equals") this.stateSchema.validateValue(field, predicate.value, entities);
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
  private readonly evidence: EvidenceVerifier;

  constructor(workspaceRoot: string) {
    this.canon = new CanonicalModelStore(workspaceRoot);
    this.proposals = new ProposalStore(workspaceRoot);
    this.compiler = new CanonicalCompiler(this.proposals, this.canon);
    this.validator = new CompilerValidator(this.canon);
    this.initialWorld = new InitialWorldStore(workspaceRoot);
    this.actorModels = new ActorModelStore(workspaceRoot);
    this.evidence = new EvidenceVerifier(workspaceRoot);
  }

  async accept(kind: CanonicalProposalKind, id: string): Promise<CompilerValidation> {
    const schema = schemaFor(kind);
    const proposal = await this.proposals.read("pending", id, schema);
    const validation = await this.validateProposal(kind, proposal.payload, proposal.evidence);
    if (!validation.accepted) return validation;
    if (kind === "entity") await this.compiler.acceptEntity(id);
    else if (kind === "claim") await this.compiler.acceptClaim(id);
    else if (kind === "canonical-event") await this.compiler.acceptEvent(id);
    else if (kind === "world-rule") await this.compiler.acceptRule(id);
    else if (kind === "initial-world") await this.initialWorld.put(initialWorldSchema.parse(proposal.payload));
    else if (kind === "character-goal") await this.actorModels.putGoal(characterGoalSchema.parse(proposal.payload));
    else await this.actorModels.putModel(characterModelSchema.parse(proposal.payload));
    if (kind === "initial-world" || kind === "character-goal" || kind === "character-model") await this.proposals.transition(id, "pending", "accepted");
    return validation;
  }

  async acceptAllValid(sourceId?: string): Promise<BatchAcceptResult> {
    const order: CanonicalProposalKind[] = ["entity", "claim", "world-rule", "initial-world", "character-model", "character-goal", "canonical-event"];
    const accepted: BatchAcceptResult["accepted"] = [];
    let changed = true;
    while (changed) {
      changed = false;
      const pending = await this.proposals.list("pending", sourceId);
      for (const kind of order) {
        for (const proposal of pending.filter((item) => item.kind === kind)) {
          const validation = await this.accept(kind, proposal.id);
          if (validation.accepted) { accepted.push({ id: proposal.id, kind }); changed = true; }
        }
      }
    }
    const remaining = await this.proposals.list("pending", sourceId);
    const blocked: BatchAcceptResult["blocked"] = [];
    const staging: BatchAcceptResult["staging"] = [];
    for (const proposal of remaining) {
      if (!isCanonicalKind(proposal.kind)) { staging.push({ id: proposal.id, kind: proposal.kind }); continue; }
      const schema = schemaFor(proposal.kind);
      const envelope = await this.proposals.read("pending", proposal.id, schema);
      const validation = await this.validateProposal(proposal.kind, envelope.payload, envelope.evidence);
      blocked.push({ id: proposal.id, kind: proposal.kind, errors: validation.errors });
    }
    return { accepted, blocked, staging };
  }

  private async validateProposal(kind: CanonicalProposalKind, payload: unknown, envelopeEvidence: readonly EvidenceRef[]): Promise<CompilerValidation> {
    const validation = await this.validator.validate(kind, payload);
    const payloadEvidence = (payload as { evidence?: EvidenceRef[] }).evidence ?? [];
    const verified = await this.evidence.verifyAll([...payloadEvidence, ...envelopeEvidence]);
    const errors = [...validation.errors, ...verified.issues];
    return { accepted: errors.length === 0, errors, warnings: validation.warnings };
  }
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

import type { z } from "zod";
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
  type Predicate,
  type ValidationIssue,
  type WorldRule,
} from "../world/model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../world/state.js";

export type CanonicalProposalKind = "entity" | "claim" | "canonical-event" | "world-rule" | "initial-world";
export type CompilerValidation = { accepted: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] };
export type BatchAcceptResult = {
  accepted: Array<{ id: string; kind: CanonicalProposalKind }>;
  blocked: Array<{ id: string; kind: CanonicalProposalKind; errors: ValidationIssue[] }>;
  staging: Array<{ id: string; kind: string }>;
};

export class CompilerValidator {
  constructor(private readonly canon: CanonicalModelStore, private readonly stateSchema = new StateSchemaRegistry(DEFAULT_STATE_FIELDS)) {}
  async validate(kind: CanonicalProposalKind, payload: unknown): Promise<CompilerValidation> {
    const entities = new Map((await this.canon.listEntities()).map((entity) => [entity.id, entity]));
    const events = new Map((await this.canon.listEvents()).map((event) => [event.id, event]));
    const rules = new Map((await this.canon.listRules()).map((rule) => [rule.id, rule]));
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];
    if (kind === "entity") this.validateEntity(entitySchema.parse(payload), errors, warnings);
    if (kind === "claim") this.validateClaim(claimSchema.parse(payload), entities, errors, warnings);
    if (kind === "canonical-event") this.validateEvent(canonicalEventSchema.parse(payload), entities, events, rules, errors, warnings);
    if (kind === "world-rule") this.validateRule(worldRuleSchema.parse(payload), entities, rules, errors, warnings);
    if (kind === "initial-world") this.validateInitialWorld(initialWorldSchema.parse(payload), entities, rules, errors);
    return { accepted: errors.length === 0, errors, warnings };
  }
  private validateEntity(entity: Entity, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
    if (!entity.evidence.length) errors.push(issue("MISSING_EVIDENCE", `Entity ${entity.id} has no source evidence`, "evidence"));
    if (!entity.aliases.length) warnings.push(issue("NO_ALIASES", `Entity ${entity.id} has no aliases; this may be valid`));
  }
  private validateClaim(claim: Claim, entities: ReadonlyMap<string, Entity>, errors: ValidationIssue[], _warnings: ValidationIssue[]): void {
    if (!entities.has(claim.subject)) errors.push(issue("UNKNOWN_SUBJECT", `Claim subject ${claim.subject} is not canonical`, "subject"));
    if (claim.speaker && !entities.has(claim.speaker)) errors.push(issue("UNKNOWN_SPEAKER", `Claim speaker ${claim.speaker} is not canonical`, "speaker"));
    if (!claim.evidence.length) errors.push(issue("MISSING_EVIDENCE", `Claim ${claim.id} has no source evidence`, "evidence"));
  }
  private validateEvent(event: CanonicalEvent, entities: ReadonlyMap<string, Entity>, events: ReadonlyMap<string, CanonicalEvent>, rules: ReadonlyMap<string, WorldRule>, errors: ValidationIssue[], _warnings: ValidationIssue[]): void {
    if (!event.evidence.length) errors.push(issue("MISSING_EVIDENCE", `Event ${event.id} has no source evidence`, "evidence"));
    for (const participant of event.participants) if (!entities.has(participant)) errors.push(issue("UNKNOWN_PARTICIPANT", `Unknown event participant ${participant}`, "participants"));
    for (const parent of event.causalParents) if (!events.has(parent)) errors.push(issue("UNKNOWN_CAUSAL_PARENT", `Unknown causal parent ${parent}`, "causalParents"));
    for (const predicate of event.preconditions) this.validatePredicate(predicate, entities, rules, errors);
    this.validateOperations(event.observedOutcome.operations, entities, rules, errors, "observedOutcome.operations");
  }
  private validateRule(rule: WorldRule, entities: ReadonlyMap<string, Entity>, rules: ReadonlyMap<string, WorldRule>, errors: ValidationIssue[], _warnings: ValidationIssue[]): void {
    if (!rule.evidence.length) errors.push(issue("MISSING_EVIDENCE", `Rule ${rule.id} has no source evidence`, "evidence"));
    const visibleRules = new Map(rules);
    visibleRules.set(rule.id, rule);
    for (const predicate of [...rule.appliesWhen, ...(rule.requires ?? []), ...(rule.forbids ?? [])]) this.validatePredicate(predicate, entities, visibleRules, errors);
  }
  private validateInitialWorld(initial: InitialWorld, entities: ReadonlyMap<string, Entity>, rules: ReadonlyMap<string, WorldRule>, errors: ValidationIssue[]): void {
    if (!initial.evidence.length) errors.push(issue("MISSING_EVIDENCE", "Initial world has no source evidence", "evidence"));
    this.validateOperations(initial.delta.operations, entities, rules, errors, "delta.operations");
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
  constructor(workspaceRoot: string) {
    this.canon = new CanonicalModelStore(workspaceRoot);
    this.proposals = new ProposalStore(workspaceRoot);
    this.compiler = new CanonicalCompiler(this.proposals, this.canon);
    this.validator = new CompilerValidator(this.canon);
    this.initialWorld = new InitialWorldStore(workspaceRoot);
  }
  async accept(kind: CanonicalProposalKind, id: string): Promise<CompilerValidation> {
    const schema = schemaFor(kind);
    const proposal = await this.proposals.read("pending", id, schema);
    const validation = await this.validator.validate(kind, proposal.payload);
    if (!validation.accepted) return validation;
    if (kind === "entity") await this.compiler.acceptEntity(id);
    else if (kind === "claim") await this.compiler.acceptClaim(id);
    else if (kind === "canonical-event") await this.compiler.acceptEvent(id);
    else if (kind === "world-rule") await this.compiler.acceptRule(id);
    else {
      await this.initialWorld.put(initialWorldSchema.parse(proposal.payload));
      await this.proposals.transition(id, "pending", "accepted");
    }
    return validation;
  }
  async acceptAllValid(): Promise<BatchAcceptResult> {
    const order: CanonicalProposalKind[] = ["entity", "claim", "world-rule", "initial-world", "canonical-event"];
    const accepted: BatchAcceptResult["accepted"] = [];
    let changed = true;
    while (changed) {
      changed = false;
      const pending = await this.proposals.list("pending");
      for (const kind of order) {
        for (const proposal of pending.filter((item) => item.kind === kind)) {
          const validation = await this.accept(kind, proposal.id);
          if (validation.accepted) { accepted.push({ id: proposal.id, kind }); changed = true; }
        }
      }
    }
    const remaining = await this.proposals.list("pending");
    const blocked: BatchAcceptResult["blocked"] = [];
    const staging: BatchAcceptResult["staging"] = [];
    for (const proposal of remaining) {
      if (!isCanonicalKind(proposal.kind)) { staging.push({ id: proposal.id, kind: proposal.kind }); continue; }
      const schema = schemaFor(proposal.kind);
      const envelope = await this.proposals.read("pending", proposal.id, schema);
      const validation = await this.validator.validate(proposal.kind, envelope.payload);
      blocked.push({ id: proposal.id, kind: proposal.kind, errors: validation.errors });
    }
    return { accepted, blocked, staging };
  }
}

function isCanonicalKind(kind: string): kind is CanonicalProposalKind { return kind === "entity" || kind === "claim" || kind === "canonical-event" || kind === "world-rule" || kind === "initial-world"; }
function schemaFor(kind: CanonicalProposalKind): z.ZodTypeAny { if (kind === "entity") return entitySchema; if (kind === "claim") return claimSchema; if (kind === "canonical-event") return canonicalEventSchema; if (kind === "initial-world") return initialWorldSchema; return worldRuleSchema; }
function issue(code: string, message: string, path?: string): ValidationIssue { return path ? { code, message, path } : { code, message }; }

import type { EvidenceRef, Predicate, ValidationIssue, WorldRule } from "../world/model.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { PossibilityTemplateStore, possibilityTemplateSchema, type PossibilityTemplate } from "../world/possibility-model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "../world/state.js";
import { EvidenceVerifier } from "./evidence.js";
import { hasExecutablePossibilityEffect } from "./semantics.js";
import { canonicalJson } from "../world/canonical.js";
import { canonicalScaffoldRoleNeutralityIssues } from "../world/canonical-adaptation.js";

export type PossibilityValidation = {
  accepted: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

export class PossibilityCommitService {
  readonly proposals: ProposalStore;
  readonly templates: PossibilityTemplateStore;
  readonly canon: CanonicalModelStore;
  private readonly evidence: EvidenceVerifier;
  private readonly stateSchema = new StateSchemaRegistry(DEFAULT_STATE_FIELDS);

  constructor(private readonly workspaceRoot: string) {
    this.proposals = new ProposalStore(workspaceRoot);
    this.templates = new PossibilityTemplateStore(workspaceRoot);
    this.canon = new CanonicalModelStore(workspaceRoot);
    this.evidence = new EvidenceVerifier(workspaceRoot);
  }

  async validate(templateInput: unknown, envelopeEvidence: readonly EvidenceRef[] = []): Promise<PossibilityValidation> {
    const template = possibilityTemplateSchema.parse(templateInput);
    const [entities, rules, events, claims, templates] = await Promise.all([
      this.canon.listEntities(),
      this.canon.listRules(),
      this.canon.listEvents(),
      this.canon.listClaims(),
      this.templates.list(),
    ]);
    const entityMap = new Map(entities.map((entity) => [entity.id, entity]));
    const ruleMap = new Map(rules.map((rule) => [rule.id, rule]));
    const eventMap = new Map(events.map((event) => [event.id, event]));
    const claimMap = new Map(claims.map((claim) => [claim.id, claim]));
    const eventIds = new Set(events.map((event) => event.id));
    const claimIds = new Set(claims.map((claim) => claim.id));
    const templateIds = new Set(templates.map((candidate) => candidate.id));
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    if (template.id.startsWith("canon-")) {
      errors.push(issue("RESERVED_POSSIBILITY_ID", `Possibility template ${template.id} uses the reserved canonical-derived namespace`, "id"));
    }
    if (!template.evidence.length) errors.push(issue("MISSING_EVIDENCE", `Possibility ${template.id} has no evidence`, "evidence"));
    const verified = await this.evidence.verifyAll([...template.evidence, ...envelopeEvidence]);
    errors.push(...verified.issues);

    for (const participant of template.participants) {
      if (!entityMap.has(participant)) errors.push(issue("UNKNOWN_PARTICIPANT", `Possibility ${template.id} references unknown participant ${participant}`, "participants"));
    }
    const presenceActors = new Set<string>();
    for (let index = 0; index < (template.participantPresence?.length ?? 0); index += 1) {
      const presence = template.participantPresence![index]!;
      if (!template.participants.includes(presence.entityId)) {
        errors.push(issue(
          "INVALID_PARTICIPANT_PRESENCE",
          `Possibility presence ${presence.entityId} is not a possibility participant`,
          `participantPresence.${index}.entityId`,
        ));
      }
      if (entityMap.get(presence.entityId)?.kind !== "character") {
        errors.push(issue(
          "INVALID_PARTICIPANT_PRESENCE",
          `Possibility presence ${presence.entityId} is not a canonical character`,
          `participantPresence.${index}.entityId`,
        ));
      }
      if (presenceActors.has(presence.entityId)) {
        errors.push(issue(
          "DUPLICATE_PARTICIPANT_PRESENCE",
          `Possibility presence ${presence.entityId} is duplicated`,
          `participantPresence.${index}.entityId`,
        ));
      }
      presenceActors.add(presence.entityId);
    }
    for (let index = 0; index < template.participants.length; index += 1) {
      const participantId = template.participants[index]!;
      if (entityMap.get(participantId)?.kind === "character" && !presenceActors.has(participantId)) {
        errors.push(issue(
          "MISSING_PARTICIPANT_PRESENCE",
          `Character participant ${participantId} has no explicit possibility presence mode`,
          `participants.${index}`,
        ));
      }
    }
    if (template.canonicalEventId && !eventIds.has(template.canonicalEventId)) {
      errors.push(issue("UNKNOWN_CANONICAL_EVENT", `Possibility ${template.id} references unknown canonical event ${template.canonicalEventId}`, "canonicalEventId"));
    }
    if (template.kind === "canon-analogue" && !template.canonicalEventId) {
      errors.push(issue("CANON_ANALOGUE_EVENT_REQUIRED", `Canon-analogue possibility ${template.id} must reference its canonical event`, "canonicalEventId"));
    }
    if (template.kind === "actor-plan") {
      errors.push(issue("UNSCHEDULABLE_ACTOR_PLAN", `Actor-plan possibility ${template.id} has no runtime consumer; compile evidence-backed character goals instead`, "kind"));
    }
    if (template.kind === "player-choice" && !hasExecutablePossibilityEffect(template)) {
      errors.push(issue("INERT_PLAYER_CHOICE", `Player-choice possibility ${template.id} has no concrete state or knowledge effect and cannot diverge from canon`, "proposedDelta"));
    }
    if (template.canonicalScaffold && template.canonicalEventId) {
      const canonicalEvent = eventMap.get(template.canonicalEventId);
      if (canonicalEvent) {
        const compare = (actual: unknown, expected: unknown, code: string, path: string, label: string) => {
          if (canonicalJson(actual) !== canonicalJson(expected)) {
            errors.push(issue(code, `Canonical scaffold ${template.id} must preserve the source event ${label}`, path));
          }
        };
        compare(template.participants, canonicalEvent.participants, "SCAFFOLD_PARTICIPANTS_MISMATCH", "participants", "participants");
        compare(template.participantPresence, canonicalEvent.participantPresence, "SCAFFOLD_PRESENCE_MISMATCH", "participantPresence", "participant presence");
        compare(template.candidateWindow, canonicalEvent.storyTime, "SCAFFOLD_TIME_MISMATCH", "candidateWindow", "story time");
        compare(template.timeAdvance, canonicalEvent.timeAdvance, "SCAFFOLD_TIME_ADVANCE_MISMATCH", "timeAdvance", "time advance");
        compare(template.preconditions, canonicalEvent.preconditions, "SCAFFOLD_PRECONDITIONS_MISMATCH", "preconditions", "preconditions");
        compare(template.proposedDelta, canonicalEvent.observedOutcome, "SCAFFOLD_EFFECT_MISMATCH", "proposedDelta", "typed outcome");
        compare(template.proposedKnowledge, canonicalEvent.observedKnowledge, "SCAFFOLD_KNOWLEDGE_MISMATCH", "proposedKnowledge", "knowledge outcome");
        compare(template.causalParents, canonicalEvent.causalParents, "SCAFFOLD_CAUSAL_PARENT_MISMATCH", "causalParents", "causal parents");
      }
      for (let roleIndex = 0; roleIndex < template.canonicalScaffold.roles.length; roleIndex += 1) {
        const role = template.canonicalScaffold.roles[roleIndex]!;
        const entity = entityMap.get(role.canonicalEntityId);
        if (entity && !role.allowedEntityKinds.includes(entity.kind)) {
          errors.push(issue(
            "SCAFFOLD_ROLE_KIND_MISMATCH",
            `Canonical role ${role.roleId} does not admit source entity kind ${entity.kind}`,
            `canonicalScaffold.roles.${roleIndex}.allowedEntityKinds`,
          ));
        }
        role.requiredState.forEach((predicate) => validatePredicate(predicate, entityMap, ruleMap, this.stateSchema, errors));
        role.requiresKnowledge.forEach((claimId, claimIndex) => {
          if (!claimIds.has(claimId)) {
            errors.push(issue(
              "UNKNOWN_SCAFFOLD_ROLE_CLAIM",
              `Canonical role ${role.roleId} requires unknown claim ${claimId}`,
              `canonicalScaffold.roles.${roleIndex}.requiresKnowledge.${claimIndex}`,
            ));
          }
        });
      }
      for (const neutralityIssue of canonicalScaffoldRoleNeutralityIssues(template, {
        entities: entityMap,
        claims: claimMap,
        stateSchema: this.stateSchema,
      })) {
        errors.push(issue(
          "SCAFFOLD_OPAQUE_ROLE_REFERENCE",
          `Canonical scaffold ${template.id} is not structurally role-neutral: ${neutralityIssue}`,
          "canonicalScaffold.roles",
        ));
      }
    }
    for (let index = 0; index < template.causalParents.length; index += 1) {
      const parent = template.causalParents[index]!;
      if (!eventIds.has(parent) && !templateIds.has(parent)) {
        errors.push(issue("UNKNOWN_CAUSAL_PARENT", `Possibility ${template.id} references unknown causal parent ${parent}`, `causalParents.${index}`));
      }
    }
    for (const predicate of [...template.preconditions, ...template.blockers, ...(template.expiry ?? [])]) {
      validatePredicate(predicate, entityMap, ruleMap, this.stateSchema, errors);
    }
    for (let index = 0; index < (template.proposedDelta?.operations.length ?? 0); index += 1) {
      const operation = template.proposedDelta!.operations[index]!;
      try {
        this.stateSchema.validateOperation(operation, entityMap);
        if ((operation.op === "activate-rule" || operation.op === "deactivate-rule") && !ruleMap.has(operation.ruleId)) {
          errors.push(issue("UNKNOWN_RULE", `Possibility ${template.id} references unknown rule ${operation.ruleId}`, `proposedDelta.operations.${index}`));
        }
      } catch (error) {
        errors.push(issue("INVALID_STATE_OPERATION", error instanceof Error ? error.message : String(error), `proposedDelta.operations.${index}`));
      }
    }
    if (!template.proposedDelta) warnings.push(issue("NO_PROPOSED_DELTA", `Possibility ${template.id} is descriptive until a candidate event supplies effects`));
    for (let index = 0; index < (template.proposedKnowledge?.operations.length ?? 0); index += 1) {
      const operation = template.proposedKnowledge!.operations[index]!;
      const actor = entityMap.get(operation.actorId);
      if (!actor || actor.kind !== "character") errors.push(issue("INVALID_KNOWLEDGE_ACTOR", `Possibility knowledge actor ${operation.actorId} is not a canonical character`, `proposedKnowledge.operations.${index}`));
      if (operation.op === "learn") {
        if (!claimIds.has(operation.claimId)) errors.push(issue("UNKNOWN_KNOWLEDGE_CLAIM", `Possibility knowledge references unknown claim ${operation.claimId}`, `proposedKnowledge.operations.${index}`));
        if (operation.sourceActorId) {
          const source = entityMap.get(operation.sourceActorId);
          if (!source || source.kind !== "character") errors.push(issue("INVALID_KNOWLEDGE_SOURCE", `Possibility knowledge source ${operation.sourceActorId} is not a canonical character`, `proposedKnowledge.operations.${index}`));
        }
      }
    }
    return { accepted: errors.length === 0, errors, warnings };
  }

  async accept(proposalId: string): Promise<PossibilityValidation> {
    const proposal = await this.proposals.read("pending", proposalId, possibilityTemplateSchema);
    const validation = await this.validate(proposal.payload, proposal.evidence);
    if (!validation.accepted) return validation;
    await this.templates.put(proposal.payload);
    await this.proposals.transition(proposalId, "pending", "accepted");
    return validation;
  }
}

function validatePredicate(
  predicate: Predicate,
  entities: ReadonlyMap<string, { kind: string }>,
  rules: ReadonlyMap<string, WorldRule>,
  schema: StateSchemaRegistry,
  errors: ValidationIssue[],
): void {
  if (predicate.op === "all" || predicate.op === "any") {
    for (const item of predicate.items) validatePredicate(item, entities, rules, schema, errors);
    return;
  }
  if (predicate.op === "not") {
    validatePredicate(predicate.item, entities, rules, schema, errors);
    return;
  }
  if (predicate.op === "rule-active") {
    if (!rules.has(predicate.ruleId)) errors.push(issue("UNKNOWN_RULE", `Predicate references unknown rule ${predicate.ruleId}`));
    return;
  }
  if (predicate.op === "after-step" || predicate.op === "before-step"
    || predicate.op === "elapsed-days-gte" || predicate.op === "elapsed-days-lte"
    || predicate.op === "story-time-at-or-after" || predicate.op === "story-time-before") return;
  const entity = entities.get(predicate.entityId);
  if (!entity) {
    errors.push(issue("UNKNOWN_PREDICATE_ENTITY", `Predicate references unknown entity ${predicate.entityId}`));
    return;
  }
  try {
    const field = schema.get(predicate.field);
    if (!field.appliesTo.includes(entity.kind as never)) errors.push(issue("INVALID_PREDICATE_FIELD", `${predicate.field} does not apply to ${entity.kind}`));
    if (predicate.op === "fact-equals") schema.validateValue(field, predicate.value, entities as never);
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

function issue(code: string, message: string, path?: string): ValidationIssue {
  return path ? { code, message, path } : { code, message };
}

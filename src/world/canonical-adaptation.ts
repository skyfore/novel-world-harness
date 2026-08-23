import { z } from "zod";
import { canonicalJson, contentHash } from "./canonical.js";
import type { WorldModelContext } from "./engine.js";
import { evaluatePossibility, type FrontierTemporalMode } from "./frontier.js";
import {
  actorAffectSchema,
  actorEventObservationSchema,
  canonicalRoleBindingSchema,
  type CanonicalRoleBinding,
  type EventProposal,
  type KnowledgeDelta,
  type Possibility,
  type Predicate,
  type StateDelta,
  type StateOperation,
  type StateValue,
  type ValidationIssue,
  type WorldState,
} from "./model.js";

const MAX_ROLE_CANDIDATES = 24;
const MAX_BINDING_COMBINATIONS = 256;
export const MAX_CANONICAL_BINDING_OPTIONS = 32;

export const canonicalAttachmentResolutionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("none") }).strict(),
  z.object({
    decision: z.literal("attach"),
    bindingOptionId: z.string().regex(/^binding-[0-9]{3}$/),
    title: z.string().trim().min(1).max(500),
    roleObservations: z.array(z.object({
      roleId: z.string().min(1),
      summary: actorEventObservationSchema.shape.summary,
    }).strict()).max(4),
    roleAffects: z.array(z.object({
      roleId: z.string().min(1),
      label: actorAffectSchema.shape.label,
      intensity: actorAffectSchema.shape.intensity,
      expression: actorAffectSchema.shape.expression,
    }).strict()).max(4),
  }).strict().superRefine((value, ctx) => {
    const observationRoles = new Set<string>();
    value.roleObservations.forEach((observation, index) => {
      if (observationRoles.has(observation.roleId)) {
        ctx.addIssue({ code: "custom", message: `Duplicate role observation ${observation.roleId}`, path: ["roleObservations", index, "roleId"] });
      }
      observationRoles.add(observation.roleId);
    });
    const affectRoles = new Set<string>();
    value.roleAffects.forEach((affect, index) => {
      if (affectRoles.has(affect.roleId)) {
        ctx.addIssue({ code: "custom", message: `Duplicate role affect ${affect.roleId}`, path: ["roleAffects", index, "roleId"] });
      }
      affectRoles.add(affect.roleId);
    });
  }),
]);
export type CanonicalAttachmentResolution = z.infer<typeof canonicalAttachmentResolutionSchema>;

export type CanonicalBindingOptionView = Readonly<{
  bindingOptionId: string;
  stateEffects: string[];
  knowledgeEffects: string[];
  roles: Array<{
    roleId: string;
    description: string;
    canonicalName: string;
    boundName: string;
    boundKind: string;
  }>;
}>;

export type CanonicalAttachmentResolverInput = Readonly<{
  canonicalEvent: {
    title: string;
    readerSummary?: string;
  };
  scaffold: {
    title: string;
  };
  bindingOptions: CanonicalBindingOptionView[];
  recentCommittedEvents: Array<{
    title: string;
    participantNames: string[];
  }>;
}>;

export type CanonicalAttachmentResolver = (
  input: CanonicalAttachmentResolverInput,
) => Promise<unknown> | unknown;

export type InstantiatedCanonicalScaffold = {
  possibility: Possibility;
  bindings: CanonicalRoleBinding[];
  coreEffectHash: string;
};

export type CanonicalBindingOption = InstantiatedCanonicalScaffold & {
  bindingOptionId: string;
};

export type CanonicalBindingEvaluation = {
  options: CanonicalBindingOption[];
  reasons: string[];
};

export type CanonicalScaffoldSemanticContext = Pick<
  WorldModelContext,
  "entities" | "claims" | "stateSchema"
>;
export type CanonicalScaffoldRoleNeutralityInput = Pick<
  Possibility,
  "canonicalScaffold" | "preconditions" | "blockers" | "expiry" | "proposedDelta" | "proposedKnowledge"
>;

/**
 * Entity-ref fields are substituted structurally. Opaque strings are not. A
 * scaffold that embeds a replaceable person's identity in those strings would
 * retain canon-specific meaning after rebinding and therefore fails closed.
 */
export function canonicalScaffoldRoleNeutralityIssues(
  scaffold: CanonicalScaffoldRoleNeutralityInput,
  context: CanonicalScaffoldSemanticContext,
  roleEntityIds?: ReadonlySet<string>,
): string[] {
  const policy = scaffold.canonicalScaffold;
  if (!policy) return [];
  const issues = new Set<string>();
  for (const role of policy.roles) {
    if (roleEntityIds && !roleEntityIds.has(role.canonicalEntityId)) continue;
    const entity = context.entities.get(role.canonicalEntityId);
    if (!entity) continue;
    const terms = [entity.id, entity.canonicalName, ...entity.aliases]
      .map((term) => term.normalize("NFKC").trim())
      .filter((term) => term.length >= 2);
    const inspectValue = (value: unknown, path: string) => {
      if (opaqueValueContainsTerm(value, terms)) {
        issues.add(`${path} embeds the replaceable identity ${role.canonicalEntityId} in opaque text`);
      }
    };
    const inspectPredicate = (predicate: Predicate, path: string): void => {
      if (predicate.op === "all" || predicate.op === "any") {
        predicate.items.forEach((item, index) => inspectPredicate(item, `${path}.items.${index}`));
        return;
      }
      if (predicate.op === "not") {
        inspectPredicate(predicate.item, `${path}.item`);
        return;
      }
      if (predicate.op !== "fact-equals") return;
      try {
        const spec = context.stateSchema.get(predicate.field);
        if (spec.valueType === "entity-ref" || spec.valueType === "entity-ref-set") return;
      } catch {
        // Unknown fields are rejected elsewhere; treating their values as
        // opaque here is the conservative choice.
      }
      inspectValue(predicate.value, `${path}.value`);
    };
    scaffold.preconditions.forEach((predicate, index) => inspectPredicate(predicate, `preconditions.${index}`));
    scaffold.blockers.forEach((predicate, index) => inspectPredicate(predicate, `blockers.${index}`));
    scaffold.expiry?.forEach((predicate, index) => inspectPredicate(predicate, `expiry.${index}`));
    role.requiredState.forEach((predicate, index) =>
      inspectPredicate(predicate, `canonicalScaffold.roles.${role.roleId}.requiredState.${index}`));
    scaffold.proposedDelta?.operations.forEach((operation, index) => {
      if (operation.op !== "set") return;
      try {
        const spec = context.stateSchema.get(operation.field);
        if (spec.valueType === "entity-ref" || spec.valueType === "entity-ref-set") return;
      } catch {
        // See predicate handling above.
      }
      inspectValue(operation.value, `proposedDelta.operations.${index}.value`);
    });
    scaffold.proposedKnowledge?.operations.forEach((operation, index) => {
      const claim = context.claims?.get(operation.claimId);
      if (!claim) return;
      inspectValue({
        subject: claim.subject,
        predicate: claim.predicate,
        object: claim.object,
        ...(claim.speaker ? { speaker: claim.speaker } : {}),
      }, `proposedKnowledge.operations.${index}.claim`);
    });
  }
  return [...issues].sort();
}

export function instantiateCanonicalScaffold(
  scaffold: Possibility,
  bindingInput: readonly CanonicalRoleBinding[],
  context: WorldModelContext,
): InstantiatedCanonicalScaffold {
  const policy = scaffold.canonicalScaffold;
  if (!policy || !scaffold.canonicalEventId || !scaffold.proposedDelta) {
    throw new Error(`Possibility ${scaffold.id} is not an executable canonical scaffold`);
  }
  const parsedBindings = canonicalRoleBindingSchema.array().parse(bindingInput);
  if (parsedBindings.length !== policy.roles.length) {
    throw new Error(`Canonical scaffold ${scaffold.id} requires exactly ${policy.roles.length} role binding(s)`);
  }
  const suppliedByRole = new Map(parsedBindings.map((binding) => [binding.roleId, binding]));
  const bindings = policy.roles.map((role) => {
    const binding = suppliedByRole.get(role.roleId);
    if (!binding || binding.canonicalEntityId !== role.canonicalEntityId) {
      throw new Error(`Canonical scaffold ${scaffold.id} has an invalid binding for role ${role.roleId}`);
    }
    const canonicalEntity = context.entities.get(role.canonicalEntityId);
    if (!canonicalEntity) throw new Error(`Unknown canonical scaffold entity ${role.canonicalEntityId}`);
    if (!role.allowedEntityKinds.includes(canonicalEntity.kind)) {
      throw new Error(`Canonical role ${role.roleId} does not admit its source entity kind ${canonicalEntity.kind}`);
    }
    const boundEntity = context.entities.get(binding.boundEntityId);
    if (!boundEntity) throw new Error(`Unknown canonical scaffold binding ${binding.boundEntityId}`);
    if (!role.allowedEntityKinds.includes(boundEntity.kind)) {
      throw new Error(`Entity ${binding.boundEntityId} cannot fill canonical role ${role.roleId}`);
    }
    if (scaffold.participantPresence?.some((presence) => presence.entityId === role.canonicalEntityId)
      && boundEntity.kind !== "character") {
      throw new Error(`Entity ${binding.boundEntityId} cannot fill physically present character role ${role.roleId}`);
    }
    return structuredClone(binding);
  });
  const boundIds = bindings.map((binding) => binding.boundEntityId);
  if (new Set(boundIds).size !== boundIds.length) {
    throw new Error(`Canonical scaffold ${scaffold.id} cannot bind one entity to multiple roles`);
  }
  const substitutions = new Map(bindings.map((binding) => [binding.canonicalEntityId, binding.boundEntityId]));
  const reboundEntityIds = new Set(bindings
    .filter((binding) => binding.canonicalEntityId !== binding.boundEntityId)
    .map((binding) => binding.canonicalEntityId));
  const neutralityIssues = canonicalScaffoldRoleNeutralityIssues(scaffold, context, reboundEntityIds);
  if (neutralityIssues.length) {
    throw new Error(`Canonical scaffold ${scaffold.id} cannot safely rebind opaque role references: ${neutralityIssues.join("; ")}`);
  }
  const fixedParticipants = new Set(scaffold.participants.filter((participant) => !substitutions.has(participant)));
  for (const boundId of boundIds) {
    if (fixedParticipants.has(boundId)) {
      throw new Error(`Canonical scaffold ${scaffold.id} binding ${boundId} collides with a fixed participant`);
    }
  }
  const roleRequirements = policy.roles.flatMap((role) => role.requiredState);
  const preconditions = uniquePredicates(
    [...scaffold.preconditions, ...roleRequirements]
      .map((predicate) => substitutePredicate(predicate, substitutions, context)),
  );
  const proposedDelta = substituteDelta(scaffold.proposedDelta, substitutions, context);
  const proposedKnowledge = scaffold.proposedKnowledge
    ? substituteKnowledge(scaffold.proposedKnowledge, substitutions)
    : undefined;
  const possibility: Possibility = {
    ...structuredClone(scaffold),
    participants: scaffold.participants.map((participant) => substitutions.get(participant) ?? participant),
    ...(scaffold.participantPresence
      ? { participantPresence: scaffold.participantPresence.map((presence) => ({
          ...presence,
          entityId: substitutions.get(presence.entityId) ?? presence.entityId,
        })) }
      : {}),
    preconditions,
    blockers: scaffold.blockers.map((predicate) => substitutePredicate(predicate, substitutions, context)),
    ...(scaffold.expiry
      ? { expiry: scaffold.expiry.map((predicate) => substitutePredicate(predicate, substitutions, context)) }
      : {}),
    proposedDelta,
    ...(proposedKnowledge ? { proposedKnowledge } : { proposedKnowledge: undefined }),
  };
  if (new Set(possibility.participants).size !== possibility.participants.length) {
    throw new Error(`Canonical scaffold ${scaffold.id} produces duplicate participants`);
  }
  const coreEffectHash = contentHash({ proposedDelta, proposedKnowledge: proposedKnowledge ?? null });
  return { possibility, bindings, coreEffectHash };
}

export async function evaluateCanonicalBindingOptions(input: {
  scaffold: Possibility;
  context: WorldModelContext;
  state: WorldState;
  knownClaimIdsByActor: ReadonlyMap<string, ReadonlySet<string>>;
  availableEntityIds: ReadonlySet<string>;
  activeEntityIds: ReadonlySet<string>;
  realizedIds: ReadonlySet<string>;
  adaptedIds: ReadonlySet<string>;
  supersededIds: ReadonlySet<string>;
  temporalMode: FrontierTemporalMode;
}): Promise<CanonicalBindingEvaluation> {
  const policy = input.scaffold.canonicalScaffold;
  if (!policy) return { options: [], reasons: ["possibility has no canonical scaffold policy"] };
  const fixedParticipants = new Set(input.scaffold.participants.filter((participant) =>
    !policy.roles.some((role) => role.canonicalEntityId === participant)));
  const candidatesByRole = policy.roles.map((role) => {
    const candidates = [...input.context.entities.values()]
      .filter((entity) => role.allowedEntityKinds.includes(entity.kind))
      .filter((entity) => input.availableEntityIds.has(entity.id))
      .filter((entity) => !fixedParticipants.has(entity.id))
      .filter((entity) => entity.kind !== "character" || input.state.values[entity.id]?.["character.alive"] !== false)
      .filter((entity) => role.presence !== "active-scene" || input.activeEntityIds.has(entity.id))
      .filter((entity) => role.requiresKnowledge.length === 0
        || (entity.kind === "character" && role.requiresKnowledge.every((claimId) =>
          input.knownClaimIdsByActor.get(entity.id)?.has(claimId))))
      .sort((left, right) => {
        const leftActive = Number(input.activeEntityIds.has(left.id));
        const rightActive = Number(input.activeEntityIds.has(right.id));
        const leftCanonical = Number(left.id === role.canonicalEntityId);
        const rightCanonical = Number(right.id === role.canonicalEntityId);
        return rightActive - leftActive || rightCanonical - leftCanonical || left.id.localeCompare(right.id);
      })
      .slice(0, MAX_ROLE_CANDIDATES);
    return { role, candidates };
  });
  const emptyRole = candidatesByRole.find(({ candidates }) => candidates.length === 0);
  if (emptyRole) {
    return { options: [], reasons: [`no current entity can fill role ${emptyRole.role.roleId}`] };
  }

  const combinations: CanonicalRoleBinding[][] = [];
  const visit = (index: number, selected: CanonicalRoleBinding[], used: Set<string>) => {
    if (combinations.length >= MAX_BINDING_COMBINATIONS) return;
    const next = candidatesByRole[index];
    if (!next) {
      combinations.push(selected.map((binding) => structuredClone(binding)));
      return;
    }
    for (const entity of next.candidates) {
      if (used.has(entity.id)) continue;
      used.add(entity.id);
      selected.push({
        roleId: next.role.roleId,
        canonicalEntityId: next.role.canonicalEntityId,
        boundEntityId: entity.id,
      });
      visit(index + 1, selected, used);
      selected.pop();
      used.delete(entity.id);
      if (combinations.length >= MAX_BINDING_COMBINATIONS) break;
    }
  };
  visit(0, [], new Set());

  const viable: InstantiatedCanonicalScaffold[] = [];
  for (const bindings of combinations) {
    let instantiated: InstantiatedCanonicalScaffold;
    try {
      instantiated = instantiateCanonicalScaffold(input.scaffold, bindings, input.context);
    } catch {
      continue;
    }
    const evaluation = evaluatePossibility(input.state, instantiated.possibility, {
      realizedIds: input.realizedIds,
      adaptedIds: input.adaptedIds,
      supersededIds: input.supersededIds,
      temporalMode: input.temporalMode,
      temporalAnchor: input.state.logicalTime.storyTime,
      activeEntityIds: input.activeEntityIds,
      rootEvidenceSupported: true,
    });
    if (evaluation.status === "eligible") viable.push(instantiated);
  }
  viable.sort((left, right) => {
    const leftActive = left.bindings.filter((binding) => input.activeEntityIds.has(binding.boundEntityId)).length;
    const rightActive = right.bindings.filter((binding) => input.activeEntityIds.has(binding.boundEntityId)).length;
    const leftCanonical = left.bindings.filter((binding) => binding.canonicalEntityId === binding.boundEntityId).length;
    const rightCanonical = right.bindings.filter((binding) => binding.canonicalEntityId === binding.boundEntityId).length;
    return rightActive - leftActive
      || rightCanonical - leftCanonical
      || canonicalJson(left.bindings).localeCompare(canonicalJson(right.bindings));
  });
  const options = viable.slice(0, MAX_CANONICAL_BINDING_OPTIONS).map((candidate, index) => ({
    ...candidate,
    bindingOptionId: `binding-${String(index + 1).padStart(3, "0")}`,
  }));
  return {
    options,
    reasons: options.length
      ? []
      : [combinations.length
          ? "no role binding satisfies the scaffold's hard state, blocker, causal, and time constraints"
          : "no collision-free role binding combination exists"],
  };
}

/**
 * Recomputes the immutable scaffold contract at the engine boundary.  Titles,
 * observations, affects, and progress may be expanded; participants, time,
 * preconditions, effects, knowledge, evidence, and role lineage may not.
 */
export function validateCanonicalAdaptationContract(
  proposal: EventProposal,
  context: WorldModelContext,
): ValidationIssue[] {
  const adaptation = proposal.canonicalAdaptation;
  if (!adaptation) return [];
  const issues: ValidationIssue[] = [];
  const scaffold = context.possibilityTemplates?.find((candidate) => candidate.id === adaptation.scaffoldPossibilityId);
  if (!scaffold?.canonicalScaffold) {
    return [{
      code: "UNKNOWN_CANONICAL_SCAFFOLD",
      message: `Unknown or non-adaptable canonical scaffold ${adaptation.scaffoldPossibilityId}`,
      path: "canonicalAdaptation.scaffoldPossibilityId",
    }];
  }
  if (scaffold.canonicalEventId !== adaptation.adaptedFromCanonicalEventId || !context.events?.has(adaptation.adaptedFromCanonicalEventId)) {
    issues.push({
      code: "CANONICAL_ADAPTATION_EVENT_MISMATCH",
      message: `Scaffold ${scaffold.id} does not adapt canonical event ${adaptation.adaptedFromCanonicalEventId}`,
      path: "canonicalAdaptation.adaptedFromCanonicalEventId",
    });
  }
  let instantiated: InstantiatedCanonicalScaffold | undefined;
  try {
    instantiated = instantiateCanonicalScaffold({
      ...scaffold,
      branchId: proposal.branchId,
      evaluatedAtCommit: proposal.expectedParentCommit,
    }, adaptation.roleBindings, context);
  } catch (error) {
    issues.push({
      code: "INVALID_CANONICAL_ROLE_BINDING",
      message: error instanceof Error ? error.message : String(error),
      path: "canonicalAdaptation.roleBindings",
    });
  }
  if (!instantiated) return issues;
  const expected = instantiated.possibility;
  const compare = (actual: unknown, wanted: unknown, code: string, path: string) => {
    if (canonicalJson(actual) !== canonicalJson(wanted)) {
      issues.push({ code, message: `Canonical adaptation altered locked scaffold field ${path}`, path });
    }
  };
  if (proposal.source !== "canon-candidate") {
    issues.push({ code: "INVALID_CANONICAL_ADAPTATION_SOURCE", message: "Canonical adaptations must use source=canon-candidate", path: "source" });
  }
  if (context.entities.get(adaptation.sceneActorId)?.kind !== "character") {
    issues.push({
      code: "INVALID_CANONICAL_ADAPTATION_SCENE_ACTOR",
      message: `Canonical adaptation scene anchor ${adaptation.sceneActorId} is not a character`,
      path: "canonicalAdaptation.sceneActorId",
    });
  }
  compare(proposal.possibilityId, scaffold.id, "CANONICAL_SCAFFOLD_ID_MISMATCH", "possibilityId");
  compare(proposal.participants, expected.participants, "CANONICAL_ADAPTATION_PARTICIPANTS_CHANGED", "participants");
  compare(proposal.participantPresence, expected.participantPresence, "CANONICAL_ADAPTATION_PRESENCE_CHANGED", "participantPresence");
  compare(proposal.proposedTime, expected.candidateWindow ?? { kind: "unknown" }, "CANONICAL_ADAPTATION_TIME_CHANGED", "proposedTime");
  compare(proposal.timeAdvance, expected.timeAdvance, "CANONICAL_ADAPTATION_TIME_ADVANCE_CHANGED", "timeAdvance");
  compare(proposal.preconditions, expected.preconditions, "CANONICAL_ADAPTATION_PRECONDITIONS_CHANGED", "preconditions");
  compare(proposal.proposedDelta, expected.proposedDelta, "CANONICAL_ADAPTATION_EFFECT_CHANGED", "proposedDelta");
  compare(proposal.proposedKnowledge, expected.proposedKnowledge, "CANONICAL_ADAPTATION_KNOWLEDGE_CHANGED", "proposedKnowledge");
  compare(proposal.causalParents, expected.causalParents, "CANONICAL_ADAPTATION_CAUSAL_PARENTS_CHANGED", "causalParents");
  compare(proposal.evidence, expected.evidence, "CANONICAL_ADAPTATION_EVIDENCE_CHANGED", "evidence");
  compare(adaptation.roleBindings, instantiated.bindings, "CANONICAL_ADAPTATION_BINDINGS_CHANGED", "canonicalAdaptation.roleBindings");
  compare(adaptation.coreEffectHash, instantiated.coreEffectHash, "CANONICAL_ADAPTATION_CORE_HASH_MISMATCH", "canonicalAdaptation.coreEffectHash");
  if (proposal.supersedesCanonicalEventIds?.length) {
    issues.push({
      code: "CANONICAL_ADAPTATION_CANNOT_SUPERSEDE",
      message: "An adapted analogue cannot declare additional canonical supersession",
      path: "supersedesCanonicalEventIds",
    });
  }
  if (proposal.actorId) {
    issues.push({ code: "CANONICAL_ADAPTATION_ACTOR_FORBIDDEN", message: "A host scaffold adaptation is not an actor-owned proposal", path: "actorId" });
  }
  if (adaptation.roleBindings.every((binding) => binding.canonicalEntityId === binding.boundEntityId)) {
    issues.push({
      code: "CANONICAL_ADAPTATION_REQUIRES_REMAP",
      message: "A canonical adaptation must remap at least one declared functional role",
      path: "canonicalAdaptation.roleBindings",
    });
  }
  return issues;
}

export type CanonicalAdaptationRoleRequirement = {
  roleId: string;
  boundEntityId: string;
  presence: "anywhere" | "active-scene";
  requiresKnowledge: string[];
};

export function canonicalAdaptationRoleRequirements(
  proposal: EventProposal,
  context: WorldModelContext,
): CanonicalAdaptationRoleRequirement[] {
  const adaptation = proposal.canonicalAdaptation;
  if (!adaptation) return [];
  const scaffold = context.possibilityTemplates?.find((candidate) => candidate.id === adaptation.scaffoldPossibilityId);
  if (!scaffold?.canonicalScaffold) return [];
  const byRole = new Map(adaptation.roleBindings.map((binding) => [binding.roleId, binding]));
  return scaffold.canonicalScaffold.roles.flatMap((role) => {
    const binding = byRole.get(role.roleId);
    return binding ? [{
      roleId: role.roleId,
      boundEntityId: binding.boundEntityId,
      presence: role.presence,
      requiresKnowledge: [...role.requiresKnowledge],
    }] : [];
  });
}

function substitutePredicate(
  predicate: Predicate,
  substitutions: ReadonlyMap<string, string>,
  context: WorldModelContext,
): Predicate {
  if (predicate.op === "all" || predicate.op === "any") {
    return { ...predicate, items: predicate.items.map((item) => substitutePredicate(item, substitutions, context)) };
  }
  if (predicate.op === "not") {
    return { ...predicate, item: substitutePredicate(predicate.item, substitutions, context) };
  }
  if (predicate.op === "rule-active" || predicate.op === "after-step" || predicate.op === "before-step"
    || predicate.op === "elapsed-days-gte" || predicate.op === "elapsed-days-lte"
    || predicate.op === "story-time-at-or-after" || predicate.op === "story-time-before") {
    return structuredClone(predicate);
  }
  const entityId = substitutions.get(predicate.entityId) ?? predicate.entityId;
  if (predicate.op === "entity-in") {
    return { ...predicate, entityId, member: substitutions.get(predicate.member) ?? predicate.member };
  }
  if (predicate.op === "fact-equals") {
    return {
      ...predicate,
      entityId,
      value: substituteStateValue(predicate.field, predicate.value, substitutions, context),
    };
  }
  return { ...predicate, entityId };
}

function substituteDelta(
  delta: StateDelta,
  substitutions: ReadonlyMap<string, string>,
  context: WorldModelContext,
): StateDelta {
  return {
    version: 1,
    operations: delta.operations.map((operation): StateOperation => {
      if (operation.op === "activate-rule" || operation.op === "deactivate-rule") return structuredClone(operation);
      const entityId = substitutions.get(operation.entityId) ?? operation.entityId;
      if (operation.op === "set") {
        return {
          ...operation,
          entityId,
          value: substituteStateValue(operation.field, operation.value, substitutions, context),
        };
      }
      if (operation.op === "add-member" || operation.op === "remove-member") {
        return { ...operation, entityId, member: substitutions.get(operation.member) ?? operation.member };
      }
      return { ...operation, entityId };
    }),
  };
}

function substituteKnowledge(
  delta: KnowledgeDelta,
  substitutions: ReadonlyMap<string, string>,
): KnowledgeDelta {
  return {
    version: 1,
    operations: delta.operations.map((operation) => operation.op === "learn"
      ? {
          ...operation,
          actorId: substitutions.get(operation.actorId) ?? operation.actorId,
          ...(operation.sourceActorId
            ? { sourceActorId: substitutions.get(operation.sourceActorId) ?? operation.sourceActorId }
            : {}),
        }
      : { ...operation, actorId: substitutions.get(operation.actorId) ?? operation.actorId }),
  };
}

function substituteStateValue(
  field: string,
  value: StateValue,
  substitutions: ReadonlyMap<string, string>,
  context: WorldModelContext,
): StateValue {
  const spec = context.stateSchema.get(field);
  if (spec.valueType === "entity-ref" && typeof value === "string") return substitutions.get(value) ?? value;
  if (spec.valueType === "entity-ref-set" && Array.isArray(value)) {
    return value.map((member) => substitutions.get(member) ?? member);
  }
  return structuredClone(value);
}

function uniquePredicates(predicates: readonly Predicate[]): Predicate[] {
  const seen = new Set<string>();
  const result: Predicate[] = [];
  for (const predicate of predicates) {
    const key = canonicalJson(predicate);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(predicate);
  }
  return result;
}

function opaqueValueContainsTerm(value: unknown, terms: readonly string[]): boolean {
  if (typeof value === "string") return terms.some((term) => stringContainsTerm(value, term));
  if (Array.isArray(value)) return value.some((item) => opaqueValueContainsTerm(item, terms));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) =>
    terms.some((term) => stringContainsTerm(key, term)) || opaqueValueContainsTerm(item, terms));
}

function stringContainsTerm(value: string, term: string): boolean {
  const normalizedValue = value.normalize("NFKC").toLocaleLowerCase("und");
  const normalizedTerm = term.normalize("NFKC").toLocaleLowerCase("und");
  if (/^[a-z0-9._-]+$/u.test(normalizedTerm)) {
    const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "u").test(normalizedValue);
  }
  return normalizedValue.includes(normalizedTerm);
}

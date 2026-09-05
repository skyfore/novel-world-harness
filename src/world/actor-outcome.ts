import {
  branchSemanticProposalDeltaSchema, processProposalDeltaSchema, normProposalDeltaSchema,
  type EventProposal, type ValidationIssue,
} from "./model.js";
import type { ActorDecisionView } from "./actor-decision-view.js";
import type { WorldProjectionBundle } from "./projection-service.js";

/** The same three nonphysical channels cross every actor adapter. */
export const actorOutcomeShape = {
  proposedSemantics: branchSemanticProposalDeltaSchema.optional(),
  proposedProcesses: processProposalDeltaSchema.optional(),
  proposedNorms: normProposalDeltaSchema.optional(),
};
export type ActorOutcome = Pick<EventProposal, "proposedSemantics" | "proposedProcesses" | "proposedNorms">;

export function copyActorOutcome(value: ActorOutcome): ActorOutcome {
  return {
    ...(value.proposedSemantics ? { proposedSemantics: structuredClone(value.proposedSemantics) } : {}),
    ...(value.proposedProcesses ? { proposedProcesses: structuredClone(value.proposedProcesses) } : {}),
    ...(value.proposedNorms ? { proposedNorms: structuredClone(value.proposedNorms) } : {}),
  };
}

export function hasActorOutcome(value: ActorOutcome): boolean {
  return Boolean(value.proposedSemantics?.operations.length || value.proposedProcesses?.operations.length || value.proposedNorms?.operations.length);
}

/** Map typed references only. Descriptions, relation/dimension names and literals are data. */
export function mapActorOutcome(value: ActorOutcome, entity: (id: string) => string, ref: (id: string) => string): ActorOutcome {
  const result = copyActorOutcome(value);
  for (const op of result.proposedSemantics?.operations ?? []) {
    switch (op.op) {
      case "record-proposition":
        op.proposition.subjectEntityId = entity(op.proposition.subjectEntityId);
        if (op.proposition.object.kind === "entity") op.proposition.object.entityId = entity(op.proposition.object.entityId);
        if (op.proposition.object.kind === "proposition") op.proposition.object.propositionId = ref(op.proposition.object.propositionId);
        if (op.proposition.validStoryTime?.kind === "relative") op.proposition.validStoryTime.anchorEventId = ref(op.proposition.validStoryTime.anchorEventId);
        break;
      case "record-attribution":
        op.attribution.propositionId = ref(op.attribution.propositionId);
        if (op.attribution.holderEntityId) op.attribution.holderEntityId = entity(op.attribution.holderEntityId);
        if (op.attribution.sourceAttributionId) op.attribution.sourceAttributionId = ref(op.attribution.sourceAttributionId);
        break;
      case "record-claim":
        op.claim.propositionId = ref(op.claim.propositionId);
        if (op.claim.attributionId) op.claim.attributionId = ref(op.claim.attributionId);
        break;
      case "open-goal":
        op.goal.actorId = entity(op.goal.actorId);
        op.goal.targetEntityIds = op.goal.targetEntityIds.map(entity);
        if (op.goal.parentGoalId) op.goal.parentGoalId = ref(op.goal.parentGoalId);
        break;
      case "close-goal": op.goalId = ref(op.goalId); break;
      case "record-appraisal":
        op.appraisal.actorId = entity(op.appraisal.actorId);
        if (op.appraisal.target.kind === "entity") op.appraisal.target.entityId = entity(op.appraisal.target.entityId);
        if (op.appraisal.target.kind === "event") op.appraisal.target.eventId = ref(op.appraisal.target.eventId);
        if (op.appraisal.target.kind === "proposition") op.appraisal.target.propositionId = ref(op.appraisal.target.propositionId);
        break;
      case "adjust-relationship":
        op.relationshipRef = ref(op.relationshipRef);
        op.fromActorId = entity(op.fromActorId); op.toActorId = entity(op.toActorId); break;
      case "create-obligation":
        op.obligation.debtorActorId = entity(op.obligation.debtorActorId);
        if (op.obligation.creditorActorId) op.obligation.creditorActorId = entity(op.obligation.creditorActorId);
        if (op.obligation.dueStoryTime?.kind === "relative") op.obligation.dueStoryTime.anchorEventId = ref(op.obligation.dueStoryTime.anchorEventId);
        break;
      case "resolve-obligation": op.obligationId = ref(op.obligationId); break;
    }
  }
  for (const op of result.proposedProcesses?.operations ?? []) {
    if (op.op === "start-process") {
      op.process.templateId = ref(op.process.templateId);
      op.process.ownerBindings = op.process.ownerBindings.map((binding) => ({ ...binding, entityIds: binding.entityIds.map(entity) }));
    } else op.processRef = ref(op.processRef);
  }
  for (const op of result.proposedNorms?.operations ?? []) {
    if (op.op === "instantiate-norm") {
      op.norm.templateId = ref(op.norm.templateId);
      op.norm.subjectActorId = entity(op.norm.subjectActorId);
      if (op.norm.beneficiaryActorId) op.norm.beneficiaryActorId = entity(op.norm.beneficiaryActorId);
      if (op.norm.dueStoryTime?.kind === "relative") op.norm.dueStoryTime.anchorEventId = ref(op.norm.dueStoryTime.anchorEventId);
    } else {
      op.normRef = ref(op.normRef);
      if (op.byActorId) op.byActorId = entity(op.byActorId);
    }
  }
  return result;
}

export function validateActorOutcomeScope(value: ActorOutcome, scope: {
  actorId: string; visibleEntityIds: ReadonlySet<string>; decision?: ActorDecisionView;
}): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const view = scope.decision;
  const refs = new Set(view ? [
    ...view.goals.map((x) => x.id), ...view.appraisals.map((x) => x.id),
    ...view.relationships.map((x) => x.id), ...view.obligations.map((x) => x.id),
    ...view.norms.flatMap((x) => [x.id, x.templateId]), ...view.processes.flatMap((x) => [x.id, x.templateId]),
    ...view.capabilities.actions.map((x) => x.id), ...view.capabilities.processes.map((x) => x.id), ...view.capabilities.norms.map((x) => x.id),
  ] : []);
  const locals = new Set<string>();
  for (const channel of [value.proposedSemantics, value.proposedProcesses, value.proposedNorms]) {
    for (const op of channel?.operations ?? []) {
      if ("localRef" in op) locals.add(op.localRef);
      if (op.op === "adjust-relationship" && op.createIfMissing) locals.add(op.relationshipRef);
    }
  }
  const reject = (code: string, message: string) => errors.push({ code, message });
  mapActorOutcome(value, (id) => {
    if (!scope.visibleEntityIds.has(id)) reject("ACTOR_OUTCOME_ENTITY_OUT_OF_SCOPE", `Outcome references entity outside actor view: ${id}`);
    return id;
  }, (id) => {
    if (!refs.has(id) && !locals.has(id)) reject("ACTOR_OUTCOME_REFERENCE_OUT_OF_SCOPE", `Outcome references unavailable decision fact: ${id}`);
    return id;
  });
  return errors;
}

/** Final authority check also covers direct actor proposals, outside model adapters. */
export function validateActorOutcomeOwnership(proposal: EventProposal, projection: WorldProjectionBundle): ValidationIssue[] {
  if (!proposal.actorId || (proposal.source !== "player" && proposal.source !== "actor")) return [];
  const actor = proposal.actorId;
  const errors: ValidationIssue[] = [];
  const owned = (ok: boolean, path: string) => {
    if (!ok) errors.push({ code: "ACTOR_OUTCOME_AUTHORITY_REQUIRED", message: "An actor may change only its own goals, attitudes, accepted duties and owned processes", path });
  };
  const introducedGoals = new Set<string>();
  const introducedObligations = new Map<string, string | undefined>();
  for (const [index, op] of (proposal.proposedSemantics?.operations ?? []).entries()) {
    const path = `proposedSemantics.operations.${index}`;
    switch (op.op) {
      case "open-goal": owned(op.goal.actorId === actor, path); introducedGoals.add(op.localRef); break;
      case "close-goal": owned(introducedGoals.has(op.goalId) || projection.semantics.goals[op.goalId]?.actorId === actor, path); break;
      case "record-appraisal": owned(op.appraisal.actorId === actor, path); break;
      case "adjust-relationship": owned(op.fromActorId === actor, path); break;
      case "record-attribution":
        owned(op.attribution.holderKind === "character" && op.attribution.holderEntityId === actor, path); break;
      case "create-obligation":
        // The debtor's own committed acceptance creates the duty; a request by its creditor does not.
        owned(op.obligation.debtorActorId === actor, path);
        introducedObligations.set(op.localRef, op.obligation.creditorActorId); break;
      case "resolve-obligation": {
        const obligation = projection.semantics.obligations[op.obligationId];
        const creditor = introducedObligations.get(op.obligationId) ?? obligation?.creditorActorId;
        // Fulfilment is acknowledged by the creditor. Self-declaration is not a receipt.
        owned(op.resolution === "fulfilled" || op.resolution === "waived"
          ? creditor === actor : obligation?.debtorActorId === actor && op.resolution === "violated", path);
        break;
      }
    }
  }
  const processes = new Set(Object.values(projection.processes.instances)
    .filter((item) => item.ownerBindings.some((binding) => binding.entityIds.includes(actor))).map((item) => item.id));
  for (const [index, op] of (proposal.proposedProcesses?.operations ?? []).entries()) {
    const path = `proposedProcesses.operations.${index}`;
    if (op.op === "start-process") {
      owned(op.process.ownerBindings.some((binding) => binding.entityIds.includes(actor))
        && op.process.ownerBindings.every((binding) => binding.entityIds.every((id) => id === actor || projection.state.values[id]?.["artifact.owner"] === actor)), path);
      processes.add(op.localRef);
    } else owned(processes.has(op.processRef), path);
  }
  const norms = new Map(Object.values(projection.norms.instances).map((item) => [item.id, { subject: item.subjectActorId, beneficiary: item.beneficiaryActorId }]));
  for (const [index, op] of (proposal.proposedNorms?.operations ?? []).entries()) {
    const path = `proposedNorms.operations.${index}`;
    if (op.op === "instantiate-norm") { owned(op.norm.subjectActorId === actor, path); norms.set(op.localRef, { subject: op.norm.subjectActorId, beneficiary: op.norm.beneficiaryActorId }); }
    else {
      const norm = norms.get(op.normRef);
      // A debtor's declaration is not a receipt. Deterministic norm evaluation
      // can still recognize a qualifying action; manual discharge needs its counterparty.
      owned(Boolean(norm) && (op.op === "satisfy-norm" || op.op === "repair-norm" ? norm?.beneficiary === actor : norm?.subject === actor)
        && (!op.byActorId || op.byActorId === actor), path);
    }
  }
  return errors;
}

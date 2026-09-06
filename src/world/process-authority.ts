import { actionPatternMatches, bindConstraintPredicate } from "./action-constraint.js";
import { applyProcessDelta, type ProcessReducerContext, type ProcessState } from "./process-effects.js";
import type { EffectProvenance } from "./semantic-effects.js";
import type { EventProposal, ProcessDelta, WorldState } from "./model.js";
import { evaluatePredicate } from "./state.js";

/** Check live actor intent before the replay reducer; historical effects remain immutable. */
export function validateActorProcessDelta(
  proposal: EventProposal, delta: ProcessDelta, initial: ProcessState,
  context: ProcessReducerContext, before: WorldState, after: WorldState, provenance: EffectProvenance,
): void {
  if (proposal.source !== "player" && proposal.source !== "actor") return;
  const elapsed = after.logicalTime.elapsedDays ?? 0;
  const duration = elapsed - (before.logicalTime.elapsedDays ?? 0);
  let staged = initial;
  const advanced = new Map<string, number>();
  for (const op of delta.operations) {
    const instance = op.op === "start-process" ? op.process : staged.instances[op.processId];
    if (!instance) throw new Error("Actor process operation references an unknown process");
    const template = context.templates.get(instance.templateId);
    if (!template) throw new Error(`Unknown process template ${instance.templateId}`);
    // Schedule and initial progress are host-derived, never accelerated by an actor.
    const due = op.op === "start-process" ? op.process.dueAtElapsedDays : "dueAtElapsedDays" in op ? op.dueAtElapsedDays : undefined;
    if (due !== undefined && due !== (template.cadence ? elapsed + template.cadence.intervalDays : undefined)) throw new Error("Actor process schedule must follow template cadence");
    if (op.op === "start-process" && op.process.progress !== 0) throw new Error("Actor processes must start with zero progress");
    const total = (advanced.get(instance.id) ?? 0) + (op.op === "advance-process" ? op.amount : 0);
    const controls = (template.actorControls ?? []).filter((control) => control.op === op.op);
    // Legacy templates permit accepting an unstarted job, but grant no progress authority.
    const initialAcceptance = op.op === "start-process" && controls.length === 0;
    const binding = { actorId: proposal.actorId, roles: new Map(instance.ownerBindings.map((role) => [role.roleId, role.entityIds])) };
    const authorized = controls.some((control) => proposal.action && actionPatternMatches(control.actionPattern, proposal.action)
      && duration >= control.minimumElapsedDays
      && (!control.fromPhaseId || control.fromPhaseId === instance.phaseId)
      && (!control.toPhaseId || op.op === "advance-process" && control.toPhaseId === (op.phaseId ?? instance.phaseId))
      && (!control.outcomeId || op.op === "finish-process" && control.outcomeId === op.outcomeId)
      && (op.op !== "advance-process" || total <= control.maximumAdvance!)
      && control.requiresBefore.every((predicate) => evaluatePredicate(before, bindConstraintPredicate(predicate, binding)))
      && control.requiresAfter.every((predicate) => evaluatePredicate(after, bindConstraintPredicate(predicate, binding))));
    if (!initialAcceptance && !authorized) throw new Error(`Actor process ${op.op} lacks a matching action/time/state control in ${template.id}`);
    staged = applyProcessDelta(staged, { version: 1, operations: [op] }, context, provenance, elapsed);
    advanced.set(instance.id, total);
  }
}

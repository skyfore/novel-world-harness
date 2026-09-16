import { contentHash } from "./canonical.js";
import type { EventProposal, EvidenceAssertion, KnowledgeDelta, ProcessDelta, ProcessProposalDelta, ValidationIssue, WorldState } from "./model.js";
import { applyProcessDelta, type ProcessReducerContext, type ProcessState } from "./process-effects.js";
import type { ProcessTemplate } from "./process-ontology.js";
import type { SemanticEffect } from "./semantic-effect.js";
import type { PerceptionObservation } from "./perception-observation.js";
import { actionPatternMatches, bindConstraintPredicate } from "./action-constraint.js";
import { evaluatePredicateTruth } from "./state.js";
import type { EffectProvenance } from "./semantic-effects.js";

/** Projection of active process phases; elapsed time and prose do not cure a character. */
export function lacksCapacity(actorId: string, capacity: "action" | "speech" | "perception", state: ProcessState, templates: ReadonlyMap<string, ProcessTemplate>): boolean {
  return Object.values(state.instances).some(instance => {
    const condition = templates.get(instance.templateId)?.incapacity;
    return condition?.capacity === capacity && instance.phaseId !== condition.recoveryPhaseId
      && instance.ownerBindings.some(binding => binding.roleId === condition.ownerRoleId && binding.entityIds.includes(actorId));
  });
}
export function capacityUseIssues(input: Pick<EventProposal, "actorId" | "spokenUtterances"> & { knowledge?: KnowledgeDelta }, before: ProcessState, after: ProcessState,
  templates: ReadonlyMap<string, ProcessTemplate>, perceptions: ReadonlyMap<string, PerceptionObservation> = new Map()): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (input.actorId && lacksCapacity(input.actorId, "action", before, templates)) issues.push({ code: "CHARACTER_ACTION_INCAPACITATED", message: "The actor lacks action capacity in the current committed process state. Preserve head and stop; a recovery must be committed through a declared mechanism.", path: "actorId" });
  for (const utterance of input.spokenUtterances ?? []) if (lacksCapacity(utterance.speakerId, "speech", before, templates)) issues.push({ code: "CHARACTER_SPEECH_INCAPACITATED", message: "The speaker cannot speak at this event's start. Do not remove actorId or let rendering supply speech; stop until a permitted recovery is committed.", path: "spokenUtterances" });
  for (const operation of input.knowledge?.operations ?? []) {
    if (operation.op !== "learn" || !["observed", "told", "read", "deceived-misattributed"].includes(operation.acquisitionMode ?? "")) continue;
    const cut = operation.perceptionId ? perceptions.get(operation.perceptionId)?.cut : undefined;
    if (lacksCapacity(operation.actorId, "perception", cut === "event-start" ? before : after, templates)) issues.push({ code: "CHARACTER_PERCEPTION_INCAPACITATED", message: "Sensory receipt is not supported at the acquisition cut. Preserve the process restriction; do not relabel acquisition or invent recovery.", path: "proposedKnowledge" });
  }
  return issues;
}

/** Deterministic onset lowering, only for the canonical occurrence actually attempted. */
export function incapacityOnsets(effects: Iterable<SemanticEffect>, eventIds: ReadonlySet<string>, templates: ReadonlyMap<string, ProcessTemplate>): ProcessProposalDelta["operations"] {
  return [...effects].filter(effect => effect.kind === "temporary-incapacity" && effect.lowering.status === "mapped" && eventIds.has(effect.canonicalEventId))
    .sort((a, b) => a.id.localeCompare(b.id)).map(effect => {
      if (effect.kind !== "temporary-incapacity" || effect.lowering.status !== "mapped") throw new Error("Invalid incapacity lowering");
      const template = templates.get(effect.lowering.processTemplateId);
      if (!template?.incapacity) throw new Error("SEMANTIC_EFFECT_PROCESS_MISMATCH: Missing frozen incapacity mechanism; stop for host compilation.");
      return { op: "start-process" as const, localRef: `local-incapacity-${contentHash(effect.id).slice(0, 20)}`, process: { templateId: template.id, ownerBindings: [{ roleId: template.incapacity.ownerRoleId, entityIds: [effect.subjectEntityId] }], progress: 0 } };
    });
}

/** Applies to every proposal source, so a background label cannot bypass recovery authority. */
export function validateIncapacityChanges(proposal: Pick<EventProposal, "actorId" | "action">, delta: ProcessDelta, initial: ProcessState, context: ProcessReducerContext,
  before: WorldState, after: WorldState, provenance: EffectProvenance, onsets: readonly ProcessProposalDelta["operations"][number][] = []): void {
  let staged = initial;
  const dueCompletions = new Map<string, string>();
  const advanced = new Map<string, number>();
  const started = new Set<string>();
  const elapsed = after.logicalTime.elapsedDays ?? 0;
  for (const operation of delta.operations) {
    const instance = operation.op === "start-process" ? operation.process : staged.instances[operation.processId];
    const template = instance ? context.templates.get(instance.templateId) : undefined;
    if (!instance || !template?.incapacity) { staged = applyProcessDelta(staged, { version: 1, operations: [operation] }, context, provenance, elapsed); continue; }
    const condition = template.incapacity;
    if (operation.op === "start-process") {
      const key = contentHash([instance.templateId, instance.ownerBindings]);
      if (started.has(key)) throw new Error("INCAPACITY_ONSET_DUPLICATE: One occurrence cannot start duplicate restrictions for the same mechanism and owner. Preserve head and stop; do not change local IDs to retry.");
      started.add(key);
    }
    if (operation.op === "pause-process" || operation.op === "resume-process") throw new Error("INCAPACITY_RECOVERY_UNAUTHORIZED: Pausing or resuming an incapacity is not a recovery mechanism; preserve the active restriction and stop.");
    const onset = operation.op === "start-process" && onsets.some(expected => expected.op === "start-process" && expected.process.templateId === instance.templateId && contentHash(expected.process.ownerBindings) === contentHash(instance.ownerBindings));
    const progress = (advanced.get(instance.id) ?? 0) + (operation.op === "advance-process" ? operation.amount : 0);
    const binding = { actorId: proposal.actorId, roles: new Map(instance.ownerBindings.map(role => [role.roleId, role.entityIds])) };
    const controlled = template.actorControls?.some(control => control.op === operation.op && proposal.action?.lane === "schema-bound" && actionPatternMatches(control.actionPattern, proposal.action)
      && contentHash(proposal.action.roleBindings.find(role => role.roleId === condition.ownerRoleId)?.entityIds ?? []) === contentHash(instance.ownerBindings.find(role => role.roleId === condition.ownerRoleId)?.entityIds ?? [])
      && elapsed - (before.logicalTime.elapsedDays ?? 0) >= control.minimumElapsedDays
      && (!control.fromPhaseId || control.fromPhaseId === instance.phaseId)
      && (!control.toPhaseId || operation.op === "advance-process" && control.toPhaseId === operation.phaseId)
      && (!control.outcomeId || operation.op === "finish-process" && operation.outcomeId === control.outcomeId)
      && (operation.op !== "advance-process" || progress <= (control.maximumAdvance ?? 0))
      && control.requiresBefore.every(predicate => evaluatePredicateTruth(before, bindConstraintPredicate(predicate, binding)) === "true")
      && control.requiresAfter.every(predicate => evaluatePredicateTruth(after, bindConstraintPredicate(predicate, binding)) === "true"));
    let due = false;
    if (operation.op === "advance-process" && condition.duration.kind === "days" && instance.dueAtElapsedDays !== undefined && elapsed >= instance.dueAtElapsedDays) {
      const transition = template.transitions.find(item => item.fromPhaseId === instance.phaseId && item.toPhaseId === operation.phaseId && item.onDue);
      due = Boolean(transition?.onDue && operation.amount === Math.min(transition.onDue.advanceBy, 1 - instance.progress));
      if (due && transition?.onDue?.outcomeId) dueCompletions.set(instance.id, transition.onDue.outcomeId);
    }
    if (operation.op === "finish-process") due = dueCompletions.get(instance.id) === operation.outcomeId;
    if (!onset && !controlled && !due) throw new Error("INCAPACITY_RECOVERY_UNAUTHORIZED: Incapacity change requires its actual onset, declared action control or due transition. Unknown duration is not a deadline. Preserve drafts/head and stop; do not change source labels or retry unchanged.");
    staged = applyProcessDelta(staged, { version: 1, operations: [operation] }, context, provenance, elapsed);
    advanced.set(instance.id, progress);
  }
}
export function validateIncapacityEvidence(template: ProcessTemplate, assertions: readonly EvidenceAssertion[]): ValidationIssue[] {
  if (!template.incapacity || template.induction.kind !== "source-pattern") return [];
  return ["/incapacity/ownerRoleId", "/incapacity/capacity", "/incapacity/recoveryPhaseId", "/incapacity/duration"].filter(pointer => !assertions.some(item => item.target.artifactKind === "process-template" && item.target.artifactId === template.id && item.target.jsonPointer === pointer && item.relation === "supports" && item.strength !== "weak-inference" && item.anchors.length))
    .map(path => ({ code: "INCAPACITY_EVIDENCE_MISSING", message: `Incapacity ${template.id} needs exact source support at ${path}`, path }));
}

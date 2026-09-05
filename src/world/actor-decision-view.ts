import { z } from "zod";
import { projectCharacterDevelopment } from "./development.js";
import type { WorldEngine } from "./engine.js";
import { idSchema } from "./model.js";
import { processOwnerEntityIds } from "./process-ontology.js";
import { evidenceBelongsExclusivelyToSource } from "./source-scope.js";

/** Actor-owned decision facts shared by player translation, NPCs and autonomous actors. */
export const actorDecisionViewSchema = z.object({
  goals: z.array(z.object({ id: idSchema, description: z.string(), priority: z.number(), targetIds: z.array(idSchema) }).strict()),
  appraisals: z.array(z.object({ id: idSchema, targetKind: z.enum(["entity", "event", "proposition"]), targetId: idSchema.optional(), dimensionId: idSchema, value: z.number() }).strict()),
  relationships: z.array(z.object({ id: idSchema, counterpartyId: idSchema, dimensions: z.record(z.string(), z.number()) }).strict()),
  obligations: z.array(z.object({ id: idSchema, role: z.enum(["debtor", "creditor"]), counterpartyId: idSchema.optional(), kindId: idSchema, description: z.string(), status: z.string() }).strict()),
  norms: z.array(z.object({ id: idSchema, templateId: idSchema, name: z.string(), modality: z.enum(["obligation", "prohibition", "permission"]), role: z.enum(["subject", "beneficiary"]), status: z.enum(["active", "violated"]), dueInDays: z.number().optional() }).strict()),
  processes: z.array(z.object({ id: idSchema, templateId: idSchema, name: z.string(), phase: z.string(), status: z.enum(["running", "paused"]), progress: z.number(), dueInDays: z.number().optional() }).strict()),
}).strict();
export type ActorDecisionView = z.infer<typeof actorDecisionViewSchema>;

export async function buildActorDecisionView(
  engine: WorldEngine,
  actorId: string,
  atCommit: string,
  scope: { visibleEntityIds: ReadonlySet<string>; knownClaimIds: ReadonlySet<string>; sourceId?: string },
): Promise<ActorDecisionView> {
  const [context, projection, development] = await Promise.all([
    engine.contextForCommit(atCommit), engine.projections.project(atCommit),
    projectCharacterDevelopment(engine, actorId, atCommit),
  ]);
  const activeGoals = new Set(development.activeGoalIds);
  const semantics = development.branchSemantics;
  const visible = (id: string) => scope.visibleEntityIds.has(id);
  const elapsed = projection.state.logicalTime.elapsedDays ?? 0;
  const goals = [
    ...(context.actorGoals ?? []).filter((goal) => goal.actorId === actorId && activeGoals.has(goal.id)
      && evidenceBelongsExclusivelyToSource(goal.evidence, scope.sourceId))
      .map((goal) => ({ id: goal.id, description: goal.description, priority: goal.priority, targetIds: (goal.targetIds ?? []).filter(visible) })),
    ...semantics.goals.filter((goal) => goal.status === "open")
      .map((goal) => ({ id: goal.id, description: goal.description, priority: goal.priority, targetIds: goal.targetEntityIds.filter(visible) })),
  ].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const appraisals = semantics.appraisals.flatMap((item): ActorDecisionView["appraisals"] => {
    if (item.target.kind === "entity" && !visible(item.target.entityId)) return [];
    return [{ id: item.id, targetKind: item.target.kind === "current-event" ? "event" : item.target.kind,
      ...(item.target.kind === "entity" ? { targetId: item.target.entityId } : {}),
      dimensionId: item.dimensionId, value: item.value }];
  });
  // A counterparty's private attitude is not automatically known by its target.
  const relationships = semantics.relationships.filter((item) => item.fromActorId === actorId && visible(item.toActorId))
    .map((item) => ({ id: item.id, counterpartyId: item.toActorId, dimensions: structuredClone(item.dimensions) }));
  const obligations = semantics.obligations.map((item): ActorDecisionView["obligations"][number] => {
    const role = item.debtorActorId === actorId ? "debtor" : "creditor";
    const counterparty = role === "debtor" ? item.creditorActorId : item.debtorActorId;
    return { id: item.id, role, ...(counterparty && visible(counterparty) ? { counterpartyId: counterparty } : {}),
      kindId: item.kindId, description: item.description, status: item.status };
  });
  const norms = Object.values(projection.norms.instances).flatMap((item): ActorDecisionView["norms"] => {
    if (item.status !== "active" && item.status !== "violated") return [];
    const role = item.subjectActorId === actorId ? "subject" : item.beneficiaryActorId === actorId ? "beneficiary" : undefined;
    const template = context.normTemplates?.get(item.templateId);
    if (!role || !template || template.visibility === "engine") return [];
    if (template.induction.kind === "source-pattern" && !evidenceBelongsExclusivelyToSource(template.evidence, scope.sourceId)) return [];
    if (template.visibility === "knowledge" && !template.knownByClaimIds.every((id) => scope.knownClaimIds.has(id))) return [];
    return [{ id: item.id, templateId: template.id, name: template.name, modality: template.modality, role, status: item.status,
      ...(item.dueAtElapsedDays !== undefined ? { dueInDays: item.dueAtElapsedDays - elapsed } : {}) }];
  });
  const processes = Object.values(projection.processes.instances).flatMap((item): ActorDecisionView["processes"] => {
    if (item.status === "finished" || !processOwnerEntityIds(item).includes(actorId)) return [];
    const template = context.processTemplates?.get(item.templateId);
    if (!template || template.visibility === "engine" || template.visibility === "knowledge") return [];
    if (template.induction.kind === "source-pattern" && !evidenceBelongsExclusivelyToSource(template.evidence, scope.sourceId)) return [];
    const phase = template.phases.find((entry) => entry.id === item.phaseId)?.label;
    if (!phase) return [];
    return [{ id: item.id, templateId: template.id, name: template.name, phase, status: item.status, progress: item.progress,
      ...(item.dueAtElapsedDays !== undefined ? { dueInDays: item.dueAtElapsedDays - elapsed } : {}) }];
  });
  norms.sort((a, b) => a.id.localeCompare(b.id));
  processes.sort((a, b) => a.id.localeCompare(b.id));
  return actorDecisionViewSchema.parse({ goals, appraisals, relationships, obligations, norms, processes });
}

export function decisionReferenceIds(view?: ActorDecisionView): string[] {
  if (!view) return [];
  return [...new Set([
    ...view.goals.map((item) => item.id), ...view.appraisals.map((item) => item.id),
    ...view.relationships.map((item) => item.id), ...view.obligations.map((item) => item.id),
    ...view.norms.flatMap((item) => [item.id, item.templateId]),
    ...view.processes.flatMap((item) => [item.id, item.templateId]),
  ])].sort();
}

export function mapActorDecisionView(view: ActorDecisionView, entity: (id: string) => string, ref: (id: string) => string): ActorDecisionView {
  return {
    goals: view.goals.map((item) => ({ ...item, id: ref(item.id), targetIds: item.targetIds.map(entity) })),
    appraisals: view.appraisals.map((item) => ({ ...item, id: ref(item.id), ...(item.targetId ? { targetId: entity(item.targetId) } : {}) })),
    relationships: view.relationships.map((item) => ({ ...item, id: ref(item.id), counterpartyId: entity(item.counterpartyId) })),
    obligations: view.obligations.map((item) => ({ ...item, id: ref(item.id), ...(item.counterpartyId ? { counterpartyId: entity(item.counterpartyId) } : {}) })),
    norms: view.norms.map((item) => ({ ...item, id: ref(item.id), templateId: ref(item.templateId) })),
    processes: view.processes.map((item) => ({ ...item, id: ref(item.id), templateId: ref(item.templateId) })),
  };
}

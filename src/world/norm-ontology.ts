import { z } from "zod";
import { contentHash } from "./canonical.js";
import { actionPatternMatches, actionPatternSchema, type ActionPattern } from "./action-constraint.js";
import {
  actionInvocationSchema,
  evidenceRefSchema,
  idSchema,
  normDeltaSchema,
  normProposalDeltaSchema,
  predicateSchema,
  type ActionInvocation,
  type CommitId,
  type Entity,
  type NormDelta,
  type NormProposalDelta,
  type ObjectHash,
  type Predicate,
  type ValidationIssue,
  type WorldState,
} from "./model.js";
import { evaluatePredicate } from "./state.js";
import type { NormInstance, NormState } from "./norm-effects.js";
import type { EffectiveWorldRule } from "./world-rule-ontology.js";

export const NORM_ONTOLOGY_VERSION = "norm-template-v1" as const;

export const normReparationSchema = z.object({
  id: idSchema,
  description: z.string().trim().min(1).max(1_000),
  actionPattern: actionPatternSchema.optional(),
  requiresAfter: z.array(predicateSchema).max(32).default([]),
}).strict();
export type NormReparation = z.infer<typeof normReparationSchema>;

export const normTemplateExceptionSchema = z.object({
  id: idSchema,
  appliesWhen: z.array(predicateSchema).min(1).max(32),
}).strict();
export type NormTemplateException = z.infer<typeof normTemplateExceptionSchema>;

export const normTemplateSchema = z.object({
  ontologyVersion: z.literal(NORM_ONTOLOGY_VERSION),
  id: idSchema,
  name: z.string().trim().min(1).max(400),
  modality: z.enum(["obligation", "prohibition", "permission"]),
  actionPattern: actionPatternSchema,
  authorityEntityId: idSchema.optional(),
  appliesWhen: z.array(predicateSchema).max(32).default([]),
  exceptions: z.array(normTemplateExceptionSchema).max(32).default([]),
  defaultDeadlineDays: z.number().finite().positive().optional(),
  reparations: z.array(normReparationSchema).max(32).default([]),
  priority: z.number().int().min(0).max(10_000),
  defeasible: z.boolean(),
  overridesTemplateIds: z.array(idSchema).max(64).default([]),
  status: z.enum(["supported", "contested"]),
  visibility: z.enum(["public", "observable", "knowledge", "engine"]),
  knownByClaimIds: z.array(idSchema).max(64).default([]),
  induction: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("source-pattern"), supportingEventIds: z.array(idSchema).min(1).max(64) }).strict(),
    z.object({ kind: z.literal("domain-module"), moduleId: idSchema, moduleVersion: z.string().trim().min(1).max(120) }).strict(),
  ]),
  evidence: z.array(evidenceRefSchema),
}).strict().superRefine((value, ctx) => {
  for (const [path, ids] of [
    ["exceptions", value.exceptions.map((item) => item.id)],
    ["reparations", value.reparations.map((item) => item.id)],
    ["overridesTemplateIds", value.overridesTemplateIds],
    ["knownByClaimIds", value.knownByClaimIds],
  ] as const) {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: [path], message: `${path} identifiers must be unique` });
  }
  if (value.overridesTemplateIds.includes(value.id)) ctx.addIssue({ code: "custom", path: ["overridesTemplateIds"], message: "A norm template cannot override itself" });
  if (value.defaultDeadlineDays !== undefined && value.modality !== "obligation") {
    ctx.addIssue({ code: "custom", path: ["defaultDeadlineDays"], message: "Only obligations can expire at a performance deadline" });
  }
  if (value.visibility === "knowledge" && !value.knownByClaimIds.length) {
    ctx.addIssue({ code: "custom", path: ["knownByClaimIds"], message: "A knowledge-visible norm requires a grounding claim" });
  }
  if (value.visibility !== "knowledge" && value.knownByClaimIds.length) {
    ctx.addIssue({ code: "custom", path: ["knownByClaimIds"], message: "knownByClaimIds is reserved for knowledge-visible norms" });
  }
  if (value.induction.kind === "source-pattern" && !value.evidence.length) ctx.addIssue({ code: "custom", path: ["evidence"], message: "A source norm template requires evidence" });
  if (value.induction.kind === "domain-module" && value.evidence.length) ctx.addIssue({ code: "custom", path: ["evidence"], message: "Domain norms use module provenance, not novel EvidenceRefs" });
});
export type NormTemplate = z.infer<typeof normTemplateSchema>;

export type MaterializedNormProposal = {
  delta: NormDelta;
  proposalHash: ObjectHash;
  localBindings: ReadonlyMap<string, string>;
};

export function materializeNormProposal(
  input: NormProposalDelta,
  options: {
    branchId: string;
    parentCommitId: CommitId;
    elapsedDays: number;
    templates: ReadonlyMap<string, NormTemplate>;
    proposalHash?: ObjectHash;
  },
): MaterializedNormProposal {
  const proposal = normProposalDeltaSchema.parse(input);
  const proposalHash = options.proposalHash ?? contentHash(proposal);
  const localBindings = new Map<string, string>();
  const resolve = (ref: string): string => {
    if (!ref.startsWith("local-")) return ref;
    const id = localBindings.get(ref);
    if (!id) throw new Error(`Turn-local norm ref ${ref} must be introduced by an earlier operation`);
    return id;
  };
  const operations: NormDelta["operations"] = [];
  proposal.operations.forEach((operation, operationIndex) => {
    if (operation.op === "instantiate-norm") {
      if (localBindings.has(operation.localRef)) throw new Error(`Turn-local norm ref ${operation.localRef} is introduced more than once`);
      const template = options.templates.get(operation.norm.templateId);
      if (!template) throw new Error(`Unknown norm template ${operation.norm.templateId}`);
      const id = `branch-norm-${contentHash({
        version: 1,
        branchId: options.branchId,
        parentCommitId: options.parentCommitId,
        proposalHash,
        operationIndex,
        localRef: operation.localRef,
        payload: operation.norm,
      }).slice(0, 32)}`;
      localBindings.set(operation.localRef, id);
      operations.push({
        op: operation.op,
        norm: {
          id,
          ...structuredClone(operation.norm),
          ...(operation.norm.dueAtElapsedDays !== undefined
            ? { dueAtElapsedDays: operation.norm.dueAtElapsedDays }
            : template.defaultDeadlineDays !== undefined
              ? { dueAtElapsedDays: options.elapsedDays + template.defaultDeadlineDays }
              : {}),
        },
      });
      return;
    }
    const normId = resolve(operation.normRef);
    if (operation.op === "satisfy-norm") operations.push({ op: operation.op, normId, ...(operation.byActorId ? { byActorId: operation.byActorId } : {}) });
    if (operation.op === "violate-norm") operations.push({ op: operation.op, normId, ...(operation.byActorId ? { byActorId: operation.byActorId } : {}), ...(operation.reasonId ? { reasonId: operation.reasonId } : {}) });
    if (operation.op === "repair-norm") operations.push({ op: operation.op, normId, ...(operation.byActorId ? { byActorId: operation.byActorId } : {}), reparationId: operation.reparationId });
  });
  return { delta: normDeltaSchema.parse({ version: 1, operations }), proposalHash, localBindings };
}

export function validateNormTemplateCatalog(
  templatesInput: Iterable<NormTemplate>,
  input: {
    entities: ReadonlyMap<string, Entity>;
    claimIds?: ReadonlySet<string>;
    canonicalEventIds?: ReadonlySet<string>;
  },
): ValidationIssue[] {
  const templates = [...templatesInput].map((item) => normTemplateSchema.parse(item));
  const byId = new Map(templates.map((item) => [item.id, item]));
  const issues: ValidationIssue[] = [];
  if (byId.size !== templates.length) issues.push(issue("DUPLICATE_NORM_TEMPLATE", "Norm template IDs must be unique", "normTemplates"));
  templates.forEach((template, index) => {
    if (template.authorityEntityId && !input.entities.has(template.authorityEntityId)) {
      issues.push(issue("UNKNOWN_NORM_AUTHORITY", `Norm template ${template.id} references unknown authority ${template.authorityEntityId}`, `normTemplates.${index}.authorityEntityId`));
    }
    template.knownByClaimIds.forEach((claimId, claimIndex) => {
      if (!input.claimIds?.has(claimId)) issues.push(issue("UNKNOWN_NORM_KNOWLEDGE", `Norm template ${template.id} references unknown claim ${claimId}`, `normTemplates.${index}.knownByClaimIds.${claimIndex}`));
    });
    if (template.induction.kind === "source-pattern") template.induction.supportingEventIds.forEach((eventId, eventIndex) => {
      if (!input.canonicalEventIds?.has(eventId)) issues.push(issue("UNKNOWN_NORM_SUPPORT_EVENT", `Norm template ${template.id} cites unknown event ${eventId}`, `normTemplates.${index}.induction.supportingEventIds.${eventIndex}`));
    });
    template.overridesTemplateIds.forEach((targetId, targetIndex) => {
      const target = byId.get(targetId);
      const path = `normTemplates.${index}.overridesTemplateIds.${targetIndex}`;
      if (!target) issues.push(issue("UNKNOWN_OVERRIDDEN_NORM", `Norm template ${template.id} overrides unknown template ${targetId}`, path));
      else if (!target.defeasible) issues.push(issue("INDEFEASIBLE_NORM_OVERRIDE", `Norm template ${targetId} is not defeasible`, path));
      else if (template.priority <= target.priority) issues.push(issue("INVALID_NORM_PRIORITY", `Overriding norm ${template.id} must have higher priority than ${targetId}`, path));
    });
  });
  for (const cycle of overrideCycles(new Map(templates.map((item) => [item.id, new Set(item.overridesTemplateIds)])))) {
    issues.push(issue("NORM_OVERRIDE_CYCLE", `Norm template override cycle: ${cycle.join(" -> ")}`, "normTemplates"));
  }
  return issues;
}

export type EffectiveNormTemplate = { template: NormTemplate; subjectActorId: string };

export function resolveEffectiveNormTemplates(
  templates: Iterable<NormTemplate>,
  state: WorldState,
  subjectActorId: string,
): EffectiveNormTemplate[] {
  const candidates = [...templates]
    .filter((template) => template.status === "supported")
    .filter((template) => template.appliesWhen.every((predicate) => evaluatePredicate(state, predicate)))
    .filter((template) => !template.exceptions.some((exception) => exception.appliesWhen.every((predicate) => evaluatePredicate(state, predicate))))
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  const effective: NormTemplate[] = [];
  for (const template of candidates) {
    if (!effective.some((higher) => higher.overridesTemplateIds.includes(template.id))) effective.push(template);
  }
  return effective.map((template) => ({ template, subjectActorId }));
}

export function deriveAutomaticNormDelta(input: {
  branchId: string;
  parentCommitId: CommitId;
  actorId?: string;
  action?: ActionInvocation;
  before: WorldState;
  after: WorldState;
  state: NormState;
  templates: ReadonlyMap<string, NormTemplate>;
  normativeRules: readonly EffectiveWorldRule[];
}): NormDelta | undefined {
  const action = input.action ? actionInvocationSchema.parse(input.action) : undefined;
  const operations: NormDelta["operations"] = [];
  const elapsedDays = input.after.logicalTime.elapsedDays ?? 0;

  for (const instance of Object.values(input.state.instances).sort((left, right) => left.id.localeCompare(right.id))) {
    if (instance.status !== "active") continue;
    const template = new Map(resolveEffectiveNormTemplates(input.templates.values(), input.before, instance.subjectActorId)
      .map((item) => [item.template.id, item.template])).get(instance.templateId);
    if (!template) continue;
    if (template.modality === "obligation"
      && instance.dueAtElapsedDays !== undefined
      && elapsedDays >= instance.dueAtElapsedDays) {
      operations.push({ op: "violate-norm", normId: instance.id, byActorId: instance.subjectActorId, reasonId: "deadline-expired" });
      continue;
    }
    if (instance.subjectActorId !== input.actorId) continue;
    if (!action || !actionPatternMatches(template.actionPattern, action)) continue;
    if (template.modality === "obligation") {
      operations.push({ op: "satisfy-norm", normId: instance.id, byActorId: instance.subjectActorId });
    } else if (template.modality === "prohibition") {
      operations.push({ op: "violate-norm", normId: instance.id, byActorId: instance.subjectActorId, reasonId: "prohibited-action" });
    }
  }

  if (input.actorId) {
    for (const effective of [...input.normativeRules].sort((left, right) => left.id.localeCompare(right.id))) {
      const violatedRequires = effective.requires.some((predicate) => !evaluatePredicate(input.after, predicate));
      const violatedForbids = effective.forbids.some((predicate) => evaluatePredicate(input.after, predicate));
      if (!violatedRequires && !violatedForbids) continue;
      const normId = `branch-norm-${contentHash({
        version: 1,
        kind: "world-rule-violation",
        branchId: input.branchId,
        parentCommitId: input.parentCommitId,
        ruleId: effective.id,
        actorId: input.actorId,
        postState: input.after,
      }).slice(0, 32)}`;
      operations.push({
        op: "instantiate-norm",
        norm: {
          id: normId,
          templateId: effective.id,
          subjectActorId: input.actorId,
          description: `Compliance with ${effective.name}`,
        },
      });
      operations.push({
        op: "violate-norm",
        normId,
        byActorId: input.actorId,
        reasonId: violatedForbids ? "forbidden-state" : "required-state-missing",
      });
    }
  }
  return operations.length ? normDeltaSchema.parse({ version: 1, operations }) : undefined;
}

export function validateNormReparation(
  instance: NormInstance,
  template: NormTemplate,
  reparationId: string,
  action: ActionInvocation | undefined,
  postState: WorldState,
): void {
  const reparation = template.reparations.find((item) => item.id === reparationId);
  if (!reparation) throw new Error(`Norm ${instance.id} has no reparation ${reparationId}`);
  if (reparation.actionPattern && (!action || !actionPatternMatches(reparation.actionPattern, action))) {
    throw new Error(`Norm reparation ${reparationId} requires a matching action`);
  }
  if (!reparation.requiresAfter.every((predicate) => evaluatePredicate(postState, predicate))) {
    throw new Error(`Norm reparation ${reparationId} postconditions are not satisfied`);
  }
}

export function dueNormInstances(state: NormState, elapsedDays: number): NormInstance[] {
  return Object.values(state.instances)
    .filter((instance) => instance.status === "active"
      && instance.dueAtElapsedDays !== undefined
      && instance.dueAtElapsedDays <= elapsedDays)
    .sort((left, right) => (left.dueAtElapsedDays! - right.dueAtElapsedDays!) || left.id.localeCompare(right.id));
}

export function nextNormDueAt(state: NormState): number | undefined {
  return Object.values(state.instances)
    .filter((instance) => instance.status === "active" && instance.dueAtElapsedDays !== undefined)
    .reduce<number | undefined>((minimum, instance) => minimum === undefined
      ? instance.dueAtElapsedDays
      : Math.min(minimum, instance.dueAtElapsedDays!), undefined);
}

export function normTemplateForInstance(
  instance: NormInstance,
  templates: ReadonlyMap<string, NormTemplate>,
): NormTemplate | undefined {
  return templates.get(instance.templateId);
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, ...(path ? { path } : {}) };
}

function overrideCycles(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      const key = [...new Set(cycle.slice(0, -1))].sort().join("\u0000");
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(cycle);
      }
      return;
    }
    visiting.add(id);
    stack.push(id);
    for (const target of [...(graph.get(id) ?? [])].sort()) visit(target);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...graph.keys()].sort()) visit(id);
  return cycles;
}

export type { ActionPattern, Predicate };

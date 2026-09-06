import { z } from "zod";
import { contentHash } from "./canonical.js";
import {
  evidenceRefSchema,
  idSchema,
  processDeltaSchema,
  processProposalDeltaSchema,
  type CommitId,
  type Entity,
  type ObjectHash,
  type ProcessDelta,
  type ProcessProposalDelta,
  type ValidationIssue,
} from "./model.js";
import { actionRoleSpecSchema } from "./action-ontology.js";
import type { ProcessInstance, ProcessState } from "./process-effects.js";
import { actionPatternSchema, constraintPredicateSchema } from "./action-constraint.js";

export const PROCESS_ONTOLOGY_VERSION = "process-template-v1" as const;

export const processPhaseSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(240),
  terminal: z.boolean(),
}).strict();
export type ProcessPhase = z.infer<typeof processPhaseSchema>;

export const processTransitionSchema = z.object({
  fromPhaseId: idSchema,
  toPhaseId: idSchema,
  minimumProgress: z.number().finite().min(0).max(1).default(0),
  onDue: z.object({
    advanceBy: z.number().finite().positive().max(1),
    outcomeId: idSchema.optional(),
  }).strict().optional(),
}).strict();
export type ProcessTransition = z.infer<typeof processTransitionSchema>;

/** Actor changes need a declared mechanism, independent of process ownership. */
export const processActorControlSchema = z.object({
  op: z.enum(["start-process", "advance-process", "pause-process", "resume-process", "finish-process"]),
  actionPattern: actionPatternSchema,
  fromPhaseId: idSchema.optional(),
  toPhaseId: idSchema.optional(),
  outcomeId: idSchema.optional(),
  maximumAdvance: z.number().finite().positive().max(1).optional(),
  minimumElapsedDays: z.number().finite().nonnegative().default(0),
  requiresBefore: z.array(constraintPredicateSchema).max(32).default([]),
  requiresAfter: z.array(constraintPredicateSchema).max(32).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.op === "advance-process" && value.maximumAdvance === undefined) ctx.addIssue({ code: "custom", path: ["maximumAdvance"], message: "Actor progress requires a per-turn maximum" });
  if ((value.op === "advance-process" || value.op === "finish-process") && value.actionPattern.kind === "any"
    && value.minimumElapsedDays === 0 && !value.requiresBefore.length && !value.requiresAfter.length) {
    ctx.addIssue({ code: "custom", message: "Progress and completion require a named action, elapsed time or state conditions" });
  }
});

export const processTemplateSchema = z.object({
  ontologyVersion: z.literal(PROCESS_ONTOLOGY_VERSION),
  id: idSchema,
  name: z.string().trim().min(1).max(400),
  ownerRoles: z.array(actionRoleSpecSchema).min(1).max(32),
  phases: z.array(processPhaseSchema).min(2).max(64),
  initialPhaseId: idSchema,
  transitions: z.array(processTransitionSchema).min(1).max(128),
  actorControls: z.array(processActorControlSchema).max(128).optional(),
  cadence: z.object({ kind: z.literal("elapsed-days"), intervalDays: z.number().finite().positive() }).strict().optional(),
  outcomeIds: z.array(idSchema).min(1).max(64),
  visibility: z.enum(["public", "observable", "knowledge", "engine"]),
  induction: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("source-pattern"), supportingEventIds: z.array(idSchema).min(1).max(64) }).strict(),
    z.object({ kind: z.literal("domain-module"), moduleId: idSchema, moduleVersion: z.string().trim().min(1).max(120) }).strict(),
  ]),
  evidence: z.array(evidenceRefSchema),
}).strict().superRefine((value, ctx) => {
  for (const [path, ids] of [
    ["ownerRoles", value.ownerRoles.map((item) => item.id)],
    ["phases", value.phases.map((item) => item.id)],
    ["outcomeIds", value.outcomeIds],
  ] as const) {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: [path], message: `${path} identifiers must be unique` });
  }
  const phases = new Map(value.phases.map((phase) => [phase.id, phase]));
  if (!phases.has(value.initialPhaseId)) ctx.addIssue({ code: "custom", path: ["initialPhaseId"], message: "initialPhaseId must reference a declared phase" });
  if (phases.get(value.initialPhaseId)?.terminal) ctx.addIssue({ code: "custom", path: ["initialPhaseId"], message: "A process cannot start in a terminal phase" });
  const transitions = new Set<string>();
  value.transitions.forEach((transition, index) => {
    if (!phases.has(transition.fromPhaseId)) ctx.addIssue({ code: "custom", path: ["transitions", index, "fromPhaseId"], message: "Unknown source phase" });
    if (!phases.has(transition.toPhaseId)) ctx.addIssue({ code: "custom", path: ["transitions", index, "toPhaseId"], message: "Unknown target phase" });
    if (transition.fromPhaseId === transition.toPhaseId) ctx.addIssue({ code: "custom", path: ["transitions", index], message: "A phase transition must change phase" });
    if (transition.onDue && transition.onDue.advanceBy < transition.minimumProgress) {
      ctx.addIssue({ code: "custom", path: ["transitions", index, "onDue", "advanceBy"], message: "A due transition must advance far enough to satisfy its minimum progress" });
    }
    if (transition.onDue?.outcomeId && !value.outcomeIds.includes(transition.onDue.outcomeId)) {
      ctx.addIssue({ code: "custom", path: ["transitions", index, "onDue", "outcomeId"], message: "A due transition outcome must be declared by the process template" });
    }
    if (transition.onDue?.outcomeId && !phases.get(transition.toPhaseId)?.terminal) {
      ctx.addIssue({ code: "custom", path: ["transitions", index, "onDue", "outcomeId"], message: "Only a transition into a terminal phase may commit an outcome" });
    }
    const key = `${transition.fromPhaseId}\u0000${transition.toPhaseId}`;
    if (transitions.has(key)) ctx.addIssue({ code: "custom", path: ["transitions", index], message: "Process phase transitions must be unique" });
    transitions.add(key);
  });
  if (!value.phases.some((phase) => phase.terminal)) ctx.addIssue({ code: "custom", path: ["phases"], message: "A process template requires a terminal phase" });
  value.actorControls?.forEach((control, index) => {
    for (const key of ["fromPhaseId", "toPhaseId"] as const) if (control[key] && !phases.has(control[key]!)) ctx.addIssue({ code: "custom", path: ["actorControls", index, key], message: "Unknown process control phase" });
    if (control.outcomeId && !value.outcomeIds.includes(control.outcomeId)) ctx.addIssue({ code: "custom", path: ["actorControls", index, "outcomeId"], message: "Unknown process control outcome" });
  });
  if (value.induction.kind === "source-pattern" && !value.evidence.length) ctx.addIssue({ code: "custom", path: ["evidence"], message: "A source process template requires evidence" });
  if (value.induction.kind === "domain-module" && value.evidence.length) ctx.addIssue({ code: "custom", path: ["evidence"], message: "Domain processes use module provenance, not novel EvidenceRefs" });
});
export type ProcessTemplate = z.infer<typeof processTemplateSchema>;

export type MaterializedProcessProposal = {
  delta: ProcessDelta;
  proposalHash: ObjectHash;
  localBindings: ReadonlyMap<string, string>;
};

export function materializeProcessProposal(
  input: ProcessProposalDelta,
  options: {
    branchId: string;
    parentCommitId: CommitId;
    elapsedDays: number;
    templates: ReadonlyMap<string, ProcessTemplate>;
    proposalHash?: ObjectHash;
  },
): MaterializedProcessProposal {
  const proposal = processProposalDeltaSchema.parse(input);
  const proposalHash = options.proposalHash ?? contentHash(proposal);
  const localBindings = new Map<string, string>();
  const resolve = (ref: string): string => {
    if (!ref.startsWith("local-")) return ref;
    const id = localBindings.get(ref);
    if (!id) throw new Error(`Turn-local process ref ${ref} must be introduced by an earlier operation`);
    return id;
  };
  const operations: ProcessDelta["operations"] = [];
  proposal.operations.forEach((operation, operationIndex) => {
    if (operation.op === "start-process") {
      if (localBindings.has(operation.localRef)) throw new Error(`Turn-local process ref ${operation.localRef} is introduced more than once`);
      const template = options.templates.get(operation.process.templateId);
      if (!template) throw new Error(`Unknown process template ${operation.process.templateId}`);
      const id = `branch-process-${contentHash({
        version: 1,
        branchId: options.branchId,
        parentCommitId: options.parentCommitId,
        proposalHash,
        operationIndex,
        localRef: operation.localRef,
        payload: operation.process,
      }).slice(0, 32)}`;
      localBindings.set(operation.localRef, id);
      operations.push({
        op: "start-process",
        process: {
          id,
          ...structuredClone(operation.process),
          phaseId: operation.process.phaseId ?? template.initialPhaseId,
          ...(operation.process.dueAtElapsedDays !== undefined
            ? { dueAtElapsedDays: operation.process.dueAtElapsedDays }
            : template.cadence
              ? { dueAtElapsedDays: options.elapsedDays + template.cadence.intervalDays }
              : {}),
        },
      });
      return;
    }
    const processId = resolve(operation.processRef);
    if (operation.op === "advance-process") operations.push({
      op: operation.op,
      processId,
      amount: operation.amount,
      ...(operation.phaseId ? { phaseId: operation.phaseId } : {}),
      ...(operation.dueAtElapsedDays !== undefined ? { dueAtElapsedDays: operation.dueAtElapsedDays } : {}),
    });
    if (operation.op === "pause-process") operations.push({ op: operation.op, processId, reasonId: operation.reasonId });
    if (operation.op === "resume-process") operations.push({ op: operation.op, processId, ...(operation.dueAtElapsedDays !== undefined ? { dueAtElapsedDays: operation.dueAtElapsedDays } : {}) });
    if (operation.op === "finish-process") operations.push({ op: operation.op, processId, outcomeId: operation.outcomeId });
  });
  return { delta: processDeltaSchema.parse({ version: 1, operations }), proposalHash, localBindings };
}

export function validateProcessTemplateCatalog(
  templatesInput: Iterable<ProcessTemplate>,
  canonicalEventIds: ReadonlySet<string> = new Set(),
  catalog?: { entities: ReadonlyMap<string, Entity>; actionSchemas: ReadonlyMap<string, import("./action-ontology.js").ActionSchema> },
): ValidationIssue[] {
  const templates = [...templatesInput].map((item) => processTemplateSchema.parse(item));
  const issues: ValidationIssue[] = [];
  if (new Set(templates.map((item) => item.id)).size !== templates.length) {
    issues.push(issue("DUPLICATE_PROCESS_TEMPLATE", "Process template IDs must be unique", "processTemplates"));
  }
  templates.forEach((template, templateIndex) => {
    template.actorControls?.forEach((control, controlIndex) => {
      const path = `processTemplates.${templateIndex}.actorControls.${controlIndex}`;
      if (catalog && control.actionPattern.kind === "schema" && !catalog.actionSchemas.has(control.actionPattern.schemaId)) issues.push(issue("UNKNOWN_PROCESS_CONTROL_ACTION", `Unknown process action ${control.actionPattern.schemaId}`, path));
      const inspect = (predicate: import("./action-constraint.js").ConstraintPredicate): void => {
        if (predicate.op === "all" || predicate.op === "any") return predicate.items.forEach(inspect);
        if (predicate.op === "not") return inspect(predicate.item);
        const reference = predicate.entity;
        if (reference.kind === "role" && !template.ownerRoles.some((role) => role.id === reference.roleId && role.maxCardinality === 1)) issues.push(issue("UNKNOWN_PROCESS_CONTROL_ROLE", "Process control predicates require a single declared owner role", path));
        if (catalog && predicate.entity.kind === "entity" && !catalog.entities.has(predicate.entity.entityId)) issues.push(issue("UNKNOWN_PROCESS_CONTROL_ENTITY", `Unknown process control entity ${predicate.entity.entityId}`, path));
      };
      [...control.requiresBefore, ...control.requiresAfter].forEach(inspect);
    });
    if (template.induction.kind === "source-pattern") template.induction.supportingEventIds.forEach((eventId, eventIndex) => {
      if (!canonicalEventIds.has(eventId)) issues.push(issue("UNKNOWN_PROCESS_SUPPORT_EVENT", `Process template ${template.id} cites unknown event ${eventId}`, `processTemplates.${templateIndex}.induction.supportingEventIds.${eventIndex}`));
    });
  });
  return issues;
}

export function dueProcessInstances(state: ProcessState, elapsedDays: number): ProcessInstance[] {
  return Object.values(state.instances)
    .filter((instance) => instance.status === "running"
      && instance.dueAtElapsedDays !== undefined
      && instance.dueAtElapsedDays <= elapsedDays)
    .sort((left, right) => (left.dueAtElapsedDays! - right.dueAtElapsedDays!) || left.id.localeCompare(right.id));
}

export function nextProcessDueAt(state: ProcessState): number | undefined {
  return Object.values(state.instances)
    .filter((instance) => instance.status === "running" && instance.dueAtElapsedDays !== undefined)
    .reduce<number | undefined>((minimum, instance) => minimum === undefined
      ? instance.dueAtElapsedDays
      : Math.min(minimum, instance.dueAtElapsedDays!), undefined);
}

export function processOwnerEntityIds(instance: Pick<ProcessInstance, "ownerBindings">): string[] {
  return [...new Set(instance.ownerBindings.flatMap((binding) => binding.entityIds))].sort();
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, ...(path ? { path } : {}) };
}

export function requireProcessOwnerEntities(
  bindings: readonly { roleId: string; entityIds: readonly string[] }[],
  roles: ProcessTemplate["ownerRoles"],
  entities: ReadonlyMap<string, Entity>,
): void {
  const declared = new Map(roles.map((role) => [role.id, role]));
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (seen.has(binding.roleId)) throw new Error(`Duplicate process owner role ${binding.roleId}`);
    seen.add(binding.roleId);
    const role = declared.get(binding.roleId);
    if (!role) throw new Error(`Unknown process owner role ${binding.roleId}`);
    if (binding.entityIds.length < role.minCardinality || binding.entityIds.length > role.maxCardinality) {
      throw new Error(`Process owner role ${role.id} requires ${role.minCardinality}..${role.maxCardinality} entities`);
    }
    for (const entityId of binding.entityIds) {
      const entity = entities.get(entityId);
      if (!entity) throw new Error(`Process owner role ${role.id} references unknown entity ${entityId}`);
      if (!role.allowedEntityKinds.includes(entity.kind)) throw new Error(`Process owner role ${role.id} does not allow ${entity.kind} ${entityId}`);
    }
  }
  for (const role of roles) {
    if (!seen.has(role.id) && role.minCardinality > 0) throw new Error(`Missing process owner role ${role.id}`);
  }
}

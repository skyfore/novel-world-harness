import type { CommitId, Entity, EntityId, ProcessDelta, ProcessOperation } from "./model.js";
import type { EffectProvenance } from "./semantic-effects.js";
import { requireProcessOwnerEntities, type ProcessTemplate } from "./process-ontology.js";

type StartedProcess = Extract<ProcessOperation, { op: "start-process" }>["process"];

export type ProcessInstance = StartedProcess & {
  status: "running" | "paused" | "finished";
  startedBy: EffectProvenance;
  updatedBy: EffectProvenance;
  pauseReasonId?: string;
  outcomeId?: string;
};

export type ProcessState = {
  version: 1;
  atCommit: CommitId;
  instances: Record<string, ProcessInstance>;
};

export type ProcessReducerContext = {
  entities: ReadonlyMap<EntityId, Entity>;
  templates: ReadonlyMap<string, ProcessTemplate>;
};

export function emptyProcessState(atCommit: CommitId): ProcessState {
  return { version: 1, atCommit, instances: {} };
}

export function applyProcessDelta(
  input: ProcessState,
  delta: ProcessDelta,
  context: ProcessReducerContext,
  provenance: EffectProvenance,
  elapsedDays: number,
): ProcessState {
  const output = structuredClone(input);
  output.atCommit = provenance.commitId;

  for (const operation of delta.operations) {
    switch (operation.op) {
      case "start-process": {
        const process = operation.process;
        if (output.instances[process.id]) throw new Error(`Duplicate process ID: ${process.id}`);
        const template = requireTemplate(context.templates, process.templateId);
        requireProcessOwnerEntities(process.ownerBindings, template.ownerRoles, context.entities);
        if (process.phaseId !== template.initialPhaseId) {
          throw new Error(`Process ${process.id} must start in template phase ${template.initialPhaseId}`);
        }
        assertFutureDueDate(process.id, process.dueAtElapsedDays, elapsedDays);
        output.instances[process.id] = {
          ...structuredClone(process),
          status: "running",
          startedBy: provenance,
          updatedBy: provenance,
        };
        break;
      }
      case "advance-process": {
        const process = requireProcess(output, operation.processId);
        const template = requireTemplate(context.templates, process.templateId);
        if (process.status !== "running") throw new Error(`Process ${process.id} cannot advance while ${process.status}`);
        const next = process.progress + operation.amount;
        if (next > 1) throw new Error(`Process ${process.id} progress cannot exceed 1`);
        if (operation.phaseId && operation.phaseId !== process.phaseId) {
          const transition = template.transitions.find((candidate) =>
            candidate.fromPhaseId === process.phaseId && candidate.toPhaseId === operation.phaseId);
          if (!transition) throw new Error(`Process ${process.id} cannot transition ${process.phaseId} -> ${operation.phaseId}`);
          if (next < transition.minimumProgress) {
            throw new Error(`Process ${process.id} transition ${process.phaseId} -> ${operation.phaseId} requires progress ${transition.minimumProgress}`);
          }
        }
        process.progress = next;
        if (operation.phaseId) process.phaseId = operation.phaseId;
        if (operation.dueAtElapsedDays !== undefined) {
          assertFutureDueDate(process.id, operation.dueAtElapsedDays, elapsedDays);
          process.dueAtElapsedDays = operation.dueAtElapsedDays;
        } else if (template.cadence) {
          process.dueAtElapsedDays = elapsedDays + template.cadence.intervalDays;
        }
        process.updatedBy = provenance;
        break;
      }
      case "pause-process": {
        const process = requireProcess(output, operation.processId);
        if (process.status !== "running") throw new Error(`Process ${process.id} cannot pause while ${process.status}`);
        process.status = "paused";
        process.pauseReasonId = operation.reasonId;
        process.updatedBy = provenance;
        break;
      }
      case "resume-process": {
        const process = requireProcess(output, operation.processId);
        const template = requireTemplate(context.templates, process.templateId);
        if (process.status !== "paused") throw new Error(`Process ${process.id} cannot resume while ${process.status}`);
        process.status = "running";
        delete process.pauseReasonId;
        if (operation.dueAtElapsedDays !== undefined) {
          assertFutureDueDate(process.id, operation.dueAtElapsedDays, elapsedDays);
          process.dueAtElapsedDays = operation.dueAtElapsedDays;
        } else if (template.cadence) {
          process.dueAtElapsedDays = elapsedDays + template.cadence.intervalDays;
        }
        process.updatedBy = provenance;
        break;
      }
      case "finish-process": {
        const process = requireProcess(output, operation.processId);
        const template = requireTemplate(context.templates, process.templateId);
        if (process.status === "finished") throw new Error(`Process ${process.id} is already finished`);
        const phase = template.phases.find((candidate) => candidate.id === process.phaseId);
        if (!phase?.terminal) throw new Error(`Process ${process.id} cannot finish outside a terminal phase`);
        if (!template.outcomeIds.includes(operation.outcomeId)) throw new Error(`Process ${process.id} has unknown outcome ${operation.outcomeId}`);
        process.status = "finished";
        process.progress = 1;
        process.outcomeId = operation.outcomeId;
        delete process.pauseReasonId;
        process.updatedBy = provenance;
        break;
      }
    }
  }
  return output;
}

function requireTemplate(templates: ReadonlyMap<string, ProcessTemplate>, templateId: string): ProcessTemplate {
  const template = templates.get(templateId);
  if (!template) throw new Error(`Unknown process template ${templateId}`);
  return template;
}

function requireProcess(state: ProcessState, processId: string): ProcessInstance {
  const process = state.instances[processId];
  if (!process) throw new Error(`Unknown process ${processId}`);
  return process;
}

function assertFutureDueDate(processId: string, dueAtElapsedDays: number | undefined, elapsedDays: number): void {
  if (dueAtElapsedDays !== undefined && dueAtElapsedDays < elapsedDays) {
    throw new Error(`Process ${processId} due time ${dueAtElapsedDays} precedes current elapsed time ${elapsedDays}`);
  }
}

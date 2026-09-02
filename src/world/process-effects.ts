import type { CommitId, Entity, EntityId, ProcessDelta, ProcessOperation } from "./model.js";
import type { EffectProvenance } from "./semantic-effects.js";

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

export function emptyProcessState(atCommit: CommitId): ProcessState {
  return { version: 1, atCommit, instances: {} };
}

export function applyProcessDelta(
  input: ProcessState,
  delta: ProcessDelta,
  entities: ReadonlyMap<EntityId, Entity>,
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
        for (const ownerId of process.ownerEntityIds) {
          if (!entities.has(ownerId)) throw new Error(`Process ${process.id} references unknown owner ${ownerId}`);
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
        if (process.status !== "running") throw new Error(`Process ${process.id} cannot advance while ${process.status}`);
        const next = process.progress + operation.amount;
        if (next > 1) throw new Error(`Process ${process.id} progress cannot exceed 1`);
        process.progress = next;
        if (operation.phaseId) process.phaseId = operation.phaseId;
        if (operation.dueAtElapsedDays !== undefined) {
          assertFutureDueDate(process.id, operation.dueAtElapsedDays, elapsedDays);
          process.dueAtElapsedDays = operation.dueAtElapsedDays;
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
        if (process.status !== "paused") throw new Error(`Process ${process.id} cannot resume while ${process.status}`);
        process.status = "running";
        delete process.pauseReasonId;
        if (operation.dueAtElapsedDays !== undefined) {
          assertFutureDueDate(process.id, operation.dueAtElapsedDays, elapsedDays);
          process.dueAtElapsedDays = operation.dueAtElapsedDays;
        }
        process.updatedBy = provenance;
        break;
      }
      case "finish-process": {
        const process = requireProcess(output, operation.processId);
        if (process.status === "finished") throw new Error(`Process ${process.id} is already finished`);
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

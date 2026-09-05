import { contentHash } from "./canonical.js";
import {
  progressCertificateSchema,
  type BranchSemanticDelta,
  type CommittedEvent,
  type EventEffectsRef,
  type KnowledgeDelta,
  type NormDelta,
  type ProcessDelta,
  type ProgressCertificate,
  type ProgressChannel,
  type SceneTransition,
  type StateDelta,
} from "./model.js";

export type LoadedEventEffects = {
  stateDelta?: StateDelta;
  knowledgeDelta?: KnowledgeDelta;
  semanticDelta?: BranchSemanticDelta;
  processDelta?: ProcessDelta;
  normDelta?: NormDelta;
};

export type ProgressCertificateInput = {
  effects: EventEffectsRef;
  loaded: LoadedEventEffects;
  effectiveStateOperationIndexes?: readonly number[];
  effectiveKnowledgeOperationIndexes?: readonly number[];
  effectiveSemanticOperationIndexes?: readonly number[];
  effectiveProcessOperationIndexes?: readonly number[];
  effectiveNormOperationIndexes?: readonly number[];
  utteranceCount: number;
  timeAdvanced: boolean;
  sceneTransition?: SceneTransition;
};

/** Build the only material-progress claim that may cross the commit boundary. */
export function deriveProgressCertificate(input: ProgressCertificateInput): ProgressCertificate {
  const stateIndexes = input.effectiveStateOperationIndexes ?? allIndexes(input.loaded.stateDelta);
  const knowledgeIndexes = input.effectiveKnowledgeOperationIndexes ?? allIndexes(input.loaded.knowledgeDelta);
  const semanticIndexes = input.effectiveSemanticOperationIndexes ?? allIndexes(input.loaded.semanticDelta);
  const processIndexes = input.effectiveProcessOperationIndexes ?? allIndexes(input.loaded.processDelta);
  const normIndexes = input.effectiveNormOperationIndexes ?? allIndexes(input.loaded.normDelta);
  const stateOperations = pointers(input.effects.stateDeltaHash, stateIndexes);
  const knowledgeOperations = pointers(input.effects.knowledgeDeltaHash, knowledgeIndexes);
  const semanticOperations = pointers(input.effects.semanticDeltaHash, semanticIndexes);
  const processOperations = pointers(input.effects.processDeltaHash, processIndexes);
  const normOperations = pointers(input.effects.normDeltaHash, normIndexes);
  const channels = new Set<ProgressChannel>();
  if (stateOperations.length) channels.add("state");
  if (knowledgeOperations.length) channels.add("knowledge");
  if (semanticOperations.length) channels.add("semantic");
  if (processOperations.length) channels.add("process");
  if (normOperations.length) channels.add("norm");
  if (input.utteranceCount) channels.add("speech");
  if (input.timeAdvanced) channels.add("time");
  if (input.sceneTransition) channels.add("scene");

  const effectiveStateOperations = stateIndexes.map((index) => input.loaded.stateDelta?.operations[index]).filter(isDefined);
  const effectiveSemanticOperations = semanticIndexes.map((index) => input.loaded.semanticDelta?.operations[index]).filter(isDefined);
  if (effectiveStateOperations.some((operation) =>
    "field" in operation && (
      operation.field.startsWith("artifact.")
      || operation.field === "character.inventory"
      || operation.field.endsWith(".resources")
    ))) channels.add("resource");
  if (
    effectiveStateOperations.some((operation) =>
      "field" in operation && (operation.field.startsWith("relationship.") || operation.field === "character.relationships" || operation.field === "character.obligations"))
    || effectiveSemanticOperations.some((operation) =>
      operation.op === "adjust-relationship" || operation.op === "create-obligation" || operation.op === "resolve-obligation")
  ) channels.add("relationship");
  if (effectiveSemanticOperations.some((operation) => operation.op === "open-goal" || operation.op === "close-goal")) {
    channels.add("plan");
  }
  if (processOperations.length || normOperations.length || input.timeAdvanced) channels.add("time-pressure");
  if (
    stateOperations.length
    || semanticOperations.length
    || processOperations.length
    || normOperations.length
    || input.timeAdvanced
    || (input.sceneTransition && input.sceneTransition.kind !== "stay")
  ) channels.add("consequence");

  return progressCertificateSchema.parse({
    version: 1,
    stateOperations,
    knowledgeOperations,
    semanticOperations,
    processOperations,
    normOperations,
    utteranceCount: input.utteranceCount,
    timeAdvanced: input.timeAdvanced,
    ...(input.sceneTransition ? { sceneTransition: structuredClone(input.sceneTransition) } : {}),
    channels: [...channels],
  });
}

export function hasMaterialProgress(certificate: ProgressCertificate): boolean {
  return certificate.stateOperations.length > 0
    || certificate.knowledgeOperations.length > 0
    || certificate.semanticOperations.length > 0
    || certificate.processOperations.length > 0
    || certificate.normOperations.length > 0
    || certificate.utteranceCount > 0
    || certificate.timeAdvanced
    || Boolean(certificate.sceneTransition);
}

/** Validate certificate pointers and derived channels against immutable event effects. */
export function validateCommittedProgress(
  event: CommittedEvent,
  loaded: LoadedEventEffects,
  timeAdvanced: boolean,
): void {
  const certificate = progressCertificateSchema.parse(event.progressCertificate);
  const expected = deriveProgressCertificate({
    effects: event.effects,
    loaded,
    effectiveStateOperationIndexes: certificate.stateOperations.map((pointer) => pointer.operationIndex),
    effectiveKnowledgeOperationIndexes: certificate.knowledgeOperations.map((pointer) => pointer.operationIndex),
    effectiveSemanticOperationIndexes: certificate.semanticOperations.map((pointer) => pointer.operationIndex),
    effectiveProcessOperationIndexes: certificate.processOperations.map((pointer) => pointer.operationIndex),
    effectiveNormOperationIndexes: certificate.normOperations.map((pointer) => pointer.operationIndex),
    utteranceCount: event.spokenUtterances?.length ?? 0,
    timeAdvanced,
    ...(event.progress?.scene ? { sceneTransition: event.progress.scene } : {}),
  });
  assertPointerSet(certificate.stateOperations, event.effects.stateDeltaHash, loaded.stateDelta, "state");
  assertPointerSet(certificate.knowledgeOperations, event.effects.knowledgeDeltaHash, loaded.knowledgeDelta, "knowledge");
  assertPointerSet(certificate.semanticOperations, event.effects.semanticDeltaHash, loaded.semanticDelta, "semantic");
  assertPointerSet(certificate.processOperations, event.effects.processDeltaHash, loaded.processDelta, "process");
  assertPointerSet(certificate.normOperations, event.effects.normDeltaHash, loaded.normDelta, "norm");
  if (contentHash(certificate) !== contentHash(expected)) {
    throw new Error("Progress certificate does not match committed effects, utterances, time, scene, or derived channels");
  }
}

function assertPointerSet(
  pointersToCheck: ProgressCertificate["stateOperations"],
  effectHash: string | undefined,
  delta: { operations: readonly unknown[] } | undefined,
  channel: string,
): void {
  if (Boolean(effectHash) !== Boolean(delta)) throw new Error(`${channel} effect reference and loaded delta disagree`);
  for (const pointer of pointersToCheck) {
    if (!effectHash || pointer.effectHash !== effectHash) throw new Error(`${channel} progress pointer targets the wrong effect hash`);
    if (!delta || pointer.operationIndex >= delta.operations.length) {
      throw new Error(`${channel} progress pointer ${pointer.operationIndex} is outside the effect delta`);
    }
  }
}

function pointers(effectHash: string | undefined, indexes: readonly number[]): Array<{ effectHash: string; operationIndex: number }> {
  if (!indexes.length) return [];
  if (!effectHash) throw new Error("Effective progress operations require a persisted effect hash");
  return indexes.map((operationIndex) => ({ effectHash, operationIndex }));
}

function allIndexes(delta: { operations: readonly unknown[] } | undefined): number[] {
  return delta ? delta.operations.map((_, index) => index) : [];
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

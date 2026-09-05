import crypto from "node:crypto";
import path from "node:path";
import { stdout } from "node:process";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import {
  COMPILER_PIPELINE_VERSION,
  CompilerBatchStore,
  prepareCompilerBatches,
  selectOpeningCompilerBatch,
  type CompilerBatch,
} from "../compiler/batches.js";
import { convergeWorldProposals, quarantineUncommittableProposals } from "../compiler/converge.js";
import { rejectPendingCompilerBatchProposals, rejectPendingCompilerSourceProposals } from "../compiler/proposals.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { ActorModelStore } from "../world/actors.js";
import { CanonicalModelStore } from "../world/canonical-model.js";
import { characterOntologyEvidence } from "../world/character-ontology.js";
import { InitialWorldStore } from "../world/initial.js";
import { PossibilityTemplateStore } from "../world/possibility-model.js";
import { spatialRelationEvidence } from "../world/spatial-ontology.js";
import { worldRuleEvidence } from "../world/world-rule-ontology.js";
import { SourceAnnotationStore, annotationAnchors } from "../compiler/annotations.js";
import { EntityResolutionStore } from "../compiler/entity-resolution.js";
import { EventResolutionStore } from "../compiler/event-resolution.js";
import { SourceAccountingStore } from "../compiler/source-accounting.js";
import { ensureSourceStructure } from "../compiler/structure.js";
import { EvidenceAssertionStore } from "../compiler/evidence-assertions.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { promptJson } from "../util/prompt-data.js";
import { compileSourceCommand } from "./compile-source.js";
import { prepareAllCommand } from "./prepare-all.js";

export type ReparseCommandOptions = {
  root: string;
  configPath: string;
  sourceId?: string;
  all?: boolean;
  chapters?: string;
  model?: string;
  cacheRoot?: string;
  acquireLock?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onStatus?: (message: string) => void;
  onModelText?: (delta: string) => void;
  onModelThinking?: (delta: string) => void;
  onModelToolCall?: (name: string, input: unknown) => void;
  onModelToolResult?: (name: string, result: unknown, isError: boolean) => void;
  onModelEvent?: (event: AgentSessionEvent) => void;
};

type ReparseDependencies = {
  compileSource: typeof compileSourceCommand;
  finishPreparation: typeof prepareAllCommand;
};

const defaultDependencies: ReparseDependencies = {
  compileSource: compileSourceCommand,
  finishPreparation: prepareAllCommand,
};

export async function reparseCommand(
  options: ReparseCommandOptions,
  dependencyOverrides: Partial<ReparseDependencies> = {},
): Promise<{ sourceId: string; chapters: number[]; previousBundleHash: string; activeBundleHash: string }> {
  options.signal?.throwIfAborted();
  const root = path.resolve(options.root);
  if (options.acquireLock !== false) {
    return withWorkspaceOperationLock(root, "compiler", () => reparseCommand({ ...options, root, acquireLock: false }, dependencyOverrides));
  }
  if (Boolean(options.all) === Boolean(options.chapters)) {
    throw new Error("Choose exactly one reparse scope: --all or --chapters <selection>.");
  }
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const report = (message: string) => options.onProgress ? options.onProgress(message) : stdout.write(`${message}\n`);
  const source = await resolveSource(root, options.sourceId);
  let batches = await prepareCompilerBatches(root, source);
  options.signal?.throwIfAborted();
  let chapterBatches = batches.filter((batch) => batch.purpose !== "structure-discovery");
  if (!chapterBatches.length) throw new Error(`Source ${source.id} has no chapter compiler batches.`);
  let availableChapters = [...new Set(chapterBatches.map((batch) => batch.chapterOrdinal))].sort((left, right) => left - right);
  let selectedChapters = options.all
    ? availableChapters
    : parseOrdinalSelection(options.chapters!, availableChapters, "--chapters");
  let selected = chapterBatches.filter((batch) => selectedChapters.includes(batch.chapterOrdinal));
  if (!selected.length) throw new Error("The chapter selection did not match any compiler batch.");

  const cache = new PreparedNovelCache(root, options.cacheRoot);
  let selectedBatchIds = selected.map((batch) => batch.id);
  const runId = `reparse-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
  options.onStatus?.("Checking active revision and rollback baseline");
  report("Checking the active prepared revision and rollback baseline.");
  await recoverInterruptedReparse(root, source, batches, selectedBatchIds, cache, report);
  options.signal?.throwIfAborted();
  // Recovery may materialize a prepared revision. That operation deliberately
  // clears transient boundary-calibration requests, so never continue with
  // the pre-recovery batch objects or their now-stale IDs.
  batches = await prepareCompilerBatches(root, source);
  chapterBatches = batches.filter((batch) => batch.purpose !== "structure-discovery");
  if (!chapterBatches.length) throw new Error(`Source ${source.id} has no chapter compiler batches after rollback recovery.`);
  availableChapters = [...new Set(chapterBatches.map((batch) => batch.chapterOrdinal))]
    .sort((left, right) => left - right);
  selectedChapters = options.all
    ? availableChapters
    : parseOrdinalSelection(options.chapters!, availableChapters, "--chapters");
  selected = chapterBatches.filter((batch) => selectedChapters.includes(batch.chapterOrdinal));
  if (!selected.length) throw new Error("The chapter selection did not match any compiler batch after rollback recovery.");
  selectedBatchIds = selected.map((batch) => batch.id);
  if (options.all) {
    const rejected = await rejectPendingCompilerSourceProposals(root, source.id, {
      code: "SOURCE_REPARSE_BASELINE_CLEANUP",
      message: `Pending proposal was preserved in rejected history before the whole-source reparse baseline for ${source.id} was published.`,
    });
    if (rejected.length) {
      report(
        `Preserved ${rejected.length} pending source proposal(s) in rejected history before publishing the rollback baseline.`,
      );
    }
  }
  let activeBaseline = await cache.lookup(source);
  const initialWorld = await new InitialWorldStore(root).get();
  if (
    !activeBaseline.bundleHash
    && (!initialWorld || !initialWorld.evidence.some((reference) => reference.span.sourceId === source.id))
  ) {
    options.onStatus?.("Establishing an evidence-backed opening for the rollback baseline");
    report("No evidence-backed opening world exists; establishing one before publishing the rollback baseline.");
    await dependencies.finishPreparation({
      root,
      configPath: options.configPath,
      sourceId: source.id,
      ...(options.model ? { model: options.model } : {}),
      yes: true,
      createBranch: false,
      restoreCache: false,
      reparseRunId: runId,
      stopAfterInitialWorld: true,
      acquireLock: false,
      signal: options.signal,
      cacheRoot: options.cacheRoot,
      onProgress: report,
      onStatus: options.onStatus,
      onModelText: options.onModelText,
      onModelThinking: options.onModelThinking,
      onModelToolCall: options.onModelToolCall,
      onModelToolResult: options.onModelToolResult,
      onModelEvent: options.onModelEvent,
    });
    activeBaseline = await cache.lookup(source);
  }
  // During a semantic upgrade, the active immutable revision is the rollback
  // authority even though its compiler fingerprint is intentionally old.
  // Republishing its materialized contents here would stamp those old
  // semantics with the current fingerprint and make a failed upgrade appear
  // complete on the next prepare-all run.
  const baseline = activeBaseline.requiresReparse && activeBaseline.bundleHash
    ? activeBaseline
    : await cache.publish(source, { allowSemanticDebtForRollback: true });
  if (activeBaseline.requiresReparse && activeBaseline.bundleHash) {
    report(`Using incompatible active revision ${activeBaseline.bundleHash} as the rollback baseline without restamping its compiler semantics.`);
  }
  if (!baseline.bundleHash) throw new Error("Current prepared revision was not published.");
  const previousBundleHash = baseline.bundleHash;
  report(
    `Starting ${options.all ? "whole-novel" : "chapter"} reparse ${runId} for ${source.id}: `
    + `${selected.length} batch(es), chapter(s) ${selectedChapters.join(", ")}.`,
  );

  try {
    options.onStatus?.("Invalidating selected preparation artifacts");
    await new CompilerBatchStore(root).markIncomplete(source.id, selectedBatchIds);
    const invalidated = await invalidatePreparationArtifacts(root, source.id, selected, Boolean(options.all));
    for (const batchId of selectedBatchIds) await rejectPendingCompilerBatchProposals(root, batchId);
    report(`Invalidated ${invalidated} current preparation artifact(s); immutable revisions and branch snapshots were retained.`);
    options.signal?.throwIfAborted();

    await dependencies.compileSource({
      root,
      configPath: options.configPath,
      allowMissingConfig: true,
      sourceId: source.id,
      ...(options.model ? { model: options.model } : {}),
      batchIds: selectedBatchIds,
      resume: true,
      acquireLock: false,
      signal: options.signal,
      promptTransform: (prompt, batch) => reparsePrompt(prompt, batch, runId, Boolean(options.all)),
      onProgress: report,
      onStatus: options.onStatus,
      onModelText: options.onModelText,
      onModelThinking: options.onModelThinking,
      onModelToolCall: options.onModelToolCall,
      onModelToolResult: options.onModelToolResult,
      onModelEvent: options.onModelEvent,
    });
    options.signal?.throwIfAborted();
    options.onStatus?.("Converging validated compiler proposals");
    const convergence = await convergeWorldProposals(root, source.id, {
      onProgress: (progress) => options.onStatus?.(
        `Converging proposals · ${progress.phase} ${progress.processed}/${progress.total}`,
      ),
    });
    const quarantined = await quarantineUncommittableProposals(root, convergence);
    options.signal?.throwIfAborted();
    report(
      `Reparse convergence accepted ${convergence.canonical.accepted.length + convergence.possibilities.accepted.length} proposal(s)`
      + ` and quarantined ${quarantined.length} uncommittable draft(s).`,
    );
    options.onStatus?.("Finalizing prepared revision");
    await dependencies.finishPreparation({
      root,
      configPath: options.configPath,
      sourceId: source.id,
      ...(options.model ? { model: options.model } : {}),
      yes: true,
      createBranch: false,
      restoreCache: false,
      reparseBaselineBundleHash: previousBundleHash,
      reparseRunId: runId,
      acquireLock: false,
      signal: options.signal,
      cacheRoot: options.cacheRoot,
      onProgress: report,
      onStatus: options.onStatus,
      onModelText: options.onModelText,
      onModelThinking: options.onModelThinking,
      onModelToolCall: options.onModelToolCall,
      onModelToolResult: options.onModelToolResult,
      onModelEvent: options.onModelEvent,
    });
    options.signal?.throwIfAborted();
    const active = await cache.lookup(source);
    if (!active.bundleHash) throw new Error("Reparse completed without an active prepared-cache revision.");
    report(active.bundleHash === previousBundleHash
      ? `Reparse reproduced and reactivated the existing content-identical revision ${active.bundleHash}.`
      : `Activated prepared revision ${active.bundleHash}; previous revision ${previousBundleHash} remains available.`);
    options.onStatus?.("Reparse complete");
    return { sourceId: source.id, chapters: selectedChapters, previousBundleHash, activeBundleHash: active.bundleHash };
  } catch (error) {
    options.onStatus?.(`Reparse failed; restoring revision ${previousBundleHash}`);
    const rejected = await rejectPendingCompilerSourceProposals(root, source.id);
    if (rejected.length) report(`Rejected ${rejected.length} pending source proposal(s) before rollback.`);
    try {
      await cache.activate(source, previousBundleHash, { allowIncompatibleRollback: true });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Reparse failed and rollback to ${previousBundleHash} also failed. `
        + `Original error: ${error instanceof Error ? error.message : String(error)} `
        + `Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    throw new Error(
      `Reparse failed; current preparation was rolled back to ${previousBundleHash}. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function recoverInterruptedReparse(
  root: string,
  source: SourceDocument,
  batches: readonly CompilerBatch[],
  selectedBatchIds: readonly string[],
  cache: PreparedNovelCache,
  report: (message: string) => void,
): Promise<void> {
  const batchStore = new CompilerBatchStore(root);
  const progress = await batchStore.read(source.id);
  const completed = new Set(progress.completedBatchIds);
  const unfinished = batches.filter((batch) => !completed.has(batch.id));
  if (!unfinished.length) return;
  const selected = new Set(selectedBatchIds);
  let active = await cache.lookup(source);
  let bootstrappedLegacyBaseline = false;
  const persisted = await batchStore.readPersisted(source.id);
  const selectedWholeSource = batches
    .filter((batch) => batch.purpose !== "structure-discovery")
    .every((batch) => selected.has(batch.id));
  if (
    !active.bundleHash
    && selectedWholeSource
    && persisted?.pipelineVersion !== undefined
    && persisted.pipelineVersion < COMPILER_PIPELINE_VERSION
    && batches.every((batch) => persisted.completedBatchIds.includes(batch.id))
  ) {
    const published = await cache.publishLegacyRollbackBaseline(source, persisted);
    if (!published.bundleHash) throw new Error("Legacy rollback baseline publication did not return a revision hash.");
    report(
      `Preserved the complete pipeline v${persisted.pipelineVersion} materialization as incompatible rollback revision `
      + `${published.bundleHash} before its first whole-novel reparse.`,
    );
    active = await cache.lookup(source);
    bootstrappedLegacyBaseline = true;
  }
  const outsideSelection = bootstrappedLegacyBaseline
    ? []
    : unfinished.filter((batch) => !selected.has(batch.id));
  if (outsideSelection.length) {
    if (outsideSelection.some((batch) => batch.purpose === "structure-discovery")) {
      throw new Error("Cannot start reparse before chapter structure discovery is checkpointed. Resume preparation first.");
    }
    const chapters = [...new Set(outsideSelection.map((batch) => batch.chapterOrdinal))].sort((left, right) => left - right);
    throw new Error(
      `Cannot start reparse while ${outsideSelection.length} unfinished compiler batch(es) exist outside the selected scope `
      + `(chapter(s) ${chapters.join(", ")}). Resume preparation first or include those chapters in this reparse.`,
    );
  }
  if (!active.bundleHash) {
    throw new Error(
      `Cannot recover ${unfinished.length} unfinished selected compiler batch(es): no active prepared revision is available as a rollback baseline. `
      + "Complete preparation before reparsing.",
    );
  }
  if (!bootstrappedLegacyBaseline) {
    report(
      `Detected an interrupted reparse affecting ${unfinished.length} selected batch(es); `
      + `restoring active revision ${active.bundleHash} before retrying.`,
    );
  }
  const rejected = await rejectPendingCompilerSourceProposals(root, source.id);
  if (rejected.length) report(`Rejected ${rejected.length} pending source proposal(s) from the interrupted reparse.`);
  await cache.activate(source, active.bundleHash, { allowIncompatibleRollback: true });
  report(bootstrappedLegacyBaseline
    ? "Legacy rollback baseline materialized; starting the whole-novel reparse from a recoverable revision."
    : "Interrupted reparse baseline restored; restarting the selected scope from a clean prepared revision.");
}

function openingBatchId(batches: readonly CompilerBatch[]): string {
  const opening = selectOpeningCompilerBatch(batches);
  if (!opening) throw new Error("Cannot resolve the opening compiler batch.");
  return `opening-${opening.id}`;
}

export function parseOrdinalSelection(value: string, available: readonly number[], optionName: string): number[] {
  const allowed = new Set(available);
  const selected = new Set<number>();
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) throw new Error(`${optionName} must use comma-separated ordinals or ranges, for example 1,3-5.`);
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start) throw new Error(`${optionName} contains an invalid range: ${part}`);
    for (let ordinal = start; ordinal <= end; ordinal += 1) selected.add(ordinal);
  }
  const unavailable = [...selected].filter((ordinal) => !allowed.has(ordinal)).sort((left, right) => left - right);
  if (unavailable.length) {
    throw new Error(`${optionName} references unavailable chapter(s): ${unavailable.join(", ")}. Available: ${[...allowed].sort((a, b) => a - b).join(", ")}`);
  }
  return [...selected].sort((left, right) => left - right);
}

async function resolveSource(root: string, sourceId?: string): Promise<SourceDocument> {
  const sources = await (await WorkspaceStore.create(root)).listSources();
  if (!sources.length) throw new Error("No ingested sources. Run nwh ingest first.");
  const source = sourceId ? sources.find((candidate) => candidate.id === sourceId) : sources.length === 1 ? sources[0] : undefined;
  if (source) return source;
  if (sourceId) throw new Error(`Unknown source id: ${sourceId}`);
  throw new Error(`Multiple sources are registered; specify --source. Available: ${sources.map((item) => item.id).join(", ")}`);
}

function reparsePrompt(prompt: string, batch: CompilerBatch, runId: string, whole: boolean): string {
  return `Explicit ${whole ? "whole-novel" : "chapter"} reparse run ${runId}; detected chapter ${batch.chapterOrdinal}`
    + `${batch.chapterTitle ? ` (title JSON: ${promptJson(batch.chapterTitle)})` : ""}. Re-evaluate the supplied evidence even when related identities appear in the catalog. `
    + `The host preserved prior immutable revisions for existing branches. Reuse stable payload logical IDs for corrected artifacts, but every newly submitted proposal envelope ID must be unique and end with -${runId}. `
    + `Do not resubmit an unchanged artifact merely to manufacture a revision. Finish this batch normally after the evidence has been reconsidered.\n\n${prompt}`;
}

export async function invalidatePreparationArtifacts(
  root: string,
  sourceId: string,
  selectedBatches: readonly CompilerBatch[],
  whole: boolean,
): Promise<number> {
  const selectedSpans = selectedBatches.flatMap((batch) => batch.evidence.map((reference) => reference.span));
  const shouldInvalidate = (item: { evidence: readonly { span: EvidenceSpanKey }[] }) => {
    if (!item.evidence.length) return false;
    if (whole) return item.evidence.every((reference) => reference.span.sourceId === sourceId);
    return item.evidence.every((reference) => selectedSpans.some((selected) => spanContains(selected, reference.span)));
  };
  const canon = new CanonicalModelStore(root);
  const actors = new ActorModelStore(root);
  const possibilities = new PossibilityTemplateStore(root);
  const initial = new InitialWorldStore(root);
  const exactEvidence = new EvidenceAssertionStore(root);
  const source = await (await WorkspaceStore.create(root)).getSource(sourceId);
  if (!source) throw new Error(`Unknown source id: ${sourceId}`);
  let count = await invalidateCompilerMetadata(root, source, selectedBatches, selectedSpans, whole);
  const [
    entities,
    propositions,
    attributions,
    claims,
    events,
    eventParticipations,
    eventRelations,
    sceneOccurrences,
    eventFrames,
    actionSchemas,
    actionConstraints,
    normTemplates,
    processTemplates,
    spatialRelations,
    rules,
    goals,
    models,
    templates,
    opening,
  ] = await Promise.all([
    canon.listEntities(),
    canon.listPropositions(),
    canon.listAttributions(),
    canon.listClaims(),
    canon.listEvents(),
    canon.listEventParticipations(),
    canon.listEventRelations(),
    canon.listSceneOccurrences(),
    canon.listEventFrames(),
    canon.listActionSchemas(),
    canon.listActionConstraints(),
    canon.listNormTemplates(),
    canon.listProcessTemplates(),
    canon.listSpatialRelations(),
    canon.listRules(),
    actors.listGoals(), actors.listModels(), possibilities.list(), initial.get(),
  ]);
  const invalidate = async (kind: string, id: string, remove: () => Promise<void>) => {
    await remove();
    await exactEvidence.removeForArtifact(kind, id);
    count += 1;
  };
  for (const item of entities) if (shouldInvalidate(item)) await invalidate("entity", item.id, () => canon.removeCurrent("entities", item.id));
  for (const item of propositions) if (shouldInvalidate(item)) await invalidate("proposition", item.id, () => canon.removeCurrent("propositions", item.id));
  for (const item of attributions) if (shouldInvalidate(item)) await invalidate("attribution", item.id, () => canon.removeCurrent("attributions", item.id));
  for (const item of claims) if (shouldInvalidate(item)) await invalidate("claim", item.id, () => canon.removeCurrent("claims", item.id));
  for (const item of events) if (shouldInvalidate(item)) await invalidate("canonical-event", item.id, () => canon.removeCurrent("events", item.id));
  for (const item of eventParticipations) if (shouldInvalidate(item)) await invalidate("event-participation", item.id, () => canon.removeCurrent("event-participations", item.id));
  for (const item of eventRelations) {
    if (shouldInvalidate({ evidence: [...item.evidence, ...(item.counterEvidence ?? [])] })) {
      await invalidate("event-relation", item.id, () => canon.removeCurrent("event-relations", item.id));
    }
  }
  for (const item of sceneOccurrences) if (shouldInvalidate(item)) await invalidate("scene-occurrence", item.id, () => canon.removeCurrent("scene-occurrences", item.id));
  for (const item of eventFrames) if (shouldInvalidate(item)) await invalidate("event-frame", item.id, () => canon.removeCurrent("event-frames", item.id));
  for (const item of actionSchemas) if (shouldInvalidate(item)) await invalidate("action-schema", item.id, () => canon.removeCurrent("action-schemas", item.id));
  for (const item of actionConstraints) if (shouldInvalidate(item)) await invalidate("action-constraint", item.id, () => canon.removeCurrent("action-constraints", item.id));
  for (const item of normTemplates) if (shouldInvalidate(item)) await invalidate("norm-template", item.id, () => canon.removeCurrent("norm-templates", item.id));
  for (const item of processTemplates) if (shouldInvalidate(item)) await invalidate("process-template", item.id, () => canon.removeCurrent("process-templates", item.id));
  for (const item of spatialRelations) if (shouldInvalidate({ evidence: spatialRelationEvidence(item) })) await invalidate("spatial-relation", item.id, () => canon.removeCurrent("spatial-relations", item.id));
  for (const item of rules) if (shouldInvalidate({ evidence: worldRuleEvidence(item) })) await invalidate("world-rule", item.id, () => canon.removeCurrent("rules", item.id));
  for (const item of goals) if (shouldInvalidate(item)) await invalidate("character-goal", item.id, () => actors.removeGoal(item.id));
  for (const item of models) {
    if (shouldInvalidate({ evidence: [...item.evidence, ...characterOntologyEvidence(item)] })) {
      await invalidate("character-model", item.actorId, () => actors.removeModel(item.actorId));
    }
  }
  for (const item of templates) if (shouldInvalidate(item)) await invalidate("possibility", item.id, () => possibilities.remove(item.id));
  if (opening && shouldInvalidate(opening)) await invalidate("initial-world", "initial-world", () => initial.clear());
  return count;
}

async function invalidateCompilerMetadata(
  root: string,
  source: SourceDocument,
  selectedBatches: readonly CompilerBatch[],
  selectedSpans: readonly EvidenceSpanKey[],
  whole: boolean,
): Promise<number> {
  const annotations = new SourceAnnotationStore(root);
  const entityResolutions = new EntityResolutionStore(root);
  const eventResolutions = new EventResolutionStore(root);
  const accounting = new SourceAccountingStore(root);
  const [currentAnnotations, currentEntityResolutions, currentEventResolutions, currentAccounting] = await Promise.all([
    annotations.list(source.id),
    entityResolutions.list(source.id),
    eventResolutions.list(source.id),
    accounting.read(source.id),
  ]);
  if (whole) {
    await Promise.all([
      annotations.replaceCurrent(source.id, []),
      entityResolutions.replaceCurrent(source.id, []),
      eventResolutions.replaceCurrent(source.id, []),
      accounting.replaceCurrent(source.id, null),
    ]);
    return currentAnnotations.length
      + currentEntityResolutions.length
      + currentEventResolutions.length
      + (currentAccounting ? 1 : 0);
  }
  const selectedAnnotationIds = new Set<string>();
  for (const annotation of currentAnnotations) {
    const anchors = annotationAnchors(annotation);
    const contained = anchors.map((anchor) => selectedSpans.some((span) => spanContains(span, anchor)));
    const touched = anchors.map((anchor) => selectedSpans.some((span) => spansOverlap(span, anchor)));
    if (touched.some(Boolean) && (!contained.every(Boolean) || touched.some((value, index) => value && !contained[index]))) {
      throw new Error(`Source annotation ${annotation.id} crosses the selected chapter boundary; rerun reparse with --all.`);
    }
    if (contained.length > 0 && contained.every(Boolean)) selectedAnnotationIds.add(annotation.id);
  }
  const retainedEntityResolutions = currentEntityResolutions.filter((resolution) =>
    !selectedAnnotationIds.has(resolution.mentionId));
  const retainedEventResolutions = currentEventResolutions.filter((resolution) => {
    const selected = resolution.eventMentionIds.filter((id) => selectedAnnotationIds.has(id));
    if (selected.length > 0 && selected.length !== resolution.eventMentionIds.length) {
      throw new Error(`Event resolution ${resolution.id} crosses the selected chapter boundary; rerun reparse with --all.`);
    }
    return selected.length === 0;
  });
  await annotations.replaceCurrent(
    source.id,
    currentAnnotations.filter((annotation) => !selectedAnnotationIds.has(annotation.id)),
  );
  await entityResolutions.replaceCurrent(source.id, retainedEntityResolutions);
  await eventResolutions.replaceCurrent(source.id, retainedEventResolutions);
  const removedReviews = await accounting.removeBatchReviews(
    source.id,
    selectedBatches.map((batch) => batch.id),
    await ensureSourceStructure(root, source),
  );
  return selectedAnnotationIds.size
    + (currentEntityResolutions.length - retainedEntityResolutions.length)
    + (currentEventResolutions.length - retainedEventResolutions.length)
    + removedReviews;
}

type EvidenceSpanKey = {
  sourceId: string;
  startLine: number;
  endLine: number;
  startByte?: number;
  endByte?: number;
  quoteHash?: string;
};

function spanContains(container: EvidenceSpanKey, candidate: EvidenceSpanKey): boolean {
  if (container.sourceId !== candidate.sourceId) return false;
  if (container.startByte !== undefined
    && container.endByte !== undefined
    && candidate.startByte !== undefined
    && candidate.endByte !== undefined) {
    return container.startByte <= candidate.startByte && container.endByte >= candidate.endByte;
  }
  return container.startLine <= candidate.startLine && container.endLine >= candidate.endLine;
}

function spansOverlap(left: EvidenceSpanKey, right: EvidenceSpanKey): boolean {
  if (left.sourceId !== right.sourceId) return false;
  if (left.startByte !== undefined
    && left.endByte !== undefined
    && right.startByte !== undefined
    && right.endByte !== undefined) {
    return left.startByte < right.endByte && right.startByte < left.endByte;
  }
  return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

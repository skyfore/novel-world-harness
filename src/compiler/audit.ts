import { ActorModelStore, characterGoalHasDevelopmentBoundary } from "../world/actors.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { InitialWorldStore } from "../world/initial.js";
import type { CanonicalEvent, EvidenceRef, StoryTime } from "../world/model.js";
import { SegmentStore } from "./segments.js";
import { EvidenceVerifier } from "./evidence.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { assertEvidenceExclusiveToSource } from "../world/source-scope.js";
import { PossibilityTemplateStore } from "../world/possibility-model.js";
import { hasExecutablePossibilityEffect } from "./semantics.js";
import { contentHash } from "../world/canonical.js";
import {
  EvidenceAssertionStore,
  evidenceAssertionSourceIds,
  validateEvidenceAssertionTargets,
} from "./evidence-assertions.js";
import { evidenceSourceIds } from "../world/source-scope.js";
import { SourceStructureStore, baseStructuralUnits, type SourceStructureManifest } from "./structure.js";
import { SourceAccountingStore, type SourceAccountingStatus } from "./source-accounting.js";
import {
  SourceAnnotationStore,
  annotationAnchors,
  validateSourceAnnotationClosure,
} from "./annotations.js";
import { inspectEntityResolutionCoverage } from "./entity-resolution.js";
import { inspectEventResolutionCoverage } from "./event-resolution.js";

export type CompilerReadinessState = "ready" | "not-ready" | "unknown";

export type CompilerAuditReport = {
  version: 1;
  sources: {
    registered: number;
    segmented: number;
    segments: number;
    changedSinceIngest: string[];
  };
  proposals: {
    pending: number;
    accepted: number;
    rejected: number;
    pendingByKind: Record<string, number>;
  };
  observations: {
    structuredSources: number;
    structuralUnits: number;
    baseUnits: number;
    entityMentions: number;
    eventMentions: number;
    quotations: number;
    discourseSegments: number;
    pendingAnnotations: number;
    accountedUnits: number;
    unaccountedUnits: number;
    blockingUnits: number;
    invalidAnchors: number;
    unitCoverage: number | null;
    byteCoverage: number | null;
    statusCounts: Record<SourceAccountingStatus, number>;
    errors: Array<{ observation: string; code: string; message: string }>;
  };
  resolutions: {
    entityMentions: number;
    resolved: number;
    newEntities: number;
    ambiguous: number;
    unresolved: number;
    missing: number;
    pending: number;
    invalid: number;
    missingMentionIds: string[];
    errors: Array<{ sourceId: string; message: string }>;
  };
  eventResolutions: {
    eventMentions: number;
    majorEventMentions: number;
    resolved: number;
    newEvents: number;
    ambiguous: number;
    unresolved: number;
    missing: number;
    pending: number;
    majorResolved: number;
    majorIncomplete: number;
    invalid: number;
    missingMentionIds: string[];
    errors: Array<{ sourceId: string; message: string }>;
  };
  canonical: {
    entities: number;
    propositions: number;
    attributions: number;
    claims: number;
    events: number;
    rules: number;
    initialWorld: boolean;
    characterGoals: number;
    characterModels: number;
    possibilities: number;
    autonomousWorldDrivers: number;
  };
  evidence: {
    artifactsChecked: number;
    referencesChecked: number;
    invalidReferences: number;
    validBindingRatio: number | null;
    assertionsChecked: number;
    artifactsWithExactEvidence: number;
    invalidAssertions: number;
    exactBindingRatio: number | null;
    errors: Array<{ artifact: string; code: string; message: string }>;
  };
  consistency: {
    causalGraphValid: boolean | null;
    narrativeGraphNavigable: boolean | null;
    causalCycles: string[][];
    missingCausalParents: Array<{ eventId: string; parentId: string }>;
    temporalRegressions: Array<{ eventId: string; parentId: string }>;
    causalComponents: number;
    largestCausalComponent: number;
    unconditionalRootEvents: string[];
    semanticReady: boolean | null;
    semanticIssues: string[];
  };
  semanticRepairTargets: {
    eventIds: string[];
    characterIds: string[];
    initialWorld: boolean;
    requiresFullReparse: boolean;
  };
  coverage: {
    sourceIndexing: number | null;
    evidenceBinding: number | null;
    sourceAccounting: number | null;
    temporalConsistency: number | null;
    stateDeltaExplicitness: number | null;
    causalityConsistency: number | null;
    entityResolution: number | null;
    majorEventResolution: number | null;
    epistemicCoverage: number | null;
    timelineAnchoring: number | null;
    eventEffectExplicitness: number | null;
    characterDevelopmentCoverage: number | null;
    openingCheckpointDeclared: number | null;
    participantPresenceCoverage: number | null;
    readerSummaryCoverage: number | null;
    characterEntryCheckpointCoverage: number | null;
    openingReaderSetup: number | null;
    openingPhysicalPresence: number | null;
    openingActionability: number | null;
    autonomousDriverCoverage: number | null;
  };
  readiness: {
    policyVersion: "baseline-v1";
    structural: CompilerReadinessState;
    evidence: CompilerReadinessState;
    accounting: CompilerReadinessState;
    resolution: CompilerReadinessState;
    semantic: CompilerReadinessState;
    runtime: CompilerReadinessState;
    publication: CompilerReadinessState;
    unknownDimensions: string[];
    blockingIssues: string[];
  };
  notes: string[];
};

export async function auditCompiler(
  workspaceRoot: string,
  options: { sourceId?: string } = {},
): Promise<CompilerAuditReport> {
  const workspace = await WorkspaceStore.create(workspaceRoot);
  const registeredSources = await workspace.listSources();
  const sources = options.sourceId
    ? registeredSources.filter((source) => source.id === options.sourceId)
    : registeredSources;
  if (options.sourceId && !sources.length) throw new Error(`Unknown source id: ${options.sourceId}`);
  const segments = new SegmentStore(workspaceRoot);
  let segmented = 0;
  let segmentCount = 0;
  let indexedBytes = 0;
  let sourceBytes = 0;
  const changedSinceIngest: string[] = [];
  for (const source of sources) {
    sourceBytes += source.bytes;
    const manifest = await segments.readManifest(source.id);
    if (manifest?.sourceSha256 === source.contentSha256) {
      segmented += 1;
      segmentCount += manifest.segments.length;
      indexedBytes += manifest.segments.reduce((sum, segment) => sum + segment.bytes, 0);
    }
    try {
      await readSourceMaterial(workspaceRoot, source);
    } catch {
      changedSinceIngest.push(source.id);
    }
  }
  const structureStore = new SourceStructureStore(workspaceRoot);
  const accountingStore = new SourceAccountingStore(workspaceRoot);
  const evidenceVerifier = new EvidenceVerifier(workspaceRoot);
  const structures: SourceStructureManifest[] = [];
  let structuralUnits = 0;
  let baseUnits = 0;
  let entityMentions = 0;
  let eventMentions = 0;
  let quotations = 0;
  let discourseSegments = 0;
  let pendingAnnotations = 0;
  let resolvedMentions = 0;
  let newEntityMentions = 0;
  let ambiguousMentions = 0;
  let unresolvedMentions = 0;
  let missingResolutions = 0;
  let pendingResolutions = 0;
  const missingResolutionMentionIds: string[] = [];
  const invalidResolutionIds = new Set<string>();
  const resolutionErrors: CompilerAuditReport["resolutions"]["errors"] = [];
  let resolvedEventMentions = 0;
  let newEventMentions = 0;
  let ambiguousEventMentions = 0;
  let unresolvedEventMentions = 0;
  let missingEventResolutions = 0;
  let pendingEventResolutions = 0;
  let majorEventMentions = 0;
  let majorResolvedEventMentions = 0;
  let majorIncompleteEventMentions = 0;
  const missingEventResolutionMentionIds: string[] = [];
  const invalidEventResolutionIds = new Set<string>();
  const eventResolutionErrors: CompilerAuditReport["eventResolutions"]["errors"] = [];
  let accountedUnits = 0;
  let unaccountedUnits = 0;
  let blockingUnits = 0;
  let accountedObservationBytes = 0;
  let observationBytes = 0;
  let invalidObservationAnchors = 0;
  const observationErrors: CompilerAuditReport["observations"]["errors"] = [];
  const annotationStore = new SourceAnnotationStore(workspaceRoot);
  const accountingStatusCounts: Record<SourceAccountingStatus, number> = {
    represented: 0,
    "background-only": 0,
    paratext: 0,
    "duplicate-description": 0,
    unresolved: 0,
    "intentionally-deferred": 0,
  };
  for (const source of sources) {
    const [resolutionCoverage, eventResolutionCoverage] = await Promise.all([
      inspectEntityResolutionCoverage(workspaceRoot, source.id),
      inspectEventResolutionCoverage(workspaceRoot, source.id),
    ]);
    resolvedMentions += resolutionCoverage.resolved;
    newEntityMentions += resolutionCoverage.newEntities;
    ambiguousMentions += resolutionCoverage.ambiguous;
    unresolvedMentions += resolutionCoverage.unresolved;
    missingResolutions += resolutionCoverage.missing;
    pendingResolutions += resolutionCoverage.pending;
    missingResolutionMentionIds.push(...resolutionCoverage.missingMentionIds);
    for (const resolutionId of resolutionCoverage.invalidResolutionIds) invalidResolutionIds.add(resolutionId);
    resolutionErrors.push(...resolutionCoverage.errors.map((message) => ({ sourceId: source.id, message })));
    resolvedEventMentions += eventResolutionCoverage.resolved;
    newEventMentions += eventResolutionCoverage.newEvents;
    ambiguousEventMentions += eventResolutionCoverage.ambiguous;
    unresolvedEventMentions += eventResolutionCoverage.unresolved;
    missingEventResolutions += eventResolutionCoverage.missing;
    pendingEventResolutions += eventResolutionCoverage.pending;
    majorEventMentions += eventResolutionCoverage.majorEventMentions;
    majorResolvedEventMentions += eventResolutionCoverage.majorResolved;
    majorIncompleteEventMentions += eventResolutionCoverage.majorIncomplete;
    missingEventResolutionMentionIds.push(...eventResolutionCoverage.missingMentionIds);
    for (const resolutionId of eventResolutionCoverage.invalidResolutionIds) invalidEventResolutionIds.add(resolutionId);
    eventResolutionErrors.push(...eventResolutionCoverage.errors.map((message) => ({ sourceId: source.id, message })));
    const [annotations, annotationProposals] = await Promise.all([
      annotationStore.list(source.id),
      annotationStore.listProposals(source.id, "pending"),
    ]);
    entityMentions += annotations.filter((annotation) => annotation.annotationType === "entity-mention").length;
    eventMentions += annotations.filter((annotation) => annotation.annotationType === "event-mention").length;
    quotations += annotations.filter((annotation) => annotation.annotationType === "quotation").length;
    discourseSegments += annotations.filter((annotation) => annotation.annotationType === "discourse-segment").length;
    pendingAnnotations += annotationProposals.length;
    for (const annotation of annotations) {
      for (const anchor of annotationAnchors(annotation)) {
        const inspection = await evidenceVerifier.inspectAnchor(anchor);
        invalidObservationAnchors += inspection.issues.length;
        for (const issue of inspection.issues) {
          observationErrors.push({
            observation: `${annotation.annotationType}:${annotation.id}`,
            code: issue.code,
            message: issue.message,
          });
        }
      }
    }
    for (const issue of await validateSourceAnnotationClosure(
      workspaceRoot,
      source.id,
      annotationProposals.map((proposal) => proposal.id),
      { includeCommitted: true, verifyAnchors: false },
    )) {
      observationErrors.push({ observation: `annotation-proposal:${source.id}`, code: "annotation-closure", message: issue });
    }
    const structure = await structureStore.read(source.id);
    if (!structure || structure.sourceSha256 !== source.contentSha256) continue;
    structures.push(structure);
    structuralUnits += structure.units.length;
    baseUnits += baseStructuralUnits(structure).length;
    for (const unit of structure.units) {
      const inspection = await evidenceVerifier.inspectAnchor(unit.anchor);
      invalidObservationAnchors += inspection.issues.length;
      for (const issue of inspection.issues) {
        observationErrors.push({ observation: `structural-unit:${unit.id}`, code: issue.code, message: issue.message });
      }
    }
    for (const discourse of structure.discourseSegments) {
      for (const anchor of discourse.anchors) {
        const inspection = await evidenceVerifier.inspectAnchor(anchor);
        invalidObservationAnchors += inspection.issues.length;
        for (const issue of inspection.issues) {
          observationErrors.push({ observation: `discourse-segment:${discourse.id}`, code: issue.code, message: issue.message });
        }
      }
    }
    const summary = await accountingStore.summarize(structure);
    accountedUnits += summary.accountedUnits;
    unaccountedUnits += summary.unaccountedUnits;
    blockingUnits += summary.blockingUnits;
    accountedObservationBytes += summary.accountedBytes;
    observationBytes += summary.totalBytes;
    for (const status of Object.keys(accountingStatusCounts) as SourceAccountingStatus[]) {
      accountingStatusCounts[status] += summary.statusCounts[status];
    }
  }

  const proposalStore = new ProposalStore(workspaceRoot);
  const [pending, accepted, rejected] = await Promise.all([
    proposalStore.list("pending", options.sourceId),
    proposalStore.list("accepted", options.sourceId),
    proposalStore.list("rejected", options.sourceId),
  ]);
  const pendingByKind: Record<string, number> = {};
  for (const proposal of pending) pendingByKind[proposal.kind] = (pendingByKind[proposal.kind] ?? 0) + 1;

  const canon = new CanonicalModelStore(workspaceRoot);
  const actorStore = new ActorModelStore(workspaceRoot);
  const [allEntities, allPropositions, allAttributions, allClaims, allEvents, allRules, storedInitialWorld, allGoals, allModels, allPossibilities] = await Promise.all([
    canon.listEntities(),
    canon.listPropositions(),
    canon.listAttributions(),
    canon.listClaims(),
    canon.listEvents(),
    canon.listRules(),
    new InitialWorldStore(workspaceRoot).get(),
    actorStore.listGoals(),
    actorStore.listModels(),
    new PossibilityTemplateStore(workspaceRoot).list(),
  ]);
  const belongsToSelectedSource = (item: { evidence: readonly EvidenceRef[] }) => {
    if (!options.sourceId) return true;
    const matches = item.evidence.some((reference) => reference.span.sourceId === options.sourceId);
    if (matches) assertEvidenceExclusiveToSource(item.evidence, options.sourceId, "Audited compiler artifact");
    return matches;
  };
  const entities = allEntities.filter(belongsToSelectedSource);
  const propositions = allPropositions.filter(belongsToSelectedSource);
  const attributions = allAttributions.filter(belongsToSelectedSource);
  const claims = allClaims.filter(belongsToSelectedSource);
  const events = allEvents.filter(belongsToSelectedSource);
  const rules = allRules.filter(belongsToSelectedSource);
  const initialWorld = storedInitialWorld && belongsToSelectedSource(storedInitialWorld) ? storedInitialWorld : null;
  const goals = allGoals.filter(belongsToSelectedSource);
  const models = allModels.filter(belongsToSelectedSource);
  const possibilities = allPossibilities.filter(belongsToSelectedSource);

  const evidenceArtifacts: Array<{ name: string; kind: string; id: string; payload: unknown; evidence: EvidenceRef[] }> = [
    ...entities.map((item) => ({ name: `entity:${item.id}`, kind: "entity", id: item.id, payload: item, evidence: item.evidence })),
    ...propositions.map((item) => ({ name: `proposition:${item.id}`, kind: "proposition", id: item.id, payload: item, evidence: item.evidence })),
    ...attributions.map((item) => ({ name: `attribution:${item.id}`, kind: "attribution", id: item.id, payload: item, evidence: item.evidence })),
    ...claims.map((item) => ({ name: `claim:${item.id}`, kind: "claim", id: item.id, payload: item, evidence: item.evidence })),
    ...events.map((item) => ({ name: `event:${item.id}`, kind: "canonical-event", id: item.id, payload: item, evidence: item.evidence })),
    ...rules.map((item) => ({ name: `rule:${item.id}`, kind: "world-rule", id: item.id, payload: item, evidence: item.evidence })),
    ...(initialWorld ? [{ name: "initial-world", kind: "initial-world", id: "initial-world", payload: initialWorld, evidence: initialWorld.evidence }] : []),
    ...goals.map((item) => ({ name: `goal:${item.id}`, kind: "character-goal", id: item.id, payload: item, evidence: item.evidence })),
    ...models.map((item) => ({ name: `model:${item.actorId}`, kind: "character-model", id: item.actorId, payload: item, evidence: item.evidence })),
    ...possibilities.map((item) => ({ name: `possibility:${item.id}`, kind: "possibility", id: item.id, payload: item, evidence: item.evidence })),
  ];
  const evidenceErrors: CompilerAuditReport["evidence"]["errors"] = [];
  const exactEvidence = new EvidenceAssertionStore(workspaceRoot);
  let referencesChecked = 0;
  let invalidReferences = 0;
  let assertionsChecked = 0;
  let artifactsWithExactEvidence = 0;
  let invalidAssertions = 0;
  let validExactBindings = 0;
  for (const artifact of evidenceArtifacts) {
    referencesChecked += artifact.evidence.length;
    const result = await evidenceVerifier.verifyAll(artifact.evidence);
    invalidReferences += result.issues.length;
    for (const issue of result.issues) evidenceErrors.push({ artifact: artifact.name, code: issue.code, message: issue.message });
    const binding = await exactEvidence.bindingForArtifact(artifact.kind, artifact.id);
    if (!binding?.assertions.length) continue;
    artifactsWithExactEvidence += 1;
    assertionsChecked += binding.assertions.length;
    const exactIssues = [
      ...validateEvidenceAssertionTargets(artifact.kind, artifact.id, artifact.payload, binding.assertions),
      ...(await evidenceVerifier.verifyAssertions(binding.assertions)).issues,
    ];
    if (binding.artifactHash !== contentHash(artifact.payload)) {
      exactIssues.push({
        code: "STALE_EVIDENCE_BINDING",
        message: `Exact evidence binding targets artifact hash ${binding.artifactHash}, current content is ${contentHash(artifact.payload)}.`,
        path: "evidenceAssertions",
      });
    }
    const legacySourceIds = evidenceSourceIds(artifact.evidence);
    const exactSourceIds = evidenceAssertionSourceIds(binding.assertions);
    if (legacySourceIds.length !== 1 || exactSourceIds.length !== 1 || legacySourceIds[0] !== exactSourceIds[0]) {
      exactIssues.push({
        code: "EVIDENCE_SOURCE_MISMATCH",
        message: `Legacy evidence sources (${legacySourceIds.join(", ") || "none"}) do not match exact evidence sources (${exactSourceIds.join(", ") || "none"}).`,
        path: "evidenceAssertions",
      });
    }
    invalidAssertions += exactIssues.length;
    for (const issue of exactIssues) evidenceErrors.push({ artifact: artifact.name, code: issue.code, message: issue.message });
    if (!exactIssues.length) validExactBindings += 1;
  }

  const graph = auditCausalGraph(events);
  const narrativeGraphNavigable = events.length ? graphNavigable(events, graph) : null;
  const eventsWithExplicitDelta = events.filter((event) => event.observedOutcome.operations.length > 0).length;
  const eventsWithExplicitEffect = events.filter((event) =>
    event.observedOutcome.operations.length > 0 || (event.observedKnowledge?.operations.length ?? 0) > 0).length;
  const timelineAnchoring = events.length
    ? events.filter((event) => event.storyTime.kind !== "unknown").length / events.length
    : null;
  const eventEffectExplicitness = events.length ? eventsWithExplicitEffect / events.length : null;
  const participationCounts = new Map<string, number>();
  for (const event of events) {
    for (const participantId of event.participants) {
      if (entities.find((entity) => entity.id === participantId)?.kind !== "character") continue;
      participationCounts.set(participantId, (participationCounts.get(participantId) ?? 0) + 1);
    }
  }
  const recurringCharacters = [...participationCounts].filter(([, count]) => count >= 3).map(([id]) => id);
  const growthActors = new Set([
    ...models.filter((model) => (model.developmentPhases?.length ?? 0) > 0).map((model) => model.actorId),
    ...goals.filter(characterGoalHasDevelopmentBoundary).map((goal) => goal.actorId),
  ]);
  const characterDevelopmentCoverage = recurringCharacters.length
    ? recurringCharacters.filter((actorId) => growthActors.has(actorId)).length / recurringCharacters.length
    : null;
  const characterIds = new Set(entities.filter((entity) => entity.kind === "character").map((entity) => entity.id));
  const characterParticipantSlots = events.flatMap((event) =>
    event.participants.filter((participantId) => characterIds.has(participantId)).map((participantId) => ({ event, participantId })));
  const participantPresenceCoverage = characterParticipantSlots.length
    ? characterParticipantSlots.filter(({ event, participantId }) =>
        event.participantPresence?.some((presence) => presence.entityId === participantId)).length / characterParticipantSlots.length
    : null;
  const readerSummaryCoverage = events.length
    ? events.filter((event) => Boolean(event.readerSummary?.trim())).length / events.length
    : null;
  const actionableOpeningFields = new Set(["character.location", "character.plan", "character.momentum"]);
  const physicalOpeningActorIds = new Set(initialWorld?.participantPresence
    ?.filter((presence) => presence.mode === "physical" && characterIds.has(presence.entityId))
    .map((presence) => presence.entityId) ?? []);
  const openingActorIds = new Set(initialWorld?.delta.operations.flatMap((operation) =>
    "entityId" in operation
    && characterIds.has(operation.entityId)
    && physicalOpeningActorIds.has(operation.entityId)
    && actionableOpeningFields.has(operation.field)
      ? [operation.entityId]
      : []) ?? []);
  const openingActionability = initialWorld
    ? initialWorld.delta.operations.some((operation) =>
        "entityId" in operation
        && characterIds.has(operation.entityId)
        && physicalOpeningActorIds.has(operation.entityId)
        && actionableOpeningFields.has(operation.field)) ? 1 : 0
    : null;
  const openingReaderSetup = initialWorld
    ? (initialWorld.readerSetup?.trim() ? 1 : 0)
    : null;
  const openingPhysicalPresence = initialWorld
    ? (physicalOpeningActorIds.size ? 1 : 0)
    : null;
  // discourseOrder is local to one compiler evidence batch. Source evidence
  // lines are the cross-batch textual-order authority; the model-proposed
  // value only breaks ties inside the same evidence slice.
  const eventsByDiscourse = [...events].sort((left, right) =>
    earliestEvidenceLine(left) - earliestEvidenceLine(right)
    || (left.narrativeContext?.discourseOrder ?? 0) - (right.narrativeContext?.discourseOrder ?? 0)
    || left.id.localeCompare(right.id));
  const firstEmbodiedEventByActor = new Map<string, CanonicalEvent>();
  for (const event of eventsByDiscourse) {
    if (event.narrativeContext?.mode && event.narrativeContext.mode !== "scene") continue;
    for (const presence of event.participantPresence ?? []) {
      if (presence.mode !== "physical" || openingActorIds.has(presence.entityId)) continue;
      if (!firstEmbodiedEventByActor.has(presence.entityId)) firstEmbodiedEventByActor.set(presence.entityId, event);
    }
  }
  const laterEntryActors = [...firstEmbodiedEventByActor.keys()];
  const characterEntryCheckpointCoverage = laterEntryActors.length
    ? laterEntryActors.filter((actorId) =>
        firstEmbodiedEventByActor.get(actorId)?.characterEntryCheckpoints?.some((checkpoint) =>
          checkpoint.actorId === actorId
          && checkpoint.participantPresence.some((presence) =>
            presence.entityId === actorId && presence.mode === "physical")
          && checkpoint.delta.operations.some((operation) =>
            "entityId" in operation
            && operation.entityId === actorId
            && actionableOpeningFields.has(operation.field))))
      .length / laterEntryActors.length
    : null;
  const incompleteEntryActors = laterEntryActors.filter((actorId) =>
    !firstEmbodiedEventByActor.get(actorId)?.characterEntryCheckpoints?.some((checkpoint) =>
      checkpoint.actorId === actorId
      && checkpoint.participantPresence.some((presence) =>
        presence.entityId === actorId && presence.mode === "physical")
      && checkpoint.delta.operations.some((operation) =>
        "entityId" in operation
        && operation.entityId === actorId
        && actionableOpeningFields.has(operation.field))));
  const autonomousPossibilities = possibilities.filter((possibility) =>
    !["canon-analogue", "player-choice", "actor-plan"].includes(possibility.kind)
    && hasExecutablePossibilityEffect(possibility));
  const executableGoals = goals.filter((goal) => [goal.candidateAction, ...(goal.actionPatterns ?? [])]
    .filter(Boolean)
    .some((action) => (action!.proposedDelta.operations.length > 0)
      || ((action!.proposedKnowledge?.operations.length ?? 0) > 0)));
  const autonomousWorldDrivers = autonomousPossibilities.length + executableGoals.length;
  const autonomousDriverCoverage = events.length ? (autonomousWorldDrivers > 0 ? 1 : 0) : null;
  const semanticIssues: string[] = [];
  const semanticRepairEventIds = new Set<string>();
  const semanticRepairCharacterIds: string[] = [];
  let semanticRepairInitialWorld = false;
  let semanticRepairRequiresFullReparse = false;
  // Small fixtures and short stories may intentionally be sparse. The hard
  // semantic gate targets novel-scale compilations where omissions compound.
  if (events.length >= 20) {
    if ((eventEffectExplicitness ?? 0) < 0.65) {
      semanticIssues.push(`Only ${formatRatio(eventEffectExplicitness)} of canonical events have a typed state or knowledge effect (minimum 65%).`);
      events.filter((event) => event.observedOutcome.operations.length === 0 && (event.observedKnowledge?.operations.length ?? 0) === 0)
        .forEach((event) => semanticRepairEventIds.add(event.id));
    }
    if ((timelineAnchoring ?? 0) < 0.75) {
      semanticIssues.push(`Only ${formatRatio(timelineAnchoring)} of canonical events have a story-time anchor (minimum 75%).`);
      events.filter((event) => event.storyTime.kind === "unknown").forEach((event) => semanticRepairEventIds.add(event.id));
    }
    if (recurringCharacters.length && (characterDevelopmentCoverage ?? 0) < 0.5) {
      semanticIssues.push(`Only ${formatRatio(characterDevelopmentCoverage)} of recurring characters have phase-bounded goals or development phases (minimum 50%).`);
      const requiredDeveloped = Math.ceil(recurringCharacters.length * 0.5);
      const currentlyDeveloped = recurringCharacters.filter((actorId) => growthActors.has(actorId)).length;
      semanticRepairCharacterIds.push(...recurringCharacters
        .filter((actorId) => !growthActors.has(actorId))
        .sort((left, right) =>
          (participationCounts.get(right) ?? 0) - (participationCounts.get(left) ?? 0)
          || left.localeCompare(right))
        .slice(0, Math.max(0, requiredDeveloped - currentlyDeveloped)));
    }
    if (initialWorld && !initialWorld.checkpoint) {
      semanticIssues.push("The initial world does not declare a temporal/narrative checkpoint.");
      semanticRepairInitialWorld = true;
    }
    if (characterParticipantSlots.length && (participantPresenceCoverage ?? 0) < 0.8) {
      semanticIssues.push(`Only ${formatRatio(participantPresenceCoverage)} of character participant slots declare physical/remote/mentioned/represented/dream/memory presence (minimum 80%).`);
      characterParticipantSlots
        .filter(({ event, participantId }) => !event.participantPresence?.some((presence) => presence.entityId === participantId))
        .forEach(({ event }) => semanticRepairEventIds.add(event.id));
    }
    if (readerSummaryCoverage !== 1) {
      semanticIssues.push(`Only ${formatRatio(readerSummaryCoverage)} of canonical events have a source-grounded reader recap (required 100% for complete later-role context).`);
      events.filter((event) => !event.readerSummary?.trim()).forEach((event) => semanticRepairEventIds.add(event.id));
    }
    if (laterEntryActors.length && characterEntryCheckpointCoverage !== 1) {
      semanticIssues.push(`Only ${formatRatio(characterEntryCheckpointCoverage)} of later embodied characters have a complete pre-event entry checkpoint (required 100%).`);
      incompleteEntryActors.forEach((actorId) => {
        const event = firstEmbodiedEventByActor.get(actorId);
        if (event) semanticRepairEventIds.add(event.id);
      });
    }
    if (initialWorld && openingReaderSetup !== 1) {
      semanticIssues.push("The initial world has no source-grounded spoiler-free readerSetup, so an unread player cannot orient before the opening scene.");
      semanticRepairInitialWorld = true;
    }
    if (initialWorld && openingPhysicalPresence !== 1) {
      semanticIssues.push("The initial world does not explicitly identify a physically present opening role; identity or state alone is not bodily presence.");
      semanticRepairInitialWorld = true;
    }
    if (initialWorld && openingActionability !== 1) {
      semanticIssues.push("The initial world has no grounded opening character location, plan, or momentum; it is not an actionable lived checkpoint.");
      semanticRepairInitialWorld = true;
    }
    if (autonomousWorldDrivers === 0) {
      semanticIssues.push("The compiled world has no executable actor goal or non-canonical autonomous possibility, so divergence can only wait for canon or repeat local dialogue.");
      semanticRepairRequiresFullReparse = true;
    }
  }
  const sourceIndexing = sources.length
    ? changedSinceIngest.length
      ? 0
      : sourceBytes === 0
        ? 1
        : Math.min(1, indexedBytes / sourceBytes)
    : null;
  const validBindingRatio = referencesChecked ? Math.max(0, 1 - invalidReferences / referencesChecked) : null;
  const exactBindingRatio = evidenceArtifacts.length ? validExactBindings / evidenceArtifacts.length : null;
  const structuralReadiness: CompilerReadinessState = !sources.length
    ? "not-ready"
    : changedSinceIngest.length || segmented !== sources.length || structures.length !== sources.length || observationErrors.length
      ? "not-ready"
      : "ready";
  const evidenceReadiness: CompilerReadinessState = evidenceArtifacts.length === 0
    ? "unknown"
    : evidenceErrors.length || invalidAssertions
      ? "not-ready"
      : validExactBindings === evidenceArtifacts.length
        ? "ready"
        : "unknown";
  const semanticReadiness: CompilerReadinessState = events.length < 20
    ? "unknown"
    : semanticIssues.length
      ? "not-ready"
      : "ready";
  const runtimeRatios = [
    openingReaderSetup,
    openingPhysicalPresence,
    openingActionability,
    autonomousDriverCoverage,
  ];
  const runtimeReadiness: CompilerReadinessState = !initialWorld
    ? "not-ready"
    : narrativeGraphNavigable === false || graph.cycles.length > 0 || graph.missing.length > 0
      ? "not-ready"
      : runtimeRatios.some((value) => value === 0)
        ? "not-ready"
        : runtimeRatios.every((value) => value === 1)
          ? "ready"
          : "unknown";
  const accountingReadiness: CompilerReadinessState = !sources.length || structures.length !== sources.length
    ? "unknown"
    : unaccountedUnits > 0
      ? "unknown"
      : blockingUnits > 0
        ? "not-ready"
        : "ready";
  const resolutionReadiness: CompilerReadinessState = entityMentions + eventMentions === 0
    ? "unknown"
    : pendingResolutions || missingResolutions || ambiguousMentions || unresolvedMentions || resolutionErrors.length
      || pendingEventResolutions || missingEventResolutions || ambiguousEventMentions || unresolvedEventMentions
      || eventResolutionErrors.length
      ? "not-ready"
      : resolvedMentions + newEntityMentions === entityMentions
        && resolvedEventMentions + newEventMentions === eventMentions
        ? "ready"
        : "not-ready";
  const readinessStates = {
    structural: structuralReadiness,
    evidence: evidenceReadiness,
    accounting: accountingReadiness,
    resolution: resolutionReadiness,
    semantic: semanticReadiness,
    runtime: runtimeReadiness,
  };
  const unknownDimensions = Object.entries(readinessStates)
    .filter(([, state]) => state === "unknown")
    .map(([name]) => name);
  const publicationReadiness: CompilerReadinessState = Object.values(readinessStates)
    .every((state) => state === "ready")
    ? "ready"
    : "not-ready";
  const readinessBlockingIssues = [
    ...changedSinceIngest.map((sourceId) => `Source ${sourceId} changed or failed immutable-source verification.`),
    ...evidenceErrors.map((error) => `${error.artifact}: ${error.code}: ${error.message}`),
    ...observationErrors.map((error) => `${error.observation}: ${error.code}: ${error.message}`),
    ...resolutionErrors.map((error) => `Identity resolution ${error.sourceId}: ${error.message}`),
    ...missingResolutionMentionIds.map((mentionId) => `Entity mention ${mentionId} has no current identity-resolution record.`),
    ...eventResolutionErrors.map((error) => `Event resolution ${error.sourceId}: ${error.message}`),
    ...missingEventResolutionMentionIds.map((mentionId) => `Event mention ${mentionId} has no current event-resolution record.`),
    ...graph.cycles.map((cycle) => `Causal cycle: ${cycle.join(" -> ")}`),
    ...graph.missing.map(({ eventId, parentId }) => `Event ${eventId} has missing causal parent ${parentId}.`),
    ...graph.temporalRegressions.map(({ eventId, parentId }) => `Event ${eventId} is earlier than causal parent ${parentId}.`),
    ...(narrativeGraphNavigable === false ? ["The canonical event graph is not narratively navigable."] : []),
    ...semanticIssues,
  ];

  return {
    version: 1,
    sources: { registered: sources.length, segmented, segments: segmentCount, changedSinceIngest },
    proposals: { pending: pending.length, accepted: accepted.length, rejected: rejected.length, pendingByKind },
    observations: {
      structuredSources: structures.length,
      structuralUnits,
      baseUnits,
      entityMentions,
      eventMentions,
      quotations,
      discourseSegments,
      pendingAnnotations,
      accountedUnits,
      unaccountedUnits,
      blockingUnits,
      invalidAnchors: invalidObservationAnchors,
      unitCoverage: baseUnits ? accountedUnits / baseUnits : null,
      byteCoverage: observationBytes ? accountedObservationBytes / observationBytes : null,
      statusCounts: accountingStatusCounts,
      errors: observationErrors,
    },
    resolutions: {
      entityMentions,
      resolved: resolvedMentions,
      newEntities: newEntityMentions,
      ambiguous: ambiguousMentions,
      unresolved: unresolvedMentions,
      missing: missingResolutions,
      pending: pendingResolutions,
      invalid: invalidResolutionIds.size,
      missingMentionIds: [...new Set(missingResolutionMentionIds)].sort(),
      errors: resolutionErrors,
    },
    eventResolutions: {
      eventMentions,
      majorEventMentions,
      resolved: resolvedEventMentions,
      newEvents: newEventMentions,
      ambiguous: ambiguousEventMentions,
      unresolved: unresolvedEventMentions,
      missing: missingEventResolutions,
      pending: pendingEventResolutions,
      majorResolved: majorResolvedEventMentions,
      majorIncomplete: majorIncompleteEventMentions,
      invalid: invalidEventResolutionIds.size,
      missingMentionIds: [...new Set(missingEventResolutionMentionIds)].sort(),
      errors: eventResolutionErrors,
    },
    canonical: {
      entities: entities.length,
      propositions: propositions.length,
      attributions: attributions.length,
      claims: claims.length,
      events: events.length,
      rules: rules.length,
      initialWorld: Boolean(initialWorld),
      characterGoals: goals.length,
      characterModels: models.length,
      possibilities: possibilities.length,
      autonomousWorldDrivers,
    },
    evidence: {
      artifactsChecked: evidenceArtifacts.length,
      referencesChecked,
      invalidReferences,
      validBindingRatio,
      assertionsChecked,
      artifactsWithExactEvidence,
      invalidAssertions,
      exactBindingRatio,
      errors: evidenceErrors,
    },
    consistency: {
      causalGraphValid: events.length ? graph.cycles.length === 0 && graph.missing.length === 0 && graph.temporalRegressions.length === 0 : null,
      narrativeGraphNavigable,
      causalCycles: graph.cycles,
      missingCausalParents: graph.missing,
      temporalRegressions: graph.temporalRegressions,
      causalComponents: graph.components.length,
      largestCausalComponent: Math.max(0, ...graph.components.map((component) => component.length)),
      unconditionalRootEvents: graph.unconditionalRoots,
      semanticReady: events.length >= 20 ? semanticIssues.length === 0 : null,
      semanticIssues,
    },
    semanticRepairTargets: {
      eventIds: [...semanticRepairEventIds],
      characterIds: semanticRepairCharacterIds,
      initialWorld: semanticRepairInitialWorld,
      requiresFullReparse: semanticRepairRequiresFullReparse,
    },
    coverage: {
      sourceIndexing,
      evidenceBinding: validBindingRatio,
      sourceAccounting: baseUnits ? accountedUnits / baseUnits : null,
      temporalConsistency: events.length ? (graph.cycles.length || graph.temporalRegressions.length ? 0 : 1) : null,
      stateDeltaExplicitness: events.length ? eventsWithExplicitDelta / events.length : null,
      causalityConsistency: events.length ? (graph.cycles.length || graph.missing.length || narrativeGraphNavigable === false ? 0 : 1) : null,
      entityResolution: entityMentions
        ? Math.min(1, (resolvedMentions + newEntityMentions) / entityMentions)
        : null,
      majorEventResolution: majorEventMentions
        ? Math.min(1, majorResolvedEventMentions / majorEventMentions)
        : null,
      epistemicCoverage: propositions.length
        ? new Set(attributions.map((attribution) => attribution.propositionId)).size / propositions.length
        : null,
      timelineAnchoring,
      eventEffectExplicitness,
      characterDevelopmentCoverage,
      openingCheckpointDeclared: initialWorld ? (initialWorld.checkpoint ? 1 : 0) : null,
      participantPresenceCoverage,
      readerSummaryCoverage,
      characterEntryCheckpointCoverage,
      openingReaderSetup,
      openingPhysicalPresence,
      openingActionability,
      autonomousDriverCoverage,
    },
    readiness: {
      policyVersion: "baseline-v1",
      ...readinessStates,
      publication: publicationReadiness,
      unknownDimensions,
      blockingIssues: readinessBlockingIssues,
    },
    notes: [
      ...(options.sourceId ? [`Audit is scoped to source ${options.sourceId}; unrelated registered sources and artifacts are excluded.`] : []),
      "Null coverage values are intentional: the compiler does not have a trustworthy denominator for those dimensions yet.",
      "Readiness states distinguish ready, not-ready, and unknown; unknown required dimensions prevent publication readiness.",
      "Canonical artifact counts are inventory, not full-book semantic coverage.",
      ...(narrativeGraphNavigable === false
        ? ["The canonical event graph is dominated by unconditional disconnected roots; recurring characters alone are not enough to make later canon active at the opening."]
        : []),
      ...(semanticIssues.length ? ["Novel-scale semantic readiness failed; structural validity alone is insufficient for publication."] : []),
      "Source indexing measures indexed source bytes and may be below 1 when blank-only gaps are intentionally omitted.",
    ],
  };
}

function formatRatio(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function earliestEvidenceLine(event: CanonicalEvent): number {
  return Math.min(
    ...event.evidence.map((reference) => reference.span.startLine),
    Number.MAX_SAFE_INTEGER,
  );
}

function auditCausalGraph(events: readonly CanonicalEvent[]): {
  cycles: string[][];
  missing: Array<{ eventId: string; parentId: string }>;
  temporalRegressions: Array<{ eventId: string; parentId: string }>;
  components: string[][];
  unconditionalRoots: string[];
} {
  const byId = new Map(events.map((event) => [event.id, event]));
  const missing: Array<{ eventId: string; parentId: string }> = [];
  for (const event of events) {
    for (const parentId of event.causalParents) if (!byId.has(parentId)) missing.push({ eventId: event.id, parentId });
  }
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string) => {
    if (active.has(id)) {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    stack.push(id);
    for (const parent of byId.get(id)?.causalParents ?? []) if (byId.has(parent)) visit(parent);
    stack.pop();
    active.delete(id);
  };
  for (const event of events) visit(event.id);
  const temporalRegressions: Array<{ eventId: string; parentId: string }> = [];
  for (const event of events) {
    for (const parentId of event.causalParents) {
      const parent = byId.get(parentId);
      if (parent && storyTimeDefinitelyBefore(event.storyTime, parent.storyTime)) temporalRegressions.push({ eventId: event.id, parentId });
    }
  }
  const adjacency = new Map(events.map((event) => [event.id, new Set<string>()]));
  for (const event of events) {
    for (const parentId of event.causalParents) {
      if (!byId.has(parentId)) continue;
      adjacency.get(event.id)!.add(parentId);
      adjacency.get(parentId)!.add(event.id);
    }
  }
  const components: string[][] = [];
  const assigned = new Set<string>();
  for (const eventId of [...byId.keys()].sort()) {
    if (assigned.has(eventId)) continue;
    const component: string[] = [];
    const pending = [eventId];
    assigned.add(eventId);
    while (pending.length) {
      const current = pending.pop()!;
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (assigned.has(neighbor)) continue;
        assigned.add(neighbor);
        pending.push(neighbor);
      }
    }
    components.push(component.sort());
  }
  const unconditionalRoots = events
    .filter((event) => event.causalParents.length === 0 && event.preconditions.length === 0)
    .map((event) => event.id)
    .sort();
  return { cycles, missing, temporalRegressions, components, unconditionalRoots };
}

function graphNavigable(
  events: readonly CanonicalEvent[],
  graph: ReturnType<typeof auditCausalGraph>,
): boolean {
  if (events.length <= 8) return true;
  const rootLimit = Math.max(8, Math.ceil(events.length * 0.4));
  const largest = Math.max(0, ...graph.components.map((component) => component.length));
  return graph.unconditionalRoots.length <= rootLimit || largest / events.length >= 0.6;
}

function storyTimeDefinitelyBefore(left: StoryTime, right: StoryTime): boolean {
  const comparable = (value: StoryTime): { scale: "year" | "ordinal"; min: number; max: number } | undefined => {
    if (value.kind === "ordinal" && typeof value.orderHint === "number") return { scale: "ordinal", min: value.orderHint, max: value.orderHint };
    const values = value.kind === "exact" ? [value.value] : value.kind === "range" ? [value.earliest, value.latest] : [];
    const years = values.flatMap((entry) => [...entry.matchAll(/(?:^|\D)(\d{3,4})(?:s)?(?=\D|$)/g)].map((match) => Number(match[1])));
    return years.length ? { scale: "year", min: Math.min(...years), max: Math.max(...years.map((year) => year + 9)) } : undefined;
  };
  const leftRange = comparable(left);
  const rightRange = comparable(right);
  return Boolean(leftRange && rightRange && leftRange.scale === rightRange.scale && leftRange.max < rightRange.min);
}

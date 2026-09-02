import { ActorModelStore, characterGoalHasDevelopmentBoundary, characterModelSchema } from "../world/actors.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { InitialWorldStore, initialWorldSchema, validateInitialWorldEvidenceAssertions } from "../world/initial.js";
import type { CanonicalEvent, ControlledWorldRule, EvidenceRef, Predicate, StoryTime } from "../world/model.js";
import { SegmentStore } from "./segments.js";
import { EvidenceVerifier } from "./evidence.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { assertEvidenceExclusiveToSource } from "../world/source-scope.js";
import { PossibilityTemplateStore } from "../world/possibility-model.js";
import { hasExecutablePossibilityEffect } from "./semantics.js";
import { canonicalJson, contentHash } from "../world/canonical.js";
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
import {
  validateCommittedAttributionTrace,
  validateCommittedKnowledgeAcquisitionTrace,
} from "./attribution-trace.js";
import { findKnowledgeDeltas, validateKnowledgeSemanticReferences } from "../world/knowledge-semantics.js";
import { validateEventParticipationCatalog } from "../world/event-semantics.js";
import { eventRelationProjectsLegacyCausalParent, validateEventRelationCatalog } from "../world/event-relations.js";
import {
  CHARACTER_ONTOLOGY_VERSION,
  characterOntologyEvidence,
  validateCharacterOntologyEvidenceAssertions,
  validateCharacterOntologyReferences,
} from "../world/character-ontology.js";
import {
  RELATIONSHIP_ONTOLOGY_VERSION,
  relationshipTypeIdSchema,
  validateRelationshipOntologyEvidenceAssertions,
  validateRelationshipOntologyReferences,
} from "../world/relationship-ontology.js";
import {
  SPATIAL_ONTOLOGY_VERSION,
  spatialEndpoints,
  spatialRelationEvidence,
  validateSpatialEvidenceAssertions,
  validateSpatialRelationCatalog,
} from "../world/spatial-ontology.js";
import {
  WORLD_RULE_ONTOLOGY_VERSION,
  validateWorldRuleCatalog,
  validateWorldRuleEvidenceAssertions,
  worldRuleEvidence,
} from "../world/world-rule-ontology.js";
import { compareStoryTime } from "../world/time.js";
import { isNovelScaleCompilation } from "./scale.js";
import { validateSceneOccurrenceCatalog } from "../world/scene-occurrence.js";
import { validateEventFrameInstance } from "../world/event-frame.js";
import { resolveActionInvocation, validateActionSchemaCatalog } from "../world/action-ontology.js";
import {
  ACTION_CONSTRAINT_ONTOLOGY_VERSION,
  validateActionConstraintCatalog,
} from "../world/action-constraint.js";
import { NORM_ONTOLOGY_VERSION, validateNormTemplateCatalog } from "../world/norm-ontology.js";
import { PROCESS_ONTOLOGY_VERSION, validateProcessTemplateCatalog } from "../world/process-ontology.js";

export type CompilerReadinessState = "ready" | "not-ready" | "unknown";
export { NOVEL_SCALE_EVENT_THRESHOLD } from "./scale.js";

export type CompilerAuditReport = {
  version: 1;
  sources: {
    registered: number;
    segmented: number;
    segments: number;
    bytes: number;
    changedSinceIngest: string[];
  };
  proposals: {
    pending: number;
    accepted: number;
    rejected: number;
    rejectionsWithDiagnostics: number;
    rejectionsMissingDiagnostics: number;
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
    nonReferential: number;
    misidentified: number;
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
    nonReferential: number;
    missing: number;
    pending: number;
    majorResolved: number;
    majorNonReferential: number;
    majorIncomplete: number;
    invalid: number;
    missingMentionIds: string[];
    errors: Array<{ sourceId: string; message: string }>;
  };
  epistemic: {
    propositions: number;
    attributions: number;
    quotationLinkedAttributions: number;
    knowledgeOperations: number;
    semanticKnowledgeOperations: number;
    acquisitionModes: Record<string, number>;
    invalidTraces: number;
    errors: Array<{ sourceId: string; artifact: string; message: string }>;
  };
  eventSemantics: {
    participations: number;
    eventsWithTypedParticipation: number;
    legacyParticipantSlots: number;
    typedParticipantSlots: number;
    validationIssues: number;
    errors: Array<{ code: string; message: string; path?: string }>;
    relations: number;
    temporalRelations: number;
    causalRelations: number;
    narrativeContinuations: number;
    legacyCausalEdges: number;
    typedCausalEdges: number;
    relationValidationIssues: number;
    relationErrors: Array<{ code: string; message: string; path?: string }>;
    sceneOccurrences: number;
    eventFrames: number;
    framedEvents: number;
    actionSchemas: number;
    schemaBoundEvents: number;
    adHocEvents: number;
    sceneValidationIssues: number;
    frameValidationIssues: number;
    actionValidationIssues: number;
    executableSemanticErrors: Array<{ code: string; message: string; path?: string }>;
  };
  characterSemantics: {
    ontologyVersion: typeof CHARACTER_ONTOLOGY_VERSION;
    controlledModels: number;
    legacyModels: number;
    dispositions: number;
    supportedDispositions: number;
    contestedDispositions: number;
    stableDispositions: number;
    appraisalEpisodes: number;
    contestedAppraisals: number;
    developmentEpisodes: number;
    contestedDevelopmentEpisodes: number;
    referenceValidationIssues: number;
    errors: Array<{ actorId: string; code: string; message: string; path?: string }>;
  };
  relationshipSemantics: {
    ontologyVersion: typeof RELATIONSHIP_ONTOLOGY_VERSION;
    relationshipEntities: number;
    directedEntities: number;
    typedEntities: number;
    legacyStateOperations: number;
    controlledModels: number;
    stances: number;
    supportedStances: number;
    contestedStances: number;
    stableStances: number;
    obligations: number;
    contestedObligations: number;
    changeEpisodes: number;
    contestedChanges: number;
    referenceValidationIssues: number;
    errors: Array<{ actorId: string; code: string; message: string; path?: string }>;
  };
  spatialSemantics: {
    ontologyVersion: typeof SPATIAL_ONTOLOGY_VERSION;
    relations: number;
    containment: number;
    adjacency: number;
    routes: number;
    oneWayRoutes: number;
    timedRoutes: number;
    eventGated: number;
    stateGated: number;
    contested: number;
    publicRelations: number;
    observableRelations: number;
    knowledgeRelations: number;
    engineRelations: number;
    locationsInTopology: number;
    referenceValidationIssues: number;
    errors: Array<{ code: string; message: string; path?: string }>;
  };
  worldRuleSemantics: {
    ontologyVersion: typeof WORLD_RULE_ONTOLOGY_VERSION;
    rules: number;
    controlledRules: number;
    legacyRules: number;
    supportedRules: number;
    contestedRules: number;
    kinds: Record<string, number>;
    scopes: Record<string, number>;
    clauses: number;
    requireClauses: number;
    forbidClauses: number;
    contestedClauses: number;
    exceptions: number;
    contestedExceptions: number;
    defeasibleRules: number;
    overrideEdges: number;
    authorityRules: number;
    boundedJurisdictionRules: number;
    publicRules: number;
    observableRules: number;
    knowledgeRules: number;
    engineRules: number;
    potentialConflicts: Array<{
      requiringRuleId: string;
      forbiddingRuleId: string;
      predicate: Predicate;
      resolvedByRuleId?: string;
    }>;
    unresolvedPotentialConflicts: number;
    referenceValidationIssues: number;
    exactEvidenceIssues: number;
    errors: Array<{ code: string; message: string; path?: string }>;
  };
  executablePolicySemantics: {
    actionConstraintOntologyVersion: typeof ACTION_CONSTRAINT_ONTOLOGY_VERSION;
    normOntologyVersion: typeof NORM_ONTOLOGY_VERSION;
    processOntologyVersion: typeof PROCESS_ONTOLOGY_VERSION;
    actionConstraints: number;
    normTemplates: number;
    processTemplates: number;
    sourceInduced: number;
    domainModules: number;
    contested: number;
    validationIssues: number;
    errors: Array<{ code: string; message: string; path?: string }>;
  };
  canonical: {
    entities: number;
    propositions: number;
    attributions: number;
    claims: number;
    events: number;
    eventParticipations: number;
    eventRelations: number;
    sceneOccurrences: number;
    eventFrames: number;
    actionSchemas: number;
    actionConstraints: number;
    normTemplates: number;
    processTemplates: number;
    spatialRelations: number;
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
    ruleIds: string[];
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
    typedEventParticipation: number | null;
    typedCausalRelations: number | null;
    timelineAnchoring: number | null;
    eventEffectExplicitness: number | null;
    controlledCharacterModels: number | null;
    directedRelationshipEntities: number | null;
    typedRelationshipEntities: number | null;
    locationsWithSpatialTopology: number | null;
    controlledWorldRules: number | null;
    characterDevelopmentCoverage: number | null;
    openingCheckpointDeclared: number | null;
    participantPresenceCoverage: number | null;
    readerSummaryCoverage: number | null;
    characterEntryCheckpointCoverage: number | null;
    openingReaderSetup: number | null;
    openingReaderContext: number | null;
    openingActorObservation: number | null;
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
  let nonReferentialMentions = 0;
  let misidentifiedMentions = 0;
  let missingResolutions = 0;
  let pendingResolutions = 0;
  const missingResolutionMentionIds: string[] = [];
  const invalidResolutionIds = new Set<string>();
  const resolutionErrors: CompilerAuditReport["resolutions"]["errors"] = [];
  let resolvedEventMentions = 0;
  let newEventMentions = 0;
  let ambiguousEventMentions = 0;
  let unresolvedEventMentions = 0;
  let nonReferentialEventMentions = 0;
  let missingEventResolutions = 0;
  let pendingEventResolutions = 0;
  let majorEventMentions = 0;
  let majorResolvedEventMentions = 0;
  let majorNonReferentialEventMentions = 0;
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
    nonReferentialMentions += resolutionCoverage.nonReferential;
    misidentifiedMentions += resolutionCoverage.misidentified;
    missingResolutions += resolutionCoverage.missing;
    pendingResolutions += resolutionCoverage.pending;
    missingResolutionMentionIds.push(...resolutionCoverage.missingMentionIds);
    for (const resolutionId of resolutionCoverage.invalidResolutionIds) invalidResolutionIds.add(resolutionId);
    resolutionErrors.push(...resolutionCoverage.errors.map((message) => ({ sourceId: source.id, message })));
    resolvedEventMentions += eventResolutionCoverage.resolved;
    newEventMentions += eventResolutionCoverage.newEvents;
    ambiguousEventMentions += eventResolutionCoverage.ambiguous;
    unresolvedEventMentions += eventResolutionCoverage.unresolved;
    nonReferentialEventMentions += eventResolutionCoverage.nonReferential;
    missingEventResolutions += eventResolutionCoverage.missing;
    pendingEventResolutions += eventResolutionCoverage.pending;
    majorEventMentions += eventResolutionCoverage.majorEventMentions;
    majorResolvedEventMentions += eventResolutionCoverage.majorResolved;
    majorNonReferentialEventMentions += eventResolutionCoverage.majorNonReferential;
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
  const [pending, accepted, rejected, rejectionReports] = await Promise.all([
    proposalStore.list("pending", options.sourceId),
    proposalStore.list("accepted", options.sourceId),
    proposalStore.list("rejected", options.sourceId),
    proposalStore.listRejections(),
  ]);
  const rejectedIds = new Set(rejected.map((proposal) => proposal.id));
  const rejectionsWithDiagnostics = rejectionReports.filter((report) => rejectedIds.has(report.proposalId)).length;
  const pendingByKind: Record<string, number> = {};
  for (const proposal of pending) pendingByKind[proposal.kind] = (pendingByKind[proposal.kind] ?? 0) + 1;

  const canon = new CanonicalModelStore(workspaceRoot);
  const actorStore = new ActorModelStore(workspaceRoot);
  const [allEntities, allPropositions, allAttributions, allClaims, allEvents, allEventParticipations, allEventRelations, allSceneOccurrences, allEventFrames, allActionSchemas, allActionConstraints, allNormTemplates, allProcessTemplates, allSpatialRelations, allRules, storedInitialWorld, allGoals, allModels, allPossibilities] = await Promise.all([
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
    new InitialWorldStore(workspaceRoot).get(),
    actorStore.listGoals(),
    actorStore.listModels(),
    new PossibilityTemplateStore(workspaceRoot).list(),
  ]);
  const artifactEvidence = (item: { evidence: readonly EvidenceRef[]; counterEvidence?: readonly EvidenceRef[] }) =>
    [...item.evidence, ...(item.counterEvidence ?? [])];
  const belongsToSelectedSource = (item: { evidence: readonly EvidenceRef[]; counterEvidence?: readonly EvidenceRef[] }) => {
    if (!options.sourceId) return true;
    const evidence = artifactEvidence(item);
    const matches = evidence.some((reference) => reference.span.sourceId === options.sourceId);
    if (matches) assertEvidenceExclusiveToSource(evidence, options.sourceId, "Audited compiler artifact");
    return matches;
  };
  const entities = allEntities.filter(belongsToSelectedSource);
  const propositions = allPropositions.filter(belongsToSelectedSource);
  const attributions = allAttributions.filter(belongsToSelectedSource);
  const claims = allClaims.filter(belongsToSelectedSource);
  const events = allEvents.filter(belongsToSelectedSource);
  const eventParticipations = allEventParticipations.filter(belongsToSelectedSource);
  const eventRelations = allEventRelations.filter(belongsToSelectedSource);
  const sceneOccurrences = allSceneOccurrences.filter(belongsToSelectedSource);
  const eventFrames = allEventFrames.filter(belongsToSelectedSource);
  const actionSchemas = allActionSchemas.filter((item) => item.induction.kind === "domain-module" || belongsToSelectedSource(item));
  const actionConstraints = allActionConstraints.filter((item) => item.induction.kind === "domain-module" || belongsToSelectedSource(item));
  const normTemplates = allNormTemplates.filter((item) => item.induction.kind === "domain-module" || belongsToSelectedSource(item));
  const processTemplates = allProcessTemplates.filter((item) => item.induction.kind === "domain-module" || belongsToSelectedSource(item));
  const spatialRelations = allSpatialRelations.filter((item) => belongsToSelectedSource({
    evidence: item.evidence,
    counterEvidence: item.counterEvidence,
  }));
  const rules = allRules.filter((item) => belongsToSelectedSource({ evidence: worldRuleEvidence(item) }));
  const initialWorld = storedInitialWorld && belongsToSelectedSource(storedInitialWorld) ? storedInitialWorld : null;
  const goals = allGoals.filter(belongsToSelectedSource);
  const models = allModels.filter((model) => belongsToSelectedSource({
    evidence: [...model.evidence, ...characterOntologyEvidence(model)],
  }));
  const possibilities = allPossibilities.filter(belongsToSelectedSource);

  const evidenceArtifacts: Array<{ name: string; kind: string; id: string; payload: unknown; evidence: EvidenceRef[] }> = [
    ...entities.map((item) => ({ name: `entity:${item.id}`, kind: "entity", id: item.id, payload: item, evidence: item.evidence })),
    ...propositions.map((item) => ({ name: `proposition:${item.id}`, kind: "proposition", id: item.id, payload: item, evidence: item.evidence })),
    ...attributions.map((item) => ({ name: `attribution:${item.id}`, kind: "attribution", id: item.id, payload: item, evidence: item.evidence })),
    ...claims.map((item) => ({ name: `claim:${item.id}`, kind: "claim", id: item.id, payload: item, evidence: item.evidence })),
    ...events.map((item) => ({ name: `event:${item.id}`, kind: "canonical-event", id: item.id, payload: item, evidence: item.evidence })),
    ...eventParticipations.map((item) => ({ name: `event-participation:${item.id}`, kind: "event-participation", id: item.id, payload: item, evidence: item.evidence })),
    ...eventRelations.map((item) => ({ name: `event-relation:${item.id}`, kind: "event-relation", id: item.id, payload: item, evidence: artifactEvidence(item) })),
    ...sceneOccurrences.map((item) => ({ name: `scene-occurrence:${item.id}`, kind: "scene-occurrence", id: item.id, payload: item, evidence: item.evidence })),
    ...eventFrames.map((item) => ({ name: `event-frame:${item.id}`, kind: "event-frame", id: item.id, payload: item, evidence: item.evidence })),
    ...actionSchemas.filter((item) => item.induction.kind === "source-pattern").map((item) => ({ name: `action-schema:${item.id}`, kind: "action-schema", id: item.id, payload: item, evidence: item.evidence })),
    ...actionConstraints.filter((item) => item.induction.kind === "source-pattern").map((item) => ({ name: `action-constraint:${item.id}`, kind: "action-constraint", id: item.id, payload: item, evidence: item.evidence })),
    ...normTemplates.filter((item) => item.induction.kind === "source-pattern").map((item) => ({ name: `norm-template:${item.id}`, kind: "norm-template", id: item.id, payload: item, evidence: item.evidence })),
    ...processTemplates.filter((item) => item.induction.kind === "source-pattern").map((item) => ({ name: `process-template:${item.id}`, kind: "process-template", id: item.id, payload: item, evidence: item.evidence })),
    ...spatialRelations.map((item) => ({ name: `spatial-relation:${item.id}`, kind: "spatial-relation", id: item.id, payload: item, evidence: spatialRelationEvidence(item) })),
    ...rules.map((item) => ({ name: `rule:${item.id}`, kind: "world-rule", id: item.id, payload: item, evidence: worldRuleEvidence(item) })),
    ...(initialWorld ? [{ name: "initial-world", kind: "initial-world", id: "initial-world", payload: initialWorld, evidence: initialWorld.evidence }] : []),
    ...goals.map((item) => ({ name: `goal:${item.id}`, kind: "character-goal", id: item.id, payload: item, evidence: item.evidence })),
    ...models.map((item) => ({ name: `model:${item.actorId}`, kind: "character-model", id: item.actorId, payload: item, evidence: [...item.evidence, ...characterOntologyEvidence(item)] })),
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
  let worldRuleExactEvidenceIssues = 0;
  for (const artifact of evidenceArtifacts) {
    referencesChecked += artifact.evidence.length;
    const result = await evidenceVerifier.verifyAll(artifact.evidence);
    invalidReferences += result.issues.length;
    for (const issue of result.issues) evidenceErrors.push({ artifact: artifact.name, code: issue.code, message: issue.message });
    const binding = await exactEvidence.bindingForArtifact(artifact.kind, artifact.id);
    if (!binding?.assertions.length) {
      if (artifact.kind === "initial-world") {
        const parsedInitialWorld = initialWorldSchema.parse(artifact.payload);
        if (parsedInitialWorld.readerContext || parsedInitialWorld.actorObservations?.length) {
          invalidAssertions += 1;
          evidenceErrors.push({
            artifact: artifact.name,
            code: "MISSING_EXACT_OPENING_CONTEXT_BINDING",
            message: "Structured unread-reader context and Genesis actor observations require exact field-level evidence.",
          });
        }
      }
      if (artifact.kind === "character-model"
        && (characterModelSchema.parse(artifact.payload).ontologyVersion === CHARACTER_ONTOLOGY_VERSION
          || characterModelSchema.parse(artifact.payload).relationshipOntologyVersion === RELATIONSHIP_ONTOLOGY_VERSION)) {
        invalidAssertions += 1;
        evidenceErrors.push({
          artifact: artifact.name,
          code: "MISSING_EXACT_CHARACTER_POLICY_BINDING",
          message: `Controlled character/relationship model ${artifact.id} has no exact evidence binding.`,
        });
      }
      if (artifact.kind === "spatial-relation") {
        invalidAssertions += 1;
        evidenceErrors.push({
          artifact: artifact.name,
          code: "MISSING_EXACT_SPATIAL_BINDING",
          message: `Spatial relation ${artifact.id} has no exact evidence binding.`,
        });
      }
      if (artifact.kind === "world-rule") {
        invalidAssertions += 1;
        worldRuleExactEvidenceIssues += 1;
        evidenceErrors.push({
          artifact: artifact.name,
          code: "MISSING_EXACT_WORLD_RULE_BINDING",
          message: `Controlled world rule ${artifact.id} has no exact evidence binding.`,
        });
      }
      continue;
    }
    artifactsWithExactEvidence += 1;
    assertionsChecked += binding.assertions.length;
    const exactIssues = [
      ...validateEvidenceAssertionTargets(artifact.kind, artifact.id, artifact.payload, binding.assertions),
      ...(artifact.kind === "character-model"
        ? validateCharacterOntologyEvidenceAssertions(
            characterModelSchema.parse(artifact.payload),
            binding.assertions,
          )
        : []),
      ...(artifact.kind === "spatial-relation"
        ? validateSpatialEvidenceAssertions(
            spatialRelations.find((relation) => relation.id === artifact.id)!,
            binding.assertions,
          )
        : []),
      ...(artifact.kind === "character-model"
        ? validateRelationshipOntologyEvidenceAssertions(
            characterModelSchema.parse(artifact.payload),
            binding.assertions,
          )
        : []),
      ...(artifact.kind === "world-rule"
        ? validateWorldRuleEvidenceAssertions(
            rules.find((rule) => rule.id === artifact.id)!,
            binding.assertions,
          )
        : []),
      ...(artifact.kind === "initial-world"
        ? validateInitialWorldEvidenceAssertions(initialWorldSchema.parse(artifact.payload), binding.assertions)
        : []),
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
    if (artifact.kind === "world-rule") worldRuleExactEvidenceIssues += exactIssues.length;
    for (const issue of exactIssues) evidenceErrors.push({ artifact: artifact.name, code: issue.code, message: issue.message });
    if (!exactIssues.length) validExactBindings += 1;
  }

  const epistemicErrors: CompilerAuditReport["epistemic"]["errors"] = [];
  const acquisitionModes: Record<string, number> = {};
  let knowledgeOperations = 0;
  let semanticKnowledgeOperations = 0;
  const semanticCatalog = {
    claims: new Map(claims.map((claim) => [claim.id, claim])),
    propositions: new Map(propositions.map((proposition) => [proposition.id, proposition])),
    attributions: new Map(attributions.map((attribution) => [attribution.id, attribution])),
  };
  const locatedKnowledge = evidenceArtifacts.flatMap((artifact) => {
    const sourceId = artifact.evidence[0]?.span.sourceId;
    if (!sourceId) return [];
    return findKnowledgeDeltas(artifact.payload).map((located) => ({
      sourceId,
      artifact: artifact.name,
      path: `${artifact.name}.${located.path || "payload"}`,
      delta: located.delta,
    }));
  });
  for (const located of locatedKnowledge) {
    for (let index = 0; index < located.delta.operations.length; index += 1) {
      const operation = located.delta.operations[index]!;
      knowledgeOperations += 1;
      for (const semanticIssue of validateKnowledgeSemanticReferences(
        operation,
        semanticCatalog,
        `${located.path}.operations.${index}`,
      )) {
        epistemicErrors.push({
          sourceId: located.sourceId,
          artifact: located.artifact,
          message: `${semanticIssue.code}${semanticIssue.path ? ` at ${semanticIssue.path}` : ""}: ${semanticIssue.message}`,
        });
      }
      if (!operation.propositionId) continue;
      semanticKnowledgeOperations += 1;
      if (operation.op === "learn" && operation.acquisitionMode) {
        acquisitionModes[operation.acquisitionMode] = (acquisitionModes[operation.acquisitionMode] ?? 0) + 1;
      }
    }
  }
  for (const source of sources) {
    for (const attribution of attributions.filter((item) =>
      item.evidence.some((reference) => reference.span.sourceId === source.id))) {
      for (const message of await validateCommittedAttributionTrace(workspaceRoot, source.id, attribution)) {
        epistemicErrors.push({ sourceId: source.id, artifact: `attribution:${attribution.id}`, message });
      }
    }
    const sourceKnowledge = locatedKnowledge
      .filter((located) => located.sourceId === source.id)
      .map(({ path, delta }) => ({ path, delta }));
    for (const message of await validateCommittedKnowledgeAcquisitionTrace(workspaceRoot, source.id, sourceKnowledge)) {
      epistemicErrors.push({ sourceId: source.id, artifact: "knowledge", message });
    }
  }

  const participationValidation = validateEventParticipationCatalog({
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    events: new Map(events.map((event) => [event.id, event])),
    participations: eventParticipations,
  });
  const eventIds = new Set(events.map((event) => event.id));
  const eventsWithTypedParticipation = new Set(eventParticipations
    .filter((item) => eventIds.has(item.eventId))
    .map((item) => item.eventId));
  const legacyParticipantKeys = new Set(events.flatMap((event) =>
    [...new Set(event.participants)].map((entityId) => `${event.id}:${entityId}`)));
  const typedParticipantKeys = new Set(eventParticipations
    .map((item) => `${item.eventId}:${item.entityId}`)
    .filter((key) => legacyParticipantKeys.has(key)));
  const legacyParticipantSlots = legacyParticipantKeys.size;
  const typedParticipantSlots = typedParticipantKeys.size;
  const typedEventParticipation = legacyParticipantSlots
    ? Math.min(1, typedParticipantSlots / legacyParticipantSlots)
    : null;
  const relationValidation = validateEventRelationCatalog({
    events: new Map(events.map((event) => [event.id, event])),
    relations: eventRelations,
  });
  const legacyCausalKeys = new Set(events.flatMap((event) =>
    [...new Set(event.causalParents)].map((parentId) => `${parentId}:${event.id}`)));
  const typedCausalKeys = new Set(eventRelations
    .filter(eventRelationProjectsLegacyCausalParent)
    .map((relation) => `${relation.fromEventId}:${relation.toEventId}`)
    .filter((key) => legacyCausalKeys.has(key)));
  const typedCausalRelations = legacyCausalKeys.size
    ? typedCausalKeys.size / legacyCausalKeys.size
    : null;
  const entityCatalog = new Map(entities.map((entity) => [entity.id, entity]));
  const eventCatalog = new Map(events.map((event) => [event.id, event]));
  const eventFrameCatalog = new Map(eventFrames.map((frame) => [frame.id, frame]));
  const actionSchemaCatalog = new Map(actionSchemas.map((schema) => [schema.id, schema]));
  const sceneValidation = validateSceneOccurrenceCatalog({
    entities: entityCatalog,
    events: eventCatalog,
    scenes: sceneOccurrences,
  });
  const frameValidation = events.flatMap((event) => {
    if (!event.frameInstance) return [];
    const frame = eventFrameCatalog.get(event.frameInstance.frameId);
    return frame
      ? validateEventFrameInstance(event.frameInstance, frame, entityCatalog, event)
      : [{ code: "UNKNOWN_EVENT_FRAME", message: `Event ${event.id} references unknown frame ${event.frameInstance.frameId}`, path: `events.${event.id}.frameInstance.frameId` }];
  });
  const actionValidation = [
    ...actionSchemas.flatMap((schema) => validateActionSchemaCatalog(schema, entityCatalog, new Set(eventCatalog.keys()))),
    ...events.flatMap((event) => event.action
      ? resolveActionInvocation(event.action, actionSchemaCatalog, entityCatalog, {
          participants: event.participants,
          proposedDelta: event.observedOutcome,
          hasKnowledge: Boolean(event.observedKnowledge?.operations.length),
          hasTimeAdvance: Boolean(event.timeAdvance),
          hasSceneTransition: false,
        }).issues
      : []),
  ];
  const executableSemanticValidation = [...sceneValidation, ...frameValidation, ...actionValidation];
  const executablePolicyValidation = [
    ...validateActionConstraintCatalog(actionConstraints, {
      entities: entityCatalog,
      actionSchemas: actionSchemaCatalog,
    }),
    ...validateNormTemplateCatalog(normTemplates, {
      entities: entityCatalog,
      claimIds: new Set(claims.map((claim) => claim.id)),
      canonicalEventIds: new Set(eventCatalog.keys()),
    }),
    ...validateProcessTemplateCatalog(processTemplates, new Set(eventCatalog.keys())),
  ];
  const spatialValidation = validateSpatialRelationCatalog(spatialRelations, {
    entities: entityCatalog,
    events: eventCatalog,
    claims: new Set(claims.map((claim) => claim.id)),
    rules: new Set(rules.map((rule) => rule.id)),
  });
  const locationEntities = entities.filter((entity) => entity.kind === "location");
  const locationIds = new Set(locationEntities.map((entity) => entity.id));
  const locationsInTopology = new Set(spatialRelations
    .flatMap(spatialEndpoints)
    .filter((entityId) => locationIds.has(entityId))).size;
  const locationsWithSpatialTopology = locationEntities.length
    ? locationsInTopology / locationEntities.length
    : null;
  const worldRuleValidation = validateWorldRuleCatalog(rules, {
    entities: new Map(entities.map((entity) => [entity.id, { kind: entity.kind }])),
    events: new Map(events.map((event) => [event.id, event])),
    claims: new Set(claims.map((claim) => claim.id)),
    rules: new Map(rules.map((rule) => [rule.id, rule])),
  });
  const controlledWorldRules = rules;
  const controlledWorldRuleCoverage = rules.length
    ? controlledWorldRules.length / rules.length
    : null;
  const worldRuleClauses = controlledWorldRules.flatMap((rule) => rule.clauses);
  const worldRuleExceptions = controlledWorldRules.flatMap((rule) => rule.exceptions);
  const worldRuleKinds = countValues(controlledWorldRules.map((rule) => rule.kind));
  const worldRuleScopes = countValues(controlledWorldRules.map((rule) => rule.scope));
  const potentialWorldRuleConflicts = findPotentialWorldRuleConflicts(controlledWorldRules);
  const characterOntologyCatalog = {
    entities: new Map(entities.map((entity) => [entity.id, { kind: entity.kind }])),
    propositions: new Set(propositions.map((proposition) => proposition.id)),
    claims: new Set(claims.map((claim) => claim.id)),
    events: new Map(events.map((event) => [event.id, {
      participants: event.participants,
      participantPresence: event.participantPresence,
    }])),
    goals: new Map(goals.map((goal) => [goal.id, { actorId: goal.actorId }])),
  };
  const characterOntologyValidation = models.flatMap((model) => [
    ...(entities.find((entity) => entity.id === model.actorId)?.kind === "character"
      ? []
      : [{
          code: "INVALID_MODEL_ACTOR",
          message: `Character model actor ${model.actorId} is not a canonical character`,
          path: "actorId",
        }]),
    ...validateCharacterOntologyReferences(model, characterOntologyCatalog),
  ].map((error) => ({ actorId: model.actorId, ...error })));
  const relationshipOntologyValidation = models.flatMap((model) =>
    validateRelationshipOntologyReferences(model, characterOntologyCatalog)
      .map((error) => ({ actorId: model.actorId, ...error })));
  const controlledCharacterModels = models.filter((model) =>
    model.ontologyVersion === CHARACTER_ONTOLOGY_VERSION).length;
  const controlledCharacterModelCoverage = models.length
    ? controlledCharacterModels / models.length
    : null;
  const dispositions = models.flatMap((model) => model.dispositions ?? []);
  const appraisalEpisodes = models.flatMap((model) => model.appraisalEpisodes ?? []);
  const developmentEpisodes = models.flatMap((model) => model.developmentEpisodes ?? []);
  const controlledRelationshipModels = models.filter((model) =>
    model.relationshipOntologyVersion === RELATIONSHIP_ONTOLOGY_VERSION).length;
  const relationshipStances = models.flatMap((model) => model.relationshipStances ?? []);
  const relationshipObligations = models.flatMap((model) => model.relationshipObligations ?? []);
  const relationshipChanges = models.flatMap((model) => model.relationshipChanges ?? []);
  const relationshipEntities = entities.filter((entity) => entity.kind === "relationship");
  const relationshipEntityIds = new Set(relationshipEntities.map((entity) => entity.id));
  const canonicalStateOperations = [
    ...(initialWorld?.delta.operations ?? []),
    ...events.flatMap((event) => [
      ...event.observedOutcome.operations,
      ...(event.characterEntryCheckpoints ?? []).flatMap((checkpoint) => checkpoint.delta.operations),
    ]),
  ];
  const relationshipOperations = canonicalStateOperations.filter((operation) =>
    "entityId" in operation && relationshipEntityIds.has(operation.entityId));
  const relationshipIdsWithField = (field: string) => new Set(relationshipOperations.flatMap((operation) =>
    "field" in operation && operation.op === "set" && operation.field === field
      ? [operation.entityId]
      : []));
  const fromRelationshipIds = relationshipIdsWithField("relationship.from");
  const toRelationshipIds = relationshipIdsWithField("relationship.to");
  const directedRelationshipEntities = relationshipEntities.filter((entity) =>
    fromRelationshipIds.has(entity.id) && toRelationshipIds.has(entity.id)).length;
  const typedRelationshipEntities = new Set(relationshipOperations.flatMap((operation) =>
    "field" in operation
      && operation.op === "set"
      && operation.field === "relationship.type"
      && relationshipTypeIdSchema.safeParse(operation.value).success
      ? [operation.entityId]
      : [])).size;
  const legacyRelationshipStateOperations = relationshipOperations.filter((operation) =>
    "field" in operation && [
      "relationship.kind",
      "relationship.strength",
      "relationship.obligations",
    ].includes(operation.field)).length;
  const directedRelationshipCoverage = relationshipEntities.length
    ? directedRelationshipEntities / relationshipEntities.length
    : null;
  const typedRelationshipCoverage = relationshipEntities.length
    ? typedRelationshipEntities / relationshipEntities.length
    : null;

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
    ...models.filter((model) =>
      (model.developmentPhases?.length ?? 0) > 0
      || (model.developmentEpisodes?.length ?? 0) > 0).map((model) => model.actorId),
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
  const openingReaderContext = initialWorld
    ? (initialWorld.readerContext ? 1 : 0)
    : null;
  const openingPhysicalPresence = initialWorld
    ? (physicalOpeningActorIds.size ? 1 : 0)
    : null;
  const openingObservationActorIds = new Set(initialWorld?.actorObservations?.map((observation) => observation.actorId) ?? []);
  const openingActorObservation = initialWorld
    ? (physicalOpeningActorIds.size > 0
        && [...physicalOpeningActorIds].every((actorId) => openingObservationActorIds.has(actorId)) ? 1 : 0)
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
  const semanticRepairRuleIds = new Set<string>();
  let semanticRepairInitialWorld = false;
  let semanticRepairRequiresFullReparse = worldRuleValidation.length > 0 || executablePolicyValidation.length > 0;
  const novelScale = isNovelScaleCompilation(sourceBytes, events.length);
  for (const issue of worldRuleValidation) {
    const index = issue.path?.match(/^worldRules\.(\d+)(?:\.|$)/u)?.[1];
    const rule = index === undefined ? undefined : rules[Number(index)];
    if (rule) semanticRepairRuleIds.add(rule.id);
  }
  if (worldRuleValidation.length && semanticRepairRuleIds.size === 0) {
    rules.forEach((rule) => semanticRepairRuleIds.add(rule.id));
  }
  // Small fixtures and short stories may intentionally be sparse. The hard
  // semantic gate targets novel-scale compilations where omissions compound.
  if (novelScale) {
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
      semanticIssues.push(`Only ${formatRatio(characterDevelopmentCoverage)} of recurring characters have phase-bounded goals or evidence-grounded development episodes (minimum 50%).`);
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
    if (legacyParticipantSlots && (typedEventParticipation ?? 0) < 0.8) {
      semanticIssues.push(`Only ${formatRatio(typedEventParticipation)} of canonical event participant slots have typed semantic roles (minimum 80%).`);
      events.filter((event) => !eventsWithTypedParticipation.has(event.id))
        .forEach((event) => semanticRepairEventIds.add(event.id));
    }
    if (legacyCausalKeys.size && typedCausalRelations !== 1) {
      semanticIssues.push(`Only ${formatRatio(typedCausalRelations)} of legacy causal-parent edges have independently evidenced causes/enables relations (required 100%).`);
      events.filter((event) => event.causalParents.some((parentId) => !typedCausalKeys.has(`${parentId}:${event.id}`)))
        .forEach((event) => semanticRepairEventIds.add(event.id));
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
    if (initialWorld && openingReaderContext !== 1) {
      semanticIssues.push("The initial world has no structured unread-reader context for first-use identities, causal premises, actor stance, and the unresolved opening situation.");
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
    if (initialWorld && openingActorObservation !== 1) {
      semanticIssues.push("One or more physically present opening characters lack a direct-perception Genesis observation.");
      semanticRepairInitialWorld = true;
    }
    if (autonomousWorldDrivers === 0) {
      semanticIssues.push("The compiled world has no executable actor goal or non-canonical autonomous possibility, so divergence can only wait for canon or repeat local dialogue.");
      semanticRepairRequiresFullReparse = true;
    }
    if (models.length && controlledCharacterModelCoverage !== 1) {
      semanticIssues.push(`Only ${formatRatio(controlledCharacterModelCoverage)} of character models use the controlled ${CHARACTER_ONTOLOGY_VERSION} vocabulary (required 100% for novel-scale publication).`);
      semanticRepairCharacterIds.push(...models
        .filter((model) => model.ontologyVersion !== CHARACTER_ONTOLOGY_VERSION)
        .map((model) => model.actorId));
    }
    if (relationshipEntities.length && directedRelationshipCoverage !== 1) {
      semanticIssues.push(`Only ${formatRatio(directedRelationshipCoverage)} of relationship entities have explicit directed from/to state (required 100%).`);
      semanticRepairRequiresFullReparse = true;
    }
    if (relationshipEntities.length && typedRelationshipCoverage !== 1) {
      semanticIssues.push(`Only ${formatRatio(typedRelationshipCoverage)} of relationship entities use controlled relationship.type (required 100%).`);
      semanticRepairRequiresFullReparse = true;
    }
    if (legacyRelationshipStateOperations) {
      semanticIssues.push(`${legacyRelationshipStateOperations} legacy relationship.kind/strength/obligations state operation(s) remain; migrate new semantics to relationship.type plus ${RELATIONSHIP_ONTOLOGY_VERSION} policy records.`);
      semanticRepairRequiresFullReparse = true;
    }
    if (rules.length && controlledWorldRuleCoverage !== 1) {
      semanticIssues.push(`Only ${formatRatio(controlledWorldRuleCoverage)} of world rules use the controlled ${WORLD_RULE_ONTOLOGY_VERSION} vocabulary (required 100% for novel-scale publication).`);
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
  const semanticReadiness: CompilerReadinessState = epistemicErrors.length
    || participationValidation.length
    || relationValidation.length
    || executableSemanticValidation.length
    || executablePolicyValidation.length
    || spatialValidation.length
    || worldRuleValidation.length
    || characterOntologyValidation.length
    || relationshipOntologyValidation.length
    ? "not-ready"
    : !novelScale
    ? "unknown"
    : semanticIssues.length
      ? "not-ready"
      : "ready";
  const runtimeRatios = [
    openingReaderSetup,
    openingPhysicalPresence,
    openingActionability,
    autonomousDriverCoverage,
    ...(novelScale ? [openingReaderContext, openingActorObservation] : []),
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
      : resolvedMentions + newEntityMentions + nonReferentialMentions + misidentifiedMentions === entityMentions
        && resolvedEventMentions + newEventMentions + nonReferentialEventMentions === eventMentions
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
    ...epistemicErrors.map((error) => `${error.artifact}: ${error.message}`),
    ...participationValidation.map((error) => `Event participation ${error.code}: ${error.message}`),
    ...relationValidation.map((error) => `Event relation ${error.code}: ${error.message}`),
    ...executableSemanticValidation.map((error) => `Executable event semantics ${error.code}: ${error.message}`),
    ...executablePolicyValidation.map((error) =>
      `Executable policy ${error.code}${error.path ? ` at ${error.path}` : ""}: ${error.message}`),
    ...worldRuleValidation.map((error) =>
      `World rule ${error.code}${error.path ? ` at ${error.path}` : ""}: ${error.message}`),
    ...characterOntologyValidation.map((error) =>
      `Character model ${error.actorId} ${error.code}${error.path ? ` at ${error.path}` : ""}: ${error.message}`),
    ...relationshipOntologyValidation.map((error) =>
      `Relationship model ${error.actorId} ${error.code}${error.path ? ` at ${error.path}` : ""}: ${error.message}`),
    ...graph.cycles.map((cycle) => `Causal cycle: ${cycle.join(" -> ")}`),
    ...graph.missing.map(({ eventId, parentId }) => `Event ${eventId} has missing causal parent ${parentId}.`),
    ...graph.temporalRegressions.map(({ eventId, parentId }) => `Event ${eventId} is earlier than causal parent ${parentId}.`),
    ...(narrativeGraphNavigable === false ? ["The canonical event graph is not narratively navigable."] : []),
    ...semanticIssues,
  ];

  return {
    version: 1,
    sources: { registered: sources.length, segmented, segments: segmentCount, bytes: sourceBytes, changedSinceIngest },
    proposals: {
      pending: pending.length,
      accepted: accepted.length,
      rejected: rejected.length,
      rejectionsWithDiagnostics,
      rejectionsMissingDiagnostics: rejected.length - rejectionsWithDiagnostics,
      pendingByKind,
    },
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
      nonReferential: nonReferentialMentions,
      misidentified: misidentifiedMentions,
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
      nonReferential: nonReferentialEventMentions,
      missing: missingEventResolutions,
      pending: pendingEventResolutions,
      majorResolved: majorResolvedEventMentions,
      majorNonReferential: majorNonReferentialEventMentions,
      majorIncomplete: majorIncompleteEventMentions,
      invalid: invalidEventResolutionIds.size,
      missingMentionIds: [...new Set(missingEventResolutionMentionIds)].sort(),
      errors: eventResolutionErrors,
    },
    epistemic: {
      propositions: propositions.length,
      attributions: attributions.length,
      quotationLinkedAttributions: attributions.filter((attribution) => attribution.quotationIds?.length).length,
      knowledgeOperations,
      semanticKnowledgeOperations,
      acquisitionModes,
      invalidTraces: epistemicErrors.length,
      errors: epistemicErrors,
    },
    eventSemantics: {
      participations: eventParticipations.length,
      eventsWithTypedParticipation: eventsWithTypedParticipation.size,
      legacyParticipantSlots,
      typedParticipantSlots,
      validationIssues: participationValidation.length,
      errors: participationValidation,
      relations: eventRelations.length,
      temporalRelations: eventRelations.filter((item) => ["before", "after", "during", "contains", "overlaps", "starts", "finishes"].includes(item.type)).length,
      causalRelations: eventRelations.filter((item) => ["causes", "enables", "prevents", "motivates", "explains"].includes(item.type)).length,
      narrativeContinuations: eventRelations.filter((item) => item.type === "narrative-continuation").length,
      legacyCausalEdges: legacyCausalKeys.size,
      typedCausalEdges: typedCausalKeys.size,
      relationValidationIssues: relationValidation.length,
      relationErrors: relationValidation,
      sceneOccurrences: sceneOccurrences.length,
      eventFrames: eventFrames.length,
      framedEvents: events.filter((event) => event.frameInstance !== undefined).length,
      actionSchemas: actionSchemas.length,
      schemaBoundEvents: events.filter((event) => event.action?.lane === "schema-bound").length,
      adHocEvents: events.filter((event) => event.action?.lane === "ad-hoc").length,
      sceneValidationIssues: sceneValidation.length,
      frameValidationIssues: frameValidation.length,
      actionValidationIssues: actionValidation.length,
      executableSemanticErrors: executableSemanticValidation,
    },
    characterSemantics: {
      ontologyVersion: CHARACTER_ONTOLOGY_VERSION,
      controlledModels: controlledCharacterModels,
      legacyModels: models.length - controlledCharacterModels,
      dispositions: dispositions.length,
      supportedDispositions: dispositions.filter((item) => item.status === "supported").length,
      contestedDispositions: dispositions.filter((item) => item.status === "contested").length,
      stableDispositions: dispositions.filter((item) => item.stability === "stable").length,
      appraisalEpisodes: appraisalEpisodes.length,
      contestedAppraisals: appraisalEpisodes.filter((item) => item.status === "contested").length,
      developmentEpisodes: developmentEpisodes.length,
      contestedDevelopmentEpisodes: developmentEpisodes.filter((item) => item.evidenceStatus === "contested").length,
      referenceValidationIssues: characterOntologyValidation.length,
      errors: characterOntologyValidation,
    },
    relationshipSemantics: {
      ontologyVersion: RELATIONSHIP_ONTOLOGY_VERSION,
      relationshipEntities: relationshipEntities.length,
      directedEntities: directedRelationshipEntities,
      typedEntities: typedRelationshipEntities,
      legacyStateOperations: legacyRelationshipStateOperations,
      controlledModels: controlledRelationshipModels,
      stances: relationshipStances.length,
      supportedStances: relationshipStances.filter((item) => item.status === "supported").length,
      contestedStances: relationshipStances.filter((item) => item.status === "contested").length,
      stableStances: relationshipStances.filter((item) => item.stability === "stable").length,
      obligations: relationshipObligations.length,
      contestedObligations: relationshipObligations.filter((item) => item.status === "contested").length,
      changeEpisodes: relationshipChanges.length,
      contestedChanges: relationshipChanges.filter((item) => item.evidenceStatus === "contested").length,
      referenceValidationIssues: relationshipOntologyValidation.length,
      errors: relationshipOntologyValidation,
    },
    spatialSemantics: {
      ontologyVersion: SPATIAL_ONTOLOGY_VERSION,
      relations: spatialRelations.length,
      containment: spatialRelations.filter((item) => item.kind === "contains").length,
      adjacency: spatialRelations.filter((item) => item.kind === "adjacent").length,
      routes: spatialRelations.filter((item) => item.kind === "route").length,
      oneWayRoutes: spatialRelations.filter((item) => item.kind === "route" && item.direction === "one-way").length,
      timedRoutes: spatialRelations.filter((item) => item.kind === "route" && item.duration !== undefined).length,
      eventGated: spatialRelations.filter((item) => item.establishedByEventIds.length > 0 || item.retiredByEventIds.length > 0).length,
      stateGated: spatialRelations.filter((item) => item.requires.length > 0 || item.blockedWhen.length > 0).length,
      contested: spatialRelations.filter((item) => item.status === "contested").length,
      publicRelations: spatialRelations.filter((item) => item.visibility === "public").length,
      observableRelations: spatialRelations.filter((item) => item.visibility === "observable").length,
      knowledgeRelations: spatialRelations.filter((item) => item.visibility === "knowledge").length,
      engineRelations: spatialRelations.filter((item) => item.visibility === "engine").length,
      locationsInTopology,
      referenceValidationIssues: spatialValidation.length,
      errors: spatialValidation,
    },
    worldRuleSemantics: {
      ontologyVersion: WORLD_RULE_ONTOLOGY_VERSION,
      rules: rules.length,
      controlledRules: controlledWorldRules.length,
      legacyRules: rules.length - controlledWorldRules.length,
      supportedRules: controlledWorldRules.filter((rule) => rule.status === "supported").length,
      contestedRules: controlledWorldRules.filter((rule) => rule.status === "contested").length,
      kinds: worldRuleKinds,
      scopes: worldRuleScopes,
      clauses: worldRuleClauses.length,
      requireClauses: worldRuleClauses.filter((clause) => clause.modality === "require").length,
      forbidClauses: worldRuleClauses.filter((clause) => clause.modality === "forbid").length,
      contestedClauses: worldRuleClauses.filter((clause) => clause.status === "contested").length,
      exceptions: worldRuleExceptions.length,
      contestedExceptions: worldRuleExceptions.filter((exception) => exception.status === "contested").length,
      defeasibleRules: controlledWorldRules.filter((rule) => rule.defeasible).length,
      overrideEdges: controlledWorldRules.reduce((count, rule) => count + rule.overridesRuleIds.length, 0),
      authorityRules: controlledWorldRules.filter((rule) => rule.authorityEntityId !== undefined).length,
      boundedJurisdictionRules: controlledWorldRules.filter((rule) =>
        rule.scope !== "global" && rule.jurisdictionEntityIds.length > 0).length,
      publicRules: controlledWorldRules.filter((rule) => rule.visibility === "public").length,
      observableRules: controlledWorldRules.filter((rule) => rule.visibility === "observable").length,
      knowledgeRules: controlledWorldRules.filter((rule) => rule.visibility === "knowledge").length,
      engineRules: controlledWorldRules.filter((rule) => rule.visibility === "engine").length,
      potentialConflicts: potentialWorldRuleConflicts,
      unresolvedPotentialConflicts: potentialWorldRuleConflicts.filter((conflict) =>
        conflict.resolvedByRuleId === undefined).length,
      referenceValidationIssues: worldRuleValidation.length,
      exactEvidenceIssues: worldRuleExactEvidenceIssues,
      errors: worldRuleValidation,
    },
    executablePolicySemantics: {
      actionConstraintOntologyVersion: ACTION_CONSTRAINT_ONTOLOGY_VERSION,
      normOntologyVersion: NORM_ONTOLOGY_VERSION,
      processOntologyVersion: PROCESS_ONTOLOGY_VERSION,
      actionConstraints: actionConstraints.length,
      normTemplates: normTemplates.length,
      processTemplates: processTemplates.length,
      sourceInduced: [...actionConstraints, ...normTemplates, ...processTemplates]
        .filter((item) => item.induction.kind === "source-pattern").length,
      domainModules: [...actionConstraints, ...normTemplates, ...processTemplates]
        .filter((item) => item.induction.kind === "domain-module").length,
      contested: [...actionConstraints, ...normTemplates]
        .filter((item) => item.status === "contested").length,
      validationIssues: executablePolicyValidation.length,
      errors: executablePolicyValidation,
    },
    canonical: {
      entities: entities.length,
      propositions: propositions.length,
      attributions: attributions.length,
      claims: claims.length,
      events: events.length,
      eventParticipations: eventParticipations.length,
      eventRelations: eventRelations.length,
      sceneOccurrences: sceneOccurrences.length,
      eventFrames: eventFrames.length,
      actionSchemas: actionSchemas.length,
      actionConstraints: actionConstraints.length,
      normTemplates: normTemplates.length,
      processTemplates: processTemplates.length,
      spatialRelations: spatialRelations.length,
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
      semanticReady: novelScale
        ? semanticIssues.length === 0
          && participationValidation.length === 0
          && relationValidation.length === 0
          && executableSemanticValidation.length === 0
          && executablePolicyValidation.length === 0
          && spatialValidation.length === 0
          && worldRuleValidation.length === 0
          && characterOntologyValidation.length === 0
          && relationshipOntologyValidation.length === 0
        : null,
      semanticIssues,
    },
    semanticRepairTargets: {
      eventIds: [...semanticRepairEventIds],
      characterIds: [...new Set(semanticRepairCharacterIds)],
      ruleIds: [...semanticRepairRuleIds].sort(),
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
        ? Math.min(1, (resolvedMentions + newEntityMentions + nonReferentialMentions + misidentifiedMentions) / entityMentions)
        : null,
      majorEventResolution: majorEventMentions
        ? Math.min(1, (majorResolvedEventMentions + majorNonReferentialEventMentions) / majorEventMentions)
        : null,
      epistemicCoverage: propositions.length
        ? new Set(attributions.map((attribution) => attribution.propositionId)).size / propositions.length
        : null,
      typedEventParticipation,
      typedCausalRelations,
      timelineAnchoring,
      eventEffectExplicitness,
      controlledCharacterModels: controlledCharacterModelCoverage,
      directedRelationshipEntities: directedRelationshipCoverage,
      typedRelationshipEntities: typedRelationshipCoverage,
      locationsWithSpatialTopology,
      controlledWorldRules: controlledWorldRuleCoverage,
      characterDevelopmentCoverage,
      openingCheckpointDeclared: initialWorld ? (initialWorld.checkpoint ? 1 : 0) : null,
      participantPresenceCoverage,
      readerSummaryCoverage,
      characterEntryCheckpointCoverage,
      openingReaderSetup,
      openingReaderContext,
      openingActorObservation,
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
      ...(potentialWorldRuleConflicts.some((conflict) => conflict.resolvedByRuleId === undefined)
        ? ["Potential cross-rule require/forbid conflicts are diagnostic: only an explicit valid override resolves them, while uncertain co-applicability does not by itself fail readiness."]
        : []),
      "Source indexing measures indexed source bytes and may be below 1 when blank-only gaps are intentionally omitted.",
    ],
  };
}

function countValues(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function findPotentialWorldRuleConflicts(
  rules: readonly ControlledWorldRule[],
): CompilerAuditReport["worldRuleSemantics"]["potentialConflicts"] {
  const supported = rules.filter((rule) => rule.status === "supported");
  const conflicts = new Map<string, CompilerAuditReport["worldRuleSemantics"]["potentialConflicts"][number]>();
  for (let leftIndex = 0; leftIndex < supported.length; leftIndex += 1) {
    const left = supported[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < supported.length; rightIndex += 1) {
      const right = supported[rightIndex]!;
      if (!worldRulesCouldOverlap(left, right)) continue;
      const leftClauses = left.clauses.filter((clause) => clause.status === "supported");
      const rightClauses = right.clauses.filter((clause) => clause.status === "supported");
      for (const leftClause of leftClauses) {
        for (const rightClause of rightClauses) {
          if (leftClause.modality === rightClause.modality
            || canonicalJson(leftClause.predicate) !== canonicalJson(rightClause.predicate)) continue;
          const requiringRule = leftClause.modality === "require" ? left : right;
          const forbiddingRule = leftClause.modality === "forbid" ? left : right;
          const resolvedByRuleId = validExplicitOverride(requiringRule, forbiddingRule)
            ? requiringRule.id
            : validExplicitOverride(forbiddingRule, requiringRule)
              ? forbiddingRule.id
              : undefined;
          const key = `${requiringRule.id}\u0000${forbiddingRule.id}\u0000${canonicalJson(leftClause.predicate)}`;
          conflicts.set(key, {
            requiringRuleId: requiringRule.id,
            forbiddingRuleId: forbiddingRule.id,
            predicate: structuredClone(leftClause.predicate),
            ...(resolvedByRuleId ? { resolvedByRuleId } : {}),
          });
        }
      }
    }
  }
  return [...conflicts.values()].sort((left, right) =>
    left.requiringRuleId.localeCompare(right.requiringRuleId)
    || left.forbiddingRuleId.localeCompare(right.forbiddingRuleId)
    || canonicalJson(left.predicate).localeCompare(canonicalJson(right.predicate)));
}

function worldRulesCouldOverlap(left: ControlledWorldRule, right: ControlledWorldRule): boolean {
  // Distinct jurisdictions are not enough to prove mutual exclusion: one actor
  // may simultaneously be subject to location, faction, and institution rules.
  // Suppress a diagnostic only when concrete temporal scopes cannot overlap.
  if (left.validStoryTime && right.validStoryTime) {
    const order = compareStoryTime(left.validStoryTime, right.validStoryTime);
    if (order === -1 || order === 1) return false;
  }
  return true;
}

function validExplicitOverride(
  overriding: ControlledWorldRule,
  target: ControlledWorldRule,
): boolean {
  return overriding.overridesRuleIds.includes(target.id)
    && target.defeasible
    && overriding.priority > target.priority;
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

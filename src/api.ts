export { auditCompiler, type CompilerAuditReport, type CompilerReadinessState } from "./compiler/audit.js";
export { prepareCompilerBatches, runCompilerBatches, CompilerBatchStore, type CompilerBatch } from "./compiler/batches.js";
export { BoundaryCalibrationStore, type BoundaryCalibrationRequest } from "./compiler/boundary-calibration.js";
export { ChapterSplitPlanStore, buildChapterStructureSample, chapterHeadingRuleSchema, chapterSplitPlanSchema, type ChapterHeadingRule, type ChapterSplitPlan, type ChapterStructureSample } from "./compiler/chapter-split.js";
export {
  convergeWorldProposals,
  quarantineInvalidResolutionBindings,
  quarantineUncommittableProposals,
  type WorldConvergenceProgress,
  type WorldProposalConvergence,
} from "./compiler/converge.js";
export { EvidenceVerifier, type EvidenceInspection, type EvidenceVerification } from "./compiler/evidence.js";
export { EvidenceAssertionStore, evidenceAssertionSourceIds, validateEvidenceAssertionTargets } from "./compiler/evidence-assertions.js";
export { jsonPointerExists, modelEvidenceSelectorSchema, modelEvidenceSelectorsSchema, modelTextSelectorSchema, resolveTextAnchor, resolveTextSelectorAnchor, textAnchorForByteRange, type ModelEvidenceSelector, type ModelTextSelector } from "./compiler/text-anchors.js";
export {
  SOURCE_ANNOTATION_ONTOLOGY_VERSION,
  SourceAnnotationStore,
  annotationAnchors,
  annotationReferenceIds,
  discourseObservationSchema,
  entityMentionSchema,
  eventMentionSchema,
  eventMentionTypeSchema,
  quotationSchema,
  sourceAnnotationDerivationSchema,
  sourceAnnotationProposalSchema,
  sourceAnnotationSchema,
  sourceAnnotationTypeSchema,
  validateSourceAnnotationClosure,
  type DiscourseObservation,
  type EntityMention,
  type EventMention,
  type EventMentionType,
  type Quotation,
  type SourceAnnotation,
  type SourceAnnotationDerivation,
  type SourceAnnotationProposal,
  type SourceAnnotationProposalStatus,
  type SourceAnnotationProposalSummary,
  type SourceAnnotationType,
} from "./compiler/annotations.js";
export {
  ENTITY_RESOLUTION_ONTOLOGY_VERSION,
  EntityResolutionStore,
  generateEntityResolutionCandidates,
  identityResolutionCandidateSchema,
  identityResolutionProposalSchema,
  identityResolutionSchema,
  inspectEntityResolutionCoverage,
  validateCommittedEntityResolutionTrace,
  validateEntityProposalResolutionTrace,
  validateIdentityResolutionClosure,
  type EntityResolutionCoverage,
  type IdentityResolution,
  type IdentityResolutionCandidate,
  type IdentityResolutionProposal,
  type IdentityResolutionProposalStatus,
  type IdentityResolutionProposalSummary,
  type LexicalEntityResolutionCandidate,
} from "./compiler/entity-resolution.js";
export {
  EVENT_RESOLUTION_ONTOLOGY_VERSION,
  EventResolutionStore,
  eventResolutionCandidateSchema,
  eventResolutionProposalSchema,
  eventResolutionRelationSchema,
  eventResolutionSchema,
  generateEventResolutionCandidates,
  inspectEventResolutionCoverage,
  validateCommittedEventResolutionTrace,
  validateEventProposalResolutionTrace,
  validateEventResolutionClosure,
  type DeterministicEventResolutionCandidate,
  type EventResolution,
  type EventResolutionCandidate,
  type EventResolutionCoverage,
  type EventResolutionProposal,
  type EventResolutionProposalStatus,
  type EventResolutionProposalSummary,
  type EventResolutionRelation,
} from "./compiler/event-resolution.js";
export {
  STRUCTURE_VERSION,
  SourceStructureStore,
  baseStructuralUnits,
  discourseSegmentSchema,
  ensureSourceStructure,
  materializeSourceStructure,
  structuralUnitKindSchema,
  structuralUnitSchema,
  type DiscourseSegment,
  type SourceStructureManifest,
  type StructuralUnit,
  type StructuralUnitKind,
} from "./compiler/structure.js";
export {
  SourceAccountingStore,
  sourceAccountingRecordSchema,
  sourceAccountingStatusSchema,
  type SourceAccountingManifest,
  type SourceAccountingRecord,
  type SourceAccountingStatus,
  type SourceAccountingSummary,
} from "./compiler/source-accounting.js";
export { PossibilityCommitService, type PossibilityValidation } from "./compiler/possibility-commit.js";
export { PreparedNovelCache, type PreparedCacheResult, type PreparedCacheRevision, type PreparedNovelBundle } from "./compiler/prepared-cache.js";
export { buildWorldReconciliationPrompt, semanticRepairIsIsolated } from "./compiler/reconcile-world.js";
export {
  backfillLegacyProposalRejectionDiagnostics,
  recoverLegacyCompilerState,
  type LegacyArtifactRepair,
  type LegacyCompilerRecoveryOptions,
  type LegacyCompilerRecoveryPlan,
  type LegacyCompilerRecoveryResult,
  type LegacyInitialWorldRepair,
  type LegacyRecoverySkip,
} from "./compiler/legacy-recovery.js";
export { compilerProposalArtifactId, CompilerProposalService, type CompilerProposalKind } from "./compiler/proposals.js";
export {
  validateAttributionProposalTrace,
  validateCommittedAttributionTrace,
  validateCommittedKnowledgeAcquisitionTrace,
  validateKnowledgeAcquisitionProposalTrace,
} from "./compiler/attribution-trace.js";
export { CompilerCommitService, CompilerValidator, type CompilerConvergenceProgress, type CompilerValidation } from "./compiler/validator.js";
export {
  evaluateCompilerAgainstGold,
  compilerGoldSchema,
  compilerSemanticGoldSchema,
  type CompilerEvaluationReport,
  type CompilerGold,
  type CompilerSemanticGold,
  type SemanticEvaluationStatus,
  type SemanticLayerMetric,
  type SemanticLayerName,
  type SetMetric,
} from "./eval/compiler-eval.js";
export { inspectPreparation, type PreparationInspection, type PreparationStage } from "./workflow/prepare.js";
export { ingestWorkspaceContent, ingestWorkspaceSource } from "./commands/ingest.js";
export { readSourceMaterial, sourceMaterialIdentity, SourceMaterialStore, type SourceMaterialIdentity } from "./storage/source-material-store.js";
export { sourceTitleInferenceSchema, sourceTitleProposalSchema, type SourceTitleInference, type SourceTitleProposal } from "./storage/novel-title.js";
export { WorkspaceStore, type SourceDocument, type StoredProject } from "./storage/workspace-store.js";

export { ActorModelStore, characterDevelopmentPhaseSchema, deterministicActorProposalSource, evaluateCharacterGoal, resolveCharacterModel, type CharacterDevelopmentPhase, type CharacterGoal, type CharacterModel, type EffectiveCharacterModel } from "./world/actors.js";
export { APPRAISAL_EMOTION_IDS, CHARACTER_CONTEXT_IDS, CHARACTER_DIMENSIONS, CHARACTER_DIMENSION_IDS, CHARACTER_ONTOLOGY_VERSION, appraisalEpisodeSchema, characterContextIdSchema, characterDimensionIdSchema, characterDispositionSchema, characterOntologyEvidence, developmentEpisodeSchema, legacyCharacterDimensionValues, modelVisibleCharacterOntology, resolveCharacterOntology, validateCharacterOntologyEvidenceAssertions, validateCharacterOntologyReferences, type AppraisalEpisode, type CharacterContextId, type CharacterDimensionDefinition, type CharacterDimensionId, type CharacterDisposition, type DevelopmentEpisode, type EffectiveCharacterAppraisal, type EffectiveCharacterDisposition, type EffectiveCharacterOntology, type EffectiveDevelopmentEpisode, type ModelVisibleCharacterOntology } from "./world/character-ontology.js";
export { RELATIONSHIP_OBLIGATION_TYPE_IDS, RELATIONSHIP_ONTOLOGY_VERSION, RELATIONSHIP_STANCE_DIMENSIONS, RELATIONSHIP_STANCE_DIMENSION_IDS, RELATIONSHIP_TYPE_IDS, modelVisibleRelationshipOntology, relationshipChangeEpisodeSchema, relationshipObligationSchema, relationshipOntologyEvidence, relationshipStanceDimensionIdSchema, relationshipStanceSchema, relationshipTypeIdSchema, resolveRelationshipOntology, validateRelationshipOntologyEvidenceAssertions, validateRelationshipOntologyReferences, type EffectiveRelationshipChange, type EffectiveRelationshipObligation, type EffectiveRelationshipOntology, type EffectiveRelationshipStance, type ModelVisibleRelationshipOntology, type RelationshipChangeEpisode, type RelationshipObligation, type RelationshipObligationTypeId, type RelationshipOntologyModel, type RelationshipStance, type RelationshipStanceDimensionDefinition, type RelationshipStanceDimensionId, type RelationshipTypeId } from "./world/relationship-ontology.js";
export { SPATIAL_ONTOLOGY_VERSION, SPATIAL_TRAVEL_MODE_IDS, findSpatialRoute, modelVisibleSpatialRelationSchema, modelVisibleSpatialRelations, resolveActiveSpatialRelations, spatialDurationSchema, spatialEndpoints, spatialLocationsMayOverlap, spatialRelationEvidence, spatialRelationSchema, spatialTravelModeSchema, spatialVisibilitySchema, validateActiveSpatialTopology, validateSpatialEvidenceAssertions, validateSpatialRelationCatalog, type ActiveSpatialRelation, type ModelVisibleSpatialRelation, type SpatialAdjacentRelation, type SpatialContainsRelation, type SpatialDuration, type SpatialReferenceCatalog, type SpatialRelation, type SpatialRoutePath, type SpatialRouteRelation, type SpatialTravelMode, type SpatialVisibility } from "./world/spatial-ontology.js";
export { WORLD_RULE_ONTOLOGY_VERSION, isControlledWorldRule, modelVisibleWorldRules, resolveEffectiveWorldRules, validateWorldRuleCatalog, validateWorldRuleEvidenceAssertions, worldRuleEvidence, worldRuleForbids, worldRulePredicates, worldRuleRequires, type EffectiveWorldRule, type ModelVisibleWorldRule, type WorldRuleReferenceCatalog, type WorldRuleResolution } from "./world/world-rule-ontology.js";
export { commitKnowledgeAwareAction, knowledgeAwareActionSchema, validateActionKnowledge, type ActionGateReport, type KnowledgeAwareAction } from "./world/action-gate.js";
export {
  CanonicalModelStore,
  ProposalStore,
  type CanonicalKind,
  type CanonicalRevisionRef,
  type ProposalRejectionReport,
} from "./world/canonical-model.js";
export { canonicalEventToPossibility } from "./world/canon-runtime.js";
export { loadWorldContext, pinBranchPreparationContexts, WorldContextStore, type CanonicalSnapshot, type ScopedWorldArtifacts } from "./world/context.js";
export { diffWorldBranches, diffWorldStates, type HistoryDifference, type KnowledgeDifference, type StateDifference, type WorldBranchDiff } from "./world/diff.js";
export { WorldEngine, WorldProjector, validateEventProposal, type ResolvedWorldModelContext, type WorldContextResolver, type WorldModelContext } from "./world/engine.js";
export { fsckWorld, type FsckIssue, type WorldFsckReport } from "./world/fsck.js";
export { buildFrontier, evaluatePossibility, selectEligible, type Frontier, type FrontierTemporalMode, type PossibilityStatus, type SchedulerFactors } from "./world/frontier.js";
export {
  projectCharacterDevelopment,
  type CharacterDevelopmentView,
  type CharacterLifeStage,
  type CharacterLivedExperience,
} from "./world/development.js";
export { InitialWorldStore, initialWorldSchema, openingCheckpointSchema, type InitialWorld, type OpeningCheckpoint } from "./world/initial.js";
export { createWorldBranch, type CreatedWorldBranch } from "./world/instance.js";
export {
  deriveCharacterEntryOptions,
  deriveCharacterEntrySeed,
  formatReaderEntryContext,
  readerContextForEntry,
  type CharacterEntryOption,
  type CharacterEntryPoint,
  type CharacterEntrySeed,
  type ReaderContextBeat,
  type ReaderEntryContext,
} from "./world/entry-context.js";
export { KnowledgeProjector, type ActorWorldView } from "./world/knowledge.js";
export {
  EVENT_PARTICIPATION_PROJECTION_VERSION,
  eventParticipationsByEvent,
  projectEventParticipations,
  validateEventParticipationCatalog,
  validateEventParticipationRecord,
  type EventParticipationCatalog,
} from "./world/event-semantics.js";
export {
  EVENT_RELATION_PROJECTION_VERSION,
  eventRelationProjectsLegacyCausalParent,
  eventRelationsByTarget,
  projectEventRelations,
  validateEventRelationCatalog,
  validateEventRelationRecord,
  type EventRelationCatalog,
} from "./world/event-relations.js";
export {
  claimProjectionMismatches,
  findKnowledgeDeltas,
  projectPropositionObject,
  validateKnowledgeSemanticReferences,
  type KnowledgeSemanticCatalog,
  type LocatedKnowledgeDelta,
} from "./world/knowledge-semantics.js";
export { isNarrativeInterpretation, NarrativeMetaView, type NarrativeObservation, type NarrativeMetaKind } from "./world/meta.js";
export { modelActorProposalSource, actorActionTemplateSchema, type ActorActionTemplate, type ActorReasoner, type ActorReasoningInput, type ModelActorDevelopmentView, type ModelActorDispositionView, type ModelActorGoalView, type ModelActorWorldView } from "./world/model-actor-policy.js";
export * from "./world/model.js";
export { NarrativeRenderer, type ActorNarrativeEvent, type ActorNarrativeFrame, type ActorNarrativeView, type NarrativeAdapter, type NarrativeEvent, type NarrativeFrame, type NarrativeStyle, type OmniscientNarrativeFrame } from "./world/narrative.js";
export { buildNarrativeDirection, publicNarrativeThread, publicPlayerAffordance, resolvePlayerAffordance, type ActorVisibleNarrativeThread, type NarrativeDirection, type NarrativeThreadView, type PlayerAffordance, type ResolvedPlayerAffordance } from "./world/narrative-director.js";
export { PossibilityTemplateStore, possibilityTemplateSchema, type PossibilityTemplate } from "./world/possibility-model.js";
export { buildActorScopedActionContext, createPlayerActionModelBoundary, deterministicPlayerIntentCandidate, playerActionCandidateSchema, playerActionModelCandidateSchema, playerContradictionBasisSchema, playerControlledActSchema, playerInteractionSchema, playerIntentSchema, playerIntentSceneTransitionSchema, playerIntentTargetSchema, playerActionModelContext, playerActionToKnowledgeAwareAction, playerActionTranslationContext, playerTurnInputSchema, playerWorldResolutionSchema, PlayerTurnService, validatePlayerActionGrounding, validatePlayerActionScope, validatePlayerActionSpatialScope, type ActorScopedActionContext, type PlayerActionCandidate, type PlayerActionModelBoundary, type PlayerActionTranslationContext, type PlayerActionTranslator, type PlayerContradictionBasis, type PlayerControlledAct, type PlayerInteraction, type PlayerIntent, type PlayerIntentSceneTransition, type PlayerIntentTarget, type PlayerProgressCertificate, type PlayerTurnAuthority, type PlayerTurnInput, type PlayerTurnResult, type PlayerWorldAdjudicationContext, type PlayerWorldAdjudicationInput, type PlayerWorldAdjudicator, type PlayerWorldResolution, type SafePlayerIntent } from "./world/player-action.js";
export { PlayConversationStore, modelPlayConversation, playConversationAtCommit, recentPlayConversation, type ModelPlayConversationMessage, type PlayConversationMessage } from "./world/play-conversation.js";
export { npcReactionCandidateSchema, npcReactionEmotionSchema, respondToNpcInteractions, type NpcPerceivedMessage, type NpcReactionBatchResult, type NpcReactionCandidate, type NpcReactionEmotion, type NpcReactionEvent, type NpcReactionReasoner, type NpcReactionReasoningInput, type NpcResponseKind } from "./world/npc-reaction.js";
export { createPiNpcReactionReasoner, type PiNpcReactionReasonerOptions } from "./agent/pi-npc-reaction.js";
export { createNpcReactionCaptureTool, type NpcReactionCaptureTool } from "./agent/npc-reaction-tool.js";
export { createPiPlayerWorldAdjudicator, type PiPlayerWorldAdjudicatorOptions } from "./agent/pi-player-world-adjudicator.js";
export { createPlayerWorldResolutionCaptureTool, type PlayerWorldResolutionCaptureTool } from "./agent/player-world-outcome-tool.js";
export { createPiPlayerWorldResponseResolver, type PiPlayerWorldResponseResolverOptions } from "./agent/pi-player-world-response.js";
export { createPlayerWorldResponseCaptureTool, playerWorldResponseSelectionSchema, type PlayerWorldResponseCaptureTool, type PlayerWorldResponseSelection } from "./agent/player-world-response-tool.js";
export { createPiCanonicalAttachmentResolver, type PiCanonicalAttachmentResolverOptions } from "./agent/pi-canonical-attachment.js";
export { createCanonicalAttachmentCaptureTool, type CanonicalAttachmentCaptureTool } from "./agent/canonical-attachment-tool.js";
export {
  canonicalAttachmentResolutionSchema,
  evaluateCanonicalBindingOptions,
  instantiateCanonicalScaffold,
  type CanonicalAttachmentResolution,
  type CanonicalAttachmentResolver,
  type CanonicalAttachmentResolverInput,
  type CanonicalBindingEvaluation,
  type CanonicalBindingOption,
  type CanonicalBindingOptionView,
  type InstantiatedCanonicalScaffold,
} from "./world/canonical-adaptation.js";
export { classifyPlayerInput, renderPlayerMetaResponse, type PlayerInputRoute } from "./world/player-input-route.js";
export { PlayerTurnAuditStore, type PlayerTurnAudit, type PlayerTurnOrigin } from "./world/player-turn-audit.js";
export { PlaySessionStore, activePlaySessionSchema, type ActivePlaySession } from "./world/play-session.js";
export {
  assertPlaySceneNarration,
  buildPlayOpeningFrame,
  playSceneRequestForEntry,
  playSceneChoicePrompt,
  playerSceneModelFrame,
  playScenePrompt,
  renderPlaySceneFailure,
  resolvePlayScenePurpose,
  type PlayOpeningFrame,
  type PlayerLiteraryAdvisory,
  type PlayerLiteraryStyleAnalysis,
  type PlayerNarrativePlayExcerpt,
  type PlayerNarrativeResolvedAct,
  type PlayerNarrativeSourceExcerpt,
  type PlayerSceneDramaturgyAnalysis,
  type PlayerSceneNarratorFrame,
  type PlayerTurnResolution,
  type PlayEntryIntent,
  type PlayScenePurpose,
  type PlaySceneRequest,
} from "./world/play-opening.js";
export { catalogForSource, choosePlayExperience, choosePlayInstance, choosePlayNovel, createSourcePlayInstance, resolvePlayInstance, resolvePlayNovel, type AskPlayQuestion, type PlayInstanceLifecycleEvent, type PlayInstanceMode } from "./world/play-choice.js";
export { inspectPlayExperience, listPlayableCharacters, performPlayTurn, resolveCharacter, resolveNovelSource, selectPlayExperience, type PlayExperienceCatalog, type PlayableCharacter, type PlayInstanceSummary, type PlayTurnOutcome, type SelectedPlayExperience } from "./world/play-experience.js";
export { runCanonReplay, runIsolatedCanonReplay, verifyHistoryReplay, type CanonReplayResult, type IsolatedCanonReplayResult, type ReplayDiagnostic } from "./world/replay.js";
export { committedHistory, projectActorScene, realizedCanonicalEvents, type ActorSceneProjection, type CommittedHistoryEntry, type SceneEventProjection } from "./world/scene.js";
export { WorldRuntime, adjudicateActorCandidates, playerWorldResponseResolutionSchema, type CanonicalRecoveryResult, type CanonicalRecoveryTrace, type MoveInput, type MoveResult, type PlayerWorldResponseOption, type PlayerWorldResponseResolution, type PlayerWorldResponseResolver, type PlayerWorldResponseResolverInput, type PlayerWorldResponseResult } from "./world/runtime.js";
export { WorldSnapshotStore, type WorldSnapshot } from "./world/snapshot.js";
export { StateSchemaRegistry, DEFAULT_STATE_FIELDS, advanceTemporalState, applyStateDelta, evaluatePredicate, validateEngineInvariants } from "./world/state.js";
export {
  advanceStoryTime,
  assertMonotonicLogicalTime,
  comparableStoryTime,
  compareStoryTime,
  nextLogicalTime,
  storyTimeAtOrAfter,
  storyTimeBefore,
  storyTimesOverlap,
  timeAdvanceInDays,
  type ComparableStoryTime,
} from "./world/time.js";
export { BranchStore, WorldObjectStore } from "./world/store.js";
export { openWorkspaceWorld, type WorkspaceWorld, type WorkspaceWorldOpenOptions } from "./world/workspace-runtime.js";
export { CatalogService, legacyPlaySessionId } from "./application/catalog-service.js";
export { PiModelCatalogService, type ModelCatalogReader } from "./application/model-catalog-service.js";
export * from "./web/contracts.js";
export { WebEventBroker, serializeServerSentEvent, type WebEventListener } from "./web/event-stream.js";
export { createWebHost, isLoopbackHost, type CreateWebHostOptions, type NwhWebHost } from "./web/host.js";

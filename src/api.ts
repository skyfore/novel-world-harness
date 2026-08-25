export { auditCompiler, type CompilerAuditReport, type CompilerReadinessState } from "./compiler/audit.js";
export { prepareCompilerBatches, runCompilerBatches, CompilerBatchStore, type CompilerBatch } from "./compiler/batches.js";
export { BoundaryCalibrationStore, type BoundaryCalibrationRequest } from "./compiler/boundary-calibration.js";
export { ChapterSplitPlanStore, buildChapterStructureSample, chapterHeadingRuleSchema, chapterSplitPlanSchema, type ChapterHeadingRule, type ChapterSplitPlan, type ChapterStructureSample } from "./compiler/chapter-split.js";
export { convergeWorldProposals, type WorldConvergenceProgress, type WorldProposalConvergence } from "./compiler/converge.js";
export { EvidenceVerifier, type EvidenceInspection, type EvidenceVerification } from "./compiler/evidence.js";
export { EvidenceAssertionStore, evidenceAssertionSourceIds, validateEvidenceAssertionTargets } from "./compiler/evidence-assertions.js";
export { jsonPointerExists, modelEvidenceSelectorSchema, modelEvidenceSelectorsSchema, resolveTextAnchor, textAnchorForByteRange, type ModelEvidenceSelector } from "./compiler/text-anchors.js";
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
export { compilerProposalArtifactId, CompilerProposalService, type CompilerProposalKind } from "./compiler/proposals.js";
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
export { commitKnowledgeAwareAction, knowledgeAwareActionSchema, validateActionKnowledge, type ActionGateReport, type KnowledgeAwareAction } from "./world/action-gate.js";
export { CanonicalModelStore, ProposalStore, type CanonicalKind, type CanonicalRevisionRef } from "./world/canonical-model.js";
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

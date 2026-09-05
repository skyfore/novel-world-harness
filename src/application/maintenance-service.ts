import path from "node:path";
import { ActorModelStore } from "../world/actors.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { contentHash } from "../world/canonical.js";
import { InitialWorldStore } from "../world/initial.js";
import { PlayConversationStore } from "../world/play-conversation.js";
import { PossibilityTemplateStore } from "../world/possibility-model.js";
import { removeNovel, removeNovelAnalysis, removeWorldInstance } from "../world/removal.js";
import { BranchStore } from "../world/store.js";
import { spatialRelationEvidence } from "../world/spatial-ontology.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { CompilerBatchStore } from "../compiler/batches.js";
import { BoundaryCalibrationStore } from "../compiler/boundary-calibration.js";
import { ChapterSplitPlanStore } from "../compiler/chapter-split.js";
import { SegmentStore } from "../compiler/segments.js";
import { SourceStructureStore } from "../compiler/structure.js";
import { SourceAccountingStore } from "../compiler/source-accounting.js";
import { SourceAnnotationStore } from "../compiler/annotations.js";
import { EntityResolutionStore } from "../compiler/entity-resolution.js";
import { EventResolutionStore } from "../compiler/event-resolution.js";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { TraceStore } from "../trace/store.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import {
  executeRemovalRequestSchema,
  removalExecutionResultSchema,
  removalPreviewSchema,
  type ExecuteRemovalRequest,
  type MaintenanceAction,
  type RemovalEffect,
  type RemovalExecutionResult,
  type RemovalPreview,
} from "../web/contracts.js";
import { WebEventBroker } from "../web/event-stream.js";
import { webError } from "../web/errors.js";
import { WebMutationJournal } from "../web/mutation-journal.js";
import { OperationManager } from "../web/operation-manager.js";
import { CatalogService } from "./catalog-service.js";

type AnalysisInventory = {
  canonicalIds: string[];
  actorIds: string[];
  possibilityIds: string[];
  proposalIds: string[];
  compilerObservationIds: string[];
  evidenceSegmentIds: string[];
  initialWorld: boolean;
  preparedRevisionIds: string[];
  pinnedRevisionIds: string[];
};

export interface MaintenanceApplicationServiceOptions {
  root: string;
  events: WebEventBroker;
  operations: OperationManager;
  traceStore?: TraceStore;
  cacheRoot?: string;
  mutations?: WebMutationJournal;
}

/**
 * Destructive Web commands are two-step operations. The preview is a
 * deterministic snapshot of the exact target identities and blockers; the
 * execution rejects a stale hash instead of silently widening its scope.
 */
export class MaintenanceApplicationService {
  readonly root: string;
  private readonly catalog: CatalogService;
  private readonly branches: BranchStore;
  private readonly conversations: PlayConversationStore;
  private readonly traces: TraceStore;
  private readonly mutations: WebMutationJournal;

  constructor(private readonly options: MaintenanceApplicationServiceOptions) {
    this.root = path.resolve(options.root);
    this.catalog = new CatalogService(this.root);
    this.branches = new BranchStore(this.root);
    this.conversations = new PlayConversationStore(this.root);
    this.traces = options.traceStore ?? new TraceStore(this.root);
    this.mutations = options.mutations ?? new WebMutationJournal(this.root);
  }

  async previewInstance(branchId: string): Promise<RemovalPreview> {
    const catalog = await this.catalog.read();
    const instance = catalog.instances.find((candidate) => candidate.branchId === branchId);
    if (!instance) throw this.instanceNotFound(branchId);
    const sessions = catalog.playSessions.filter((session) => session.branchId === branchId);
    const messages = sessions.length
      ? (await Promise.all(sessions.map((session) =>
          this.conversations.list(branchId, session.conversationId)))).flat()
      : await this.conversations.list(branchId);
    const traceIds = await this.traces.listRunIds({ branchId });
    const children = catalog.instances.filter((candidate) => candidate.parentBranchId === branchId).map((candidate) => candidate.branchId).sort();
    const blockers = await this.instanceBlockers(branchId, sessions.map((session) => session.id));
    const effects: RemovalEffect[] = [
      effect("branch", "Branch reference", "remove", 1, [branchId], "Deletes the selected leaf branch record and its mutable frontier."),
      effect("play-sessions", "Play session metadata", "modify", sessions.length, sessions.map((session) => session.id), "Marks saved sessions as detached historical presentation; they can no longer write world truth."),
      effect("conversation", "Presentation messages", "preserve", messages.length, messages.map((message) => message.id), "Preserves the branch transcript for historical inspection; these messages never were world truth."),
      effect("children", "Dependent child branches", "preserve", children.length, children, children.length ? "Live children block deletion; remove them first." : "No child branch depends on this target."),
      effect("trace-runs", "LLM and tool traces", "preserve", traceIds.length, traceIds, "Observability records remain available and become detached historical evidence."),
      effect("world-objects", "Immutable commits and events", "preserve", instance.commitCount + instance.eventCount, [instance.headCommitId], "Content-addressed commit/event objects remain available because other branches may share them."),
    ];
    return preview("remove-instance", branchId, instance.name, branchId, effects, blockers, {
      headCommitId: instance.headCommitId,
      updatedAt: instance.updatedAt,
    });
  }

  async previewAnalysis(sourceId: string): Promise<RemovalPreview> {
    return this.previewNovelAction(sourceId, "reset-analysis");
  }

  async previewNovel(sourceId: string): Promise<RemovalPreview> {
    return this.previewNovelAction(sourceId, "remove-novel");
  }

  async removeInstance(branchId: string, inputValue: ExecuteRemovalRequest): Promise<RemovalExecutionResult> {
    return this.execute("remove-instance", branchId, inputValue, async (current) => {
      await removeWorldInstance(this.root, branchId, { retainPresentation: true });
      return resultFromPreview(current);
    });
  }

  async resetAnalysis(sourceId: string, inputValue: ExecuteRemovalRequest): Promise<RemovalExecutionResult> {
    return this.execute("reset-analysis", sourceId, inputValue, async (current) => {
      const removal = await withWorkspaceOperationLock(this.root, "compiler", () => removeNovelAnalysis(
        this.root,
        sourceId,
        this.options.cacheRoot ? { cacheRoot: this.options.cacheRoot } : {},
      ));
      return removalExecutionResultSchema.parse({
        ...resultFromPreview(current),
        removed: {
          ...resultFromPreview(current).removed,
          canonicalArtifacts: removal.canonicalArtifacts,
          actorArtifacts: removal.actorArtifacts,
          possibilities: removal.possibilities,
          proposals: removal.proposals,
        },
      });
    });
  }

  async removeNovel(sourceId: string, inputValue: ExecuteRemovalRequest): Promise<RemovalExecutionResult> {
    return this.execute("remove-novel", sourceId, inputValue, async (current) => {
      const removal = await withWorkspaceOperationLock(this.root, "compiler", () => removeNovel(
        this.root,
        sourceId,
        { ...(this.options.cacheRoot ? { cacheRoot: this.options.cacheRoot } : {}), retainPresentation: true },
      ));
      return removalExecutionResultSchema.parse({
        ...resultFromPreview(current),
        removed: {
          ...resultFromPreview(current).removed,
          branches: removal.removedBranchIds.length,
          canonicalArtifacts: removal.analysis.canonicalArtifacts,
          actorArtifacts: removal.analysis.actorArtifacts,
          possibilities: removal.analysis.possibilities,
          proposals: removal.analysis.proposals,
          sourceRegistrations: removal.sourceUnregistered ? 1 : 0,
        },
      });
    });
  }

  private async previewNovelAction(sourceId: string, action: "reset-analysis" | "remove-novel"): Promise<RemovalPreview> {
    const workspace = await WorkspaceStore.create(this.root);
    const source = await workspace.getSource(sourceId);
    if (!source) throw this.sourceNotFound(sourceId);
    const [catalog, inventory] = await Promise.all([this.catalog.read(), this.analysisInventory(source)]);
    const instances = catalog.instances.filter((instance) => instance.sourceId === sourceId);
    const branchIds = instances.map((instance) => instance.branchId).sort();
    const sessions = catalog.playSessions.filter((session) => branchIds.includes(session.branchId));
    const messages = sessions.length
      ? (await Promise.all(sessions.map((session) =>
          this.conversations.list(session.branchId, session.conversationId)))).flat()
      : (await Promise.all(branchIds.map((branchId) => this.conversations.list(branchId)))).flat();
    const traceIds = new Set(await this.traces.listRunIds({ sourceId }));
    for (const branchId of branchIds) {
      for (const runId of await this.traces.listRunIds({ branchId })) traceIds.add(runId);
    }
    const blockers = await this.novelBlockers(sourceId, branchIds, sessions.map((session) => session.id), action);
    const removeBranches = action === "remove-novel";
    const unpinnedRevisionIds = inventory.preparedRevisionIds.filter((id) =>
      removeBranches || !inventory.pinnedRevisionIds.includes(id));
    const effects: RemovalEffect[] = [
      effect("canonical-artifacts", "Canonical artifacts with source evidence", "modify", inventory.canonicalIds.length, inventory.canonicalIds, "Detaches this source's evidence; source-exclusive current refs are removed while immutable revisions remain."),
      effect("actor-artifacts", "Character goals and models", "modify", inventory.actorIds.length, inventory.actorIds, "Detaches this source's evidence; source-exclusive current refs are removed."),
      effect("possibilities", "Possibility frontier templates", "modify", inventory.possibilityIds.length, inventory.possibilityIds, "Detaches this source's evidence or removes its current template ref."),
      effect("proposals", "Compiler proposals", "remove", inventory.proposalIds.length, inventory.proposalIds, "Removes pending, accepted, and rejected proposal envelopes owned by this source."),
      effect("opening-world", "Opening-world materialization", "modify", inventory.initialWorld ? 1 : 0, inventory.initialWorld ? ["initial-world"] : [], "Detaches source evidence; clears the current opening world if no evidence remains."),
      effect("evidence-index", "Evidence segments", "remove", inventory.evidenceSegmentIds.length, inventory.evidenceSegmentIds, "Removes only the derived segment index, never archived source bytes."),
      effect("compiler-observations", "Compiler checkpoints and observations", "remove", inventory.compilerObservationIds.length, inventory.compilerObservationIds, "Removes structure, accounting, annotations, identity/event resolutions, split plans, and batch checkpoints."),
      effect("prepared-revisions-remove", "Unpinned prepared revisions", "remove", unpinnedRevisionIds.length, unpinnedRevisionIds, "Removes mutable active cache state and revisions not required by a retained branch."),
      effect("prepared-revisions-pinned", "Branch-pinned prepared revisions", removeBranches ? "remove" : "preserve", inventory.pinnedRevisionIds.length, inventory.pinnedRevisionIds, removeBranches ? "Owned branches are removed, so their prepared bundles no longer need retention." : "Immutable bundles remain addressable only by retained branch revision hash."),
      effect("branches", "Owned branches", removeBranches ? "remove" : "preserve", branchIds.length, branchIds, removeBranches ? "Removes owned branches child-first." : "Committed branch history and derived world state remain playable."),
      effect("play-sessions", "Owned play sessions", removeBranches ? "modify" : "preserve", sessions.length, sessions.map((session) => session.id), removeBranches ? "Marks session selectors as detached historical presentation after their branches are removed." : "Saved play sessions remain attached to retained branches."),
      effect("conversation", "Presentation messages", "preserve", messages.length, messages.map((message) => message.id), removeBranches ? "Preserves branch conversations for detached-session inspection." : "Conversation presentation memory remains with retained sessions."),
      effect("source-registration", "Novel registration", removeBranches ? "remove" : "preserve", 1, [source.id], removeBranches ? "Unregisters the source from this workspace." : "Keeps the novel registered for a fresh compilation."),
      effect("source-material", "Immutable archived source bytes", "preserve", 1, [source.contentSha256], "Content-addressed source evidence is never physically deleted by this command."),
      effect("trace-runs", "LLM and tool traces", "preserve", traceIds.size, [...traceIds].sort(), "Trace records remain read-only historical diagnostics."),
      effect("world-objects", "Immutable commit/event objects", "preserve", instances.reduce((sum, instance) => sum + instance.commitCount + instance.eventCount, 0), instances.map((instance) => instance.headCommitId).sort(), "Content-addressed history objects may be shared and are not garbage-collected by removal."),
    ];
    return preview(action, source.id, source.title, source.id, effects, blockers, {
      sourceUpdatedAt: source.updatedAt,
      sourceSha256: source.contentSha256,
    });
  }

  private async analysisInventory(source: SourceDocument): Promise<AnalysisInventory> {
    const canonical = new CanonicalModelStore(this.root);
    const actors = new ActorModelStore(this.root);
    const possibilities = new PossibilityTemplateStore(this.root);
    const sourceId = source.id;
    const canonicalIds: string[] = [];
    const collect = <T extends { id: string; evidence: readonly { span: { sourceId: string } }[] }>(kind: string, items: readonly T[]) => {
      for (const item of items) if (hasSourceEvidence(item.evidence, sourceId)) canonicalIds.push(`${kind}:${item.id}`);
    };
    const [entities, propositions, attributions, claims, participations, eventRelations, spatialRelations, events, rules] = await Promise.all([
      canonical.listEntities(), canonical.listPropositions(), canonical.listAttributions(), canonical.listClaims(),
      canonical.listEventParticipations(), canonical.listEventRelations(), canonical.listSpatialRelations(), canonical.listEvents(), canonical.listRules(),
    ]);
    collect("entity", entities);
    collect("proposition", propositions);
    collect("attribution", attributions);
    collect("claim", claims);
    collect("event-participation", participations);
    for (const relation of eventRelations) {
      if (hasSourceEvidence([...relation.evidence, ...(relation.counterEvidence ?? [])], sourceId)) canonicalIds.push(`event-relation:${relation.id}`);
    }
    for (const relation of spatialRelations) {
      if (hasSourceEvidence(spatialRelationEvidence(relation), sourceId)) canonicalIds.push(`spatial-relation:${relation.id}`);
    }
    collect("event", events);
    collect("rule", rules);

    const [goals, models, possibilityItems] = await Promise.all([actors.listGoals(), actors.listModels(), possibilities.list()]);
    const actorIds = [
      ...goals.filter((item) => hasSourceEvidence(item.evidence, sourceId)).map((item) => `goal:${item.id}`),
      ...models.filter((item) => hasSourceEvidence(item.evidence, sourceId)).map((item) => `model:${item.actorId}`),
    ].sort();
    const possibilityIds = possibilityItems.filter((item) => hasSourceEvidence(item.evidence, sourceId)).map((item) => item.id).sort();

    const proposalStore = new ProposalStore(this.root);
    const proposalIds: string[] = [];
    for (const status of ["pending", "accepted", "rejected"] as const) {
      proposalIds.push(...(await proposalStore.list(status, sourceId)).map((item) => `${status}:${item.id}`));
    }
    if (source.pendingTitleProposal) proposalIds.push(`pending-title:${source.pendingTitleProposal.proposalId}`);

    const segments = await new SegmentStore(this.root).readManifest(sourceId);
    const structure = await new SourceStructureStore(this.root).read(sourceId);
    const accounting = await new SourceAccountingStore(this.root).read(sourceId);
    const annotations = new SourceAnnotationStore(this.root);
    const entityResolutions = new EntityResolutionStore(this.root);
    const eventResolutions = new EventResolutionStore(this.root);
    const compilerObservationIds: string[] = [];
    if (structure) compilerObservationIds.push(...structure.units.map((item) => `structure:${item.id}`), ...structure.discourseSegments.map((item) => `discourse:${item.id}`));
    if (accounting) compilerObservationIds.push(...accounting.records.map((item) => `accounting:${item.unitId}`), ...accounting.batchReviews.map((item) => `batch-review:${item.batchId}`));
    compilerObservationIds.push(...(await annotations.list(sourceId)).map((item) => `annotation:${item.id}`));
    compilerObservationIds.push(...(await entityResolutions.list(sourceId)).map((item) => `entity-resolution:${item.id}`));
    compilerObservationIds.push(...(await eventResolutions.list(sourceId)).map((item) => `event-resolution:${item.id}`));
    for (const status of ["pending", "accepted", "rejected"] as const) {
      compilerObservationIds.push(...(await annotations.listProposals(sourceId, status)).map((item) => `annotation-${status}:${item.id}`));
      compilerObservationIds.push(...(await entityResolutions.listProposals(sourceId, status)).map((item) => `entity-resolution-${status}:${item.id}`));
      compilerObservationIds.push(...(await eventResolutions.listProposals(sourceId, status)).map((item) => `event-resolution-${status}:${item.id}`));
    }
    const chapterPlan = await new ChapterSplitPlanStore(this.root).read(sourceId);
    if (chapterPlan) compilerObservationIds.push(`chapter-split:${sourceId}`);
    const batchProgress = await new CompilerBatchStore(this.root).readPersisted(sourceId);
    if (batchProgress) compilerObservationIds.push(...batchProgress.completedBatchIds.map((id) => `batch:${id}`), `batch-checkpoint:${sourceId}`);
    compilerObservationIds.push(...(await new BoundaryCalibrationStore(this.root).list(sourceId)).map((item) => `boundary:${item.id}`));

    const preparedRevisionIds = (await new PreparedNovelCache(this.root, this.options.cacheRoot).listRevisions(source)).map((item) => item.bundleHash).sort();
    const pinnedRevisionIds = await this.pinnedPreparedRevisions(sourceId);
    const initialWorld = await new InitialWorldStore(this.root).get();
    return {
      canonicalIds: canonicalIds.sort(),
      actorIds,
      possibilityIds,
      proposalIds: proposalIds.sort(),
      compilerObservationIds: [...new Set(compilerObservationIds)].sort(),
      evidenceSegmentIds: (segments?.segments ?? []).map((item) => item.id).sort(),
      initialWorld: Boolean(initialWorld && hasSourceEvidence(initialWorld.evidence, sourceId)),
      preparedRevisionIds,
      pinnedRevisionIds,
    };
  }

  private async pinnedPreparedRevisions(sourceId: string): Promise<string[]> {
    const hashes = new Set<string>();
    for (const branchId of await this.branches.listIds()) {
      const branch = await this.branches.read(branchId);
      if (branch.sourceId === sourceId && branch.preparedRevisionHash) hashes.add(branch.preparedRevisionHash);
    }
    return [...hashes].sort();
  }

  private async instanceBlockers(branchId: string, sessionIds: string[]): Promise<string[]> {
    const blockers: string[] = [];
    try {
      await this.branches.assertRemovable(branchId);
    } catch (error) {
      blockers.push(errorMessage(error));
    }
    const scopes = new Set([branchId, ...sessionIds]);
    for (const operation of this.activeOperations()) {
      if (scopes.has(operation.scopeId)) blockers.push(`Operation '${operation.id}' (${operation.kind}) is ${operation.status} for this instance.`);
    }
    return [...new Set(blockers)].sort();
  }

  private async novelBlockers(sourceId: string, branchIds: string[], sessionIds: string[], action: "reset-analysis" | "remove-novel"): Promise<string[]> {
    const blockers: string[] = [];
    if (action === "remove-novel") {
      const removing = new Set(branchIds);
      for (const branchId of branchIds) {
        try {
          await this.branches.assertRemovable(branchId, removing);
        } catch (error) {
          blockers.push(errorMessage(error));
        }
      }
    }
    const scopes = new Set([sourceId, ...branchIds, ...sessionIds]);
    for (const operation of this.activeOperations()) {
      if (scopes.has(operation.scopeId)) blockers.push(`Operation '${operation.id}' (${operation.kind}) is ${operation.status} for this novel.`);
    }
    return [...new Set(blockers)].sort();
  }

  private activeOperations() {
    return this.options.operations.list().filter((operation) => operation.status === "queued" || operation.status === "running");
  }

  private async execute(
    action: MaintenanceAction,
    targetId: string,
    inputValue: ExecuteRemovalRequest,
    mutate: (previewValue: RemovalPreview) => Promise<RemovalExecutionResult>,
  ): Promise<RemovalExecutionResult> {
    const input = executeRemovalRequestSchema.parse(inputValue);
    const execution = await this.mutations.execute({
      kind: action,
      scopeId: targetId,
      clientRequestId: input.clientRequestId,
      request: input,
    }, async () => {
      const current = action === "remove-instance"
        ? await this.previewInstance(targetId)
        : action === "reset-analysis"
          ? await this.previewAnalysis(targetId)
          : await this.previewNovel(targetId);
      if (input.confirmation !== current.target.confirmation) {
        throw webError(400, "REMOVAL_CONFIRMATION_MISMATCH", `Type the exact target ID '${current.target.confirmation}' to confirm this operation.`, {
          kind: "after-user-action",
          discoveryEndpoint: previewEndpoint(action, targetId),
          copyField: "target.confirmation",
          maxAttempts: 1,
        });
      }
      if (input.effectHash !== current.effectHash) {
        throw webError(409, "REMOVAL_PREVIEW_STALE", "The removal effect changed after it was previewed. Refresh the effect manifest and review it before one corrected retry.", {
          kind: "after-refresh",
          discoveryEndpoint: previewEndpoint(action, targetId),
          copyField: "effectHash",
          maxAttempts: 1,
        });
      }
      if (!current.executable) {
        throw webError(409, "REMOVAL_BLOCKED", "The target cannot be removed while the preview reports blockers. Do not retry unchanged.", { kind: "none" }, { blockers: current.blockers });
      }
      try {
        const result = await mutate(current);
        this.options.events.publish("catalog.invalidated", { reason: action, targetId });
        return result;
      } catch (error) {
        if (error instanceof Error && error.name === "WebApplicationError") throw error;
        throw webError(409, "REMOVAL_FAILED", errorMessage(error), {
          kind: "after-refresh",
          discoveryEndpoint: previewEndpoint(action, targetId),
          copyField: "effectHash",
          maxAttempts: 1,
        });
      }
    });
    return removalExecutionResultSchema.parse(execution.value);
  }

  private instanceNotFound(branchId: string) {
    return webError(404, "INSTANCE_NOT_FOUND", `Unknown world instance '${branchId}'.`, {
      kind: "after-refresh", discoveryEndpoint: "/api/v1/instances", copyField: "branchId", maxAttempts: 1,
    });
  }

  private sourceNotFound(sourceId: string) {
    return webError(404, "SOURCE_NOT_FOUND", `Unknown novel source '${sourceId}'.`, {
      kind: "after-refresh", discoveryEndpoint: "/api/v1/novels", copyField: "id", maxAttempts: 1,
    });
  }
}

function effect(
  id: string,
  label: string,
  disposition: RemovalEffect["disposition"],
  count: number,
  itemIds: string[],
  detail: string,
): RemovalEffect {
  return { id, label, disposition, count, itemIds: [...new Set(itemIds)].sort(), detail };
}

function preview(
  action: MaintenanceAction,
  targetId: string,
  targetLabel: string,
  confirmation: string,
  effects: RemovalEffect[],
  blockers: string[],
  stateIdentity: Record<string, unknown>,
): RemovalPreview {
  const identity = { action, targetId, effects, blockers, stateIdentity };
  return removalPreviewSchema.parse({
    version: 1,
    action,
    target: { id: targetId, label: targetLabel, confirmation },
    effectHash: contentHash(identity),
    executable: blockers.length === 0,
    blockers,
    effects,
  });
}

function resultFromPreview(current: RemovalPreview): RemovalExecutionResult {
  const count = (id: string) => current.effects.find((item) => item.id === id && item.disposition === "remove")?.count ?? 0;
  return removalExecutionResultSchema.parse({
    version: 1,
    action: current.action,
    targetId: current.target.id,
    effectHash: current.effectHash,
    completed: true,
    removed: {
      branches: count("branch") || count("branches"),
      sessions: count("play-sessions"),
      conversationMessages: count("conversation"),
      canonicalArtifacts: current.action === "reset-analysis" || current.action === "remove-novel" ? current.effects.find((item) => item.id === "canonical-artifacts")?.count ?? 0 : 0,
      actorArtifacts: current.action === "reset-analysis" || current.action === "remove-novel" ? current.effects.find((item) => item.id === "actor-artifacts")?.count ?? 0 : 0,
      possibilities: current.action === "reset-analysis" || current.action === "remove-novel" ? current.effects.find((item) => item.id === "possibilities")?.count ?? 0 : 0,
      proposals: count("proposals"),
      sourceRegistrations: count("source-registration"),
    },
    immutableSourcePreserved: true,
    tracesPreserved: true,
  });
}

function hasSourceEvidence(evidence: readonly { span: { sourceId: string } }[], sourceId: string): boolean {
  return evidence.some((item) => item.span.sourceId === sourceId);
}

function previewEndpoint(action: MaintenanceAction, targetId: string): string {
  if (action === "remove-instance") return `/api/v1/instances/${encodeURIComponent(targetId)}/removal-preview`;
  const query = action === "reset-analysis" ? "analysis" : "novel";
  return `/api/v1/novels/${encodeURIComponent(targetId)}/removal-preview?mode=${query}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

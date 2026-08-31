import path from "node:path";
import { compilerPayloadEvidence } from "../compiler/proposals.js";
import { ActorModelStore, type CharacterModel } from "../world/actors.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { contentHash } from "../world/canonical.js";
import { InitialWorldStore } from "../world/initial.js";
import type {
  Attribution,
  CanonicalEvent,
  Claim,
  CommittedEvent,
  Entity,
  EventParticipation,
  EventRelation,
  EvidenceRef,
  Predicate,
  Proposition,
  StoryTime,
  WorldRule,
  WorldState,
} from "../world/model.js";
import { PossibilityTemplateStore, type PossibilityTemplate } from "../world/possibility-model.js";
import { committedHistory, realizedCanonicalEvents, type CommittedHistoryEntry } from "../world/scene.js";
import { resolveActiveSpatialRelations, spatialEndpoints, spatialRelationEvidence, type SpatialRelation } from "../world/spatial-ontology.js";
import { BranchStore } from "../world/store.js";
import { isControlledWorldRule, resolveEffectiveWorldRules, worldRuleEvidence } from "../world/world-rule-ontology.js";
import { openWorkspaceWorld } from "../world/workspace-runtime.js";
import type { WorldModelContext } from "../world/engine.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import {
  ontologyGraphSchema,
  ontologyNodeDetailSchema,
  ontologyViewSchema,
  type OntologyAssociation,
  type OntologyEdge,
  type OntologyEvidence,
  type OntologyGraph,
  type OntologyLayer,
  type OntologyNode,
  type OntologyNodeDetail,
  type OntologyScope,
  type OntologyStatus,
  type OntologyView,
} from "../web/contracts.js";
import { WebApplicationError, webError } from "../web/errors.js";

const DEFAULT_LIMIT = 180;
const MAX_PAGE_LIMIT = 500;
const DEFAULT_RELATION_LIMIT = 100;
const MAX_RELATION_LIMIT = 500;
const MAX_DETAIL_EXCERPT_BYTES = 1_200;
const PAGE_CACHE_TTL_MS = 60_000;
const MAX_CACHED_PROJECTIONS = 3;

export type OntologyProjectionInput = {
  sourceId: string;
  view: OntologyView;
  branchId?: string;
  atCommit?: string;
  includeCanonicalFuture?: boolean;
  layers?: OntologyLayer[];
  limit?: number;
  cursor?: string;
  search?: string;
  kind?: string;
  status?: OntologyStatus;
  relationLimit?: number;
};

type ValidatedOntologyProjectionInput = {
  sourceId: string;
  view: OntologyView;
  branchId?: string;
  atCommit?: string;
  includeCanonicalFuture: boolean;
  layers: OntologyLayer[];
  limit: number;
  cursor?: string;
  search?: string;
  kind?: string;
  status?: OntologyStatus;
  relationLimit: number;
};

type ArtifactSet = {
  entities: Entity[];
  propositions: Proposition[];
  attributions: Attribution[];
  claims: Claim[];
  events: CanonicalEvent[];
  eventParticipations: EventParticipation[];
  eventRelations: EventRelation[];
  spatialRelations: SpatialRelation[];
  rules: WorldRule[];
  models: CharacterModel[];
  goals: Awaited<ReturnType<ActorModelStore["listGoals"]>>;
  possibilities: PossibilityTemplate[];
};

type ProjectionFrame = {
  source: SourceDocument;
  scope: OntologyScope;
  artifacts: ArtifactSet;
  history: CommittedHistoryEntry[];
  state?: WorldState;
  realizedCanonicalEventIds: ReadonlySet<string>;
  activeSpatialIds: ReadonlySet<string>;
  effectiveRuleIds: ReadonlySet<string>;
  inactiveRules: ReadonlyMap<string, string>;
};

type InternalProjection = {
  graph: OntologyGraph;
  allNodes: OntologyNode[];
  allEdges: OntologyEdge[];
  payloads: Map<string, unknown>;
  evidence: Map<string, EvidenceRef[]>;
};

type CachedProjection = {
  signature: string;
  expiresAt: number;
  graph: OntologyGraph;
  allNodes: OntologyNode[];
  allEdges: OntologyEdge[];
};

export class OntologyProjectionService {
  readonly root: string;
  private readonly pageCache = new Map<string, CachedProjection>();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async project(inputValue: OntologyProjectionInput): Promise<OntologyGraph> {
    const input = validateInput(inputValue);
    const endpoint = ontologyEndpoint(input);
    const cursor = input.cursor ? readGraphCursor(input.cursor, endpoint) : undefined;
    const cached = cursor ? this.pageCache.get(cursor.snapshotId) : undefined;
    if (cursor && cached && cached.expiresAt > Date.now() && cached.signature === projectionSignature(input)) {
      return graphPageFromCache(cached, input, cursor.offset);
    }
    const projection = await this.build(input);
    this.rememberProjection(projection, input);
    return projection.graph;
  }

  async getNode(inputValue: OntologyProjectionInput, nodeId: string): Promise<OntologyNodeDetail> {
    const input = validateInput({
      ...inputValue,
      cursor: undefined,
      search: undefined,
      kind: undefined,
      status: undefined,
    });
    const projection = await this.build(input, nodeId);
    const node = projection.allNodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      throw webError(404, "ONTOLOGY_NODE_NOT_FOUND", `Node '${nodeId}' is not present in the selected ${input.view} projection.`, {
        kind: "after-refresh",
        discoveryEndpoint: ontologyEndpoint(input),
        copyField: "nodes[].id",
        maxAttempts: 1,
      });
    }
    const evidence = await this.evidenceDetails(
      (projection.evidence.get(node.id) ?? []).filter((item) => item.span.sourceId === input.sourceId),
      (await WorkspaceStore.create(this.root)).getSource(input.sourceId),
    );
    const allIncoming = projection.allEdges.filter((edge) => edge.target === node.id);
    const allOutgoing = projection.allEdges.filter((edge) => edge.source === node.id);
    const incoming = allIncoming.slice(0, input.relationLimit);
    const outgoing = allOutgoing.slice(0, input.relationLimit);
    const relatedNodeIds = new Set([...incoming, ...outgoing].flatMap((edge) => [edge.source, edge.target]));
    relatedNodeIds.delete(node.id);
    const associations = entityAssociations(node, projection.allNodes, projection.allEdges);
    return ontologyNodeDetailSchema.parse({
      version: 1,
      scope: projection.graph.scope,
      node,
      payload: sanitizePayload(projection.payloads.get(node.id), input.sourceId),
      evidence,
      incoming,
      outgoing,
      relatedNodes: projection.allNodes.filter((candidate) => relatedNodeIds.has(candidate.id)),
      associations,
      relationPage: {
        limitPerDirection: input.relationLimit,
        incomingTotal: allIncoming.length,
        outgoingTotal: allOutgoing.length,
        truncated: allIncoming.length > input.relationLimit || allOutgoing.length > input.relationLimit,
      },
    });
  }

  private async build(input: ValidatedOntologyProjectionInput, detailNodeId?: string): Promise<InternalProjection> {
    const frame = await this.frame(input);
    const builder = new GraphBuilder(frame.scope, detailNodeId);
    if (input.view === "model") this.buildModel(builder, frame);
    if (input.view === "events") this.buildEvents(builder, frame);
    if (input.view === "places") this.buildPlaces(builder, frame);
    if (input.view === "rules") this.buildRules(builder, frame);
    if (input.view === "provenance") await this.buildProvenance(builder, frame);
    return builder.finish(input);
  }

  private rememberProjection(projection: InternalProjection, input: ValidatedOntologyProjectionInput): void {
    const now = Date.now();
    for (const [snapshotId, cached] of this.pageCache) {
      if (cached.expiresAt <= now) this.pageCache.delete(snapshotId);
    }
    const snapshotId = projection.graph.page.snapshotId;
    this.pageCache.delete(snapshotId);
    this.pageCache.set(snapshotId, {
      signature: projectionSignature(input),
      expiresAt: now + PAGE_CACHE_TTL_MS,
      graph: projection.graph,
      allNodes: projection.allNodes,
      allEdges: projection.allEdges,
    });
    while (this.pageCache.size > MAX_CACHED_PROJECTIONS) {
      const oldest = this.pageCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pageCache.delete(oldest);
    }
  }

  private async frame(input: ValidatedOntologyProjectionInput): Promise<ProjectionFrame> {
    const workspace = await WorkspaceStore.create(this.root);
    const source = await workspace.getSource(input.sourceId);
    if (!source) throw this.sourceNotFound(input.sourceId);
    if (!input.branchId && input.atCommit) {
      throw webError(400, "ONTOLOGY_COMMIT_REQUIRES_BRANCH", "atCommit requires an explicit branchId so ancestry can be validated.", { kind: "after-user-action" });
    }
    if (!input.branchId) {
      const artifacts = await this.currentArtifacts(input.sourceId);
      return {
        source,
        scope: {
          sourceId: source.id,
          view: input.view,
          includeCanonicalFuture: input.includeCanonicalFuture,
          layers: input.layers,
        },
        artifacts,
        history: [],
        realizedCanonicalEventIds: new Set(),
        activeSpatialIds: new Set(),
        effectiveRuleIds: new Set(),
        inactiveRules: new Map(),
      };
    }
    const branches = new BranchStore(this.root);
    let branch;
    try {
      branch = await branches.read(input.branchId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw this.branchNotFound(input.branchId);
    }
    if (branch.sourceId && branch.sourceId !== source.id) {
      throw webError(409, "ONTOLOGY_SOURCE_BRANCH_MISMATCH", `Branch '${branch.id}' belongs to source '${branch.sourceId}', not '${source.id}'.`, {
        kind: "after-user-action",
        discoveryEndpoint: "/api/v1/instances",
        copyField: "sourceId",
        maxAttempts: 1,
      });
    }
    const atCommit = input.atCommit ?? branch.headCommitId;
    const { engine } = await openWorkspaceWorld(this.root, undefined, {
      sourceId: source.id,
      ...(branch.preparedRevisionHash ? { preparedRevisionHash: branch.preparedRevisionHash } : {}),
    });
    try {
      await assertAncestor(branch.headCommitId, atCommit, async (commitId) => (await engine.objects.getCommit(commitId)).parentCommitId);
    } catch (error) {
      if (isWebError(error)) throw error;
      throw webError(409, "ONTOLOGY_COMMIT_UNAVAILABLE", `Commit '${atCommit}' cannot be resolved in world instance '${branch.id}'.`, {
        kind: "after-refresh",
        discoveryEndpoint: "/api/v1/instances",
        copyField: "headCommitId",
        maxAttempts: 1,
      });
    }
    const [context, state, history] = await Promise.all([
      engine.contextForCommit(atCommit),
      engine.projector.project(atCommit),
      committedHistory(engine, atCommit),
    ]);
    if (context.sourceId && context.sourceId !== source.id) {
      throw webError(409, "ONTOLOGY_COMMIT_SOURCE_MISMATCH", `Commit '${atCommit}' resolves to source '${context.sourceId}', not '${source.id}'.`, { kind: "none" });
    }
    const artifacts = artifactsFromContext(context);
    const realized = realizedCanonicalEvents(history);
    const activeSpatial = resolveActiveSpatialRelations(artifacts.spatialRelations, { state, realizedCanonicalEventIds: realized });
    const rules = resolveEffectiveWorldRules(context.rules, state);
    return {
      source,
      scope: {
        sourceId: source.id,
        view: input.view,
        branchId: branch.id,
        atCommit,
        branchHead: branch.headCommitId,
        includeCanonicalFuture: input.includeCanonicalFuture,
        layers: input.layers,
      },
      artifacts,
      history,
      state,
      realizedCanonicalEventIds: realized,
      activeSpatialIds: new Set(activeSpatial.map((item) => item.id)),
      effectiveRuleIds: new Set(rules.effective.map((item) => item.id)),
      inactiveRules: new Map(rules.inactive.map((item) => [item.ruleId, item.reason])),
    };
  }

  private async currentArtifacts(sourceId: string): Promise<ArtifactSet> {
    const canonical = new CanonicalModelStore(this.root);
    const actors = new ActorModelStore(this.root);
    const possibilities = new PossibilityTemplateStore(this.root);
    const values = await Promise.all([
      canonical.listEntities(), canonical.listPropositions(), canonical.listAttributions(), canonical.listClaims(),
      canonical.listEvents(), canonical.listEventParticipations(), canonical.listEventRelations(), canonical.listSpatialRelations(),
      canonical.listRules(), actors.listModels(), actors.listGoals(), possibilities.list(),
    ]);
    const scoped = <T>(items: T[], evidenceOf: (item: T) => readonly EvidenceRef[] = defaultEvidence) =>
      items.filter((item) => evidenceOf(item).some((reference) => reference.span.sourceId === sourceId));
    return {
      entities: scoped(values[0]),
      propositions: scoped(values[1]),
      attributions: scoped(values[2]),
      claims: scoped(values[3]),
      events: scoped(values[4]),
      eventParticipations: scoped(values[5]),
      eventRelations: scoped(values[6], (item) => [...item.evidence, ...(item.counterEvidence ?? [])]),
      spatialRelations: scoped(values[7], spatialRelationEvidence),
      rules: scoped(values[8], worldRuleEvidence),
      models: scoped(values[9]),
      goals: scoped(values[10]),
      possibilities: scoped(values[11]),
    };
  }

  private buildModel(builder: GraphBuilder, frame: ProjectionFrame): void {
    const entities = new Map(frame.artifacts.entities.map((entity) => [entity.id, entity]));
    for (const entity of frame.artifacts.entities) builder.artifact(entityNode(entity, frame));
    for (const proposition of frame.artifacts.propositions) {
      const node = propositionNode(proposition, frame);
      builder.artifact(node);
      builder.edge(link("proposition-subject", entityId(proposition.subjectEntityId), node.node.id, "subject", node.node.status, "canonical", proposition.evidence));
      if (proposition.object.kind === "entity") builder.edge(link("proposition-object", node.node.id, entityId(proposition.object.entityId), proposition.relationId, node.node.status, "canonical", proposition.evidence));
      if (proposition.object.kind === "proposition") builder.edge(link("nested-proposition", node.node.id, propositionId(proposition.object.propositionId), "contains proposition", node.node.status, "canonical", proposition.evidence));
    }
    for (const claim of frame.artifacts.claims) {
      const node = claimNode(claim, frame);
      builder.artifact(node);
      builder.edge(link("claim-subject", entityId(claim.subject), node.node.id, claim.predicate, node.node.status, "canonical", claim.evidence));
      if (claim.speaker) builder.edge(link("claim-speaker", entityId(claim.speaker), node.node.id, "asserts", node.node.status, "canonical", claim.evidence));
      if (typeof claim.object === "string" && entities.has(claim.object)) builder.edge(link("claim-object", node.node.id, entityId(claim.object), "object", node.node.status, "canonical", claim.evidence));
    }
    for (const attribution of frame.artifacts.attributions) {
      const node = attributionNode(attribution, frame);
      builder.artifact(node);
      builder.edge(link("attribution-proposition", node.node.id, propositionId(attribution.propositionId), attribution.attitude, node.node.status, "canonical", attribution.evidence));
      if (attribution.holderEntityId) builder.edge(link("attribution-holder", entityId(attribution.holderEntityId), node.node.id, attribution.holderKind, node.node.status, "canonical", attribution.evidence));
      if (attribution.sourceAttributionId) builder.edge(link("attribution-source", attributionId(attribution.sourceAttributionId), node.node.id, "derived from", node.node.status, "canonical", attribution.evidence));
    }
    for (const model of frame.artifacts.models) this.addCharacterModel(builder, model, frame);
    for (const goal of frame.artifacts.goals) {
      const node = artifactNode(`goal:${goal.id}`, goal.id, "goal", goal.description, statusFrom(goal), "canonical", goal, goal.evidence, frame, {
        priority: goal.priority,
        actorId: goal.actorId,
        requiresKnowledge: goal.requiresKnowledge.length,
      }, undefined, characterGoalDescription(goal, frame));
      builder.artifact(node);
      builder.edge(link("actor-goal", entityId(goal.actorId), node.node.id, "pursues", node.node.status, "canonical", goal.evidence));
      for (const targetId of goal.targetIds ?? []) builder.edge(link("goal-target", node.node.id, entityId(targetId), "targets", node.node.status, "canonical", goal.evidence));
    }
  }

  private addCharacterModel(builder: GraphBuilder, model: CharacterModel, frame: ProjectionFrame): void {
    const modelEvidence = model.evidence;
    const actorName = displayEntityName(model.actorId, frame);
    const modelNode = artifactNode(`actor-model:${model.actorId}`, model.actorId, "character-model", `Model · ${actorName}`, "canonical", "canonical", model, modelEvidence, frame, {
      dispositions: model.dispositions?.length ?? 0,
      appraisals: model.appraisalEpisodes?.length ?? 0,
      developmentEpisodes: model.developmentEpisodes?.length ?? 0,
      relationships: (model.relationshipStances?.length ?? 0) + (model.relationshipObligations?.length ?? 0) + (model.relationshipChanges?.length ?? 0),
    }, undefined, characterModelDescription(model));
    builder.artifact(modelNode);
    builder.edge(link("actor-model", entityId(model.actorId), modelNode.node.id, "has model", "canonical", "canonical", modelEvidence));
    const semantics = [
      ...(model.dispositions ?? []).map((item) => ({ item, kind: "disposition", label: `${item.dimensionId} ${formatSigned(item.value)}` })),
      ...(model.appraisalEpisodes ?? []).map((item) => ({ item, kind: "appraisal", label: item.id })),
      ...(model.developmentEpisodes ?? []).map((item) => ({ item, kind: "development", label: item.id })),
      ...(model.relationshipStances ?? []).map((item) => ({ item, kind: "relationship-stance", label: `${item.dimensionId} ${formatSigned(item.value)}` })),
      ...(model.relationshipObligations ?? []).map((item) => ({ item, kind: "relationship-obligation", label: item.typeId })),
      ...(model.relationshipChanges ?? []).map((item) => ({ item, kind: "relationship-change", label: item.id })),
    ];
    for (const semantic of semantics) {
      const item = semantic.item;
      const evidence = "evidence" in item ? [...item.evidence] : modelEvidence;
      const id = `model-semantic:${semantic.kind}:${item.id}`;
      const node = artifactNode(id, item.id, semantic.kind, semantic.label, statusFrom(item), "canonical", item, evidence, frame, {
        actorId: model.actorId,
        confidence: "confidence" in item ? item.confidence : undefined,
      }, undefined, semanticDescription(semantic.kind, item));
      builder.artifact(node);
      builder.edge(link("model-semantic", modelNode.node.id, id, "defines", node.node.status, "canonical", evidence));
      if ("targetEntityId" in item && typeof item.targetEntityId === "string") builder.edge(link("semantic-target", id, entityId(item.targetEntityId), "targets", node.node.status, "canonical", evidence));
      if ("relationshipEntityId" in item && typeof item.relationshipEntityId === "string") builder.edge(link("semantic-relationship", id, entityId(item.relationshipEntityId), "relationship", node.node.status, "canonical", evidence));
    }
  }

  private buildEvents(builder: GraphBuilder, frame: ProjectionFrame): void {
    const visibleEvents = canonicalEventsForFrame(frame);
    const entityIds = new Set<string>();
    for (const event of visibleEvents) for (const id of event.participants) entityIds.add(id);
    for (const participation of frame.artifacts.eventParticipations) if (visibleEvents.some((event) => event.id === participation.eventId)) entityIds.add(participation.entityId);
    for (const entry of frame.history) for (const id of entry.event.participants) entityIds.add(id);
    for (const possibility of frame.artifacts.possibilities) for (const id of possibility.participants) entityIds.add(id);
    for (const entity of frame.artifacts.entities) if (entityIds.has(entity.id)) builder.artifact(entityNode(entity, frame));
    for (const event of visibleEvents) builder.artifact(eventNode(event, frame));
    const explicitParticipationKeys = new Set(frame.artifacts.eventParticipations.map((item) => `${item.eventId}:${item.entityId}`));
    for (const participation of frame.artifacts.eventParticipations) {
      if (!visibleEvents.some((event) => event.id === participation.eventId)) continue;
      builder.edge(link("participates-as", entityId(participation.entityId), canonicalEventId(participation.eventId), participation.role, statusFrom(participation), "canonical", participation.evidence, {
        presence: participation.presence,
        confidence: participation.confidence,
      }));
    }
    for (const event of visibleEvents) {
      for (const participantId of event.participants) {
        if (explicitParticipationKeys.has(`${event.id}:${participantId}`)) continue;
        builder.edge(link("participates", entityId(participantId), canonicalEventId(event.id), "participant", "canonical", "canonical", event.evidence));
      }
      for (const parentId of event.causalParents) builder.edge(link("canonical-causal-parent", canonicalEventId(parentId), canonicalEventId(event.id), "causes", "canonical", "canonical", event.evidence));
    }
    for (const relation of frame.artifacts.eventRelations) {
      if (!visibleEvents.some((event) => event.id === relation.fromEventId) || !visibleEvents.some((event) => event.id === relation.toEventId)) continue;
      builder.edge(link(`event-relation:${relation.id}`, canonicalEventId(relation.fromEventId), canonicalEventId(relation.toEventId), relation.type, statusFrom(relation), "canonical", [...relation.evidence, ...(relation.counterEvidence ?? [])], {
        relationId: relation.id,
        confidence: relation.confidence,
        mechanism: relation.mechanism,
      }, relation.id));
    }
    this.addCommittedHistory(builder, frame);
    for (const possibility of frame.artifacts.possibilities) {
      const node = possibilityNode(possibility, frame);
      builder.artifact(node);
      for (const participantId of possibility.participants) builder.edge(link("possibility-participant", entityId(participantId), node.node.id, "may participate", "possibility", "possibility", possibility.evidence));
      if (possibility.canonicalEventId && visibleEvents.some((event) => event.id === possibility.canonicalEventId)) builder.edge(link("possible-analogue", node.node.id, canonicalEventId(possibility.canonicalEventId), "canonical analogue", "possibility", "possibility", possibility.evidence));
    }
  }

  private addCommittedHistory(builder: GraphBuilder, frame: ProjectionFrame): void {
    for (const entry of frame.history) {
      const commitNode = artifactNode(`commit:${entry.commitId}`, entry.commitId, "world-commit", `Commit · step ${entry.event.logicalTime.step}`, "branch-committed", "branch", { commitId: entry.commitId, eventHash: entry.eventHash }, [], frame, {
        logicalStep: entry.event.logicalTime.step,
      }, entry.event.logicalTime.storyTime);
      const eventNodeValue = artifactNode(`committed-event:${entry.event.eventId}`, entry.event.eventId, "committed-event", entry.event.title, "branch-committed", "branch", entry.event, entry.event.evidence, frame, {
        logicalStep: entry.event.logicalTime.step,
        branchId: entry.event.branchId,
      }, entry.event.logicalTime.storyTime);
      builder.artifact(commitNode);
      builder.artifact(eventNodeValue);
      builder.edge(link("committed-in", eventNodeValue.node.id, commitNode.node.id, "committed in", "branch-committed", "branch", entry.event.evidence));
      for (const participantId of entry.event.participants) builder.edge(link("committed-participant", entityId(participantId), eventNodeValue.node.id, "participant", "branch-committed", "branch", entry.event.evidence));
      for (const parentId of entry.event.causalParents) builder.edge(link("runtime-causal-parent", `committed-event:${parentId}`, eventNodeValue.node.id, "causal parent", "branch-committed", "branch", entry.event.evidence));
      for (const canonicalId of entry.event.realizesCanonicalEventIds ?? []) builder.edge(link("realizes", eventNodeValue.node.id, canonicalEventId(canonicalId), "realizes", "branch-committed", "branch", entry.event.evidence));
      if (entry.event.canonicalAdaptation?.adaptedFromCanonicalEventId) builder.edge(link("adapted-from", eventNodeValue.node.id, canonicalEventId(entry.event.canonicalAdaptation.adaptedFromCanonicalEventId), "adapted from", "branch-committed", "branch", entry.event.evidence));
    }
    for (let index = 1; index < frame.history.length; index += 1) {
      builder.edge(link("commit-parent", `commit:${frame.history[index - 1]!.commitId}`, `commit:${frame.history[index]!.commitId}`, "next commit", "branch-committed", "branch", []));
    }
  }

  private buildPlaces(builder: GraphBuilder, frame: ProjectionFrame): void {
    for (const entity of frame.artifacts.entities.filter((item) => item.kind === "location")) builder.artifact(entityNode(entity, frame));
    for (const relation of frame.artifacts.spatialRelations) {
      const [sourceId, targetId] = spatialEndpoints(relation);
      const status: OntologyStatus = relation.status === "contested"
        ? "contested"
        : frame.scope.branchId
          ? frame.activeSpatialIds.has(relation.id) ? "active" : "inactive"
          : "canonical";
      builder.edge(link(`spatial:${relation.id}`, entityId(sourceId), entityId(targetId), relation.kind, status, "canonical", spatialRelationEvidence(relation), {
        relationId: relation.id,
        direction: relation.kind === "route" ? relation.direction : relation.kind === "adjacent" ? "two-way" : "contains",
        validStoryTime: relation.validStoryTime,
        requires: relation.requires,
        blockedWhen: relation.blockedWhen,
        establishedByEventIds: relation.establishedByEventIds,
        retiredByEventIds: relation.retiredByEventIds,
        modes: relation.kind === "route" ? relation.modes : undefined,
        duration: relation.kind === "route" ? relation.duration : undefined,
      }, relation.id, relation.validStoryTime));
    }
  }

  private buildRules(builder: GraphBuilder, frame: ProjectionFrame): void {
    const neededEntityIds = new Set<string>();
    const neededClaimIds = new Set<string>();
    for (const rule of frame.artifacts.rules) {
      if (isControlledWorldRule(rule)) {
        if (rule.authorityEntityId) neededEntityIds.add(rule.authorityEntityId);
        rule.jurisdictionEntityIds.forEach((id) => neededEntityIds.add(id));
        rule.knownByClaimIds.forEach((id) => neededClaimIds.add(id));
      }
      for (const predicate of rulePredicates(rule)) collectPredicateReferences(predicate, neededEntityIds, new Set());
    }
    for (const entity of frame.artifacts.entities.filter((item) => neededEntityIds.has(item.id))) builder.artifact(entityNode(entity, frame));
    for (const claim of frame.artifacts.claims.filter((item) => neededClaimIds.has(item.id))) builder.artifact(claimNode(claim, frame));
    for (const rule of frame.artifacts.rules) {
      const status: OntologyStatus = isControlledWorldRule(rule) && rule.status === "contested"
        ? "contested"
        : frame.scope.branchId
          ? frame.effectiveRuleIds.has(rule.id) ? "active" : "inactive"
          : "canonical";
      const node = artifactNode(ruleId(rule.id), rule.id, "world-rule", rule.name, status, "canonical", rule, worldRuleEvidence(rule), frame, {
        scope: rule.scope,
        kind: isControlledWorldRule(rule) ? rule.kind : "legacy",
        visibility: isControlledWorldRule(rule) ? rule.visibility : "legacy",
        priority: isControlledWorldRule(rule) ? rule.priority : undefined,
        inactiveReason: frame.inactiveRules.get(rule.id),
        clauses: isControlledWorldRule(rule) ? rule.clauses.length : (rule.requires?.length ?? 0) + (rule.forbids?.length ?? 0),
      }, isControlledWorldRule(rule) ? rule.validStoryTime : undefined);
      builder.artifact(node);
      if (isControlledWorldRule(rule)) {
        if (rule.authorityEntityId) builder.edge(link("rule-authority", entityId(rule.authorityEntityId), node.node.id, "authority", status, "canonical", rule.evidence));
        for (const id of rule.jurisdictionEntityIds) builder.edge(link("rule-jurisdiction", node.node.id, entityId(id), "jurisdiction", status, "canonical", rule.evidence));
        for (const id of rule.knownByClaimIds) builder.edge(link("rule-known-by", claimId(id), node.node.id, "grounds visibility", status, "canonical", rule.evidence));
        for (const id of rule.overridesRuleIds) builder.edge(link("rule-overrides", node.node.id, ruleId(id), "overrides", status, "canonical", rule.evidence));
      }
      const entityRefs = new Set<string>();
      const ruleRefs = new Set<string>();
      for (const predicate of rulePredicates(rule)) collectPredicateReferences(predicate, entityRefs, ruleRefs);
      for (const id of entityRefs) builder.edge(link("rule-predicate-entity", node.node.id, entityId(id), "constrains", status, "canonical", rule.evidence));
      for (const id of ruleRefs) builder.edge(link("rule-predicate-rule", node.node.id, ruleId(id), "depends on", status, "canonical", rule.evidence));
    }
  }

  private async buildProvenance(builder: GraphBuilder, frame: ProjectionFrame): Promise<void> {
    const sourceNode = artifactNode(`source:${frame.source.id}`, frame.source.id, "source", frame.source.title, "canonical", "evidence", frame.source, [], frame, {
      contentSha256: frame.source.contentSha256,
      bytes: frame.source.bytes,
      sourcePath: frame.source.sourcePath,
    });
    builder.artifact(sourceNode);
    const artifacts = [
      ...frame.artifacts.entities.map((item) => entityNode(item, frame)),
      ...frame.artifacts.propositions.map((item) => propositionNode(item, frame)),
      ...frame.artifacts.attributions.map((item) => attributionNode(item, frame)),
      ...frame.artifacts.claims.map((item) => claimNode(item, frame)),
      ...canonicalEventsForFrame(frame).map((item) => eventNode(item, frame)),
      ...frame.artifacts.eventParticipations.map((item) => artifactNode(`event-participation:${item.id}`, item.id, "event-participation", `${item.entityId} · ${item.role}`, statusFrom(item), "canonical", item, item.evidence, frame, { eventId: item.eventId, entityId: item.entityId, role: item.role })),
      ...frame.artifacts.eventRelations.map((item) => artifactNode(`event-relation:${item.id}`, item.id, "event-relation", `${item.fromEventId} ${item.type} ${item.toEventId}`, statusFrom(item), "canonical", item, [...item.evidence, ...(item.counterEvidence ?? [])], frame, { fromEventId: item.fromEventId, toEventId: item.toEventId, type: item.type })),
      ...frame.artifacts.spatialRelations.map((item) => artifactNode(`spatial-relation:${item.id}`, item.id, "spatial-relation", `${item.kind} · ${item.id}`, statusFrom(item), "canonical", item, spatialRelationEvidence(item), frame, { kind: item.kind, endpoints: spatialEndpoints(item) }, item.validStoryTime)),
      ...frame.artifacts.rules.map((item) => artifactNode(ruleId(item.id), item.id, "world-rule", item.name, statusFrom(item), "canonical", item, worldRuleEvidence(item), frame, { scope: item.scope })),
      ...frame.artifacts.models.map((item) => artifactNode(`actor-model:${item.actorId}`, item.actorId, "character-model", `Model · ${item.actorId}`, "canonical", "canonical", item, item.evidence, frame, {})),
      ...frame.artifacts.goals.map((item) => artifactNode(`goal:${item.id}`, item.id, "goal", item.description, statusFrom(item), "canonical", item, item.evidence, frame, {})),
      ...frame.artifacts.possibilities.map((item) => possibilityNode(item, frame)),
    ];
    // Branch views are pinned to their prepared snapshot. The mutable current
    // cache can belong to a later compiler revision, so it is never mixed in.
    const initial = frame.scope.branchId ? null : await new InitialWorldStore(this.root).get();
    if (initial && initial.evidence.some((item) => item.span.sourceId === frame.source.id)) {
      artifacts.push(artifactNode("initial-world:current", "initial-world", "initial-world", "Opening world", "canonical", "canonical", initial, initial.evidence, frame, {
        operations: initial.delta.operations.length,
      }));
    }
    for (const artifact of artifacts) {
      builder.artifact(artifact);
      this.addEvidence(builder, frame, artifact.node.id, artifact.evidence);
    }

    const proposalStore = new ProposalStore(this.root);
    for (const status of ["pending", "accepted", "rejected"] as const) {
      for (const summary of await proposalStore.list(status, frame.source.id)) {
        const envelope = await proposalStore.readEnvelope(status, summary.id);
        const evidence = proposalEvidence(envelope).filter((item) => item.span.sourceId === frame.source.id);
        const nodeStatus: OntologyStatus = status === "rejected" ? "rejected" : "proposal";
        const proposalNodeValue = artifactNode(`proposal:${summary.id}`, summary.id, `proposal:${summary.kind}`, `${summary.kind} · ${summary.id}`, nodeStatus, "proposal", envelope, evidence, frame, {
          proposalStatus: status,
          worker: summary.worker,
          createdAt: summary.createdAt,
        });
        builder.artifact(proposalNodeValue);
        this.addEvidence(builder, frame, proposalNodeValue.node.id, evidence);
        const workerId = `worker:${summary.worker}`;
        builder.artifact(artifactNode(workerId, summary.worker, "compiler-worker", summary.worker, "proposal", "proposal", { worker: summary.worker }, [], frame, {}));
        builder.edge(link("generated-by", workerId, proposalNodeValue.node.id, "generated", nodeStatus, "proposal", []));
        const targetId = proposalTargetNodeId(envelope);
        if (targetId) {
          if (!builder.hasNode(targetId)) {
            const payload = envelope.payload;
            // Accepted compiler output is canonical only when it is present in
            // the selected snapshot. A newer accepted proposal must not leak
            // into an older branch/commit projection as active world truth.
            builder.artifact(artifactNode(targetId, payloadIdentity(envelope) ?? summary.id, `artifact:${summary.kind}`, artifactLabel(envelope), nodeStatus, "proposal", payload, evidence, frame, {
              validationStatus: status,
              absentFromSelectedSnapshot: status === "accepted",
            }));
          }
          const validationId = `validation:${status}:${summary.id}`;
          const rejection = status === "rejected" ? await proposalStore.readRejection(summary.id) : null;
          builder.artifact(artifactNode(validationId, summary.id, "validation", status === "accepted" ? "Accepted validation" : status === "rejected" ? "Rejected validation" : "Awaiting validation", nodeStatus, "proposal", rejection ?? { status }, [], frame, {
            status,
            errors: rejection?.errors.length ?? 0,
          }));
          builder.edge(link("validated-by", proposalNodeValue.node.id, validationId, status, nodeStatus, "proposal", evidence));
          builder.edge(link("validation-result", validationId, targetId, status === "accepted" ? "committed artifact" : status === "rejected" ? "rejected artifact" : "candidate artifact", nodeStatus, "proposal", evidence));
        }
      }
    }
    this.addCommittedHistory(builder, frame);
  }

  private addEvidence(builder: GraphBuilder, frame: ProjectionFrame, artifactNodeId: string, evidence: readonly EvidenceRef[]): void {
    for (const reference of evidence.filter((item) => item.span.sourceId === frame.source.id)) {
      const key = contentHash(reference);
      const nodeId = `evidence:${key}`;
      builder.artifact(artifactNode(nodeId, key, "source-span", `Lines ${reference.span.startLine}–${reference.span.endLine}`, "canonical", "evidence", reference, [reference], frame, {
        strength: reference.strength,
        startLine: reference.span.startLine,
        endLine: reference.span.endLine,
        quoteHash: reference.span.quoteHash,
      }));
      builder.edge(link("supports", nodeId, artifactNodeId, reference.strength, "canonical", "evidence", [reference]));
      builder.edge(link("evidence-source", `source:${frame.source.id}`, nodeId, "contains span", "canonical", "evidence", [reference]));
    }
  }

  private async evidenceDetails(evidence: EvidenceRef[], sourcePromise: Promise<SourceDocument | null>): Promise<OntologyEvidence[]> {
    const source = await sourcePromise;
    const bytes = source ? await readSourceMaterial(this.root, source) : undefined;
    return evidence.map((reference) => {
      let excerpt: string | undefined;
      let excerptTruncated: boolean | undefined;
      if (bytes && reference.span.startByte !== undefined && reference.span.endByte !== undefined) {
        const slice = bytes.subarray(reference.span.startByte, reference.span.endByte);
        const bounded = slice.subarray(0, MAX_DETAIL_EXCERPT_BYTES);
        excerpt = new TextDecoder("utf-8", { fatal: false }).decode(bounded);
        if (bounded.byteLength < slice.byteLength) excerptTruncated = true;
      }
      return {
        sourceId: reference.span.sourceId,
        startLine: reference.span.startLine,
        endLine: reference.span.endLine,
        ...(reference.span.startByte !== undefined ? { startByte: reference.span.startByte } : {}),
        ...(reference.span.endByte !== undefined ? { endByte: reference.span.endByte } : {}),
        quoteHash: reference.span.quoteHash,
        strength: reference.strength,
        ...(excerpt !== undefined ? { excerpt } : {}),
        ...(excerptTruncated ? { excerptTruncated } : {}),
      };
    });
  }

  private sourceNotFound(sourceId: string) {
    return webError(404, "SOURCE_NOT_FOUND", `Unknown novel source '${sourceId}'.`, {
      kind: "after-refresh", discoveryEndpoint: "/api/v1/novels", copyField: "id", maxAttempts: 1,
    });
  }

  private branchNotFound(branchId: string) {
    return webError(404, "INSTANCE_NOT_FOUND", `Unknown world instance '${branchId}'.`, {
      kind: "after-refresh", discoveryEndpoint: "/api/v1/instances", copyField: "branchId", maxAttempts: 1,
    });
  }
}

class GraphBuilder {
  readonly payloads = new Map<string, unknown>();
  readonly evidence = new Map<string, EvidenceRef[]>();
  private readonly nodes = new Map<string, OntologyNode>();
  private readonly edges = new Map<string, OntologyEdge>();
  private readonly diagnostics: string[] = [];

  constructor(private readonly scope: OntologyScope, private readonly detailNodeId?: string) {}

  hasNode(id: string): boolean { return this.nodes.has(id); }

  artifact(value: { node: OntologyNode; payload: unknown; evidence: EvidenceRef[] }): void {
    const existing = this.nodes.get(value.node.id);
    if (existing && contentHash(existing) !== contentHash(value.node)) {
      this.diagnostics.push(`Node '${value.node.id}' was projected more than once with different summaries; the first projection won.`);
      return;
    }
    this.nodes.set(value.node.id, value.node);
    if (value.node.id === this.detailNodeId) {
      this.payloads.set(value.node.id, structuredClone(value.payload));
      this.evidence.set(value.node.id, structuredClone(value.evidence));
    }
  }

  edge(value: OntologyEdge): void {
    if (!this.edges.has(value.id)) this.edges.set(value.id, value);
  }

  finish(input: ValidatedOntologyProjectionInput): InternalProjection {
    const layerSet = new Set(this.scope.layers);
    const layerNodes = [...this.nodes.values()].filter((node) => layerSet.has(node.layer)).sort(compareNode);
    const layerIds = new Set(layerNodes.map((node) => node.id));
    const layerEdges = [...this.edges.values()]
      .filter((edge) => layerSet.has(edge.layer) && layerIds.has(edge.source) && layerIds.has(edge.target))
      .sort(compareEdge);
    const filteredNodes = filterNodes(layerNodes, input);
    const filteredIds = new Set(filteredNodes.map((node) => node.id));
    const filteredEdges = layerEdges.filter((edge) => filteredIds.has(edge.source) && filteredIds.has(edge.target));
    const allNodes = topologyOrder(filteredNodes, filteredEdges);
    const nodeIndex = new Map(allNodes.map((node, index) => [node.id, index]));
    const allEdges = [...filteredEdges].sort((left, right) => {
      const leftIndex = Math.max(nodeIndex.get(left.source) ?? 0, nodeIndex.get(left.target) ?? 0);
      const rightIndex = Math.max(nodeIndex.get(right.source) ?? 0, nodeIndex.get(right.target) ?? 0);
      return leftIndex - rightIndex || compareEdge(left, right);
    });
    const snapshotId = contentHash({
      scope: this.scope,
      search: input.search ?? null,
      kind: input.kind ?? null,
      status: input.status ?? null,
      nodes: allNodes.map((node) => [node.id, node.revisionHash ?? null, node.status]),
      edges: allEdges.map((edge) => [edge.id, edge.source, edge.target, edge.status]),
    });
    const endpoint = ontologyEndpoint(input);
    const offset = input.cursor ? decodeGraphCursor(input.cursor, snapshotId, endpoint) : 0;
    const graph = buildGraphPage({
      scope: this.scope,
      allNodes,
      allEdges,
      legend: legend(allNodes),
      facets: {
        kinds: counts(layerNodes.map((node) => node.kind)),
        statuses: counts(layerNodes.map((node) => node.status)),
        layers: counts(layerNodes.map((node) => node.layer)),
      },
      diagnostics: [...new Set(this.diagnostics)],
      snapshotId,
    }, input, offset);
    return { graph, allNodes, allEdges, payloads: this.payloads, evidence: this.evidence };
  }
}

function validateInput(input: OntologyProjectionInput) {
  const view = ontologyViewSchema.parse(input.view);
  const layers = input.layers?.length ? [...new Set(input.layers)] : defaultLayers(view);
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) throw webError(400, "ONTOLOGY_LIMIT_INVALID", `Ontology page limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`, { kind: "after-user-action" });
  const relationLimit = input.relationLimit ?? DEFAULT_RELATION_LIMIT;
  if (!Number.isInteger(relationLimit) || relationLimit < 1 || relationLimit > MAX_RELATION_LIMIT) throw webError(400, "ONTOLOGY_RELATION_LIMIT_INVALID", `Ontology relation limit must be an integer between 1 and ${MAX_RELATION_LIMIT}.`, { kind: "after-user-action" });
  return {
    sourceId: input.sourceId,
    view,
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(input.atCommit ? { atCommit: input.atCommit } : {}),
    includeCanonicalFuture: input.includeCanonicalFuture ?? false,
    layers,
    limit,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.search?.trim() ? { search: input.search.trim() } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.status ? { status: input.status } : {}),
    relationLimit,
  };
}

function filterNodes(nodes: readonly OntologyNode[], input: ValidatedOntologyProjectionInput): OntologyNode[] {
  const needle = input.search?.toLocaleLowerCase();
  return nodes.filter((node) => {
    if (input.kind && !matchesKindFilter(node.kind, input.kind)) return false;
    if (input.status && node.status !== input.status) return false;
    return !needle || `${node.label} ${node.id} ${node.artifactId} ${node.kind} ${node.status} ${node.layer}`
      .toLocaleLowerCase()
      .includes(needle);
  });
}

function matchesKindFilter(kind: string, filter: string): boolean {
  if (!filter.endsWith("*")) return kind === filter;
  const prefix = filter.slice(0, -1);
  return prefix.length > 0 && kind.startsWith(prefix);
}

function topologyOrder(nodes: readonly OntologyNode[], edges: readonly OntologyEdge[]): OntologyNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  const ranked = [...nodes].sort((left, right) =>
    (adjacency.get(right.id)?.size ?? 0) - (adjacency.get(left.id)?.size ?? 0) || compareNode(left, right));
  const unseen = new Set(ranked.map((node) => node.id));
  const ordered: OntologyNode[] = [];
  for (const root of ranked) {
    if (!unseen.delete(root.id)) continue;
    const queue = [root.id];
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index]!;
      const node = byId.get(id);
      if (node) ordered.push(node);
      const neighbors = [...(adjacency.get(id) ?? [])]
        .filter((candidate) => unseen.has(candidate))
        .sort((left, right) => {
          const leftNode = byId.get(left)!;
          const rightNode = byId.get(right)!;
          return (adjacency.get(right)?.size ?? 0) - (adjacency.get(left)?.size ?? 0)
            || compareNode(leftNode, rightNode);
        });
      for (const neighbor of neighbors) {
        if (!unseen.delete(neighbor)) continue;
        queue.push(neighbor);
      }
    }
  }
  return ordered;
}

type GraphCursor = { version: 1; snapshotId: string; offset: number };

function encodeGraphCursor(cursor: GraphCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeGraphCursor(value: string, snapshotId: string, endpoint: string): number {
  const cursor = readGraphCursor(value, endpoint);
  if (cursor.snapshotId !== snapshotId) throw staleGraphCursor(endpoint);
  return cursor.offset;
}

function readGraphCursor(value: string, endpoint: string): GraphCursor {
  let cursor: GraphCursor;
  try {
    cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as GraphCursor;
  } catch {
    throw invalidGraphCursor(endpoint);
  }
  if (cursor.version !== 1 || typeof cursor.snapshotId !== "string" || !/^[a-f0-9]{64}$/.test(cursor.snapshotId)
    || !Number.isInteger(cursor.offset) || cursor.offset < 0) {
    throw invalidGraphCursor(endpoint);
  }
  return cursor;
}

function projectionSignature(input: ValidatedOntologyProjectionInput): string {
  return contentHash({
    sourceId: input.sourceId,
    view: input.view,
    branchId: input.branchId ?? null,
    atCommit: input.atCommit ?? null,
    includeCanonicalFuture: input.includeCanonicalFuture,
    layers: [...input.layers].sort(),
    search: input.search ?? null,
    kind: input.kind ?? null,
    status: input.status ?? null,
  });
}

function graphPageFromCache(
  cached: CachedProjection,
  input: ValidatedOntologyProjectionInput,
  offset: number,
): OntologyGraph {
  return buildGraphPage({
    scope: cached.graph.scope,
    allNodes: cached.allNodes,
    allEdges: cached.allEdges,
    legend: cached.graph.legend,
    facets: cached.graph.facets,
    diagnostics: cached.graph.diagnostics.filter((message) => !message.startsWith("Loaded ")),
    snapshotId: cached.graph.page.snapshotId,
  }, input, offset);
}

type GraphPageSource = {
  scope: OntologyScope;
  allNodes: OntologyNode[];
  allEdges: OntologyEdge[];
  legend: OntologyGraph["legend"];
  facets: OntologyGraph["facets"];
  diagnostics: string[];
  snapshotId: string;
};

function buildGraphPage(source: GraphPageSource, input: ValidatedOntologyProjectionInput, offset: number): OntologyGraph {
  const endpoint = ontologyEndpoint(input);
  if (offset > source.allNodes.length) throw staleGraphCursor(endpoint);
  const nodeIndex = new Map(source.allNodes.map((node, index) => [node.id, index]));
  const end = Math.min(source.allNodes.length, offset + input.limit);
  const nodes = source.allNodes.slice(offset, end);

  // Each edge belongs to exactly one page: the page that introduces its later
  // endpoint. Merging sequential pages therefore produces a complete induced
  // graph for the loaded node prefix without repeating earlier edges.
  const edges: OntologyEdge[] = [];
  let loadedEdges = 0;
  for (const edge of source.allEdges) {
    const sourceIndex = nodeIndex.get(edge.source);
    const targetIndex = nodeIndex.get(edge.target);
    if (sourceIndex === undefined || targetIndex === undefined) continue;
    const introducedAt = Math.max(sourceIndex, targetIndex);
    if (introducedAt >= end) break;
    loadedEdges += 1;
    if (introducedAt >= offset) edges.push(edge);
  }
  const requiredNodeIds = [...new Set(edges.flatMap((edge) => [edge.source, edge.target])
    .filter((nodeId) => (nodeIndex.get(nodeId) ?? end) < offset))].sort();
  const nextCursor = end < source.allNodes.length
    ? encodeGraphCursor({ version: 1, snapshotId: source.snapshotId, offset: end })
    : null;
  const diagnostics = [...source.diagnostics];
  if (nextCursor) diagnostics.push(`Loaded ${end} of ${source.allNodes.length} nodes; relationships within the loaded prefix are complete and ${source.allEdges.length - loadedEdges} relation(s) remain deferred.`);
  return ontologyGraphSchema.parse({
    version: 1,
    scope: source.scope,
    nodes,
    edges,
    legend: source.legend,
    facets: source.facets,
    totalNodes: source.allNodes.length,
    totalEdges: source.allEdges.length,
    truncated: nextCursor !== null,
    page: {
      snapshotId: source.snapshotId,
      offset,
      limit: input.limit,
      newNodes: nodes.length,
      loadedNodes: end,
      loadedEdges,
      remainingEdges: Math.max(0, source.allEdges.length - loadedEdges),
      nextCursor,
      relationshipMode: "prefix-complete",
      requiredNodeIds,
    },
    diagnostics,
  });
}

function invalidGraphCursor(endpoint: string) {
  return webError(400, "ONTOLOGY_PAGE_CURSOR_INVALID", "The ontology page cursor is invalid for this projection. Read the first page, copy page.nextCursor exactly, and retry at most once; do not guess or retry unchanged.", {
    kind: "after-refresh",
    discoveryEndpoint: endpoint,
    copyField: "page.nextCursor",
    maxAttempts: 1,
  });
}

function staleGraphCursor(endpoint: string) {
  return webError(409, "ONTOLOGY_PAGE_CURSOR_STALE", "The ontology projection changed while pages were being read. Refresh the first page, copy page.nextCursor exactly, and retry at most once; do not reuse the stale cursor.", {
    kind: "after-refresh",
    discoveryEndpoint: endpoint,
    copyField: "page.nextCursor",
    maxAttempts: 1,
  });
}

function defaultLayers(view: OntologyView): OntologyLayer[] {
  if (view === "events") return ["canonical", "branch", "possibility"];
  if (view === "provenance") return ["canonical", "branch", "possibility", "proposal", "evidence"];
  return ["canonical", "branch"];
}

function artifactsFromContext(context: WorldModelContext): ArtifactSet {
  return {
    entities: [...context.entities.values()],
    propositions: [...(context.propositions?.values() ?? [])],
    attributions: [...(context.attributions?.values() ?? [])],
    claims: [...(context.claims?.values() ?? [])],
    events: [...(context.events?.values() ?? [])],
    eventParticipations: [...(context.eventParticipations ?? [])],
    eventRelations: [...(context.eventRelations ?? [])],
    spatialRelations: [...(context.spatialRelations ?? [])],
    rules: [...context.rules.values()],
    models: [...(context.actorModels?.values() ?? [])],
    goals: [...(context.actorGoals ?? [])],
    possibilities: [...(context.possibilityTemplates ?? [])],
  };
}

function artifactNode(
  id: string,
  artifactId: string,
  kind: string,
  label: string,
  status: OntologyStatus,
  layer: OntologyLayer,
  payload: unknown,
  evidence: readonly EvidenceRef[],
  frame: ProjectionFrame,
  summary: Record<string, unknown>,
  storyTime?: StoryTime,
  description?: string,
) {
  const localEvidence = evidence.filter((item) => item.span.sourceId === frame.source.id);
  const sourceIds = new Set(evidence.map((item) => item.span.sourceId));
  const query = new URLSearchParams({ sourceId: frame.source.id, view: frame.scope.view });
  if (frame.scope.branchId) query.set("branchId", frame.scope.branchId);
  if (frame.scope.atCommit) query.set("atCommit", frame.scope.atCommit);
  if (frame.scope.includeCanonicalFuture) query.set("includeCanonicalFuture", "true");
  const node: OntologyNode = {
    id,
    artifactId,
    kind,
    label,
    ...(description ? { description } : {}),
    status,
    layer,
    revisionHash: contentHash(payload),
    evidenceCount: localEvidence.length,
    shared: sourceIds.size > 1,
    ...(storyTime ? { storyTime: structuredClone(storyTime) } : {}),
    summary: withoutUndefined(summary),
    detailsEndpoint: `/api/v1/ontology/nodes/${encodeURIComponent(id)}?${query.toString()}`,
  };
  return { node, payload, evidence: [...evidence] };
}

function entityNode(entity: Entity, frame: ProjectionFrame) {
  const goals = frame.artifacts.goals.filter((goal) => goal.actorId === entity.id);
  const claims = frame.artifacts.claims.filter((claim) => claim.subject === entity.id || claim.speaker === entity.id);
  const propositions = frame.artifacts.propositions.filter((proposition) => proposition.subjectEntityId === entity.id);
  const model = frame.artifacts.models.find((candidate) => candidate.actorId === entity.id);
  const eventIds = new Set([
    ...frame.artifacts.events.filter((event) => event.participants.includes(entity.id)).map((event) => event.id),
    ...frame.artifacts.eventParticipations.filter((participation) => participation.entityId === entity.id).map((participation) => participation.eventId),
  ]);
  return artifactNode(entityId(entity.id), entity.id, `entity:${entity.kind}`, entity.canonicalName, "canonical", "canonical", entity, entity.evidence, frame, {
    entityKind: entity.kind,
    aliases: entity.aliases,
    claimCount: claims.length,
    propositionCount: propositions.length,
    goalCount: goals.length,
    eventCount: eventIds.size,
    hasCharacterModel: Boolean(model),
    dispositions: model?.dispositions?.map((item) => ({
      dimensionId: item.dimensionId,
      value: item.value,
      stability: item.stability,
      status: item.status,
      confidence: item.confidence,
    })),
  }, undefined, entityDescription(entity, frame, { goals: goals.length, claims, propositions: propositions.length, eventCount: eventIds.size, model }));
}

function propositionNode(proposition: Proposition, frame: ProjectionFrame) {
  const subjectName = displayEntityName(proposition.subjectEntityId, frame);
  const relation = readableIdentifier(proposition.relationId);
  const object = propositionObjectLabel(proposition, frame);
  const statement = [subjectName, relation, object].filter(Boolean).join(" · ");
  return artifactNode(propositionId(proposition.id), proposition.id, "proposition", `${subjectName} · ${relation}`, statusFrom(proposition), "canonical", proposition, proposition.evidence, frame, {
    polarity: proposition.polarity,
    modality: proposition.modality,
    relationId: proposition.relationId,
  }, proposition.validStoryTime, statement);
}

function attributionNode(attribution: Attribution, frame: ProjectionFrame) {
  const holder = attribution.holderEntityId ? displayEntityName(attribution.holderEntityId, frame) : readableIdentifier(attribution.holderKind);
  const attitude = readableIdentifier(attribution.attitude);
  return artifactNode(attributionId(attribution.id), attribution.id, "attribution", `${holder} · ${attitude}`, statusFrom(attribution), "canonical", attribution, attribution.evidence, frame, {
    holderKind: attribution.holderKind,
    holderEntityId: attribution.holderEntityId,
    attitude: attribution.attitude,
    certainty: attribution.certainty,
  }, undefined, `${holder} ${attitude}此命题 · 置信度 ${Math.round(attribution.certainty * 100)}%`);
}

function claimNode(claim: Claim, frame: ProjectionFrame) {
  const subjectName = displayEntityName(claim.subject, frame);
  const predicate = readableIdentifier(claim.predicate);
  const object = claimObjectLabel(claim.object, frame);
  const statement = [subjectName, predicate, object].filter(Boolean).join(" · ");
  return artifactNode(claimId(claim.id), claim.id, "claim", `${subjectName} · ${predicate}`, claim.epistemicType === "rumor" || claim.epistemicType === "interpretation" ? "contested" : "canonical", "canonical", claim, claim.evidence, frame, {
    epistemicType: claim.epistemicType,
    speaker: claim.speaker,
    predicate: claim.predicate,
  }, undefined, statement);
}

function eventNode(event: CanonicalEvent, frame: ProjectionFrame) {
  const future = Boolean(frame.scope.branchId && !frame.realizedCanonicalEventIds.has(event.id));
  return artifactNode(canonicalEventId(event.id), event.id, "canonical-event", event.title, future ? "possibility" : "canonical", future ? "possibility" : "canonical", event, event.evidence, frame, {
    participants: event.participants.length,
    confidence: event.confidence,
    narrativeOrder: event.narrativeContext?.discourseOrder,
    narrativeMode: event.narrativeContext?.mode,
    futureCanonicalReference: future,
  }, event.storyTime, event.readerSummary ?? `${event.participants.length} 个参与实体 · 置信度 ${Math.round(event.confidence * 100)}%`);
}

function possibilityNode(possibility: PossibilityTemplate, frame: ProjectionFrame) {
  return artifactNode(`possibility:${possibility.id}`, possibility.id, `possibility:${possibility.kind}`, possibility.title, "possibility", "possibility", possibility, possibility.evidence, frame, {
    kind: possibility.kind,
    pressure: possibility.pressure,
    relevance: possibility.relevance,
    canonicalEventId: possibility.canonicalEventId,
  }, possibility.candidateWindow, `${readableIdentifier(possibility.kind)} · 压力 ${possibility.pressure.toFixed(2)} · 相关性 ${possibility.relevance.toFixed(2)}`);
}

function displayEntityName(entityIdValue: string, frame: ProjectionFrame): string {
  return frame.artifacts.entities.find((entity) => entity.id === entityIdValue)?.canonicalName ?? readableIdentifier(entityIdValue);
}

function readableIdentifier(value: string): string {
  if (/[^\u0000-\u007f]/u.test(value)) return value;
  return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\s+/gu, " ").trim();
}

function propositionObjectLabel(proposition: Proposition, frame: ProjectionFrame): string | undefined {
  if (proposition.object.kind === "entity") return displayEntityName(proposition.object.entityId, frame);
  if (proposition.object.kind === "proposition") return readableIdentifier(proposition.object.propositionId);
  return primitiveLabel(proposition.object.value);
}

function claimObjectLabel(value: unknown, frame: ProjectionFrame): string | undefined {
  if (typeof value === "string") {
    const entity = frame.artifacts.entities.find((candidate) => candidate.id === value);
    return entity?.canonicalName ?? readableIdentifier(value);
  }
  return primitiveLabel(value);
}

function primitiveLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function entityDescription(
  entity: Entity,
  frame: ProjectionFrame,
  profile: {
    goals: number;
    claims: Claim[];
    propositions: number;
    eventCount: number;
    model?: CharacterModel;
  },
): string | undefined {
  if (entity.kind !== "character") return entity.aliases.length ? entity.aliases.join(" · ") : undefined;
  const highlights = profile.claims
    .filter((claim) => claim.subject === entity.id)
    .map((claim) => ({
      id: claim.id,
      value: [readableIdentifier(claim.predicate), claimObjectLabel(claim.object, frame)].filter(Boolean).join(" · "),
      score: claimHighlightScore(claim),
    }))
    .filter((item) => item.value.length >= 3 && item.value.length <= 96)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const unique: string[] = [];
  for (const highlight of highlights) {
    if (unique.includes(highlight.value)) continue;
    unique.push(highlight.value);
    if (unique.length === 2) break;
  }
  return unique.length ? unique.join("；") : entity.aliases.length ? entity.aliases.join(" · ") : undefined;
}

function claimHighlightScore(claim: Claim): number {
  const semantic = readableIdentifier(claim.predicate);
  const sourceGrounded = claim.epistemicType === "explicit-fact" || claim.epistemicType === "narrator-claim" ? 30 : 0;
  const naturalLanguage = /[^\u0000-\u007f]/u.test(semantic) ? 45 : 0;
  const concise = Math.max(0, 30 - Math.abs(semantic.length - 18));
  return sourceGrounded + naturalLanguage + concise;
}

function characterGoalDescription(goal: ArtifactSet["goals"][number], frame: ProjectionFrame): string {
  const targets = (goal.targetIds ?? []).map((targetId) => displayEntityName(targetId, frame));
  return [`Priority ${Math.round(goal.priority * 100)}%`, targets.length ? `Targets: ${targets.join(", ")}` : undefined]
    .filter(Boolean)
    .join(" · ");
}

function characterModelDescription(model: CharacterModel): string {
  return [
    `${model.dispositions?.length ?? 0} dispositions`,
    `${model.appraisalEpisodes?.length ?? 0} appraisals`,
    `${model.developmentEpisodes?.length ?? 0} development episodes`,
  ].join(" · ");
}

function semanticDescription(kind: string, value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (kind === "disposition" && typeof item.dimensionId === "string" && typeof item.value === "number") {
    return [readableIdentifier(item.dimensionId), formatSigned(item.value), typeof item.stability === "string" ? readableIdentifier(item.stability) : undefined]
      .filter(Boolean)
      .join(" · ");
  }
  if (typeof item.resultingIntention === "string") return item.resultingIntention;
  if (typeof item.label === "string") return item.label;
  return undefined;
}

function entityAssociations(
  root: OntologyNode,
  nodes: readonly OntologyNode[],
  edges: readonly OntologyEdge[],
): OntologyAssociation[] {
  if (!root.kind.startsWith("entity:")) return [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edgesByNode = new Map<string, OntologyEdge[]>();
  for (const edge of edges) {
    edgesByNode.set(edge.source, [...(edgesByNode.get(edge.source) ?? []), edge]);
    edgesByNode.set(edge.target, [...(edgesByNode.get(edge.target) ?? []), edge]);
  }
  const collected = new Map<string, {
    node: OntologyNode;
    relations: Set<string>;
    contexts: Set<string>;
    edgeIds: Set<string>;
    evidenceCount: number;
  }>();
  const add = (node: OntologyNode, relation: string, context: string | undefined, pathEdges: readonly OntologyEdge[]) => {
    if (node.id === root.id) return;
    const current = collected.get(node.id) ?? {
      node,
      relations: new Set<string>(),
      contexts: new Set<string>(),
      edgeIds: new Set<string>(),
      evidenceCount: 0,
    };
    if (relation) current.relations.add(relation);
    if (context && context !== relation) current.contexts.add(context);
    for (const edge of pathEdges) {
      if (current.edgeIds.has(edge.id)) continue;
      current.edgeIds.add(edge.id);
      current.evidenceCount += edge.evidenceCount;
    }
    collected.set(node.id, current);
  };

  for (const rootEdge of edgesByNode.get(root.id) ?? []) {
    const adjacentId = rootEdge.source === root.id ? rootEdge.target : rootEdge.source;
    const adjacent = nodesById.get(adjacentId);
    if (!adjacent) continue;
    if (adjacent.kind.startsWith("entity:")) {
      add(adjacent, readableIdentifier(rootEdge.label), undefined, [rootEdge]);
      continue;
    }
    if (!isAssociationBridge(adjacent.kind)) continue;
    for (const bridgeEdge of edgesByNode.get(adjacent.id) ?? []) {
      const candidateId = bridgeEdge.source === adjacent.id ? bridgeEdge.target : bridgeEdge.source;
      const candidate = nodesById.get(candidateId);
      if (!candidate?.kind.startsWith("entity:") || candidate.id === root.id) continue;
      add(
        candidate,
        associationRelation(adjacent, rootEdge, bridgeEdge),
        adjacent.description ?? adjacent.label,
        [rootEdge, bridgeEdge],
      );
    }
  }

  return [...collected.values()]
    .map(({ node, relations, contexts, evidenceCount }) => ({
      node,
      relationLabels: [...relations].slice(0, 6),
      contextLabels: [...contexts].slice(0, 4),
      evidenceCount,
    }))
    .filter((association) => association.relationLabels.length > 0)
    .sort((left, right) => {
      const leftCharacter = left.node.kind === "entity:character" ? 1 : 0;
      const rightCharacter = right.node.kind === "entity:character" ? 1 : 0;
      return rightCharacter - leftCharacter
        || right.relationLabels.length - left.relationLabels.length
        || left.node.label.localeCompare(right.node.label);
    })
    .slice(0, 100);
}

function isAssociationBridge(kind: string): boolean {
  return kind === "proposition"
    || kind === "claim"
    || kind === "goal"
    || kind === "entity:relationship"
    || kind.startsWith("relationship-");
}

function associationRelation(bridge: OntologyNode, first: OntologyEdge, second: OntologyEdge): string {
  if (bridge.kind === "goal") return bridge.label;
  const semantic = bridge.kind === "proposition" ? bridge.summary.relationId : bridge.kind === "claim" ? bridge.summary.predicate : undefined;
  if (typeof semantic === "string") return readableIdentifier(semantic);
  const label = first.label === "subject" || first.label === "object" || first.label === "targets" ? second.label : first.label;
  return readableIdentifier(label);
}

function link(
  key: string,
  source: string,
  target: string,
  label: string,
  status: OntologyStatus,
  layer: OntologyLayer,
  evidence: readonly EvidenceRef[],
  properties: Record<string, unknown> = {},
  stableId?: string,
  storyTime?: StoryTime,
): OntologyEdge {
  const id = `edge:${stableId ?? contentHash({ key, source, target, label }).slice(0, 24)}`;
  return {
    id,
    kind: key.split(":")[0]!,
    label,
    source,
    target,
    status,
    layer,
    evidenceCount: evidence.length,
    ...(storyTime ? { storyTime: structuredClone(storyTime) } : {}),
    properties: withoutUndefined(properties),
  };
}

function canonicalEventsForFrame(frame: ProjectionFrame): CanonicalEvent[] {
  if (!frame.scope.branchId || frame.scope.includeCanonicalFuture) return frame.artifacts.events;
  return frame.artifacts.events.filter((event) => frame.realizedCanonicalEventIds.has(event.id));
}

function statusFrom(value: unknown): OntologyStatus {
  if (value && typeof value === "object" && "status" in value && (value as { status?: string }).status === "contested") return "contested";
  return "canonical";
}

function proposalEvidence(envelope: Record<string, unknown>): EvidenceRef[] {
  const direct = Array.isArray(envelope.evidence)
    ? envelope.evidence.filter((item): item is EvidenceRef => Boolean(item && typeof item === "object" && "span" in item && "strength" in item))
    : [];
  const payload = compilerPayloadEvidence(envelope.payload);
  const assertions = Array.isArray(envelope.evidenceAssertions)
    ? envelope.evidenceAssertions.flatMap((candidate): EvidenceRef[] => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const assertion = candidate as Record<string, unknown>;
      const strength = assertion.strength;
      if (strength !== "explicit" && strength !== "strong-inference" && strength !== "weak-inference") return [];
      if (!Array.isArray(assertion.anchors)) return [];
      return assertion.anchors.flatMap((anchor): EvidenceRef[] => {
        if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return [];
        const value = anchor as Record<string, unknown>;
        if (typeof value.sourceId !== "string" || typeof value.startLine !== "number" || typeof value.endLine !== "number" || typeof value.exactHash !== "string") return [];
        return [{
          span: {
            sourceId: value.sourceId,
            startLine: value.startLine,
            endLine: value.endLine,
            ...(typeof value.startByte === "number" ? { startByte: value.startByte } : {}),
            ...(typeof value.endByte === "number" ? { endByte: value.endByte } : {}),
            quoteHash: value.exactHash,
          },
          strength,
        }];
      });
    })
    : [];
  const unique = new Map<string, EvidenceRef>();
  for (const reference of [...direct, ...payload, ...assertions]) unique.set(contentHash(reference), reference);
  return [...unique.values()];
}

function proposalTargetNodeId(envelope: Record<string, unknown>): string | undefined {
  const kind = typeof envelope.kind === "string" ? envelope.kind : undefined;
  const id = payloadIdentity(envelope);
  if (!kind || !id) return undefined;
  if (kind === "entity") return entityId(id);
  if (kind === "proposition") return propositionId(id);
  if (kind === "attribution") return attributionId(id);
  if (kind === "claim") return claimId(id);
  if (kind === "canonical-event") return canonicalEventId(id);
  if (kind === "event-participation") return `event-participation:${id}`;
  if (kind === "event-relation") return `event-relation:${id}`;
  if (kind === "spatial-relation") return `spatial-relation:${id}`;
  if (kind === "world-rule") return ruleId(id);
  if (kind === "character-model") return `actor-model:${id}`;
  if (kind === "character-goal") return `goal:${id}`;
  if (kind === "possibility") return `possibility:${id}`;
  if (kind === "initial-world") return "initial-world:current";
  return `artifact:${kind}:${id}`;
}

function payloadIdentity(envelope: Record<string, unknown>): string | undefined {
  const payload = envelope.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  return typeof record.id === "string" ? record.id : typeof record.actorId === "string" ? record.actorId : envelope.kind === "initial-world" ? "initial-world" : undefined;
}

function artifactLabel(envelope: Record<string, unknown>): string {
  const payload = envelope.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    for (const key of ["canonicalName", "title", "name", "description", "id", "actorId"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return typeof envelope.kind === "string" ? envelope.kind : "proposal artifact";
}

function rulePredicates(rule: WorldRule): Predicate[] {
  if (!isControlledWorldRule(rule)) return [...rule.appliesWhen, ...(rule.requires ?? []), ...(rule.forbids ?? [])];
  return [...rule.appliesWhen, ...rule.clauses.map((item) => item.predicate), ...rule.exceptions.flatMap((item) => item.appliesWhen)];
}

function collectPredicateReferences(predicate: Predicate, entityIds: Set<string>, ruleIds: Set<string>): void {
  if (predicate.op === "all" || predicate.op === "any") {
    predicate.items.forEach((item) => collectPredicateReferences(item, entityIds, ruleIds));
    return;
  }
  if (predicate.op === "not") {
    collectPredicateReferences(predicate.item, entityIds, ruleIds);
    return;
  }
  if ("entityId" in predicate) entityIds.add(predicate.entityId);
  if (predicate.op === "entity-in") entityIds.add(predicate.member);
  if (predicate.op === "rule-active") ruleIds.add(predicate.ruleId);
}

async function assertAncestor(headCommit: string, candidate: string, parentOf: (commitId: string) => Promise<string | undefined>): Promise<void> {
  const seen = new Set<string>();
  let cursor: string | undefined = headCommit;
  while (cursor) {
    if (cursor === candidate) return;
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = await parentOf(cursor);
  }
  throw webError(409, "ONTOLOGY_COMMIT_NOT_IN_BRANCH", `Commit '${candidate}' is not an ancestor of branch head '${headCommit}'.`, {
    kind: "after-refresh",
    discoveryEndpoint: "/api/v1/instances",
    copyField: "headCommitId",
    maxAttempts: 1,
  });
}

function isWebError(error: unknown): error is WebApplicationError {
  return error instanceof WebApplicationError;
}

function sanitizePayload(value: unknown, sourceId: string): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizePayload(item, sourceId));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "evidence" || key === "counterEvidence") && Array.isArray(nested)) {
      result[key] = nested.filter((item) => evidenceSourceId(item) === sourceId).map((item) => sanitizePayload(item, sourceId));
      continue;
    }
    if (key === "anchors" && Array.isArray(nested)) {
      result[key] = nested.filter((item) => anchorSourceId(item) === sourceId).map((item) => sanitizePayload(item, sourceId));
      continue;
    }
    result[key] = sanitizePayload(nested, sourceId);
  }
  return result;
}

function evidenceSourceId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const span = (value as Record<string, unknown>).span;
  return span && typeof span === "object" && !Array.isArray(span) && typeof (span as Record<string, unknown>).sourceId === "string"
    ? (span as Record<string, unknown>).sourceId as string
    : undefined;
}

function anchorSourceId(value: unknown): string | undefined {
  return value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).sourceId === "string"
    ? (value as Record<string, unknown>).sourceId as string
    : undefined;
}

function legend(nodes: OntologyNode[]) {
  const palette: Record<OntologyStatus, string> = {
    canonical: "#d6ff72",
    active: "#8fe388",
    inactive: "#64685f",
    "branch-committed": "#80b7d8",
    possibility: "#e8bb68",
    proposal: "#caa0d7",
    contested: "#ffb36f",
    rejected: "#ff8d7f",
  };
  return Object.entries(counts(nodes.map((node) => node.status))).map(([id, count]) => ({ id, label: id.replaceAll("-", " "), color: palette[id as OntologyStatus], count }));
}

function counts(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function compareNode(left: OntologyNode, right: OntologyNode): number {
  return left.layer.localeCompare(right.layer) || left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
}

function compareEdge(left: OntologyEdge, right: OntologyEdge): number {
  return left.layer.localeCompare(right.layer) || left.kind.localeCompare(right.kind) || left.source.localeCompare(right.source) || left.target.localeCompare(right.target) || left.id.localeCompare(right.id);
}

function defaultEvidence(value: unknown): readonly EvidenceRef[] {
  return value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as { evidence?: unknown }).evidence)
    ? (value as { evidence: EvidenceRef[] }).evidence
    : [];
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function formatSigned(value: number): string { return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`; }
function entityId(id: string): string { return `entity:${id}`; }
function propositionId(id: string): string { return `proposition:${id}`; }
function attributionId(id: string): string { return `attribution:${id}`; }
function claimId(id: string): string { return `claim:${id}`; }
function canonicalEventId(id: string): string { return `canonical-event:${id}`; }
function ruleId(id: string): string { return `rule:${id}`; }

function ontologyEndpoint(input: OntologyProjectionInput): string {
  const query = new URLSearchParams({ view: input.view });
  if (input.branchId) query.set("branchId", input.branchId);
  if (input.atCommit) query.set("atCommit", input.atCommit);
  if (input.includeCanonicalFuture) query.set("includeCanonicalFuture", "true");
  if (input.layers?.length) query.set("layers", input.layers.join(","));
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  if (input.search) query.set("search", input.search);
  if (input.kind) query.set("kind", input.kind);
  if (input.status) query.set("status", input.status);
  return `/api/v1/novels/${encodeURIComponent(input.sourceId)}/ontology?${query.toString()}`;
}

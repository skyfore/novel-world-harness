import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ActorModelStore, type ActorArtifactKind } from "./actors.js";
import { canonicalJson, contentHash } from "./canonical.js";
import { CanonicalModelStore, type CanonicalKind, type CanonicalRevisionRef } from "./canonical-model.js";
import type { WorldModelContext } from "./engine.js";
import { idSchema, stateFieldSpecSchema, type Attribution, type CanonicalEvent, type Claim, type Entity, type EventParticipation, type EventRelation, type EvidenceRef, type Proposition, type WorldRule } from "./model.js";
import { eventParticipationsByEvent, projectEventParticipations, validateEventParticipationCatalog } from "./event-semantics.js";
import { eventRelationsByTarget, projectEventRelations, validateEventRelationCatalog } from "./event-relations.js";
import { characterOntologyEvidence } from "./character-ontology.js";
import { validateSpatialRelationCatalog, type SpatialRelation } from "./spatial-ontology.js";
import { PossibilityTemplateStore, type PossibilityTemplate } from "./possibility-model.js";
import type { CharacterGoal, CharacterModel } from "./actors.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "./state.js";
import { worldStorageRoot } from "./paths.js";
import { assertEvidenceExclusiveToSource } from "./source-scope.js";

const revisionRefSchema = z.object({ id: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const validatePreparedSnapshotScope = (
  value: { sourceId?: string; preparedRevisionHash?: string },
  ctx: z.RefinementCtx,
) => {
  if (value.preparedRevisionHash && !value.sourceId) {
    ctx.addIssue({ code: "custom", path: ["preparedRevisionHash"], message: "A prepared revision hash requires sourceId" });
  }
};
export const canonicalSnapshotSchema = z.object({
  version: z.literal(8),
  sourceId: idSchema.optional(),
  preparedRevisionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  entities: z.array(revisionRefSchema),
  propositions: z.array(revisionRefSchema),
  attributions: z.array(revisionRefSchema),
  claims: z.array(revisionRefSchema),
  events: z.array(revisionRefSchema),
  eventParticipations: z.array(revisionRefSchema),
  eventRelations: z.array(revisionRefSchema),
  spatialRelations: z.array(revisionRefSchema),
  rules: z.array(revisionRefSchema),
  actorGoals: z.array(revisionRefSchema),
  actorModels: z.array(revisionRefSchema),
  possibilities: z.array(revisionRefSchema),
  stateFields: z.array(stateFieldSpecSchema),
}).strict().superRefine(validatePreparedSnapshotScope);
export type CanonicalSnapshot = z.infer<typeof canonicalSnapshotSchema>;

export type ScopedWorldArtifacts = {
  entities: readonly Entity[];
  propositions: readonly Proposition[];
  attributions: readonly Attribution[];
  claims: readonly Claim[];
  events: readonly CanonicalEvent[];
  eventParticipations: readonly EventParticipation[];
  eventRelations: readonly EventRelation[];
  spatialRelations: readonly SpatialRelation[];
  rules: readonly WorldRule[];
  goals: readonly CharacterGoal[];
  models: readonly CharacterModel[];
  possibilities: readonly PossibilityTemplate[];
};

export class WorldContextStore {
  readonly root: string;
  private readonly actors: ActorModelStore;
  private readonly possibilities: PossibilityTemplateStore;
  constructor(workspaceRoot: string, private readonly canon = new CanonicalModelStore(workspaceRoot)) {
    this.root = path.join(worldStorageRoot(workspaceRoot), "canon", "snapshots");
    this.actors = new ActorModelStore(workspaceRoot);
    this.possibilities = new PossibilityTemplateStore(workspaceRoot);
  }

  async captureCurrent(sourceId?: string): Promise<WorldModelContext> {
    const [entities, propositions, attributions, claims, events, eventParticipations, eventRelations, spatialRelations, rules, goals, models, possibilities] = await Promise.all([
      this.canon.listEntities(),
      this.canon.listPropositions(),
      this.canon.listAttributions(),
      this.canon.listClaims(),
      this.canon.listEvents(),
      this.canon.listEventParticipations(),
      this.canon.listEventRelations(),
      this.canon.listSpatialRelations(),
      this.canon.listRules(),
      this.actors.listGoals(),
      this.actors.listModels(),
      this.possibilities.list(),
    ]);
    const belongsToSource = (item: { evidence: readonly { span: { sourceId: string } }[] }) =>
      !sourceId || item.evidence.some((reference) => reference.span.sourceId === sourceId);
    const artifacts: ScopedWorldArtifacts = {
      entities: entities.filter(belongsToSource),
      propositions: propositions.filter(belongsToSource),
      attributions: attributions.filter(belongsToSource),
      claims: claims.filter(belongsToSource),
      events: events.filter(belongsToSource),
      eventParticipations: eventParticipations.filter(belongsToSource),
      eventRelations: eventRelations.filter(belongsToSource),
      spatialRelations: spatialRelations.filter(belongsToSource),
      rules: rules.filter(belongsToSource),
      goals: goals.filter(belongsToSource),
      models: models.filter(belongsToSource),
      possibilities: possibilities.filter(belongsToSource),
    };
    return this.captureArtifacts(artifacts, sourceId);
  }

  async capturePrepared(
    sourceId: string,
    preparedRevisionHash: string,
    artifacts: ScopedWorldArtifacts,
  ): Promise<WorldModelContext> {
    if (!/^[a-f0-9]{64}$/.test(preparedRevisionHash)) throw new Error(`Invalid prepared revision hash: ${preparedRevisionHash}`);
    assertEventParticipationProjection(artifacts);
    assertEventRelationProjection(artifacts);
    assertSpatialProjection(artifacts);
    await Promise.all([
      ...artifacts.entities.map((item) => this.canon.ensureEntityRevision(item)),
      ...artifacts.propositions.map((item) => this.canon.ensurePropositionRevision(item)),
      ...artifacts.attributions.map((item) => this.canon.ensureAttributionRevision(item)),
      ...artifacts.claims.map((item) => this.canon.ensureClaimRevision(item)),
      ...artifacts.events.map((item) => this.canon.ensureEventRevision(item)),
      ...artifacts.eventParticipations.map((item) => this.canon.ensureEventParticipationRevision(item)),
      ...artifacts.eventRelations.map((item) => this.canon.ensureEventRelationRevision(item)),
      ...artifacts.spatialRelations.map((item) => this.canon.ensureSpatialRelationRevision(item)),
      ...artifacts.rules.map((item) => this.canon.ensureRuleRevision(item)),
      ...artifacts.goals.map((item) => this.actors.ensureGoalRevision(item)),
      ...artifacts.models.map((item) => this.actors.ensureModelRevision(item)),
      ...artifacts.possibilities.map((item) => this.possibilities.ensureRevision(item)),
    ]);
    return this.captureArtifacts(artifacts, sourceId, preparedRevisionHash, true);
  }

  private async captureArtifacts(
    artifacts: ScopedWorldArtifacts,
    sourceId?: string,
    preparedRevisionHash?: string,
    refsFromContent = false,
  ): Promise<WorldModelContext> {
    assertEventParticipationProjection(artifacts);
    assertEventRelationProjection(artifacts);
    assertSpatialProjection(artifacts);
    if (sourceId) {
      assertArtifactCollectionsExclusiveToSource(sourceId, [
        artifacts.entities,
        artifacts.propositions,
        artifacts.attributions,
        artifacts.claims,
        artifacts.events,
        artifacts.eventParticipations,
        artifacts.eventRelations,
        artifacts.spatialRelations,
        artifacts.rules,
        artifacts.goals,
        artifacts.models,
        artifacts.possibilities,
      ]);
    }
    const canonicalRefs = async <T extends { id: string }>(kind: CanonicalKind, items: readonly T[]) =>
      refsFromContent
        ? items.map((item) => ({ id: item.id, hash: contentHash(item) })).sort((left, right) => left.id.localeCompare(right.id))
        : this.refs(kind, items.map((item) => item.id));
    const actorRefs = async <T>(kind: ActorArtifactKind, items: readonly T[], idOf: (item: T) => string) =>
      refsFromContent
        ? items.map((item) => ({ id: idOf(item), hash: contentHash(item) })).sort((left, right) => left.id.localeCompare(right.id))
        : this.actorRefs(kind, items.map(idOf));
    const possibilityRefs = async (items: readonly PossibilityTemplate[]) =>
      refsFromContent
        ? items.map((item) => ({ id: item.id, hash: contentHash(item) })).sort((left, right) => left.id.localeCompare(right.id))
        : this.possibilityRefs(items.map((item) => item.id));
    const snapshot = canonicalSnapshotSchema.parse({
      version: 8,
      ...(sourceId ? { sourceId } : {}),
      ...(preparedRevisionHash ? { preparedRevisionHash } : {}),
      entities: await canonicalRefs("entities", artifacts.entities),
      propositions: await canonicalRefs("propositions", artifacts.propositions),
      attributions: await canonicalRefs("attributions", artifacts.attributions),
      claims: await canonicalRefs("claims", artifacts.claims),
      events: await canonicalRefs("events", artifacts.events),
      eventParticipations: await canonicalRefs("event-participations", artifacts.eventParticipations),
      eventRelations: await canonicalRefs("event-relations", artifacts.eventRelations),
      spatialRelations: await canonicalRefs("spatial-relations", artifacts.spatialRelations),
      rules: await canonicalRefs("rules", artifacts.rules),
      actorGoals: await actorRefs("goals", artifacts.goals, (item) => item.id),
      actorModels: await actorRefs("models", artifacts.models, (item) => item.actorId),
      possibilities: await possibilityRefs(artifacts.possibilities),
      stateFields: DEFAULT_STATE_FIELDS,
    });
    const snapshotHash = contentHash(snapshot);
    await this.writeSnapshot(snapshotHash, snapshot);
    return this.hydrate(snapshotHash, snapshot);
  }

  async load(snapshotHash: string): Promise<WorldModelContext> {
    if (!/^[a-f0-9]{64}$/.test(snapshotHash)) throw new Error(`Invalid canonical snapshot hash: ${snapshotHash}`);
    const snapshot = canonicalSnapshotSchema.parse(JSON.parse(await fs.readFile(path.join(this.root, `${snapshotHash}.json`), "utf8")));
    if (contentHash(snapshot) !== snapshotHash) throw new Error(`Corrupt canonical snapshot ${snapshotHash}`);
    return this.hydrate(snapshotHash, snapshot);
  }

  private async refs(kind: CanonicalKind, ids: string[]): Promise<CanonicalRevisionRef[]> {
    const refs = await Promise.all(ids.map(async (id) => {
      const revision = await this.canon.currentRevision(kind, id);
      if (!revision) throw new Error(`Canonical ${kind} artifact disappeared while capturing snapshot: ${id}`);
      return revision;
    }));
    return refs.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async actorRefs(kind: ActorArtifactKind, ids: string[]): Promise<CanonicalRevisionRef[]> {
    const refs = await Promise.all(ids.map(async (id) => {
      const revision = await this.actors.currentRevision(kind, id);
      if (!revision) throw new Error(`Actor ${kind} artifact disappeared while capturing snapshot: ${id}`);
      return revision;
    }));
    return refs.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async possibilityRefs(ids: string[]): Promise<CanonicalRevisionRef[]> {
    const refs = await Promise.all(ids.map(async (id) => {
      const revision = await this.possibilities.currentRevision(id);
      if (!revision) throw new Error(`Possibility disappeared while capturing snapshot: ${id}`);
      return revision;
    }));
    return refs.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async hydrate(snapshotHash: string, snapshot: CanonicalSnapshot): Promise<WorldModelContext> {
    const [entities, propositions, attributions, claims, events, eventParticipations, eventRelations, spatialRelations, rules, actorGoals, actorModels, possibilities] = await Promise.all([
      Promise.all(snapshot.entities.map((ref) => this.canon.getEntityRevision(ref.id, ref.hash))),
      Promise.all(snapshot.propositions.map((ref) => this.canon.getPropositionRevision(ref.id, ref.hash))),
      Promise.all(snapshot.attributions.map((ref) => this.canon.getAttributionRevision(ref.id, ref.hash))),
      Promise.all(snapshot.claims.map((ref) => this.canon.getClaimRevision(ref.id, ref.hash))),
      Promise.all(snapshot.events.map((ref) => this.canon.getEventRevision(ref.id, ref.hash))),
      Promise.all(snapshot.eventParticipations.map((ref) => this.canon.getEventParticipationRevision(ref.id, ref.hash))),
      Promise.all(snapshot.eventRelations.map((ref) => this.canon.getEventRelationRevision(ref.id, ref.hash))),
      Promise.all(snapshot.spatialRelations.map((ref) => this.canon.getSpatialRelationRevision(ref.id, ref.hash))),
      Promise.all(snapshot.rules.map((ref) => this.canon.getRuleRevision(ref.id, ref.hash))),
      Promise.all(snapshot.actorGoals.map((ref) => this.actors.getGoalRevision(ref.id, ref.hash))),
      Promise.all(snapshot.actorModels.map((ref) => this.actors.getModelRevision(ref.id, ref.hash))),
      Promise.all(snapshot.possibilities.map((ref) => this.possibilities.getRevision(ref.id, ref.hash))),
    ]);
    if (snapshot.sourceId) {
      assertArtifactCollectionsExclusiveToSource(snapshot.sourceId, [
        entities,
        propositions,
        attributions,
        claims,
        events,
        eventParticipations,
        eventRelations,
        spatialRelations,
        rules,
        actorGoals,
        actorModels,
        possibilities,
      ]);
    }
    assertEventParticipationProjection({ entities, events, eventParticipations });
    assertEventRelationProjection({ events, eventRelations });
    assertSpatialProjection({ entities, events, claims, rules, spatialRelations });
    const participationIndex = eventParticipationsByEvent(eventParticipations);
    const relationIndex = eventRelationsByTarget(eventRelations);
    const projectedEvents = events.map((event) => projectEventRelations(
      projectEventParticipations(event, participationIndex.get(event.id) ?? []),
      relationIndex.get(event.id) ?? [],
    ));
    return {
      canonicalSnapshotHash: snapshotHash,
      ...(snapshot.sourceId ? { sourceId: snapshot.sourceId } : {}),
      ...(snapshot.preparedRevisionHash ? { preparedRevisionHash: snapshot.preparedRevisionHash } : {}),
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      propositions: new Map(propositions.map((proposition) => [proposition.id, proposition])),
      attributions: new Map(attributions.map((attribution) => [attribution.id, attribution])),
      claims: new Map(claims.map((claim) => [claim.id, claim])),
      events: new Map(projectedEvents.map((event) => [event.id, event])),
      eventParticipations,
      eventRelations,
      spatialOntologyVersion: "spatial-v1",
      spatialRelations,
      rules: new Map(rules.map((rule) => [rule.id, rule])),
      actorGoals,
      actorModels: new Map(actorModels.map((model) => [model.actorId, model])),
      possibilityTemplates: possibilities,
      stateSchema: new StateSchemaRegistry(snapshot.stateFields),
    };
  }

  private async writeSnapshot(snapshotHash: string, snapshot: CanonicalSnapshot): Promise<void> {
    const filePath = path.join(this.root, `${snapshotHash}.json`);
    const serialized = `${canonicalJson(snapshot)}\n`;
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await fs.readFile(filePath, "utf8")) !== serialized) throw new Error(`Canonical snapshot already exists with different content: ${snapshotHash}`);
    }
  }
}

function assertEventParticipationProjection(
  artifacts: Pick<ScopedWorldArtifacts, "entities" | "events" | "eventParticipations">,
): void {
  const issues = validateEventParticipationCatalog({
    entities: new Map(artifacts.entities.map((item) => [item.id, item])),
    events: new Map(artifacts.events.map((item) => [item.id, item])),
    participations: artifacts.eventParticipations,
  });
  if (issues.length) {
    throw new Error(`Invalid typed event participation projection: ${issues.map((item) => `${item.code} at ${item.path ?? "payload"}: ${item.message}`).join("; ")}`);
  }
}

function assertEventRelationProjection(
  artifacts: Pick<ScopedWorldArtifacts, "events" | "eventRelations">,
): void {
  const issues = validateEventRelationCatalog({
    events: new Map(artifacts.events.map((item) => [item.id, item])),
    relations: artifacts.eventRelations,
  });
  if (issues.length) {
    throw new Error(`Invalid typed event relation projection: ${issues.map((item) => `${item.code} at ${item.path ?? "payload"}: ${item.message}`).join("; ")}`);
  }
}

function assertSpatialProjection(
  artifacts: Pick<ScopedWorldArtifacts, "entities" | "events" | "claims" | "rules" | "spatialRelations">,
): void {
  const issues = validateSpatialRelationCatalog(artifacts.spatialRelations, {
    entities: new Map(artifacts.entities.map((item) => [item.id, item])),
    events: new Map(artifacts.events.map((item) => [item.id, item])),
    claims: new Set(artifacts.claims.map((item) => item.id)),
    rules: new Set(artifacts.rules.map((item) => item.id)),
  });
  if (issues.length) {
    throw new Error(`Invalid spatial relation projection: ${issues.map((item) => `${item.code} at ${item.path ?? "payload"}: ${item.message}`).join("; ")}`);
  }
}

function assertArtifactCollectionsExclusiveToSource(
  sourceId: string,
  collections: Array<readonly ({ id?: string; actorId?: string; evidence: readonly EvidenceRef[]; counterEvidence?: readonly EvidenceRef[] })[]>,
): void {
  for (const items of collections) {
    for (const item of items) {
      assertEvidenceExclusiveToSource(
        [...item.evidence, ...(item.counterEvidence ?? []), ...characterOntologyEvidence(item)],
        sourceId,
        `World snapshot artifact ${item.id ?? item.actorId ?? "unknown"}`,
      );
    }
  }
}

export async function loadWorldContext(
  workspaceRoot: string,
  options: {
    sourceId?: string;
    preparedRevisionHash?: string;
    artifacts?: ScopedWorldArtifacts;
  } = {},
): Promise<{
  canon: CanonicalModelStore;
  contexts: WorldContextStore;
  context: WorldModelContext;
}> {
  const canon = new CanonicalModelStore(workspaceRoot);
  const contexts = new WorldContextStore(workspaceRoot, canon);
  const context = options.sourceId && options.preparedRevisionHash && options.artifacts
    ? await contexts.capturePrepared(options.sourceId, options.preparedRevisionHash, options.artifacts)
    : await contexts.captureCurrent(options.sourceId);
  return { canon, contexts, context };
}

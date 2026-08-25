import fs from "node:fs/promises";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { z } from "zod";
import { ActorModelStore, type ActorArtifactKind } from "./actors.js";
import { canonicalJson, contentHash } from "./canonical.js";
import { CanonicalModelStore, type CanonicalKind, type CanonicalRevisionRef } from "./canonical-model.js";
import type { WorldModelContext } from "./engine.js";
import { idSchema, stateFieldSpecSchema, type Attribution, type CanonicalEvent, type Claim, type Entity, type EventParticipation, type EvidenceRef, type Proposition, type WorldRule } from "./model.js";
import { eventParticipationsByEvent, projectEventParticipations, validateEventParticipationCatalog } from "./event-semantics.js";
import { PossibilityTemplateStore, type PossibilityTemplate } from "./possibility-model.js";
import type { CharacterGoal, CharacterModel } from "./actors.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "./state.js";
import { BranchStore, WorldObjectStore } from "./store.js";
import { assertEvidenceExclusiveToSource, evidenceSourceIds } from "./source-scope.js";

const revisionRefSchema = z.object({ id: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const canonicalSnapshotV1Schema = z.object({
  version: z.literal(1),
  entities: z.array(revisionRefSchema),
  claims: z.array(revisionRefSchema),
  events: z.array(revisionRefSchema),
  rules: z.array(revisionRefSchema),
  stateFields: z.array(stateFieldSpecSchema),
}).strict();
const policySnapshotSchema = z.object({
  actorGoals: z.array(revisionRefSchema),
  actorModels: z.array(revisionRefSchema),
  possibilities: z.array(revisionRefSchema),
}).strict();
const canonicalSnapshotV2Schema = canonicalSnapshotV1Schema.omit({ version: true }).extend({
  version: z.literal(2),
  actorGoals: policySnapshotSchema.shape.actorGoals,
  actorModels: policySnapshotSchema.shape.actorModels,
  possibilities: policySnapshotSchema.shape.possibilities,
}).strict();
const canonicalSnapshotV3Schema = canonicalSnapshotV2Schema.omit({ version: true }).extend({
  version: z.literal(3),
  sourceId: idSchema,
  preparedRevisionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
const canonicalSnapshotV4BaseSchema = canonicalSnapshotV2Schema.omit({ version: true }).extend({
  version: z.literal(4),
  propositions: z.array(revisionRefSchema),
  attributions: z.array(revisionRefSchema),
  sourceId: idSchema.optional(),
  preparedRevisionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
const validatePreparedSnapshotScope = (
  value: { sourceId?: string; preparedRevisionHash?: string },
  ctx: z.RefinementCtx,
) => {
  if (value.preparedRevisionHash && !value.sourceId) {
    ctx.addIssue({ code: "custom", path: ["preparedRevisionHash"], message: "A prepared revision hash requires sourceId" });
  }
};
const canonicalSnapshotV4Schema = canonicalSnapshotV4BaseSchema.superRefine(validatePreparedSnapshotScope);
const canonicalSnapshotV5Schema = canonicalSnapshotV4BaseSchema.omit({ version: true }).extend({
  version: z.literal(5),
  eventParticipations: z.array(revisionRefSchema),
}).strict().superRefine(validatePreparedSnapshotScope);
const canonicalSnapshotSchema = z.union([canonicalSnapshotV1Schema, canonicalSnapshotV2Schema, canonicalSnapshotV3Schema, canonicalSnapshotV4Schema, canonicalSnapshotV5Schema]);
const legacyPolicySupplementSchema = policySnapshotSchema.extend({ version: z.literal(1) }).strict();
export type CanonicalSnapshot = z.infer<typeof canonicalSnapshotSchema>;

export type ScopedWorldArtifacts = {
  entities: readonly Entity[];
  propositions: readonly Proposition[];
  attributions: readonly Attribution[];
  claims: readonly Claim[];
  events: readonly CanonicalEvent[];
  eventParticipations: readonly EventParticipation[];
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
    this.root = path.join(workspaceStateDir(workspaceRoot), "world", "v1", "canon", "snapshots");
    this.actors = new ActorModelStore(workspaceRoot);
    this.possibilities = new PossibilityTemplateStore(workspaceRoot);
  }

  async captureCurrent(sourceId?: string): Promise<WorldModelContext> {
    const [entities, propositions, attributions, claims, events, eventParticipations, rules, goals, models, possibilities] = await Promise.all([
      this.canon.listEntities(),
      this.canon.listPropositions(),
      this.canon.listAttributions(),
      this.canon.listClaims(),
      this.canon.listEvents(),
      this.canon.listEventParticipations(),
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
    await Promise.all([
      ...artifacts.entities.map((item) => this.canon.ensureEntityRevision(item)),
      ...artifacts.propositions.map((item) => this.canon.ensurePropositionRevision(item)),
      ...artifacts.attributions.map((item) => this.canon.ensureAttributionRevision(item)),
      ...artifacts.claims.map((item) => this.canon.ensureClaimRevision(item)),
      ...artifacts.events.map((item) => this.canon.ensureEventRevision(item)),
      ...artifacts.eventParticipations.map((item) => this.canon.ensureEventParticipationRevision(item)),
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
    if (sourceId) {
      assertArtifactCollectionsExclusiveToSource(sourceId, [
        artifacts.entities,
        artifacts.propositions,
        artifacts.attributions,
        artifacts.claims,
        artifacts.events,
        artifacts.eventParticipations,
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
      version: 5,
      ...(sourceId ? { sourceId } : {}),
      ...(preparedRevisionHash ? { preparedRevisionHash } : {}),
      entities: await canonicalRefs("entities", artifacts.entities),
      propositions: await canonicalRefs("propositions", artifacts.propositions),
      attributions: await canonicalRefs("attributions", artifacts.attributions),
      claims: await canonicalRefs("claims", artifacts.claims),
      events: await canonicalRefs("events", artifacts.events),
      eventParticipations: await canonicalRefs("event-participations", artifacts.eventParticipations),
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

  async pinLegacySnapshot(snapshotHash: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(snapshotHash)) throw new Error(`Invalid canonical snapshot hash: ${snapshotHash}`);
    const snapshot = canonicalSnapshotSchema.parse(JSON.parse(await fs.readFile(path.join(this.root, `${snapshotHash}.json`), "utf8")));
    if (contentHash(snapshot) !== snapshotHash) throw new Error(`Corrupt canonical snapshot ${snapshotHash}`);
    if (snapshot.version !== 1 || await this.readLegacySupplement(snapshotHash)) return;
    const [goals, models, possibilities, snapshotEntities, snapshotEvents, snapshotClaims, snapshotRules] = await Promise.all([
      this.actors.listGoals(),
      this.actors.listModels(),
      this.possibilities.list(),
      Promise.all(snapshot.entities.map((ref) => this.canon.getEntityRevision(ref.id, ref.hash))),
      Promise.all(snapshot.events.map((ref) => this.canon.getEventRevision(ref.id, ref.hash))),
      Promise.all(snapshot.claims.map((ref) => this.canon.getClaimRevision(ref.id, ref.hash))),
      Promise.all(snapshot.rules.map((ref) => this.canon.getRuleRevision(ref.id, ref.hash))),
    ]);
    const entityIds = new Set(snapshotEntities.map((entity) => entity.id));
    const characterIds = new Set(snapshotEntities.filter((entity) => entity.kind === "character").map((entity) => entity.id));
    const eventIds = new Set(snapshotEvents.map((event) => event.id));
    const snapshotSourceIds = new Set(evidenceSourceIds([
      ...snapshotEntities.flatMap((item) => item.evidence),
      ...snapshotEvents.flatMap((item) => item.evidence),
      ...snapshotClaims.flatMap((item) => item.evidence),
      ...snapshotRules.flatMap((item) => item.evidence),
    ]));
    const evidenceFitsLegacySnapshot = (evidence: readonly EvidenceRef[]) => !snapshotSourceIds.size
      || (evidence.length > 0 && evidence.every((reference) => snapshotSourceIds.has(reference.span.sourceId)));
    const scopedGoals = goals.filter((goal) => characterIds.has(goal.actorId) && evidenceFitsLegacySnapshot(goal.evidence));
    const scopedModels = models.filter((model) => characterIds.has(model.actorId) && evidenceFitsLegacySnapshot(model.evidence));
    const scopedPossibilities = possibilities.filter((possibility) =>
      possibility.participants.every((participantId) => entityIds.has(participantId))
      && possibility.causalParents.every((eventId) => eventIds.has(eventId))
      && (!possibility.canonicalEventId || eventIds.has(possibility.canonicalEventId))
      && evidenceFitsLegacySnapshot(possibility.evidence));
    const supplement = legacyPolicySupplementSchema.parse({
      version: 1,
      actorGoals: await this.actorRefs("goals", scopedGoals.map((item) => item.id)),
      actorModels: await this.actorRefs("models", scopedModels.map((item) => item.actorId)),
      possibilities: await this.possibilityRefs(scopedPossibilities.map((item) => item.id)),
    });
    await this.writeImmutable(path.join(this.root, "supplements", `${snapshotHash}.json`), supplement);
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
    const policies = snapshot.version === 1 ? await this.readLegacySupplement(snapshotHash) : snapshot;
    const [entities, propositions, attributions, claims, events, eventParticipations, rules, actorGoals, actorModels, possibilities] = await Promise.all([
      Promise.all(snapshot.entities.map((ref) => this.canon.getEntityRevision(ref.id, ref.hash))),
      snapshot.version === 4 || snapshot.version === 5 ? Promise.all(snapshot.propositions.map((ref) => this.canon.getPropositionRevision(ref.id, ref.hash))) : [],
      snapshot.version === 4 || snapshot.version === 5 ? Promise.all(snapshot.attributions.map((ref) => this.canon.getAttributionRevision(ref.id, ref.hash))) : [],
      Promise.all(snapshot.claims.map((ref) => this.canon.getClaimRevision(ref.id, ref.hash))),
      Promise.all(snapshot.events.map((ref) => this.canon.getEventRevision(ref.id, ref.hash))),
      snapshot.version === 5 ? Promise.all(snapshot.eventParticipations.map((ref) => this.canon.getEventParticipationRevision(ref.id, ref.hash))) : [],
      Promise.all(snapshot.rules.map((ref) => this.canon.getRuleRevision(ref.id, ref.hash))),
      policies ? Promise.all(policies.actorGoals.map((ref) => this.actors.getGoalRevision(ref.id, ref.hash))) : [],
      policies ? Promise.all(policies.actorModels.map((ref) => this.actors.getModelRevision(ref.id, ref.hash))) : [],
      policies ? Promise.all(policies.possibilities.map((ref) => this.possibilities.getRevision(ref.id, ref.hash))) : [],
    ]);
    if ((snapshot.version === 3 || snapshot.version === 4 || snapshot.version === 5) && snapshot.sourceId) {
      assertArtifactCollectionsExclusiveToSource(snapshot.sourceId, [
        entities,
        propositions,
        attributions,
        claims,
        events,
        eventParticipations,
        rules,
        actorGoals,
        actorModels,
        possibilities,
      ]);
    }
    assertEventParticipationProjection({ entities, events, eventParticipations });
    const participationIndex = eventParticipationsByEvent(eventParticipations);
    const projectedEvents = events.map((event) => projectEventParticipations(event, participationIndex.get(event.id) ?? []));
    return {
      canonicalSnapshotHash: snapshotHash,
      ...((snapshot.version === 3 || snapshot.version === 4 || snapshot.version === 5) && snapshot.sourceId ? { sourceId: snapshot.sourceId } : {}),
      ...((snapshot.version === 3 || snapshot.version === 4 || snapshot.version === 5) && snapshot.preparedRevisionHash ? { preparedRevisionHash: snapshot.preparedRevisionHash } : {}),
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      propositions: new Map(propositions.map((proposition) => [proposition.id, proposition])),
      attributions: new Map(attributions.map((attribution) => [attribution.id, attribution])),
      claims: new Map(claims.map((claim) => [claim.id, claim])),
      events: new Map(projectedEvents.map((event) => [event.id, event])),
      eventParticipations,
      rules: new Map(rules.map((rule) => [rule.id, rule])),
      actorGoals,
      actorModels: new Map(actorModels.map((model) => [model.actorId, model])),
      possibilityTemplates: possibilities,
      stateSchema: new StateSchemaRegistry(snapshot.stateFields),
    };
  }

  private async readLegacySupplement(snapshotHash: string): Promise<z.infer<typeof legacyPolicySupplementSchema> | null> {
    try {
      return legacyPolicySupplementSchema.parse(JSON.parse(await fs.readFile(path.join(this.root, "supplements", `${snapshotHash}.json`), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeImmutable(filePath: string, value: unknown): Promise<void> {
    const serialized = `${canonicalJson(value)}\n`;
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await fs.readFile(filePath, "utf8")) !== serialized) throw new Error(`Canonical snapshot supplement already differs: ${filePath}`);
    }
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

function assertArtifactCollectionsExclusiveToSource(
  sourceId: string,
  collections: Array<readonly ({ id?: string; actorId?: string; evidence: readonly EvidenceRef[] })[]>,
): void {
  for (const items of collections) {
    for (const item of items) {
      assertEvidenceExclusiveToSource(
        item.evidence,
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

export async function pinBranchPreparationContexts(workspaceRoot: string): Promise<number> {
  const branches = new BranchStore(workspaceRoot);
  const objects = new WorldObjectStore(workspaceRoot);
  const contexts = new WorldContextStore(workspaceRoot);
  const seenCommits = new Set<string>();
  const snapshotHashes = new Set<string>();
  for (const branchId of await branches.listIds()) {
    let cursor: string | undefined = await branches.readHead(branchId);
    while (cursor) {
      if (seenCommits.has(cursor)) break;
      seenCommits.add(cursor);
      const commit = await objects.getCommit(cursor);
      if (commit.canonicalSnapshotHash) snapshotHashes.add(commit.canonicalSnapshotHash);
      cursor = commit.parentCommitId;
    }
  }
  for (const snapshotHash of snapshotHashes) await contexts.pinLegacySnapshot(snapshotHash);
  return snapshotHashes.size;
}

import fs from "node:fs/promises";
import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { z } from "zod";
import { ActorModelStore, type ActorArtifactKind } from "./actors.js";
import { canonicalJson, contentHash } from "./canonical.js";
import { CanonicalModelStore, type CanonicalKind, type CanonicalRevisionRef } from "./canonical-model.js";
import type { WorldModelContext } from "./engine.js";
import { stateFieldSpecSchema } from "./model.js";
import { PossibilityTemplateStore } from "./possibility-model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "./state.js";
import { BranchStore, WorldObjectStore } from "./store.js";

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
const canonicalSnapshotSchema = z.union([canonicalSnapshotV1Schema, canonicalSnapshotV2Schema]);
const legacyPolicySupplementSchema = policySnapshotSchema.extend({ version: z.literal(1) }).strict();
export type CanonicalSnapshot = z.infer<typeof canonicalSnapshotSchema>;

export class WorldContextStore {
  readonly root: string;
  private readonly actors: ActorModelStore;
  private readonly possibilities: PossibilityTemplateStore;
  constructor(workspaceRoot: string, private readonly canon = new CanonicalModelStore(workspaceRoot)) {
    this.root = path.join(workspaceStateDir(workspaceRoot), "world", "v1", "canon", "snapshots");
    this.actors = new ActorModelStore(workspaceRoot);
    this.possibilities = new PossibilityTemplateStore(workspaceRoot);
  }

  async captureCurrent(): Promise<WorldModelContext> {
    const [entities, claims, events, rules, goals, models, possibilities] = await Promise.all([
      this.canon.listEntities(),
      this.canon.listClaims(),
      this.canon.listEvents(),
      this.canon.listRules(),
      this.actors.listGoals(),
      this.actors.listModels(),
      this.possibilities.list(),
    ]);
    const snapshot = canonicalSnapshotSchema.parse({
      version: 2,
      entities: await this.refs("entities", entities.map((item) => item.id)),
      claims: await this.refs("claims", claims.map((item) => item.id)),
      events: await this.refs("events", events.map((item) => item.id)),
      rules: await this.refs("rules", rules.map((item) => item.id)),
      actorGoals: await this.actorRefs("goals", goals.map((item) => item.id)),
      actorModels: await this.actorRefs("models", models.map((item) => item.actorId)),
      possibilities: await this.possibilityRefs(possibilities.map((item) => item.id)),
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
    const [goals, models, possibilities] = await Promise.all([
      this.actors.listGoals(),
      this.actors.listModels(),
      this.possibilities.list(),
    ]);
    const supplement = legacyPolicySupplementSchema.parse({
      version: 1,
      actorGoals: await this.actorRefs("goals", goals.map((item) => item.id)),
      actorModels: await this.actorRefs("models", models.map((item) => item.actorId)),
      possibilities: await this.possibilityRefs(possibilities.map((item) => item.id)),
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
    const policies = snapshot.version === 2 ? snapshot : await this.readLegacySupplement(snapshotHash);
    const [entities, claims, events, rules, actorGoals, actorModels, possibilities] = await Promise.all([
      Promise.all(snapshot.entities.map((ref) => this.canon.getEntityRevision(ref.id, ref.hash))),
      Promise.all(snapshot.claims.map((ref) => this.canon.getClaimRevision(ref.id, ref.hash))),
      Promise.all(snapshot.events.map((ref) => this.canon.getEventRevision(ref.id, ref.hash))),
      Promise.all(snapshot.rules.map((ref) => this.canon.getRuleRevision(ref.id, ref.hash))),
      policies ? Promise.all(policies.actorGoals.map((ref) => this.actors.getGoalRevision(ref.id, ref.hash))) : this.actors.listGoals(),
      policies ? Promise.all(policies.actorModels.map((ref) => this.actors.getModelRevision(ref.id, ref.hash))) : this.actors.listModels(),
      policies ? Promise.all(policies.possibilities.map((ref) => this.possibilities.getRevision(ref.id, ref.hash))) : this.possibilities.list(),
    ]);
    return {
      canonicalSnapshotHash: snapshotHash,
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      claims: new Map(claims.map((claim) => [claim.id, claim])),
      events: new Map(events.map((event) => [event.id, event])),
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

export async function loadWorldContext(workspaceRoot: string): Promise<{
  canon: CanonicalModelStore;
  contexts: WorldContextStore;
  context: WorldModelContext;
}> {
  const canon = new CanonicalModelStore(workspaceRoot);
  const contexts = new WorldContextStore(workspaceRoot, canon);
  const context = await contexts.captureCurrent();
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

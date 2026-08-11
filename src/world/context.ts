import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalJson, contentHash } from "./canonical.js";
import { CanonicalModelStore, type CanonicalKind, type CanonicalRevisionRef } from "./canonical-model.js";
import type { WorldModelContext } from "./engine.js";
import { stateFieldSpecSchema } from "./model.js";
import { DEFAULT_STATE_FIELDS, StateSchemaRegistry } from "./state.js";

const revisionRefSchema = z.object({ id: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const canonicalSnapshotSchema = z.object({
  version: z.literal(1),
  entities: z.array(revisionRefSchema),
  claims: z.array(revisionRefSchema),
  events: z.array(revisionRefSchema),
  rules: z.array(revisionRefSchema),
  stateFields: z.array(stateFieldSpecSchema),
}).strict();
export type CanonicalSnapshot = z.infer<typeof canonicalSnapshotSchema>;

export class WorldContextStore {
  readonly root: string;
  constructor(workspaceRoot: string, private readonly canon = new CanonicalModelStore(workspaceRoot)) {
    this.root = path.join(workspaceRoot, ".novel-harness", "world", "v1", "canon", "snapshots");
  }

  async captureCurrent(): Promise<WorldModelContext> {
    const [entities, claims, events, rules] = await Promise.all([
      this.canon.listEntities(),
      this.canon.listClaims(),
      this.canon.listEvents(),
      this.canon.listRules(),
    ]);
    const snapshot = canonicalSnapshotSchema.parse({
      version: 1,
      entities: await this.refs("entities", entities.map((item) => item.id)),
      claims: await this.refs("claims", claims.map((item) => item.id)),
      events: await this.refs("events", events.map((item) => item.id)),
      rules: await this.refs("rules", rules.map((item) => item.id)),
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

  private async hydrate(snapshotHash: string, snapshot: CanonicalSnapshot): Promise<WorldModelContext> {
    const [entities, claims, events, rules] = await Promise.all([
      Promise.all(snapshot.entities.map((ref) => this.canon.getEntityRevision(ref.id, ref.hash))),
      Promise.all(snapshot.claims.map((ref) => this.canon.getClaimRevision(ref.id, ref.hash))),
      Promise.all(snapshot.events.map((ref) => this.canon.getEventRevision(ref.id, ref.hash))),
      Promise.all(snapshot.rules.map((ref) => this.canon.getRuleRevision(ref.id, ref.hash))),
    ]);
    return {
      canonicalSnapshotHash: snapshotHash,
      entities: new Map(entities.map((entity) => [entity.id, entity])),
      claims: new Map(claims.map((claim) => [claim.id, claim])),
      events: new Map(events.map((event) => [event.id, event])),
      rules: new Map(rules.map((rule) => [rule.id, rule])),
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

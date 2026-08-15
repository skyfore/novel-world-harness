import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { nwhRuntimeDir } from "../agent/runtime-paths.js";
import { readSourceMaterial, sourceMaterialIdentity } from "../storage/source-material-store.js";
import type { SourceDocument } from "../storage/workspace-store.js";
import { ActorModelStore, characterGoalSchema, characterModelSchema } from "../world/actors.js";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { InitialWorldStore, initialWorldSchema } from "../world/initial.js";
import { canonicalEventSchema, claimSchema, entitySchema, worldRuleSchema } from "../world/model.js";
import { PossibilityTemplateStore, possibilityTemplateSchema } from "../world/possibility-model.js";
import { BranchStore } from "../world/store.js";
import { pinBranchPreparationContexts } from "../world/context.js";
import { CompilerBatchStore, prepareCompilerBatches } from "./batches.js";
import { SEGMENTER_VERSION } from "./segments.js";
import { CompilerValidator, type CanonicalProposalKind, type CompilerValidationCatalog } from "./validator.js";

const CACHE_FORMAT_VERSION = 1;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const md5Schema = z.string().regex(/^[a-f0-9]{32}$/);

const preparedNovelBundleSchema = z.object({
  version: z.literal(1),
  source: z.object({
    id: z.string().min(1),
    contentMd5: md5Schema,
    contentSha256: digestSchema,
  }).strict(),
  segmenterVersion: z.number().int().positive(),
  batchIds: z.array(z.string().min(1)),
  canonical: z.object({
    entities: z.array(entitySchema),
    claims: z.array(claimSchema),
    events: z.array(canonicalEventSchema),
    rules: z.array(worldRuleSchema),
    initialWorld: initialWorldSchema,
    goals: z.array(characterGoalSchema),
    models: z.array(characterModelSchema),
    possibilities: z.array(possibilityTemplateSchema),
  }).strict(),
}).strict();

export type PreparedNovelBundle = z.infer<typeof preparedNovelBundleSchema>;

const preparedNovelManifestSchema = z.object({
  version: z.literal(1),
  contentMd5: md5Schema,
  contentSha256: digestSchema,
  sourceId: z.string().min(1),
  bundleHash: digestSchema,
  createdAt: z.string().datetime(),
}).strict();

const preparedNovelActiveRefSchema = z.object({
  version: z.literal(1),
  contentMd5: md5Schema,
  bundleHash: digestSchema,
  updatedAt: z.string().datetime(),
}).strict();

export type PreparedCacheResult = {
  status: "miss" | "restored" | "already-materialized" | "published" | "already-cached" | "activated" | "workspace-not-empty";
  contentMd5: string;
  cachePath: string;
  bundleHash?: string;
  reason?: string;
};

export type PreparedCacheRevision = {
  bundleHash: string;
  createdAt: string;
  active: boolean;
  cachePath: string;
};

export class PreparedNovelCache {
  readonly root: string;

  constructor(
    private readonly workspaceRoot: string,
    cacheRoot = path.join(nwhRuntimeDir(), "prepared-novels", `v${CACHE_FORMAT_VERSION}`),
  ) {
    this.root = path.resolve(cacheRoot);
  }

  async lookup(source: SourceDocument): Promise<PreparedCacheResult> {
    const identity = await sourceIdentity(this.workspaceRoot, source);
    const cached = await this.readCached(identity.contentMd5);
    if (!cached) return { status: "miss", contentMd5: identity.contentMd5, cachePath: this.cachePath(identity.contentMd5) };
    assertSourceIdentity(cached.bundle, identity);
    return {
      status: "already-cached",
      contentMd5: identity.contentMd5,
      cachePath: cached.cachePath,
      bundleHash: cached.manifest.bundleHash,
    };
  }

  async restore(source: SourceDocument): Promise<PreparedCacheResult> {
    const identity = await sourceIdentity(this.workspaceRoot, source);
    const cached = await this.readCached(identity.contentMd5);
    if (!cached) return { status: "miss", contentMd5: identity.contentMd5, cachePath: this.cachePath(identity.contentMd5) };
    assertSourceIdentity(cached.bundle, identity);

    const layoutIssue = await this.batchLayoutIssue(source, cached.bundle);
    if (layoutIssue) {
      return {
        status: "miss",
        contentMd5: identity.contentMd5,
        cachePath: cached.cachePath,
        reason: layoutIssue,
      };
    }

    const compatibility = await this.assertWorkspaceCanMaterialize(cached.bundle);
    if (!compatibility.compatible) {
      return {
        status: "workspace-not-empty",
        contentMd5: identity.contentMd5,
        cachePath: cached.cachePath,
        bundleHash: cached.manifest.bundleHash,
        reason: compatibility.reason,
      };
    }

    await this.materialize(cached.bundle, false);

    return {
      status: compatibility.empty ? "restored" : "already-materialized",
      contentMd5: identity.contentMd5,
      cachePath: cached.cachePath,
      bundleHash: cached.manifest.bundleHash,
    };
  }

  async publish(source: SourceDocument): Promise<PreparedCacheResult> {
    const identity = await sourceIdentity(this.workspaceRoot, source);
    const bundle = await this.buildBundle(source, identity);
    const bundleHash = contentHash(bundle);
    await this.ensureRevisionLayout(identity.contentMd5);
    const cachePath = this.revisionPath(identity.contentMd5, bundleHash);
    const existing = await this.readCached(identity.contentMd5, bundleHash);
    if (existing && canonicalJson(existing.bundle) !== canonicalJson(bundle)) {
      throw new Error(`Prepared cache revision collision for ${identity.contentMd5}@${bundleHash}.`);
    }
    if (existing) assertSourceIdentity(existing.bundle, identity);

    const staging = path.join(this.cachePath(identity.contentMd5), "revisions", `.${bundleHash}.${process.pid}.${crypto.randomUUID()}.tmp`);
    await fs.mkdir(staging, { mode: 0o700 });
    const manifest = preparedNovelManifestSchema.parse({
      version: 1,
      contentMd5: identity.contentMd5,
      contentSha256: identity.contentSha256,
      sourceId: source.id,
      bundleHash,
      createdAt: new Date().toISOString(),
    });
    let published = false;
    try {
      await fs.writeFile(path.join(staging, "bundle.json"), `${canonicalJson(bundle)}\n`, { encoding: "utf8", mode: 0o400, flag: "wx" });
      await fs.writeFile(path.join(staging, "manifest.json"), `${canonicalJson(manifest)}\n`, { encoding: "utf8", mode: 0o400, flag: "wx" });
      // Immutable revision files remain read-only. The generation directory stays owner-writable
      // so cache GC/teardown can unlink the files without first mutating directory permissions.
      await fs.chmod(staging, 0o700);
      try {
        await fs.rename(staging, cachePath);
        published = true;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await fs.chmod(staging, 0o700);
        await fs.rm(staging, { recursive: true, force: true });
        const raced = await this.readCached(identity.contentMd5, bundleHash);
        if (!raced || raced.manifest.bundleHash !== bundleHash || canonicalJson(raced.bundle) !== canonicalJson(bundle)) {
          throw new Error(`Prepared cache publication race produced a different revision for ${identity.contentMd5}@${bundleHash}.`);
        }
      }
    } catch (error) {
      try {
        await fs.chmod(staging, 0o700);
        await fs.rm(staging, { recursive: true, force: true });
      } catch {
        // Preserve the original publication error.
      }
      throw error;
    }
    await this.writeActive(identity.contentMd5, bundleHash);
    return { status: published ? "published" : "already-cached", contentMd5: identity.contentMd5, cachePath, bundleHash };
  }

  async listRevisions(source: SourceDocument): Promise<PreparedCacheRevision[]> {
    const identity = await sourceIdentity(this.workspaceRoot, source);
    await this.ensureRevisionLayout(identity.contentMd5, false);
    const active = await this.readActive(identity.contentMd5);
    let names: string[];
    try {
      names = (await fs.readdir(path.join(this.cachePath(identity.contentMd5), "revisions"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && digestSchema.safeParse(entry.name).success)
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const revisions: PreparedCacheRevision[] = [];
    for (const bundleHash of names) {
      const cached = await this.readCached(identity.contentMd5, bundleHash);
      if (!cached) continue;
      assertSourceIdentity(cached.bundle, identity);
      revisions.push({
        bundleHash,
        createdAt: cached.manifest.createdAt,
        active: active?.bundleHash === bundleHash,
        cachePath: cached.cachePath,
      });
    }
    return revisions.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.bundleHash.localeCompare(right.bundleHash));
  }

  async activate(source: SourceDocument, bundleHash: string): Promise<PreparedCacheResult> {
    digestSchema.parse(bundleHash);
    const identity = await sourceIdentity(this.workspaceRoot, source);
    await this.ensureRevisionLayout(identity.contentMd5, false);
    const previous = await this.readCached(identity.contentMd5);
    const cached = await this.readCached(identity.contentMd5, bundleHash);
    if (!cached) throw new Error(`Prepared cache revision not found: ${identity.contentMd5}@${bundleHash}`);
    assertSourceIdentity(cached.bundle, identity);
    const pending = await new ProposalStore(this.workspaceRoot).list("pending", source.id);
    if (pending.length) throw new Error(`Cannot activate a prepared revision while ${pending.length} source proposal(s) are pending.`);
    const layoutIssue = await this.batchLayoutIssue(source, cached.bundle);
    if (layoutIssue) throw new Error(layoutIssue);
    await pinBranchPreparationContexts(this.workspaceRoot);
    try {
      await this.materialize(cached.bundle, true);
    } catch (error) {
      if (!previous || previous.manifest.bundleHash === bundleHash) throw error;
      try {
        await this.materialize(previous.bundle, true);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Prepared revision activation failed and workspace rollback to ${previous.manifest.bundleHash} also failed.`);
      }
      throw new Error(`Prepared revision activation failed; workspace refs were restored to ${previous.manifest.bundleHash}.`, { cause: error });
    }
    await this.writeActive(identity.contentMd5, bundleHash);
    return { status: "activated", contentMd5: identity.contentMd5, cachePath: cached.cachePath, bundleHash };
  }

  private async buildBundle(
    source: SourceDocument,
    identity: { contentMd5: string; contentSha256: string },
  ): Promise<PreparedNovelBundle> {
    const proposals = new ProposalStore(this.workspaceRoot);
    const pending = await proposals.list("pending", source.id);
    if (pending.length) throw new Error(`Cannot cache ${source.id}: ${pending.length} source proposal(s) are still pending.`);
    const batches = await prepareCompilerBatches(this.workspaceRoot, source);
    const progress = await new CompilerBatchStore(this.workspaceRoot).read(source.id);
    const completed = new Set(progress.completedBatchIds);
    const unfinished = batches.filter((batch) => !completed.has(batch.id));
    if (unfinished.length) throw new Error(`Cannot cache ${source.id}: ${unfinished.length} compiler batch(es) are unfinished.`);

    const canonical = new CanonicalModelStore(this.workspaceRoot);
    const actors = new ActorModelStore(this.workspaceRoot);
    const initialWorld = await new InitialWorldStore(this.workspaceRoot).get();
    if (!initialWorld || !initialWorld.evidence.some((reference) => reference.span.sourceId === source.id)) {
      throw new Error(`Cannot cache ${source.id}: an evidence-backed initial world for this source is required.`);
    }
    const fromSource = <T extends { evidence: readonly { span: { sourceId: string } }[] }>(items: readonly T[]) =>
      items.filter((item) => item.evidence.some((reference) => reference.span.sourceId === source.id));
    const [entities, claims, events, rules, goals, models, possibilities] = await Promise.all([
      canonical.listEntities(),
      canonical.listClaims(),
      canonical.listEvents(),
      canonical.listRules(),
      actors.listGoals(),
      actors.listModels(),
      new PossibilityTemplateStore(this.workspaceRoot).list(),
    ]);
    const bundle = preparedNovelBundleSchema.parse({
      version: 1,
      source: { id: source.id, ...identity },
      segmenterVersion: SEGMENTER_VERSION,
      batchIds: batches.map((batch) => batch.id).sort(),
      canonical: {
        entities: fromSource(entities),
        claims: fromSource(claims),
        events: fromSource(events),
        rules: fromSource(rules),
        initialWorld,
        goals: fromSource(goals),
        models: fromSource(models),
        possibilities: fromSource(possibilities),
      },
    });
    assertSelfContainedBaseline(bundle, canonical);
    return bundle;
  }

  private async assertWorkspaceCanMaterialize(bundle: PreparedNovelBundle): Promise<{ compatible: boolean; empty: boolean; reason?: string }> {
    const proposals = new ProposalStore(this.workspaceRoot);
    const branches = new BranchStore(this.workspaceRoot);
    const [pending, branchIds] = await Promise.all([proposals.list("pending"), branches.listIds()]);
    if (pending.length || branchIds.length) {
      return {
        compatible: false,
        empty: false,
        reason: `Workspace has ${pending.length} pending proposal(s) and ${branchIds.length} branch(es); cached baselines are restored only before local world evolution starts.`,
      };
    }
    const current = await currentCanonical(this.workspaceRoot);
    const expected = bundle.canonical;
    const groups = [
      ["entity", current.entities, expected.entities, (item: { id: string }) => item.id],
      ["claim", current.claims, expected.claims, (item: { id: string }) => item.id],
      ["event", current.events, expected.events, (item: { id: string }) => item.id],
      ["rule", current.rules, expected.rules, (item: { id: string }) => item.id],
      ["goal", current.goals, expected.goals, (item: { id: string }) => item.id],
      ["model", current.models, expected.models, (item: { actorId: string }) => item.actorId],
      ["possibility", current.possibilities, expected.possibilities, (item: { id: string }) => item.id],
    ] as const;
    for (const [label, actual, target, key] of groups) {
      const expectedById = new Map(target.map((item) => [key(item as never), item]));
      for (const item of actual) {
        const id = key(item as never);
        const cached = expectedById.get(id);
        if (!cached || canonicalJson(cached) !== canonicalJson(item)) {
          return { compatible: false, empty: false, reason: `Workspace ${label} '${id}' differs from the active prepared revision.` };
        }
      }
    }
    if (current.initialWorld && canonicalJson(current.initialWorld) !== canonicalJson(expected.initialWorld)) {
      return { compatible: false, empty: false, reason: "Workspace initial world differs from the active prepared revision." };
    }
    const empty = !current.initialWorld && groups.every(([, actual]) => actual.length === 0);
    return { compatible: true, empty };
  }

  private async materialize(bundle: PreparedNovelBundle, exact: boolean): Promise<void> {
    const sourceId = bundle.source.id;
    const canonical = new CanonicalModelStore(this.workspaceRoot);
    const actors = new ActorModelStore(this.workspaceRoot);
    const possibilities = new PossibilityTemplateStore(this.workspaceRoot);
    if (exact) {
      const current = await currentCanonical(this.workspaceRoot);
      const removeMissing = async <T extends { evidence: readonly { span: { sourceId: string } }[] }>(
        items: readonly T[],
        expectedIds: ReadonlySet<string>,
        idOf: (item: T) => string,
        remove: (id: string) => Promise<void>,
      ) => {
        for (const item of items) {
          const id = idOf(item);
          if (!expectedIds.has(id) && belongsExclusivelyToSource(item, sourceId)) await remove(id);
        }
      };
      await removeMissing(current.entities, new Set(bundle.canonical.entities.map((item) => item.id)), (item) => item.id, (id) => canonical.removeCurrent("entities", id));
      await removeMissing(current.claims, new Set(bundle.canonical.claims.map((item) => item.id)), (item) => item.id, (id) => canonical.removeCurrent("claims", id));
      await removeMissing(current.events, new Set(bundle.canonical.events.map((item) => item.id)), (item) => item.id, (id) => canonical.removeCurrent("events", id));
      await removeMissing(current.rules, new Set(bundle.canonical.rules.map((item) => item.id)), (item) => item.id, (id) => canonical.removeCurrent("rules", id));
      await removeMissing(current.goals, new Set(bundle.canonical.goals.map((item) => item.id)), (item) => item.id, (id) => actors.removeGoal(id));
      await removeMissing(current.models, new Set(bundle.canonical.models.map((item) => item.actorId)), (item) => item.actorId, (id) => actors.removeModel(id));
      await removeMissing(current.possibilities, new Set(bundle.canonical.possibilities.map((item) => item.id)), (item) => item.id, (id) => possibilities.remove(id));
    }
    for (const entity of bundle.canonical.entities) await canonical.putEntity(entity);
    for (const claim of bundle.canonical.claims) await canonical.putClaim(claim);
    for (const rule of bundle.canonical.rules) await canonical.putRule(rule);
    for (const event of bundle.canonical.events) await canonical.putEvent(event);
    await new InitialWorldStore(this.workspaceRoot).put(bundle.canonical.initialWorld);
    for (const goal of bundle.canonical.goals) await actors.putGoal(goal);
    for (const model of bundle.canonical.models) await actors.putModel(model);
    for (const possibility of bundle.canonical.possibilities) await possibilities.put(possibility);
    await new CompilerBatchStore(this.workspaceRoot).replaceCompleted(sourceId, bundle.batchIds);
  }

  private async batchLayoutIssue(source: SourceDocument, bundle: PreparedNovelBundle): Promise<string | null> {
    const batches = await prepareCompilerBatches(this.workspaceRoot, source);
    const currentBatchIds = batches.map((batch) => batch.id).sort();
    if (canonicalJson(currentBatchIds) === canonicalJson([...bundle.batchIds].sort())) return null;
    return `Cached compiler batches use a different segmenter layout (cache=${bundle.segmenterVersion}, current=${SEGMENTER_VERSION}).`;
  }

  private async ensureRevisionLayout(contentMd5: string, create = true): Promise<void> {
    const container = this.cachePath(contentMd5);
    if (create) {
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      await fs.mkdir(container, { recursive: true, mode: 0o700 });
    } else {
      try { await fs.access(container); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    }
    await fs.chmod(container, 0o700);
    const legacy = await this.readDirectory(contentMd5, container);
    if (!legacy) {
      await fs.mkdir(path.join(container, "revisions"), { recursive: true, mode: 0o700 });
      return;
    }
    const revisionDirectory = this.revisionPath(contentMd5, legacy.manifest.bundleHash);
    try {
      await fs.access(revisionDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.writeRevisionDirectory(contentMd5, legacy.manifest, legacy.bundle);
    }
    if (!await this.readActive(contentMd5)) await this.writeActive(contentMd5, legacy.manifest.bundleHash);
  }

  private async writeRevisionDirectory(
    contentMd5: string,
    manifest: z.infer<typeof preparedNovelManifestSchema>,
    bundle: PreparedNovelBundle,
  ): Promise<void> {
    const revisionsRoot = path.join(this.cachePath(contentMd5), "revisions");
    await fs.mkdir(revisionsRoot, { recursive: true, mode: 0o700 });
    const target = this.revisionPath(contentMd5, manifest.bundleHash);
    const staging = path.join(revisionsRoot, `.${manifest.bundleHash}.${process.pid}.${crypto.randomUUID()}.tmp`);
    await fs.mkdir(staging, { mode: 0o700 });
    try {
      await fs.writeFile(path.join(staging, "bundle.json"), `${canonicalJson(bundle)}\n`, { encoding: "utf8", mode: 0o400, flag: "wx" });
      await fs.writeFile(path.join(staging, "manifest.json"), `${canonicalJson(manifest)}\n`, { encoding: "utf8", mode: 0o400, flag: "wx" });
      await fs.chmod(staging, 0o700);
      try { await fs.rename(staging, target); }
      catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await fs.chmod(staging, 0o700);
        await fs.rm(staging, { recursive: true, force: true });
      }
    } catch (error) {
      try { await fs.chmod(staging, 0o700); await fs.rm(staging, { recursive: true, force: true }); } catch { /* keep original error */ }
      throw error;
    }
  }

  private async readCached(contentMd5: string, requestedHash?: string): Promise<{
    manifest: z.infer<typeof preparedNovelManifestSchema>;
    bundle: PreparedNovelBundle;
    cachePath: string;
  } | null> {
    if (requestedHash) return this.readDirectory(contentMd5, this.revisionPath(contentMd5, requestedHash));
    const active = await this.readActive(contentMd5);
    if (active) {
      const cached = await this.readDirectory(contentMd5, this.revisionPath(contentMd5, active.bundleHash));
      if (!cached) throw new Error(`Prepared cache active revision is missing: ${contentMd5}@${active.bundleHash}`);
      return cached;
    }
    return this.readDirectory(contentMd5, this.cachePath(contentMd5));
  }

  private async readDirectory(contentMd5: string, directory: string): Promise<{
    manifest: z.infer<typeof preparedNovelManifestSchema>;
    bundle: PreparedNovelBundle;
    cachePath: string;
  } | null> {
    try {
      const [manifestRaw, bundleRaw] = await Promise.all([
        fs.readFile(path.join(directory, "manifest.json"), "utf8"),
        fs.readFile(path.join(directory, "bundle.json"), "utf8"),
      ]);
      const manifest = preparedNovelManifestSchema.parse(JSON.parse(manifestRaw));
      const bundle = preparedNovelBundleSchema.parse(JSON.parse(bundleRaw));
      if (manifest.contentMd5 !== contentMd5 || bundle.source.contentMd5 !== contentMd5) throw new Error(`Prepared cache path/digest mismatch: ${directory}`);
      if (
        manifest.contentSha256 !== bundle.source.contentSha256
        || manifest.sourceId !== bundle.source.id
        || bundle.source.id !== bundle.source.contentSha256.slice(0, 20)
      ) throw new Error(`Prepared cache source identity mismatch: ${directory}`);
      if (contentHash(bundle) !== manifest.bundleHash) throw new Error(`Prepared cache bundle hash mismatch: ${directory}`);
      return { manifest, bundle, cachePath: directory };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async readActive(contentMd5: string): Promise<z.infer<typeof preparedNovelActiveRefSchema> | null> {
    try {
      const value = preparedNovelActiveRefSchema.parse(JSON.parse(await fs.readFile(path.join(this.cachePath(contentMd5), "active.json"), "utf8")));
      if (value.contentMd5 !== contentMd5) throw new Error(`Prepared cache active ref/path mismatch: ${contentMd5}`);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeActive(contentMd5: string, bundleHash: string): Promise<void> {
    const filePath = path.join(this.cachePath(contentMd5), "active.json");
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, `${canonicalJson(preparedNovelActiveRefSchema.parse({ version: 1, contentMd5, bundleHash, updatedAt: new Date().toISOString() }))}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
  }

  private cachePath(contentMd5: string): string {
    return path.join(this.root, md5Schema.parse(contentMd5));
  }

  private revisionPath(contentMd5: string, bundleHash: string): string {
    return path.join(this.cachePath(contentMd5), "revisions", digestSchema.parse(bundleHash));
  }
}

function belongsExclusivelyToSource(
  item: { evidence: readonly { span: { sourceId: string } }[] },
  sourceId: string,
): boolean {
  return item.evidence.length > 0 && item.evidence.every((reference) => reference.span.sourceId === sourceId);
}

async function currentCanonical(workspaceRoot: string) {
  const canonical = new CanonicalModelStore(workspaceRoot);
  const actors = new ActorModelStore(workspaceRoot);
  return {
    entities: await canonical.listEntities(),
    claims: await canonical.listClaims(),
    events: await canonical.listEvents(),
    rules: await canonical.listRules(),
    initialWorld: await new InitialWorldStore(workspaceRoot).get(),
    goals: await actors.listGoals(),
    models: await actors.listModels(),
    possibilities: await new PossibilityTemplateStore(workspaceRoot).list(),
  };
}

async function sourceIdentity(workspaceRoot: string, source: SourceDocument): Promise<{ contentMd5: string; contentSha256: string }> {
  const content = await readSourceMaterial(workspaceRoot, source);
  const { contentSha256, contentMd5 } = sourceMaterialIdentity(content);
  if (contentSha256 !== source.contentSha256) throw new Error(`Source ${source.sourcePath} changed after ingest; prepared cache access is denied.`);
  if (source.contentMd5 && source.contentMd5 !== contentMd5) throw new Error(`Source ${source.sourcePath} has inconsistent MD5 metadata.`);
  return { contentMd5, contentSha256 };
}

function assertSourceIdentity(
  bundle: PreparedNovelBundle,
  identity: { contentMd5: string; contentSha256: string },
): void {
  if (bundle.source.contentMd5 !== identity.contentMd5 || bundle.source.contentSha256 !== identity.contentSha256) {
    throw new Error(`MD5 collision detected for ${identity.contentMd5}; SHA-256 identities differ, so the prepared cache will not be used.`);
  }
}

function isAlreadyExists(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

function assertSelfContainedBaseline(bundle: PreparedNovelBundle, canonicalStore: CanonicalModelStore): void {
  const catalog: CompilerValidationCatalog = {
    entities: new Map(bundle.canonical.entities.map((item) => [item.id, item])),
    claims: new Map(bundle.canonical.claims.map((item) => [item.id, item])),
    events: new Map(bundle.canonical.events.map((item) => [item.id, item])),
    rules: new Map(bundle.canonical.rules.map((item) => [item.id, item])),
  };
  const validator = new CompilerValidator(canonicalStore);
  const artifacts: Array<{ kind: CanonicalProposalKind; label: string; payload: unknown }> = [
    ...bundle.canonical.entities.map((payload) => ({ kind: "entity" as const, label: payload.id, payload })),
    ...bundle.canonical.claims.map((payload) => ({ kind: "claim" as const, label: payload.id, payload })),
    ...bundle.canonical.rules.map((payload) => ({ kind: "world-rule" as const, label: payload.id, payload })),
    ...bundle.canonical.events.map((payload) => ({ kind: "canonical-event" as const, label: payload.id, payload })),
    { kind: "initial-world", label: "initial-world", payload: bundle.canonical.initialWorld },
    ...bundle.canonical.models.map((payload) => ({ kind: "character-model" as const, label: payload.actorId, payload })),
    ...bundle.canonical.goals.map((payload) => ({ kind: "character-goal" as const, label: payload.id, payload })),
  ];
  for (const artifact of artifacts) {
    const validation = validator.validateWithCatalog(artifact.kind, artifact.payload, catalog);
    if (validation.accepted) continue;
    throw new Error(
      `Cannot cache source-isolated baseline: ${artifact.kind} '${artifact.label}' depends on omitted or invalid data (${validation.errors.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}).`,
    );
  }
  const possibilityIds = new Set(bundle.canonical.possibilities.map((item) => item.id));
  for (const possibility of bundle.canonical.possibilities) {
    const unknownParticipant = possibility.participants.find((id) => !catalog.entities.has(id));
    const unknownParent = possibility.causalParents.find((id) => !catalog.events.has(id) && !possibilityIds.has(id));
    if (unknownParticipant || unknownParent || (possibility.canonicalEventId && !catalog.events.has(possibility.canonicalEventId))) {
      throw new Error(`Cannot cache source-isolated baseline: possibility '${possibility.id}' depends on omitted canonical data.`);
    }
  }
}

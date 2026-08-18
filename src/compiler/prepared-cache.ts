import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { nwhRuntimeDir } from "../agent/runtime-paths.js";
import { readSourceMaterial, sourceMaterialIdentity } from "../storage/source-material-store.js";
import { WorkspaceStore, type SourceDocument } from "../storage/workspace-store.js";
import { ActorModelStore, characterGoalSchema, characterModelSchema } from "../world/actors.js";
import { canonicalJson, contentHash } from "../world/canonical.js";
import { CanonicalModelStore, ProposalStore } from "../world/canonical-model.js";
import { InitialWorldStore, initialWorldSchema } from "../world/initial.js";
import { WORLD_ENGINE_VERSION, canonicalEventSchema, claimSchema, entitySchema, worldRuleSchema, type EvidenceRef } from "../world/model.js";
import { PossibilityTemplateStore, possibilityTemplateSchema } from "../world/possibility-model.js";
import { BranchStore } from "../world/store.js";
import { pinBranchPreparationContexts } from "../world/context.js";
import { COMPILER_PIPELINE_VERSION, CompilerBatchStore, prepareCompilerBatches } from "./batches.js";
import { SEGMENTER_VERSION } from "./segments.js";
import { CompilerValidator, type CanonicalProposalKind, type CompilerValidationCatalog } from "./validator.js";
import { DEFAULT_STATE_FIELDS } from "../world/state.js";
import { auditCompiler } from "./audit.js";
import { assertEvidenceExclusiveToSource } from "../world/source-scope.js";
import { ChapterSplitPlanStore, chapterSplitPlanSchema } from "./chapter-split.js";

export { COMPILER_PIPELINE_VERSION };

const CACHE_FORMAT_VERSION = 1;
export const COMPILER_PROMPT_VERSION = 5;
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
  compilerFingerprint: z.object({
    pipelineVersion: z.number().int().positive(),
    promptVersion: z.number().int().positive(),
    engineVersion: z.string().min(1),
    stateSchemaHash: digestSchema,
  }).strict().optional(),
  chapterSplitPlan: chapterSplitPlanSchema.optional(),
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

function assertPreparedBundleSourceScope(bundle: PreparedNovelBundle): void {
  const sourceId = bundle.source.id;
  if (bundle.chapterSplitPlan && (
    bundle.chapterSplitPlan.sourceId !== sourceId
    || bundle.chapterSplitPlan.sourceSha256 !== bundle.source.contentSha256
  )) {
    throw new Error("Prepared bundle chapter split plan does not match its source identity.");
  }
  const collections = [
    bundle.canonical.entities,
    bundle.canonical.claims,
    bundle.canonical.events,
    bundle.canonical.rules,
    bundle.canonical.goals,
    bundle.canonical.models,
    bundle.canonical.possibilities,
  ] as const;
  for (const items of collections) {
    for (const item of items as readonly { id?: string; actorId?: string; evidence: readonly EvidenceRef[] }[]) {
      assertEvidenceExclusiveToSource(item.evidence, sourceId, `Prepared bundle artifact ${item.id ?? item.actorId ?? "unknown"}`);
    }
  }
  assertEvidenceExclusiveToSource(bundle.canonical.initialWorld.evidence, sourceId, "Prepared bundle initial world");
}

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
  /** The cached artifact cannot be safely upgraded by merely resuming batches. */
  requiresReparse?: boolean;
};

export type PreparedCacheRevision = {
  bundleHash: string;
  createdAt: string;
  active: boolean;
  cachePath: string;
};

export type ActivePreparedNovel = {
  bundleHash: string;
  bundle: PreparedNovelBundle;
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
    const compatibilityIssue = await this.batchLayoutIssue(source, cached.bundle);
    if (compatibilityIssue) {
      return {
        status: "miss",
        contentMd5: identity.contentMd5,
        cachePath: cached.cachePath,
        bundleHash: cached.manifest.bundleHash,
        reason: compatibilityIssue,
        requiresReparse: true,
      };
    }
    return {
      status: "already-cached",
      contentMd5: identity.contentMd5,
      cachePath: cached.cachePath,
      bundleHash: cached.manifest.bundleHash,
    };
  }

  async loadActive(source: SourceDocument): Promise<ActivePreparedNovel | null> {
    const identity = await sourceIdentity(this.workspaceRoot, source);
    const cached = await this.readCached(identity.contentMd5);
    if (!cached) return null;
    assertSourceIdentity(cached.bundle, identity);
    const layoutIssue = await this.batchLayoutIssue(source, cached.bundle);
    if (layoutIssue) throw new Error(layoutIssue);
    return {
      bundleHash: cached.manifest.bundleHash,
      bundle: cached.bundle,
      cachePath: cached.cachePath,
    };
  }

  /**
   * Branch creation must not silently prefer an older immutable bundle over
   * newer accepted compiler artifacts. Explicit revision activation first
   * materializes that revision, so a deliberate rollback remains fresh while
   * an un-published accepted opening or goal change is rejected here.
   */
  async loadFreshActive(source: SourceDocument): Promise<ActivePreparedNovel | null> {
    const active = await this.loadActive(source);
    if (!active) return null;
    const issue = await this.freshnessIssue(active.bundle);
    if (issue) {
      throw new Error(
        `Active prepared revision ${active.bundleHash} is stale relative to accepted workspace artifacts: ${issue} `
        + "Run prepare-all to publish a new immutable revision, then create a fresh instance; existing branches remain pinned.",
      );
    }
    return active;
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
        bundleHash: cached.manifest.bundleHash,
        reason: layoutIssue,
        requiresReparse: true,
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

  async publish(source: SourceDocument, options: { allowSemanticDebtForRollback?: boolean } = {}): Promise<PreparedCacheResult> {
    const identity = await sourceIdentity(this.workspaceRoot, source);
    const bundle = await this.buildBundle(source, identity, options);
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

  async remove(source: SourceDocument): Promise<boolean> {
    const contentMd5 = source.contentMd5 ?? (await sourceIdentity(this.workspaceRoot, source)).contentMd5;
    const target = this.cachePath(contentMd5);
    try {
      await fs.rm(target, { recursive: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async activate(source: SourceDocument, bundleHash: string, options: { allowIncompatibleRollback?: boolean } = {}): Promise<PreparedCacheResult> {
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
    if (layoutIssue && !options.allowIncompatibleRollback) throw new Error(layoutIssue);
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
    options: { allowSemanticDebtForRollback?: boolean },
  ): Promise<PreparedNovelBundle> {
    const proposals = new ProposalStore(this.workspaceRoot);
    const pending = await proposals.list("pending", source.id);
    if (pending.length) throw new Error(`Cannot cache ${source.id}: ${pending.length} source proposal(s) are still pending.`);
    const batches = await prepareCompilerBatches(this.workspaceRoot, source);
    const progress = await new CompilerBatchStore(this.workspaceRoot).read(source.id);
    const completed = new Set(progress.completedBatchIds);
    const unfinished = batches.filter((batch) => !completed.has(batch.id));
    if (unfinished.length) throw new Error(`Cannot cache ${source.id}: ${unfinished.length} compiler batch(es) are unfinished.`);
    const semanticAudit = await auditCompiler(this.workspaceRoot, { sourceId: source.id });
    if (semanticAudit.consistency.semanticReady === false && !options.allowSemanticDebtForRollback) {
      throw new Error(`Cannot cache ${source.id}: novel-scale semantic readiness failed (${semanticAudit.consistency.semanticIssues.join(" ")}).`);
    }

    const canonical = new CanonicalModelStore(this.workspaceRoot);
    const actors = new ActorModelStore(this.workspaceRoot);
    const initialWorld = await new InitialWorldStore(this.workspaceRoot).get();
    if (!initialWorld || !initialWorld.evidence.some((reference) => reference.span.sourceId === source.id)) {
      throw new Error(`Cannot cache ${source.id}: an evidence-backed initial world for this source is required.`);
    }
    assertEvidenceExclusiveToSource(initialWorld.evidence, source.id, "Prepared initial world");
    const fromSource = <T extends { id?: string; actorId?: string; evidence: readonly EvidenceRef[] }>(items: readonly T[]) =>
      items.filter((item) => {
        const matches = item.evidence.some((reference) => reference.span.sourceId === source.id);
        if (matches) assertEvidenceExclusiveToSource(item.evidence, source.id, `Prepared artifact ${item.id ?? item.actorId ?? "unknown"}`);
        return matches;
      });
    const [entities, claims, events, rules, goals, models, possibilities] = await Promise.all([
      canonical.listEntities(),
      canonical.listClaims(),
      canonical.listEvents(),
      canonical.listRules(),
      actors.listGoals(),
      actors.listModels(),
      new PossibilityTemplateStore(this.workspaceRoot).list(),
    ]);
    const chapterSplitPlan = await new ChapterSplitPlanStore(this.workspaceRoot).read(source.id);
    const bundle = preparedNovelBundleSchema.parse({
      version: 1,
      source: { id: source.id, ...identity },
      segmenterVersion: SEGMENTER_VERSION,
      compilerFingerprint: currentCompilerFingerprint(),
      ...(chapterSplitPlan ? { chapterSplitPlan } : {}),
      // Boundary calibrations are transient, model-requested workflow checks.
      // Their accepted artifacts are already captured below. Structure discovery
      // is deterministic workflow provenance and is retained with its validated
      // plan so a prepared revision reproduces the same author-chapter layout.
      batchIds: batches
        .filter((batch) => batch.purpose !== "boundary-calibration")
        .map((batch) => batch.id)
        .sort(),
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

  private async freshnessIssue(bundle: PreparedNovelBundle): Promise<string | null> {
    const pending = await new ProposalStore(this.workspaceRoot).list("pending", bundle.source.id);
    if (pending.length) return `${pending.length} source proposal(s) are pending`;
    const current = await currentCanonical(this.workspaceRoot);
    const fromSource = <T extends { id?: string; actorId?: string; evidence: readonly EvidenceRef[] }>(items: readonly T[]) =>
      items.filter((item) => {
        const matches = item.evidence.some((reference) => reference.span.sourceId === bundle.source.id);
        if (matches) assertEvidenceExclusiveToSource(item.evidence, bundle.source.id, `Prepared-cache artifact ${item.id ?? item.actorId ?? "unknown"}`);
        return matches;
      });
    const groups = [
      ["entities", fromSource(current.entities), bundle.canonical.entities, (item: { id: string }) => item.id],
      ["claims", fromSource(current.claims), bundle.canonical.claims, (item: { id: string }) => item.id],
      ["events", fromSource(current.events), bundle.canonical.events, (item: { id: string }) => item.id],
      ["rules", fromSource(current.rules), bundle.canonical.rules, (item: { id: string }) => item.id],
      ["goals", fromSource(current.goals), bundle.canonical.goals, (item: { id: string }) => item.id],
      ["models", fromSource(current.models), bundle.canonical.models, (item: { actorId: string }) => item.actorId],
      ["possibilities", fromSource(current.possibilities), bundle.canonical.possibilities, (item: { id: string }) => item.id],
    ] as const;
    const currentInitialForSource = current.initialWorld?.evidence.some((reference) =>
      reference.span.sourceId === bundle.source.id)
      ? current.initialWorld
      : null;
    if (currentInitialForSource) {
      assertEvidenceExclusiveToSource(currentInitialForSource.evidence, bundle.source.id, "Prepared-cache current initial world");
    }
    // A shared workspace may contain only another novel's material. In that
    // case the active immutable bundle is the source of truth for this new
    // branch, not a "missing" local copy that should be diagnosed as stale.
    // Once any accepted artifact for this source is present, however, require
    // the complete source-scoped snapshot to match so newer partial revisions
    // cannot be silently ignored.
    const hasMaterializedSource = groups.some(([, actual]) => actual.length > 0) || Boolean(currentInitialForSource);
    if (!hasMaterializedSource) return null;
    for (const [label, actual, expected, idOf] of groups) {
      const normalize = (items: readonly unknown[]) => [...items]
        .sort((left, right) => idOf(left as never).localeCompare(idOf(right as never)))
        .map((item) => canonicalJson(item));
      if (canonicalJson(normalize(actual)) !== canonicalJson(normalize(expected))) return `${label} differ`;
    }
    if (!currentInitialForSource || canonicalJson(currentInitialForSource) !== canonicalJson(bundle.canonical.initialWorld)) {
      return "initial world differs";
    }
    return null;
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
    const chapterSplits = new ChapterSplitPlanStore(this.workspaceRoot);
    if (bundle.chapterSplitPlan) await chapterSplits.write(bundle.chapterSplitPlan);
    else await chapterSplits.remove(sourceId);
    const source = await (await WorkspaceStore.create(this.workspaceRoot)).getSource(sourceId);
    if (!source) throw new Error(`Prepared revision source is not registered: ${sourceId}`);
    await prepareCompilerBatches(this.workspaceRoot, source, {
      chapterSplitPlan: bundle.chapterSplitPlan ?? null,
    });
    await new CompilerBatchStore(this.workspaceRoot).replaceCompleted(sourceId, bundle.batchIds);
  }

  private async batchLayoutIssue(source: SourceDocument, bundle: PreparedNovelBundle): Promise<string | null> {
    if (canonicalJson(bundle.compilerFingerprint) !== canonicalJson(currentCompilerFingerprint())) {
      return `Cached world was compiled by an incompatible semantic pipeline; reparse is required (cache=${bundle.compilerFingerprint?.pipelineVersion ?? "legacy"}, current=${COMPILER_PIPELINE_VERSION}).`;
    }
    const batches = await prepareCompilerBatches(this.workspaceRoot, source, {
      chapterSplitPlan: bundle.chapterSplitPlan ?? null,
    });
    const currentBatchIds = batches
      .filter((batch) => batch.purpose !== "boundary-calibration")
      .map((batch) => batch.id)
      .sort();
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
      assertPreparedBundleSourceScope(bundle);
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

export function currentCompilerFingerprint(): NonNullable<PreparedNovelBundle["compilerFingerprint"]> {
  return {
    pipelineVersion: COMPILER_PIPELINE_VERSION,
    promptVersion: COMPILER_PROMPT_VERSION,
    engineVersion: WORLD_ENGINE_VERSION,
    stateSchemaHash: contentHash(DEFAULT_STATE_FIELDS),
  };
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

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
import { WORLD_ENGINE_VERSION, attributionSchema, canonicalEventSchema, claimSchema, entitySchema, eventParticipationSchema, eventRelationSchema, propositionSchema, worldRuleSchema, type EvidenceRef } from "../world/model.js";
import { validateEventParticipationCatalog } from "../world/event-semantics.js";
import { validateEventRelationCatalog } from "../world/event-relations.js";
import {
  CHARACTER_ONTOLOGY_VERSION,
  characterOntologyEvidence,
  validateCharacterOntologyEvidenceAssertions,
} from "../world/character-ontology.js";
import {
  RELATIONSHIP_ONTOLOGY_VERSION,
  validateRelationshipOntologyEvidenceAssertions,
} from "../world/relationship-ontology.js";
import {
  spatialRelationEvidence,
  spatialRelationSchema,
  validateSpatialEvidenceAssertions,
  validateSpatialRelationCatalog,
} from "../world/spatial-ontology.js";
import {
  isControlledWorldRule,
  validateWorldRuleCatalog,
  validateWorldRuleEvidenceAssertions,
  worldRuleEvidence,
} from "../world/world-rule-ontology.js";
import { PossibilityTemplateStore, possibilityTemplateSchema } from "../world/possibility-model.js";
import { BranchStore } from "../world/store.js";
import { pinBranchPreparationContexts } from "../world/context.js";
import {
  COMPILER_PIPELINE_VERSION,
  CompilerBatchStore,
  prepareCompilerBatches,
  type PersistedBatchProgress,
} from "./batches.js";
import { SEGMENTER_VERSION } from "./segments.js";
import { CompilerValidator, type CanonicalProposalKind, type CompilerValidationCatalog } from "./validator.js";
import { DEFAULT_STATE_FIELDS } from "../world/state.js";
import { auditCompiler } from "./audit.js";
import { assertEvidenceExclusiveToSource } from "../world/source-scope.js";
import { ChapterSplitPlanStore, chapterSplitPlanSchema } from "./chapter-split.js";
import {
  inferredTitleOccursInEvidence,
  sourceTitleInferenceSchema,
} from "../storage/novel-title.js";
import { EvidenceVerifier } from "./evidence.js";
import {
  EvidenceAssertionStore,
  evidenceAssertionBindingSnapshotSchema,
  validateEvidenceAssertionTargets,
  type EvidenceAssertionBindingSnapshot,
} from "./evidence-assertions.js";
import { SourceAnnotationStore, annotationAnchors, sourceAnnotationSchema } from "./annotations.js";
import { EntityResolutionStore, identityResolutionSchema } from "./entity-resolution.js";
import { EventResolutionStore, eventResolutionSchema } from "./event-resolution.js";
import { SourceStructureStore, sourceStructureManifestSchema } from "./structure.js";
import { SourceAccountingStore, sourceAccountingManifestSchema } from "./source-accounting.js";

export { COMPILER_PIPELINE_VERSION };

const CACHE_FORMAT_VERSION = 1;
export const COMPILER_PROMPT_VERSION = 24;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const md5Schema = z.string().regex(/^[a-f0-9]{32}$/);

const preparedSourceSchema = z.object({
  id: z.string().min(1),
  contentMd5: md5Schema,
  contentSha256: digestSchema,
  titleInference: sourceTitleInferenceSchema.optional(),
}).strict();

const compilerFingerprintSchema = z.object({
  pipelineVersion: z.number().int().positive(),
  promptVersion: z.number().int().positive(),
  engineVersion: z.string().min(1),
  stateSchemaHash: digestSchema,
}).strict();

const preparedRevisionLineageSchema = z.object({
  operation: z.enum(["repair", "reparse"]),
  parentBundleHash: digestSchema,
  runId: z.string().trim().min(1).max(300),
}).strict();
export type PreparedRevisionLineage = z.infer<typeof preparedRevisionLineageSchema>;

const preparedCanonicalSchema = z.object({
  entities: z.array(entitySchema),
  propositions: z.array(propositionSchema).default([]),
  attributions: z.array(attributionSchema).default([]),
  claims: z.array(claimSchema),
  events: z.array(canonicalEventSchema),
  eventParticipations: z.array(eventParticipationSchema).default([]),
  eventRelations: z.array(eventRelationSchema).default([]),
  spatialRelations: z.array(spatialRelationSchema).default([]),
  rules: z.array(worldRuleSchema),
  initialWorld: initialWorldSchema,
  goals: z.array(characterGoalSchema),
  models: z.array(characterModelSchema),
  possibilities: z.array(possibilityTemplateSchema),
}).strict();

const preparedCompilerSnapshotSchema = z.object({
  evidenceBindings: z.array(evidenceAssertionBindingSnapshotSchema),
  structure: sourceStructureManifestSchema,
  annotations: z.array(sourceAnnotationSchema),
  entityResolutions: z.array(identityResolutionSchema),
  eventResolutions: z.array(eventResolutionSchema),
  accounting: sourceAccountingManifestSchema.nullable(),
}).strict();

const preparedBundleCommonShape = {
  source: preparedSourceSchema,
  segmenterVersion: z.number().int().positive(),
  compilerFingerprint: compilerFingerprintSchema.optional(),
  chapterSplitPlan: chapterSplitPlanSchema.optional(),
  batchIds: z.array(z.string().min(1)),
  canonical: preparedCanonicalSchema,
};

const preparedNovelBundleV1Schema = z.object({
  version: z.literal(1),
  ...preparedBundleCommonShape,
}).strict();

const preparedNovelBundleV2Schema = z.object({
  version: z.literal(2),
  ...preparedBundleCommonShape,
  lineage: preparedRevisionLineageSchema.optional(),
  compilerSnapshot: preparedCompilerSnapshotSchema,
}).strict();

const preparedNovelBundleSchema = z.discriminatedUnion("version", [
  preparedNovelBundleV1Schema,
  preparedNovelBundleV2Schema,
]);

export type PreparedNovelBundle = z.infer<typeof preparedNovelBundleSchema>;

function assertPreparedBundleSourceScope(bundle: PreparedNovelBundle): void {
  const sourceId = bundle.source.id;
  if (bundle.source.titleInference && (
    bundle.source.titleInference.sourceId !== sourceId
    || bundle.source.titleInference.evidence.span.sourceId !== sourceId
  )) {
    throw new Error("Prepared bundle novel-title inference does not match its source identity.");
  }
  if (bundle.chapterSplitPlan && (
    bundle.chapterSplitPlan.sourceId !== sourceId
    || bundle.chapterSplitPlan.sourceSha256 !== bundle.source.contentSha256
  )) {
    throw new Error("Prepared bundle chapter split plan does not match its source identity.");
  }
  if (bundle.version === 2) {
    const snapshot = bundle.compilerSnapshot;
    if (snapshot.structure.sourceId !== sourceId
      || snapshot.structure.sourceSha256 !== bundle.source.contentSha256) {
      throw new Error("Prepared compiler structure snapshot does not match its source identity.");
    }
    for (const annotation of snapshot.annotations) {
      if (annotation.sourceId !== sourceId
        || annotationAnchors(annotation).some((anchor) => anchor.sourceId !== sourceId)) {
        throw new Error(`Prepared source annotation ${annotation.id} escapes source ${sourceId}.`);
      }
    }
    for (const resolution of [...snapshot.entityResolutions, ...snapshot.eventResolutions]) {
      if (resolution.sourceId !== sourceId) {
        throw new Error(`Prepared resolution ${resolution.id} escapes source ${sourceId}.`);
      }
    }
    if (snapshot.accounting && (
      snapshot.accounting.sourceId !== sourceId
      || snapshot.accounting.sourceSha256 !== bundle.source.contentSha256
    )) {
      throw new Error("Prepared source-accounting snapshot does not match its source identity.");
    }
    const bindingKeys = new Set<string>();
    const artifactsByKey = new Map<string, { kind: string; id: string; payload: unknown }>(preparedArtifactDescriptors(bundle.canonical)
      .map((artifact) => [`${artifact.kind}/${artifact.id}`, artifact] as const));
    for (const binding of snapshot.evidenceBindings) {
      const key = `${binding.artifactKind}/${binding.artifactId}`;
      if (bindingKeys.has(key)) throw new Error(`Prepared compiler snapshot repeats exact-evidence binding ${key}.`);
      bindingKeys.add(key);
      const artifact = artifactsByKey.get(key);
      if (!artifact || contentHash(artifact.payload) !== binding.artifactHash) {
        throw new Error(`Prepared exact-evidence binding ${key} is missing its artifact or has a stale artifact hash.`);
      }
      for (const assertion of binding.assertions) {
        if (assertion.target.artifactKind !== binding.artifactKind
          || assertion.target.artifactId !== binding.artifactId
          || assertion.anchors.some((anchor) => anchor.sourceId !== sourceId)) {
          throw new Error(`Prepared exact-evidence assertion ${assertion.id} has an invalid source or artifact target.`);
        }
      }
    }
  }
  const collections = [
    bundle.canonical.entities,
    bundle.canonical.propositions,
    bundle.canonical.attributions,
    bundle.canonical.claims,
    bundle.canonical.events,
    bundle.canonical.eventParticipations,
    bundle.canonical.eventRelations,
    bundle.canonical.spatialRelations,
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
  for (const relation of bundle.canonical.eventRelations) {
    assertEvidenceExclusiveToSource(
      [...relation.evidence, ...(relation.counterEvidence ?? [])],
      sourceId,
      `Prepared event relation ${relation.id}`,
    );
  }
  for (const relation of bundle.canonical.spatialRelations) {
    assertEvidenceExclusiveToSource(
      spatialRelationEvidence(relation),
      sourceId,
      `Prepared spatial relation ${relation.id}`,
    );
  }
  for (const rule of bundle.canonical.rules) {
    assertEvidenceExclusiveToSource(
      worldRuleEvidence(rule),
      sourceId,
      `Prepared world rule ${rule.id}`,
    );
  }
  for (const model of bundle.canonical.models) {
    assertEvidenceExclusiveToSource(
      [...model.evidence, ...characterOntologyEvidence(model)],
      sourceId,
      `Prepared character model ${model.actorId}`,
    );
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
  lineage?: PreparedRevisionLineage;
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
    await this.assertTitleInferenceEvidence(cached.bundle);
    const layoutIssue = await this.batchLayoutIssue(source, cached.bundle);
    if (layoutIssue) throw new Error(layoutIssue);
    return {
      bundleHash: cached.manifest.bundleHash,
      bundle: cached.bundle,
      cachePath: cached.cachePath,
    };
  }

  /** Load an immutable branch-pinned revision without consulting the active ref. */
  async loadRevision(
    source: SourceDocument,
    bundleHash: string,
    options: { allowIncompatible?: boolean } = {},
  ): Promise<ActivePreparedNovel | null> {
    if (!/^[a-f0-9]{64}$/.test(bundleHash)) throw new Error(`Invalid prepared revision hash: ${bundleHash}`);
    const identity = await sourceIdentity(this.workspaceRoot, source);
    const cached = await this.readCached(identity.contentMd5, bundleHash);
    if (!cached) return null;
    assertSourceIdentity(cached.bundle, identity);
    await this.assertTitleInferenceEvidence(cached.bundle);
    const layoutIssue = await this.batchLayoutIssue(source, cached.bundle);
    if (layoutIssue && !options.allowIncompatible) throw new Error(layoutIssue);
    return {
      bundleHash: cached.manifest.bundleHash,
      bundle: cached.bundle,
      cachePath: cached.cachePath,
    };
  }

  /** Compare the materialized source workspace with one immutable revision. */
  async workspaceDifferenceFromRevision(source: SourceDocument, bundleHash: string): Promise<string | null> {
    if (!/^[a-f0-9]{64}$/.test(bundleHash)) throw new Error(`Invalid prepared revision hash: ${bundleHash}`);
    const identity = await sourceIdentity(this.workspaceRoot, source);
    const cached = await this.readCached(identity.contentMd5, bundleHash);
    if (!cached) throw new Error(`Prepared cache revision not found: ${identity.contentMd5}@${bundleHash}`);
    assertSourceIdentity(cached.bundle, identity);
    return this.freshnessIssue(cached.bundle);
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

  async publish(
    source: SourceDocument,
    options: { allowSemanticDebtForRollback?: boolean; lineage?: PreparedRevisionLineage } = {},
  ): Promise<PreparedCacheResult> {
    if (options.lineage && !await this.loadRevision(source, options.lineage.parentBundleHash, { allowIncompatible: true })) {
      throw new Error(
        `Cannot publish ${options.lineage.operation} lineage: parent prepared revision ${options.lineage.parentBundleHash} was not found.`,
      );
    }
    const identity = await sourceIdentity(this.workspaceRoot, source);
    const bundle = await this.buildBundle(source, identity, options);
    return this.publishBundle(source, identity, bundle);
  }

  /**
   * Preserve a complete pre-upgrade materialization before its first reparse.
   * The bundle deliberately omits a compiler fingerprint so it remains an
   * incompatible rollback authority and can never masquerade as current work.
   */
  async publishLegacyRollbackBaseline(
    source: SourceDocument,
    checkpoint: PersistedBatchProgress,
  ): Promise<PreparedCacheResult> {
    if (
      checkpoint.sourceId !== source.id
      || checkpoint.pipelineVersion === undefined
      || checkpoint.pipelineVersion >= COMPILER_PIPELINE_VERSION
    ) {
      throw new Error(`Cannot publish a legacy rollback baseline from the current or invalid checkpoint for ${source.id}.`);
    }
    const identity = await sourceIdentity(this.workspaceRoot, source);
    const bundle = await this.buildBundle(source, identity, {
      allowSemanticDebtForRollback: true,
      legacyRollbackCheckpoint: checkpoint,
    });
    return this.publishBundle(source, identity, bundle);
  }

  private async publishBundle(
    source: SourceDocument,
    identity: { contentMd5: string; contentSha256: string },
    bundle: PreparedNovelBundle,
  ): Promise<PreparedCacheResult> {
    const bundleHash = contentHash(bundle);
    if (bundle.version === 2 && bundle.lineage?.parentBundleHash === bundleHash) {
      throw new Error(`Prepared revision ${bundleHash} cannot name itself as its lineage parent.`);
    }
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
        ...(cached.bundle.version === 2 && cached.bundle.lineage ? { lineage: cached.bundle.lineage } : {}),
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
    const registeredSource = await (await WorkspaceStore.create(this.workspaceRoot)).getSource(source.id);
    const pendingTitle = registeredSource?.pendingTitleProposal ? 1 : 0;
    const pendingCompilerMetadata = await pendingSourceCompilerMetadataCount(this.workspaceRoot, source.id);
    if (pending.length || pendingTitle || pendingCompilerMetadata) {
      throw new Error(`Cannot activate a prepared revision while ${pending.length + pendingTitle + pendingCompilerMetadata} source proposal(s) are pending.`);
    }
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
    options: {
      allowSemanticDebtForRollback?: boolean;
      legacyRollbackCheckpoint?: PersistedBatchProgress;
      lineage?: PreparedRevisionLineage;
    },
  ): Promise<PreparedNovelBundle> {
    const proposals = new ProposalStore(this.workspaceRoot);
    const pending = await proposals.list("pending", source.id);
    if (pending.length) throw new Error(`Cannot cache ${source.id}: ${pending.length} source proposal(s) are still pending.`);
    const pendingCompilerMetadata = await pendingSourceCompilerMetadataCount(this.workspaceRoot, source.id);
    if (pendingCompilerMetadata) {
      throw new Error(`Cannot cache ${source.id}: ${pendingCompilerMetadata} source observation/resolution/accounting proposal(s) are still pending.`);
    }
    // Refresh because the successful opening batch can replace the ingest
    // label with accepted model-derived title metadata while callers retain an
    // older SourceDocument snapshot.
    const currentSource = await (await WorkspaceStore.create(this.workspaceRoot)).getSource(source.id);
    if (!currentSource) throw new Error(`Cannot cache unregistered source ${source.id}.`);
    if (currentSource.pendingTitleProposal) {
      throw new Error(`Cannot cache ${source.id}: novel-title proposal ${currentSource.pendingTitleProposal.proposalId} is still pending.`);
    }
    const batches = await prepareCompilerBatches(this.workspaceRoot, source);
    const progress = options.legacyRollbackCheckpoint
      ?? await new CompilerBatchStore(this.workspaceRoot).read(source.id);
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
    const [entities, propositions, attributions, claims, events, eventParticipations, eventRelations, spatialRelations, rules, goals, models, possibilities] = await Promise.all([
      canonical.listEntities(),
      canonical.listPropositions(),
      canonical.listAttributions(),
      canonical.listClaims(),
      canonical.listEvents(),
      canonical.listEventParticipations(),
      canonical.listEventRelations(),
      canonical.listSpatialRelations(),
      canonical.listRules(),
      actors.listGoals(),
      actors.listModels(),
      new PossibilityTemplateStore(this.workspaceRoot).list(),
    ]);
    const chapterSplitPlan = await new ChapterSplitPlanStore(this.workspaceRoot).read(source.id);
    const preparedCanonical = preparedCanonicalSchema.parse({
      entities: fromSource(entities),
      propositions: fromSource(propositions),
      attributions: fromSource(attributions),
      claims: fromSource(claims),
      events: fromSource(events),
      eventParticipations: fromSource(eventParticipations),
      eventRelations: fromSource(eventRelations),
      spatialRelations: fromSource(spatialRelations),
      rules: fromSource(rules),
      initialWorld,
      goals: fromSource(goals),
      models: fromSource(models),
      possibilities: fromSource(possibilities),
    });
    const structure = await new SourceStructureStore(this.workspaceRoot).read(source.id);
    if (!structure || structure.sourceSha256 !== source.contentSha256) {
      throw new Error(`Cannot cache ${source.id}: source structure is missing or stale.`);
    }
    const exactEvidence = new EvidenceAssertionStore(this.workspaceRoot);
    const evidenceBindings: EvidenceAssertionBindingSnapshot[] = [];
    for (const artifact of preparedArtifactDescriptors(preparedCanonical)) {
      const binding = await exactEvidence.bindingForArtifact(artifact.kind, artifact.id);
      if (!binding) continue;
      const artifactHash = contentHash(artifact.payload);
      if (binding.artifactHash !== artifactHash) {
        throw new Error(`Cannot cache ${source.id}: exact-evidence binding ${artifact.kind}/${artifact.id} is stale.`);
      }
      evidenceBindings.push(evidenceAssertionBindingSnapshotSchema.parse({
        artifactKind: artifact.kind,
        artifactId: artifact.id,
        artifactHash,
        assertions: binding.assertions,
      }));
    }
    const [annotations, entityResolutions, eventResolutions, accounting] = await Promise.all([
      new SourceAnnotationStore(this.workspaceRoot).list(source.id),
      new EntityResolutionStore(this.workspaceRoot).list(source.id),
      new EventResolutionStore(this.workspaceRoot).list(source.id),
      new SourceAccountingStore(this.workspaceRoot).read(source.id),
    ]);
    const bundle = preparedNovelBundleSchema.parse({
      version: 2,
      source: {
        id: source.id,
        ...identity,
        ...(currentSource.titleInference ? { titleInference: currentSource.titleInference } : {}),
      },
      segmenterVersion: SEGMENTER_VERSION,
      ...(options.legacyRollbackCheckpoint ? {} : { compilerFingerprint: currentCompilerFingerprint() }),
      ...(options.lineage ? { lineage: options.lineage } : {}),
      ...(chapterSplitPlan ? { chapterSplitPlan } : {}),
      // Boundary calibrations are transient, model-requested workflow checks.
      // Their accepted artifacts are already captured below. Structure discovery
      // is deterministic workflow provenance and is retained with its validated
      // plan so a prepared revision reproduces the same author-chapter layout.
      batchIds: batches
        .filter((batch) => batch.purpose !== "boundary-calibration")
        .map((batch) => batch.id)
        .sort(),
      canonical: preparedCanonical,
      compilerSnapshot: {
        evidenceBindings: evidenceBindings.sort((left, right) =>
          left.artifactKind.localeCompare(right.artifactKind) || left.artifactId.localeCompare(right.artifactId)),
        structure,
        annotations,
        entityResolutions,
        eventResolutions,
        accounting,
      },
    });
    await this.assertTitleInferenceEvidence(bundle);
    assertPreparedBundleSourceScope(bundle);
    await assertPreparedCompilerSnapshotEvidence(this.workspaceRoot, bundle);
    await assertPreparedCharacterEvidence(this.workspaceRoot, bundle);
    await assertPreparedSpatialEvidence(this.workspaceRoot, bundle);
    await assertPreparedWorldRuleEvidence(this.workspaceRoot, bundle);
    assertSelfContainedBaseline(bundle, canonical);
    return bundle;
  }

  private async assertWorkspaceCanMaterialize(bundle: PreparedNovelBundle): Promise<{ compatible: boolean; empty: boolean; reason?: string }> {
    const proposals = new ProposalStore(this.workspaceRoot);
    const branches = new BranchStore(this.workspaceRoot);
    const workspace = await WorkspaceStore.create(this.workspaceRoot);
    const [pending, branchIds, source] = await Promise.all([
      proposals.list("pending"),
      branches.listIds(),
      workspace.getSource(bundle.source.id),
    ]);
    const pendingTitle = source?.pendingTitleProposal ? 1 : 0;
    const pendingCompilerMetadata = await pendingSourceCompilerMetadataCount(this.workspaceRoot, bundle.source.id);
    if (pending.length || pendingTitle || pendingCompilerMetadata || branchIds.length) {
      return {
        compatible: false,
        empty: false,
        reason: `Workspace has ${pending.length + pendingTitle + pendingCompilerMetadata} pending proposal(s) and ${branchIds.length} branch(es); cached baselines are restored only before local world evolution starts.`,
      };
    }
    const current = await currentCanonical(this.workspaceRoot);
    const expected = bundle.canonical;
    const groups = [
      ["entity", current.entities, expected.entities, (item: { id: string }) => item.id],
      ["proposition", current.propositions, expected.propositions, (item: { id: string }) => item.id],
      ["attribution", current.attributions, expected.attributions, (item: { id: string }) => item.id],
      ["claim", current.claims, expected.claims, (item: { id: string }) => item.id],
      ["event", current.events, expected.events, (item: { id: string }) => item.id],
      ["event participation", current.eventParticipations, expected.eventParticipations, (item: { id: string }) => item.id],
      ["event relation", current.eventRelations, expected.eventRelations, (item: { id: string }) => item.id],
      ["spatial relation", current.spatialRelations, expected.spatialRelations, (item: { id: string }) => item.id],
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
    const canonicalEmpty = !current.initialWorld && groups.every(([, actual]) => actual.length === 0);
    if (bundle.version === 2) {
      const snapshot = await this.readCompilerSnapshot(bundle);
      const compilerEmpty = snapshot.annotations.length === 0
        && snapshot.entityResolutions.length === 0
        && snapshot.eventResolutions.length === 0
        && snapshot.evidenceBindings.length === 0
        && snapshot.accounting === null;
      if ((!canonicalEmpty || !compilerEmpty)
        && canonicalJson(snapshot) !== canonicalJson(bundle.compilerSnapshot)) {
        return {
          compatible: false,
          empty: false,
          reason: "Workspace compiler evidence/observation state differs from the active prepared revision.",
        };
      }
      return { compatible: true, empty: canonicalEmpty && compilerEmpty };
    }
    return { compatible: true, empty: canonicalEmpty };
  }

  private async freshnessIssue(bundle: PreparedNovelBundle): Promise<string | null> {
    const pending = await new ProposalStore(this.workspaceRoot).list("pending", bundle.source.id);
    if (pending.length) return `${pending.length} source proposal(s) are pending`;
    const pendingCompilerMetadata = await pendingSourceCompilerMetadataCount(this.workspaceRoot, bundle.source.id);
    if (pendingCompilerMetadata) return `${pendingCompilerMetadata} source observation/resolution/accounting proposal(s) are pending`;
    const source = await (await WorkspaceStore.create(this.workspaceRoot)).getSource(bundle.source.id);
    if (source?.pendingTitleProposal) return "a novel-title proposal is pending";
    if (canonicalJson(source?.titleInference ?? null) !== canonicalJson(bundle.source.titleInference ?? null)) {
      return "novel-title inference differs";
    }
    const current = await currentCanonical(this.workspaceRoot);
    const fromSource = <T extends { id?: string; actorId?: string; evidence: readonly EvidenceRef[] }>(items: readonly T[]) =>
      items.filter((item) => {
        const matches = item.evidence.some((reference) => reference.span.sourceId === bundle.source.id);
        if (matches) assertEvidenceExclusiveToSource(item.evidence, bundle.source.id, `Prepared-cache artifact ${item.id ?? item.actorId ?? "unknown"}`);
        return matches;
      });
    const groups = [
      ["entities", fromSource(current.entities), bundle.canonical.entities, (item: { id: string }) => item.id],
      ["propositions", fromSource(current.propositions), bundle.canonical.propositions, (item: { id: string }) => item.id],
      ["attributions", fromSource(current.attributions), bundle.canonical.attributions, (item: { id: string }) => item.id],
      ["claims", fromSource(current.claims), bundle.canonical.claims, (item: { id: string }) => item.id],
      ["events", fromSource(current.events), bundle.canonical.events, (item: { id: string }) => item.id],
      ["event participations", fromSource(current.eventParticipations), bundle.canonical.eventParticipations, (item: { id: string }) => item.id],
      ["event relations", fromSource(current.eventRelations), bundle.canonical.eventRelations, (item: { id: string }) => item.id],
      ["spatial relations", fromSource(current.spatialRelations), bundle.canonical.spatialRelations, (item: { id: string }) => item.id],
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
    const currentCompilerSnapshot = bundle.version === 2 ? await this.readCompilerSnapshot(bundle) : undefined;
    const hasCompilerMaterialized = Boolean(currentCompilerSnapshot && (
      currentCompilerSnapshot.annotations.length
      || currentCompilerSnapshot.entityResolutions.length
      || currentCompilerSnapshot.eventResolutions.length
      || currentCompilerSnapshot.evidenceBindings.length
      || currentCompilerSnapshot.accounting
    ));
    const hasMaterializedSource = groups.some(([, actual]) => actual.length > 0)
      || Boolean(currentInitialForSource)
      || hasCompilerMaterialized;
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
    if (bundle.version === 2) {
      if (canonicalJson(currentCompilerSnapshot) !== canonicalJson(bundle.compilerSnapshot)) {
        return "source observations, identity resolutions, accounting, or exact evidence bindings differ";
      }
    }
    return null;
  }

  private async readCompilerSnapshot(bundle: PreparedNovelBundle): Promise<{
    evidenceBindings: EvidenceAssertionBindingSnapshot[];
    structure: Awaited<ReturnType<SourceStructureStore["read"]>>;
    annotations: Awaited<ReturnType<SourceAnnotationStore["list"]>>;
    entityResolutions: Awaited<ReturnType<EntityResolutionStore["list"]>>;
    eventResolutions: Awaited<ReturnType<EventResolutionStore["list"]>>;
    accounting: Awaited<ReturnType<SourceAccountingStore["read"]>>;
  }> {
    const sourceId = bundle.source.id;
    const exactEvidence = new EvidenceAssertionStore(this.workspaceRoot);
    const evidenceBindings: EvidenceAssertionBindingSnapshot[] = [];
    for (const artifact of preparedArtifactDescriptors(bundle.canonical)) {
      const binding = await exactEvidence.bindingForArtifact(artifact.kind, artifact.id);
      if (!binding) continue;
      evidenceBindings.push(evidenceAssertionBindingSnapshotSchema.parse({
        artifactKind: artifact.kind,
        artifactId: artifact.id,
        artifactHash: binding.artifactHash,
        assertions: binding.assertions,
      }));
    }
    const [structure, annotations, entityResolutions, eventResolutions, accounting] = await Promise.all([
      new SourceStructureStore(this.workspaceRoot).read(sourceId),
      new SourceAnnotationStore(this.workspaceRoot).list(sourceId),
      new EntityResolutionStore(this.workspaceRoot).list(sourceId),
      new EventResolutionStore(this.workspaceRoot).list(sourceId),
      new SourceAccountingStore(this.workspaceRoot).read(sourceId),
    ]);
    return {
      evidenceBindings: evidenceBindings.sort((left, right) =>
        left.artifactKind.localeCompare(right.artifactKind) || left.artifactId.localeCompare(right.artifactId)),
      structure,
      annotations,
      entityResolutions,
      eventResolutions,
      accounting,
    };
  }

  private async materialize(bundle: PreparedNovelBundle, exact: boolean): Promise<void> {
    const sourceId = bundle.source.id;
    const workspace = await WorkspaceStore.create(this.workspaceRoot);
    await assertPreparedCompilerSnapshotEvidence(this.workspaceRoot, bundle);
    if (bundle.source.titleInference) {
      await this.assertTitleInferenceEvidence(bundle);
    }
    await workspace.replaceSourceTitleInference(sourceId, bundle.source.titleInference ?? null);
    const canonical = new CanonicalModelStore(this.workspaceRoot);
    const actors = new ActorModelStore(this.workspaceRoot);
    const possibilities = new PossibilityTemplateStore(this.workspaceRoot);
    const currentBefore = exact || bundle.version === 2
      ? await currentCanonical(this.workspaceRoot)
      : undefined;
    if (exact) {
      const current = currentBefore!;
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
      await removeMissing(current.propositions, new Set(bundle.canonical.propositions.map((item) => item.id)), (item) => item.id, (id) => canonical.removeCurrent("propositions", id));
      await removeMissing(current.attributions, new Set(bundle.canonical.attributions.map((item) => item.id)), (item) => item.id, (id) => canonical.removeCurrent("attributions", id));
      await removeMissing(current.claims, new Set(bundle.canonical.claims.map((item) => item.id)), (item) => item.id, (id) => canonical.removeCurrent("claims", id));
      await removeMissing(current.events, new Set(bundle.canonical.events.map((item) => item.id)), (item) => item.id, (id) => canonical.removeCurrent("events", id));
      await removeMissing(current.eventParticipations, new Set(bundle.canonical.eventParticipations.map((item) => item.id)), (item) => item.id, (id) => canonical.removeCurrent("event-participations", id));
      await removeMissing(current.eventRelations, new Set(bundle.canonical.eventRelations.map((item) => item.id)), (item) => item.id, (id) => canonical.removeCurrent("event-relations", id));
      await removeMissing(current.spatialRelations, new Set(bundle.canonical.spatialRelations.map((item) => item.id)), (item) => item.id, (id) => canonical.removeCurrent("spatial-relations", id));
      await removeMissing(current.rules, new Set(bundle.canonical.rules.map((item) => item.id)), (item) => item.id, (id) => canonical.removeCurrent("rules", id));
      await removeMissing(current.goals, new Set(bundle.canonical.goals.map((item) => item.id)), (item) => item.id, (id) => actors.removeGoal(id));
      await removeMissing(current.models, new Set(bundle.canonical.models.map((item) => item.actorId)), (item) => item.actorId, (id) => actors.removeModel(id));
      await removeMissing(current.possibilities, new Set(bundle.canonical.possibilities.map((item) => item.id)), (item) => item.id, (id) => possibilities.remove(id));
    }
    for (const entity of bundle.canonical.entities) await canonical.putEntity(entity);
    for (const proposition of bundle.canonical.propositions) await canonical.putProposition(proposition);
    for (const attribution of bundle.canonical.attributions) await canonical.putAttribution(attribution);
    for (const claim of bundle.canonical.claims) await canonical.putClaim(claim);
    for (const rule of bundle.canonical.rules) await canonical.putRule(rule);
    for (const event of bundle.canonical.events) await canonical.putEvent(event);
    for (const participation of bundle.canonical.eventParticipations) await canonical.putEventParticipation(participation);
    for (const relation of bundle.canonical.eventRelations) await canonical.putEventRelation(relation);
    for (const relation of bundle.canonical.spatialRelations) await canonical.putSpatialRelation(relation);
    await new InitialWorldStore(this.workspaceRoot).put(bundle.canonical.initialWorld);
    for (const goal of bundle.canonical.goals) await actors.putGoal(goal);
    for (const model of bundle.canonical.models) await actors.putModel(model);
    for (const possibility of bundle.canonical.possibilities) await possibilities.put(possibility);
    if (bundle.version === 2) {
      const snapshot = bundle.compilerSnapshot;
      await new SourceStructureStore(this.workspaceRoot).write(snapshot.structure);
      await new SourceAnnotationStore(this.workspaceRoot).replaceCurrent(sourceId, snapshot.annotations);
      await new EntityResolutionStore(this.workspaceRoot).replaceCurrent(sourceId, snapshot.entityResolutions);
      await new EventResolutionStore(this.workspaceRoot).replaceCurrent(sourceId, snapshot.eventResolutions);
      await new SourceAccountingStore(this.workspaceRoot).replaceCurrent(sourceId, snapshot.accounting);
      const exactEvidence = new EvidenceAssertionStore(this.workspaceRoot);
      const currentDescriptors = currentBefore
        ? preparedArtifactDescriptors(currentBefore)
          .filter((artifact) => artifactBelongsToSource(artifact.payload, sourceId))
        : [];
      const bindingKeys = new Map([
        ...currentDescriptors.map((artifact) => [`${artifact.kind}/${artifact.id}`, artifact] as const),
        ...preparedArtifactDescriptors(bundle.canonical).map((artifact) => [`${artifact.kind}/${artifact.id}`, artifact] as const),
      ]);
      for (const artifact of bindingKeys.values()) {
        await exactEvidence.removeForArtifact(artifact.kind, artifact.id);
      }
      await exactEvidence.restoreBindings(snapshot.evidenceBindings);
    } else {
      // Legacy bundles did not carry compiler observations or exact evidence.
      // Exact activation must materialize that honest absence instead of
      // retaining metadata from a newer, potentially failed compilation.
      await new SourceAnnotationStore(this.workspaceRoot).replaceCurrent(sourceId, []);
      await new EntityResolutionStore(this.workspaceRoot).replaceCurrent(sourceId, []);
      await new EventResolutionStore(this.workspaceRoot).replaceCurrent(sourceId, []);
      await new SourceAccountingStore(this.workspaceRoot).replaceCurrent(sourceId, null);
      const exactEvidence = new EvidenceAssertionStore(this.workspaceRoot);
      const currentDescriptors = currentBefore
        ? preparedArtifactDescriptors(currentBefore)
          .filter((artifact) => artifactBelongsToSource(artifact.payload, sourceId))
        : [];
      const bindingKeys = new Map([
        ...currentDescriptors.map((artifact) => [`${artifact.kind}/${artifact.id}`, artifact] as const),
        ...preparedArtifactDescriptors(bundle.canonical).map((artifact) => [`${artifact.kind}/${artifact.id}`, artifact] as const),
      ]);
      for (const artifact of bindingKeys.values()) {
        await exactEvidence.removeForArtifact(artifact.kind, artifact.id);
      }
    }
    const chapterSplits = new ChapterSplitPlanStore(this.workspaceRoot);
    if (bundle.chapterSplitPlan) await chapterSplits.write(bundle.chapterSplitPlan);
    else await chapterSplits.remove(sourceId);
    const source = await workspace.getSource(sourceId);
    if (!source) throw new Error(`Prepared revision source is not registered: ${sourceId}`);
    await prepareCompilerBatches(this.workspaceRoot, source, {
      chapterSplitPlan: bundle.chapterSplitPlan ?? null,
    });
    await new CompilerBatchStore(this.workspaceRoot).replaceCompleted(sourceId, bundle.batchIds);
  }

  private async assertTitleInferenceEvidence(bundle: PreparedNovelBundle): Promise<void> {
    const inference = bundle.source.titleInference;
    if (!inference) return;
    const verification = await new EvidenceVerifier(this.workspaceRoot).inspect(inference.evidence);
    if (!verification.valid || verification.excerpt === undefined) {
      throw new Error(
        `Prepared revision novel-title evidence is invalid: ${verification.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`,
      );
    }
    if (!inferredTitleOccursInEvidence(inference.title, verification.excerpt)) {
      throw new Error("Prepared revision novel title does not occur in its verified source evidence.");
    }
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
      await this.writeRevisionDirectory(contentMd5, legacy.manifest, legacy.rawBundle);
    }
    if (!await this.readActive(contentMd5)) await this.writeActive(contentMd5, legacy.manifest.bundleHash);
  }

  private async writeRevisionDirectory(
    contentMd5: string,
    manifest: z.infer<typeof preparedNovelManifestSchema>,
    rawBundle: unknown,
  ): Promise<void> {
    if (contentHash(rawBundle) !== manifest.bundleHash) {
      throw new Error(`Prepared cache migration payload does not match immutable bundle hash ${manifest.bundleHash}.`);
    }
    const revisionsRoot = path.join(this.cachePath(contentMd5), "revisions");
    await fs.mkdir(revisionsRoot, { recursive: true, mode: 0o700 });
    const target = this.revisionPath(contentMd5, manifest.bundleHash);
    const staging = path.join(revisionsRoot, `.${manifest.bundleHash}.${process.pid}.${crypto.randomUUID()}.tmp`);
    await fs.mkdir(staging, { mode: 0o700 });
    try {
      await fs.writeFile(path.join(staging, "bundle.json"), `${canonicalJson(rawBundle)}\n`, { encoding: "utf8", mode: 0o400, flag: "wx" });
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
    rawBundle: unknown;
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
    rawBundle: unknown;
    cachePath: string;
  } | null> {
    try {
      const [manifestRaw, bundleRaw] = await Promise.all([
        fs.readFile(path.join(directory, "manifest.json"), "utf8"),
        fs.readFile(path.join(directory, "bundle.json"), "utf8"),
      ]);
      const manifest = preparedNovelManifestSchema.parse(JSON.parse(manifestRaw));
      const rawBundle: unknown = JSON.parse(bundleRaw);
      if (contentHash(rawBundle) !== manifest.bundleHash) throw new Error(`Prepared cache bundle hash mismatch: ${directory}`);
      const bundle = preparedNovelBundleSchema.parse(rawBundle);
      assertPreparedBundleSourceScope(bundle);
      if (manifest.contentMd5 !== contentMd5 || bundle.source.contentMd5 !== contentMd5) throw new Error(`Prepared cache path/digest mismatch: ${directory}`);
      if (
        manifest.contentSha256 !== bundle.source.contentSha256
        || manifest.sourceId !== bundle.source.id
        || bundle.source.id !== bundle.source.contentSha256.slice(0, 20)
      ) throw new Error(`Prepared cache source identity mismatch: ${directory}`);
      return { manifest, bundle, rawBundle, cachePath: directory };
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

type PreparedCanonical = z.infer<typeof preparedCanonicalSchema>;

function preparedArtifactDescriptors(canonical: {
  entities: PreparedCanonical["entities"];
  propositions: PreparedCanonical["propositions"];
  attributions: PreparedCanonical["attributions"];
  claims: PreparedCanonical["claims"];
  events: PreparedCanonical["events"];
  eventParticipations: PreparedCanonical["eventParticipations"];
  eventRelations: PreparedCanonical["eventRelations"];
  spatialRelations: PreparedCanonical["spatialRelations"];
  rules: PreparedCanonical["rules"];
  initialWorld: PreparedCanonical["initialWorld"] | null;
  goals: PreparedCanonical["goals"];
  models: PreparedCanonical["models"];
  possibilities: PreparedCanonical["possibilities"];
}): Array<{ kind: string; id: string; payload: unknown }> {
  return [
    ...canonical.entities.map((payload) => ({ kind: "entity", id: payload.id, payload })),
    ...canonical.propositions.map((payload) => ({ kind: "proposition", id: payload.id, payload })),
    ...canonical.attributions.map((payload) => ({ kind: "attribution", id: payload.id, payload })),
    ...canonical.claims.map((payload) => ({ kind: "claim", id: payload.id, payload })),
    ...canonical.events.map((payload) => ({ kind: "canonical-event", id: payload.id, payload })),
    ...canonical.eventParticipations.map((payload) => ({ kind: "event-participation", id: payload.id, payload })),
    ...canonical.eventRelations.map((payload) => ({ kind: "event-relation", id: payload.id, payload })),
    ...canonical.spatialRelations.map((payload) => ({ kind: "spatial-relation", id: payload.id, payload })),
    ...canonical.rules.map((payload) => ({ kind: "world-rule", id: payload.id, payload })),
    ...(canonical.initialWorld ? [{ kind: "initial-world", id: "initial-world", payload: canonical.initialWorld }] : []),
    ...canonical.goals.map((payload) => ({ kind: "character-goal", id: payload.id, payload })),
    ...canonical.models.map((payload) => ({ kind: "character-model", id: payload.actorId, payload })),
    ...canonical.possibilities.map((payload) => ({ kind: "possibility", id: payload.id, payload })),
  ];
}

function artifactBelongsToSource(payload: unknown, sourceId: string): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const evidence = (payload as { evidence?: unknown }).evidence;
  if (!Array.isArray(evidence) || evidence.length === 0) return false;
  return evidence.every((candidate) => candidate
    && typeof candidate === "object"
    && !Array.isArray(candidate)
    && (candidate as { span?: { sourceId?: unknown } }).span?.sourceId === sourceId);
}

async function pendingSourceCompilerMetadataCount(workspaceRoot: string, sourceId: string): Promise<number> {
  const [annotations, entityResolutions, eventResolutions, accounting] = await Promise.all([
    new SourceAnnotationStore(workspaceRoot).listProposals(sourceId, "pending"),
    new EntityResolutionStore(workspaceRoot).listProposals(sourceId, "pending"),
    new EventResolutionStore(workspaceRoot).listProposals(sourceId, "pending"),
    new SourceAccountingStore(workspaceRoot).listProposals(sourceId, "pending"),
  ]);
  return annotations.length + entityResolutions.length + eventResolutions.length + accounting.length;
}

async function currentCanonical(workspaceRoot: string) {
  const canonical = new CanonicalModelStore(workspaceRoot);
  const actors = new ActorModelStore(workspaceRoot);
  return {
    entities: await canonical.listEntities(),
    propositions: await canonical.listPropositions(),
    attributions: await canonical.listAttributions(),
    claims: await canonical.listClaims(),
    events: await canonical.listEvents(),
    eventParticipations: await canonical.listEventParticipations(),
    eventRelations: await canonical.listEventRelations(),
    spatialRelations: await canonical.listSpatialRelations(),
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

async function assertPreparedCharacterEvidence(
  workspaceRoot: string,
  bundle: PreparedNovelBundle,
): Promise<void> {
  const exactEvidence = new EvidenceAssertionStore(workspaceRoot);
  const verifier = new EvidenceVerifier(workspaceRoot);
  for (const model of bundle.canonical.models) {
    if (model.ontologyVersion !== CHARACTER_ONTOLOGY_VERSION
      && model.relationshipOntologyVersion !== RELATIONSHIP_ONTOLOGY_VERSION) continue;
    const binding = await exactEvidence.bindingForArtifact("character-model", model.actorId);
    if (!binding?.assertions.length) {
      throw new Error(`Prepared controlled character/relationship model ${model.actorId} has no exact evidence binding.`);
    }
    if (binding.artifactHash !== contentHash(model)) {
      throw new Error(`Prepared controlled character/relationship model ${model.actorId} has a stale exact evidence binding.`);
    }
    const issues = [
      ...validateCharacterOntologyEvidenceAssertions(model, binding.assertions),
      ...validateRelationshipOntologyEvidenceAssertions(model, binding.assertions),
      ...(await verifier.verifyAssertions(binding.assertions)).issues,
    ];
    if (issues.length) {
      throw new Error(`Prepared controlled character/relationship model ${model.actorId} has invalid exact evidence: ${issues
        .map((issue) => `${issue.code}${issue.path ? ` at ${issue.path}` : ""}: ${issue.message}`)
        .join("; ")}`);
    }
  }
}

async function assertPreparedCompilerSnapshotEvidence(
  workspaceRoot: string,
  bundle: PreparedNovelBundle,
): Promise<void> {
  if (bundle.version !== 2) return;
  const artifacts = new Map(preparedArtifactDescriptors(bundle.canonical)
    .map((artifact) => [`${artifact.kind}/${artifact.id}`, artifact] as const));
  const verifier = new EvidenceVerifier(workspaceRoot);
  for (const binding of bundle.compilerSnapshot.evidenceBindings) {
    const artifact = artifacts.get(`${binding.artifactKind}/${binding.artifactId}`);
    if (!artifact) {
      throw new Error(`Prepared exact-evidence binding ${binding.artifactKind}/${binding.artifactId} has no canonical artifact.`);
    }
    const issues = [
      ...validateEvidenceAssertionTargets(
        binding.artifactKind,
        binding.artifactId,
        artifact.payload,
        binding.assertions,
      ),
      ...(await verifier.verifyAssertions(binding.assertions)).issues,
    ];
    if (issues.length) {
      throw new Error(`Prepared exact-evidence binding ${binding.artifactKind}/${binding.artifactId} is invalid: ${issues
        .map((issue) => `${issue.code}${issue.path ? ` at ${issue.path}` : ""}: ${issue.message}`)
        .join("; ")}`);
    }
  }
}

async function assertPreparedSpatialEvidence(
  workspaceRoot: string,
  bundle: PreparedNovelBundle,
): Promise<void> {
  const exactEvidence = new EvidenceAssertionStore(workspaceRoot);
  const verifier = new EvidenceVerifier(workspaceRoot);
  for (const relation of bundle.canonical.spatialRelations) {
    const binding = await exactEvidence.bindingForArtifact("spatial-relation", relation.id);
    if (!binding?.assertions.length) {
      throw new Error(`Prepared spatial relation ${relation.id} has no exact evidence binding.`);
    }
    if (binding.artifactHash !== contentHash(relation)) {
      throw new Error(`Prepared spatial relation ${relation.id} has a stale exact evidence binding.`);
    }
    const issues = [
      ...validateSpatialEvidenceAssertions(relation, binding.assertions),
      ...(await verifier.verifyAssertions(binding.assertions)).issues,
    ];
    if (issues.length) {
      throw new Error(`Prepared spatial relation ${relation.id} has invalid exact evidence: ${issues
        .map((issue) => `${issue.code}${issue.path ? ` at ${issue.path}` : ""}: ${issue.message}`)
        .join("; ")}`);
    }
  }
}

async function assertPreparedWorldRuleEvidence(
  workspaceRoot: string,
  bundle: PreparedNovelBundle,
): Promise<void> {
  const exactEvidence = new EvidenceAssertionStore(workspaceRoot);
  const verifier = new EvidenceVerifier(workspaceRoot);
  for (const rule of bundle.canonical.rules) {
    if (!isControlledWorldRule(rule)) continue;
    const binding = await exactEvidence.bindingForArtifact("world-rule", rule.id);
    if (!binding?.assertions.length) {
      throw new Error(`Prepared controlled world rule ${rule.id} has no exact evidence binding.`);
    }
    if (binding.artifactHash !== contentHash(rule)) {
      throw new Error(`Prepared controlled world rule ${rule.id} has a stale exact evidence binding.`);
    }
    const issues = [
      ...validateWorldRuleEvidenceAssertions(rule, binding.assertions),
      ...(await verifier.verifyAssertions(binding.assertions)).issues,
    ];
    if (issues.length) {
      throw new Error(`Prepared controlled world rule ${rule.id} has invalid exact evidence: ${issues
        .map((issue) => `${issue.code}${issue.path ? ` at ${issue.path}` : ""}: ${issue.message}`)
        .join("; ")}`);
    }
  }
}

function assertSelfContainedBaseline(bundle: PreparedNovelBundle, canonicalStore: CanonicalModelStore): void {
  const catalog: CompilerValidationCatalog = {
    entities: new Map(bundle.canonical.entities.map((item) => [item.id, item])),
    propositions: new Map(bundle.canonical.propositions.map((item) => [item.id, item])),
    attributions: new Map(bundle.canonical.attributions.map((item) => [item.id, item])),
    claims: new Map(bundle.canonical.claims.map((item) => [item.id, item])),
    events: new Map(bundle.canonical.events.map((item) => [item.id, item])),
    eventParticipations: new Map(bundle.canonical.eventParticipations.map((item) => [item.id, item])),
    eventRelations: new Map(bundle.canonical.eventRelations.map((item) => [item.id, item])),
    spatialRelations: new Map(bundle.canonical.spatialRelations.map((item) => [item.id, item])),
    rules: new Map(bundle.canonical.rules.map((item) => [item.id, item])),
    goals: new Map(bundle.canonical.goals.map((item) => [item.id, item])),
  };
  const validator = new CompilerValidator(canonicalStore);
  const artifacts: Array<{ kind: CanonicalProposalKind; label: string; payload: unknown }> = [
    ...bundle.canonical.entities.map((payload) => ({ kind: "entity" as const, label: payload.id, payload })),
    ...bundle.canonical.propositions.map((payload) => ({ kind: "proposition" as const, label: payload.id, payload })),
    ...bundle.canonical.attributions.map((payload) => ({ kind: "attribution" as const, label: payload.id, payload })),
    ...bundle.canonical.claims.map((payload) => ({ kind: "claim" as const, label: payload.id, payload })),
    ...bundle.canonical.rules.map((payload) => ({ kind: "world-rule" as const, label: payload.id, payload })),
    ...bundle.canonical.events.map((payload) => ({ kind: "canonical-event" as const, label: payload.id, payload })),
    ...bundle.canonical.eventParticipations.map((payload) => ({ kind: "event-participation" as const, label: payload.id, payload })),
    ...bundle.canonical.eventRelations.map((payload) => ({ kind: "event-relation" as const, label: payload.id, payload })),
    ...bundle.canonical.spatialRelations.map((payload) => ({ kind: "spatial-relation" as const, label: payload.id, payload })),
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
  const participationIssues = validateEventParticipationCatalog({
    entities: catalog.entities,
    events: catalog.events,
    participations: catalog.eventParticipations.values(),
  });
  if (participationIssues.length) {
    throw new Error(`Cannot cache source-isolated baseline: typed event participation projection is invalid (${participationIssues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}).`);
  }
  const relationIssues = validateEventRelationCatalog({
    events: catalog.events,
    relations: catalog.eventRelations.values(),
  });
  if (relationIssues.length) {
    throw new Error(`Cannot cache source-isolated baseline: typed event relation projection is invalid (${relationIssues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}).`);
  }
  const spatialIssues = validateSpatialRelationCatalog(bundle.canonical.spatialRelations, {
    entities: catalog.entities,
    events: catalog.events,
    claims: new Set(catalog.claims.keys()),
    rules: new Set(catalog.rules.keys()),
  });
  if (spatialIssues.length) {
    throw new Error(`Cannot cache source-isolated baseline: spatial relation projection is invalid (${spatialIssues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}).`);
  }
  const ruleIssues = validateWorldRuleCatalog(bundle.canonical.rules, {
    entities: catalog.entities,
    events: catalog.events,
    claims: new Set(catalog.claims.keys()),
    rules: catalog.rules,
  });
  if (ruleIssues.length) {
    throw new Error(`Cannot cache source-isolated baseline: world-rule projection is invalid (${ruleIssues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}).`);
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

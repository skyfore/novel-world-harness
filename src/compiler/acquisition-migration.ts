import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { acquisitionInputSchema, acquisitionCatalog, validateAcquisitionOperation } from "../world/acquisition.js";
import { modelEvidenceSelectorSchema } from "./text-anchors.js";
import { PreparedNovelCache } from "./prepared-cache.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { CanonicalModelStore } from "../world/canonical-model.js";
import { contentHash } from "../world/canonical.js";
import { WorldContextStore } from "../world/context.js";
import { createCompilerProposalToolset } from "./proposal-tools.js";
import { convergeWorldProposals } from "./converge.js";
import { EvidenceAssertionStore } from "./evidence-assertions.js";
import { prepareCompilerBatches } from "./batches.js";
import { type CanonicalEvent, type KnowledgeOperation } from "../world/model.js";

/** A reviewed manifest supplies evidence; a legacy status is never evidence of understanding. */
export const acquisitionMigrationManifestSchema = z.object({
  version: z.literal(1), sourceId: z.string().min(1), parentBundleHash: z.string().regex(/^[a-f0-9]{64}$/),
  entries: z.array(z.object({
    eventHash: z.string().regex(/^[a-f0-9]{64}$/), operationIndex: z.number().int().nonnegative(),
    acquisition: acquisitionInputSchema,
    evidence_segment_ids: z.array(z.string().min(1)).min(1),
    evidence_selectors: z.array(modelEvidenceSelectorSchema).min(1),
  }).strict()).min(1).max(256),
}).strict();
export type AcquisitionMigrationManifest = z.infer<typeof acquisitionMigrationManifestSchema>;

/** Fork an immutable candidate; never rewrite staging, active pointers or runtime histories. */
export async function migrateLegacyAcquisitions(options: { root: string; manifest: unknown; cacheRoot?: string }) {
  const manifest = acquisitionMigrationManifestSchema.parse(options.manifest);
  const workspace = await WorkspaceStore.create(options.root), source = await workspace.getSource(manifest.sourceId);
  if (!source) throw new Error("ACQUISITION_MIGRATION_SOURCE_MISSING: inspect this workspace's registered sources; stop without guessing or retrying unchanged.");
  const cache = new PreparedNovelCache(options.root, options.cacheRoot);
  if (!await cache.loadRevision(source, manifest.parentBundleHash, { allowIncompatible: true })) throw new Error("ACQUISITION_MIGRATION_PARENT_MISSING: preserve the manifest; inspect same-source prepared revisions and copy the exact bundleHash for one corrected retry. Do not substitute another novel.");
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-acquisition-migration-"));
  try {
    const fork = await WorkspaceStore.create(stagingRoot);
    const forkSource = await fork.registerSourceContent(source.title, await readSourceMaterial(options.root, source));
    await prepareCompilerBatches(stagingRoot, forkSource);
    const forkCache = new PreparedNovelCache(stagingRoot, cache.root);
    await forkCache.restoreCompilerCheckpoint(forkSource, manifest.parentBundleHash);
    const canon = new CanonicalModelStore(stagingRoot), evidence = new EvidenceAssertionStore(stagingRoot);
    const originals = new Map((await canon.listEvents()).map(event => [event.id, event]));
    const expressions = new Map((await canon.listUtteranceExpressions()).map(value => [value.id, value]));
    const changed = new Map<string, CanonicalEvent>();
    const acquisitionIds = new Set((await canon.listAcquisitions()).map(value => value.id)), targets = new Set<string>();
    for (const entry of manifest.entries) {
      const value = entry.acquisition, original = originals.get(value.canonicalEventId), target = `${value.canonicalEventId}/${entry.operationIndex}`;
      if (!original || contentHash(original) !== entry.eventHash) throw new Error(`ACQUISITION_MIGRATION_STALE: ${target}; preserve parent and stop for evidence review.`);
      if (targets.has(target) || acquisitionIds.has(value.id)) throw new Error(`ACQUISITION_MIGRATION_DUPLICATE: ${target}; stop without overwriting an existing receipt.`);
      targets.add(target); acquisitionIds.add(value.id);
      const old = original.observedKnowledge?.operations[entry.operationIndex];
      if (!old || old.op !== "learn" || old.acquisitionId || old.actorId !== value.actorId || old.claimId !== value.claimId) throw new Error(`ACQUISITION_MIGRATION_TARGET_MISMATCH: ${target}; stop, only the exact legacy recipient operation may be upgraded.`);
      const basis = value.basis;
      const sourceActorId = basis.mode === "told" ? expressions.get(basis.expressionId)?.speakerId : basis.mode === "deceived-misattributed" ? basis.actualSourceActorId : undefined;
      if (old.sourceActorId !== undefined && old.sourceActorId !== sourceActorId) throw new Error(`ACQUISITION_MIGRATION_CONTENT_CHANGE: ${target}/sourceActorId; stop rather than rewriting the recorded source.`);
      const operation: KnowledgeOperation = { ...old, acquisitionId: value.id, propositionId: value.propositionId, acquisitionMode: basis.mode,
        ...(sourceActorId ? { sourceActorId } : {}),
        ...("expressionId" in basis ? { expressionId: basis.expressionId } : {}), ...("attributionId" in basis ? { attributionId: basis.attributionId } : {}), ...(basis.mode === "observed" ? { perceptionId: basis.perceptionId } : {}) };
      for (const field of ["propositionId", "acquisitionMode", "expressionId", "attributionId", "perceptionId"] as const) if (old[field] !== undefined && old[field] !== operation[field]) throw new Error(`ACQUISITION_MIGRATION_CONTENT_CHANGE: ${target}/${field}; stop for a separate evidence-backed repair.`);
      const event = changed.get(original.id) ?? structuredClone(original);
      event.observedKnowledge!.operations[entry.operationIndex] = operation;
      changed.set(event.id, event);
    }
    // Stage the complete event revisions first so the proposal tool freezes their
    // final hashes, including every receipt reference, without a dependency cycle.
    for (const event of changed.values()) {
      await canon.putEvent(event);
      const assertions = await evidence.listForArtifact("canonical-event", event.id);
      if (assertions.length) await evidence.replaceForArtifact("canonical-event", event.id, contentHash(event), assertions);
    }
    const toolset = createCompilerProposalToolset(stagingRoot), runId = `acquisition-migration-${contentHash(manifest).slice(0, 24)}`;
    await toolset.beginBatch([], runId, forkSource.id);
    const invoke = async (name: string, input: unknown) => {
      await toolset.tools.find(tool => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
    };
    for (const [index, entry] of manifest.entries.entries()) await invoke("propose_acquisition", { proposal_id: `${runId}-${index}`, payload: entry.acquisition, evidence_segment_ids: entry.evidence_segment_ids, evidence_selectors: entry.evidence_selectors });
    await invoke("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Explicit legacy recipient migration; exact selectors independently bind receipt, understanding and belief." });
    const convergence = await convergeWorldProposals(stagingRoot, forkSource.id);
    if (convergence.canonical.blocked.length) throw new Error(`ACQUISITION_MIGRATION_BLOCKED: ${JSON.stringify(convergence.canonical.blocked)}`);
    const context = await new WorldContextStore(stagingRoot).captureCurrent(forkSource.id);
    for (const entry of manifest.entries) {
      const event = changed.get(entry.acquisition.canonicalEventId)!;
      const issues = validateAcquisitionOperation(event.observedKnowledge!.operations[entry.operationIndex]!, acquisitionCatalog(context), undefined, event.id);
      if (issues.length) throw new Error(issues.map(issue => `${issue.code}: ${issue.message}`).join("; "));
    }
    const candidate = await forkCache.archiveCandidate(forkSource, { lineage: { operation: "repair", parentBundleHash: manifest.parentBundleHash, runId } });
    await fs.writeFile(path.join(stagingRoot, "acquisition-migration.json"), JSON.stringify({ manifest, candidateBundleHash: candidate.bundleHash }, null, 2) + "\n");
    return { sourceId: source.id, parentBundleHash: manifest.parentBundleHash, candidateBundleHash: candidate.bundleHash!, migratedOperations: manifest.entries.length, stagingRoot };
  } catch (cause) {
    throw new Error(`Acquisition migration stopped; isolated review workspace: ${stagingRoot}. Parent, publication and branch history are unchanged. Fix missing evidence in the manifest before one corrected run; never invent sources or retry unchanged. ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

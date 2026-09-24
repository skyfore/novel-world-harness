import { CompilerFinishReceipts } from "./finish-receipts.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { SourceMaterialStore } from "../storage/source-material-store.js";
import { CanonicalModelStore } from "../world/canonical-model.js";
import { CompilerValidator } from "./validator.js";
import { RequirementLedger, requirementResultIssues, sceneCatalogKeys, type RequirementSet } from "./requirement-ledger.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";
import { sceneCapabilitySpecSchema, type SceneReviewCatalog } from "../eval/scene-capabilities.js";

export async function requirementInputs(root: string, sourceId: string) {
  const source = await WorkspaceStore.openReadOnly(root).getSource(sourceId);
  if (!source) throw new Error("Requirement source is not registered; stop for host source review.");
  const bytes = await new SourceMaterialStore().read(source);
  if (!bytes) throw new Error("Requirement source bytes are missing; stop for host storage repair, do not retry unchanged.");
  const loaded = await new CompilerValidator(new CanonicalModelStore(root)).loadCatalog();
  const catalog = Object.fromEntries(sceneCatalogKeys.map(key => [key, new Map([...(loaded[key]?.values() ?? [])]
    .filter(value => !value.evidence.length || value.evidence.every(ref => ref.span.sourceId === sourceId))
    .map(value => [value.id, value]))])) as SceneReviewCatalog;
  return { source, bytes, catalog };
}

/** Canonical-only: pending drafts may diagnose, never settle an obligation. */
export async function settleSourceRequirements(root: string, sourceId: string) {
  const ledger = new RequirementLedger(root, sourceId), sets = await ledger.definitions();
  // Recover an interrupted post-finish append from immutable receipts only.
  // Archived work remains historical; this never replays proposals or settles it.
  for (const { receipt } of await CompilerFinishReceipts.listRetained(root, sourceId)) {
    if (receipt.state === "completed" && receipt.identity.requirementAttempts) await ledger.recordCoreRoleAttempts(receipt);
  }
  if (!sets.length) return { sets, results: [], issues: [] };
  const { bytes, catalog, source } = await requirementInputs(root, sourceId);
  if (sets.some(set => set.spec.sourceSha256 !== source.contentSha256)) throw new Error("Requirement source revision changed; stop for host source review.");
  const results = await ledger.evaluate(bytes, catalog);
  return { sets, results, issues: requirementResultIssues(sets, results, catalog) };
}

export function frozenSceneCatalog(bundle: Pick<PreparedNovelBundle, "canonical">): SceneReviewCatalog {
  return Object.fromEntries(sceneCatalogKeys.map(key => [key, new Map(bundle.canonical[key].map(value => [value.id, value]))])) as SceneReviewCatalog;
}

export async function registerSourceRequirements(root: string, input: { id: string; spec: unknown; scopeDecisionRef: string; predecessorRevision?: string; sourceId: string }): Promise<RequirementSet> {
  const { source, bytes, catalog } = await requirementInputs(root, input.sourceId);
  const spec = sceneCapabilitySpecSchema.parse(input.spec);
  if (spec.sourceSha256 !== source.contentSha256) throw new Error("Registered source hash mismatch; stop for host storage review.");
  return new RequirementLedger(root, input.sourceId).register({ ...input, spec }, bytes, catalog);
}

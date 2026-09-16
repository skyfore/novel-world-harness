import crypto from "node:crypto";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { contentHash } from "../world/canonical.js";
import { SourceAnnotationStore } from "./annotations.js";
import { EntityResolutionStore } from "./entity-resolution.js";
import { EventResolutionStore } from "./event-resolution.js";
import { loadCompilerArtifactRecords } from "./artifact-retrieval.js";
import { SegmentStore, segmentSource } from "./segments.js";
import { RequirementLedger, evaluateRequirementSet, sceneCatalogKeys } from "./requirement-ledger.js";
import { coreRoleDefinitions, assertCoreRoleDefinitionEvidence } from "./core-role-requirement-records.js";
import { RoleRosterStore } from "./role-roster.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";
import { upstreamRepairPlanSchema, type UpstreamRepairPlan } from "./upstream-repair-plan.js";
import type { SceneReviewCatalog } from "../eval/scene-capabilities.js";

export function upstreamRepairHostError(reason: string): Error {
  return new Error(`UPSTREAM_REPAIR_REQUIRES_HOST_REVIEW: ${reason}. Preserve plan, receipts, budget and drafts. Stop this task and model retries; do not reset history, rotate namespaces, guess IDs or retry unchanged.`);
}

/** Read actual source-local host state under the compiler lock; no caller-supplied revision claims. */
export async function verifyUpstreamRepairPlan(root: string, raw: UpstreamRepairPlan, committedOutputs: ReadonlyMap<string, string> = new Map()) {
  const plan = upstreamRepairPlanSchema.parse(raw), sourceId = plan.sourceScope.sourceId;
  if (committedOutputs.size) {
    const receipt = await new CompilerFinishReceipts(root, sourceId, plan.batchId).read();
    const intent = receipt?.identity.upstreamRepairIntent;
    if (!intent || intent.planHash !== plan.planHash || committedOutputs.size !== intent.proposals.length
      || intent.proposals.some(item => committedOutputs.get(`${item.artifactKind}:${item.artifactId}`) !== item.payloadHash)) throw upstreamRepairHostError("Recovery revisions lack the exact durable upstream finish receipt");
  }
  const source = await WorkspaceStore.openReadOnly(root).getSource(sourceId);
  if (!source) throw upstreamRepairHostError("Registered source is missing");
  const bytes = await readSourceMaterial(root, source);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== plan.sourceScope.sourceSha256 || source.contentSha256 !== plan.sourceScope.sourceSha256) throw upstreamRepairHostError("Immutable source changed");
  const ledger = new RequirementLedger(root, sourceId);
  const scene = (await ledger.definitions()).find(item => item.revisionHash === plan.requirementSetHash);
  const core = (await ledger.coreRoleDefinitionHistory()).at(-1);
  let requirementIds: string[];
  if (scene) {
    const catalog = Object.fromEntries(sceneCatalogKeys.map(key => [key, new Map()])) as SceneReviewCatalog;
    requirementIds = evaluateRequirementSet(scene, bytes, catalog).requirements.map(item => item.id);
  } else if (core?.revisionHash === plan.requirementSetHash) {
    assertCoreRoleDefinitionEvidence(core, bytes);
    const roster = await new RoleRosterStore(root).read(sourceId);
    if (!roster || contentHash(roster) !== contentHash(core.roster) || roster.reviewRevisionId !== (await ledger.roleReviewRevisions()).at(-1)?.id) throw upstreamRepairHostError("Role review scope is being revised; retained definitions are historical repair inputs only");
    requirementIds = coreRoleDefinitions({ source }, core.roster).map(item => item.id);
  } else throw upstreamRepairHostError("Independent requirement definition is no longer active");
  if (plan.requirementIds.some(id => !requirementIds.includes(id))) throw upstreamRepairHostError("Plan selects an unknown independent requirement");
  const manifest = await new SegmentStore(root).readManifest(sourceId);
  if (!manifest || contentHash(manifest) !== contentHash(await segmentSource(root, source))) throw upstreamRepairHostError("Source segment layout is missing or stale");
  if (plan.sourceScope.segmentIds.some(id => !manifest.segments.some(segment => segment.id === id))) throw upstreamRepairHostError("Plan segment is outside the immutable source layout");
  const payloads = new Map<string, unknown>();
  for (const item of await new SourceAnnotationStore(root).list(sourceId)) payloads.set(`${item.annotationType}:${item.id}`, item);
  for (const item of await new EntityResolutionStore(root).list(sourceId)) payloads.set(`entity-resolution:${item.id}`, item);
  for (const item of await new EventResolutionStore(root).list(sourceId)) payloads.set(`event-resolution:${item.id}`, item);
  for (const item of manifest.segments) payloads.set(`source-segment:${item.id}`, item);
  for (const record of await loadCompilerArtifactRecords(root, sourceId)) {
    if (record.status !== "canonical") continue;
    payloads.set(`${record.kind}:${record.logicalId}`, record.payload);
    for (const assertion of record.evidenceAssertions) payloads.set(`evidence-assertion:${assertion.id}`, assertion);
  }
  const activeRevisions = new Map([...payloads].map(([key, value]) => [key, contentHash(value)]));
  for (const ref of plan.baselineRefs) if (activeRevisions.get(`${ref.kind}:${ref.id}`) !== ref.revisionHash && (!committedOutputs.has(`${ref.kind}:${ref.id}`) || activeRevisions.get(`${ref.kind}:${ref.id}`) !== committedOutputs.get(`${ref.kind}:${ref.id}`))) throw upstreamRepairHostError(`Active dependency changed: ${ref.kind}:${ref.id}`);
  for (const ref of plan.readableRefs) if (!activeRevisions.has(`${ref.kind}:${ref.id}`)) throw upstreamRepairHostError(`Readable dependency is missing: ${ref.kind}:${ref.id}`);
  const annotationKinds = ["entity-mention", "event-mention", "quotation", "discourse-segment"];
  for (const ref of plan.allowedCreations) if ((activeRevisions.has(`${ref.kind}:${ref.id}`) && (!committedOutputs.has(`${ref.kind}:${ref.id}`) || activeRevisions.get(`${ref.kind}:${ref.id}`) !== committedOutputs.get(`${ref.kind}:${ref.id}`))) || (annotationKinds.includes(ref.kind) && annotationKinds.some(kind => kind !== ref.kind && activeRevisions.has(`${kind}:${ref.id}`)))) throw upstreamRepairHostError(`Allocated creation ID is already active: ${ref.kind}:${ref.id}`);
  const receipts = await CompilerFinishReceipts.listRetained(root, sourceId);
  for (const fingerprint of plan.predecessorReceiptRefs) {
    const receipt = receipts.find(item => item.receipt.fingerprint === fingerprint)?.receipt;
    if (!receipt || receipt.state !== "completed" || receipt.identity.sourceSha256 !== source.contentSha256) throw upstreamRepairHostError("Predecessor receipt is missing, incomplete or from another source revision");
  }
  return { plan, source, bytes, activeRevisions, payloads };
}

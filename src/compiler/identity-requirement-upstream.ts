import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { worldStorageRoot } from "../world/paths.js";
import { contentHash } from "../world/canonical.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { UpstreamRepairLedger } from "./upstream-repair-ledger.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { identityRequirementsReady, validateIdentityOutput, identityRequirementDirectory, identitySemanticHash, type IdentityRecord } from "./identity-requirements.js";
import type { PreparedIdentityRequirements } from "./identity-requirement-service.js";
import { identityResolutionSchema } from "./entity-resolution.js";
import { freezeUpstreamRepairPlan, upstreamRepairReferencedKeys, type UpstreamRepairPlan } from "./upstream-repair-plan.js";
import { verifyIdentityRecord } from "./identity-requirement-trace.js";
import { validateConsumerRepairHistory, type ConsumerRepairRecord } from "./identity-consumer-repair-model.js";
import { buildIdentityRepairHandoff } from "./identity-repair-handoff.js";
import { assertConsumerRepairRetainedState } from "./identity-consumer-repair.js";
import { verifyConsumerRepairRecord } from "./identity-consumer-repair-trace.js";
import { buildRevalidatedConsumerPlan, revalidatedConsumerParentCatalog } from "./identity-consumer-revalidated-plan.js";
import { consumerRevalidationId } from "./identity-consumer-revalidation-model.js";

// Only the serialized host workflow uses this scope. Original journals are
// immutable while the compiler lock is held; live baselines and retained state
// are still checked on every preflight. A new invocation verifies journals anew.
const verifiedJournals = new AsyncLocalStorage<Set<string>>();
export const withIdentityAuthorityVerification = <T>(work: () => Promise<T>) => verifiedJournals.run(new Set(), work);

/** The independent requirement defines the postcondition. The fixed scope supplies
 * only a candidate payload; incompatibility is a durable stop, never normalization. */
export function buildIdentityRepairPlan(p: PreparedIdentityRequirements, records: IdentityRecord[], consumerRepair?: ConsumerRepairRecord[]): UpstreamRepairPlan {
  validateIdentityOutput(p.intent, records, p.inventory, p.semantic);
  if (!consumerRepair && !identityRequirementsReady(records)) throw prerequisiteStop("Identity definition or complete consumer impact review is not supported; no repair authority");
  if (consumerRepair) {
    validateConsumerRepairHistory(consumerRepair, records);
    if (consumerRepair.length !== 2 || consumerRepair[0]!.output.phase !== "consumer-repair-plan" || consumerRepair[0]!.output.operation.mode !== "capability-gap"
      || consumerRepair[1]!.output.phase !== "consumer-repair-check" || consumerRepair[1]!.output.verdict !== "supported")
      throw prerequisiteStop("Consumer repair lacks an independently supported original-condition capability finding; no typed staging authority");
  }
  const definition = records[0]!.output, original = p.semantic[0]!.output;
  if (definition.phase !== "identity-definition" || original.phase !== "semantic-scope-plan") throw prerequisiteStop("Missing exact independent definition");
  const payloads = original.operations.map(o => identityResolutionSchema.parse(JSON.parse(o.payloadJson)));
  for (const t of p.intent.targets) {
    const d = definition.requirements.find(r => r.id === t.requirementId)!, payload = payloads.find(r => r.mentionId === t.mentionId)!;
    if (!payload || payload.status !== d.requiredStatus || payload.entityId || payload.intendedEntityId || payload.candidates.length
      || (payload.supersedesResolutionId ?? null) !== (t.predecessor?.id ?? null)) throw prerequisiteStop("Fixed resolution fails independently defined uncertainty postcondition; do not correct or renew its consumed proposal");
  }
  const refs = [...new Map(original.operations.flatMap(o => o.readableRefs).map(r => [`${r.kind}:${r.id}`, r])).values()];
  const repair = consumerRepair?.[0]?.intent;
  const entity = repair ? p.inventory.consumers.find(c => c.ref === repair.ref) : undefined;
  const targets = entity ? p.intent.targets.filter(t => t.predecessor && p.catalog.some(c => c.kind === "entity-resolution" && c.id === t.predecessor!.id
    && (c.payload as { entityId?: string }).entityId === repair!.ref.slice("entity/".length))) : [];
  const target = targets[0];
  if (repair && (!entity || entity.revisionHash !== repair.revisionHash || targets.length !== 1)) throw prerequisiteStop("Entity consumer repair has no unique exact original identity predecessor; no guessed binding or staging");
  if (entity) refs.push({ kind: "entity", id: repair!.ref.slice("entity/".length), revisionHash: entity.revisionHash });
  const segments = p.manifest.segments.filter(s => p.intent.requiredSourceSegmentIds.includes(s.id));
  for (const s of segments) refs.push({ kind: "source-segment", id: s.id, revisionHash: contentHash(s) });
  const id = repair ? `identity-consumer-${repair.findingId}` : `identity-upstream-${p.intent.taskId}`, requirements = p.intent.targets.map(t => t.requirementId);
  const edges: UpstreamRepairPlan["dependencyEdges"] = [];
  for (const [i, op] of original.operations.entries()) {
    const t = p.intent.targets.find(t => t.slot === op.slot)!;
    edges.push({ from: `requirement:${t.requirementId}`, to: `entity-resolution:${op.id}`, purpose: "requirement" });
    for (const ref of upstreamRepairReferencedKeys("entity-resolution", payloads[i])) edges.push({ from: `entity-resolution:${op.id}`, to: ref, purpose: "identity" });
    for (const segment of segments) edges.push({ from: `entity-resolution:${op.id}`, to: `source-segment:${segment.id}`, purpose: "source-evidence" });
  }
  if (repair && target) {
    const entityKey = repair.ref.replace("entity/", "entity:"), operation = original.operations.find(o => o.slot === target.slot)!;
    edges.push({ from: entityKey, to: `entity-resolution:${operation.id}`, purpose: "identity" });
    edges.push({ from: entityKey, to: `entity-mention:${target.mentionId}`, purpose: "identity" });
    edges.push({ from: entityKey, to: `entity-resolution:${target.predecessor!.id}`, purpose: "identity" });
    edges.push({ from: `requirement:${target.requirementId}`, to: entityKey, purpose: "requirement" });
    for (const segment of segments) edges.push({ from: entityKey, to: `source-segment:${segment.id}`, purpose: "source-evidence" });
  }
  return freezeUpstreamRepairPlan({ version: 1, planId: id, batchId: id,
    requirementSetHash: contentHash({ intentHash: contentHash(p.intent), definition }), requirementIds: requirements,
    identityRequirements: { taskId: p.intent.taskId, intentHash: contentHash(p.intent), recordHashes: records.map(contentHash),
      ...(repair ? { consumerRepair: { findingId: repair.findingId, recordHashes: consumerRepair!.map(contentHash), entityId: repair.ref.slice("entity/".length),
        resolutionId: original.operations.find(o => o.slot === target!.slot)!.id, capabilityVersion: 1 as const } } : {}),
      semanticSlots: payloads.map(payload => ({ id: payload.id, payloadHash: identitySemanticHash(payload) })) },
    predecessorReceiptRefs: [p.review.upstream.receiptFingerprint], sourceScope: { sourceId: p.intent.sourceId, sourceSha256: p.intent.sourceHash, segmentIds: segments.map(s => s.id) },
    baselineRefs: refs, readableRefs: refs.map(({ revisionHash: _, ...r }) => r), allowedWrites: repair ? [{ kind: "entity", id: repair.ref.slice("entity/".length), pointers: ["/identityConsumption"] }] : [],
    allowedCreations: original.operations.map(o => ({ kind: "entity-resolution", id: o.id, maxCount: 1, dependencyOf: p.intent.targets.find(t => t.slot === o.slot)!.requirementId })),
    resolutionAbsences: payloads.filter(r => !r.supersedesResolutionId).map(r => ({ kind: "entity-resolution", id: r.id, mentionId: r.mentionId })),
    resolutionRevisions: payloads.filter(r => r.supersedesResolutionId).map(r => ({ kind: "entity-resolution", id: r.id, predecessorId: r.supersedesResolutionId!, mentionIds: [r.mentionId] })),
    citableEvidenceRefs: segments.map(s => s.id), dependencyEdges: edges, postconditionIds: requirements,
    authorizationRef: repair?.authorizationRef ?? p.intent.authorizationRef, retryBudgetRef: `${id}-budget` });
}

/** Historical context is content-addressed by the intent and original journals.
 * Current typed baselines and exact receipt-backed outputs are checked separately
 * by the existing upstream preflight, including after an interrupted finish. */
export async function readIdentityAuthority(root: string, plan: UpstreamRepairPlan) {
  const a = plan.identityRequirements;
  if (!a) throw prerequisiteStop("Missing independent identity authority");
  const ledger = new RequirementLedger(root, plan.sourceScope.sourceId), records = await ledger.identityRequirements(a.taskId);
  const file = path.join(identityRequirementDirectory(root, plan.sourceScope.sourceId, a.taskId), "context.json");
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  const p = { ...raw, bytes: Buffer.from(raw.sourceBytesBase64, "base64") } as PreparedIdentityRequirements;
  const review = (await ledger.roleDependencyReviews()).find(r => r.taskId === a.taskId);
  const repairRecords = a.consumerRepair ? (await ledger.history()).flatMap(r => r.payload.kind === "identity-consumer-repair" && r.payload.record.intent.findingId === a.consumerRepair!.findingId ? [r.payload.record] : []) : undefined;
  const revalidationRecords = a.consumerRevalidation ? (await ledger.history()).flatMap(r => r.payload.kind === "identity-consumer-revalidation"
    && consumerRevalidationId(r.payload.record.scope) === a.consumerRevalidation!.id ? [r.payload.record] : []) : [];
  const parentPlan = buildIdentityRepairPlan(p, records, repairRecords);
  const expected = a.consumerRevalidation ? buildRevalidatedConsumerPlan(p, records, parentPlan, revalidationRecords) : parentPlan;
  if (!review || contentHash(p.review) !== contentHash(review) || contentHash(p.intent) !== a.intentHash || contentHash(p.catalog) !== p.intent.catalogHash
    || contentHash(p.inventory) !== p.intent.inventoryHash || contentHash(p.semantic) !== contentHash(await ledger.roleSemanticScopes(a.taskId))
    || contentHash(p.prerequisites) !== contentHash(await ledger.sourcePrerequisites(a.taskId)) || contentHash(p.representations) !== contentHash(await ledger.sourceRepresentations(a.taskId))
    || contentHash(records.map(contentHash)) !== contentHash(a.recordHashes) || contentHash(expected) !== contentHash(plan)) throw prerequisiteStop("Independent identity authority lost its exact original context or reviews");
  const history = await ledger.history(), upstream = await new UpstreamRepairLedger(root, plan.sourceScope.sourceId).history();
  if (history[p.intent.requirementPrefix.length - 1]?.hash !== p.intent.requirementPrefix.head
    || upstream[p.intent.upstreamPrefix.length - 1]?.hash !== p.intent.upstreamPrefix.head) throw prerequisiteStop("Identity authority rewrote a retained ledger prefix");
  const parent = JSON.parse(await fs.readFile(path.join(workspaceStateDir(root), "compile-loops", p.intent.sourceId, "state.json"), "utf8"));
  if (parent.phase !== "BREAK" || createHash("sha256").update(JSON.stringify(parent)).digest("hex") !== p.intent.parentStateHash) throw prerequisiteStop("Original compiler stop changed; no identity authority");
  for (const retained of p.review.retainedFiles) {
    const file = path.resolve(worldStorageRoot(root), retained.path);
    if (!file.startsWith(path.resolve(worldStorageRoot(root)) + path.sep) || createHash("sha256").update(await fs.readFile(file)).digest("hex") !== retained.hash) throw prerequisiteStop("Original role plan, grant, failure or budget changed");
  }
  for (const q of p.review.scope.questions) {
    const latest = history.findLast(r => r.payload.kind === "role-review-question-disposition" && r.payload.disposition.questionId === q.questionId);
    if (latest?.payload.kind !== "role-review-question-disposition" || latest.payload.disposition.status !== "blocked") throw prerequisiteStop("Original critical question was settled without its own authorized revalidation");
  }
  const verifiedKey = `${root}:${plan.planHash}`, cached = verifiedJournals.getStore()?.has(verifiedKey);
  if (!cached) for (let i = 0; i < (repairRecords ? 2 : records.length); i++) await verifyIdentityRecord(root, records[i]!, records.slice(0, i), p);
  if (repairRecords) {
    const intent = repairRecords[0]!.intent, handoff = buildIdentityRepairHandoff(p, records, { ref: intent.ref, limit: 1 });
    if (!("selected" in handoff)) throw prerequisiteStop("Missing exact consumer repair handoff");
    if (contentHash(repairRecords.map(contentHash)) !== contentHash(a.consumerRepair!.recordHashes)) throw prerequisiteStop("Consumer repair planning records changed");
    await assertConsumerRepairRetainedState(root, intent);
    if (!cached) for (const record of repairRecords) await verifyConsumerRepairRecord(root, record, { intent, prepared: p, identity: records, handoff, prior: repairRecords });
  }
  if (!cached && revalidationRecords.length) {
    const { verifyConsumerRevalidationRecord } = await import("./identity-consumer-revalidation.js");
    for (const record of revalidationRecords) await verifyConsumerRevalidationRecord(root, record);
  }
  verifiedJournals.getStore()?.add(verifiedKey);
  const parentCatalog = a.consumerRevalidation ? await revalidatedConsumerParentCatalog(root, p, parentPlan, revalidationRecords[0]!.scope) : undefined;
  return { prepared: p, records, repairRecords, revalidationRecords, parentPlan, parentCatalog };
}

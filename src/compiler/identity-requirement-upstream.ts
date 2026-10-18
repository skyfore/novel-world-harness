import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
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

/** The independent requirement defines the postcondition. The fixed scope supplies
 * only a candidate payload; incompatibility is a durable stop, never normalization. */
export function buildIdentityRepairPlan(p: PreparedIdentityRequirements, records: IdentityRecord[]): UpstreamRepairPlan {
  validateIdentityOutput(p.intent, records, p.inventory, p.semantic);
  if (!identityRequirementsReady(records)) throw prerequisiteStop("Identity definition or complete consumer impact review is not supported; no repair authority");
  const definition = records[0]!.output, original = p.semantic[0]!.output;
  if (definition.phase !== "identity-definition" || original.phase !== "semantic-scope-plan") throw prerequisiteStop("Missing exact independent definition");
  const payloads = original.operations.map(o => identityResolutionSchema.parse(JSON.parse(o.payloadJson)));
  for (const t of p.intent.targets) {
    const d = definition.requirements.find(r => r.id === t.requirementId)!, payload = payloads.find(r => r.mentionId === t.mentionId)!;
    if (!payload || payload.status !== d.requiredStatus || payload.entityId || payload.intendedEntityId || payload.candidates.length
      || (payload.supersedesResolutionId ?? null) !== (t.predecessor?.id ?? null)) throw prerequisiteStop("Fixed resolution fails independently defined uncertainty postcondition; do not correct or renew its consumed proposal");
  }
  const refs = [...new Map(original.operations.flatMap(o => o.readableRefs).map(r => [`${r.kind}:${r.id}`, r])).values()];
  const segments = p.manifest.segments.filter(s => p.intent.requiredSourceSegmentIds.includes(s.id));
  for (const s of segments) refs.push({ kind: "source-segment", id: s.id, revisionHash: contentHash(s) });
  const id = `identity-upstream-${p.intent.taskId}`, requirements = p.intent.targets.map(t => t.requirementId);
  const edges: UpstreamRepairPlan["dependencyEdges"] = [];
  for (const [i, op] of original.operations.entries()) {
    const t = p.intent.targets.find(t => t.slot === op.slot)!;
    edges.push({ from: `requirement:${t.requirementId}`, to: `entity-resolution:${op.id}`, purpose: "requirement" });
    for (const ref of upstreamRepairReferencedKeys("entity-resolution", payloads[i])) edges.push({ from: `entity-resolution:${op.id}`, to: ref, purpose: "identity" });
    for (const segment of segments) edges.push({ from: `entity-resolution:${op.id}`, to: `source-segment:${segment.id}`, purpose: "source-evidence" });
  }
  return freezeUpstreamRepairPlan({ version: 1, planId: id, batchId: id,
    requirementSetHash: contentHash({ intentHash: contentHash(p.intent), definition }), requirementIds: requirements,
    identityRequirements: { taskId: p.intent.taskId, intentHash: contentHash(p.intent), recordHashes: records.map(contentHash),
      semanticSlots: payloads.map(payload => ({ id: payload.id, payloadHash: identitySemanticHash(payload) })) },
    predecessorReceiptRefs: [p.review.upstream.receiptFingerprint], sourceScope: { sourceId: p.intent.sourceId, sourceSha256: p.intent.sourceHash, segmentIds: segments.map(s => s.id) },
    baselineRefs: refs, readableRefs: refs.map(({ revisionHash: _, ...r }) => r), allowedWrites: [],
    allowedCreations: original.operations.map(o => ({ kind: "entity-resolution", id: o.id, maxCount: 1, dependencyOf: p.intent.targets.find(t => t.slot === o.slot)!.requirementId })),
    resolutionAbsences: payloads.filter(r => !r.supersedesResolutionId).map(r => ({ kind: "entity-resolution", id: r.id, mentionId: r.mentionId })),
    resolutionRevisions: payloads.filter(r => r.supersedesResolutionId).map(r => ({ kind: "entity-resolution", id: r.id, predecessorId: r.supersedesResolutionId!, mentionIds: [r.mentionId] })),
    citableEvidenceRefs: segments.map(s => s.id), dependencyEdges: edges, postconditionIds: requirements,
    authorizationRef: p.intent.authorizationRef, retryBudgetRef: `${id}-budget` });
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
  if (!review || contentHash(p.review) !== contentHash(review) || contentHash(p.intent) !== a.intentHash || contentHash(p.catalog) !== p.intent.catalogHash
    || contentHash(p.inventory) !== p.intent.inventoryHash || contentHash(p.semantic) !== contentHash(await ledger.roleSemanticScopes(a.taskId))
    || contentHash(p.prerequisites) !== contentHash(await ledger.sourcePrerequisites(a.taskId)) || contentHash(p.representations) !== contentHash(await ledger.sourceRepresentations(a.taskId))
    || contentHash(records.map(contentHash)) !== contentHash(a.recordHashes) || contentHash(buildIdentityRepairPlan(p, records)) !== contentHash(plan)) throw prerequisiteStop("Independent identity authority lost its exact original context or reviews");
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
  for (let i = 0; i < records.length; i++) await verifyIdentityRecord(root, records[i]!, records.slice(0, i), p);
  return { prepared: p, records };
}

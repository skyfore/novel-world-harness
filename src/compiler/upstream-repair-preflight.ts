import { SourceStructureStore } from "./structure.js";
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
import { recoverUpstreamResolutionBaselines, assertUpstreamResolutionAbsences, upstreamRepairPlanSchema, type UpstreamRepairPlan } from "./upstream-repair-plan.js";
import type { SceneReviewCatalog } from "../eval/scene-capabilities.js";
import { CompilerProposalObligations, sourcePatternObligationRequirementId } from "./proposal-obligations.js";
import { readAccountingBatchSegments } from "./accounting-review.js";
import { buildRepresentationRepairPlan, representationRecordsFromJournal } from "./source-representation-upstream.js";
import { ProposalStore } from "../world/canonical-model.js";
import { evidenceAssertionSchema } from "../world/model.js";

/** Restore only evidence bindings owned by an exact receipt-backed revision.
 * New assertions in that accepted envelope are outputs too, not unrelated
 * catalog drift. Every other current artifact remains visible to the guard. */
export function originalIdentityCatalog(current: ReadonlyMap<string, unknown>, original: readonly { kind: string; id: string; payload: unknown }[],
  revisions: readonly { kind: string; id: string; payload: unknown; committed?: boolean; assertions: readonly { id: string; target: { artifactKind: string; artifactId: string } }[] }[]) {
  const before = new Map(current);
  for (const revision of revisions) {
    before.set(`${revision.kind}:${revision.id}`, revision.payload);
    // Repair scopes name the singleton slot; field evidence uses the canonical
    // artifact ID emitted by compilerProposalArtifactId.
    const evidenceId = revision.kind === "initial-world" && revision.id === "singleton" ? "initial-world" : revision.id;
    for (const assertion of revision.assertions) {
      if (assertion.target.artifactKind !== revision.kind || assertion.target.artifactId !== evidenceId) throw upstreamRepairHostError("Receipt-backed assertion targets another artifact");
      const key = `evidence-assertion:${assertion.id}`, actual = before.get(key);
      if (revision.committed && (actual === undefined || contentHash(actual) !== contentHash(assertion)))
        throw upstreamRepairHostError("Committed entity lost its exact receipt-backed evidence assertion; inspect the original binding, do not replace or retry the model");
      if (actual !== undefined && contentHash(actual) !== contentHash(assertion)
        && !original.some(o => `${o.kind}:${o.id}` === key && contentHash(o.payload) === contentHash(actual)))
        throw upstreamRepairHostError("Receipt-backed evidence assertion changed outside its accepted envelope");
      before.delete(key);
    }
    for (const item of original) if (item.kind === "evidence-assertion") {
      const target = (item.payload as { target?: { artifactKind?: string; artifactId?: string } }).target;
      if (target?.artifactKind === revision.kind && target.artifactId === evidenceId) before.set(`evidence-assertion:${item.id}`, item.payload);
    }
  }
  return before;
}

export function upstreamRepairHostError(reason: string): Error {
  return new Error(`UPSTREAM_REPAIR_REQUIRES_HOST_REVIEW: ${reason}. Preserve plan, receipts, budget and drafts. Stop this task and model retries; do not reset history, rotate namespaces, guess IDs or retry unchanged.`);
}

/** Read-only continuation preflight. Only the original active receipt can
 * explain changed baselines; this does not reopen a stopped model invocation. */
export async function verifyUpstreamRepairContinuation(root: string, plan: UpstreamRepairPlan) {
  const { UpstreamRepairLedger } = await import("./upstream-repair-ledger.js");
  const current = (await new UpstreamRepairLedger(root, plan.sourceScope.sourceId).inspect()).plans.find(item => item.plan.planId === plan.planId);
  if (current && current.plan.planHash !== plan.planHash) throw upstreamRepairHostError("Original continuation plan changed");
  const receipt = await new CompilerFinishReceipts(root, plan.sourceScope.sourceId, plan.batchId).read();
  if (!receipt) {
    if (current?.finishedReceipt) throw upstreamRepairHostError("Original completed continuation receipt is missing");
    return verifyUpstreamRepairPlan(root, plan);
  }
  const intent = receipt.identity.upstreamRepairIntent;
  if (!intent || !current?.finishIntent || contentHash(intent) !== contentHash(current.finishIntent)
    || (current.finishedReceipt && (receipt.state !== "completed" || receipt.fingerprint !== current.finishedReceipt)))
    throw upstreamRepairHostError("Continuation receipt differs from the original frozen finish intent");
  return verifyUpstreamRepairPlan(root, plan, new Map(intent.proposals.map(item => [`${item.artifactKind}:${item.artifactId}`, item.payloadHash])));
}

/** Read actual source-local host state under the compiler lock; no caller-supplied revision claims. */
export async function verifyUpstreamRepairPlan(root: string, raw: UpstreamRepairPlan, committedOutputs: ReadonlyMap<string, string> = new Map(), restoringReceipt?: import("./finish-receipts.js").CompilerFinishReceipt) {
  const plan = upstreamRepairPlanSchema.parse(raw), sourceId = plan.sourceScope.sourceId;
  let recoveryBaselines: NonNullable<import("./finish-receipts.js").CompilerFinishReceipt["identity"]["upstreamRepairIntent"]>["baselines"] = [];
  let recoveryProposals: NonNullable<import("./finish-receipts.js").CompilerFinishReceipt["identity"]["upstreamRepairIntent"]>["proposals"] = [];
  if (committedOutputs.size) {
    const active = await new CompilerFinishReceipts(root, sourceId, plan.batchId).read();
    const retained = restoringReceipt && (await CompilerFinishReceipts.listRetained(root, sourceId)).find(item => contentHash(item.receipt) === contentHash(restoringReceipt))?.receipt;
    const receipt = active ?? retained;
    const intent = receipt?.identity.upstreamRepairIntent;
    if (!intent || intent.planHash !== plan.planHash || committedOutputs.size !== intent.proposals.length
      || intent.proposals.some(item => committedOutputs.get(`${item.artifactKind}:${item.artifactId}`) !== item.payloadHash)) throw upstreamRepairHostError("Recovery revisions lack the exact durable upstream finish receipt");
    recoveryBaselines = intent.baselines;
    recoveryProposals = intent.proposals;
  }
  const source = await WorkspaceStore.openReadOnly(root).getSource(sourceId);
  if (!source) throw upstreamRepairHostError("Registered source is missing");
  const bytes = await readSourceMaterial(root, source);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== plan.sourceScope.sourceSha256 || source.contentSha256 !== plan.sourceScope.sourceSha256) throw upstreamRepairHostError("Immutable source changed");
  const ledger = new RequirementLedger(root, sourceId);
  let requirementIds: string[];
  let identityContext: Awaited<ReturnType<typeof import("./identity-requirement-upstream.js").readIdentityAuthority>> | undefined;
  if (plan.identityRequirements) {
    identityContext = await (await import("./identity-requirement-upstream.js")).readIdentityAuthority(root, plan);
    requirementIds = identityContext.prepared.intent.targets.map(t => t.requirementId);
  } else if (plan.sourceRepresentation) {
    const { prerequisites, records } = representationRecordsFromJournal(await ledger.history(), plan.sourceRepresentation.taskId);
    const annotations = await new SourceAnnotationStore(root).list(sourceId);
    // Remove only exact receipt-backed outputs, never arbitrary newly visible observations.
    const before = annotations.filter(a => !committedOutputs.has(`${a.annotationType}:${a.id}`));
    const manifest = await new SegmentStore(root).readManifest(sourceId);
    if (!manifest) throw upstreamRepairHostError("Representation source manifest is missing");
    const expected = buildRepresentationRepairPlan(prerequisites, records, before, manifest.segments);
    if (contentHash(expected) !== contentHash(plan)) throw upstreamRepairHostError("Representation repair escaped its independently reviewed exact scope");
    const { verifyRepresentationTrace } = await import("./source-representation-trace.js");
    const { verifyPrerequisiteTrace } = await import("./role-source-prerequisite-trace.js");
    for (const r of prerequisites) await verifyPrerequisiteTrace(root, r);
    for (const r of records) await verifyRepresentationTrace(root, r);
    requirementIds = expected.requirementIds;
  } else if (plan.proposalObligation) {
    new CompilerProposalObligations(root, plan.proposalObligation.sourceId, plan.proposalObligation.batchId)
      .verifySourcePatternUpstreamAuthority(plan.proposalObligation, {
        upstreamPlanHash: plan.planHash,
        addedCanonicalEventIds: (plan.semanticEventCreations ?? []).map(item => item.canonicalEventId),
      });
    requirementIds = [sourcePatternObligationRequirementId(plan.proposalObligation)];
  } else {
    const scene = (await ledger.definitions()).find(item => item.revisionHash === plan.requirementSetHash);
    const core = (await ledger.coreRoleDefinitionHistory()).at(-1);
    if (scene) {
      const catalog = Object.fromEntries(sceneCatalogKeys.map(key => [key, new Map()])) as SceneReviewCatalog;
      requirementIds = evaluateRequirementSet(scene, bytes, catalog).requirements.map(item => item.id);
    } else if (core?.revisionHash === plan.requirementSetHash) {
      assertCoreRoleDefinitionEvidence(core, bytes);
      const roster = await new RoleRosterStore(root).read(sourceId);
      if (!roster || contentHash(roster) !== contentHash(core.roster) || roster.reviewRevisionId !== (await ledger.roleReviewRevisions()).at(-1)?.id) throw upstreamRepairHostError("Role review scope is being revised; retained definitions are historical repair inputs only");
      requirementIds = coreRoleDefinitions({ source }, core.roster).map(item => item.id);
    } else throw upstreamRepairHostError("Independent requirement definition is no longer active");
  }
  if (plan.requirementIds.some(id => !requirementIds.includes(id))) throw upstreamRepairHostError("Plan selects an unknown independent requirement");
  const manifest = await new SegmentStore(root).readManifest(sourceId);
  if (!manifest || contentHash(manifest) !== contentHash(await segmentSource(root, source))) throw upstreamRepairHostError("Source segment layout is missing or stale");
  if (plan.sourceScope.segmentIds.some(id => !manifest.segments.some(segment => segment.id === id))) throw upstreamRepairHostError("Plan segment is outside the immutable source layout");
  if (plan.proposalObligation) {
    const originalBatchSegments = await readAccountingBatchSegments(root, sourceId, plan.proposalObligation.batchId);
    if (plan.proposalObligation.originalEvidenceSegmentIds.some(id => !originalBatchSegments.some(segment => segment.id === id))) {
      throw upstreamRepairHostError("Proposal-obligation citation scope differs from its original executable batch");
    }
  }
  const payloads = new Map<string, unknown>();
  const structure = plan.readableRefs.some(ref => ref.kind === "structural-discourse")
    ? await new SourceStructureStore(root).read(sourceId) : null;
  if (structure?.sourceId === sourceId && structure.sourceSha256 === source.contentSha256) for (const item of structure.discourseSegments) payloads.set(`structural-discourse:${item.id}`, item);
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
  // Retained predecessor payloads are readable audit evidence, never active decisions.
  recoverUpstreamResolutionBaselines(plan, payloads, committedOutputs, recoveryBaselines);
  const retainedRevisions = new Map<string, string>();
  if (identityContext) {
    const p = identityContext.prepared;
    const preceding = identityContext.parentCatalog;
    if (preceding) {
      const intent = preceding.receipt.identity.upstreamRepairIntent!;
      recoverUpstreamResolutionBaselines(identityContext.parentPlan, payloads,
        new Map(intent.proposals.map(p => [`${p.artifactKind}:${p.artifactId}`, p.payloadHash])), intent.baselines);
      for (const id of plan.identityRequirements!.consumerRevalidation!.retainedResolutionIds) {
        const payload = payloads.get(`entity-resolution:${id}`);
        if (!payload) throw upstreamRepairHostError("Original retained resolution is missing from its exact predecessor receipt");
        retainedRevisions.set(`entity-resolution:${id}`, contentHash(payload));
      }
    }
    const originalCatalog = preceding?.catalog ?? p.catalog;
    const revisions = [];
    for (const write of plan.allowedWrites) if (committedOutputs.has(`${write.kind}:${write.id}`)) {
      const original = recoveryBaselines.find(b => b.kind === write.kind && b.id === write.id);
      if (!original || contentHash(original.payload) !== plan.baselineRefs.find(b => b.kind === write.kind && b.id === write.id)?.revisionHash)
        throw upstreamRepairHostError("Identity revision recovery lacks its exact original entity baseline");
      const proposal = recoveryProposals.find(p => p.artifactKind === write.kind && p.artifactId === write.id);
      if (!proposal || !["entity", ...(preceding ? ["initial-world"] : [])].includes(write.kind)) throw upstreamRepairHostError("Identity catalog recovery lacks its exact typed proposal");
      let envelope, accepted = true;
      try { envelope = await new ProposalStore(root).readEnvelope("accepted", proposal.proposalId); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; accepted = false; envelope = await new ProposalStore(root).readEnvelope("pending", proposal.proposalId); }
      if (contentHash(envelope) !== proposal.proposalHash || contentHash(envelope.payload) !== proposal.payloadHash) throw upstreamRepairHostError("Identity entity evidence recovery differs from its exact finish envelope");
      revisions.push({ kind: write.kind, id: write.id, payload: original.payload,
        committed: accepted && activeRevisions.get(`${write.kind}:${write.id}`) === proposal.payloadHash,
        assertions: evidenceAssertionSchema.array().parse(envelope.evidenceAssertions ?? []) });
    }
    const before = originalIdentityCatalog(payloads, originalCatalog, revisions);
    const created = new Set(plan.allowedCreations.map(c => `${c.kind}:${c.id}`));
    const currentCatalog = [...before].filter(([key]) => !key.startsWith("source-segment:") && !key.startsWith("structural-discourse:") && !(created.has(key) && committedOutputs.has(key)))
      .map(([key, payload]) => ({ kind: key.slice(0, key.indexOf(":")), id: key.slice(key.indexOf(":") + 1), payload, revisionHash: contentHash(payload) }))
      .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
    if (contentHash(currentCatalog) !== (preceding ? contentHash(preceding.catalog) : p.intent.catalogHash)) throw upstreamRepairHostError("Identity consumer catalog changed outside exact receipt-backed outputs");
    if (contentHash(await new RoleRosterStore(root).read(sourceId)) !== contentHash(p.review.priorRoster)
      || contentHash(await new SourceStructureStore(root).read(sourceId)) !== p.review.priorPlan.structureHash) throw upstreamRepairHostError("Identity consumer roster or source structure changed");
    const { RoleReviewWorkStore } = await import("./role-review-work.js");
    const entries = new RoleReviewWorkStore(root, p.review.priorPlan).stagedEntries();
    const expected = p.inventory.consumers.filter(c => c.ref.startsWith("staged-role/"));
    if (entries.length !== expected.length || entries.some(e => expected.find(c => c.ref === `staged-role/${e.candidateId}`)?.revisionHash !== contentHash(e))) throw upstreamRepairHostError("Identity consumer entries changed after complete independent review");
  }
  const baselineRevisions = new Map([...payloads].map(([key, value]) => [key, contentHash(value)]));
  for (const ref of plan.baselineRefs) if (baselineRevisions.get(`${ref.kind}:${ref.id}`) !== ref.revisionHash && (!committedOutputs.has(`${ref.kind}:${ref.id}`) || activeRevisions.get(`${ref.kind}:${ref.id}`) !== committedOutputs.get(`${ref.kind}:${ref.id}`))) throw upstreamRepairHostError(`Active dependency changed: ${ref.kind}:${ref.id}`);
  for (const ref of plan.readableRefs) if (!baselineRevisions.has(`${ref.kind}:${ref.id}`)) throw upstreamRepairHostError(`Readable dependency is missing: ${ref.kind}:${ref.id}`);
  const annotationKinds = ["entity-mention", "event-mention", "quotation", "discourse-segment"];
  for (const ref of plan.allowedCreations) if ((activeRevisions.has(`${ref.kind}:${ref.id}`) && (!committedOutputs.has(`${ref.kind}:${ref.id}`) || activeRevisions.get(`${ref.kind}:${ref.id}`) !== committedOutputs.get(`${ref.kind}:${ref.id}`))) || (annotationKinds.includes(ref.kind) && annotationKinds.some(kind => kind !== ref.kind && activeRevisions.has(`${kind}:${ref.id}`)))) throw upstreamRepairHostError(`Allocated creation ID is already active: ${ref.kind}:${ref.id}`);
  for (const semantic of plan.semanticEventCreations ?? []) for (const [candidateKey, payload] of payloads) {
    if (!candidateKey.startsWith("event-resolution:")) continue;
    const resolution = payload as { id?: string; eventMentionIds?: string[] };
    if (!resolution.eventMentionIds?.includes(semantic.eventMentionId)) continue;
    const expectedKey = `event-resolution:${semantic.eventResolutionId}`;
    if (candidateKey !== expectedKey || committedOutputs.get(expectedKey) !== contentHash(payload)) throw upstreamRepairHostError(`Reviewed missing-event mention already has another active resolution: ${semantic.eventMentionId}`);
  }
  assertUpstreamResolutionAbsences(plan, payloads, committedOutputs);
  const receipts = await CompilerFinishReceipts.listRetained(root, sourceId);
  for (const fingerprint of plan.predecessorReceiptRefs) {
    const receipt = receipts.find(item => item.receipt.fingerprint === fingerprint)?.receipt;
    if (!receipt || receipt.state !== "completed" || receipt.identity.sourceSha256 !== source.contentSha256) throw upstreamRepairHostError("Predecessor receipt is missing, incomplete or from another source revision");
  }
  return { plan, source, bytes, activeRevisions, retainedRevisions, payloads };
}

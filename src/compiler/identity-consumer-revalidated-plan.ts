import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { consumerEntityRepairId, consumerRevalidationId, consumerRevalidationDirectory, validateConsumerRevalidationHistory, type ConsumerRevalidationRecord } from "./identity-consumer-revalidation-model.js";
import type { IdentityRecord } from "./identity-requirements.js";
import type { PreparedIdentityRequirements } from "./identity-requirement-service.js";
import { freezeUpstreamRepairPlan, type UpstreamRepairPlan } from "./upstream-repair-plan.js";
import { evidenceAssertionSchema } from "../world/model.js";

/** Derive writes only from the independently supported original-condition scope.
 * All existing identity decisions remain dependencies, never new creation slots. */
export function buildRevalidatedConsumerPlan(p: PreparedIdentityRequirements, original: IdentityRecord[], parent: UpstreamRepairPlan, reviews: ConsumerRevalidationRecord[]) {
  validateConsumerRevalidationHistory(reviews, original);
  const first = reviews[0], check = reviews[1], output = first?.output, scope = first?.scope;
  if (reviews.length !== 2 || output?.phase !== "consumer-revalidation" || output.disposition !== "repair-required"
    || check?.output.phase !== "consumer-revalidation-check" || check.output.verdict !== "supported" || !scope?.compilerCorrection
    || !output.entityRepair || !output.initialWorldRepair || scope.upstreamPlanHash !== parent.planHash
    || scope.ref !== `initial/${scope.sourceId}` || !parent.identityRequirements?.consumerRepair
    || consumerEntityRepairId(output.entityRepair.ref) !== parent.identityRequirements.consumerRepair.entityId)
    throw prerequisiteStop("Typed continuation requires the exact independently supported joint entity/initial-world scope; inspect consumerRevalidation.reviews[].id for the same task, no inferred write authority");
  const refs = new Map<string, { kind: string; id: string; revisionHash: string }>();
  const edges: UpstreamRepairPlan["dependencyEdges"] = [], segments = new Set<string>();
  const targets = [{ kind: "entity" as const, id: parent.identityRequirements.consumerRepair.entityId, repair: output.entityRepair },
    { kind: "initial-world" as const, id: "singleton", repair: output.initialWorldRepair }];
  for (const { kind, id, repair } of targets) {
    for (const ref of repair.readableRefs) {
      const key = `${ref.kind}:${ref.id}`, old = refs.get(key);
      if (old && old.revisionHash !== ref.revisionHash) throw prerequisiteStop("Independent repair scope has conflicting dependency revisions; no inferred baseline");
      refs.set(key, ref);
      if (key !== `${kind}:${id}`) edges.push({ from: `${kind}:${id}`, to: key, purpose: "identity" });
    }
    for (const id of repair.segmentIds) segments.add(id);
    for (const requirement of parent.requirementIds) edges.push({ from: `requirement:${requirement}`, to: `${kind}:${id}`, purpose: "requirement" });
  }
  if (refs.get("initial-world:singleton")?.revisionHash !== scope.currentRevisionHash
    || refs.get(`entity:${targets[0]!.id}`)?.revisionHash !== output.entityRepair.revisionHash)
    throw prerequisiteStop("Supported repair lacks its exact existing write baselines; no guessed payload or plan");
  for (const id of segments) {
    const segment = p.manifest.segments.find(s => s.id === id);
    if (!segment) throw prerequisiteStop("Supported repair source is outside the original manifest; no scope expansion");
    refs.set(`source-segment:${id}`, { kind: "source-segment", id, revisionHash: contentHash(segment) });
    for (const target of targets) edges.push({ from: `${target.kind}:${target.id}`, to: `source-segment:${id}`, purpose: "source-evidence" });
  }
  const id = consumerRevalidationId(scope), planId = `identity-revalidated-${id}`;
  return freezeUpstreamRepairPlan({ version: 1, planId, batchId: planId, requirementSetHash: parent.requirementSetHash, requirementIds: parent.requirementIds,
    identityRequirements: { ...parent.identityRequirements, consumerRevalidation: { id, recordHashes: reviews.map(contentHash), scopeHash: contentHash(scope),
      parentPlanHash: parent.planHash, parentReceiptFingerprint: scope.receiptFingerprint, initialWorldPointers: output.initialWorldRepair.pointers,
      retainedResolutionIds: (parent.resolutionRevisions ?? []).map(r => r.predecessorId) } },
    predecessorReceiptRefs: [scope.receiptFingerprint], sourceScope: { sourceId: scope.sourceId, sourceSha256: scope.sourceHash, segmentIds: [...segments] },
    baselineRefs: [...refs.values()] as UpstreamRepairPlan["baselineRefs"], readableRefs: [...refs.values()].map(({ revisionHash: _, ...r }) => r) as UpstreamRepairPlan["readableRefs"],
    allowedWrites: targets.map(t => ({ kind: t.kind, id: t.id, pointers: t.repair.pointers })), allowedCreations: [],
    citableEvidenceRefs: [...segments], dependencyEdges: edges, postconditionIds: parent.postconditionIds,
    authorizationRef: scope.authorizationRef, retryBudgetRef: `${planId}-budget` });
}

/** Every prior stage/segment remains an immutable charge, including rejected
 * submissions. A new typed plan has the existing slot/acceptance limits. */
export async function revalidatedConsumerBudgetOrigin(root: string, reviews: ConsumerRevalidationRecord[]) {
  const { consumerStageBudgetDirectories, maybeRecoveryFile } = await import("./identity-consumer-stage-recovery.js");
  const scope = reviews[0]!.scope, directory = consumerRevalidationDirectory(root, scope), priorUsage = { ...scope.priorUsage };
  const budgetFiles = [...scope.priorBudgetFiles];
  for (const file of budgetFiles) if (contentHash(JSON.parse(await fs.readFile(file.path, "utf8"))) !== file.hash) throw prerequisiteStop("Original inherited budget changed; no typed continuation");
  for (const stage of ["consumer-revalidation", "consumer-revalidation-check"]) for (const dir of consumerStageBudgetDirectories(directory, stage)) {
    const file = path.join(dir, `${stage}.budget.json`), budget = await maybeRecoveryFile(file);
    if (!budget) continue;
    if (budget.scopeHash !== contentHash(scope) || budget.originalBudgetHash !== scope.originalBudgetHash) throw prerequisiteStop("Consumer stage charges changed scope; no typed continuation");
    priorUsage.modelCalls += budget.state.usage.modelCalls; priorUsage.totalPayloadBytes += budget.state.usage.totalPayloadBytes;
    budgetFiles.push({ path: file, hash: contentHash(budget) });
  }
  return { originalBudgetHash: scope.originalBudgetHash, priorUsage, revalidationRecordHashes: reviews.map(contentHash), budgetFiles };
}

/** Reconstruct the complete catalog after the preceding accepted repair from
 * immutable originals and its exact receipt. Never freeze unrelated drift. */
export async function revalidatedConsumerParentCatalog(root: string, p: PreparedIdentityRequirements, parent: UpstreamRepairPlan, scope: ConsumerRevalidationRecord["scope"]) {
  const { CompilerFinishReceipts } = await import("./finish-receipts.js");
  const { ProposalStore } = await import("../world/canonical-model.js");
  const { EntityResolutionStore } = await import("./entity-resolution.js");
  const receipt = await new CompilerFinishReceipts(root, scope.sourceId, parent.batchId).read();
  if (!receipt || receipt.state !== "completed" || receipt.fingerprint !== scope.receiptFingerprint || receipt.identity.upstreamRepairIntent?.planHash !== parent.planHash)
    throw prerequisiteStop("Typed continuation lost its original completed dependency receipt; no replacement baseline");
  const intent = receipt.identity.upstreamRepairIntent, catalog = new Map(p.catalog.map(r => [`${r.kind}:${r.id}`, r]));
  for (const proposal of intent.proposals) {
    const envelope = proposal.artifactKind === "entity" ? await new ProposalStore(root).readEnvelope("accepted", proposal.proposalId)
      : await new EntityResolutionStore(root).readProposal(scope.sourceId, "accepted", proposal.proposalId);
    if (contentHash(envelope) !== proposal.proposalHash || contentHash(envelope.payload) !== proposal.payloadHash)
      throw prerequisiteStop("Original accepted dependency envelope changed; no typed continuation");
    catalog.set(`${proposal.artifactKind}:${proposal.artifactId}`, { kind: proposal.artifactKind, id: proposal.artifactId, revisionHash: proposal.payloadHash, payload: envelope.payload });
    if (proposal.artifactKind === "entity") {
      for (const [key, item] of catalog) if (item.kind === "evidence-assertion") {
        const a = evidenceAssertionSchema.parse(item.payload);
        if (a.target.artifactKind === "entity" && a.target.artifactId === proposal.artifactId) catalog.delete(key);
      }
      for (const assertion of evidenceAssertionSchema.array().parse((envelope as { evidenceAssertions?: unknown }).evidenceAssertions ?? []))
        catalog.set(`evidence-assertion:${assertion.id}`, { kind: "evidence-assertion", id: assertion.id, revisionHash: contentHash(assertion), payload: assertion });
    }
  }
  return { receipt, catalog: [...catalog.values()].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)) };
}

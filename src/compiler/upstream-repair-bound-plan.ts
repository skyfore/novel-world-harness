import { SourceStructureStore } from "./structure.js";
import { z } from "zod";
import { idSchema } from "../world/model.js";
import { contentHash } from "../world/canonical.js";
import { SourceAnnotationStore } from "./annotations.js";
import { bindUpstreamRepairRequirements } from "./upstream-repair-binding.js";
import { planUpstreamRepair } from "./upstream-repair-planner.js";
import { freezeUpstreamRepairPlan, upstreamRepairReadableRefSchema, type UpstreamRepairPlan } from "./upstream-repair-plan.js";
import { upstreamRepairHostError, verifyUpstreamRepairPlan } from "./upstream-repair-preflight.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const boundUpstreamRepairRequestSchema = z.object({
  version: z.literal(1), sourceId: idSchema, subjectSnapshotHash: hash, closureHash: hash, requirementSetHash: hash,
  findingIds: z.array(hash).min(1).max(128).refine(ids => new Set(ids).size === ids.length, "Duplicate finding selection"),
  planId: idSchema, batchId: idSchema, authorizationRef: z.string().trim().min(1), retryBudgetRef: idSchema,
  segmentIds: z.array(idSchema).min(1).max(128), citableEvidenceRefs: z.array(idSchema).min(1).max(128),
  predecessorReceiptRefs: z.array(hash).max(128),
  candidateSelections: z.array(z.object({ findingId: hash, candidateIds: z.array(idSchema).max(32)
    .refine(ids => new Set(ids).size === ids.length, "Duplicate candidate selection") }).strict()).max(128).default([]),
}).strict();

/** Host-owned conversion. Recompute bindings; caller selects findings, never replaces requirement IDs. */
export async function planBoundUpstreamRepair(root: string, raw: unknown) {
  const request = boundUpstreamRepairRequestSchema.parse(raw);
  const current = await bindUpstreamRepairRequirements(root, request.sourceId);
  if (current.subjectSnapshotHash !== request.subjectSnapshotHash || current.closureHash !== request.closureHash) throw upstreamRepairHostError("Bound repair inputs changed; regenerate bind-upstream-repairs and copy current subjectSnapshotHash, closureHash and discovery.findings[].findingId for one corrected host request");
  if (new Set(request.candidateSelections.map(item => item.findingId)).size !== request.candidateSelections.length
    || request.candidateSelections.some(item => !request.findingIds.includes(item.findingId))) throw upstreamRepairHostError("Candidate selection escapes or duplicates the selected finding scope");
  const bindings = current.bindings.filter(item => item.requirementSetHash === request.requirementSetHash && request.findingIds.includes(item.findingId));
  const diagnostics = [];
  for (const findingId of request.findingIds) {
    const finding = current.discovery.findings.find(item => item.findingId === findingId);
    const selected = bindings.filter(item => item.findingId === findingId);
    if (!finding || !selected.length) throw upstreamRepairHostError("Selected finding lacks a current typed path to an unresolved requirement in this definition; preserve it for host review instead of guessing a requirement ID");
    const selection = request.candidateSelections.find(item => item.findingId === findingId);
    if (finding.diagnostic.code === "QUOTATION_SPEAKER_MENTION_MISSING") {
      if (selection) throw upstreamRepairHostError("Mention creation does not accept canonical resolution candidate selections");
      for (const binding of selected) diagnostics.push({ ...finding.diagnostic, requirementId: binding.requirementId });
    } else {
      const kind = finding.diagnostic.code === "ENTITY_RESOLUTION_MISSING" ? "entity" : "canonical-event";
      const candidates = (selection?.candidateIds ?? []).map(id => {
        const actual = current.discovery.candidateRefs.find(item => item.kind === kind && item.id === id);
        if (!actual) throw upstreamRepairHostError("Resolution candidate is outside the discovered source/kind; copy discovery.candidateRefs[].id for the exact kind, without guessing");
        return { id, revisionHash: actual.revisionHash };
      });
      for (const binding of selected) diagnostics.push({ ...finding.diagnostic, requirementId: binding.requirementId, candidates });
    }
  }
  const bindingHash = contentHash({ subjectSnapshotHash: current.subjectSnapshotHash, closureHash: current.closureHash, bindings });
  const result = await planUpstreamRepair(root, { version: 1, sourceId: request.sourceId, sourceSha256: current.discovery.sourceSha256,
    planId: request.planId, batchId: request.batchId, authorizationRef: `${request.authorizationRef}#binding=${bindingHash}`, retryBudgetRef: request.retryBudgetRef,
    requirementSetHash: request.requirementSetHash, requirementIds: [...new Set(bindings.map(item => item.requirementId))].sort(),
    segmentIds: request.segmentIds, citableEvidenceRefs: request.citableEvidenceRefs, predecessorReceiptRefs: request.predecessorReceiptRefs, diagnostics });
  if (!result.plan) throw upstreamRepairHostError("Current binding requires an unsupported repair policy");
  const baselines = new Map(result.plan.baselineRefs.map(ref => [`${ref.kind}:${ref.id}`, ref]));
  const annotations = await new SourceAnnotationStore(root).list(request.sourceId);
  const structure = await new SourceStructureStore(root).read(request.sourceId);
  const kinds: Record<string, string> = { event: "canonical-event", action: "action-schema", norm: "norm-template", process: "process-template", rule: "world-rule",
    participation: "event-participation", spatial: "spatial-relation", scene: "scene-occurrence", frame: "event-frame", constraint: "action-constraint", goal: "character-goal", model: "character-model", discourse: "discourse-segment" };
  for (const binding of bindings) for (const node of binding.path) {
    const kind = node.kind === "discourse" && structure?.discourseSegments.some(item => item.id === node.id) ? "structural-discourse" : node.kind === "annotation" ? annotations.find(item => item.id === node.id)?.annotationType : kinds[node.kind] ?? node.kind;
    const parsed = upstreamRepairReadableRefSchema.safeParse({ kind, id: node.id });
    if (!parsed.success) throw upstreamRepairHostError(`Dependency path ${node.kind}/${node.id} has no registered readable baseline representation; stop for host review rather than dropping the path guard`);
    const ref = { ...parsed.data, revisionHash: node.revisionHash };
    const previous = baselines.get(`${ref.kind}:${ref.id}`);
    if (previous && previous.revisionHash !== ref.revisionHash) throw upstreamRepairHostError("Binding path changed during plan construction");
    baselines.set(`${ref.kind}:${ref.id}`, ref);
  }
  const { planHash: _priorHash, ...identity } = result.plan;
  const baselineRefs = [...baselines.values()].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  const plan: UpstreamRepairPlan = freezeUpstreamRepairPlan({ ...identity, baselineRefs,
    readableRefs: baselineRefs.map(({ kind, id }) => ({ kind, id })) });
  await verifyUpstreamRepairPlan(root, plan);
  return { authority: "diagnostic-only" as const, bindingHash, bindings, reviewHash: result.reviewHash, plan };
}

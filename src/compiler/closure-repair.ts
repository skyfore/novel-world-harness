import { contentHash } from "../world/canonical.js";
import type { CompilerBatch } from "./batches.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";
import { affectedClosureNodes, buildPreparedClosure, type ClosureGraph } from "./closure.js";

export type ClosureRepairPlan = {
  inputHash: string;
  requestedBatchIds: string[];
  batchIds: string[];
  affectedNodeKeys: string[];
  sourceUnitIds: string[];
};

/** Resolve evidence scopes to a fixed point before invalidating anything. */
export function planClosureRepair(bundle: PreparedNovelBundle, batches: readonly CompilerBatch[], requestedBatchIds: readonly string[]): ClosureRepairPlan {
  const graph = buildPreparedClosure(bundle), index = new Map(graph.nodes.map((node) => [`${node.kind}/${node.id}`, node]));
  const base = bundle.compilerSnapshot.structure.units.filter((unit) => bundle.compilerSnapshot.structure.baseUnitIds.includes(unit.id));
  const selected = new Set(requestedBatchIds), sourceUnits = new Set<string>();
  let affected: string[] = [];
  const touches = (batch: CompilerBatch, unit: (typeof base)[number]) => batch.evidence.some(({ span }) => span.sourceId === bundle.source.id && (
    typeof span.startByte === "number" && typeof span.endByte === "number"
      ? span.startByte < unit.anchor.endByte && span.endByte > unit.anchor.startByte
      : span.startLine <= unit.anchor.endLine && span.endLine >= unit.anchor.startLine));
  for (;;) {
    const before = selected.size;
    for (const unit of base) if (batches.some((batch) => selected.has(batch.id) && touches(batch, unit))) sourceUnits.add(unit.id);
    affected = affectedClosureNodes(graph, [...sourceUnits].map((id) => ({ kind: "unit", id })));
    // Follow support for affected compiler artifacts, not the all-source review
    // coverage of a derived roster/certificate or unrelated semantic identities.
    const pending = affected.filter((key) => !["roster", "entry", "source"].includes(key.split("/")[0]!)), visited = new Set<string>();
    while (pending.length) {
      const key = pending.pop()!;
      if (visited.has(key)) continue;
      visited.add(key);
      const node = index.get(key);
      if (node?.kind === "unit") { sourceUnits.add(node.id); continue; }
      for (const ref of node?.dependsOn ?? []) if (["unit", "evidence", "annotation", "discourse", "entity-resolution", "event-resolution"].includes(ref.kind)) pending.push(`${ref.kind}/${ref.id}`);
    }
    for (const batch of batches) if (batch.purpose !== "structure-discovery" && base.some((unit) => sourceUnits.has(unit.id) && touches(batch, unit))) selected.add(batch.id);
    if (selected.size === before) break;
  }
  return { inputHash: contentHash({ graph, batches, requestedBatchIds: [...requestedBatchIds].sort() }), requestedBatchIds: [...requestedBatchIds].sort(), batchIds: batches.filter((batch) => selected.has(batch.id)).map((batch) => batch.id), affectedNodeKeys: affected, sourceUnitIds: [...sourceUnits].sort() };
}

/** Root causes first; callers may retry only when the input revision changes. */
export function closureRepairDiagnostics(graph: ClosureGraph) {
  const stages = ["identity", "temporal-attribution", "effects-mechanisms", "entry", "certification"] as const;
  const stageFor = (kind: string) => ["entity", "entity-resolution", "annotation", "unit", "discourse"].includes(kind) ? 0 : ["event-resolution", "attribution", "event-relation"].includes(kind) ? 1 : ["entry", "initial"].includes(kind) ? 3 : ["roster"].includes(kind) ? 4 : 2;
  const inputHash = contentHash(graph);
  return graph.issues.map((issue) => {
    const impacted = graph.nodes.find((node) => `${node.kind}/${node.id}` === issue.path);
    const missing = impacted?.dependsOn.filter((ref) => !ref.revisionHash) ?? [];
    const stage = Math.min(stageFor(impacted?.kind ?? "roster"), ...missing.map((ref) => stageFor(ref.kind)));
    return { issueId: contentHash({ inputHash, issue }), inputHash, stage: stages[stage]!, severity: "blocking" as const, ...issue,
      affectedNodeKeys: impacted ? affectedClosureNodes(graph, [impacted]) : [], missingReferences: missing,
      resolution: "Use the existing source-scoped compiler discovery and typed proposal tools to repair these references, then rebuild this candidate. An unchanged input and diagnostic must remain blocked." };
  }).sort((a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage) || a.issueId.localeCompare(b.issueId));
}

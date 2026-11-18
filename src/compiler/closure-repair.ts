import { contentHash } from "../world/canonical.js";
import type { PreparedNovelBundle } from "./prepared-cache.js";
import { affectedClosureNodes, buildPreparedClosure, type ClosureGraph } from "./closure.js";

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

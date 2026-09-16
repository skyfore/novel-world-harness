import { buildPreparedClosure, closureGraphSchema, type ClosureGraph } from "./closure.js";
import { contentHash } from "../world/canonical.js";
import { discoverUpstreamRepairDiagnostics } from "./upstream-repair-discovery.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { evaluateSceneCapabilities } from "../eval/scene-capabilities.js";
import { frozenSceneCatalog } from "./requirement-service.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { PreparedNovelCache } from "./prepared-cache.js";
import { preparedSubjectHash } from "./certification.js";
import { upstreamRepairHostError } from "./upstream-repair-preflight.js";

type Node = ClosureGraph["nodes"][number];
const key = (node: { kind: string; id: string }) => `${node.kind}/${node.id}`;
const globalKinds = new Set(["source", "unit", "roster", "entry", "requirement-set", "core-role-requirements"]);

/** Exact directed dependency proof; common source/units and text overlap confer no binding. */
export function upstreamRepairDependencyPath(raw: ClosureGraph, targetRef: string, annotationId: string, revisionHash: string): Array<Pick<Node, "kind" | "id" | "revisionHash">> | null {
  return dependencyLookup(raw)(targetRef, annotationId, revisionHash);
}
function dependencyLookup(raw: ClosureGraph) {
  const graph = closureGraphSchema.parse(raw), nodes = new Map(graph.nodes.map(node => [key(node), node]));
  if (nodes.size !== graph.nodes.length) throw upstreamRepairHostError("Dependency binding has duplicate closure identities");
  for (const node of graph.nodes) for (const ref of node.dependsOn) {
    const dependency = nodes.get(key(ref));
    if (dependency && dependency.revisionHash !== ref.revisionHash) throw upstreamRepairHostError("Dependency binding has a stale closure edge");
  }
  const searches = new Map<string, Map<string, string | null>>();
  return (targetRef: string, annotationId: string, revisionHash: string) => {
    const colon = targetRef.indexOf(":"), kind = targetRef.slice(0, colon), id = targetRef.slice(colon + 1);
    if (colon < 1 || !["event", "norm", "action"].includes(kind)) return null;
    const root = nodes.get(`${kind}/${id}`), endpoint = nodes.get(`annotation/${annotationId}`);
    if (!root || !endpoint || endpoint.revisionHash !== revisionHash) return null;
    let parents = searches.get(targetRef);
    if (!parents) {
      parents = new Map([[key(root), null]]);
      const queue = [root];
      for (let index = 0; index < queue.length; index++) {
        const node = queue[index]!;
        for (const ref of node.dependsOn.slice().sort((a, b) => key(a).localeCompare(key(b)))) {
          const next = nodes.get(key(ref));
          if (next && !globalKinds.has(next.kind) && !parents.has(key(next))) { parents.set(key(next), key(node)); queue.push(next); }
        }
      }
      searches.set(targetRef, parents);
    }
    if (!parents.has(key(endpoint))) return null;
    const path: Array<Pick<Node, "kind" | "id" | "revisionHash">> = [];
    for (let at: string | null = key(endpoint); at !== null; at = parents.get(at) ?? null) {
      const { kind, id, revisionHash } = nodes.get(at)!; path.push({ kind, id, revisionHash });
    }
    return path.reverse();
  };
}

/** Host holds compiler lock; regenerate findings and assessments instead of accepting claimed links. */
export async function bindUpstreamRepairRequirements(root: string, sourceId: string) {
  const discovery = await discoverUpstreamRepairDiagnostics(root, sourceId);
  const source = await WorkspaceStore.openReadOnly(root).getSource(sourceId);
  if (!source) throw upstreamRepairHostError("Binding source is not registered");
  const bundle = await new PreparedNovelCache(root).candidateSnapshot(source).catch(error => {
    throw upstreamRepairHostError(`Binding candidate cannot be frozen: ${String(error)}; preserve and resolve the original pending host work, then regenerate bindings without replaying model calls`);
  });
  const bytes = await readSourceMaterial(root, source), graph = buildPreparedClosure(bundle), catalog = frozenSceneCatalog(bundle);
  const findPath = dependencyLookup(graph);
  const ledger = new RequirementLedger(root, sourceId);
  const bindings: Array<{ findingId: string; requirementSetHash: string; requirementId: string; state: string; targetRef: string; path: NonNullable<ReturnType<typeof upstreamRepairDependencyPath>> }> = [];
  for (const definition of await ledger.definitions()) {
    const assessment = evaluateSceneCapabilities(definition.spec, bytes, catalog).requirements;
    for (const requirement of assessment.requirements.filter(item => item.state !== "satisfied")) {
      for (const finding of discovery.findings) {
        const diagnostic = finding.diagnostic;
        const annotationId = diagnostic.quotationId ?? diagnostic.mentionId;
        if (!annotationId) throw upstreamRepairHostError("Discovered finding lacks its exact annotation identity");
        const path = findPath(requirement.targetRef, annotationId, diagnostic.revisionHash);
        if (path) bindings.push({ findingId: finding.findingId, requirementSetHash: definition.revisionHash,
          requirementId: requirement.id, state: requirement.state, targetRef: requirement.targetRef, path });
      }
    }
  }
  return { version: 1 as const, authority: "diagnostic-only" as const, sourceId, subjectSnapshotHash: preparedSubjectHash(bundle),
    closureHash: contentHash(graph), discovery, bindings,
    unboundFindingIds: discovery.findings.filter(finding => !bindings.some(binding => binding.findingId === finding.findingId)).map(finding => finding.findingId),
    coreRoleBinding: "requires-host-review" as const,
    recovery: "Bindings prove a current typed dependency only, not satisfaction or write authority. Regenerate after input changes. Unbound findings require host review; do not bind by shared source text, overlap or guessed role identity." };
}

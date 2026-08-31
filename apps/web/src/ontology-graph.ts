import type {
  OntologyEdge,
  OntologyGraph,
  OntologyNode,
  OntologyStatus,
  OntologyView,
} from "../../../src/web/contracts";

export type EdgeDensity = "essential" | "balanced" | "complete";

export type NodeFamily =
  | "character"
  | "place"
  | "collective"
  | "artifact"
  | "relationship"
  | "event"
  | "knowledge"
  | "model"
  | "rule"
  | "possibility"
  | "provenance"
  | "other";

export type Point = { x: number; y: number };

export type RenderableGraph = {
  nodes: OntologyNode[];
  edges: OntologyEdge[];
  degree: Map<string, number>;
  sampled: boolean;
  focused: boolean;
  focusNodeId?: string;
  sourceNodeCount: number;
  sourceEdgeCount: number;
  hiddenNodeCount: number;
  hiddenEdgeCount: number;
};

export const statusColors: Record<OntologyStatus, string> = {
  canonical: "#d6ff72",
  active: "#75e6a4",
  inactive: "#697169",
  "branch-committed": "#75bff2",
  possibility: "#f4bf63",
  proposal: "#cc9ee7",
  contested: "#ff9f6e",
  rejected: "#ff756f",
};

export const familyVisuals: Record<NodeFamily, { color: string; label: string }> = {
  character: { color: "#ff9c7a", label: "Characters" },
  place: { color: "#55c7e8", label: "Places" },
  collective: { color: "#9ca8ff", label: "Groups" },
  artifact: { color: "#e7ba61", label: "Artifacts" },
  relationship: { color: "#ef83b6", label: "Relationships" },
  event: { color: "#bc91ff", label: "Events" },
  knowledge: { color: "#72d9c2", label: "Knowledge" },
  model: { color: "#8fb8ff", label: "Character model" },
  rule: { color: "#a8d66d", label: "Rules" },
  possibility: { color: "#f2a85d", label: "Possibilities" },
  provenance: { color: "#c59ad9", label: "Evidence & compile" },
  other: { color: "#9aa39c", label: "Other" },
};

export function nodeFamily(node: Pick<OntologyNode, "kind" | "layer">): NodeFamily {
  const kind = node.kind;
  if (
    node.layer === "proposal"
    || node.layer === "evidence"
    || kind.startsWith("proposal:")
    || kind.startsWith("artifact:")
  ) return "provenance";
  if (kind.startsWith("possibility:") || node.layer === "possibility") return "possibility";
  if (kind === "entity:character") return "character";
  if (kind === "entity:location" || kind.includes("location") || kind === "spatial-relation") return "place";
  if (kind === "entity:faction" || kind === "entity:institution") return "collective";
  if (kind === "entity:artifact") return "artifact";
  if (kind === "entity:relationship" || kind.startsWith("relationship-")) return "relationship";
  if (kind.includes("event") || kind === "world-commit") return "event";
  if (kind.includes("rule") || kind === "predicate") return "rule";
  if (
    kind === "character-model"
    || kind === "goal"
    || kind === "disposition"
    || kind === "appraisal"
    || kind === "development"
  ) return "model";
  if (kind === "proposition" || kind === "claim" || kind === "attribution" || kind === "concept" || kind === "entity:concept") return "knowledge";
  if (
    kind === "source"
    || kind === "source-span"
    || kind === "proposal"
    || kind === "validation"
    || kind === "compiler-worker"
    || kind === "initial-world"
  ) return "provenance";
  return "other";
}

export function nodeColor(node: Pick<OntologyNode, "kind" | "layer">): string {
  return familyVisuals[nodeFamily(node)].color;
}

export function nodeShape(node: Pick<OntologyNode, "kind" | "layer">): string {
  const family = nodeFamily(node);
  if (family === "character" || family === "knowledge" || family === "other") return "circle";
  if (family === "place" || family === "model") return "roundRect";
  if (family === "collective" || family === "provenance") return "rect";
  if (family === "rule") return "triangle";
  if (family === "event" || family === "artifact" || family === "relationship" || family === "possibility") return "diamond";
  return "circle";
}

export function familyCounts(nodes: readonly OntologyNode[]): Array<{ family: NodeFamily; count: number }> {
  const values = new Map<NodeFamily, number>();
  for (const node of nodes) {
    const family = nodeFamily(node);
    values.set(family, (values.get(family) ?? 0) + 1);
  }
  return [...values.entries()]
    .map(([family, count]) => ({ family, count }))
    .sort((left, right) => right.count - left.count || left.family.localeCompare(right.family));
}

export function buildRenderableGraph(
  graph: Pick<OntologyGraph, "nodes" | "edges">,
  options: {
    focusNodeId?: string;
    density?: EdgeDensity;
    nodeLimit?: number;
    edgeLimit?: number;
  } = {},
): RenderableGraph {
  const density = options.density ?? "balanced";
  const nodeLimit = options.nodeLimit ?? 1_200;
  const edgeLimit = options.edgeLimit ?? 3_000;
  const degree = graphDegree(graph.nodes, graph.edges);
  const focusNodeId = options.focusNodeId;

  if (focusNodeId && degree.has(focusNodeId)) {
    const focusedIds = new Set([focusNodeId]);
    const edges = graph.edges.filter((edge) => {
      const related = edge.source === focusNodeId || edge.target === focusNodeId;
      if (related) {
        focusedIds.add(edge.source);
        focusedIds.add(edge.target);
      }
      return related;
    });
    const limitedEdges = prioritizeEdges(edges).slice(0, edgeLimit);
    const visibleIds = new Set(limitedEdges.flatMap((edge) => [edge.source, edge.target]));
    visibleIds.add(focusNodeId);
    const nodes = graph.nodes.filter((node) => visibleIds.has(node.id)).slice(0, nodeLimit);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const closedEdges = limitedEdges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
    return {
      nodes,
      edges: closedEdges,
      degree,
      sampled: nodes.length < focusedIds.size || closedEdges.length < edges.length,
      focused: true,
      focusNodeId,
      sourceNodeCount: focusedIds.size,
      sourceEdgeCount: edges.length,
      hiddenNodeCount: Math.max(0, focusedIds.size - nodes.length),
      hiddenEdgeCount: Math.max(0, edges.length - closedEdges.length),
    };
  }

  const nodes = selectRenderableNodes(graph.nodes, degree, nodeLimit);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const candidateEdges = graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const edges = sparsifyEdges(nodes, candidateEdges, density, edgeLimit);
  return {
    nodes,
    edges,
    degree,
    sampled: nodes.length < graph.nodes.length || edges.length < candidateEdges.length,
    focused: false,
    sourceNodeCount: graph.nodes.length,
    sourceEdgeCount: graph.edges.length,
    hiddenNodeCount: Math.max(0, graph.nodes.length - nodes.length),
    hiddenEdgeCount: Math.max(0, graph.edges.length - edges.length),
  };
}

export function sparsifyEdges(
  nodes: readonly Pick<OntologyNode, "id">[],
  edges: readonly OntologyEdge[],
  density: EdgeDensity,
  maxEdges = 3_000,
): OntologyEdge[] {
  if (density === "complete") return prioritizeEdges(edges).slice(0, maxEdges);
  if (edges.length === 0 || nodes.length === 0) return [];
  if (density === "balanced" && edges.length <= Math.min(maxEdges, Math.max(80, nodes.length * 2))) {
    return prioritizeEdges(edges);
  }

  const bestByPair = new Map<string, OntologyEdge>();
  for (const edge of prioritizeEdges(edges)) {
    const key = edge.source < edge.target
      ? `${edge.source}\u001f${edge.target}`
      : `${edge.target}\u001f${edge.source}`;
    if (!bestByPair.has(key)) bestByPair.set(key, edge);
  }
  const candidates = [...bestByPair.values()];
  const union = new UnionFind(nodes.map((node) => node.id));
  const selected = new Map<string, OntologyEdge>();
  const selectedDegree = new Map(nodes.map((node) => [node.id, 0]));
  const add = (edge: OntologyEdge) => {
    if (selected.has(edge.id)) return;
    selected.set(edge.id, edge);
    selectedDegree.set(edge.source, (selectedDegree.get(edge.source) ?? 0) + 1);
    selectedDegree.set(edge.target, (selectedDegree.get(edge.target) ?? 0) + 1);
  };

  // A maximum-weight spanning forest keeps every connected component legible
  // before optional cycle edges are admitted.
  for (const edge of candidates) {
    if (edge.source === edge.target || union.find(edge.source) === union.find(edge.target)) continue;
    union.join(edge.source, edge.target);
    add(edge);
  }

  const degreeBudget = density === "essential" ? 2 : 5;
  const proportionalLimit = density === "essential"
    ? Math.ceil(nodes.length * 1.08)
    : Math.ceil(nodes.length * 2.2);
  const target = Math.min(maxEdges, Math.max(selected.size, proportionalLimit));
  for (const edge of candidates) {
    if (selected.size >= target) break;
    if (selected.has(edge.id)) continue;
    const sourceDegree = selectedDegree.get(edge.source) ?? 0;
    const targetDegree = selectedDegree.get(edge.target) ?? 0;
    if (sourceDegree >= degreeBudget && targetDegree >= degreeBudget) continue;
    add(edge);
  }
  return [...selected.values()];
}

export function graphPositions(
  graph: RenderableGraph,
  view: OntologyView,
  revision: number,
): Map<string, Point> {
  if (graph.focused && graph.focusNodeId) return focusedGraphPositions(graph, graph.focusNodeId, revision);
  if (graph.nodes.length === 0) return new Map();
  const adjacency = adjacencyFor(graph.nodes, graph.edges);
  const components = connectedComponents(graph.nodes, adjacency);
  const layouts = components.map((component) => componentLayout(component, graph, adjacency, view, revision));
  const totalArea = layouts.reduce((sum, layout) => sum + layout.width * layout.height, 0);
  const widest = Math.max(...layouts.map((layout) => layout.width));
  const rowTarget = Math.max(widest, Math.sqrt(totalArea) * 1.28);
  const gap = 130;
  const result = new Map<string, Point>();
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const layout of layouts) {
    if (cursorX > 0 && cursorX + layout.width > rowTarget) {
      cursorX = 0;
      cursorY += rowHeight + gap;
      rowHeight = 0;
    }
    for (const [id, point] of layout.positions) {
      result.set(id, { x: cursorX + point.x - layout.minX, y: cursorY + point.y - layout.minY });
    }
    cursorX += layout.width + gap;
    rowHeight = Math.max(rowHeight, layout.height);
  }
  return result;
}

export function relationCurves(edges: readonly OntologyEdge[]): Map<string, number> {
  const groups = new Map<string, OntologyEdge[]>();
  for (const edge of edges) {
    const key = [edge.source, edge.target].sort().join("\u001f");
    const values = groups.get(key) ?? [];
    values.push(edge);
    groups.set(key, values);
  }
  const result = new Map<string, number>();
  for (const values of groups.values()) {
    values.sort((left, right) => left.id.localeCompare(right.id));
    values.forEach((edge, index) => {
      result.set(edge.id, values.length === 1 ? 0 : (index - (values.length - 1) / 2) * 0.13);
    });
  }
  return result;
}

function graphDegree(nodes: readonly Pick<OntologyNode, "id">[], edges: readonly OntologyEdge[]): Map<string, number> {
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (degree.has(edge.source)) degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    if (degree.has(edge.target)) degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return degree;
}

function selectRenderableNodes(nodes: readonly OntologyNode[], degree: Map<string, number>, limit: number): OntologyNode[] {
  if (nodes.length <= limit) return [...nodes];
  const ranked = [...nodes].sort((left, right) =>
    (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || left.id.localeCompare(right.id));
  const selected = new Set<string>();
  const families = new Map<NodeFamily, OntologyNode[]>();
  for (const node of ranked) {
    const family = nodeFamily(node);
    const bucket = families.get(family) ?? [];
    bucket.push(node);
    families.set(family, bucket);
  }
  for (const bucket of families.values()) {
    if (selected.size >= limit) break;
    if (bucket[0]) selected.add(bucket[0].id);
  }
  for (const node of ranked) {
    if (selected.size >= limit) break;
    selected.add(node.id);
  }
  return nodes.filter((node) => selected.has(node.id));
}

function prioritizeEdges(edges: readonly OntologyEdge[]): OntologyEdge[] {
  return [...edges].sort((left, right) => edgePriority(right) - edgePriority(left) || left.id.localeCompare(right.id));
}

function edgePriority(edge: OntologyEdge): number {
  const status = ({
    active: 90,
    "branch-committed": 86,
    canonical: 80,
    contested: 60,
    possibility: 52,
    proposal: 38,
    inactive: 24,
    rejected: 5,
  } satisfies Record<OntologyStatus, number>)[edge.status];
  const semantic = /causal|spatial|particip|relationship|target|requires|forbids/.test(edge.kind) ? 14 : 0;
  return status + Math.min(40, edge.evidenceCount * 4) + semantic;
}

function adjacencyFor(nodes: readonly OntologyNode[], edges: readonly OntologyEdge[]): Map<string, Set<string>> {
  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  return adjacency;
}

function connectedComponents(nodes: readonly OntologyNode[], adjacency: Map<string, Set<string>>): OntologyNode[][] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const unseen = new Set(nodes.map((node) => node.id));
  const result: OntologyNode[][] = [];
  while (unseen.size > 0) {
    const root = [...unseen].sort()[0]!;
    unseen.delete(root);
    const ids = [root];
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index]!;
      const neighbors = [...(adjacency.get(id) ?? [])].sort();
      for (const neighbor of neighbors) {
        if (!unseen.delete(neighbor)) continue;
        ids.push(neighbor);
      }
    }
    result.push(ids.map((id) => byId.get(id)!).filter(Boolean));
  }
  return result.sort((left, right) => right.length - left.length || left[0]!.id.localeCompare(right[0]!.id));
}

type ComponentLayout = {
  positions: Map<string, Point>;
  minX: number;
  minY: number;
  width: number;
  height: number;
};

function componentLayout(
  nodes: OntologyNode[],
  graph: RenderableGraph,
  adjacency: Map<string, Set<string>>,
  view: OntologyView,
  revision: number,
): ComponentLayout {
  if (nodes.length === 1) {
    return { positions: new Map([[nodes[0]!.id, { x: 0, y: 0 }]]), minX: -38, minY: -38, width: 76, height: 76 };
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const root = [...nodes].sort((left, right) =>
    (graph.degree.get(right.id) ?? 0) - (graph.degree.get(left.id) ?? 0) || left.id.localeCompare(right.id))[0]!;
  const depth = new Map<string, number>([[root.id, 0]]);
  const parent = new Map<string, string>();
  const queue = [root.id];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    const neighbors = [...(adjacency.get(id) ?? [])]
      .filter((candidate) => nodeIds.has(candidate) && !depth.has(candidate))
      .sort((left, right) => left.localeCompare(right));
    for (const neighbor of neighbors) {
      depth.set(neighbor, (depth.get(id) ?? 0) + 1);
      parent.set(neighbor, id);
      queue.push(neighbor);
    }
  }
  const levels = new Map<number, OntologyNode[]>();
  for (const node of nodes) {
    const level = depth.get(node.id) ?? 1;
    const values = levels.get(level) ?? [];
    values.push(node);
    levels.set(level, values);
  }
  const positions = new Map<string, Point>([[root.id, { x: 0, y: 0 }]]);
  const rotation = hashNumber(`${root.id}:${revision}`) / 0xffffffff * Math.PI * 2;
  let priorRadius = 0;
  for (const [level, values] of [...levels.entries()].sort(([left], [right]) => left - right)) {
    if (level === 0) continue;
    values.sort((left, right) => {
      const leftParent = parent.get(left.id) ?? "";
      const rightParent = parent.get(right.id) ?? "";
      return leftParent.localeCompare(rightParent)
        || graphGroup(left, view).localeCompare(graphGroup(right, view))
        || hashNumber(`${left.id}:${revision}`) - hashNumber(`${right.id}:${revision}`);
    });
    // High-degree hubs often put most of a novel on the same BFS level. Packing
    // that level onto one huge circumference produces an unreadable halo, so
    // use as many concentric sub-rings as needed while preserving graph depth.
    let offset = 0;
    let radius = Math.max(level * 132, priorRadius + 106);
    while (offset < values.length) {
      const capacity = Math.max(8, Math.floor(2 * Math.PI * radius / 96));
      const ringNodes = values.slice(offset, offset + capacity);
      const ringRotation = rotation + (offset % 2 === 0 ? 0 : Math.PI / Math.max(1, ringNodes.length));
      ringNodes.forEach((node, index) => {
        const angle = ringRotation - Math.PI / 2 + index * Math.PI * 2 / ringNodes.length;
        positions.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
      });
      offset += ringNodes.length;
      priorRadius = radius;
      radius += 106;
    }
  }
  return boundsOf(positions, 58);
}

function focusedGraphPositions(graph: RenderableGraph, selectedNodeId: string, revision: number): Map<string, Point> {
  const result = new Map<string, Point>([[selectedNodeId, { x: 0, y: 0 }]]);
  const neighbors = graph.nodes
    .filter((node) => node.id !== selectedNodeId)
    .sort((left, right) => nodeFamily(left).localeCompare(nodeFamily(right))
      || (graph.degree.get(right.id) ?? 0) - (graph.degree.get(left.id) ?? 0)
      || left.label.localeCompare(right.label)
      || left.id.localeCompare(right.id));
  let offset = 0;
  let ring = 0;
  const rotation = hashNumber(`${selectedNodeId}:${revision}`) / 0xffffffff * Math.PI * 2;
  while (offset < neighbors.length) {
    const radius = 158 + ring * 108;
    const capacity = Math.max(10, Math.floor(2 * Math.PI * radius / 82));
    const ringNodes = neighbors.slice(offset, offset + capacity);
    ringNodes.forEach((node, index) => {
      const angle = rotation - Math.PI / 2 + index * 2 * Math.PI / ringNodes.length;
      result.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    });
    offset += ringNodes.length;
    ring += 1;
  }
  return result;
}

function boundsOf(positions: Map<string, Point>, padding: number): ComponentLayout {
  const values = [...positions.values()];
  const minX = Math.min(...values.map((point) => point.x)) - padding;
  const maxX = Math.max(...values.map((point) => point.x)) + padding;
  const minY = Math.min(...values.map((point) => point.y)) - padding;
  const maxY = Math.max(...values.map((point) => point.y)) + padding;
  return { positions, minX, minY, width: maxX - minX, height: maxY - minY };
}

function graphGroup(node: OntologyNode, view: OntologyView): string {
  if (view === "provenance") {
    if (node.kind === "source") return "0-source";
    if (node.kind === "source-span") return "1-evidence";
    if (node.kind.includes("proposal") || node.layer === "proposal") return "2-proposal";
    if (node.kind === "validation") return "3-validation";
    if (node.kind.includes("commit") || node.layer === "branch") return "5-history";
    return "4-artifact";
  }
  if (view === "events") return `${node.layer}:${node.status}`;
  return `${nodeFamily(node)}:${node.layer}`;
}

function hashNumber(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  constructor(ids: readonly string[]) {
    for (const id of ids) this.parent.set(id, id);
  }

  find(id: string): string {
    const value = this.parent.get(id) ?? id;
    if (value === id) return value;
    const root = this.find(value);
    this.parent.set(id, root);
    return root;
  }

  join(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }
}

import { describe, expect, it } from "vitest";
import {
  buildRenderableGraph,
  familyVisuals,
  graphPositions,
  nodeColor,
  nodeFamily,
  relationCurves,
  sparsifyEdges,
} from "../apps/web/src/ontology-graph.js";
import type { OntologyEdge, OntologyNode } from "../src/web/contracts.js";

function node(id: string, kind = "entity:character", layer: OntologyNode["layer"] = "canonical"): OntologyNode {
  return {
    id,
    artifactId: `artifact:${id}`,
    kind,
    label: id,
    status: layer === "possibility" ? "possibility" : "canonical",
    layer,
    evidenceCount: 1,
    shared: false,
    summary: {},
    detailsEndpoint: `/ontology/${id}`,
  };
}

function edge(id: string, source: string, target: string, evidenceCount = 1): OntologyEdge {
  return {
    id,
    kind: "semantic-link",
    label: id,
    source,
    target,
    status: "canonical",
    layer: "canonical",
    evidenceCount,
    properties: {},
  };
}

describe("ontology graph presentation", () => {
  it("assigns semantic entity families independently from truth status", () => {
    const examples = [
      [node("character", "entity:character"), "character"],
      [node("place", "entity:location"), "place"],
      [node("group", "entity:faction"), "collective"],
      [node("artifact", "entity:artifact"), "artifact"],
      [node("relationship", "entity:relationship"), "relationship"],
      [node("event", "canonical-event"), "event"],
      [node("knowledge", "entity:concept"), "knowledge"],
      [node("model", "character-model"), "model"],
      [node("rule", "world-rule"), "rule"],
      [node("possibility", "possibility:canon-analogue", "possibility"), "possibility"],
      [node("source", "source-span", "evidence"), "provenance"],
      [node("draft-event", "proposal:canonical-event", "proposal"), "provenance"],
    ] as const;

    for (const [value, family] of examples) {
      expect(nodeFamily(value)).toBe(family);
      expect(nodeColor(value)).toBe(familyVisuals[family].color);
    }
    expect(new Set(examples.map(([value]) => nodeColor(value))).size).toBe(new Set(examples.map(([, family]) => family)).size);
  });

  it("keeps a connected backbone before admitting optional cycle edges", () => {
    const nodes = Array.from({ length: 15 }, (_, index) => node(`n${index}`));
    const edges: OntologyEdge[] = [];
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        edges.push(edge(`e:${left}:${right}`, nodes[left]!.id, nodes[right]!.id, (left + right) % 4 + 1));
      }
    }

    const essential = sparsifyEdges(nodes, edges, "essential");
    const balanced = sparsifyEdges(nodes, edges, "balanced");
    const complete = sparsifyEdges(nodes, edges, "complete");

    expect(reachableFrom(nodes[0]!.id, essential).size).toBe(nodes.length);
    expect(essential.length).toBeLessThan(balanced.length);
    expect(balanced.length).toBeLessThan(complete.length);
    expect(essential.map((value) => value.id)).toEqual(sparsifyEdges(nodes, edges, "essential").map((value) => value.id));
  });

  it("retains representation from each visible entity family when sampling nodes", () => {
    const nodes = [
      ...Array.from({ length: 20 }, (_, index) => node(`character:${index}`)),
      node("location", "entity:location"),
      node("rule", "world-rule"),
      node("event", "canonical-event"),
    ];
    const rendered = buildRenderableGraph({ nodes, edges: [] }, { nodeLimit: 4 });

    expect(new Set(rendered.nodes.map(nodeFamily))).toEqual(new Set(["character", "place", "rule", "event"]));
    expect(rendered.hiddenNodeCount).toBe(nodes.length - 4);
  });

  it("produces deterministic layouts and centers a focused entity", () => {
    const nodes = [
      node("a", "entity:character"),
      node("b", "entity:location"),
      node("c", "canonical-event"),
      node("d", "world-rule"),
      node("e", "entity:artifact"),
    ];
    const edges = [edge("ab", "a", "b"), edge("ac", "a", "c"), edge("bd", "b", "d"), edge("ce", "c", "e")];
    const overview = buildRenderableGraph({ nodes, edges }, { density: "complete" });
    const first = graphPositions(overview, "model", 0);
    const second = graphPositions(overview, "model", 0);

    expect([...first.entries()]).toEqual([...second.entries()]);
    expect(new Set([...first.values()].map(({ x, y }) => `${x}:${y}`)).size).toBe(nodes.length);

    const focused = buildRenderableGraph({ nodes, edges }, { focusNodeId: "a" });
    expect(graphPositions(focused, "model", 0).get("a")).toEqual({ x: 0, y: 0 });
  });

  it("separates parallel relationships with stable curves", () => {
    const edges = [edge("a", "left", "right"), edge("b", "left", "right"), edge("c", "right", "left")];
    const curves = relationCurves(edges);
    expect([...curves.values()]).toEqual([-0.13, 0, 0.13]);
    expect(relationCurves([...edges].reverse())).toEqual(curves);
  });
});

function reachableFrom(root: string, edges: readonly OntologyEdge[]): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const value of edges) {
    adjacency.set(value.source, [...(adjacency.get(value.source) ?? []), value.target]);
    adjacency.set(value.target, [...(adjacency.get(value.target) ?? []), value.source]);
  }
  const reached = new Set([root]);
  const queue = [root];
  for (let index = 0; index < queue.length; index += 1) {
    for (const neighbor of adjacency.get(queue[index]!) ?? []) {
      if (reached.has(neighbor)) continue;
      reached.add(neighbor);
      queue.push(neighbor);
    }
  }
  return reached;
}

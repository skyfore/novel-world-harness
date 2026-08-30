import { GraphChart, type GraphSeriesOption } from "echarts/charts";
import { TooltipComponent, type TooltipComponentOption } from "echarts/components";
import { init as initChart, use as useECharts, type ComposeOption, type ECharts } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import {
  forwardRef,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link } from "@tanstack/react-router";
import { fetchInstance, fetchOntology, fetchOntologyNode, type OntologyFilters } from "./api";
import { canRetrySameRequest, recoveryInstruction, webErrorDetail } from "./recovery";
import { useI18n } from "./i18n";
import type {
  InstanceSummary,
  NovelSummary,
  OntologyEdge,
  OntologyGraph,
  OntologyLayer,
  OntologyNode,
  OntologyStatus,
  OntologyView,
} from "../../../src/web/contracts";

useECharts([GraphChart, TooltipComponent, CanvasRenderer]);
type GraphChartOption = ComposeOption<GraphSeriesOption | TooltipComponentOption>;

const GRAPH_PAGE_SIZE = 180;
const GRAPH_RENDER_NODE_LIMIT = 1_200;
const GRAPH_RENDER_EDGE_LIMIT = 3_000;

const views: Array<{ id: OntologyView; label: string; description: string }> = [
  { id: "model", label: "World model", description: "Entities, propositions, claims, character models, goals, and their semantic links." },
  { id: "events", label: "Events", description: "Canonical structure, committed branch history, causal links, and isolated future possibilities." },
  { id: "places", label: "Places", description: "Location topology and route validity at the selected committed time." },
  { id: "rules", label: "Rules", description: "World rules, authority, jurisdiction, dependencies, and effective status." },
  { id: "provenance", label: "Provenance", description: "Source spans, compiler proposals, validation outcomes, artifacts, and committed history." },
];

const allLayers: Array<{ id: OntologyLayer; label: string }> = [
  { id: "canonical", label: "Canonical" },
  { id: "branch", label: "Branch truth" },
  { id: "possibility", label: "Possibility" },
  { id: "proposal", label: "Proposals" },
  { id: "evidence", label: "Evidence" },
];

const statusColors: Record<OntologyStatus, string> = {
  canonical: "#d6ff72",
  active: "#8fe388",
  inactive: "#64685f",
  "branch-committed": "#80b7d8",
  possibility: "#e8bb68",
  proposal: "#caa0d7",
  contested: "#ffb36f",
  rejected: "#ff8d7f",
};

export function OntologyPage({
  sourceId,
  view,
  novel,
  instances,
  initialBranchId,
  initialCommitId,
  initialIncludeCanonicalFuture = false,
  onScopeChange,
}: {
  sourceId: string;
  view: OntologyView;
  novel?: NovelSummary;
  instances: InstanceSummary[];
  initialBranchId?: string;
  initialCommitId?: string;
  initialIncludeCanonicalFuture?: boolean;
  onScopeChange?: (scope: { branchId?: string; atCommit?: string; includeCanonicalFuture?: boolean }) => void;
}) {
  const { t } = useI18n();
  const meta = views.find((candidate) => candidate.id === view)!;
  const sourceInstances = instances.filter((instance) => instance.sourceId === sourceId);
  const [branchId, setBranchId] = useState(initialBranchId ?? "");
  const [commitId, setCommitId] = useState(initialCommitId ?? "");
  const [includeCanonicalFuture, setIncludeCanonicalFuture] = useState(initialIncludeCanonicalFuture);
  const [layers, setLayers] = useState<OntologyLayer[]>(() => defaultLayers(view));
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState<OntologyStatus | "">("");
  const deferredSearch = useDeferredValue(search.trim());
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [loadingAll, setLoadingAll] = useState(false);
  const stopFullLoad = useRef(false);
  const graphRef = useRef<GraphCanvasHandle>(null);
  const onScopeChangeRef = useRef(onScopeChange);
  onScopeChangeRef.current = onScopeChange;

  useEffect(() => {
    setBranchId(initialBranchId ?? "");
    setCommitId(initialCommitId ?? "");
    setIncludeCanonicalFuture(initialIncludeCanonicalFuture);
  }, [initialBranchId, initialCommitId, initialIncludeCanonicalFuture]);

  useEffect(() => {
    setLayers(defaultLayers(view));
    setKind("");
    setStatus("");
    setSelectedNodeId(undefined);
    if (view !== "events" && view !== "provenance") {
      setIncludeCanonicalFuture(false);
      if (initialIncludeCanonicalFuture) onScopeChangeRef.current?.({
        ...(branchId ? { branchId } : {}),
        ...(commitId ? { atCommit: commitId } : {}),
      });
    }
  }, [view]);

  const instance = useQuery({
    queryKey: ["instance", branchId],
    queryFn: ({ signal }) => fetchInstance(branchId, signal),
    enabled: Boolean(branchId),
  });
  const effectiveCommit = branchId ? commitId || instance.data?.instance.headCommitId : undefined;

  useEffect(() => {
    if (!branchId) {
      setCommitId("");
      return;
    }
    if (instance.data?.instance.branchId === branchId && !commitId) {
      setCommitId(instance.data.instance.headCommitId);
      onScopeChangeRef.current?.({ branchId, atCommit: instance.data.instance.headCommitId, ...(includeCanonicalFuture ? { includeCanonicalFuture: true } : {}) });
    }
  }, [branchId, commitId, includeCanonicalFuture, instance.data?.instance.branchId, instance.data?.instance.headCommitId]);

  const filters: OntologyFilters = {
    ...(branchId ? { branchId } : {}),
    ...(effectiveCommit ? { atCommit: effectiveCommit } : {}),
    ...(includeCanonicalFuture ? { includeCanonicalFuture: true } : {}),
    layers,
    limit: GRAPH_PAGE_SIZE,
    ...(deferredSearch ? { search: deferredSearch } : {}),
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
  };
  const graph = useInfiniteQuery({
    queryKey: ["ontology", sourceId, view, branchId, effectiveCommit, includeCanonicalFuture, [...layers].sort().join(","), deferredSearch, kind, status],
    queryFn: ({ signal, pageParam }) => fetchOntology(sourceId, view, {
      ...filters,
      ...(pageParam ? { cursor: pageParam } : {}),
    }, signal),
    enabled: Boolean(novel),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
  });
  const loadedGraph = useMemo(() => mergeGraphPages(graph.data?.pages), [graph.data?.pages]);
  const [canvasGraph, setCanvasGraph] = useState<OntologyGraph>();

  useEffect(() => {
    if (selectedNodeId && loadedGraph && !loadedGraph.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(undefined);
    }
  }, [loadedGraph, selectedNodeId]);
  useEffect(() => () => { stopFullLoad.current = true; }, []);
  useEffect(() => {
    stopFullLoad.current = true;
    setLoadingAll(false);
  }, [sourceId, view, branchId, effectiveCommit, includeCanonicalFuture, deferredSearch, kind, status, layers.join(",")]);
  useEffect(() => {
    if (loadedGraph && !loadingAll) setCanvasGraph(loadedGraph);
  }, [loadedGraph, loadingAll]);

  const detail = useQuery({
    queryKey: ["ontology-node", sourceId, view, selectedNodeId, branchId, effectiveCommit, includeCanonicalFuture, [...layers].sort().join(",")],
    queryFn: ({ signal }) => fetchOntologyNode(sourceId, view, selectedNodeId!, {
      ...(branchId ? { branchId } : {}),
      ...(effectiveCommit ? { atCommit: effectiveCommit } : {}),
      ...(includeCanonicalFuture ? { includeCanonicalFuture: true } : {}),
      layers,
      relationLimit: 100,
    }, signal),
    enabled: Boolean(selectedNodeId),
  });

  const visible = loadedGraph;
  const selectedNode = loadedGraph?.nodes.find((node) => node.id === selectedNodeId);

  const loadAllPages = async () => {
    stopFullLoad.current = false;
    setLoadingAll(true);
    try {
      let nextCursor = graph.data?.pages.at(-1)?.page.nextCursor;
      while (nextCursor && !stopFullLoad.current) {
        const result = await graph.fetchNextPage();
        nextCursor = result.data?.pages.at(-1)?.page.nextCursor;
        await yieldToBrowser();
      }
    } finally {
      setLoadingAll(false);
    }
  };

  if (!novel) {
    return <PageState title={t("Unknown novel")} body={t("No registered source matches {sourceId}.", { sourceId })} />;
  }

  return (
    <>
      <div className="ontology-heading">
        <div>
          <Link className="ontology-back-link" to="/novels/$sourceId" params={{ sourceId }}>← {novel.title}</Link>
          <span className="eyebrow">{t("Ontology workbench")}</span>
          <h1>{t(meta.label)}</h1>
          <p>{t(meta.description)}</p>
        </div>
        <div className="ontology-heading-actions">
          <span className={branchId ? "truth-badge truth-badge-branch" : "truth-badge"}>{branchId ? t("Committed branch scope") : t("Compiled source scope")}</span>
          {effectiveCommit && <code>{shortHash(effectiveCommit)}</code>}
        </div>
      </div>

      <nav className="ontology-tabs" aria-label={t("Ontology projection")}>
        {views.map((candidate) => (
          <Link
            key={candidate.id}
            to="/novels/$sourceId/ontology/$view"
            params={{ sourceId, view: candidate.id }}
            search={{
              ...(branchId ? { branchId } : {}),
              ...(effectiveCommit ? { atCommit: effectiveCommit } : {}),
              ...(includeCanonicalFuture && (candidate.id === "events" || candidate.id === "provenance") ? { includeCanonicalFuture: true } : {}),
            }}
            className={candidate.id === view ? "ontology-tab ontology-tab-active" : "ontology-tab"}
          >
            {t(candidate.label)}
          </Link>
        ))}
      </nav>

      <section className="ontology-scope" aria-label={t("Projection scope")}>
        <label>
          <span>{t("Truth scope")}</span>
          <select value={branchId} onChange={(event) => {
            const nextBranchId = event.target.value;
            setBranchId(nextBranchId);
            setCommitId("");
            onScopeChangeRef.current?.(nextBranchId ? { branchId: nextBranchId } : {});
          }}>
            <option value="">{t("Current compiled source")}</option>
            {sourceInstances.map((candidate) => <option key={candidate.branchId} value={candidate.branchId}>{candidate.name} · {t("step")} {candidate.logicalStep}</option>)}
          </select>
        </label>
        <label>
          <span>{t("Committed time")}</span>
          <select
            value={effectiveCommit ?? ""}
            disabled={!branchId || instance.isPending || !instance.data}
            onChange={(event) => {
              setCommitId(event.target.value);
              onScopeChangeRef.current?.({ branchId, atCommit: event.target.value, ...(includeCanonicalFuture ? { includeCanonicalFuture: true } : {}) });
            }}
          >
            {!branchId && <option value="">{t("Not branch-scoped")}</option>}
            {branchId && instance.isPending && <option value="">{t("Resolving ancestry…")}</option>}
            {instance.data?.history.map((commit) => (
              <option key={commit.id} value={commit.id}>{t("step")} {commit.logicalStep} · {shortHash(commit.id)}{commit.id === instance.data.instance.headCommitId ? ` · ${t("HEAD")}` : ""}</option>
            ))}
          </select>
        </label>
        {(view === "events" || view === "provenance") && branchId ? (
          <label className="ontology-future-toggle">
            <input type="checkbox" checked={includeCanonicalFuture} onChange={(event) => {
              setIncludeCanonicalFuture(event.target.checked);
              onScopeChangeRef.current?.({ branchId, ...(effectiveCommit ? { atCommit: effectiveCommit } : {}), ...(event.target.checked ? { includeCanonicalFuture: true } : {}) });
            }} />
            <span><strong>{t("Show future canon as possibility")}</strong><small>{t("Never promotes it into branch truth.")}</small></span>
          </label>
        ) : <div className="ontology-scope-note"><strong>{t("Truth boundary")}</strong><span>{branchId ? t("State and validity derive from the selected commit.") : t("Shows current accepted compiler artifacts, not a runtime state.")}</span></div>}
      </section>

      <section className="ontology-toolbar" aria-label={t("Graph filters")}>
        <label className="ontology-search"><span>{t("Search")}</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("Label, ID, kind, status…")} /></label>
        <label><span>{t("Kind")}</span><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">{t("All kinds")}</option>{Object.keys(graph.data?.pages[0]?.facets.kinds ?? {}).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span>{t("Status")}</span><select value={status} onChange={(event) => setStatus(event.target.value as OntologyStatus | "")}><option value="">{t("All statuses")}</option>{Object.keys(graph.data?.pages[0]?.facets.statuses ?? {}).map((value) => <option key={value} value={value}>{t(value)}</option>)}</select></label>
        <div className="ontology-graph-actions">
          <button type="button" onClick={() => graphRef.current?.fit()} disabled={!visible?.nodes.length}>{t("Fit")}</button>
          <button type="button" onClick={() => graphRef.current?.relayout()} disabled={!visible?.nodes.length}>{t("Re-layout")}</button>
          <button type="button" onClick={() => void graph.refetch()} disabled={graph.isFetching}>{graph.isFetching ? t("Refreshing…") : t("Refresh")}</button>
        </div>
      </section>

      <section className="ontology-layer-bar" aria-label={t("Projection layers")}>
        <span>{t("Layers")}</span>
        {allLayers.map((layer) => (
          <label key={layer.id} className={layers.includes(layer.id) ? "layer-chip layer-chip-active" : "layer-chip"}>
            <input
              type="checkbox"
              checked={layers.includes(layer.id)}
              onChange={() => setLayers((current) => current.includes(layer.id)
                ? current.length === 1 ? current : current.filter((item) => item !== layer.id)
                : [...current, layer.id])}
            />
            {t(layer.label)}
          </label>
        ))}
        <span className="ontology-count">{t("{nodes} nodes · {edges} edges", { nodes: visible?.nodes.length ?? 0, edges: visible?.edges.length ?? 0 })}</span>
      </section>

      {visible && <section className="ontology-load-bar" aria-live="polite">
        <div>
          <span>{t("Topology pages")}</span>
          <strong>{t("{loaded} of {total} nodes · {edges} closed relations", { loaded: visible.page.loadedNodes, total: visible.totalNodes, edges: visible.page.loadedEdges })}</strong>
          <div className="paged-load-track"><i style={{ width: `${percentage(visible.page.loadedNodes, visible.totalNodes)}%` }} /></div>
          {visible.page.remainingEdges > 0 && <small>{t("{count} relationships remain deferred until their endpoint nodes are loaded.", { count: visible.page.remainingEdges })}</small>}
        </div>
        {graph.hasNextPage && !loadingAll && <>
          <button type="button" onClick={() => void graph.fetchNextPage()} disabled={graph.isFetchingNextPage}>{graph.isFetchingNextPage ? t("Loading next page…") : t("Load next page")}</button>
          <button type="button" onClick={() => void loadAllPages()} disabled={graph.isFetchingNextPage}>{t("Load complete dataset")}</button>
        </>}
        {loadingAll && <button type="button" onClick={() => { stopFullLoad.current = true; }}>{t("Stop loading")}</button>}
      </section>}

      {instance.isError && <InlineError error={instance.error} />}
      {graph.isPending ? <PageState loading title={t("Projecting the ontology")} body={t("Resolving source-scoped artifacts and temporal validity…")} /> : graph.isError ? <OntologyErrorState error={graph.error} retry={() => void graph.refetch()} /> : graph.data && visible ? (
        <>
          {visible.diagnostics.length > 0 && <div className="ontology-diagnostics">{visible.diagnostics.map((message) => <p key={message}>{message}</p>)}</div>}
          <div className="ontology-workbench">
            <section className="ontology-canvas-panel">
              <header>
                <div><span className="eyebrow">{t("Graph")}</span><strong>{visible.truncated ? t("Progressive topology · {loaded}/{total} nodes", { loaded: visible.page.loadedNodes, total: visible.totalNodes }) : t("Complete selected projection")}</strong></div>
                <div className="ontology-legend">{visible.legend.map((item) => <span key={item.id}><i style={{ background: item.color }} />{t(item.label)}<small>{item.count}</small></span>)}</div>
              </header>
              {visible.nodes.length ? <GraphCanvas ref={graphRef} graph={canvasGraph?.page.snapshotId === visible.page.snapshotId ? canvasGraph : visible} view={view} selectedNodeId={selectedNodeId} onSelect={setSelectedNodeId} /> : <EmptyGraph />}
            </section>
            <NodeInspector node={selectedNode} detail={detail} onClose={() => setSelectedNodeId(undefined)} />
          </div>
          <OntologyTable graph={visible} selectedNodeId={selectedNodeId} onSelect={setSelectedNodeId} />
        </>
      ) : null}
    </>
  );
}

type GraphCanvasHandle = { fit: () => void; relayout: () => void };

const GraphCanvas = forwardRef<GraphCanvasHandle, {
  graph: OntologyGraph;
  view: OntologyView;
  selectedNodeId?: string;
  onSelect: (nodeId: string) => void;
}>(function GraphCanvas({ graph, view, selectedNodeId, onSelect }, ref) {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const option = useRef<GraphChartOption | undefined>(undefined);
  const onSelectRef = useRef(onSelect);
  const [layoutRevision, setLayoutRevision] = useState(0);
  onSelectRef.current = onSelect;
  const rendered = useMemo(
    () => renderableGraph(graph, selectedNodeId),
    [graph, selectedNodeId],
  );

  useImperativeHandle(ref, () => ({
    fit: () => {
      if (!chart.current || !option.current) return;
      chart.current.setOption(option.current, { notMerge: true, lazyUpdate: false });
      chart.current.resize();
    },
    relayout: () => setLayoutRevision((current) => current + 1),
  }), []);

  useEffect(() => {
    if (!container.current) return;
    const instance = initChart(container.current, undefined, {
      renderer: "canvas",
      useDirtyRect: true,
    });
    chart.current = instance;
    instance.on("click", (event) => {
      if (event.dataType === "node" && typeof event.name === "string") onSelectRef.current(event.name);
    });
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      if (chart.current === instance) chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chart.current) return;
    option.current = graphOption(rendered, view, selectedNodeId, layoutRevision);
    chart.current.setOption(option.current, { notMerge: true, lazyUpdate: true });
  }, [layoutRevision, rendered, selectedNodeId, view]);

  return <div className="ontology-canvas-shell">
    <div ref={container} className="ontology-canvas" role="img" aria-label={t("{view} ontology graph with {nodes} nodes and {edges} edges", { view: t(view), nodes: rendered.nodes.length, edges: rendered.edges.length })} />
    {rendered.sampled && <div className="ontology-render-note">{t("Canvas view sampled {nodes} high-connectivity nodes and {edges} relations; the virtual table retains all {total} loaded nodes.", { nodes: rendered.nodes.length, edges: rendered.edges.length, total: graph.nodes.length })}</div>}
  </div>;
});

type RenderableGraph = {
  nodes: OntologyNode[];
  edges: OntologyEdge[];
  degree: Map<string, number>;
  sampled: boolean;
};

function renderableGraph(graph: OntologyGraph, selectedNodeId?: string): RenderableGraph {
  const degree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const sampled = graph.nodes.length > GRAPH_RENDER_NODE_LIMIT || graph.edges.length > GRAPH_RENDER_EDGE_LIMIT;
  if (!sampled) return { nodes: graph.nodes, edges: graph.edges, degree, sampled: false };

  const included = new Set<string>();
  if (selectedNodeId) {
    included.add(selectedNodeId);
    for (const edge of graph.edges) {
      if (edge.source === selectedNodeId) included.add(edge.target);
      if (edge.target === selectedNodeId) included.add(edge.source);
    }
  }
  const ranked = [...graph.nodes].sort((left, right) =>
    (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || left.id.localeCompare(right.id));
  for (const node of ranked) {
    if (included.size >= GRAPH_RENDER_NODE_LIMIT) break;
    included.add(node.id);
  }
  const nodes = graph.nodes.filter((node) => included.has(node.id));
  const edges = graph.edges
    .filter((edge) => included.has(edge.source) && included.has(edge.target))
    .sort((left, right) => {
      const leftSelected = left.source === selectedNodeId || left.target === selectedNodeId ? 1 : 0;
      const rightSelected = right.source === selectedNodeId || right.target === selectedNodeId ? 1 : 0;
      return rightSelected - leftSelected
        || (degree.get(right.source) ?? 0) + (degree.get(right.target) ?? 0)
          - (degree.get(left.source) ?? 0) - (degree.get(left.target) ?? 0)
        || left.id.localeCompare(right.id);
    })
    .slice(0, GRAPH_RENDER_EDGE_LIMIT);
  return { nodes, edges, degree, sampled: true };
}

function graphOption(
  graph: RenderableGraph,
  view: OntologyView,
  selectedNodeId: string | undefined,
  layoutRevision: number,
): GraphChartOption {
  const positions = graphPositions(graph.nodes, view, layoutRevision);
  const showLabels = graph.nodes.length <= 90;
  return {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      confine: true,
      backgroundColor: "#1b1d18",
      borderColor: "#4d5246",
      textStyle: { color: "#d7d8d1", fontFamily: "DM Mono", fontSize: 10 },
    },
    series: [{
      type: "graph",
      layout: "none",
      coordinateSystem: undefined,
      animation: false,
      progressive: 400,
      progressiveThreshold: 700,
      roam: true,
      scaleLimit: { min: 0.08, max: 6 },
      selectedMode: "single",
      edgeSymbol: ["none", graph.edges.length <= 900 ? "arrow" : "none"],
      edgeSymbolSize: 5,
      data: graph.nodes.map((node) => {
        const position = positions.get(node.id) ?? { x: 0, y: 0 };
        const selected = node.id === selectedNodeId;
        return {
          id: node.id,
          name: node.id,
          value: node.label,
          x: position.x,
          y: position.y,
          symbol: shapeFor(node),
          symbolSize: selected ? 28 : Math.min(22, 10 + Math.log2((graph.degree.get(node.id) ?? 0) + 1) * 3),
          selected,
          itemStyle: {
            color: statusColors[node.status],
            borderColor: selected ? "#ffffff" : "#10110f",
            borderWidth: selected ? 3 : 1,
          },
          label: {
            show: showLabels || selected,
            formatter: node.label,
            position: "bottom",
            distance: 5,
            color: "#d7d8d1",
            fontFamily: "Manrope",
            fontSize: 8,
            width: 120,
            overflow: "truncate",
          },
          emphasis: {
            focus: "adjacency",
            scale: true,
            label: { show: true, formatter: node.label, color: "#ffffff", fontSize: 10 },
            itemStyle: { borderColor: "#ffffff", borderWidth: 3 },
          },
        };
      }),
      links: graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        lineStyle: {
          color: statusColors[edge.status],
          width: edge.source === selectedNodeId || edge.target === selectedNodeId ? 2 : 0.8,
          opacity: edge.source === selectedNodeId || edge.target === selectedNodeId ? 0.9 : 0.32,
          curveness: graph.edges.length < 500 ? 0.06 : 0,
        },
      })),
      lineStyle: { opacity: 0.35 },
      label: { show: showLabels },
      edgeLabel: { show: false },
      emphasis: { focus: "adjacency", lineStyle: { width: 2, opacity: 0.95 } },
    }],
  };
}

function graphPositions(nodes: readonly OntologyNode[], view: OntologyView, revision: number): Map<string, { x: number; y: number }> {
  const groups = new Map<string, OntologyNode[]>();
  for (const node of nodes) {
    const group = graphGroup(node, view);
    const values = groups.get(group) ?? [];
    values.push(node);
    groups.set(group, values);
  }
  const result = new Map<string, { x: number; y: number }>();
  let groupOffset = 0;
  for (const [group, values] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    values.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
    const rows = Math.max(1, Math.min(28, Math.ceil(Math.sqrt(values.length * 1.7))));
    const columns = Math.max(1, Math.ceil(values.length / rows));
    values.forEach((node, index) => {
      const column = Math.floor(index / rows);
      const row = index % rows;
      const jitter = hashNumber(`${node.id}:${revision}`) % 13;
      result.set(node.id, {
        x: groupOffset + column * 58 + jitter,
        y: row * 52 + (hashNumber(`${group}:${node.id}:${revision}`) % 9),
      });
    });
    groupOffset += columns * 58 + 180;
  }
  return result;
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
  return `${node.layer}:${node.kind}`;
}

function hashNumber(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function NodeInspector({
  node,
  detail,
  onClose,
}: {
  node?: OntologyNode;
  detail: ReturnType<typeof useQuery<Awaited<ReturnType<typeof fetchOntologyNode>>, Error>>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <aside className="ontology-inspector">
      <header>
        <div><span className="eyebrow">{t("Inspector")}</span><strong>{node?.label ?? t("Select a node")}</strong></div>
        {node && <button type="button" aria-label={t("Close inspector")} onClick={onClose}>×</button>}
      </header>
      {!node ? <div className="ontology-inspector-empty"><span>◇</span><p>{t("Click a graph node or table row to inspect its exact payload, evidence, and relationships.")}</p></div> : (
        <div className="ontology-inspector-scroll">
          <div className="node-identity">
            <span style={{ background: statusColors[node.status] }} />
            <div><strong>{node.kind}</strong><small>{node.status} · {node.layer}</small></div>
          </div>
          <dl className="ontology-node-meta">
            <div><dt>{t("Artifact")}</dt><dd>{node.artifactId}</dd></div>
            <div><dt>{t("Node ID")}</dt><dd>{node.id}</dd></div>
            <div><dt>{t("Revision")}</dt><dd>{node.revisionHash ?? t("derived")}</dd></div>
            <div><dt>{t("Evidence")}</dt><dd>{node.evidenceCount}{node.shared ? ` · ${t("shared artifact, locally filtered")}` : ""}</dd></div>
            {node.storyTime !== undefined && <div><dt>{t("Story time")}</dt><dd>{compactJson(node.storyTime)}</dd></div>}
          </dl>
          {detail.isPending ? <InlineLoading /> : detail.isError ? <InlineError error={detail.error} /> : detail.data ? (
            <>
              <InspectorSection title={t("Summary")}><JsonRecord value={node.summary} /></InspectorSection>
              <InspectorSection title={`${t("Evidence")} · ${detail.data.evidence.length}`}>
                {detail.data.evidence.length ? <div className="evidence-list">{detail.data.evidence.map((evidence, index) => (
                  <article key={`${evidence.quoteHash}:${index}`}>
                    <header><span>{t("lines {start}–{end}", { start: evidence.startLine, end: evidence.endLine })}</span><small>{t(evidence.strength)}</small></header>
                    {evidence.excerpt !== undefined ? <blockquote>{evidence.excerpt}{evidence.excerptTruncated ? "…" : ""}</blockquote> : <p>{t("Exact byte excerpt is unavailable for this legacy reference.")}</p>}
                    <code>{shortHash(evidence.quoteHash)}</code>
                  </article>
                ))}</div> : <p className="inspector-muted">{t("No source-local evidence span is attached.")}</p>}
              </InspectorSection>
              <InspectorSection title={t("Incoming · {loaded}/{total}", { loaded: detail.data.incoming.length, total: detail.data.relationPage.incomingTotal })}><EdgeList edges={detail.data.incoming} direction="incoming" /></InspectorSection>
              <InspectorSection title={t("Outgoing · {loaded}/{total}", { loaded: detail.data.outgoing.length, total: detail.data.relationPage.outgoingTotal })}><EdgeList edges={detail.data.outgoing} direction="outgoing" /></InspectorSection>
              {detail.data.relationPage.truncated && <p className="inspector-muted">{t("Node detail shows a bounded relationship preview; load the complete topology to inspect every connected edge.")}</p>}
              <DeferredPayload value={detail.data.payload} />
            </>
          ) : null}
        </div>
      )}
    </aside>
  );
}

function DeferredPayload({ value }: { value: unknown }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const formatted = useMemo(() => open ? JSON.stringify(value, null, 2) ?? "null" : "", [open, value]);
  return <details className="payload-json" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{t("Exact stored / derived payload")}</summary>{open && <pre>{formatted}</pre>}</details>;
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="inspector-section"><h3>{title}</h3>{children}</section>;
}

function JsonRecord({ value }: { value: Record<string, unknown> }) {
  const { t } = useI18n();
  const entries = Object.entries(value);
  return entries.length ? <dl className="summary-record">{entries.map(([key, item]) => <div key={key}><dt>{key}</dt><dd>{formatValue(item)}</dd></div>)}</dl> : <p className="inspector-muted">{t("No summary fields.")}</p>;
}

function EdgeList({ edges, direction }: { edges: OntologyEdge[]; direction: "incoming" | "outgoing" }) {
  const { t } = useI18n();
  return edges.length ? <div className="inspector-edge-list">{edges.map((edge) => <div key={edge.id}><span>{edge.label}</span><code>{direction === "incoming" ? edge.source : edge.target}</code></div>)}</div> : <p className="inspector-muted">{t(direction === "incoming" ? "No incoming relationships in this projection." : "No outgoing relationships in this projection.")}</p>;
}

function OntologyTable({ graph, selectedNodeId, onSelect }: { graph: OntologyGraph; selectedNodeId?: string; onSelect: (nodeId: string) => void }) {
  const { t } = useI18n();
  const parent = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: graph.nodes.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 48,
    overscan: 10,
  });
  return (
    <section className="ontology-table-panel">
      <header><div><span className="eyebrow">{t("Accessible table")}</span><strong>{t("Searchable projection fallback")}</strong></div><span className="panel-tag">{t("{count} rows", { count: graph.nodes.length })}</span></header>
      <div className="ontology-table" role="table" aria-label={t("Ontology nodes")}>
        <div className="ontology-table-row ontology-table-head" role="row"><span>{t("Node")}</span><span>{t("Kind")}</span><span>{t("Status")}</span><span>{t("Layer")}</span><span>{t("Evidence")}</span></div>
        <div ref={parent} className="ontology-table-scroll" role="rowgroup">
          <div className="ontology-table-virtual-space" style={{ height: virtual.getTotalSize() }}>
            {virtual.getVirtualItems().map((row) => {
              const node = graph.nodes[row.index]!;
              return <button
                ref={virtual.measureElement}
                data-index={row.index}
                key={node.id}
                type="button"
                role="row"
                style={{ transform: `translateY(${row.start}px)` }}
                className={node.id === selectedNodeId ? "ontology-table-row ontology-table-selected" : "ontology-table-row"}
                onClick={() => onSelect(node.id)}
              >
                <span><strong>{node.label}</strong><small>{node.artifactId}</small></span><code>{node.kind}</code><span><i style={{ background: statusColors[node.status] }} />{t(node.status)}</span><span>{t(node.layer)}</span><span>{node.evidenceCount}</span>
              </button>;
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function mergeGraphPages(pages: OntologyGraph[] | undefined): OntologyGraph | undefined {
  const first = pages?.[0];
  if (!first) return undefined;
  const nodes = new Map<string, OntologyNode>();
  const edges = new Map<string, OntologyEdge>();
  const diagnostics = new Set<string>();
  for (const page of pages) {
    for (const node of page.nodes) nodes.set(node.id, node);
    const missingRequired = page.page.requiredNodeIds.filter((nodeId) => !nodes.has(nodeId));
    if (missingRequired.length) {
      diagnostics.add(`Skipped a graph page whose required prefix nodes were absent: ${missingRequired.slice(0, 5).join(", ")}.`);
      continue;
    }
    for (const edge of page.edges) {
      if (nodes.has(edge.source) && nodes.has(edge.target)) edges.set(edge.id, edge);
      else diagnostics.add(`Deferred relation '${edge.id}' because one of its endpoint nodes is not loaded.`);
    }
    for (const message of page.diagnostics) {
      if (!message.startsWith("Loaded ")) diagnostics.add(message);
    }
  }
  const last = pages.at(-1)!;
  const progressDiagnostic = last.diagnostics.find((message) => message.startsWith("Loaded "));
  if (progressDiagnostic) diagnostics.add(progressDiagnostic);
  return {
    ...first,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    totalNodes: last.totalNodes,
    totalEdges: last.totalEdges,
    truncated: last.page.nextCursor !== null,
    page: {
      ...last.page,
      newNodes: last.page.newNodes,
      loadedNodes: nodes.size,
      loadedEdges: edges.size,
      remainingEdges: Math.max(0, last.totalEdges - edges.size),
      requiredNodeIds: [],
    },
    diagnostics: [...diagnostics],
  };
}

function defaultLayers(view: OntologyView): OntologyLayer[] {
  if (view === "events") return ["canonical", "branch", "possibility"];
  if (view === "provenance") return ["canonical", "branch", "possibility", "proposal", "evidence"];
  return ["canonical", "branch"];
}

function shapeFor(node: OntologyNode): string {
  if (node.kind.includes("event") || node.kind === "world-commit") return "diamond";
  if (node.kind.includes("rule")) return "triangle";
  if (node.kind.includes("location") || node.kind === "source") return "roundRect";
  if (node.kind.includes("proposal") || node.kind === "validation") return "pin";
  if (node.kind === "source-span") return "rect";
  return "circle";
}

function EmptyGraph() {
  const { t } = useI18n();
  return <div className="ontology-empty"><span>◇</span><strong>{t("No nodes match this projection")}</strong><p>{t("Adjust the search, facets, layers, branch, or commit.")}</p></div>;
}

function PageState({ loading = false, title, body, action }: { loading?: boolean; title: string; body: string; action?: React.ReactNode }) {
  return <div className="ontology-page-state">{loading ? <span className="loading-orbit" /> : <span className="ontology-state-mark">◇</span>}<strong>{title}</strong><p>{body}</p>{action}</div>;
}

function InlineLoading() { const { t } = useI18n(); return <div className="ontology-inline-state"><span className="loading-orbit" />{t("Loading exact node detail…")}</div>; }
function OntologyErrorState({ error, retry }: { error: Error; retry: () => void }) {
  const { t } = useI18n();
  const detail = webErrorDetail(error);
  return <PageState title={detail?.code ?? t("Projection failed")} body={error.message} action={<>{detail && <small>{recoveryInstruction(detail, t)}</small>}{canRetrySameRequest(error) && <button onClick={retry}>{t("Retry once")}</button>}</>} />;
}
function InlineError({ error }: { error: Error }) { const { t } = useI18n(); const detail = webErrorDetail(error); return <div className="ontology-inline-error"><strong>{detail?.code ?? error.name}</strong><span>{error.message}</span>{detail && <small>{recoveryInstruction(detail, t)}</small>}</div>; }
function compactJson(value: unknown): string { return JSON.stringify(value); }
function formatValue(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value); }
function shortHash(value: string): string { return value.length > 16 ? `${value.slice(0, 9)}…${value.slice(-5)}` : value; }
function percentage(loaded: number, total: number): number { return total === 0 ? 100 : Math.min(100, Math.round(loaded / total * 100)); }
function yieldToBrowser(): Promise<void> { return new Promise((resolve) => requestAnimationFrame(() => resolve())); }

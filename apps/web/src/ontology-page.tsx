import { GraphChart, type GraphSeriesOption } from "echarts/charts";
import { TooltipComponent, type TooltipComponentOption } from "echarts/components";
import { init as initChart, use as useECharts, type ComposeOption, type ECharts } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import {
  useDeferredValue,
  useEffect,
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

  useEffect(() => () => { stopFullLoad.current = true; }, []);
  useEffect(() => {
    stopFullLoad.current = true;
    setLoadingAll(false);
    setSelectedNodeId(undefined);
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
      relationLimit: 500,
    }, signal),
    enabled: Boolean(selectedNodeId),
  });

  useEffect(() => {
    if (loadedGraph && !loadingAll && selectedNodeId && detail.data?.node.id === selectedNodeId) {
      setCanvasGraph(focusedGraph(loadedGraph, selectedNodeId, detail.data));
    }
  }, [detail.data, loadedGraph, loadingAll, selectedNodeId]);

  const visible = loadedGraph;
  const baseCanvasGraph = canvasGraph?.page.snapshotId === visible?.page.snapshotId ? canvasGraph : visible;
  const interactiveGraph = baseCanvasGraph ? focusedGraph(baseCanvasGraph, selectedNodeId, detail.data) : undefined;
  const selectedNode = interactiveGraph?.nodes.find((node) => node.id === selectedNodeId);

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
              {visible.nodes.length ? <GraphCanvas
                graph={interactiveGraph ?? visible}
                view={view}
                selectedNodeId={selectedNodeId}
                onSelect={setSelectedNodeId}
                refreshing={graph.isFetching}
                focusLoading={Boolean(selectedNodeId) && detail.isFetching}
                neighborhoodTruncated={Boolean(detail.data && detail.data.node.id === selectedNodeId && detail.data.relationPage.truncated)}
                onRefresh={() => {
                  void graph.refetch();
                  if (selectedNodeId) void detail.refetch();
                }}
              /> : <EmptyGraph />}
            </section>
            <NodeInspector node={selectedNode} detail={detail} onClose={() => setSelectedNodeId(undefined)} />
          </div>
          <OntologyTable graph={visible} selectedNodeId={selectedNodeId} onSelect={setSelectedNodeId} />
        </>
      ) : null}
    </>
  );
}

function focusedGraph(
  graph: OntologyGraph,
  selectedNodeId: string | undefined,
  detail: Awaited<ReturnType<typeof fetchOntologyNode>> | undefined,
): OntologyGraph {
  if (!selectedNodeId || detail?.node.id !== selectedNodeId) return graph;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  nodes.set(detail.node.id, detail.node);
  for (const node of detail.relatedNodes) nodes.set(node.id, node);
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]));
  for (const edge of [...detail.incoming, ...detail.outgoing]) edges.set(edge.id, edge);
  return { ...graph, nodes: [...nodes.values()], edges: [...edges.values()] };
}

function GraphCanvas({
  graph,
  view,
  selectedNodeId,
  onSelect,
  refreshing,
  focusLoading,
  neighborhoodTruncated,
  onRefresh,
}: {
  graph: OntologyGraph;
  view: OntologyView;
  selectedNodeId?: string;
  onSelect: (nodeId?: string) => void;
  refreshing: boolean;
  focusLoading: boolean;
  neighborhoodTruncated: boolean;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const option = useRef<GraphChartOption | undefined>(undefined);
  const onSelectRef = useRef(onSelect);
  const geometryKeyRef = useRef("");
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [viewport, setViewport] = useState({ width: 960, height: 600 });
  const [showAllLabels, setShowAllLabels] = useState(false);
  onSelectRef.current = onSelect;
  const rendered = useMemo(
    () => renderableGraph(graph, selectedNodeId),
    [graph, selectedNodeId],
  );
  const labels = useMemo(
    () => graphLabelPlan(rendered, selectedNodeId, viewport, showAllLabels),
    [rendered, selectedNodeId, showAllLabels, viewport],
  );
  const geometryKey = useMemo(() => rendered.focused
    ? `focus:${selectedNodeId ?? ""}:${layoutRevision}:${rendered.nodes.map((node) => node.id).join("\u001f")}:${rendered.edges.map((edge) => edge.id).join("\u001f")}`
    : `overview:${layoutRevision}`,
  [layoutRevision, rendered, selectedNodeId]);

  useEffect(() => setShowAllLabels(false), [selectedNodeId]);

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
    instance.getZr().on("click", (event) => {
      if (!event.target) onSelectRef.current(undefined);
    });
    const observer = new ResizeObserver(([entry]) => {
      instance.resize();
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      setViewport((current) => current.width === width && current.height === height ? current : { width, height });
    });
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      if (chart.current === instance) chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chart.current) return;
    option.current = graphOption(rendered, view, selectedNodeId, layoutRevision, labels);
    const resetViewport = geometryKeyRef.current !== geometryKey;
    if (resetViewport) chart.current.clear();
    chart.current.setOption(option.current, { notMerge: true, lazyUpdate: !resetViewport });
    if (resetViewport) chart.current.resize();
    geometryKeyRef.current = geometryKey;
  }, [geometryKey, labels, layoutRevision, rendered, selectedNodeId, view]);

  const fit = () => {
    if (!chart.current || !option.current) return;
    chart.current.clear();
    chart.current.setOption(option.current, { notMerge: true, lazyUpdate: false });
    chart.current.resize();
  };

  return <div className="ontology-canvas-shell">
    <div className="ontology-canvas-actions" role="toolbar" aria-label={t("Canvas controls")}>
      {rendered.focused && labels.dense && <button
        type="button"
        className={showAllLabels ? "ontology-canvas-action-active" : undefined}
        aria-pressed={showAllLabels}
        onClick={() => setShowAllLabels((current) => !current)}
      >{showAllLabels ? t("Use smart labels") : t("Show all labels")}</button>}
      {rendered.focused && <button type="button" onClick={() => onSelect(undefined)}>{t("Clear focus")}</button>}
      <button type="button" onClick={fit}>{t("Fit")}</button>
      <button type="button" onClick={() => setLayoutRevision((current) => current + 1)}>{t("Re-layout")}</button>
      <button type="button" onClick={onRefresh} disabled={refreshing}>{refreshing ? t("Refreshing…") : t("Refresh")}</button>
    </div>
    <div
      ref={container}
      className="ontology-canvas"
      role="img"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Escape" && rendered.focused) onSelect(undefined);
      }}
      aria-label={t("{view} ontology graph with {nodes} nodes and {edges} edges", { view: t(view), nodes: rendered.nodes.length, edges: rendered.edges.length })}
    />
    {rendered.focused && <div className="ontology-focus-note" aria-live="polite">
      <strong>{t("Focused neighborhood")}</strong>
      <span>{t("{nodes} related entities · {edges} relationships", { nodes: Math.max(0, rendered.nodes.length - 1), edges: rendered.edges.length })}</span>
      {focusLoading && <small>{t("Loading the complete one-hop neighborhood…")}</small>}
      {!focusLoading && labels.dense && !showAllLabels && <small>{t("Labels are distributed for readability: {nodes}/{totalNodes} entities · {edges}/{totalEdges} relationships.", {
        nodes: labels.nodeIds.size,
        totalNodes: rendered.nodes.length,
        edges: labels.edgeIds.size,
        totalEdges: rendered.edges.length,
      })}</small>}
      {neighborhoodTruncated && <small>{t("This entity has more than 500 incoming or outgoing relationships; load the complete dataset to resolve the remainder.")}</small>}
    </div>}
    {rendered.sampled && <div className="ontology-render-note">{t("Canvas view sampled {nodes} high-connectivity nodes and {edges} relations; the virtual table retains all {total} loaded nodes.", { nodes: rendered.nodes.length, edges: rendered.edges.length, total: graph.nodes.length })}</div>}
  </div>;
}

type RenderableGraph = {
  nodes: OntologyNode[];
  edges: OntologyEdge[];
  degree: Map<string, number>;
  sampled: boolean;
  focused: boolean;
};

function renderableGraph(graph: OntologyGraph, selectedNodeId?: string): RenderableGraph {
  const degree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  if (selectedNodeId && degree.has(selectedNodeId)) {
    const focusedIds = new Set([selectedNodeId]);
    const edges = graph.edges.filter((edge) => {
      const related = edge.source === selectedNodeId || edge.target === selectedNodeId;
      if (related) {
        focusedIds.add(edge.source);
        focusedIds.add(edge.target);
      }
      return related;
    });
    return {
      nodes: graph.nodes.filter((node) => focusedIds.has(node.id)),
      edges,
      degree,
      sampled: false,
      focused: true,
    };
  }
  const sampled = graph.nodes.length > GRAPH_RENDER_NODE_LIMIT || graph.edges.length > GRAPH_RENDER_EDGE_LIMIT;
  if (!sampled) return { nodes: graph.nodes, edges: graph.edges, degree, sampled: false, focused: false };

  const included = new Set<string>();
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
      return (degree.get(right.source) ?? 0) + (degree.get(right.target) ?? 0)
          - (degree.get(left.source) ?? 0) - (degree.get(left.target) ?? 0)
        || left.id.localeCompare(right.id);
    })
    .slice(0, GRAPH_RENDER_EDGE_LIMIT);
  return { nodes, edges, degree, sampled: true, focused: false };
}

type GraphLabelPlan = {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
  dense: boolean;
};

function graphLabelPlan(
  graph: RenderableGraph,
  selectedNodeId: string | undefined,
  viewport: { width: number; height: number },
  showAll: boolean,
): GraphLabelPlan {
  const area = Math.max(1, viewport.width * viewport.height);
  const nodeCapacity = Math.max(18, Math.floor(area / 7_000));
  const edgeCapacity = Math.max(14, Math.floor(area / 8_500));
  if (!graph.focused) {
    const visible = graph.nodes.length <= Math.min(90, nodeCapacity)
      ? graph.nodes
      : evenlySample(graph.nodes, Math.min(nodeCapacity, 42));
    return { nodeIds: new Set(visible.map((node) => node.id)), edgeIds: new Set(), dense: false };
  }

  const dense = graph.nodes.length > nodeCapacity || graph.edges.length > edgeCapacity;
  if (showAll || !dense) {
    return {
      nodeIds: new Set(graph.nodes.map((node) => node.id)),
      edgeIds: new Set(graph.edges.map((edge) => edge.id)),
      dense,
    };
  }
  const neighbors = graph.nodes.filter((node) => node.id !== selectedNodeId);
  const sampledNodes = evenlySample(neighbors, Math.max(0, nodeCapacity - (selectedNodeId ? 1 : 0)));
  return {
    nodeIds: new Set([...(selectedNodeId ? [selectedNodeId] : []), ...sampledNodes.map((node) => node.id)]),
    edgeIds: new Set(evenlySample(graph.edges, edgeCapacity).map((edge) => edge.id)),
    dense,
  };
}

function evenlySample<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  if (limit <= 0) return [];
  return Array.from({ length: limit }, (_, index) => values[Math.floor(index * values.length / limit)]!);
}

function graphOption(
  graph: RenderableGraph,
  view: OntologyView,
  selectedNodeId: string | undefined,
  layoutRevision: number,
  labels: GraphLabelPlan,
): GraphChartOption {
  const positions = graphPositions(graph.nodes, view, layoutRevision, graph.focused ? selectedNodeId : undefined);
  const curves = relationCurves(graph.edges);
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
      left: graph.focused ? 58 : 24,
      right: graph.focused ? 58 : 24,
      top: graph.focused ? 72 : 24,
      bottom: graph.focused ? 76 : 24,
      selectedMode: false,
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
          symbolSize: selected ? 34 : graph.focused ? 23 : Math.min(22, 10 + Math.log2((graph.degree.get(node.id) ?? 0) + 1) * 3),
          cursor: "pointer",
          itemStyle: {
            color: selected ? "#f2ff9b" : graph.focused ? "#73c9e8" : statusColors[node.status],
            borderColor: selected ? "#ffffff" : graph.focused ? statusColors[node.status] : "#10110f",
            borderWidth: selected ? 4 : graph.focused ? 2 : 1,
            shadowBlur: graph.focused ? selected ? 18 : 9 : 0,
            shadowColor: selected ? "#d6ff72" : "#5bb9dc",
          },
          label: {
            show: labels.nodeIds.has(node.id),
            formatter: node.label,
            position: "bottom",
            distance: selected ? 8 : 6,
            color: selected ? "#fbffd8" : graph.focused ? "#e4f6ff" : "#d7d8d1",
            fontFamily: "Manrope",
            fontSize: selected ? 11 : graph.focused ? 9 : 8,
            fontWeight: selected ? 700 : 600,
            width: graph.focused ? 150 : 120,
            overflow: "truncate",
            backgroundColor: graph.focused ? "#101511dc" : "transparent",
            borderRadius: 3,
            padding: graph.focused ? [3, 5] : 0,
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
          color: graph.focused ? "#8bd3f0" : statusColors[edge.status],
          width: graph.focused ? 2.2 : 0.8,
          opacity: graph.focused ? 0.92 : 0.32,
          curveness: graph.focused ? curves.get(edge.id) ?? 0 : graph.edges.length < 500 ? 0.06 : 0,
          shadowBlur: graph.focused ? 4 : 0,
          shadowColor: "#4a9fbe",
        },
        label: {
          show: graph.focused && labels.edgeIds.has(edge.id),
          formatter: edge.label,
          color: "#eefaff",
          fontFamily: "DM Mono",
          fontSize: 8,
          backgroundColor: "#121a18ee",
          borderColor: "#466878",
          borderWidth: 1,
          borderRadius: 3,
          padding: [3, 5],
        },
        emphasis: {
          focus: "adjacency" as const,
          label: {
            show: true,
            formatter: edge.label,
            color: "#ffffff",
            fontSize: 9,
            backgroundColor: "#17211eff",
            padding: [4, 6],
          },
          lineStyle: { width: 3, opacity: 1 },
        },
      })),
      lineStyle: { opacity: 0.35 },
      label: { show: false },
      edgeLabel: { show: false },
      emphasis: { focus: "adjacency", lineStyle: { width: 3, opacity: 1 } },
    }],
  };
}

function graphPositions(
  nodes: readonly OntologyNode[],
  view: OntologyView,
  revision: number,
  selectedNodeId?: string,
): Map<string, { x: number; y: number }> {
  if (selectedNodeId && nodes.some((node) => node.id === selectedNodeId)) {
    return focusedGraphPositions(nodes, selectedNodeId, revision);
  }
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

function focusedGraphPositions(
  nodes: readonly OntologyNode[],
  selectedNodeId: string,
  revision: number,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>([[selectedNodeId, { x: 0, y: 0 }]]);
  const neighbors = nodes
    .filter((node) => node.id !== selectedNodeId)
    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  let offset = 0;
  let ring = 0;
  const rotation = (hashNumber(`${selectedNodeId}:${revision}`) % 360) * Math.PI / 180;
  while (offset < neighbors.length) {
    const radius = 145 + ring * 92;
    const capacity = Math.max(10, Math.floor(2 * Math.PI * radius / 68));
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

function relationCurves(edges: readonly OntologyEdge[]): Map<string, number> {
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

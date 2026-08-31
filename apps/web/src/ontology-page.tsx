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
import {
  buildRenderableGraph,
  familyCounts,
  familyVisuals,
  graphLabelBox,
  graphPositions,
  nodeColor,
  nodeFamily,
  nodeShape,
  relationCurves,
  statusColors,
  type EdgeDensity,
  type Point,
  type RenderableGraph,
} from "./ontology-graph";
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
  const [focusedNodeId, setFocusedNodeId] = useState<string>();
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
    setFocusedNodeId(undefined);
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
    setFocusedNodeId(undefined);
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

  const visible = loadedGraph;
  const baseCanvasGraph = canvasGraph?.page.snapshotId === visible?.page.snapshotId ? canvasGraph : visible;
  const interactiveGraph = baseCanvasGraph ? focusedGraph(baseCanvasGraph, focusedNodeId, detail.data) : undefined;
  const selectedDetailNode = detail.data?.node;
  const selectedNode = selectedDetailNode?.id === selectedNodeId
    ? selectedDetailNode
    : interactiveGraph?.nodes.find((node) => node.id === selectedNodeId);
  const actionableDiagnostics = visible?.diagnostics.filter((message) => !message.startsWith("Loaded ")) ?? [];
  const openNode = (nodeId?: string) => {
    setSelectedNodeId(nodeId);
    setFocusedNodeId(nodeId);
  };

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
      <div className="ontology-heading ontology-heading-compact">
        <div>
          <Link className="ontology-back-link" to="/novels/$sourceId" params={{ sourceId }}>← {novel.title}</Link>
          <div className="ontology-title-row"><div><span className="eyebrow">{t("World graph")}</span><h1>{t(meta.label)}</h1></div>
            <span className={branchId ? "truth-badge truth-badge-branch" : "truth-badge"}>{branchId ? t("Committed branch scope") : t("Compiled source scope")}</span>
          </div>
          <p>{t(meta.description)}</p>
        </div>
        <div className="ontology-heading-actions">
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

      <section className="ontology-command-bar" aria-label={t("Graph scope and filters")}>
        <div className="ontology-command-grid">
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
          <label className="ontology-search"><span>{t("Find in graph")}</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("Name, ID, type…")} /></label>
          <label><span>{t("Type")}</span><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">{t("All types")}</option>{Object.keys(graph.data?.pages[0]?.facets.kinds ?? {}).map((value) => <option key={value} value={value}>{t(humanize(value))}</option>)}</select></label>
          <label><span>{t("State")}</span><select value={status} onChange={(event) => setStatus(event.target.value as OntologyStatus | "")}><option value="">{t("All states")}</option>{Object.keys(graph.data?.pages[0]?.facets.statuses ?? {}).map((value) => <option key={value} value={value}>{t(value)}</option>)}</select></label>
        </div>
        <div className="ontology-command-secondary">
          <span className="ontology-layer-label">{t("Truth layers")}</span>
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
          {(view === "events" || view === "provenance") && branchId && <label className="ontology-future-toggle ontology-future-toggle-compact">
            <input type="checkbox" checked={includeCanonicalFuture} onChange={(event) => {
              setIncludeCanonicalFuture(event.target.checked);
              onScopeChangeRef.current?.({ branchId, ...(effectiveCommit ? { atCommit: effectiveCommit } : {}), ...(event.target.checked ? { includeCanonicalFuture: true } : {}) });
            }} />
            <span>{t("Show future canon as possibility")}</span>
          </label>}
          {(search || kind || status) && <button className="ontology-clear-filters" type="button" onClick={() => { setSearch(""); setKind(""); setStatus(""); }}>{t("Clear filters")}</button>}
          <span className="ontology-count">{t("{nodes} entities · {edges} relations", { nodes: visible?.nodes.length ?? 0, edges: visible?.edges.length ?? 0 })}</span>
        </div>
      </section>

      {instance.isError && <InlineError error={instance.error} />}
      {graph.isPending ? <PageState loading title={t("Projecting the ontology")} body={t("Resolving source-scoped artifacts and temporal validity…")} /> : graph.isError ? <OntologyErrorState error={graph.error} retry={() => void graph.refetch()} /> : graph.data && visible ? (
        <>
          {actionableDiagnostics.length > 0 && <div className="ontology-diagnostics">{actionableDiagnostics.map((message) => <p key={message}>{message}</p>)}</div>}
          <div className="ontology-workbench">
            <section className="ontology-canvas-panel">
              <header>
                <div className="ontology-canvas-heading">
                  {focusedNodeId && <button type="button" className="ontology-graph-back" onClick={() => setFocusedNodeId(undefined)}>← {t("Back to full graph")}</button>}
                  <span className="eyebrow">{focusedNodeId ? t("Relationship focus") : t("World graph")}</span>
                  <strong>{focusedNodeId ? selectedNode?.label ?? t("Focused neighborhood") : t("Drag to arrange · click an entity to explore")}</strong>
                </div>
                <div className="ontology-legend" aria-label={t("Entity type colors")}>{familyCounts(visible.nodes).map(({ family, count }) => <span key={family}><i style={{ background: familyVisuals[family].color }} />{t(familyVisuals[family].label)}<small>{count}</small></span>)}</div>
              </header>
              {visible.nodes.length ? <GraphCanvas
                graph={interactiveGraph ?? visible}
                view={view}
                selectedNodeId={selectedNodeId}
                focusNodeId={focusedNodeId}
                onSelect={openNode}
                onFocus={(nodeId) => { setSelectedNodeId(nodeId); setFocusedNodeId(nodeId); }}
                onClearFocus={() => setFocusedNodeId(undefined)}
                refreshing={graph.isFetching}
                focusLoading={Boolean(focusedNodeId) && focusedNodeId === selectedNodeId && detail.isFetching}
                neighborhoodTruncated={Boolean(detail.data && detail.data.node.id === focusedNodeId && detail.data.relationPage.truncated)}
                onRefresh={() => {
                  void graph.refetch();
                  if (selectedNodeId) void detail.refetch();
                }}
              /> : <EmptyGraph />}
              <TopologyLoadBar
                graph={visible}
                hasNextPage={Boolean(graph.hasNextPage)}
                fetchingNext={graph.isFetchingNextPage}
                loadingAll={loadingAll}
                onNext={() => void graph.fetchNextPage()}
                onAll={() => void loadAllPages()}
                onStop={() => { stopFullLoad.current = true; }}
              />
            </section>
            <NodeInspector
              graph={visible}
              node={selectedNode}
              detail={detail}
              focused={Boolean(selectedNode && focusedNodeId === selectedNode.id)}
              onSelect={(nodeId) => openNode(nodeId)}
              onFocus={(nodeId) => { setSelectedNodeId(nodeId); setFocusedNodeId(nodeId); }}
              onClose={() => { setSelectedNodeId(undefined); setFocusedNodeId(undefined); }}
            />
          </div>
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
  focusNodeId,
  onSelect,
  onFocus,
  onClearFocus,
  refreshing,
  focusLoading,
  neighborhoodTruncated,
  onRefresh,
}: {
  graph: OntologyGraph;
  view: OntologyView;
  selectedNodeId?: string;
  focusNodeId?: string;
  onSelect: (nodeId?: string) => void;
  onFocus: (nodeId: string) => void;
  onClearFocus: () => void;
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
  const onFocusRef = useRef(onFocus);
  const geometryKeyRef = useRef("");
  const manualPositions = useRef(new Map<string, Point>());
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [viewport, setViewport] = useState({ width: 960, height: 600 });
  const [showAllLabels, setShowAllLabels] = useState(false);
  const [density, setDensity] = useState<EdgeDensity>("balanced");
  onSelectRef.current = onSelect;
  onFocusRef.current = onFocus;
  const rendered = useMemo(
    () => buildRenderableGraph(graph, { focusNodeId, density }),
    [density, focusNodeId, graph],
  );
  const labels = useMemo(
    () => graphLabelPlan(rendered, viewport, showAllLabels),
    [rendered, showAllLabels, viewport],
  );
  const geometryKey = useMemo(
    () => `${focusNodeId ? `focus:${focusNodeId}` : `overview:${density}`}:${layoutRevision}:${rendered.nodes.map((node) => node.id).join("\u001f")}:${rendered.edges.map((edge) => edge.id).join("\u001f")}`,
    [density, focusNodeId, layoutRevision, rendered.edges, rendered.nodes],
  );

  useEffect(() => setShowAllLabels(false), [focusNodeId]);

  useEffect(() => {
    if (!container.current) return;
    const instance = initChart(container.current, undefined, {
      renderer: "canvas",
      useDirtyRect: true,
    });
    chart.current = instance;
    instance.on("click", (event) => {
      const nodeId = chartEventNodeId(event);
      if (event.dataType === "node" && nodeId) onSelectRef.current(nodeId);
    });
    instance.on("dblclick", (event) => {
      const nodeId = chartEventNodeId(event);
      if (event.dataType === "node" && nodeId) onFocusRef.current(nodeId);
    });
    instance.on("dragend", (event) => {
      const nodeId = chartEventNodeId(event);
      const dataIndex = Array.isArray(event.dataIndex) ? event.dataIndex[0] : event.dataIndex;
      if (!nodeId || typeof dataIndex !== "number") return;
      const runtime = instance as unknown as { getModel: () => { getSeriesByIndex: (index: number) => unknown } };
      const series = runtime.getModel().getSeriesByIndex(0) as {
        getData: () => { getItemLayout: (index: number) => unknown };
      };
      const layout = series.getData().getItemLayout(dataIndex);
      if (Array.isArray(layout) && typeof layout[0] === "number" && typeof layout[1] === "number") {
        manualPositions.current.set(nodeId, { x: layout[0], y: layout[1] });
      }
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
    const resetViewport = geometryKeyRef.current !== geometryKey;
    if (resetViewport) manualPositions.current.clear();
    option.current = graphOption(rendered, view, layoutRevision, labels, manualPositions.current, t);
    if (resetViewport) chart.current.clear();
    chart.current.setOption(option.current, { notMerge: true, lazyUpdate: !resetViewport });
    if (resetViewport) chart.current.resize();
    geometryKeyRef.current = geometryKey;
  }, [geometryKey, labels, layoutRevision, rendered, t, view]);

  useEffect(() => {
    if (!chart.current) return;
    chart.current.dispatchAction({ type: "downplay", seriesIndex: 0 });
    const dataIndex = rendered.nodes.findIndex((node) => node.id === selectedNodeId);
    if (dataIndex >= 0) chart.current.dispatchAction({ type: "highlight", seriesIndex: 0, dataIndex });
  }, [rendered.nodes, selectedNodeId]);

  const fit = () => {
    if (!chart.current || !option.current) return;
    chart.current.clear();
    chart.current.setOption(option.current, { notMerge: true, lazyUpdate: false });
    chart.current.resize();
    const dataIndex = rendered.nodes.findIndex((node) => node.id === selectedNodeId);
    if (dataIndex >= 0) chart.current.dispatchAction({ type: "highlight", seriesIndex: 0, dataIndex });
  };

  const zoom = (scale: number) => {
    if (!chart.current) return;
    chart.current.dispatchAction({
      type: "graphRoam",
      seriesIndex: 0,
      zoom: scale,
      originX: viewport.width / 2,
      originY: viewport.height / 2,
    } as never);
  };

  const relayout = () => {
    manualPositions.current.clear();
    setLayoutRevision((current) => current + 1);
  };

  return <div className="ontology-canvas-shell">
    <div className="ontology-canvas-actions" role="toolbar" aria-label={t("Canvas controls")}>
      {!rendered.focused && <div className="ontology-density-control" role="group" aria-label={t("Relationship detail")}>
        {(["essential", "balanced", "complete"] as const).map((value) => <button
          key={value}
          type="button"
          className={density === value ? "ontology-canvas-action-active" : undefined}
          aria-pressed={density === value}
          onClick={() => setDensity(value)}
        >{t(value === "essential" ? "Essential" : value === "balanced" ? "Balanced" : "All relations")}</button>)}
      </div>}
      <button
        type="button"
        className={showAllLabels ? "ontology-canvas-action-active" : undefined}
        aria-pressed={showAllLabels}
        onClick={() => setShowAllLabels((current) => !current)}
      >{showAllLabels ? t("Smart labels") : t("All labels")}</button>
      {!rendered.focused && selectedNodeId && <button type="button" className="ontology-focus-action" onClick={() => onFocus(selectedNodeId)}>{t("Focus selection")}</button>}
      {rendered.focused && <button type="button" className="ontology-focus-action" onClick={onClearFocus}>← {t("Overview")}</button>}
      <button type="button" aria-label={t("Re-layout graph")} title={t("Re-layout graph")} onClick={relayout}>↻</button>
      <button type="button" aria-label={t("Refresh graph")} title={t("Refresh graph")} onClick={onRefresh} disabled={refreshing}>{refreshing ? "…" : "⟳"}</button>
    </div>
    <div className="ontology-zoom-actions" role="toolbar" aria-label={t("Zoom controls")}>
      <button type="button" aria-label={t("Zoom in")} title={t("Zoom in")} onClick={() => zoom(1.25)}>＋</button>
      <button type="button" aria-label={t("Zoom out")} title={t("Zoom out")} onClick={() => zoom(.8)}>−</button>
      <button type="button" aria-label={t("Fit graph")} title={t("Fit graph")} onClick={fit}>⌗</button>
    </div>
    <div
      ref={container}
      className="ontology-canvas"
      role="img"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Escape" && rendered.focused) onClearFocus();
      }}
      aria-label={t("{view} ontology graph with {nodes} nodes and {edges} edges", { view: t(view), nodes: rendered.nodes.length, edges: rendered.edges.length })}
    />
    {rendered.focused && <div className="ontology-focus-note" aria-live="polite">
      <strong>{t("Focused neighborhood")}</strong>
      <span>{t("{nodes} related entities · {edges} relationships", { nodes: Math.max(0, rendered.nodes.length - 1), edges: rendered.edges.length })}</span>
      {focusLoading && <small>{t("Loading the complete one-hop neighborhood…")}</small>}
      {!focusLoading && labels.dense && !showAllLabels && <small>{t("Labels are distributed for readability: {nodes}/{totalNodes} entity names. Hover a node or edge for exact details.", {
        nodes: labels.nodeIds.size,
        totalNodes: rendered.nodes.length,
      })}</small>}
      {neighborhoodTruncated && <small>{t("This entity has more than 500 incoming or outgoing relationships; load the complete dataset to resolve the remainder.")}</small>}
    </div>}
    {!rendered.focused && (rendered.hiddenNodeCount > 0 || rendered.hiddenEdgeCount > 0) && <div className="ontology-render-note">{t("Showing {nodes}/{totalNodes} entities · {edges}/{totalEdges} relations", {
      nodes: rendered.nodes.length,
      totalNodes: rendered.sourceNodeCount,
      edges: rendered.edges.length,
      totalEdges: rendered.sourceEdgeCount,
    })}</div>}
    <div className="ontology-canvas-hint">{t("Drag nodes · scroll to zoom · double-click for relationships")}</div>
  </div>;
}

type GraphLabelPlan = {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
  dense: boolean;
};

function graphLabelPlan(
  graph: RenderableGraph,
  viewport: { width: number; height: number },
  showAll: boolean,
): GraphLabelPlan {
  const area = Math.max(1, viewport.width * viewport.height);
  const nodeCapacity = graph.focused
    ? Math.min(36, Math.max(14, Math.floor(area / 26_000)))
    : Math.min(34, Math.max(12, Math.floor(area / 22_000)));
  const edgeCapacity = Math.min(40, Math.max(10, Math.floor(area / 18_000)));
  const dense = graph.nodes.length > nodeCapacity || graph.edges.length > edgeCapacity;
  if (showAll || !dense) {
    return {
      nodeIds: new Set(graph.nodes.map((node) => node.id)),
      edgeIds: new Set(graph.edges.map((edge) => edge.id)),
      dense,
    };
  }
  const ranked = [...graph.nodes].sort((left, right) => {
    const leftFocus = left.id === graph.focusNodeId ? 1 : 0;
    const rightFocus = right.id === graph.focusNodeId ? 1 : 0;
    return rightFocus - leftFocus
      || (graph.degree.get(right.id) ?? 0) - (graph.degree.get(left.id) ?? 0)
      || left.label.localeCompare(right.label);
  });
  const visibleNodes = typeBalancedPrefix(ranked, nodeCapacity);
  return {
    nodeIds: new Set(visibleNodes.map((node) => node.id)),
    edgeIds: new Set(),
    dense,
  };
}

function typeBalancedPrefix(nodes: readonly OntologyNode[], limit: number): OntologyNode[] {
  if (nodes.length <= limit) return [...nodes];
  const result: OntologyNode[] = [];
  const selected = new Set<string>();
  for (const family of new Set(nodes.map(nodeFamily))) {
    const node = nodes.find((candidate) => nodeFamily(candidate) === family);
    if (node && result.length < limit) { result.push(node); selected.add(node.id); }
  }
  for (const node of nodes) {
    if (result.length >= limit) break;
    if (!selected.has(node.id)) result.push(node);
  }
  return result;
}

function graphOption(
  graph: RenderableGraph,
  view: OntologyView,
  layoutRevision: number,
  labels: GraphLabelPlan,
  manualPositions: ReadonlyMap<string, Point>,
  translate: (message: string) => string,
): GraphChartOption {
  const positions = graphPositions(graph, view, layoutRevision);
  for (const [id, position] of manualPositions) if (positions.has(id)) positions.set(id, position);
  const curves = relationCurves(graph.edges);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  return {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      confine: true,
      backgroundColor: "#111815f2",
      borderColor: "#43544c",
      padding: 10,
      formatter: (params) => {
        const item = Array.isArray(params) ? params[0] : params;
        if (!item) return "";
        const data = item.data as { id?: string } | undefined;
        const id = data?.id;
        if (!id) return "";
        if (item.dataType === "edge") {
          const edge = edgeById.get(id);
          return edge ? `${tooltipText(edge.label)}\n${tooltipText(translate(humanize(edge.kind)))} · ${tooltipText(translate(edge.status))}` : "";
        }
        const node = nodeById.get(id);
        return node ? `${tooltipText(node.label)}\n${tooltipText(translate(humanize(node.kind)))} · ${tooltipText(translate(node.status))}` : "";
      },
      textStyle: {
        color: "#d7e1da",
        fontFamily: "DM Mono",
        fontSize: 10,
      },
    },
    series: [{
      id: "ontology-graph",
      type: "graph",
      layout: "none",
      coordinateSystem: undefined,
      animation: false,
      progressive: 400,
      progressiveThreshold: 700,
      roam: true,
      preserveAspect: "contain",
      scaleLimit: { min: 0.12, max: 8 },
      left: graph.focused ? 72 : 48,
      right: graph.focused ? 72 : 48,
      top: graph.focused ? 84 : 56,
      bottom: graph.focused ? 86 : 58,
      selectedMode: false,
      edgeSymbol: ["none", graph.focused && graph.edges.length <= 320 ? "arrow" : "none"],
      edgeSymbolSize: 6,
      data: graph.nodes.map((node) => {
        const position = positions.get(node.id) ?? { x: 0, y: 0 };
        const focus = node.id === graph.focusNodeId;
        const opacity = node.status === "rejected" ? .42 : node.status === "inactive" ? .62 : 1;
        const fontSize = focus ? 12 : graph.focused ? 10 : 9;
        const labelBox = graphLabelBox(node.label, fontSize, graph.focused ? 168 : 132);
        return {
          id: node.id,
          name: node.label,
          value: graph.degree.get(node.id) ?? 0,
          x: position.x,
          y: position.y,
          symbol: nodeShape(node),
          symbolSize: focus ? 38 : graph.focused ? 24 : Math.min(29, 14 + Math.log2((graph.degree.get(node.id) ?? 0) + 1) * 3.2),
          draggable: true,
          cursor: "grab",
          itemStyle: {
            color: nodeColor(node),
            opacity,
            borderColor: statusColors[node.status],
          borderWidth: focus ? 4 : 1.35,
          shadowBlur: focus ? 22 : graph.focused ? 7 : (graph.degree.get(node.id) ?? 0) > 8 ? 4 : 0,
            shadowColor: focus ? statusColors[node.status] : `${nodeColor(node)}66`,
          },
          label: {
            show: labels.nodeIds.has(node.id),
            formatter: node.label,
            position: "bottom",
            distance: focus ? 10 : 7,
            color: focus ? "#ffffff" : "#dce6df",
            fontFamily: "Manrope",
            fontSize,
            fontWeight: focus ? 750 : 650,
            width: labelBox.width,
            height: labelBox.height,
            lineHeight: labelBox.lineHeight,
            overflow: "break",
            lineOverflow: "truncate",
            ellipsis: "…",
            backgroundColor: "#101713e8",
            borderColor: focus ? statusColors[node.status] : "transparent",
            borderWidth: focus ? 1 : 0,
            borderRadius: 5,
            padding: [3, 6],
          },
          emphasis: {
            focus: "adjacency",
            scale: 1.18,
            label: {
              show: true,
              formatter: node.label,
              color: "#ffffff",
              fontSize: 11,
              width: graphLabelBox(node.label, 11, 184).width,
              height: graphLabelBox(node.label, 11, 184).height,
              lineHeight: graphLabelBox(node.label, 11, 184).lineHeight,
              overflow: "break",
              lineOverflow: "truncate",
              ellipsis: "…",
              backgroundColor: "#111a16f2",
              padding: [4, 7],
              borderRadius: 5,
            },
            itemStyle: { borderColor: "#ffffff", borderWidth: 3, opacity: 1, shadowBlur: 18, shadowColor: `${nodeColor(node)}bb` },
          },
          blur: { itemStyle: { opacity: .12 }, label: { show: false } },
        };
      }),
      links: graph.edges.map((edge) => {
        const edgeBox = graphLabelBox(edge.label, 8, 124);
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          value: edge.evidenceCount,
          lineStyle: {
            color: statusColors[edge.status],
            width: graph.focused ? 2.1 : Math.min(.95, .5 + edge.evidenceCount * .035),
            opacity: graph.focused ? .84 : .16,
            type: edge.status === "possibility" || edge.status === "proposal" || edge.status === "contested" ? "dashed" : "solid",
            curveness: curves.get(edge.id) ?? 0,
            shadowBlur: graph.focused ? 3 : 0,
            shadowColor: statusColors[edge.status],
          },
          label: {
            show: graph.focused && labels.edgeIds.has(edge.id),
            formatter: edge.label,
            color: "#f1f8f3",
            fontFamily: "DM Mono",
            fontSize: 8,
            width: edgeBox.width,
            height: edgeBox.height,
            lineHeight: edgeBox.lineHeight,
            overflow: "break" as const,
            lineOverflow: "truncate" as const,
            ellipsis: "…",
            backgroundColor: "#111916f2",
            borderColor: statusColors[edge.status],
            borderWidth: 1,
            borderRadius: 3,
            padding: [3, 5],
          },
          emphasis: {
            focus: "adjacency" as const,
            label: {
              show: !labels.dense && graph.edges.length <= 24,
              formatter: edge.label,
              color: "#ffffff",
              fontSize: 9,
              width: graphLabelBox(edge.label, 9, 148).width,
              height: graphLabelBox(edge.label, 9, 148).height,
              lineHeight: graphLabelBox(edge.label, 9, 148).lineHeight,
              overflow: "break" as const,
              lineOverflow: "truncate" as const,
              ellipsis: "…",
              backgroundColor: "#17211eff",
              padding: [4, 6],
            },
            lineStyle: { width: 3, opacity: 1 },
          },
          blur: { lineStyle: { opacity: .035 }, label: { show: false } },
        };
      }),
      lineStyle: { opacity: 0.35 },
      label: { show: false },
      edgeLabel: { show: false },
      emphasis: { focus: "adjacency", lineStyle: { width: 3, opacity: 1 } },
    }],
  };
}

function chartEventNodeId(event: { data?: unknown }): string | undefined {
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return undefined;
  const id = (event.data as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function tooltipText(value: string): string { return value.replaceAll("{", "(").replaceAll("}", ")"); }

function NodeInspector({
  graph,
  node,
  detail,
  focused,
  onSelect,
  onFocus,
  onClose,
}: {
  graph: OntologyGraph;
  node?: OntologyNode;
  detail: ReturnType<typeof useQuery<Awaited<ReturnType<typeof fetchOntologyNode>>, Error>>;
  focused: boolean;
  onSelect: (nodeId: string) => void;
  onFocus: (nodeId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const relatedLabels = new Map(detail.data?.relatedNodes.map((item) => [item.id, item.label]) ?? []);
  return (
    <aside className="ontology-inspector">
      <header>
        <div><span className="eyebrow">{node ? t("Entity detail") : t("Entity browser")}</span><strong>{node?.label ?? t("Everything in this graph")}</strong></div>
        {node && <button type="button" aria-label={t("Close inspector")} onClick={onClose}>×</button>}
      </header>
      {!node ? <OntologyNodeBrowser graph={graph} onSelect={onSelect} /> : (
        <div className="ontology-inspector-scroll">
          <div className="node-identity">
            <span style={{ background: nodeColor(node), borderColor: statusColors[node.status] }} />
            <div><strong>{t(familyVisuals[nodeFamily(node)].label)}</strong><small>{t(node.status)} · {t(node.layer)}</small></div>
            <button type="button" className={focused ? "node-focus-button node-focus-button-active" : "node-focus-button"} aria-pressed={focused} onClick={() => onFocus(node.id)}>{focused ? t("Focused") : t("Focus relations")}</button>
          </div>
          <div className="ontology-node-facts">
            <span><small>{t("Evidence")}</small><strong>{node.evidenceCount}</strong></span>
            <span><small>{t("Truth layer")}</small><strong>{t(node.layer)}</strong></span>
            <span><small>{t("State")}</small><strong style={{ color: statusColors[node.status] }}>{t(node.status)}</strong></span>
          </div>
          {detail.isPending ? <InlineLoading /> : detail.isError ? <InlineError error={detail.error} /> : detail.data ? (
            <>
              <InspectorSection title={t("Summary")}><JsonRecord value={node.summary} /></InspectorSection>
              <InspectorSection title={t("Relationships · {count}", { count: detail.data.incoming.length + detail.data.outgoing.length })}>
                <div className="inspector-relation-groups">
                  <details open={detail.data.incoming.length > 0}><summary>{t("Incoming · {loaded}/{total}", { loaded: detail.data.incoming.length, total: detail.data.relationPage.incomingTotal })}</summary><EdgeList edges={detail.data.incoming} direction="incoming" labels={relatedLabels} onSelect={onSelect} /></details>
                  <details open={detail.data.outgoing.length > 0}><summary>{t("Outgoing · {loaded}/{total}", { loaded: detail.data.outgoing.length, total: detail.data.relationPage.outgoingTotal })}</summary><EdgeList edges={detail.data.outgoing} direction="outgoing" labels={relatedLabels} onSelect={onSelect} /></details>
                </div>
                {detail.data.relationPage.truncated && <p className="inspector-muted">{t("Node detail shows a bounded relationship preview; load the complete topology to inspect every connected edge.")}</p>}
              </InspectorSection>
              <InspectorSection title={`${t("Evidence")} · ${detail.data.evidence.length}`}>
                {detail.data.evidence.length ? <div className="evidence-list">{detail.data.evidence.map((evidence, index) => (
                  <article key={`${evidence.quoteHash}:${index}`}>
                    <header><span>{t("lines {start}–{end}", { start: evidence.startLine, end: evidence.endLine })}</span><small>{t(evidence.strength)}</small></header>
                    {evidence.excerpt !== undefined ? <blockquote>{evidence.excerpt}{evidence.excerptTruncated ? "…" : ""}</blockquote> : <p>{t("Exact byte excerpt is unavailable for this legacy reference.")}</p>}
                    <code>{shortHash(evidence.quoteHash)}</code>
                  </article>
                ))}</div> : <p className="inspector-muted">{t("No source-local evidence span is attached.")}</p>}
              </InspectorSection>
              <details className="ontology-technical-details">
                <summary>{t("Technical identity")}</summary>
                <dl className="ontology-node-meta">
                  <div><dt>{t("Artifact")}</dt><dd>{node.artifactId}</dd></div>
                  <div><dt>{t("Node ID")}</dt><dd>{node.id}</dd></div>
                  <div><dt>{t("Revision")}</dt><dd>{node.revisionHash ?? t("derived")}</dd></div>
                  {node.storyTime !== undefined && <div><dt>{t("Story time")}</dt><dd>{compactJson(node.storyTime)}</dd></div>}
                </dl>
              </details>
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

function EdgeList({
  edges,
  direction,
  labels,
  onSelect,
}: {
  edges: OntologyEdge[];
  direction: "incoming" | "outgoing";
  labels: ReadonlyMap<string, string>;
  onSelect: (nodeId: string) => void;
}) {
  const { t } = useI18n();
  return edges.length ? <div className="inspector-edge-list">{edges.map((edge) => {
    const relatedId = direction === "incoming" ? edge.source : edge.target;
    return <button type="button" key={edge.id} onClick={() => onSelect(relatedId)}><span>{edge.label}</span><strong>{labels.get(relatedId) ?? humanize(relatedId.split(":").at(-1) ?? relatedId)}</strong><code>{humanize(edge.kind)}</code></button>;
  })}</div> : <p className="inspector-muted">{t(direction === "incoming" ? "No incoming relationships in this projection." : "No outgoing relationships in this projection.")}</p>;
}

function OntologyNodeBrowser({ graph, onSelect }: { graph: OntologyGraph; onSelect: (nodeId: string) => void }) {
  const { t } = useI18n();
  const parent = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: graph.nodes.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 58,
    overscan: 10,
  });
  return (
    <div className="ontology-node-browser">
      <div className="ontology-browser-intro"><p>{t("Choose an entity to inspect its evidence and complete one-hop relationships.")}</p><span>{t("{count} loaded", { count: graph.nodes.length })}</span></div>
      <div className="ontology-table" role="table" aria-label={t("Ontology nodes")}>
        <div className="ontology-table-row ontology-table-head" role="row"><span>{t("Entity")}</span><span>{t("State")}</span></div>
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
                className="ontology-table-row"
                onClick={() => onSelect(node.id)}
              >
                <span className="ontology-browser-identity"><i style={{ background: nodeColor(node), borderColor: statusColors[node.status] }} /><span><strong>{node.label}</strong><small>{t(familyVisuals[nodeFamily(node)].label)}</small></span></span>
                <span className="ontology-browser-state"><strong>{t(node.status)}</strong><small>{t("{count} evidence", { count: node.evidenceCount })}</small></span>
              </button>;
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function TopologyLoadBar({
  graph,
  hasNextPage,
  fetchingNext,
  loadingAll,
  onNext,
  onAll,
  onStop,
}: {
  graph: OntologyGraph;
  hasNextPage: boolean;
  fetchingNext: boolean;
  loadingAll: boolean;
  onNext: () => void;
  onAll: () => void;
  onStop: () => void;
}) {
  const { t } = useI18n();
  return <footer className="ontology-load-bar" aria-live="polite">
    <div>
      <span>{loadingAll || fetchingNext ? t("Loading graph") : graph.truncated ? t("Partial graph") : t("Graph loaded")}</span>
      <strong>{t("{loaded}/{total} entities · {edges} relations ready", { loaded: graph.page.loadedNodes, total: graph.totalNodes, edges: graph.page.loadedEdges })}</strong>
      <div className="paged-load-track"><i style={{ width: `${percentage(graph.page.loadedNodes, graph.totalNodes)}%` }} /></div>
    </div>
    {hasNextPage && !loadingAll && <>
      <button type="button" onClick={onNext} disabled={fetchingNext}>{fetchingNext ? t("Loading…") : t("Load more")}</button>
      <button type="button" className="ontology-load-all" onClick={onAll} disabled={fetchingNext}>{t("Load all")}</button>
    </>}
    {loadingAll && <button type="button" onClick={onStop}>{t("Stop loading")}</button>}
  </footer>;
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
function humanize(value: string): string { return value.replaceAll(":", " · ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function shortHash(value: string): string { return value.length > 16 ? `${value.slice(0, 9)}…${value.slice(-5)}` : value; }
function percentage(loaded: number, total: number): number { return total === 0 ? 100 : Math.min(100, Math.round(loaded / total * 100)); }
function yieldToBrowser(): Promise<void> { return new Promise((resolve) => requestAnimationFrame(() => resolve())); }

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
  OntologyAssociation,
  OntologyEdge,
  OntologyGraph,
  OntologyLayer,
  OntologyNode,
  OntologyNodeDetail,
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
                  <div><span className="eyebrow">{focusedNodeId ? t("Relationship focus") : t("World graph")}</span>
                    <strong>{focusedNodeId ? selectedNode?.label ?? t("Focused neighborhood") : t("Drag to arrange · click an entity to explore")}</strong></div>
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
    <div className="ontology-canvas-hint">{t("Drag nodes · scroll to zoom · click an entity for relationships")}</div>
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
  const resolvedDetail = detail.data?.node.id === node?.id ? detail.data : undefined;
  const aliases = stringSummary(node?.summary.aliases);
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
            <div className="node-identity-copy">
              <div className="node-tag-row">
                <span className="node-kind-tag" style={{ borderColor: `${nodeColor(node)}88`, color: nodeColor(node) }}>{t(nodeKindLabel(node))}</span>
                <span className="node-state-tag" style={{ color: statusColors[node.status] }}>{t(node.status)}</span>
              </div>
              {aliases.length > 0 && <small>{t("Also known as {aliases}", { aliases: aliases.join("、") })}</small>}
            </div>
            {focused
              ? <span className="node-focus-state">{t("Focused")}</span>
              : <button type="button" className="node-focus-button" onClick={() => onFocus(node.id)}>{t("View relationships")}</button>}
          </div>
          <p className="node-description">{node.description ?? fallbackNodeDescription(node, t)}</p>
          {detail.isPending ? <InlineLoading /> : detail.isError ? <InlineError error={detail.error} /> : detail.data ? (
            resolvedDetail && node.kind === "entity:character"
              ? <CharacterInspector node={node} detail={resolvedDetail} onSelect={onSelect} />
              : resolvedDetail
                ? <GeneralInspector node={node} detail={resolvedDetail} onSelect={onSelect} />
                : null
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

function CharacterInspector({
  node,
  detail,
  onSelect,
}: {
  node: OntologyNode;
  detail: OntologyNodeDetail;
  onSelect: (nodeId: string) => void;
}) {
  const { t } = useI18n();
  const related = relationItems(node.id, detail);
  const ownGoals = related.filter(({ edge, node: relatedNode }) => edge.kind === "actor-goal" && edge.source === node.id && relatedNode.kind === "goal");
  const facts = keyFactItems(related);
  const people = detail.associations.filter((association) => association.node.kind === "entity:character");
  const dispositions = dispositionSummary(node.summary.dispositions);
  const hasModel = booleanSummary(node.summary.hasCharacterModel);
  const goals = numberSummary(node.summary.goalCount);
  const events = numberSummary(node.summary.eventCount);
  const claims = numberSummary(node.summary.claimCount);
  return <>
    <div className="ontology-node-facts ontology-character-facts">
      <span><small>{t("Related characters")}</small><strong>{people.length}</strong></span>
      <span><small>{t("Story events")}</small><strong>{events}</strong></span>
      <span><small>{t("Goals")}</small><strong>{goals}</strong></span>
      <span><small>{t("Character model")}</small><strong className={hasModel ? "model-present" : "model-missing"}>{hasModel ? t("Available") : t("Not built")}</strong></span>
    </div>

    <InspectorSection title={t("Character profile")}>
      {dispositions.length > 0 ? <div className="character-trait-list">{dispositions.map((disposition) => (
        <article className="character-trait" key={disposition.dimensionId}>
          <header><strong>{t(dimensionLabel(disposition.dimensionId))}</strong><span>{formatSignedValue(disposition.value)}</span></header>
          <div className="character-trait-track"><i style={{ width: `${Math.round((disposition.value + 1) / 2 * 100)}%` }} /></div>
          <small>{t(disposition.stability)} · {t("{percent}% confidence", { percent: Math.round(disposition.confidence * 100) })}</small>
        </article>
      ))}</div> : <div className="character-model-empty"><strong>{t("No character model yet")}</strong><p>{t("Goals and source-backed information are available, but this character has no persistent behavioral dispositions yet.")}</p></div>}
    </InspectorSection>

    {ownGoals.length > 0 && <InspectorSection title={t("Current goals · {count}", { count: ownGoals.length })}>
      <SemanticCards items={ownGoals} onSelect={onSelect} />
    </InspectorSection>}

    {facts.length > 0 && <InspectorSection title={t("Key character information · {shown}/{total}", { shown: facts.length, total: claims })}>
      <SemanticCards items={facts} onSelect={onSelect} />
    </InspectorSection>}

    {people.length > 0 && <InspectorSection title={t("Related characters · {count}", { count: people.length })}>
      <AssociationCards associations={people} onSelect={onSelect} />
    </InspectorSection>}

    <RelationshipDisclosure node={node} detail={detail} onSelect={onSelect} />
    <EvidenceDisclosure detail={detail} />
    <TechnicalDisclosure node={node} payload={detail.payload} />
  </>;
}

function GeneralInspector({
  node,
  detail,
  onSelect,
}: {
  node: OntologyNode;
  detail: OntologyNodeDetail;
  onSelect: (nodeId: string) => void;
}) {
  const { t } = useI18n();
  const entries = usefulSummaryEntries(node.summary);
  return <>
    <div className="ontology-node-facts">
      <span><small>{t("Relationships")}</small><strong>{detail.relationPage.incomingTotal + detail.relationPage.outgoingTotal}</strong></span>
      <span><small>{t("Related entities")}</small><strong>{detail.associations.length}</strong></span>
      <span><small>{t("Evidence")}</small><strong>{detail.evidence.length}</strong></span>
    </div>
    {entries.length > 0 && <InspectorSection title={t("What matters")}><HumanSummary entries={entries} /></InspectorSection>}
    {detail.associations.length > 0 && <InspectorSection title={t("Related entities · {count}", { count: detail.associations.length })}>
      <AssociationCards associations={detail.associations} onSelect={onSelect} />
    </InspectorSection>}
    <RelationshipDisclosure node={node} detail={detail} onSelect={onSelect} />
    <EvidenceDisclosure detail={detail} />
    <TechnicalDisclosure node={node} payload={detail.payload} />
  </>;
}

type RelatedItem = {
  edge: OntologyEdge;
  node: OntologyNode;
  direction: "incoming" | "outgoing";
};

function relationItems(rootId: string, detail: OntologyNodeDetail): RelatedItem[] {
  const nodes = new Map(detail.relatedNodes.map((node) => [node.id, node]));
  return [
    ...detail.incoming.map((edge) => ({ edge, node: nodes.get(edge.source), direction: "incoming" as const })),
    ...detail.outgoing.map((edge) => ({ edge, node: nodes.get(edge.target), direction: "outgoing" as const })),
  ].flatMap((item) => item.node && item.node.id !== rootId ? [{ ...item, node: item.node }] : []);
}

function keyFactItems(items: RelatedItem[]): RelatedItem[] {
  const candidates = items
    .filter(({ edge, node }) => edge.source !== node.id && (node.kind === "claim" || node.kind === "proposition"))
    .sort((left, right) => {
      const leftClaim = left.node.kind === "claim" ? 1 : 0;
      const rightClaim = right.node.kind === "claim" ? 1 : 0;
      return factImportance(right.node) - factImportance(left.node)
        || rightClaim - leftClaim
        || right.node.evidenceCount - left.node.evidenceCount
        || left.node.label.localeCompare(right.node.label);
    });
  const seen = new Set<string>();
  return candidates.filter(({ node }) => {
    const key = typeof node.summary.predicate === "string"
      ? node.summary.predicate
      : typeof node.summary.relationId === "string"
        ? node.summary.relationId
        : node.label;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

function factImportance(node: OntologyNode): number {
  const statement = typeof node.summary.predicate === "string"
    ? node.summary.predicate
    : typeof node.summary.relationId === "string"
      ? node.summary.relationId
      : node.label;
  const identity = /(身份|血统|等级|候选|学生|会长|教授|校长|成员|所属|任职|担任|评级|级新生|bloodline|blood-status|is-blood|status|rating|student|candidate|member|leader|president|professor|director|captain)/iu.test(statement) ? 80 : 0;
  const grounded = node.summary.epistemicType === "explicit-fact" || node.summary.epistemicType === "narrator-claim" ? 30 : 0;
  const naturalLanguage = /[^\u0000-\u007f]/u.test(statement) ? 45 : 0;
  const concise = Math.max(0, 30 - Math.abs(statement.length - 18));
  return identity + grounded + naturalLanguage + concise;
}

function SemanticCards({ items, onSelect }: { items: RelatedItem[]; onSelect: (nodeId: string) => void }) {
  const { t } = useI18n();
  return <div className="semantic-card-list">{items.map(({ edge, node }) => {
    const targets = stringSummary(node.summary.targetNames);
    const description = node.kind === "goal" && targets.length
      ? t("Targets: {targets}", { targets: targets.join("、") })
      : node.description !== node.label ? node.description : undefined;
    return <button type="button" key={edge.id} onClick={() => onSelect(node.id)}>
      <span className="semantic-card-tag">{t(nodeKindLabel(node))}</span>
      <strong>{compactNodeTitle(node)}</strong>
      {description && <p>{description}</p>}
      <small>{semanticCardMeta(node, edge, t)}</small>
    </button>;
  })}</div>;
}

function AssociationCards({ associations, onSelect }: { associations: OntologyAssociation[]; onSelect: (nodeId: string) => void }) {
  const { t } = useI18n();
  return <div className="association-card-list">{associations.map((association) => (
    <button type="button" key={association.node.id} onClick={() => onSelect(association.node.id)}>
      <header><span style={{ background: nodeColor(association.node) }} /><strong>{association.node.label}</strong><small>{t(nodeKindLabel(association.node))}</small></header>
      <p>{association.node.description ?? fallbackNodeDescription(association.node, t)}</p>
      <div>{association.relationLabels.slice(0, 3).map((label) => <span key={label}>{humanize(label)}</span>)}</div>
    </button>
  ))}</div>;
}

function RelationshipDisclosure({ node, detail, onSelect }: { node: OntologyNode; detail: OntologyNodeDetail; onSelect: (nodeId: string) => void }) {
  const { t } = useI18n();
  const related = new Map(detail.relatedNodes.map((item) => [item.id, item]));
  return <details className="inspector-disclosure relationship-disclosure">
    <summary><span>{t("All connected content")}</span><strong>{detail.relationPage.incomingTotal + detail.relationPage.outgoingTotal}</strong></summary>
    <div className="inspector-relation-groups">
      <details open={detail.incoming.length > 0}><summary>{t("Incoming · {loaded}/{total}", { loaded: detail.incoming.length, total: detail.relationPage.incomingTotal })}</summary><EdgeList edges={detail.incoming} direction="incoming" related={related} root={node} onSelect={onSelect} /></details>
      <details open={detail.outgoing.length > 0}><summary>{t("Outgoing · {loaded}/{total}", { loaded: detail.outgoing.length, total: detail.relationPage.outgoingTotal })}</summary><EdgeList edges={detail.outgoing} direction="outgoing" related={related} root={node} onSelect={onSelect} /></details>
    </div>
    {detail.relationPage.truncated && <p className="inspector-muted">{t("Node detail shows a bounded relationship preview; load the complete topology to inspect every connected edge.")}</p>}
  </details>;
}

function EvidenceDisclosure({ detail }: { detail: OntologyNodeDetail }) {
  const { t } = useI18n();
  return <details className="inspector-disclosure evidence-disclosure">
    <summary><span>{t("Source evidence")}</span><strong>{detail.evidence.length}</strong></summary>
    <div className="disclosure-body">
      {detail.evidence.length ? <div className="evidence-list">{detail.evidence.map((evidence, index) => (
        <article key={`${evidence.quoteHash}:${index}`}>
          <header><span>{t("lines {start}–{end}", { start: evidence.startLine, end: evidence.endLine })}</span><small>{t(evidence.strength)}</small></header>
          {evidence.excerpt !== undefined ? <blockquote>{evidence.excerpt}{evidence.excerptTruncated ? "…" : ""}</blockquote> : <p>{t("Exact byte excerpt is unavailable for this legacy reference.")}</p>}
          <code>{shortHash(evidence.quoteHash)}</code>
        </article>
      ))}</div> : <p className="inspector-muted">{t("No source-local evidence span is attached.")}</p>}
    </div>
  </details>;
}

function TechnicalDisclosure({ node, payload }: { node: OntologyNode; payload: unknown }) {
  const { t } = useI18n();
  return <>
    <details className="ontology-technical-details">
      <summary>{t("Technical identity")}</summary>
      <dl className="ontology-node-meta">
        <div><dt>{t("Artifact")}</dt><dd>{node.artifactId}</dd></div>
        <div><dt>{t("Node ID")}</dt><dd>{node.id}</dd></div>
        <div><dt>{t("Revision")}</dt><dd>{node.revisionHash ?? t("derived")}</dd></div>
        {node.storyTime !== undefined && <div><dt>{t("Story time")}</dt><dd>{compactJson(node.storyTime)}</dd></div>}
      </dl>
    </details>
    <DeferredPayload value={payload} />
  </>;
}

function EdgeList({
  edges,
  direction,
  related,
  root,
  onSelect,
}: {
  edges: OntologyEdge[];
  direction: "incoming" | "outgoing";
  related: ReadonlyMap<string, OntologyNode>;
  root: OntologyNode;
  onSelect: (nodeId: string) => void;
}) {
  const { t } = useI18n();
  return edges.length ? <div className="inspector-edge-list">{edges.map((edge) => {
    const relatedId = direction === "incoming" ? edge.source : edge.target;
    const relatedNode = related.get(relatedId);
    const label = relatedNode?.label ?? humanize(relatedId.split(":").at(-1) ?? relatedId);
    return <button type="button" key={edge.id} onClick={() => onSelect(relatedId)}>
      <header><strong>{label}</strong><span>{t(humanize(edge.label))}</span></header>
      <p>{relatedNode?.description ?? t(direction === "incoming" ? "Connects into {entity}." : "Connected from {entity}.", { entity: root.label })}</p>
      <small>{relatedNode ? t(nodeKindLabel(relatedNode)) : t("Related content")} · {t("{count} evidence", { count: edge.evidenceCount })}</small>
    </button>;
  })}</div> : <p className="inspector-muted">{t(direction === "incoming" ? "No incoming relationships in this projection." : "No outgoing relationships in this projection.")}</p>;
}

function HumanSummary({ entries }: { entries: Array<[string, unknown]> }) {
  const { t } = useI18n();
  return <dl className="summary-record">{entries.map(([key, item]) => <div key={key}><dt>{t(summaryLabel(key))}</dt><dd>{formatValue(item)}</dd></div>)}</dl>;
}

function usefulSummaryEntries(summary: Record<string, unknown>): Array<[string, unknown]> {
  const hidden = new Set(["entityKind", "aliases", "actorId", "holderEntityId", "hasCharacterModel", "dispositions", "claimCount", "propositionCount", "goalCount", "eventCount"]);
  return Object.entries(summary).filter(([key, value]) => !hidden.has(key) && value !== undefined && !(Array.isArray(value) && value.length === 0));
}

function stringSummary(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberSummary(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanSummary(value: unknown): boolean {
  return value === true;
}

type DispositionSummary = { dimensionId: string; value: number; stability: string; confidence: number };

function dispositionSummary(value: unknown): DispositionSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): DispositionSummary[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.dimensionId !== "string" || typeof candidate.value !== "number") return [];
    return [{
      dimensionId: candidate.dimensionId,
      value: Math.max(-1, Math.min(1, candidate.value)),
      stability: typeof candidate.stability === "string" ? candidate.stability : "situational",
      confidence: typeof candidate.confidence === "number" ? Math.max(0, Math.min(1, candidate.confidence)) : 0,
    }];
  });
}

function dimensionLabel(value: string): string {
  const labels: Record<string, string> = {
    "risk-tolerance": "Risk tolerance",
    deliberation: "Deliberation",
    affiliation: "Affiliation",
    dominance: "Dominance",
    "norm-adherence": "Norm adherence",
    "trust-readiness": "Trust readiness",
    persistence: "Persistence",
    "openness-to-revision": "Openness to revision",
  };
  return labels[value] ?? humanize(value);
}

function nodeKindLabel(node: Pick<OntologyNode, "kind" | "layer">): string {
  const entityKind = node.kind.startsWith("entity:") ? node.kind.slice("entity:".length) : undefined;
  const entityLabels: Record<string, string> = {
    character: "Character",
    location: "Location",
    concept: "Concept",
    faction: "Faction",
    institution: "Institution",
    relationship: "Relationship",
    artifact: "Artifact",
    other: "Other",
  };
  if (entityKind) return entityLabels[entityKind] ?? humanize(entityKind);
  const artifactLabels: Record<string, string> = {
    goal: "Goal",
    claim: "Character information",
    proposition: "Proposition",
    attribution: "Knowledge attribution",
    "character-model": "Character model",
    disposition: "Disposition",
    appraisal: "Appraisal",
    development: "Development",
    "canonical-event": "Event",
    "committed-event": "Event",
    "world-rule": "Rule",
  };
  return artifactLabels[node.kind] ?? familyVisuals[nodeFamily(node)].label;
}

function fallbackNodeDescription(node: OntologyNode, translate: (message: string, values?: Record<string, string | number>) => string): string {
  const facts = numberSummary(node.summary.claimCount) + numberSummary(node.summary.propositionCount);
  const goals = numberSummary(node.summary.goalCount);
  const events = numberSummary(node.summary.eventCount);
  if (facts || goals || events) return translate("{facts} information items · {goals} goals · {events} events", { facts, goals, events });
  return translate("Source-backed {kind} with {count} evidence references.", { kind: translate(nodeKindLabel(node)), count: node.evidenceCount });
}

function semanticCardMeta(node: OntologyNode, edge: OntologyEdge, translate: (message: string, values?: Record<string, string | number>) => string): string {
  if (node.kind === "goal") return translate("Priority {percent}% · {count} evidence", { percent: Math.round(numberSummary(node.summary.priority) * 100), count: edge.evidenceCount });
  const type = typeof node.summary.epistemicType === "string" ? humanize(node.summary.epistemicType) : humanize(edge.label);
  return `${translate(type)} · ${translate("{count} evidence", { count: edge.evidenceCount })}`;
}

function compactNodeTitle(node: OntologyNode): string {
  const separator = node.label.indexOf(" · ");
  return separator >= 0 ? node.label.slice(separator + 3) : node.label;
}

function summaryLabel(value: string): string {
  const labels: Record<string, string> = {
    priority: "Priority",
    requiresKnowledge: "Required knowledge",
    polarity: "Polarity",
    modality: "Modality",
    relationId: "Relation",
    epistemicType: "Information type",
    speaker: "Speaker",
    predicate: "Statement",
    confidence: "Confidence",
    participants: "Participants",
    narrativeOrder: "Narrative order",
    narrativeMode: "Narrative mode",
    dispositions: "Dispositions",
    appraisals: "Appraisals",
    developmentEpisodes: "Development",
    relationships: "Relationships",
  };
  return labels[value] ?? humanize(value);
}

function formatSignedValue(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
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

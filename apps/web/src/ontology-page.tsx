import cytoscape from "cytoscape";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { fetchInstance, fetchOntology, fetchOntologyNode, type OntologyFilters } from "./api";
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
  const meta = views.find((candidate) => candidate.id === view)!;
  const sourceInstances = instances.filter((instance) => instance.sourceId === sourceId);
  const [branchId, setBranchId] = useState(initialBranchId ?? "");
  const [commitId, setCommitId] = useState(initialCommitId ?? "");
  const [includeCanonicalFuture, setIncludeCanonicalFuture] = useState(initialIncludeCanonicalFuture);
  const [layers, setLayers] = useState<OntologyLayer[]>(() => defaultLayers(view));
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
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
    limit: 2_000,
  };
  const graph = useQuery({
    queryKey: ["ontology", sourceId, view, branchId, effectiveCommit, includeCanonicalFuture, [...layers].sort().join(",")],
    queryFn: ({ signal }) => fetchOntology(sourceId, view, filters, signal),
    enabled: Boolean(novel),
  });

  useEffect(() => {
    if (selectedNodeId && graph.data && !graph.data.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(undefined);
    }
  }, [graph.data, selectedNodeId]);

  const detail = useQuery({
    queryKey: ["ontology-node", sourceId, view, selectedNodeId, branchId, effectiveCommit, includeCanonicalFuture, [...layers].sort().join(",")],
    queryFn: ({ signal }) => fetchOntologyNode(sourceId, view, selectedNodeId!, filters, signal),
    enabled: Boolean(selectedNodeId),
  });

  const visible = useMemo(() => filterGraph(graph.data, search, kind, status), [graph.data, search, kind, status]);
  const selectedNode = graph.data?.nodes.find((node) => node.id === selectedNodeId);

  if (!novel) {
    return <PageState title="Unknown novel" body={`No registered source matches ${sourceId}.`} />;
  }

  return (
    <>
      <div className="ontology-heading">
        <div>
          <Link className="ontology-back-link" to="/novels/$sourceId" params={{ sourceId }}>← {novel.title}</Link>
          <span className="eyebrow">Ontology workbench</span>
          <h1>{meta.label}</h1>
          <p>{meta.description}</p>
        </div>
        <div className="ontology-heading-actions">
          <span className={branchId ? "truth-badge truth-badge-branch" : "truth-badge"}>{branchId ? "Committed branch scope" : "Compiled source scope"}</span>
          {effectiveCommit && <code>{shortHash(effectiveCommit)}</code>}
        </div>
      </div>

      <nav className="ontology-tabs" aria-label="Ontology projection">
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
            {candidate.label}
          </Link>
        ))}
      </nav>

      <section className="ontology-scope" aria-label="Projection scope">
        <label>
          <span>Truth scope</span>
          <select value={branchId} onChange={(event) => {
            const nextBranchId = event.target.value;
            setBranchId(nextBranchId);
            setCommitId("");
            onScopeChangeRef.current?.(nextBranchId ? { branchId: nextBranchId } : {});
          }}>
            <option value="">Current compiled source</option>
            {sourceInstances.map((candidate) => <option key={candidate.branchId} value={candidate.branchId}>{candidate.name} · step {candidate.logicalStep}</option>)}
          </select>
        </label>
        <label>
          <span>Committed time</span>
          <select
            value={effectiveCommit ?? ""}
            disabled={!branchId || instance.isPending || !instance.data}
            onChange={(event) => {
              setCommitId(event.target.value);
              onScopeChangeRef.current?.({ branchId, atCommit: event.target.value, ...(includeCanonicalFuture ? { includeCanonicalFuture: true } : {}) });
            }}
          >
            {!branchId && <option value="">Not branch-scoped</option>}
            {branchId && instance.isPending && <option value="">Resolving ancestry…</option>}
            {instance.data?.history.map((commit) => (
              <option key={commit.id} value={commit.id}>step {commit.logicalStep} · {shortHash(commit.id)}{commit.id === instance.data.instance.headCommitId ? " · HEAD" : ""}</option>
            ))}
          </select>
        </label>
        {(view === "events" || view === "provenance") && branchId ? (
          <label className="ontology-future-toggle">
            <input type="checkbox" checked={includeCanonicalFuture} onChange={(event) => {
              setIncludeCanonicalFuture(event.target.checked);
              onScopeChangeRef.current?.({ branchId, ...(effectiveCommit ? { atCommit: effectiveCommit } : {}), ...(event.target.checked ? { includeCanonicalFuture: true } : {}) });
            }} />
            <span><strong>Show future canon as possibility</strong><small>Never promotes it into branch truth.</small></span>
          </label>
        ) : <div className="ontology-scope-note"><strong>Truth boundary</strong><span>{branchId ? "State and validity derive from the selected commit." : "Shows current accepted compiler artifacts, not a runtime state."}</span></div>}
      </section>

      <section className="ontology-toolbar" aria-label="Graph filters">
        <label className="ontology-search"><span>Search</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Label, ID, kind, status…" /></label>
        <label><span>Kind</span><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">All kinds</option>{Object.keys(graph.data?.facets.kinds ?? {}).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{Object.keys(graph.data?.facets.statuses ?? {}).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <div className="ontology-graph-actions">
          <button type="button" onClick={() => graphRef.current?.fit()} disabled={!visible?.nodes.length}>Fit</button>
          <button type="button" onClick={() => graphRef.current?.relayout()} disabled={!visible?.nodes.length}>Re-layout</button>
          <button type="button" onClick={() => void graph.refetch()} disabled={graph.isFetching}>{graph.isFetching ? "Refreshing…" : "Refresh"}</button>
        </div>
      </section>

      <section className="ontology-layer-bar" aria-label="Projection layers">
        <span>Layers</span>
        {allLayers.map((layer) => (
          <label key={layer.id} className={layers.includes(layer.id) ? "layer-chip layer-chip-active" : "layer-chip"}>
            <input
              type="checkbox"
              checked={layers.includes(layer.id)}
              onChange={() => setLayers((current) => current.includes(layer.id)
                ? current.length === 1 ? current : current.filter((item) => item !== layer.id)
                : [...current, layer.id])}
            />
            {layer.label}
          </label>
        ))}
        <span className="ontology-count">{visible?.nodes.length ?? 0} nodes · {visible?.edges.length ?? 0} edges</span>
      </section>

      {instance.isError && <InlineError error={instance.error} />}
      {graph.isPending ? <PageState loading title="Projecting the ontology" body="Resolving source-scoped artifacts and temporal validity…" /> : graph.isError ? <PageState title="Projection failed" body={graph.error.message} action={<button onClick={() => void graph.refetch()}>Try again</button>} /> : graph.data && visible ? (
        <>
          {graph.data.diagnostics.length > 0 && <div className="ontology-diagnostics">{graph.data.diagnostics.map((message) => <p key={message}>{message}</p>)}</div>}
          <div className="ontology-workbench">
            <section className="ontology-canvas-panel">
              <header>
                <div><span className="eyebrow">Graph</span><strong>{graph.data.truncated ? `Showing a bounded projection of ${graph.data.totalNodes} nodes` : "Complete selected projection"}</strong></div>
                <div className="ontology-legend">{graph.data.legend.map((item) => <span key={item.id}><i style={{ background: item.color }} />{item.label}<small>{item.count}</small></span>)}</div>
              </header>
              {visible.nodes.length ? <GraphCanvas ref={graphRef} graph={visible} view={view} selectedNodeId={selectedNodeId} onSelect={setSelectedNodeId} /> : <EmptyGraph />}
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
  const container = useRef<HTMLDivElement>(null);
  const core = useRef<cytoscape.Core | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const layout = () => core.current?.layout(layoutOptions(view)).run();
  useImperativeHandle(ref, () => ({
    fit: () => core.current?.fit(undefined, 52),
    relayout: layout,
  }), [view]);

  useEffect(() => {
    if (!container.current) return;
    const cy = cytoscape({
      container: container.current,
      elements: [
        ...graph.nodes.map((node) => ({
          group: "nodes" as const,
          data: {
            id: node.id,
            label: node.label,
            kind: node.kind,
            status: node.status,
            layer: node.layer,
            color: statusColors[node.status],
            shape: shapeFor(node),
          },
          classes: node.id === selectedNodeId ? "selected" : "",
        })),
        ...graph.edges.map((edge) => ({
          group: "edges" as const,
          data: { id: edge.id, source: edge.source, target: edge.target, label: edge.label, color: statusColors[edge.status] },
        })),
      ],
      style: graphStyles,
      layout: layoutOptions(view),
      minZoom: 0.08,
      maxZoom: 3.5,
      wheelSensitivity: 0.18,
      selectionType: "single",
    });
    core.current = cy;
    cy.on("tap", "node", (event) => onSelectRef.current(event.target.id()));
    cy.on("tap", (event) => {
      if (event.target === cy) cy.elements().unselect();
    });
    return () => {
      cy.destroy();
      if (core.current === cy) core.current = null;
    };
  }, [graph, view]);

  useEffect(() => {
    if (!core.current) return;
    core.current.nodes().removeClass("selected");
    if (selectedNodeId) core.current.getElementById(selectedNodeId).addClass("selected").select();
  }, [selectedNodeId]);

  return <div ref={container} className="ontology-canvas" role="img" aria-label={`${view} ontology graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges`} />;
});

const graphStyles = [
  {
    selector: "node",
    style: {
      "background-color": "data(color)",
      "border-width": 2,
      "border-color": "#10110f",
      shape: "data(shape)",
      width: 28,
      height: 28,
      label: "data(label)",
      color: "#d7d8d1",
      "font-family": "Manrope, sans-serif",
      "font-size": 7,
      "text-wrap": "wrap",
      "text-max-width": 100,
      "text-valign": "bottom",
      "text-margin-y": 7,
      "text-background-color": "#141512",
      "text-background-opacity": 0.88,
      "text-background-padding": 2,
    },
  },
  {
    selector: "node.selected",
    style: { "border-width": 4, "border-color": "#ffffff", "overlay-color": "#d6ff72", "overlay-opacity": 0.13, "overlay-padding": 8 },
  },
  {
    selector: "edge",
    style: {
      width: 1.2,
      "line-color": "data(color)",
      "target-arrow-color": "data(color)",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      opacity: 0.58,
      label: "data(label)",
      color: "#8d9187",
      "font-size": 5,
      "text-rotation": "autorotate",
      "text-background-color": "#10110f",
      "text-background-opacity": 0.82,
      "text-background-padding": 1,
    },
  },
] as unknown as cytoscape.StylesheetJson;

function NodeInspector({
  node,
  detail,
  onClose,
}: {
  node?: OntologyNode;
  detail: ReturnType<typeof useQuery<Awaited<ReturnType<typeof fetchOntologyNode>>, Error>>;
  onClose: () => void;
}) {
  return (
    <aside className="ontology-inspector">
      <header>
        <div><span className="eyebrow">Inspector</span><strong>{node?.label ?? "Select a node"}</strong></div>
        {node && <button type="button" aria-label="Close inspector" onClick={onClose}>×</button>}
      </header>
      {!node ? <div className="ontology-inspector-empty"><span>◇</span><p>Click a graph node or table row to inspect its exact payload, evidence, and relationships.</p></div> : (
        <div className="ontology-inspector-scroll">
          <div className="node-identity">
            <span style={{ background: statusColors[node.status] }} />
            <div><strong>{node.kind}</strong><small>{node.status} · {node.layer}</small></div>
          </div>
          <dl className="ontology-node-meta">
            <div><dt>Artifact</dt><dd>{node.artifactId}</dd></div>
            <div><dt>Node ID</dt><dd>{node.id}</dd></div>
            <div><dt>Revision</dt><dd>{node.revisionHash ?? "derived"}</dd></div>
            <div><dt>Evidence</dt><dd>{node.evidenceCount}{node.shared ? " · shared artifact, locally filtered" : ""}</dd></div>
            {node.storyTime !== undefined && <div><dt>Story time</dt><dd>{compactJson(node.storyTime)}</dd></div>}
          </dl>
          {detail.isPending ? <InlineLoading /> : detail.isError ? <InlineError error={detail.error} /> : detail.data ? (
            <>
              <InspectorSection title="Summary"><JsonRecord value={node.summary} /></InspectorSection>
              <InspectorSection title={`Evidence · ${detail.data.evidence.length}`}>
                {detail.data.evidence.length ? <div className="evidence-list">{detail.data.evidence.map((evidence, index) => (
                  <article key={`${evidence.quoteHash}:${index}`}>
                    <header><span>lines {evidence.startLine}–{evidence.endLine}</span><small>{evidence.strength}</small></header>
                    {evidence.excerpt !== undefined ? <blockquote>{evidence.excerpt}{evidence.excerptTruncated ? "…" : ""}</blockquote> : <p>Exact byte excerpt is unavailable for this legacy reference.</p>}
                    <code>{shortHash(evidence.quoteHash)}</code>
                  </article>
                ))}</div> : <p className="inspector-muted">No source-local evidence span is attached.</p>}
              </InspectorSection>
              <InspectorSection title={`Incoming · ${detail.data.incoming.length}`}><EdgeList edges={detail.data.incoming} direction="incoming" /></InspectorSection>
              <InspectorSection title={`Outgoing · ${detail.data.outgoing.length}`}><EdgeList edges={detail.data.outgoing} direction="outgoing" /></InspectorSection>
              <details className="payload-json"><summary>Exact stored / derived payload</summary><pre>{JSON.stringify(detail.data.payload, null, 2) ?? "null"}</pre></details>
            </>
          ) : null}
        </div>
      )}
    </aside>
  );
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="inspector-section"><h3>{title}</h3>{children}</section>;
}

function JsonRecord({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  return entries.length ? <dl className="summary-record">{entries.map(([key, item]) => <div key={key}><dt>{key}</dt><dd>{formatValue(item)}</dd></div>)}</dl> : <p className="inspector-muted">No summary fields.</p>;
}

function EdgeList({ edges, direction }: { edges: OntologyEdge[]; direction: "incoming" | "outgoing" }) {
  return edges.length ? <div className="inspector-edge-list">{edges.map((edge) => <div key={edge.id}><span>{edge.label}</span><code>{direction === "incoming" ? edge.source : edge.target}</code></div>)}</div> : <p className="inspector-muted">No {direction} relationships in this projection.</p>;
}

function OntologyTable({ graph, selectedNodeId, onSelect }: { graph: OntologyGraph; selectedNodeId?: string; onSelect: (nodeId: string) => void }) {
  return (
    <section className="ontology-table-panel">
      <header><div><span className="eyebrow">Accessible table</span><strong>Searchable projection fallback</strong></div><span className="panel-tag">{graph.nodes.length} rows</span></header>
      <div className="ontology-table" role="table" aria-label="Ontology nodes">
        <div className="ontology-table-row ontology-table-head" role="row"><span>Node</span><span>Kind</span><span>Status</span><span>Layer</span><span>Evidence</span></div>
        {graph.nodes.slice(0, 500).map((node) => (
          <button key={node.id} type="button" role="row" className={node.id === selectedNodeId ? "ontology-table-row ontology-table-selected" : "ontology-table-row"} onClick={() => onSelect(node.id)}>
            <span><strong>{node.label}</strong><small>{node.artifactId}</small></span><code>{node.kind}</code><span><i style={{ background: statusColors[node.status] }} />{node.status}</span><span>{node.layer}</span><span>{node.evidenceCount}</span>
          </button>
        ))}
      </div>
      {graph.nodes.length > 500 && <p className="ontology-table-limit">Table is capped at 500 rows; narrow the search or facet filters to inspect the remainder.</p>}
    </section>
  );
}

function filterGraph(graph: OntologyGraph | undefined, search: string, kind: string, status: string): OntologyGraph | undefined {
  if (!graph) return undefined;
  const needle = search.trim().toLocaleLowerCase();
  const nodes = graph.nodes.filter((node) => {
    if (kind && node.kind !== kind) return false;
    if (status && node.status !== status) return false;
    return !needle || `${node.label} ${node.id} ${node.artifactId} ${node.kind} ${node.status} ${node.layer}`.toLocaleLowerCase().includes(needle);
  });
  const ids = new Set(nodes.map((node) => node.id));
  return { ...graph, nodes, edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) };
}

function defaultLayers(view: OntologyView): OntologyLayer[] {
  if (view === "events") return ["canonical", "branch", "possibility"];
  if (view === "provenance") return ["canonical", "branch", "possibility", "proposal", "evidence"];
  return ["canonical", "branch"];
}

function layoutOptions(view: OntologyView): cytoscape.LayoutOptions {
  if (view === "rules" || view === "provenance") return { name: "breadthfirst", directed: true, padding: 45, spacingFactor: 1.35, animate: false };
  return { name: "cose", padding: 50, animate: false, nodeRepulsion: () => 9_000, idealEdgeLength: () => 95, componentSpacing: 90 };
}

function shapeFor(node: OntologyNode): string {
  if (node.kind.includes("event") || node.kind === "world-commit") return "diamond";
  if (node.kind.includes("rule")) return "hexagon";
  if (node.kind.includes("location") || node.kind === "source") return "round-rectangle";
  if (node.kind.includes("proposal") || node.kind === "validation") return "tag";
  if (node.kind === "source-span") return "rectangle";
  return "ellipse";
}

function EmptyGraph() {
  return <div className="ontology-empty"><span>◇</span><strong>No nodes match this projection</strong><p>Adjust the search, facets, layers, branch, or commit.</p></div>;
}

function PageState({ loading = false, title, body, action }: { loading?: boolean; title: string; body: string; action?: React.ReactNode }) {
  return <div className="ontology-page-state">{loading ? <span className="loading-orbit" /> : <span className="ontology-state-mark">◇</span>}<strong>{title}</strong><p>{body}</p>{action}</div>;
}

function InlineLoading() { return <div className="ontology-inline-state"><span className="loading-orbit" />Loading exact node detail…</div>; }
function InlineError({ error }: { error: Error }) { return <div className="ontology-inline-error"><strong>{error.name}</strong><span>{error.message}</span></div>; }
function compactJson(value: unknown): string { return JSON.stringify(value); }
function formatValue(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value); }
function shortHash(value: string): string { return value.length > 16 ? `${value.slice(0, 9)}…${value.slice(-5)}` : value; }

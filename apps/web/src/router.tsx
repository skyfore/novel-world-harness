import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  useParams,
} from "@tanstack/react-router";
import { fetchBootstrap } from "./api";
import type { BootstrapResponse, InstanceSummary, NovelSummary, PlaySessionSummary } from "../../../src/web/contracts";

interface RouterContext {
  queryClient: QueryClient;
}

const bootstrapQueryKey = ["bootstrap"] as const;

function useBootstrap() {
  return useQuery({
    queryKey: bootstrapQueryKey,
    queryFn: ({ signal }) => fetchBootstrap(signal),
  });
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: RootLayout });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardPage });
const novelRoute = createRoute({ getParentRoute: () => rootRoute, path: "/novels/$sourceId", component: NovelPage });
const instanceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/instances/$branchId", component: InstancePage });
const sessionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/play/$sessionId", component: SessionPage });
const modelsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/models", component: ModelsPage });
const routeTree = rootRoute.addChildren([indexRoute, novelRoute, instanceRoute, sessionRoute, modelsRoute]);

export const router = createRouter({ routeTree, context: { queryClient: undefined! } });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function RootLayout() {
  const query = useBootstrap();
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<"connecting" | "online" | "offline">("connecting");

  useEffect(() => {
    const source = new EventSource("/api/v1/events");
    source.onopen = () => setConnection("online");
    source.onerror = () => setConnection("offline");
    const invalidate = () => void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
    source.addEventListener("catalog.invalidated", invalidate);
    return () => {
      source.removeEventListener("catalog.invalidated", invalidate);
      source.close();
    };
  }, [queryClient]);

  const data = query.data;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link to="/" className="brand" activeOptions={{ exact: true }}>
          <span className="brand-mark">NW</span>
          <span>
            <strong>Novel World</strong>
            <small>Harness</small>
          </span>
        </Link>
        <nav aria-label="主导航" className="primary-nav">
          <NavSection label="Workspace">
            <Link to="/" activeOptions={{ exact: true }} className="nav-link">Overview</Link>
          </NavSection>
          <NavSection label="Novels" count={data?.catalog.novels.length}>
            {data?.catalog.novels.map((novel) => (
              <Link key={novel.id} to="/novels/$sourceId" params={{ sourceId: novel.id }} className="nav-link nav-link-item">
                <span>{novel.title}</span><small>{formatBytes(novel.bytes)}</small>
              </Link>
            ))}
            {!data?.catalog.novels.length && <span className="nav-empty">No registered novels</span>}
          </NavSection>
          <NavSection label="Instances" count={data?.catalog.instances.length}>
            {data?.catalog.instances.map((instance) => (
              <Link key={instance.branchId} to="/instances/$branchId" params={{ branchId: instance.branchId }} className="nav-link nav-link-item">
                <span>{instance.name}</span><small>step {instance.logicalStep}</small>
              </Link>
            ))}
          </NavSection>
          <NavSection label="Play sessions" count={data?.catalog.playSessions.length}>
            {data?.catalog.playSessions.map((session) => (
              <Link key={session.id} to="/play/$sessionId" params={{ sessionId: session.id }} className="nav-link nav-link-item">
                <span>{session.actorName ?? session.actorId}</span><small>{session.status}</small>
              </Link>
            ))}
          </NavSection>
        </nav>
        <div className="sidebar-footer">
          <Link to="/settings/models" className="nav-link">Model catalog</Link>
          <div className={`connection connection-${connection}`}><span />{connection}</div>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">Local workspace</span>
            <strong>{data?.workspace.displayName ?? "Loading…"}</strong>
          </div>
          <div className="topbar-meta">
            <span>API {data?.apiVersion ?? "v1"}</span>
            <span>Pi-backed</span>
            <span>No app login</span>
          </div>
        </header>
        <section className="page">
          {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : <Outlet />}
        </section>
      </main>
    </div>
  );
}

function NavSection({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  return <section className="nav-section"><h2>{label}{count !== undefined && <span>{count}</span>}</h2>{children}</section>;
}

function DashboardPage() {
  const { data } = useBootstrap();
  if (!data) return null;
  const configuredProviders = data.modelCatalog.providers.filter((provider) => provider.configured).length;
  return (
    <>
      <PageHeading eyebrow="Executable novel workspace" title="World control room" description="Inspect compiled worlds, resume their branches, and follow every model-backed operation from one local interface." />
      <div className="metric-grid">
        <Metric label="Novels" value={data.catalog.novels.length} note="registered sources" />
        <Metric label="Instances" value={data.catalog.instances.length} note="committed branches" />
        <Metric label="Play sessions" value={data.catalog.playSessions.length} note="recoverable contexts" />
        <Metric label="Providers" value={configuredProviders} note={`${data.modelCatalog.models.length} known models`} />
      </div>
      <div className="content-grid">
        <Panel title="Recent instances" action={<span className="panel-tag">world truth</span>}>
          {data.catalog.instances.length ? data.catalog.instances.slice(0, 5).map((instance) => <InstanceRow key={instance.branchId} instance={instance} />) : <EmptyState title="No playable world yet" body="Prepare a registered novel to create its first committed branch." />}
        </Panel>
        <Panel title="Delivery map" action={<span className="panel-tag">MVP</span>}>
          <div className="feature-list">
            {data.features.map((feature) => (
              <div className="feature-row" key={feature.id}>
                <span className={`status-dot status-${feature.status}`} />
                <strong>{feature.id.replace("-", " ")}</strong>
                <span>Phase {feature.phase}</span>
                <small>{feature.status}</small>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Panel title="Registered novels" action={<span className="panel-tag">source evidence</span>}>
        <div className="card-grid">
          {data.catalog.novels.map((novel) => <NovelCard key={novel.id} novel={novel} />)}
          {!data.catalog.novels.length && <EmptyState title="The library is empty" body="Source upload and the compiler workbench arrive in Phase 2. Existing CLI-ingested novels appear here now." />}
        </div>
      </Panel>
    </>
  );
}

function NovelPage() {
  const { sourceId } = useParams({ from: novelRoute.id });
  const { data } = useBootstrap();
  const novel = data?.catalog.novels.find((candidate) => candidate.id === sourceId);
  if (!data || !novel) return <MissingState kind="novel" id={sourceId} />;
  const instances = data.catalog.instances.filter((instance) => instance.sourceId === novel.id);
  return (
    <>
      <PageHeading eyebrow="Source evidence" title={novel.title} description={novel.sourcePath} />
      <div className="metric-grid metric-grid-three">
        <Metric label="Size" value={formatBytes(novel.bytes)} note="immutable source" />
        <Metric label="Instances" value={novel.instanceCount} note="owned branches" />
        <Metric label="Updated" value={formatDate(novel.updatedAt)} note={novel.id} />
      </div>
      <Panel title="World instances" action={<span className="panel-tag">read only</span>}>
        {instances.length ? instances.map((instance) => <InstanceRow key={instance.branchId} instance={instance} />) : <EmptyState title="No committed instance" body="This source is registered but does not yet own a playable branch." />}
      </Panel>
      <PlannedCallout title="Compiler and ontology workbench" phase="Phase 2" body="Batch progress, proposal review, model/event/place/rule graphs, and evidence provenance will live on this novel page without changing canonical truth." />
    </>
  );
}

function InstancePage() {
  const { branchId } = useParams({ from: instanceRoute.id });
  const { data } = useBootstrap();
  const instance = data?.catalog.instances.find((candidate) => candidate.branchId === branchId);
  if (!instance) return <MissingState kind="instance" id={branchId} />;
  return (
    <>
      <PageHeading eyebrow="Committed branch" title={instance.name} description={instance.sourceTitle ?? "Unscoped legacy world"} />
      <div className="metric-grid">
        <Metric label="Story step" value={instance.logicalStep} note="derived world time" />
        <Metric label="Commits" value={instance.commitCount} note="authoritative history" />
        <Metric label="Events" value={instance.eventCount} note={instance.lastEventTitle ?? "no event title"} />
        <Metric label="Actor" value={instance.actorName ?? "—"} note={instance.sessionAtHead ? "session at head" : "session not at head"} />
      </div>
      <Panel title="Branch identity" action={<span className="panel-tag">immutable links</span>}>
        <dl className="detail-list">
          <Detail label="Branch ID" value={instance.branchId} mono />
          <Detail label="Head commit" value={instance.headCommitId} mono />
          <Detail label="Parent" value={instance.parentBranchId ?? "genesis"} mono />
          <Detail label="Prepared revision" value={instance.preparedRevisionHash ?? "legacy / unpinned"} mono />
          <Detail label="Updated" value={formatDateTime(instance.updatedAt)} />
        </dl>
      </Panel>
      <PlannedCallout title="Branch history and graph overlay" phase="Phase 2" body="Commit history, state diff, fork controls, and branch-scoped ontology will be added here." />
    </>
  );
}

function SessionPage() {
  const { sessionId } = useParams({ from: sessionRoute.id });
  const { data } = useBootstrap();
  const session = data?.catalog.playSessions.find((candidate) => candidate.id === sessionId);
  if (!session) return <MissingState kind="play session" id={sessionId} />;
  return (
    <>
      <PageHeading eyebrow="Recoverable play context" title={session.actorName ?? session.actorId} description={`Branch ${session.branchId}`} />
      <div className="metric-grid metric-grid-three">
        <Metric label="Status" value={session.status} note={session.active ? "currently selected" : "saved"} />
        <Metric label="World head" value={session.atHead ? "Current" : "Moved"} note="optimistic resume boundary" />
        <Metric label="Storage" value={`v${session.storageVersion}`} note={formatDateTime(session.updatedAt)} />
      </div>
      <Panel title="Session pointer" action={<span className="panel-tag">presentation only</span>}>
        <dl className="detail-list">
          <Detail label="Session ID" value={session.id} mono />
          <Detail label="Actor ID" value={session.actorId} mono />
          <Detail label="Last commit" value={session.lastCommitId} mono />
        </dl>
      </Panel>
      <PlannedCallout title="Play and full trajectory" phase="Phase 1" body="Streaming play, continuation, cancellation, nested LLM requests, tool calls, context composition, and commit effects will be implemented on this route next." />
    </>
  );
}

function ModelsPage() {
  const { data } = useBootstrap();
  if (!data) return null;
  return (
    <>
      <PageHeading eyebrow="Pi runtime" title="Model catalog" description="Credential values stay in Pi storage. This page receives status metadata only." />
      {data.modelCatalog.diagnostic && <div className="alert"><strong>Catalog diagnostic</strong><span>{data.modelCatalog.diagnostic}</span></div>}
      <Panel title="Providers" action={<span className="panel-tag">read only</span>}>
        <div className="provider-grid">
          {data.modelCatalog.providers.map((provider) => (
            <article className="provider-card" key={provider.id}>
              <div><span className={`status-dot ${provider.configured ? "status-available" : "status-planned"}`} /><strong>{provider.name}</strong></div>
              <code>{provider.id}</code>
              <p>{provider.configured ? provider.authLabel ?? provider.authSource ?? "Configured" : "Not configured"}</p>
              <small>{provider.modelCount} models</small>
            </article>
          ))}
        </div>
      </Panel>
      <Panel title="Known models" action={<span className="panel-tag">{data.modelCatalog.models.length}</span>}>
        <div className="model-table" role="table" aria-label="Known Pi models">
          {data.modelCatalog.models.slice(0, 100).map((model) => (
            <div className="model-row" role="row" key={`${model.providerId}/${model.id}`}>
              <span><strong>{model.name}</strong><small>{model.providerId}/{model.id}</small></span>
              <span>{model.api}</span><span>{formatNumber(model.contextWindow)} ctx</span><span>{model.reasoning ? "reasoning" : "standard"}</span>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}

function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="page-heading"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></header>;
}

function Metric({ label, value, note }: { label: string; value: string | number; note: string }) {
  return <article className="metric"><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;
}

function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="panel"><header><h2>{title}</h2>{action}</header><div className="panel-body">{children}</div></section>;
}

function NovelCard({ novel }: { novel: NovelSummary }) {
  return <Link to="/novels/$sourceId" params={{ sourceId: novel.id }} className="novel-card"><span className="book-spine" /><div><span className="eyebrow">{novel.instanceCount} instances</span><h3>{novel.title}</h3><p>{novel.sourcePath}</p><small>{formatBytes(novel.bytes)} · {formatDate(novel.updatedAt)}</small></div></Link>;
}

function InstanceRow({ instance }: { instance: InstanceSummary }) {
  return <Link to="/instances/$branchId" params={{ branchId: instance.branchId }} className="instance-row"><span className={`branch-marker ${instance.active ? "branch-marker-active" : ""}`} /><span><strong>{instance.name}</strong><small>{instance.sourceTitle ?? instance.sourceId ?? "unscoped"}</small></span><span><strong>Step {instance.logicalStep}</strong><small>{instance.eventCount} events</small></span><code>{shortHash(instance.headCommitId)}</code></Link>;
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? "mono" : undefined}>{value}</dd></div>;
}

function PlannedCallout({ title, phase, body }: { title: string; phase: string; body: string }) {
  return <section className="planned-callout"><span>{phase}</span><div><h2>{title}</h2><p>{body}</p></div></section>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="empty-state"><span>◇</span><div><strong>{title}</strong><p>{body}</p></div></div>;
}

function MissingState({ kind, id }: { kind: string; id: string }) {
  return <div className="center-state"><span className="eyebrow">Not found</span><h1>Unknown {kind}</h1><p>No item with ID <code>{id}</code> exists in the current workspace.</p><Link to="/">Return to overview</Link></div>;
}

function LoadingState() {
  return <div className="center-state"><span className="loading-orbit" /><h1>Opening the world model</h1><p>Reading local catalog and Pi metadata…</p></div>;
}

function ErrorState({ error, retry }: { error: Error; retry: () => void }) {
  return <div className="center-state center-error"><span className="eyebrow">Bootstrap failed</span><h1>The local workspace could not be read</h1><p>{error.message}</p><button onClick={retry}>Try again</button></div>;
}

function shortHash(value: string): string { return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value; }
function formatBytes(bytes: number): string { return bytes < 1_024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1_024).toFixed(1)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`; }
function formatDate(value: string): string { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)); }
function formatDateTime(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function formatNumber(value: number): string { return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value); }

import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  useNavigate,
  useParams,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import {
  activatePlaySession,
  answerAuthInteraction,
  cancelOperation,
  clearPlayConversation,
  createPlaySession,
  enterPlaySession,
  fetchBootstrap,
  fetchCharacters,
  fetchInstance,
  fetchModelProfiles,
  fetchOperation,
  fetchOperations,
  fetchPlaySession,
  fetchPreparation,
  fetchSourcePlayRoles,
  fetchTraceRuns,
  forkInstance,
  loginProvider,
  logoutProvider,
  removePlaySession,
  retryNarration,
  restorePlaySession,
  startPlayerMove,
  startFreshPlay,
  startSceneNarration,
  updatePlaySession,
  updateModelProfile,
} from "./api";
import {
  CompilerWorkbenchPage,
  NewNovelPage,
  preparationKey,
} from "./compiler-pages";
import {
  TraceDetailPage,
  TraceDrawer,
  TraceListPage,
  traceRunKey,
  traceRunsQueryKey,
} from "./trace-pages";
import { MaintenanceControl } from "./maintenance-dialog";
import { LanguageSwitcher, useI18n } from "./i18n";
import { narrationStreamStore, useNarrationStream } from "./narration-stream-store";
import { canRetrySameRequest, recoveryInstruction, webErrorDetail } from "./recovery";
import {
  operationSnapshotSchema,
  authInteractionSnapshotSchema,
  narrationRetryResultSchema,
  ontologyViewSchema,
  playOperationResultSchema,
  sceneNarrationResultSchema,
  webEventSchema,
  type BootstrapResponse,
  type InstanceSummary,
  type NovelSummary,
  type OperationSnapshot,
  type ModelProfileSummary,
  type ModelRole,
  type ModelSummary,
  type ProviderSummary,
  type PlaySessionSummary,
  type PlayerChoiceSummary,
} from "../../../src/web/contracts";

interface RouterContext {
  queryClient: QueryClient;
}

const bootstrapQueryKey = ["bootstrap"] as const;
const playSessionKey = (sessionId: string) => ["play-session", sessionId] as const;
const operationsKey = (sessionId: string) => ["operations", sessionId] as const;
const operationKey = (operationId: string) => ["operation", operationId] as const;
const LazyOntologyPage = lazy(() => import("./ontology-page").then((module) => ({ default: module.OntologyPage })));

function useBootstrap() {
  return useQuery({ queryKey: bootstrapQueryKey, queryFn: ({ signal }) => fetchBootstrap(signal) });
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: RootLayout });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardPage });
const newNovelRoute = createRoute({ getParentRoute: () => rootRoute, path: "/novels/new", component: NewNovelRoutePage });
const novelRoute = createRoute({ getParentRoute: () => rootRoute, path: "/novels/$sourceId", component: NovelPage });
const compileRoute = createRoute({ getParentRoute: () => rootRoute, path: "/novels/$sourceId/compile", component: CompilerRoutePage });
const ontologyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/novels/$sourceId/ontology/$view",
  validateSearch: ontologyRouteSearch,
  component: OntologyRoutePage,
});
const instanceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/instances/$branchId", component: InstancePage });
const sessionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/play/$sessionId", component: SessionPage });
const sessionTraceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/play/$sessionId/trace/$runId", component: SessionTraceRoutePage });
const tracesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/traces", component: TracesRoutePage });
const traceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/traces/$runId", component: TraceRoutePage });
const modelsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/models", component: ModelsPage });
const routeTree = rootRoute.addChildren([indexRoute, newNovelRoute, novelRoute, compileRoute, ontologyRoute, instanceRoute, sessionRoute, sessionTraceRoute, tracesRoute, traceRoute, modelsRoute]);

export const router = createRouter({ routeTree, context: { queryClient: undefined! } });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function RootLayout() {
  const { t } = useI18n();
  const query = useBootstrap();
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<"connecting" | "online" | "offline">("connecting");
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const operations = useQuery({
    queryKey: ["operations"],
    queryFn: ({ signal }) => fetchOperations(undefined, signal),
    refetchInterval: 2_000,
  });

  useEffect(() => {
    const source = new EventSource("/api/v1/events");
    source.onopen = () => {
      setConnection("online");
      // The SSE cursor is process-local while operations, traces, sessions,
      // and world truth are durable. Every initial connection/reconnection
      // therefore refreshes active authoritative snapshots before relying on
      // the live tail; this also closes cursor gaps after a host restart.
      void queryClient.invalidateQueries({ refetchType: "active" });
    };
    source.onerror = () => setConnection("offline");
    const onCatalog = () => void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
    const onOperation = (raw: Event) => {
      const event = parseServerEvent(raw);
      if (!event) return;
      const operation = operationSnapshotSchema.safeParse(event.data.operation);
      if (!operation.success) return;
      queryClient.setQueryData(operationKey(operation.data.id), operation.data);
      void queryClient.invalidateQueries({ queryKey: ["operations"], exact: true });
      void queryClient.invalidateQueries({ queryKey: operationsKey(operation.data.scopeId) });
      if (operation.data.runId) {
        void queryClient.invalidateQueries({ queryKey: traceRunsQueryKey });
        void queryClient.invalidateQueries({ queryKey: traceRunKey(operation.data.runId) });
        void queryClient.invalidateQueries({ queryKey: ["trace-call", operation.data.runId] });
      }
      if (isTerminal(operation.data.status)) {
        narrationStreamStore.complete(operation.data.id);
        void queryClient.invalidateQueries({ queryKey: playSessionKey(operation.data.scopeId) });
        if (operation.data.kind === "prepare") {
          void queryClient.invalidateQueries({ queryKey: preparationKey(operation.data.scopeId) });
          void queryClient.invalidateQueries({ queryKey: ["proposals", operation.data.scopeId] });
        }
        void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
      }
    };
    const onNarrationDelta = (raw: Event) => {
      const event = parseServerEvent(raw);
      if (!event?.operationId || typeof event.data.delta !== "string") return;
      narrationStreamStore.append(event.operationId, event.data.delta);
    };
    const onPlayChanged = (raw: Event) => {
      const event = parseServerEvent(raw);
      if (!event) return;
      const sessionId = typeof event.data.sessionId === "string" ? event.data.sessionId : undefined;
      if (sessionId) void queryClient.invalidateQueries({ queryKey: playSessionKey(sessionId) });
    };
    source.addEventListener("catalog.invalidated", onCatalog);
    source.addEventListener("operation.changed", onOperation);
    source.addEventListener("play.narration.delta", onNarrationDelta);
    source.addEventListener("play.narration.completed", onPlayChanged);
    source.addEventListener("play.message.appended", onPlayChanged);
    source.addEventListener("model.catalog.changed", onCatalog);
    return () => {
      source.removeEventListener("catalog.invalidated", onCatalog);
      source.removeEventListener("operation.changed", onOperation);
      source.removeEventListener("play.narration.delta", onNarrationDelta);
      source.removeEventListener("play.narration.completed", onPlayChanged);
      source.removeEventListener("play.message.appended", onPlayChanged);
      source.removeEventListener("model.catalog.changed", onCatalog);
      source.close();
    };
  }, [queryClient]);

  const data = query.data;
  const activeOperations = operations.data?.filter((operation) => !isTerminal(operation.status)) ?? [];
  const visibleSessions = data?.catalog.playSessions.filter((session) => showArchivedSessions || session.status !== "archived") ?? [];
  const archivedSessionCount = data?.catalog.playSessions.filter((session) => session.status === "archived").length ?? 0;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">{t("Skip to content")}</a>
      <button className={navigationOpen ? "sidebar-backdrop sidebar-backdrop-visible" : "sidebar-backdrop"} type="button" aria-label={t("Close navigation")} onClick={() => setNavigationOpen(false)} />
      <aside className={navigationOpen ? "sidebar sidebar-open" : "sidebar"}>
        <Link to="/" className="brand" activeOptions={{ exact: true }}>
          <span className="brand-mark">NW</span>
          <span><strong>Novel World</strong><small>Harness</small></span>
        </Link>
        <nav aria-label={t("Workspace")} className="primary-nav" onClick={(event) => { if ((event.target as HTMLElement).closest("a")) setNavigationOpen(false); }}>
          <NavSection label={t("Workspace")}><Link to="/" activeOptions={{ exact: true }} className="nav-link">{t("Overview")}</Link></NavSection>
          <NavSection label={t("Story worlds")} count={data?.catalog.novels.length}>
            <Link to="/novels/new" className="nav-link nav-link-new"><span>＋ {t("Register novel")}</span></Link>
            <StoryWorldNavigation
              novels={data?.catalog.novels ?? []}
              instances={data?.catalog.instances ?? []}
              sessions={visibleSessions}
            />
            {!data?.catalog.novels.length && !data?.catalog.instances.length && !visibleSessions.length && <span className="nav-empty">{t("No registered novels")}</span>}
            {archivedSessionCount > 0 && <button type="button" className="nav-archive-toggle" onClick={() => setShowArchivedSessions((value) => !value)}>{showArchivedSessions ? t("Hide archived") : t("Show archived ({count})", { count: archivedSessionCount })}</button>}
          </NavSection>
        </nav>
        <div className="sidebar-footer">
          <Link to="/traces" className="nav-link">{t("Trace ledger")}</Link>
          <Link to="/settings/models" className="nav-link">{t("Model catalog")}</Link>
          <div className={`connection connection-${connection}`}><span />{t(connection)}</div>
        </div>
      </aside>
      <main className="workspace" id="main-content" tabIndex={-1}>
        <header className="topbar">
          <div className="topbar-leading">
            <button className="mobile-nav-trigger" type="button" aria-label={t("Open navigation")} aria-expanded={navigationOpen} onClick={() => setNavigationOpen(true)}><span /><span /><span /></button>
            <div><span className="eyebrow">{t("Local workspace")}</span><strong>{data?.workspace.displayName ?? "Loading…"}</strong></div>
          </div>
          <div className="topbar-actions"><div className="topbar-meta"><span>API {data?.apiVersion ?? "v1"}</span><span>Pi-backed</span><span>{t("No app login")}</span></div><LanguageSwitcher /></div>
        </header>
        {activeOperations.length > 0 && <OperationTray operations={activeOperations} csrfToken={data?.csrfToken ?? ""} />}
        <section className="page">
          {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : <Outlet />}
        </section>
      </main>
    </div>
  );
}

function OperationTray({ operations, csrfToken }: { operations: OperationSnapshot[]; csrfToken: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: (operationId: string) => cancelOperation(operationId, csrfToken),
    onSuccess: (operation) => {
      queryClient.setQueryData(operationKey(operation.id), operation);
      void queryClient.invalidateQueries({ queryKey: ["operations"], exact: true });
    },
  });
  return <section className="operation-tray" aria-label={t("Active operations")}><span className="eyebrow">{t("Active")}</span><div>{operations.slice(0, 4).map((operation) => <article key={operation.id}><OperationJump operation={operation} /><span className={`operation-status operation-${operation.status}`}>{operation.phase}</span>{operation.cancellable && <button type="button" disabled={!csrfToken || cancel.isPending} onClick={() => cancel.mutate(operation.id)}>{operation.commitBoundaryCrossed ? t("Stop") : t("Cancel")}</button>}</article>)}</div>{operations.length > 4 && <small>+{t("{count} more", { count: operations.length - 4 })}</small>}</section>;
}

function OperationJump({ operation }: { operation: OperationSnapshot }) {
  const label = <span><strong>{operation.kind.replaceAll("-", " ")}</strong><small>{shortHash(operation.id)}</small></span>;
  if (operation.kind === "prepare") return <Link to="/novels/$sourceId/compile" params={{ sourceId: operation.scopeId }}>{label}</Link>;
  if (operation.kind === "player-move" || operation.kind === "scene-narration" || operation.kind === "narration-retry") return <Link to="/play/$sessionId" params={{ sessionId: operation.scopeId }}>{label}</Link>;
  if (operation.kind === "provider-login") return <Link to="/settings/models">{label}</Link>;
  return <Link to="/">{label}</Link>;
}

function NavSection({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  return <section className="nav-section"><h2>{label}{count !== undefined && <span>{count}</span>}</h2>{children}</section>;
}

type StoryWorldNavigationProps = {
  novels: NovelSummary[];
  instances: InstanceSummary[];
  sessions: PlaySessionSummary[];
};

function StoryWorldNavigation({ novels, instances, sessions }: StoryWorldNavigationProps) {
  const { t } = useI18n();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [collapsedNovelIds, setCollapsedNovelIds] = useState<Set<string>>(() => new Set());
  const selectedSessionId = routeResourceId(pathname, "play");
  const selectedSession = sessions.find((session) => session.id === selectedSessionId);
  const selectedBranchId = routeResourceId(pathname, "instances") ?? selectedSession?.branchId;
  const selectedInstance = instances.find((instance) => instance.branchId === selectedBranchId);
  const selectedSourceId = routeResourceId(pathname, "novels")
    ?? selectedInstance?.sourceId
    ?? selectedSession?.sourceId;
  const sessionsByBranch = new Map<string, PlaySessionSummary[]>();
  for (const session of sessions) {
    const branchSessions = sessionsByBranch.get(session.branchId) ?? [];
    branchSessions.push(session);
    sessionsByBranch.set(session.branchId, branchSessions);
  }
  const sourceForInstance = (instance: InstanceSummary) => instance.sourceId
    ?? sessionsByBranch.get(instance.branchId)?.find((session) => session.sourceId)?.sourceId;
  const knownSourceIds = new Set(novels.map((novel) => novel.id));
  const assignedBranchIds = new Set(instances
    .filter((instance) => {
      const sourceId = sourceForInstance(instance);
      return sourceId !== undefined && knownSourceIds.has(sourceId);
    })
    .map((instance) => instance.branchId));
  const unassignedInstances = instances.filter((instance) => !assignedBranchIds.has(instance.branchId));
  const knownBranchIds = new Set(instances.map((instance) => instance.branchId));
  const detachedSessions = sessions.filter((session) => !knownBranchIds.has(session.branchId));
  useEffect(() => {
    if (!selectedSourceId) return;
    setCollapsedNovelIds((current) => {
      if (!current.has(selectedSourceId)) return current;
      const next = new Set(current);
      next.delete(selectedSourceId);
      return next;
    });
  }, [selectedBranchId, selectedSessionId, selectedSourceId]);
  const toggleNovel = (sourceId: string) => setCollapsedNovelIds((current) => {
    const next = new Set(current);
    if (next.has(sourceId)) next.delete(sourceId);
    else next.add(sourceId);
    return next;
  });

  return (
    <div className="nav-world-tree" role="group" aria-label={t("Novel, world instance, and play session hierarchy")}>
      <ul className="nav-tree-novel-list">
        {novels.map((novel) => {
          const novelInstances = instances.filter((instance) => sourceForInstance(instance) === novel.id);
          const isExpanded = !collapsedNovelIds.has(novel.id);
          const sessionCount = novelInstances.reduce((count, instance) => count + (sessionsByBranch.get(instance.branchId)?.length ?? 0), 0);
          return (
            <li className={selectedSourceId === novel.id ? "nav-tree-novel nav-tree-novel-context" : "nav-tree-novel"} key={novel.id}>
              <div className="nav-tree-novel-row">
                <button
                  type="button"
                  className="nav-tree-disclosure"
                  aria-expanded={isExpanded}
                  aria-controls={`nav-novel-${novel.id}`}
                  aria-label={isExpanded ? t("Collapse {title}", { title: novel.title }) : t("Expand {title}", { title: novel.title })}
                  onClick={() => toggleNovel(novel.id)}
                >
                  <span aria-hidden="true" />
                </button>
                <Link
                  to="/novels/$sourceId"
                  params={{ sourceId: novel.id }}
                  className={selectedSourceId === novel.id ? "nav-tree-novel-link nav-tree-context-link" : "nav-tree-novel-link"}
                >
                  <span className="nav-tree-icon nav-tree-icon-novel" aria-hidden="true" />
                  <span className="nav-tree-label">{novel.title}</span>
                  <span className="nav-tree-meta" title={t("{count} worlds · {sessions} sessions", { count: novelInstances.length, sessions: sessionCount })}>{novelInstances.length}</span>
                </Link>
              </div>
              <div id={`nav-novel-${novel.id}`} hidden={!isExpanded}>
                {novelInstances.length > 0
                  ? <InstanceNavigationList instances={novelInstances} sessionsByBranch={sessionsByBranch} selectedBranchId={selectedBranchId} selectedSessionId={selectedSessionId} />
                  : <span className="nav-tree-empty">{t("No world instance yet")}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      {unassignedInstances.length > 0 && <NavigationOrphanGroup label={t("Unassigned worlds")} count={unassignedInstances.length}>
        <InstanceNavigationList instances={unassignedInstances} sessionsByBranch={sessionsByBranch} selectedBranchId={selectedBranchId} selectedSessionId={selectedSessionId} />
      </NavigationOrphanGroup>}
      {detachedSessions.length > 0 && <NavigationOrphanGroup label={t("Detached history")} count={detachedSessions.length}>
        <ul className="nav-tree-detached-list">
          {detachedSessions.map((session) => <SessionNavigationItem key={session.id} session={session} selected={session.id === selectedSessionId} />)}
        </ul>
      </NavigationOrphanGroup>}
    </div>
  );
}

function InstanceNavigationList({
  instances,
  sessionsByBranch,
  selectedBranchId,
  selectedSessionId,
}: {
  instances: InstanceSummary[];
  sessionsByBranch: Map<string, PlaySessionSummary[]>;
  selectedBranchId?: string;
  selectedSessionId?: string;
}) {
  const { t } = useI18n();
  return (
    <ul className="nav-tree-instance-list">
      {instances.map((instance) => {
        const branchSessions = sessionsByBranch.get(instance.branchId) ?? [];
        const inSelectedPath = selectedBranchId === instance.branchId;
        return (
          <li className={inSelectedPath ? "nav-tree-instance nav-tree-instance-context" : "nav-tree-instance"} key={instance.branchId}>
            <Link
              to="/instances/$branchId"
              params={{ branchId: instance.branchId }}
              className={inSelectedPath ? "nav-tree-instance-link nav-tree-context-link" : "nav-tree-instance-link"}
            >
              <span className="nav-tree-icon nav-tree-icon-instance" aria-hidden="true" />
              <span className="nav-tree-label" title={`${instance.name} · ${instance.branchId}`}>{instance.name}</span>
              <span className="nav-tree-meta">{t("step")} {instance.logicalStep}</span>
              {branchSessions.length > 0 && <span className="nav-tree-count" title={t("{count} play sessions", { count: branchSessions.length })}>{branchSessions.length}</span>}
            </Link>
            {branchSessions.length > 0
              ? <ul className="nav-tree-session-list">{branchSessions.map((session) => <SessionNavigationItem key={session.id} session={session} selected={session.id === selectedSessionId} />)}</ul>
              : <span className="nav-tree-empty nav-tree-empty-session">{t("No play sessions")}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function SessionNavigationItem({ session, selected }: { session: PlaySessionSummary; selected: boolean }) {
  const { t } = useI18n();
  return (
    <li className="nav-tree-session">
      <Link
        to="/play/$sessionId"
        params={{ sessionId: session.id }}
        className={selected ? "nav-tree-session-link nav-tree-context-link" : "nav-tree-session-link"}
      >
        <span className={`nav-tree-session-dot nav-tree-session-${session.status}`} aria-hidden="true" />
        <span className="nav-tree-label" title={session.title}>{session.actorName ?? session.actorId}</span>
        <span className="nav-tree-status">{t(session.status)}</span>
      </Link>
    </li>
  );
}

function NavigationOrphanGroup({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return <section className="nav-tree-orphan-group"><header><span>{label}</span><small>{count}</small></header>{children}</section>;
}

function routeResourceId(pathname: string, resource: "novels" | "instances" | "play"): string | undefined {
  const match = pathname.match(new RegExp(`^/${resource}/([^/]+)`));
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function DashboardPage() {
  const { t } = useI18n();
  const { data } = useBootstrap();
  if (!data) return null;
  const configuredProviders = data.modelCatalog.providers.filter((provider) => provider.configured).length;
  return (
    <>
      <PageHeading eyebrow={t("Executable novel workspace")} title={t("World control room")} description={t("Inspect compiled worlds, enter a character, and follow every Pi-backed play operation from one local interface.")} />
      <div className="metric-grid">
        <Metric label={t("Novels")} value={data.catalog.novels.length} note={t("registered sources")} />
        <Metric label={t("Instances")} value={data.catalog.instances.length} note={t("committed branches")} />
        <Metric label={t("Play sessions")} value={data.catalog.playSessions.length} note={t("recoverable contexts")} />
        <Metric label={t("Providers")} value={configuredProviders} note={t("{count} known models", { count: data.modelCatalog.models.length })} />
      </div>
      <div className="content-grid">
        <Panel title={t("Recent instances")} action={<span className="panel-tag">{t("world truth")}</span>}>
          {data.catalog.instances.length ? data.catalog.instances.slice(0, 5).map((instance) => <InstanceRow key={instance.branchId} instance={instance} />) : <EmptyState title={t("No playable world yet")} body={t("Prepare a registered novel to create its first committed branch.")} />}
        </Panel>
        <Panel title={t("Delivery map")} action={<span className="panel-tag">MVP</span>}>
          <div className="feature-list">
            {data.features.map((feature) => (
              <div className="feature-row" key={feature.id}>
                <span className={`status-dot status-${feature.status}`} /><strong>{feature.id.replace("-", " ")}</strong><span>{t("Phase {phase}", { phase: feature.phase })}</span><small>{t(feature.status)}</small>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Panel title={t("Registered novels")} action={<span className="panel-tag">{t("source evidence")}</span>}>
        <div className="card-grid">
          {data.catalog.novels.map((novel) => <NovelCard key={novel.id} novel={novel} />)}
          {!data.catalog.novels.length && <Link to="/novels/new" className="empty-action-card"><span>＋</span><strong>{t("Register the first novel")}</strong><p>{t("Upload UTF-8 text or paste source evidence directly in the browser.")}</p></Link>}
        </div>
      </Panel>
    </>
  );
}

function NovelPage() {
  const { t, localeTag } = useI18n();
  const { sourceId } = useParams({ from: novelRoute.id });
  const { data } = useBootstrap();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const novel = data?.catalog.novels.find((candidate) => candidate.id === sourceId);
  const preparation = useQuery({
    queryKey: preparationKey(sourceId),
    queryFn: ({ signal }) => fetchPreparation(sourceId, undefined, signal),
    enabled: Boolean(novel),
  });
  if (!data || !novel) return <MissingState kind="novel" id={sourceId} />;
  const instances = data.catalog.instances.filter((instance) => instance.sourceId === novel.id);
  const snapshot = preparation.data;
  return (
    <>
      <div className="session-heading">
        <PageHeading eyebrow={t("Source evidence")} title={novel.title} description={novel.sourcePath} />
        <div className="session-toolbar novel-heading-actions">
          <NovelPlayLauncher novel={novel} sessions={data.catalog.playSessions} csrfToken={data.csrfToken} />
          <Link className="secondary-button" to="/novels/$sourceId/compile" params={{ sourceId }}>{t("Open compiler workbench")}</Link>
        </div>
      </div>
      <div className="metric-grid">
        <Metric label={t("Size")} value={formatBytes(novel.bytes)} note={t("immutable source")} />
        <Metric label={t("Instances")} value={novel.instanceCount} note={t("owned branches")} />
        <Metric label={t("Preparation")} value={snapshot ? t(snapshot.stage) : "…"} note={snapshot ? t("{done}/{total} batches", { done: snapshot.progress.completedBatches, total: snapshot.progress.totalBatches }) : t("reading checkpoint")} />
        <Metric label={t("Updated")} value={formatDate(novel.updatedAt, localeTag)} note={novel.id} />
      </div>
      <Panel title={t("Preparation checkpoint")} action={snapshot ? <span className={`operation-status operation-${snapshot.stage === "ready" ? "succeeded" : snapshot.stage === "repair" ? "failed" : "running"}`}>{t(snapshot.stage)}</span> : <span className="panel-tag">{t("loading")}</span>}>
        {preparation.isPending ? <InlineLoading label={t("Reading compiler checkpoints…")} /> : preparation.isError ? <InlineError error={preparation.error} /> : snapshot ? <div className="novel-preparation-summary">
          <div className="novel-progress"><span><strong>{Math.round(snapshot.progress.ratio * 100)}%</strong><small>{t("{percent}% evidence batches checkpointed", { percent: Math.round(snapshot.progress.ratio * 100) })}</small></span><div><i style={{ width: `${Math.round(snapshot.progress.ratio * 100)}%` }} /></div></div>
          <dl className="detail-list">
            <Detail label={t("Next action")} value={t(snapshot.nextAction.replaceAll("-", " "))} />
            <Detail label={t("Pending proposals")} value={String(snapshot.proposalCounts.pending)} />
            <Detail label={t("Suggested branch")} value={snapshot.branchId} mono />
            <Detail label={t("Publication readiness")} value={t(snapshot.audit?.readiness.publication ?? "unknown")} />
          </dl>
          {snapshot.repairReasons.length > 0 && <div className="proposal-validation-errors">{snapshot.repairReasons.slice(0, 4).map((reason) => <p key={reason}>{reason}</p>)}</div>}
          <Link className="secondary-button" to="/novels/$sourceId/compile" params={{ sourceId }}>{snapshot.stage === "review" ? t("Review proposal inbox") : snapshot.stage === "create-branch" ? t("Create world instance") : t("Continue preparation")}</Link>
        </div> : null}
      </Panel>
      <Panel title={t("World instances")} action={<span className="panel-tag">{t("committed")}</span>}>
        {instances.length ? instances.map((instance) => <InstanceRow key={instance.branchId} instance={instance} />) : <EmptyState title={t("No committed instance")} body={t("This source is registered but does not yet own a playable branch.")} />}
      </Panel>
      <Panel title={t("Ontology workbench")} action={<span className="panel-tag">{t("five projections")}</span>}>
        <div className="ontology-launch-grid">
          {[
            ["model", t("World model"), t("Entities, claims, goals, and character semantics")],
            ["events", t("Events"), t("Canon, committed history, causality, and possibilities")],
            ["places", t("Places"), t("Spatial topology and validity at committed time")],
            ["rules", t("Rules"), t("Effective rules, authority, and jurisdiction")],
            ["provenance", t("Provenance"), t("Evidence → proposal → validation → artifact → history")],
          ].map(([view, label, body]) => <Link key={view} to="/novels/$sourceId/ontology/$view" params={{ sourceId, view }} className="ontology-launch-card"><span>↗</span><strong>{label}</strong><p>{body}</p></Link>)}
        </div>
      </Panel>
      <Panel title={t("Maintenance")} action={<span className="panel-tag">{t("exact preview required")}</span>}>
        <div className="maintenance-zone">
          <div><strong>{t("Reset derived analysis")}</strong><p>{t("Keep the registration, immutable source bytes, committed branches, sessions, pinned prepared revisions, and traces. Remove source-scoped compiler material so the novel can be parsed again.")}</p></div>
          <MaintenanceControl action="reset-analysis" targetId={sourceId} csrfToken={data.csrfToken} triggerLabel={t("Preview analysis reset")} onCompleted={() => {
            void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
            void queryClient.invalidateQueries({ queryKey: preparationKey(sourceId) });
            void navigate({ to: "/novels/$sourceId/compile", params: { sourceId } });
          }} />
          <div><strong>{t("Remove novel")}</strong><p>{t("Remove its registration, analysis, and owned branches. Sessions, conversations, archived content-addressed source bytes, and traces remain as detached history.")}</p></div>
          <MaintenanceControl action="remove-novel" targetId={sourceId} csrfToken={data.csrfToken} triggerLabel={t("Preview novel removal")} onCompleted={() => {
            void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
            void navigate({ to: "/" });
          }} />
        </div>
      </Panel>
    </>
  );
}

function NovelPlayLauncher({
  novel,
  sessions,
  csrfToken,
}: {
  novel: NovelSummary;
  sessions: PlaySessionSummary[];
  csrfToken: string;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [actorId, setActorId] = useState("");
  const [roleQuery, setRoleQuery] = useState("");
  const sourceSessions = sessions.filter((session) => session.sourceId === novel.id && session.status !== "detached");
  const roles = useQuery({
    queryKey: ["source-play-roles", novel.id],
    queryFn: ({ signal }) => fetchSourcePlayRoles(novel.id, signal),
    enabled: open,
  });
  const selectedRole = roles.data?.roles.find((role) => role.id === actorId);
  const filterRoles = (value: string) => roles.data?.roles.filter((role) => {
    const query = value.normalize("NFKC").trim().toLocaleLowerCase();
    if (!query) return true;
    return [role.canonicalName, role.id, ...role.aliases]
      .some((value) => value.normalize("NFKC").toLocaleLowerCase().includes(query));
  }) ?? [];
  const visibleRoles = filterRoles(roleQuery);
  const startMutation = useMutation({
    mutationFn: () => startFreshPlay({
      sourceId: novel.id,
      preparedRevisionHash: roles.data!.preparedRevisionHash,
      actorId,
      clientRequestId: requestId("start-fresh-play"),
    }, csrfToken),
    onSuccess: async (result) => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
      await navigate({ to: "/play/$sessionId", params: { sessionId: result.session.session.id } });
    },
  });

  useEffect(() => {
    if (!open || !roles.data) return;
    setActorId((current) => {
      if (roles.data.roles.some((role) => role.id === current)) return current;
      return roles.data.roles[0]?.id ?? "";
    });
  }, [roles.data, open]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || startMutation.isPending) return;
      setOpen(false);
      startMutation.reset();
      window.requestAnimationFrame(() => trigger.current?.focus());
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [startMutation.isPending, open]);

  const openLauncher = () => {
    setActorId("");
    setRoleQuery("");
    startMutation.reset();
    setOpen(true);
  };
  const closeLauncher = () => {
    if (startMutation.isPending) return;
    setOpen(false);
    startMutation.reset();
    window.requestAnimationFrame(() => trigger.current?.focus());
  };
  const actionLabel = !selectedRole
    ? t("Choose a role to begin")
    : t("Start an independent instance as {character}", { character: selectedRole.canonicalName });

  return (
    <>
      <button ref={trigger} className="primary-button novel-play-trigger" type="button" aria-haspopup="dialog" onClick={openLauncher}>
        <span aria-hidden="true">▶</span>{t("Play")}
      </button>
      {open && <div className="novel-play-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeLauncher(); }}>
        <section className="novel-play-dialog" role="dialog" aria-modal="true" aria-labelledby={`novel-play-title-${novel.id}`}>
          <header>
            <div><span className="eyebrow">{t("New independent play")}</span><h2 id={`novel-play-title-${novel.id}`}>{t("Enter {title}", { title: novel.title })}</h2><p>{t("Choose a character. The harness will create a new isolated world instance from the frozen novel base; no existing playthrough will be reused or changed.")}</p></div>
            <button type="button" aria-label={t("Close Play launcher")} disabled={startMutation.isPending} onClick={closeLauncher}>×</button>
          </header>
          <div className="novel-play-body">
            {roles.isPending ? <InlineLoading label={t("Reading the frozen world base…")} /> : roles.isError ? <InlineError error={roles.error} /> : roles.data?.roles.length ? <>
              <div className="novel-play-branch novel-play-base">
                <span>{t("Frozen world base")}</span>
                <strong>{novel.title}</strong>
                <small><code>{shortHash(roles.data.preparedRevisionHash)}</code><span>{t("Every new instance starts from this immutable revision.")}</span></small>
              </div>
              <section className="novel-play-roles" aria-labelledby={`novel-play-roles-${novel.id}`}>
                <header><div><span className="eyebrow">{t("Choose a role")}</span><strong id={`novel-play-roles-${novel.id}`}>{t("Whose story will begin?")}</strong></div><small>{t("Each choice creates a separate branch at that character's grounded entry checkpoint.")}</small></header>
                <label className="novel-play-role-search"><span>{t("Find a role")}</span><input autoFocus value={roleQuery} onChange={(event) => {
                  const value = event.target.value;
                  const matches = filterRoles(value);
                  setRoleQuery(value);
                  if (!matches.some((role) => role.id === actorId)) setActorId(matches[0]?.id ?? "");
                  startMutation.reset();
                }} placeholder={t("Search name, alias, or ID")} /></label>
                {visibleRoles.length ? <div className="character-picker novel-play-character-grid">
                  {visibleRoles.map((role) => (
                    <label key={role.id} className={actorId === role.id ? "character-option character-option-selected" : "character-option"}>
                      <input type="radio" name={`novel-play-actor-${novel.id}`} value={role.id} checked={actorId === role.id} onChange={() => { setActorId(role.id); startMutation.reset(); }} />
                      <span><strong>{role.canonicalName}</strong><small>{t("Starts at {entry}", { entry: role.entryTitle })}</small></span>
                      <span className="novel-play-role-meta"><em>{role.entryKind === "opening" ? t("Novel opening") : t("Character entry")}</em><code>{role.id}</code></span>
                    </label>
                  ))}
                </div> : <EmptyState title={t("No matching role")} body={t("Try a character name, alias, or compiled entity ID.")} />}
              </section>
              {startMutation.error && <InlineError error={startMutation.error} />}
            </> : <EmptyState title={t("No grounded play role")} body={t("Compile and publish a frozen base with at least one embodied character entry before starting play.")} />}
            {sourceSessions.length > 0 && <section className="novel-play-saved-list" aria-label={t("Continue existing playthroughs")}>
              <header><span>{t("Continue existing playthroughs")}</span><small>{t("Opening one of these resumes its own world history; it does not create a new instance.")}</small></header>
              <div>{sourceSessions.slice(0, 5).map((session) => <Link key={session.id} to="/play/$sessionId" params={{ sessionId: session.id }} onClick={() => setOpen(false)}><span><strong>{session.title}</strong><small>{session.actorName ?? session.actorId}</small></span><em>{t(session.status)}</em></Link>)}</div>
            </section>}
          </div>
          <footer>
            {(roles.isError || !roles.data?.roles.length) && <Link className="secondary-button" to="/novels/$sourceId/compile" params={{ sourceId: novel.id }} onClick={() => setOpen(false)}>{t("Open compiler workbench")}</Link>}
            <button type="button" className="text-button" disabled={startMutation.isPending} onClick={closeLauncher}>{t("Cancel")}</button>
            {roles.data?.roles.length ? <button type="button" className="primary-button" disabled={!selectedRole || startMutation.isPending} onClick={() => startMutation.mutate()}>{startMutation.isPending ? t("Creating isolated world…") : actionLabel}<span aria-hidden="true"> →</span></button> : null}
          </footer>
        </section>
      </div>}
    </>
  );
}

function NewNovelRoutePage() {
  const { data } = useBootstrap();
  const navigate = useNavigate();
  return <NewNovelPage csrfToken={data?.csrfToken ?? ""} onRegistered={(result) => void navigate({ to: "/novels/$sourceId/compile", params: { sourceId: result.source.id } })} />;
}

function CompilerRoutePage() {
  const { sourceId } = useParams({ from: compileRoute.id });
  const { data } = useBootstrap();
  const navigate = useNavigate();
  return <CompilerWorkbenchPage
    sourceId={sourceId}
    csrfToken={data?.csrfToken ?? ""}
    models={data?.modelCatalog.models ?? []}
    onInstanceCreated={(branchId) => void navigate({ to: "/instances/$branchId", params: { branchId } })}
  />;
}

function OntologyRoutePage() {
  const { sourceId, view: viewValue } = useParams({ from: ontologyRoute.id });
  const search = useSearch({ from: ontologyRoute.id });
  const { data } = useBootstrap();
  const navigate = useNavigate({ from: ontologyRoute.id });
  const view = ontologyViewSchema.safeParse(viewValue);
  if (!view.success) return <MissingState kind="ontology view" id={viewValue} />;
  return <Suspense fallback={<LoadingState label="Loading the graph renderer…" />}><LazyOntologyPage
    sourceId={sourceId}
    view={view.data}
    novel={data?.catalog.novels.find((candidate) => candidate.id === sourceId)}
    instances={data?.catalog.instances ?? []}
    initialBranchId={search.branchId}
    initialCommitId={search.atCommit}
    initialIncludeCanonicalFuture={search.includeCanonicalFuture}
    onScopeChange={(scope) => void navigate({ search: scope, replace: true })}
  /></Suspense>;
}

function InstancePage() {
  const { t, localeTag } = useI18n();
  const { branchId } = useParams({ from: instanceRoute.id });
  const { data } = useBootstrap();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detail = useQuery({
    queryKey: ["instance", branchId],
    queryFn: ({ signal }) => fetchInstance(branchId, signal),
  });
  const instance = detail.data?.instance ?? data?.catalog.instances.find((candidate) => candidate.branchId === branchId);
  const existingSession = data?.catalog.playSessions.find((session) => session.branchId === branchId);
  const characters = useQuery({
    queryKey: ["characters", branchId, instance?.sourceId],
    queryFn: ({ signal }) => fetchCharacters(branchId, instance?.sourceId, signal),
    enabled: Boolean(instance),
  });
  const [actorId, setActorId] = useState("");
  const [forkBranchId, setForkBranchId] = useState("");
  const [forkName, setForkName] = useState("");
  const [forkCommitId, setForkCommitId] = useState("");
  const [openForkSession, setOpenForkSession] = useState(true);
  useEffect(() => {
    if (actorId) return;
    setActorId(existingSession?.actorId ?? characters.data?.characters[0]?.id ?? "");
  }, [actorId, characters.data, existingSession?.actorId]);
  useEffect(() => {
    if (!forkBranchId) setForkBranchId(`${branchId}-fork`);
    if (!forkCommitId && detail.data?.instance.headCommitId) setForkCommitId(detail.data.instance.headCommitId);
  }, [branchId, detail.data?.instance.headCommitId, forkBranchId, forkCommitId]);
  const createMutation = useMutation({
    mutationFn: () => createPlaySession({
      branchId,
      actorId,
      ...(instance?.sourceId ? { sourceId: instance.sourceId } : {}),
      clientRequestId: requestId("create-session"),
    }, data!.csrfToken),
    onSuccess: async (detail) => {
      await queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
      await navigate({ to: "/play/$sessionId", params: { sessionId: detail.session.id } });
    },
  });
  const forkMutation = useMutation({
    mutationFn: async () => {
      const forked = await forkInstance(branchId, {
        newBranchId: forkBranchId.trim(),
        ...(forkName.trim() ? { name: forkName.trim() } : {}),
        ...(forkCommitId ? { fromCommit: forkCommitId } : {}),
        clientRequestId: requestId("fork-instance"),
      }, data!.csrfToken);
      if (!openForkSession) return { forked };
      const playSession = await createPlaySession({
        branchId: forked.instance.branchId,
        actorId,
        ...(forked.instance.sourceId ? { sourceId: forked.instance.sourceId } : {}),
        clientRequestId: requestId("create-fork-session"),
      }, data!.csrfToken);
      return { forked, playSession };
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
      queryClient.setQueryData(["instance", result.forked.instance.branchId], undefined);
      await navigate(result.playSession
        ? { to: "/play/$sessionId", params: { sessionId: result.playSession.session.id } }
        : { to: "/instances/$branchId", params: { branchId: result.forked.instance.branchId } });
    },
  });
  if (detail.isPending && !instance) return <LoadingState label={t("Reading committed branch history…")} />;
  if (detail.isError && !instance) return <ErrorState error={detail.error} retry={() => void detail.refetch()} />;
  if (!instance) return <MissingState kind="instance" id={branchId} />;
  const history = detail.data?.history ?? [];
  return (
    <>
      <div className="session-heading">
        <PageHeading eyebrow={t("Committed branch")} title={instance.name} description={instance.sourceTitle ?? t("Unscoped legacy world")} />
        <div className="session-toolbar">{instance.sourceId && <Link className="secondary-button" to="/novels/$sourceId/ontology/$view" params={{ sourceId: instance.sourceId, view: "events" }} search={{ branchId }}>{t("Inspect ontology")}</Link>}<MaintenanceControl action="remove-instance" targetId={branchId} csrfToken={data?.csrfToken ?? ""} triggerLabel={t("Preview instance removal")} onCompleted={() => {
          void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
          void navigate(instance.sourceId ? { to: "/novels/$sourceId", params: { sourceId: instance.sourceId } } : { to: "/" });
        }} /></div>
      </div>
      <div className="metric-grid">
        <Metric label={t("Story step")} value={instance.logicalStep} note={t("derived world time")} />
        <Metric label={t("Commits")} value={instance.commitCount} note={t("authoritative history")} />
        <Metric label={t("Events")} value={instance.eventCount} note={instance.lastEventTitle ?? t("no event title")} />
        <Metric label={t("Actor")} value={instance.actorName ?? "—"} note={instance.sessionAtHead ? t("session at head") : t("select below")} />
      </div>
      <div className="content-grid">
        <Panel title={t("Play this existing instance")} action={<span className="panel-tag">{t("same world history")}</span>}>
          {existingSession ? (
            <div className="character-picker">
              <p>{t("Continuing here resumes this instance's committed history. To choose any role from a clean beginning, start a new independent play from the novel page.")}</p>
              <div className="action-row"><Link className="primary-button" to="/play/$sessionId" params={{ sessionId: existingSession.id }}>{t("Continue this instance")}</Link></div>
            </div>
          ) : characters.isPending ? <InlineLoading label={t("Reading playable characters…")} /> : characters.isError ? <InlineError error={characters.error} /> : characters.data?.characters.length ? (
            <div className="character-picker">
              <p>{t("This opens a presentation session on the existing branch; it does not create a fresh world instance.")}</p>
              {characters.data.characters.map((character) => (
                <label key={character.id} className={actorId === character.id ? "character-option character-option-selected" : "character-option"}>
                  <input type="radio" name="actor" value={character.id} checked={actorId === character.id} onChange={() => setActorId(character.id)} />
                  <span><strong>{character.canonicalName}</strong><small>{character.availability === "entry-checkpoint" ? t("Starts at {entry}", { entry: character.entryTitle ?? t("first grounded scene") }) : character.locationName ?? character.locationId ?? t("Current branch head")}</small></span>
                  <code>{character.id}</code>
                </label>
              ))}
              <div className="action-row">
                <button className="primary-button" disabled={!actorId || createMutation.isPending} onClick={() => createMutation.mutate()}>{createMutation.isPending ? t("Opening…") : t("Open this existing instance")}</button>
              </div>
              {createMutation.error && <InlineError error={createMutation.error} />}
            </div>
          ) : <EmptyState title={t("No playable character at this head")} body={t("The branch needs at least one living, embodied compiled character before play can begin.")} />}
        </Panel>
        <Panel title={t("Branch identity")} action={<span className="panel-tag">{t("world truth")}</span>}>
          <dl className="detail-list">
            <Detail label={t("Branch ID")} value={instance.branchId} mono />
            <Detail label={t("Head commit")} value={instance.headCommitId} mono />
            <Detail label={t("Parent")} value={instance.parentBranchId ?? t("genesis")} mono />
            <Detail label={t("Prepared revision")} value={instance.preparedRevisionHash ?? t("legacy / unpinned")} mono />
            <Detail label={t("Updated")} value={formatDateTime(instance.updatedAt, localeTag)} />
          </dl>
        </Panel>
      </div>
      <div className="branch-workbench">
        <Panel title={t("Authoritative commit history")} action={<span className="panel-tag">{t("{count} commits", { count: history.length })}</span>}>
          {detail.isPending ? <InlineLoading label={t("Resolving ancestry…")} /> : detail.isError ? <InlineError error={detail.error} /> : history.length ? (
            <div className="branch-timeline">
              {[...history].reverse().map((commit, index) => (
                <article key={commit.id} className={commit.id === instance.headCommitId ? "branch-commit branch-commit-head" : "branch-commit"}>
                  <div className="branch-rail"><i /><span /></div>
                  <div className="branch-commit-body">
                    <header>
                      <span><strong>{commit.id === instance.headCommitId ? t("HEAD") : t("STEP {step}", { step: commit.logicalStep })}</strong><small>{t(commit.eventCount === 1 ? "{count} event" : "{count} events", { count: commit.eventCount })}</small></span>
                      <code>{commit.id}</code>
                    </header>
                    {commit.events.length ? <div className="branch-events">{commit.events.map((event) => <div key={event.hash}><span>◆</span><strong>{event.title}</strong><code>{event.eventId}</code>{event.possibilityId && <small>{t("possibility")} {event.possibilityId}</small>}</div>)}</div> : <p className="branch-genesis-note">{t("Genesis checkpoint — no event payload.")}</p>}
                    {index === 0 && <small className="branch-current-note">{t("Current derived world state projects from this ancestry.")}</small>}
                  </div>
                </article>
              ))}
            </div>
          ) : <EmptyState title={t("No ancestry available")} body={t("The instance exists, but its commit history could not be projected.")} />}
        </Panel>
        <Panel title={t("Fork timeline")} action={<span className="panel-tag">{t("counterfactual")}</span>}>
          <form className="fork-form" onSubmit={(event) => { event.preventDefault(); if (!forkMutation.isPending && forkBranchId.trim()) forkMutation.mutate(); }}>
            <p>{t("Create an independent branch from any committed ancestor. Future canon remains outside active branch truth.")}</p>
            <label className="field-label"><span>{t("New branch ID")}</span><input value={forkBranchId} onChange={(event) => setForkBranchId(event.target.value)} placeholder={`${branchId}-fork`} /></label>
            <label className="field-label"><span>{t("Display name")} <small>{t("optional")}</small></span><input value={forkName} onChange={(event) => setForkName(event.target.value)} placeholder={t("Alternative timeline")} /></label>
            <label className="field-label fork-commit-field"><span>{t("Fork from commit")}</span><select value={forkCommitId} onChange={(event) => setForkCommitId(event.target.value)}>
              {history.map((commit) => <option key={commit.id} value={commit.id}>{t("step")} {commit.logicalStep} · {shortHash(commit.id)}{commit.id === instance.headCommitId ? ` · ${t("HEAD")}` : ""}</option>)}
            </select></label>
            <label className="fork-session-option"><input type="checkbox" checked={openForkSession} onChange={(event) => setOpenForkSession(event.target.checked)} /><span><strong>{t("Open a new play session after forking")}</strong><small>{t("Enabled by default. The new session writes only to the child branch and creates no story event until you submit an action.")}</small></span></label>
            <div className="fork-truth-note"><span>{t("Truth boundary")}</span><small>{t("The child receives only ancestry through the selected commit. Trace data and future source events are not copied into world truth.")}</small></div>
            <button className="primary-button" type="submit" disabled={!data?.csrfToken || !forkBranchId.trim() || !forkCommitId || forkBranchId.trim() === branchId || (openForkSession && !actorId) || forkMutation.isPending}>{forkMutation.isPending ? (openForkSession ? t("Forking and opening…") : t("Forking…")) : (openForkSession ? t("Create new session") : t("Create timeline fork"))}</button>
            {forkMutation.error && <InlineError error={forkMutation.error} />}
          </form>
        </Panel>
      </div>
    </>
  );
}

function SessionPage() {
  const { t, localeTag } = useI18n();
  const { sessionId } = useParams({ from: sessionRoute.id });
  const bootstrap = useBootstrap();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detail = useQuery({ queryKey: playSessionKey(sessionId), queryFn: ({ signal }) => fetchPlaySession(sessionId, signal) });
  const operationList = useQuery({ queryKey: operationsKey(sessionId), queryFn: ({ signal }) => fetchOperations(sessionId, signal), refetchInterval: 2_000 });
  const traceRuns = useQuery({
    queryKey: [...traceRunsQueryKey, { sessionId, limit: 500 }],
    queryFn: ({ signal }) => fetchTraceRuns({ sessionId, limit: 500 }, signal),
    refetchInterval: (query) => query.state.data?.some((run) => run.status === "running") ? 1_500 : false,
  });
  const [selectedOperationId, setSelectedOperationId] = useState<string>();
  const effectiveOperationId = selectedOperationId
    ?? operationList.data?.find((operation) => !isTerminal(operation.status))?.id
    ?? operationList.data?.[0]?.id;
  const operation = useQuery({
    queryKey: operationKey(effectiveOperationId ?? "none"),
    queryFn: ({ signal }) => fetchOperation(effectiveOperationId!, signal),
    enabled: Boolean(effectiveOperationId),
    refetchInterval: (query) => isTerminal(query.state.data?.status) ? false : 750,
  });
  const streamed = useNarrationStream(effectiveOperationId);
  const [draft, setDraft] = useState("");
  const [affordanceId, setAffordanceId] = useState<string>();
  const [selectedTraceRunId, setSelectedTraceRunId] = useState<string>();
  const [edgePanelOpen, setEdgePanelOpen] = useState(false);
  const entryAttempt = useRef<string | undefined>(undefined);
  const transcriptElement = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const closeTraceDrawer = useCallback(() => setSelectedTraceRunId(undefined), []);
  const csrfToken = bootstrap.data?.csrfToken ?? "";
  const current = operation.data;
  const busy = Boolean(current && !isTerminal(current.status));

  useEffect(() => {
    document.body.classList.add("play-immersive-active");
    return () => document.body.classList.remove("play-immersive-active");
  }, []);

  useEffect(() => {
    const element = transcriptElement.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [detail.data?.messages.length, streamed]);

  useEffect(() => {
    if (!current || !isTerminal(current.status)) return;
    narrationStreamStore.complete(current.id);
    void queryClient.invalidateQueries({ queryKey: playSessionKey(sessionId) });
    void queryClient.invalidateQueries({ queryKey: operationsKey(sessionId) });
    void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
  }, [current?.id, current?.status, queryClient, sessionId]);

  const acceptOperation = (accepted: { operation: OperationSnapshot }) => {
    setSelectedOperationId(accepted.operation.id);
    queryClient.setQueryData(operationKey(accepted.operation.id), accepted.operation);
    narrationStreamStore.reset(accepted.operation.id);
  };
  const moveMutation = useMutation({
    mutationFn: () => startPlayerMove(sessionId, {
      text: draft,
      ...(affordanceId ? { affordanceId } : {}),
      expectedHead: detail.data!.headCommitId!,
      clientRequestId: requestId("move"),
    }, csrfToken),
    onSuccess: (accepted) => {
      acceptOperation(accepted);
      setDraft("");
      setAffordanceId(undefined);
    },
  });
  const narrationMutation = useMutation({
    mutationFn: () => startSceneNarration(sessionId, {
      purpose: detail.data?.messages.length ? "orientation" : "auto",
      expectedHead: detail.data!.headCommitId!,
      clientRequestId: requestId("scene"),
    }, csrfToken),
    onSuccess: acceptOperation,
  });
  const entryMutation = useMutation({
    mutationFn: () => enterPlaySession(sessionId, { intent: "play" }, csrfToken),
    onSuccess: (entry) => {
      if (entry.operation) acceptOperation({ operation: entry.operation });
    },
  });
  useEffect(() => {
    if (!detail.isSuccess || !csrfToken || entryAttempt.current === sessionId) return;
    entryAttempt.current = sessionId;
    entryMutation.mutate();
  }, [csrfToken, detail.isSuccess, sessionId]);
  const narrationRetryMutation = useMutation({
    mutationFn: () => retryNarration(sessionId, {
      sourceRunId: current!.runId!,
      expectedHead: detail.data!.headCommitId!,
      clientRequestId: requestId("narration-retry"),
    }, csrfToken),
    onSuccess: acceptOperation,
  });
  const cancelMutation = useMutation({
    mutationFn: () => cancelOperation(current!.id, csrfToken),
    onSuccess: (snapshot) => queryClient.setQueryData(operationKey(snapshot.id), snapshot),
  });
  const archiveMutation = useMutation({
    mutationFn: () => updatePlaySession(sessionId, { status: "archived", clientRequestId: requestId("archive-session") }, csrfToken),
    onSuccess: (next) => {
      queryClient.setQueryData(playSessionKey(sessionId), next);
      void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
    },
  });
  const restoreMutation = useMutation({
    mutationFn: () => restorePlaySession(sessionId, { clientRequestId: requestId("restore-session") }, csrfToken),
    onSuccess: (next) => {
      queryClient.setQueryData(playSessionKey(sessionId), next);
      void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
    },
  });
  const activateMutation = useMutation({
    mutationFn: () => activatePlaySession(sessionId, { clientRequestId: requestId("activate-session") }, csrfToken),
    onSuccess: (next) => {
      queryClient.setQueryData(playSessionKey(sessionId), next);
      void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
    },
  });
  const clearMutation = useMutation({
    mutationFn: () => clearPlayConversation(sessionId, { clientRequestId: requestId("clear-conversation") }, csrfToken),
    onSuccess: () => {
      setDraft("");
      setAffordanceId(undefined);
      void queryClient.invalidateQueries({ queryKey: playSessionKey(sessionId) });
    },
  });
  const removeMutation = useMutation({
    mutationFn: () => removePlaySession(sessionId, { clientRequestId: requestId("remove-session") }, csrfToken),
    onSuccess: async (removed) => {
      await queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
      await navigate({ to: "/instances/$branchId", params: { branchId: removed.branchId } });
    },
  });

  if (detail.isPending) return <LoadingState />;
  if (detail.isError) return <ErrorState error={detail.error} retry={() => void detail.refetch()} />;
  const data = detail.data;
  const session = data.session;
  const instance = bootstrap.data?.catalog.instances.find((candidate) => candidate.branchId === session.branchId);
  const runsById = new Map((traceRuns.data ?? []).map((run) => [run.id, run]));
  const runsByMessageId = new Map((traceRuns.data ?? []).flatMap((run) =>
    run.presentationMessageIds.map((messageId) => [messageId, run] as const)));
  const result = current?.result;
  const playResult = playOperationResultSchema.safeParse(result);
  const sceneResult = sceneNarrationResultSchema.safeParse(result);
  const retryResult = narrationRetryResultSchema.safeParse(result);
  const choices = playResult.success ? playResult.data.choices : sceneResult.success ? sceneResult.data.choices : retryResult.success ? retryResult.data.choices : [];
  const settledNarration = playResult.success ? playResult.data.narration : sceneResult.success ? sceneResult.data.narration : retryResult.success ? retryResult.data.narration : undefined;
  const mutationError = firstError(entryMutation.error, moveMutation.error, narrationMutation.error, narrationRetryMutation.error, cancelMutation.error, archiveMutation.error, restoreMutation.error, activateMutation.error, clearMutation.error, removeMutation.error);
  const writable = session.status !== "archived" && session.status !== "detached" && Boolean(data.headCommitId);
  const enteringScene = !data.messages.length
    && writable
    && !entryMutation.isError
    && (
      !entryMutation.data
      || entryMutation.isPending
      || (entryMutation.data.state === "starting" && (!current || !isTerminal(current.status)))
      || (busy && current?.kind === "scene-narration")
    );
  const sceneReady = data.messages.some((message) => message.role === "scene" && message.status === "rendered");
  const canRetryNarration = Boolean(
    writable
    && current?.runId
    && data.headCommitId
    && current.kind === "player-move"
    && (
      (playResult.success
        && playResult.data.accepted
        && playResult.data.finalHead === data.headCommitId
        && playResult.data.narrationStatus !== "rendered")
      || (current.status === "interrupted" && current.commitBoundaryCrossed)
    ),
  );

  const submitMove = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || busy || !writable || !sceneReady) return;
    moveMutation.mutate();
  };
  const chooseAction = (selected: PlayerChoiceSummary) => {
    setDraft(selected.action);
    setAffordanceId(selected.affordanceId);
    window.requestAnimationFrame(() => composerInput.current?.focus());
  };
  return (
    <div className={`immersive-play${edgePanelOpen ? " play-edge-open" : ""}`}>
      <section className="transcript-panel play-story-panel" aria-label={t("Transcript")}>
        <header className="play-story-bar">
          <span className={busy ? "play-presence play-presence-busy" : "play-presence"} aria-hidden="true" />
          <small>{busy
            ? (current?.progress.statusText ? String(current.progress.statusText) : current?.phase)
            : enteringScene
              ? t("The narrator is setting the scene")
              : sceneReady
                ? t("The world waits for your move")
                : t("Scene context required")}</small>
          <span>{t("{count} messages", { count: data.messages.length })}</span>
          <button className="play-edge-toggle" type="button" aria-label={t("Open session controls")} aria-expanded={edgePanelOpen} onClick={() => setEdgePanelOpen(true)}>•••</button>
        </header>
        <div ref={transcriptElement} className="transcript">
          {!data.messages.length && !busy && (enteringScene
            ? <EmptyState title={t("Entering the scene")} body={t("The narrator is weaving the chosen character's necessary past and immediate situation into the opening.")} />
            : <EmptyState title={t("The scene has not been rendered")} body={t("The automatic scene did not complete, or the presentation transcript was cleared. Re-establishing it does not advance world truth.")} />)}
          {data.messages.map((message) => {
            const run = message.role === "scene"
              ? (message.runId ? runsById.get(message.runId) : undefined) ?? runsByMessageId.get(message.id)
              : undefined;
            const runId = message.role === "scene" ? message.runId ?? run?.id : undefined;
            return (
              <article key={message.id} className={`message message-${message.role}`}>
                <header><span>{message.role === "player" ? t("Action request") : t("Story")}</span><small>{t(message.status)} · {formatDateTime(message.createdAt, localeTag)}</small></header>
                <p>{message.text}</p>
                {runId && <MessageTraceTrigger runId={runId} run={run} onOpen={setSelectedTraceRunId} />}
              </article>
            );
          })}
          {busy && (current?.kind === "scene-narration" || streamed || current?.phase.includes("narrat")) && (
            <article className="message message-scene message-streaming">
              <header><span>{t("Story")} · {t("live")}</span><small>{current?.phase}</small></header>
              <p>{streamed || t("The scene is being composed…")}</p>
              {current?.runId && <MessageTraceTrigger runId={current.runId} run={runsById.get(current.runId)} onOpen={setSelectedTraceRunId} />}
            </article>
          )}
          {!busy && settledNarration && !data.messages.some((message) => message.text === settledNarration) && (
            <article className="message message-scene"><header><span>{t("Story")}</span><small>{t("settled")}</small></header><p>{settledNarration}</p>{current?.runId && <MessageTraceTrigger runId={current.runId} run={runsById.get(current.runId)} onOpen={setSelectedTraceRunId} />}</article>
          )}
        </div>
        <footer className="composer-area">
          {choices.length > 0 && (
            <section className="choice-deck" aria-label={t("Suggested actions")}>
              <header><span>{t("Suggested actions")}</span><small>{t("Choose a direction or write your own.")}</small></header>
              <div className="choice-strip">{choices.map((choice, index) => <ChoiceButton key={`${choice.affordanceId ?? "free"}:${choice.action}`} choice={choice} index={index} selected={draft === choice.action && affordanceId === choice.affordanceId} onChoose={chooseAction} />)}</div>
            </section>
          )}
          <form className="composer" onSubmit={submitMove}>
            <div className="composer-prompt"><span>{t("Your next move")}</span><small>{t("Ctrl/⌘ + Enter to submit")}</small></div>
            <textarea
              ref={composerInput}
              value={draft}
              disabled={!writable || busy || !sceneReady}
              onChange={(event) => { setDraft(event.target.value); setAffordanceId(undefined); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={session.status === "detached"
                ? t("This historical session has no writable world instance")
                : session.status === "archived"
                  ? t("Restore this session to continue")
                  : !sceneReady
                    ? enteringScene
                      ? t("Wait while the narrator establishes the scene…")
                      : t("Re-establish the scene before taking an action.")
                    : t("Describe one immediate action, observation, thought, or wait…")}
              rows={2}
            />
            <div className="composer-actions">
              <button type="button" className="text-button" disabled={!draft} onClick={() => { setDraft(""); setAffordanceId(undefined); }}>{t("Clear")}</button>
              {!data.messages.length && !enteringScene && <button type="button" className="secondary-button" disabled={!writable || busy || narrationMutation.isPending} onClick={() => narrationMutation.mutate()}>{t("Re-establish scene")}</button>}
              <button type="submit" className="primary-button" disabled={!draft.trim() || !writable || !sceneReady || busy || moveMutation.isPending}>{t("Commit action")} <span aria-hidden="true">↵</span></button>
            </div>
          </form>
        </footer>
      </section>

      <button className="play-edge-backdrop" type="button" aria-label={t("Close session controls")} onClick={() => setEdgePanelOpen(false)} />
      <aside className="operation-panel play-edge-panel">
        <header>
          <div><span className="eyebrow">{t("Actor")}</span><strong>{session.actorName ?? session.actorId}</strong></div>
          {session.status === "detached" ? <span className="detached-pill">{t("Detached world")}</span> : session.status === "active" ? <span className="live-pill"><i />{t("Active writer")}</span> : <span className={`operation-status operation-${session.status}`}>{t(session.status)}</span>}
          <button className="play-edge-close" type="button" aria-label={t("Close session controls")} onClick={() => setEdgePanelOpen(false)}>×</button>
        </header>
        <div className="play-edge-scroll">
          <section className="play-edge-meta" aria-label={t("Play status")}>
            <div><span>{t("Story time")}</span><strong>{instance ? `${t("step")} ${instance.logicalStep}` : t("unknown")}</strong></div>
            <div><span>{t("Branch")}</span><code>{session.branchId}</code></div>
            <div><span>{t("Head")}</span><code>{data.headCommitId ? shortHash(data.headCommitId) : t("detached")}</code></div>
            <div><span>{t("Run stage")}</span><strong>{current?.phase ?? t("idle")}</strong></div>
          </section>

          <section className="play-edge-actions" aria-label={t("Session controls")}>
            {session.status === "archived" ? <button onClick={() => restoreMutation.mutate()}>{t("Restore")}</button> : session.status === "idle" ? <button onClick={() => activateMutation.mutate()}>{t("Make active")}</button> : null}
            <button disabled={busy || !data.messages.length} onClick={() => window.confirm(t("Clear presentation transcript? Committed world history will be preserved.")) && clearMutation.mutate()}>{t("Clear transcript")}</button>
            {session.status !== "archived" && session.status !== "detached" && <button disabled={busy} onClick={() => archiveMutation.mutate()}>{t("Archive")}</button>}
            <button className="danger-button" disabled={busy} onClick={() => window.confirm(t("Remove this play session and its presentation transcript? The world branch will be preserved.")) && removeMutation.mutate()}>{t("Remove")}</button>
          </section>

          <section className="play-edge-operation">
            <header><span className="eyebrow">{t("Current operation")}</span>{current && <span className={`operation-status operation-${current.status}`}>{t(current.status)}</span>}</header>
            {current ? (
              <>
                {busy && current.progress.statusText && <div className="operation-activity"><span className="loading-orbit" /><p>{String(current.progress.statusText)}</p></div>}
                {busy && current.cancellable && <button className="stop-button" disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>{current.commitBoundaryCrossed ? t("Stop narration") : t("Cancel before commit")}</button>}
                {canRetryNarration && <button className="primary-button" disabled={narrationRetryMutation.isPending} onClick={() => narrationRetryMutation.mutate()}>{narrationRetryMutation.isPending ? t("Starting presentation…") : t("Retry narration only")}</button>}
                {current.error && <div className="inline-error"><strong>{current.error.code}</strong><span>{current.error.message}</span><small>{recoveryInstruction(current.error)}</small></div>}
                <details className="play-edge-details">
                  <summary>{t("Operation details")}</summary>
                  <dl className="operation-detail">
                    <Detail label={t("Kind")} value={t(current.kind)} />
                    <Detail label={t("Phase")} value={current.phase} />
                    <Detail label={t("Operation")} value={current.id} mono />
                    {current.runId && <div><dt>{t("Trace")}</dt><dd><Link className="inline-trace-link" to="/play/$sessionId/trace/$runId" params={{ sessionId, runId: current.runId }}>{t("Open full trajectory")} ↗</Link></dd></div>}
                    <Detail label={t("Commit boundary")} value={current.commitBoundaryCrossed ? t("crossed — world may be committed") : t("not crossed")} />
                  </dl>
                  {playResult.success && <OperationResult result={playResult.data} />}
                  {retryResult.success && <div className="operation-result"><span className="eyebrow">{t("Presentation repair")}</span><strong>{t("Rendered without world mutation")}</strong><p>{t("Original move {move}", { move: shortHash(retryResult.data.playerMoveId) })}</p><code>{shortHash(retryResult.data.headCommitId)}</code></div>}
                </details>
              </>
            ) : <p className="play-edge-empty">{t("The world is waiting for your first move.")}</p>}
          </section>

          {operationList.data && operationList.data.length > 1 && (
            <details className="play-edge-details play-edge-history">
              <summary>{t("Recent operations")}</summary>
              <div className="operation-history">{operationList.data.slice(0, 8).map((item) => <button key={item.id} className={item.id === effectiveOperationId ? "selected" : ""} onClick={() => setSelectedOperationId(item.id)}><span>{t(item.kind)}</span><small>{t(item.status)} · {formatTime(item.createdAt, localeTag)}</small></button>)}</div>
            </details>
          )}
        </div>
      </aside>
      {selectedTraceRunId && <TraceDrawer runId={selectedTraceRunId} sessionId={sessionId} onClose={closeTraceDrawer} />}
      {mutationError && <div className="floating-error"><InlineError error={mutationError} /></div>}
    </div>
  );
}

function TracesRoutePage() {
  const { data } = useBootstrap();
  return <TraceListPage sessions={data?.catalog.playSessions ?? []} />;
}

function TraceRoutePage() {
  const { runId } = useParams({ from: traceRoute.id });
  return <TraceDetailPage runId={runId} />;
}

function SessionTraceRoutePage() {
  const { sessionId, runId } = useParams({ from: sessionTraceRoute.id });
  return <TraceDetailPage runId={runId} sessionId={sessionId} />;
}

function ChoiceButton({ choice, index, selected, onChoose }: { choice: PlayerChoiceSummary; index: number; selected: boolean; onChoose: (choice: PlayerChoiceSummary) => void }) {
  const { t } = useI18n();
  return <button type="button" className={selected ? "selected" : ""} aria-pressed={selected} onClick={() => onChoose(choice)}><kbd>{index + 1}</kbd><span>{choice.action}</span><small>{choice.affordanceId ? t("preflighted") : t("free choice")}</small></button>;
}

function MessageTraceTrigger({ runId, run, onOpen }: { runId: string; run?: Awaited<ReturnType<typeof fetchTraceRuns>>[number]; onOpen: (runId: string) => void }) {
  const { t } = useI18n();
  const detail = run
    ? t("{llm} LLM · {tools} tools · {status}", { llm: run.counts.llmRequests, tools: run.counts.toolCalls, status: t(run.status) })
    : t("trace loading");
  return (
    <footer className="message-trace-footer">
      <button
        type="button"
        className={`message-trace-trigger trace-trigger-${run?.status ?? "loading"}`}
        aria-label={t("Open trace details for this message")}
        title={t("Open the complete LLM, tool, context, timing, and world-effect trajectory")}
        onClick={() => onOpen(runId)}
      >
        <svg className="message-trace-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
          <circle cx="5" cy="6" r="2" />
          <circle cx="19" cy="6" r="2" />
          <circle cx="12" cy="18" r="2" />
          <path d="M7 6h5a3 3 0 0 1 3 3v1M17.5 7.5 13.5 16M6.5 7.5 10.5 16" />
        </svg>
        <span><strong>{t("Trace")}</strong><small>{detail}</small></span>
        <b aria-hidden="true">›</b>
      </button>
    </footer>
  );
}

function OperationResult({ result }: { result: ReturnType<typeof playOperationResultSchema.parse> }) {
  const { t } = useI18n();
  return (
    <div className="operation-result">
      <span className="eyebrow">{t("World result")}</span>
      <strong>{result.accepted ? t("Committed") : t("Not committed · {stage}", { stage: result.stage })}</strong>
      <p>{t("Step {step} · narration {status}", { step: result.logicalStep, status: result.narrationStatus })}</p>
      <code>{shortHash(result.finalHead)}</code>
      {result.issues.length > 0 && <ul>{result.issues.slice(0, 4).map((issue, index) => <li key={`${issue.code}:${index}`}><strong>{issue.code}</strong>{issue.message}</li>)}</ul>}
      {result.narrationError && <small>{result.narrationError}</small>}
    </div>
  );
}

function ModelsPage() {
  const { t } = useI18n();
  const { data } = useBootstrap();
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: ({ signal }) => fetchModelProfiles(signal) });
  const operations = useQuery({ queryKey: ["operations"], queryFn: ({ signal }) => fetchOperations(undefined, signal), refetchInterval: 1_000 });
  if (!data) return null;
  const loginOperations = (operations.data ?? []).filter((operation) => operation.kind === "provider-login");
  return (
    <>
      <PageHeading eyebrow={t("Pi runtime")} title={t("Models & credentials")} description={t("Provider login stays inside Pi. API keys are write-only; this page receives status metadata, prompts, and redacted progress only.")} />
      {data.modelCatalog.diagnostic && <div className="alert"><strong>{t("Catalog diagnostic")}</strong><span>{data.modelCatalog.diagnostic}</span></div>}
      <Panel title={t("Providers")} action={<span className="panel-tag">{t("Pi credential store")}</span>}>
        <div className="provider-grid">
          {data.modelCatalog.providers.map((provider) => (
            <ProviderCredentialCard key={provider.id} provider={provider} csrfToken={data.csrfToken} operations={loginOperations.filter((operation) => operation.scopeId === provider.id)} onChanged={() => {
              void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
              void queryClient.invalidateQueries({ queryKey: ["operations"], exact: true });
            }} />
          ))}
        </div>
      </Panel>
      <Panel title={t("Role profiles")} action={<span className="panel-tag">{t("shared YAML config")}</span>}>
        {profiles.isPending ? <InlineLoading label={t("Reading model routes…")} /> : profiles.isError ? <InlineError error={profiles.error} /> : <><div className="profile-config-path"><span>{t("Configuration")}</span><code>{profiles.data.configPath}</code></div><div className="model-profile-grid">{profiles.data.roles.map((profile) => <ModelProfileEditor key={profile.role} profile={profile} models={data.modelCatalog.models} csrfToken={data.csrfToken} onSaved={(next) => queryClient.setQueryData(["model-profiles"], next)} />)}</div></>}
      </Panel>
      <Panel title={t("Known models")} action={<span className="panel-tag">{data.modelCatalog.models.length}</span>}>
        <div className="model-table" role="table" aria-label={t("Known Pi models")}>
          {data.modelCatalog.models.slice(0, 100).map((model) => (
            <div className="model-row" role="row" key={`${model.providerId}/${model.id}`}>
              <span><strong>{model.name}</strong><small>{model.providerId}/{model.id}</small></span><span>{model.api}</span><span>{formatNumber(model.contextWindow)} {t("ctx")}</span><span>{model.reasoning ? t("reasoning") : t("standard")}</span>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}

function ProviderCredentialCard({ provider, csrfToken, operations, onChanged }: { provider: ProviderSummary; csrfToken: string; operations: OperationSnapshot[]; onChanged: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const operation = operations.find((candidate) => !isTerminal(candidate.status)) ?? operations[0];
  const interaction = authInteractionSnapshotSchema.safeParse(operation?.progress.interaction);
  const authEvent = operation?.progress.authEvent && typeof operation.progress.authEvent === "object" ? operation.progress.authEvent as Record<string, unknown> : undefined;
  const begin = async (authType: "api_key" | "oauth") => {
    const secret = apiKey;
    setApiKey("");
    setBusy(true);
    setError(undefined);
    try {
      const accepted = await loginProvider(provider.id, {
        authType,
        ...(authType === "api_key" ? { apiKey: secret } : {}),
        clientRequestId: requestId(`provider-${authType}`),
      }, csrfToken);
      queryClient.setQueryData(operationKey(accepted.operation.id), accepted.operation);
      void queryClient.invalidateQueries({ queryKey: ["operations"], exact: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setBusy(false);
    }
  };
  const submitAnswer = async () => {
    if (!interaction.success) return;
    const oneTimeAnswer = answer;
    setAnswer("");
    setBusy(true);
    setError(undefined);
    try {
      await answerAuthInteraction(interaction.data.id, { answer: oneTimeAnswer }, csrfToken);
      void queryClient.invalidateQueries({ queryKey: ["operations"], exact: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(t("Remove the stored Pi credential for {provider}? Environment credentials are not changed.", { provider: provider.name }))) return;
    setBusy(true);
    setError(undefined);
    try { await logoutProvider(provider.id, { clientRequestId: requestId("provider-logout") }, csrfToken); onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause : new Error(String(cause))); }
    finally { setBusy(false); }
  };
  return <article className="provider-card">
    <header><div><span className={`status-dot ${provider.configured ? "status-available" : "status-planned"}`} /><strong>{provider.name}</strong></div><code>{provider.id}</code></header>
    <p>{provider.configured ? provider.authLabel ?? provider.authSource ?? t("Configured") : t("Not configured")}</p><small>{provider.modelCount} {t("models")}{provider.credentialType ? ` · ${provider.credentialType}` : ""}</small>
    {provider.authTypes.includes("api_key") && <form className="provider-key-form" onSubmit={(event) => { event.preventDefault(); if (apiKey && !busy) void begin("api_key"); }}><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={t("Write-only API key")} /><button type="submit" disabled={!apiKey || busy}>{t("Save key")}</button></form>}
    <div className="provider-actions">{provider.authTypes.includes("oauth") && <button disabled={busy || Boolean(operation && !isTerminal(operation.status))} onClick={() => void begin("oauth")}>{t("Start OAuth")}</button>}{provider.configured && <button className="danger-button" disabled={busy} onClick={() => void remove()}>{t("Remove credential")}</button>}</div>
    {operation && <div className="provider-login-state"><span className={`operation-status operation-${operation.status}`}>{operation.phase}</span><small>{operation.error?.message ?? String(authEvent?.message ?? t("Pi authentication is running"))}</small>{authEvent && <AuthEventView event={authEvent} />}</div>}
    {interaction.success && interaction.data.status === "pending" && <AuthPromptForm interaction={interaction.data} answer={answer} setAnswer={setAnswer} busy={busy} onSubmit={() => void submitAnswer()} />}
    {error && <InlineError error={error} />}
  </article>;
}

function AuthPromptForm({ interaction, answer, setAnswer, busy, onSubmit }: { interaction: ReturnType<typeof authInteractionSnapshotSchema.parse>; answer: string; setAnswer: (value: string) => void; busy: boolean; onSubmit: () => void }) {
  const { t } = useI18n();
  const prompt = interaction.prompt;
  return <form className="auth-prompt" onSubmit={(event) => { event.preventDefault(); if (!busy) onSubmit(); }}><strong>{prompt.message}</strong>{prompt.type === "select" ? <select value={answer} onChange={(event) => setAnswer(event.target.value)}><option value="">{t("Choose…")}</option>{prompt.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select> : <input type={prompt.type === "secret" ? "password" : "text"} autoComplete="off" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={prompt.placeholder} />}<button disabled={busy || !answer}>{t("Answer once")}</button><small>{t("Answer values are never echoed into operation progress or SSE.")}</small></form>;
}

function AuthEventView({ event }: { event: Record<string, unknown> }) {
  const { t } = useI18n();
  const url = typeof event.url === "string" ? safeExternalUrl(event.url) : undefined;
  const verification = typeof event.verificationUri === "string" ? safeExternalUrl(event.verificationUri) : undefined;
  return <div className="auth-event">{url && <a href={url} target="_blank" rel="noreferrer">{t("Open provider authorization")} ↗</a>}{verification && <a href={verification} target="_blank" rel="noreferrer">{t("Open verification page")} ↗</a>}{typeof event.userCode === "string" && <code>{event.userCode}</code>}{typeof event.instructions === "string" && <p>{event.instructions}</p>}</div>;
}

function ModelProfileEditor({ profile, models, csrfToken, onSaved }: { profile: ModelProfileSummary; models: ModelSummary[]; csrfToken: string; onSaved: (profiles: Awaited<ReturnType<typeof fetchModelProfiles>>) => void }) {
  const { t } = useI18n();
  const initialKey = profile.providerId && profile.modelId ? modelOptionKey(profile.providerId, profile.modelId) : "";
  const [selected, setSelected] = useState(initialKey);
  const [thinking, setThinking] = useState(profile.thinkingLevel ?? "medium");
  useEffect(() => { setSelected(initialKey); setThinking(profile.thinkingLevel ?? "medium"); }, [initialKey, profile.thinkingLevel]);
  const mutation = useMutation({
    mutationFn: () => {
      const model = models.find((candidate) => modelOptionKey(candidate.providerId, candidate.id) === selected);
      if (!model) throw new Error("Select one exact Pi model.");
      return updateModelProfile(profile.role as ModelRole, { providerId: model.providerId, modelId: model.id, thinkingLevel: thinking, clientRequestId: requestId("model-profile") }, csrfToken);
    },
    onSuccess: onSaved,
  });
  return <article className="model-profile-card"><header><strong>{t(profile.role.replaceAll("-", " "))}</strong><small>{profile.inheritedDefault ? `${t("inherits")} ${profile.profileId ?? t("none")}` : profile.profileId ?? t("unconfigured")}</small></header><select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">{t("Choose model…")}</option>{models.map((model) => <option key={modelOptionKey(model.providerId, model.id)} value={modelOptionKey(model.providerId, model.id)}>{model.providerId} / {model.name}{model.available ? "" : ` · ${t("unavailable")}`}</option>)}</select><select value={thinking} onChange={(event) => setThinking(event.target.value as typeof thinking)}><option value="off">{t("thinking off")}</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select><button disabled={!selected || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? t("Saving…") : t("Save route")}</button>{mutation.error && <InlineError error={mutation.error} />}</article>;
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
  const { t, localeTag } = useI18n();
  return <Link to="/novels/$sourceId" params={{ sourceId: novel.id }} className="novel-card"><span className="book-spine" /><div><span className="eyebrow">{t("{count} instances", { count: novel.instanceCount })}</span><h3>{novel.title}</h3><p>{novel.sourcePath}</p><small>{formatBytes(novel.bytes)} · {formatDate(novel.updatedAt, localeTag)}</small></div></Link>;
}
function InstanceRow({ instance }: { instance: InstanceSummary }) {
  const { t } = useI18n();
  return <Link to="/instances/$branchId" params={{ branchId: instance.branchId }} className="instance-row"><span className={`branch-marker ${instance.active ? "branch-marker-active" : ""}`} /><span><strong>{instance.name}</strong><small>{instance.sourceTitle ?? instance.sourceId ?? t("unscoped")}</small></span><span><strong>{t("Step")} {instance.logicalStep}</strong><small>{t("{count} events", { count: instance.eventCount })}</small></span><code>{shortHash(instance.headCommitId)}</code></Link>;
}
function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? "mono" : undefined}>{value}</dd></div>;
}
function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="empty-state"><span>◇</span><div><strong>{title}</strong><p>{body}</p></div></div>;
}
function MissingState({ kind, id }: { kind: string; id: string }) {
  const { t } = useI18n();
  return <div className="center-state"><span className="eyebrow">{t("Not found")}</span><h1>{t("Unknown {kind}", { kind: t(kind) })}</h1><p>{t("No item with ID {id} exists in the current workspace.", { id })}</p><Link to="/">{t("Return to overview")}</Link></div>;
}
function LoadingState({ label = "Reading local catalog and Pi metadata…" }: { label?: string }) {
  const { t } = useI18n();
  return <div className="center-state"><span className="loading-orbit" /><h1>{t("Opening the world model")}</h1><p>{t(label)}</p></div>;
}
function ErrorState({ error, retry }: { error: Error; retry: () => void }) {
  const { t } = useI18n();
  const detail = webErrorDetail(error);
  return <div className="center-state center-error"><span className="eyebrow">{detail?.code ?? t("Request failed")}</span><h1>{t("The local workspace could not be read")}</h1><p>{error.message}</p>{detail && <small>{recoveryInstruction(detail, t)}</small>}{canRetrySameRequest(error) && <button onClick={retry}>{t("Retry once")}</button>}</div>;
}
function InlineLoading({ label }: { label: string }) { return <div className="inline-loading"><span className="loading-orbit" />{label}</div>; }
function InlineError({ error }: { error: Error }) { const { t } = useI18n(); const detail = webErrorDetail(error); return <div className="inline-error"><strong>{detail?.code ?? error.name}</strong><span>{error.message}</span>{detail && <small>{recoveryInstruction(detail, t)}</small>}</div>; }

function parseServerEvent(raw: Event) {
  if (!(raw instanceof MessageEvent)) return undefined;
  try {
    const parsed = webEventSchema.safeParse(JSON.parse(String(raw.data)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
function isTerminal(status?: OperationSnapshot["status"]): boolean { return status === "succeeded" || status === "failed" || status === "cancelled" || status === "interrupted"; }
function ontologyRouteSearch(value: Record<string, unknown>) {
  return {
    ...(typeof value.branchId === "string" && value.branchId ? { branchId: value.branchId } : {}),
    ...(typeof value.atCommit === "string" && value.atCommit ? { atCommit: value.atCommit } : {}),
    ...((value.includeCanonicalFuture === true || value.includeCanonicalFuture === "true") ? { includeCanonicalFuture: true } : {}),
  };
}
function firstError(...errors: Array<Error | null | undefined>): Error | undefined { return errors.find((error): error is Error => error instanceof Error); }
function requestId(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }
function shortHash(value: string): string { return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value; }
function formatBytes(bytes: number): string { return bytes < 1_024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1_024).toFixed(1)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`; }
function formatDate(value: string, locale?: string): string { return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)); }
function formatDateTime(value: string, locale?: string): string { return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function formatTime(value: string, locale?: string): string { return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
function formatNumber(value: number): string { return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value); }
function modelOptionKey(providerId: string, modelId: string): string { return JSON.stringify([providerId, modelId]); }
function safeExternalUrl(value: string): string | undefined { try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined; } catch { return undefined; } }

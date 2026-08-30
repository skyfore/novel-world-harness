import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import {
  activatePlaySession,
  cancelOperation,
  clearPlayConversation,
  createPlaySession,
  fetchBootstrap,
  fetchCharacters,
  fetchOperation,
  fetchOperations,
  fetchPlaySession,
  removePlaySession,
  restorePlaySession,
  startPlayerMove,
  startSceneNarration,
  updatePlaySession,
} from "./api";
import {
  operationSnapshotSchema,
  playOperationResultSchema,
  sceneNarrationResultSchema,
  webEventSchema,
  type BootstrapResponse,
  type InstanceSummary,
  type NovelSummary,
  type OperationSnapshot,
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
const narrationStreamKey = (operationId: string) => ["narration-stream", operationId] as const;

function useBootstrap() {
  return useQuery({ queryKey: bootstrapQueryKey, queryFn: ({ signal }) => fetchBootstrap(signal) });
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
    const onCatalog = () => void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
    const onOperation = (raw: Event) => {
      const event = parseServerEvent(raw);
      if (!event) return;
      const operation = operationSnapshotSchema.safeParse(event.data.operation);
      if (!operation.success) return;
      queryClient.setQueryData(operationKey(operation.data.id), operation.data);
      void queryClient.invalidateQueries({ queryKey: operationsKey(operation.data.scopeId) });
      if (isTerminal(operation.data.status)) {
        void queryClient.invalidateQueries({ queryKey: playSessionKey(operation.data.scopeId) });
        void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
      }
    };
    const onNarrationDelta = (raw: Event) => {
      const event = parseServerEvent(raw);
      if (!event?.operationId || typeof event.data.delta !== "string") return;
      queryClient.setQueryData<string>(narrationStreamKey(event.operationId), (current = "") => current + event.data.delta);
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
    return () => {
      source.removeEventListener("catalog.invalidated", onCatalog);
      source.removeEventListener("operation.changed", onOperation);
      source.removeEventListener("play.narration.delta", onNarrationDelta);
      source.removeEventListener("play.narration.completed", onPlayChanged);
      source.removeEventListener("play.message.appended", onPlayChanged);
      source.close();
    };
  }, [queryClient]);

  const data = query.data;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link to="/" className="brand" activeOptions={{ exact: true }}>
          <span className="brand-mark">NW</span>
          <span><strong>Novel World</strong><small>Harness</small></span>
        </Link>
        <nav aria-label="主导航" className="primary-nav">
          <NavSection label="Workspace"><Link to="/" activeOptions={{ exact: true }} className="nav-link">Overview</Link></NavSection>
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
                <span>{session.title}</span><small>{session.status}</small>
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
          <div><span className="eyebrow">Local workspace</span><strong>{data?.workspace.displayName ?? "Loading…"}</strong></div>
          <div className="topbar-meta"><span>API {data?.apiVersion ?? "v1"}</span><span>Pi-backed</span><span>No app login</span></div>
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
      <PageHeading eyebrow="Executable novel workspace" title="World control room" description="Inspect compiled worlds, enter a character, and follow every Pi-backed play operation from one local interface." />
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
                <span className={`status-dot status-${feature.status}`} /><strong>{feature.id.replace("-", " ")}</strong><span>Phase {feature.phase}</span><small>{feature.status}</small>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Panel title="Registered novels" action={<span className="panel-tag">source evidence</span>}>
        <div className="card-grid">
          {data.catalog.novels.map((novel) => <NovelCard key={novel.id} novel={novel} />)}
          {!data.catalog.novels.length && <EmptyState title="The library is empty" body="Existing CLI-ingested novels appear here; browser ingest and compilation arrive in Phase 2." />}
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
      <Panel title="World instances" action={<span className="panel-tag">committed</span>}>
        {instances.length ? instances.map((instance) => <InstanceRow key={instance.branchId} instance={instance} />) : <EmptyState title="No committed instance" body="This source is registered but does not yet own a playable branch." />}
      </Panel>
      <PlannedCallout title="Compiler and ontology workbench" phase="Phase 2" body="Batch progress, proposal review, model/event/place/rule graphs, and evidence provenance will live on this novel page." />
    </>
  );
}

function InstancePage() {
  const { branchId } = useParams({ from: instanceRoute.id });
  const { data } = useBootstrap();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const instance = data?.catalog.instances.find((candidate) => candidate.branchId === branchId);
  const existingSession = data?.catalog.playSessions.find((session) => session.branchId === branchId);
  const characters = useQuery({
    queryKey: ["characters", branchId, instance?.sourceId],
    queryFn: ({ signal }) => fetchCharacters(branchId, instance?.sourceId, signal),
    enabled: Boolean(instance),
  });
  const [actorId, setActorId] = useState("");
  useEffect(() => {
    if (actorId) return;
    setActorId(existingSession?.actorId ?? characters.data?.characters[0]?.id ?? "");
  }, [actorId, characters.data, existingSession?.actorId]);
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
  if (!instance) return <MissingState kind="instance" id={branchId} />;
  return (
    <>
      <PageHeading eyebrow="Committed branch" title={instance.name} description={instance.sourceTitle ?? "Unscoped legacy world"} />
      <div className="metric-grid">
        <Metric label="Story step" value={instance.logicalStep} note="derived world time" />
        <Metric label="Commits" value={instance.commitCount} note="authoritative history" />
        <Metric label="Events" value={instance.eventCount} note={instance.lastEventTitle ?? "no event title"} />
        <Metric label="Actor" value={instance.actorName ?? "—"} note={instance.sessionAtHead ? "session at head" : "select below"} />
      </div>
      <div className="content-grid">
        <Panel title="Enter this world" action={<span className="panel-tag">Pi play</span>}>
          {characters.isPending ? <InlineLoading label="Reading playable characters…" /> : characters.isError ? <InlineError error={characters.error} /> : characters.data?.characters.length ? (
            <div className="character-picker">
              {characters.data.characters.map((character) => (
                <label key={character.id} className={actorId === character.id ? "character-option character-option-selected" : "character-option"}>
                  <input type="radio" name="actor" value={character.id} checked={actorId === character.id} onChange={() => setActorId(character.id)} />
                  <span><strong>{character.canonicalName}</strong><small>{character.locationName ?? character.locationId ?? "location unknown"}</small></span>
                  <code>{character.id}</code>
                </label>
              ))}
              <div className="action-row">
                <button className="primary-button" disabled={!actorId || createMutation.isPending} onClick={() => createMutation.mutate()}>{createMutation.isPending ? "Opening…" : existingSession ? "Switch / continue" : "Start play session"}</button>
                {existingSession && <Link className="secondary-button" to="/play/$sessionId" params={{ sessionId: existingSession.id }}>Open saved session</Link>}
              </div>
              {createMutation.error && <InlineError error={createMutation.error} />}
            </div>
          ) : <EmptyState title="No playable character at this head" body="The branch needs at least one living, embodied compiled character before play can begin." />}
        </Panel>
        <Panel title="Branch identity" action={<span className="panel-tag">world truth</span>}>
          <dl className="detail-list">
            <Detail label="Branch ID" value={instance.branchId} mono />
            <Detail label="Head commit" value={instance.headCommitId} mono />
            <Detail label="Parent" value={instance.parentBranchId ?? "genesis"} mono />
            <Detail label="Prepared revision" value={instance.preparedRevisionHash ?? "legacy / unpinned"} mono />
            <Detail label="Updated" value={formatDateTime(instance.updatedAt)} />
          </dl>
        </Panel>
      </div>
      <PlannedCallout title="Branch history and graph overlay" phase="Phase 2" body="Commit history, state diff, fork controls, and branch-scoped ontology will be added here." />
    </>
  );
}

function SessionPage() {
  const { sessionId } = useParams({ from: sessionRoute.id });
  const bootstrap = useBootstrap();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detail = useQuery({ queryKey: playSessionKey(sessionId), queryFn: ({ signal }) => fetchPlaySession(sessionId, signal) });
  const operationList = useQuery({ queryKey: operationsKey(sessionId), queryFn: ({ signal }) => fetchOperations(sessionId, signal), refetchInterval: 2_000 });
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
  const streamed = useQuery({
    queryKey: narrationStreamKey(effectiveOperationId ?? "none"),
    queryFn: async () => "",
    enabled: false,
    initialData: "",
  });
  const [draft, setDraft] = useState("");
  const [affordanceId, setAffordanceId] = useState<string>();
  const csrfToken = bootstrap.data?.csrfToken ?? "";
  const current = operation.data;
  const busy = Boolean(current && !isTerminal(current.status));

  useEffect(() => {
    if (!current || !isTerminal(current.status)) return;
    void queryClient.invalidateQueries({ queryKey: playSessionKey(sessionId) });
    void queryClient.invalidateQueries({ queryKey: operationsKey(sessionId) });
    void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
  }, [current?.id, current?.status, queryClient, sessionId]);

  const acceptOperation = (accepted: { operation: OperationSnapshot }) => {
    setSelectedOperationId(accepted.operation.id);
    queryClient.setQueryData(operationKey(accepted.operation.id), accepted.operation);
    queryClient.setQueryData(narrationStreamKey(accepted.operation.id), "");
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
      purpose: detail.data?.messages.length ? "orientation" : "opening",
      expectedHead: detail.data!.headCommitId!,
      clientRequestId: requestId("scene"),
    }, csrfToken),
    onSuccess: acceptOperation,
  });
  const cancelMutation = useMutation({
    mutationFn: () => cancelOperation(current!.id, csrfToken),
    onSuccess: (snapshot) => queryClient.setQueryData(operationKey(snapshot.id), snapshot),
  });
  const archiveMutation = useMutation({
    mutationFn: () => updatePlaySession(sessionId, { status: "archived" }, csrfToken),
    onSuccess: (next) => {
      queryClient.setQueryData(playSessionKey(sessionId), next);
      void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
    },
  });
  const restoreMutation = useMutation({
    mutationFn: () => restorePlaySession(sessionId, csrfToken),
    onSuccess: (next) => {
      queryClient.setQueryData(playSessionKey(sessionId), next);
      void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
    },
  });
  const activateMutation = useMutation({
    mutationFn: () => activatePlaySession(sessionId, csrfToken),
    onSuccess: (next) => {
      queryClient.setQueryData(playSessionKey(sessionId), next);
      void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
    },
  });
  const clearMutation = useMutation({
    mutationFn: () => clearPlayConversation(sessionId, csrfToken),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: playSessionKey(sessionId) }),
  });
  const removeMutation = useMutation({
    mutationFn: () => removePlaySession(sessionId, csrfToken),
    onSuccess: async (removed) => {
      await queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
      await navigate({ to: "/instances/$branchId", params: { branchId: removed.branchId } });
    },
  });

  if (detail.isPending) return <LoadingState />;
  if (detail.isError) return <ErrorState error={detail.error} retry={() => void detail.refetch()} />;
  const data = detail.data;
  const session = data.session;
  const result = current?.result;
  const playResult = playOperationResultSchema.safeParse(result);
  const sceneResult = sceneNarrationResultSchema.safeParse(result);
  const choices = playResult.success ? playResult.data.choices : sceneResult.success ? sceneResult.data.choices : [];
  const settledNarration = playResult.success ? playResult.data.narration : sceneResult.success ? sceneResult.data.narration : undefined;
  const mutationError = firstError(moveMutation.error, narrationMutation.error, cancelMutation.error, archiveMutation.error, restoreMutation.error, activateMutation.error, clearMutation.error, removeMutation.error);
  const writable = session.status !== "archived" && session.status !== "detached" && Boolean(data.headCommitId);

  const submitMove = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || busy || !writable) return;
    moveMutation.mutate();
  };
  return (
    <>
      <div className="session-heading">
        <PageHeading eyebrow="Live executable world" title={session.title} description={`${session.actorName ?? session.actorId} · ${session.branchId}`} />
        <div className="session-toolbar">
          {session.status === "archived" ? <button onClick={() => restoreMutation.mutate()}>Restore</button> : session.status === "idle" ? <button onClick={() => activateMutation.mutate()}>Make active</button> : <span className="live-pill"><i />Active writer</span>}
          <button disabled={busy || !data.messages.length} onClick={() => window.confirm("Clear presentation transcript? Committed world history will be preserved.") && clearMutation.mutate()}>Clear transcript</button>
          {session.status !== "archived" && <button disabled={busy} onClick={() => archiveMutation.mutate()}>Archive</button>}
          <button className="danger-button" disabled={busy} onClick={() => window.confirm("Remove this play session and its presentation transcript? The world branch will be preserved.") && removeMutation.mutate()}>Remove</button>
        </div>
      </div>
      <div className="play-layout">
        <section className="transcript-panel" aria-label="Play transcript">
          <header>
            <div><span className="eyebrow">Transcript</span><strong>{data.messages.length} messages</strong></div>
            <code>{data.headCommitId ? shortHash(data.headCommitId) : "detached"}</code>
          </header>
          <div className="transcript">
            {!data.messages.length && !busy && <EmptyState title="The scene has not been rendered" body="Render the opening from the actor-safe committed frame. This does not advance world truth." />}
            {data.messages.map((message) => (
              <article key={message.id} className={`message message-${message.role}`}>
                <header><span>{message.role === "player" ? "You" : "Narrator"}</span><small>{message.status} · {formatDateTime(message.createdAt)}</small></header>
                <p>{message.text}</p>
                <code>{shortHash(message.atCommit)}</code>
              </article>
            ))}
            {busy && (streamed.data || current?.phase.includes("narrat")) && (
              <article className="message message-scene message-streaming">
                <header><span>Narrator · live</span><small>{current?.phase}</small></header>
                <p>{streamed.data || "The scene is being composed…"}</p>
              </article>
            )}
            {!busy && settledNarration && !data.messages.some((message) => message.text === settledNarration) && (
              <article className="message message-scene"><header><span>Narrator</span><small>settled</small></header><p>{settledNarration}</p></article>
            )}
          </div>
          <footer className="composer-area">
            {choices.length > 0 && <div className="choice-strip">{choices.map((choice) => <ChoiceButton key={`${choice.affordanceId ?? "free"}:${choice.action}`} choice={choice} onChoose={(selected) => { setDraft(selected.action); setAffordanceId(selected.affordanceId); }} />)}</div>}
            <form className="composer" onSubmit={submitMove}>
              <textarea value={draft} disabled={!writable || busy} onChange={(event) => { setDraft(event.target.value); setAffordanceId(undefined); }} placeholder={session.status === "archived" ? "Restore this session to continue" : "Describe one immediate action, observation, thought, or wait…"} rows={3} />
              <div>
                <button type="button" className="text-button" disabled={!draft} onClick={() => { setDraft(""); setAffordanceId(undefined); }}>Clear</button>
                {!data.messages.length && <button type="button" className="secondary-button" disabled={!writable || busy || narrationMutation.isPending} onClick={() => narrationMutation.mutate()}>Render opening</button>}
                <button type="submit" className="primary-button" disabled={!draft.trim() || !writable || busy || moveMutation.isPending}>Commit action</button>
              </div>
            </form>
          </footer>
        </section>
        <aside className="operation-panel">
          <header><span className="eyebrow">Current operation</span>{current && <span className={`operation-status operation-${current.status}`}>{current.status}</span>}</header>
          {current ? (
            <>
              <dl className="operation-detail">
                <Detail label="Kind" value={current.kind} />
                <Detail label="Phase" value={current.phase} />
                <Detail label="Operation" value={current.id} mono />
                <Detail label="Commit boundary" value={current.commitBoundaryCrossed ? "crossed — world may be committed" : "not crossed"} />
              </dl>
              {current.progress.statusText && <div className="operation-activity"><span className={busy ? "loading-orbit" : "status-dot"} /><p>{String(current.progress.statusText)}</p></div>}
              {busy && current.cancellable && <button className="stop-button" disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>{current.commitBoundaryCrossed ? "Stop narration" : "Cancel before commit"}</button>}
              {current.error && <div className="inline-error"><strong>{current.error.code}</strong><span>{current.error.message}</span></div>}
              {playResult.success && <OperationResult result={playResult.data} />}
            </>
          ) : <EmptyState title="No operation yet" body="Render the scene or submit an action to start a traceable operation." />}
          {operationList.data && operationList.data.length > 1 && (
            <div className="operation-history"><span className="eyebrow">Recent</span>{operationList.data.slice(0, 8).map((item) => <button key={item.id} className={item.id === effectiveOperationId ? "selected" : ""} onClick={() => setSelectedOperationId(item.id)}><span>{item.kind}</span><small>{item.status} · {formatTime(item.createdAt)}</small></button>)}</div>
          )}
          <PlannedCallout title="Full LLM trajectory" phase="Phase 1B" body="The next increment expands this operation into every nested request, tool call, context part, token count, response, and event-time linkage." />
        </aside>
      </div>
      {mutationError && <div className="floating-error"><InlineError error={mutationError} /></div>}
    </>
  );
}

function ChoiceButton({ choice, onChoose }: { choice: PlayerChoiceSummary; onChoose: (choice: PlayerChoiceSummary) => void }) {
  return <button type="button" onClick={() => onChoose(choice)}><span>{choice.action}</span>{choice.affordanceId && <small>preflighted</small>}</button>;
}

function OperationResult({ result }: { result: ReturnType<typeof playOperationResultSchema.parse> }) {
  return (
    <div className="operation-result">
      <span className="eyebrow">World result</span>
      <strong>{result.accepted ? "Committed" : `Not committed · ${result.stage}`}</strong>
      <p>Step {result.logicalStep} · narration {result.narrationStatus}</p>
      <code>{shortHash(result.finalHead)}</code>
      {result.issues.length > 0 && <ul>{result.issues.slice(0, 4).map((issue, index) => <li key={`${issue.code}:${index}`}><strong>{issue.code}</strong>{issue.message}</li>)}</ul>}
      {result.narrationError && <small>{result.narrationError}</small>}
    </div>
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
              <code>{provider.id}</code><p>{provider.configured ? provider.authLabel ?? provider.authSource ?? "Configured" : "Not configured"}</p><small>{provider.modelCount} models</small>
            </article>
          ))}
        </div>
      </Panel>
      <Panel title="Known models" action={<span className="panel-tag">{data.modelCatalog.models.length}</span>}>
        <div className="model-table" role="table" aria-label="Known Pi models">
          {data.modelCatalog.models.slice(0, 100).map((model) => (
            <div className="model-row" role="row" key={`${model.providerId}/${model.id}`}>
              <span><strong>{model.name}</strong><small>{model.providerId}/{model.id}</small></span><span>{model.api}</span><span>{formatNumber(model.contextWindow)} ctx</span><span>{model.reasoning ? "reasoning" : "standard"}</span>
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
  return <div className="center-state center-error"><span className="eyebrow">Request failed</span><h1>The local workspace could not be read</h1><p>{error.message}</p><button onClick={retry}>Try again</button></div>;
}
function InlineLoading({ label }: { label: string }) { return <div className="inline-loading"><span className="loading-orbit" />{label}</div>; }
function InlineError({ error }: { error: Error }) { return <div className="inline-error"><strong>{error.name}</strong><span>{error.message}</span></div>; }

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
function firstError(...errors: Array<Error | null | undefined>): Error | undefined { return errors.find((error): error is Error => error instanceof Error); }
function requestId(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }
function shortHash(value: string): string { return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value; }
function formatBytes(bytes: number): string { return bytes < 1_024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1_024).toFixed(1)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`; }
function formatDate(value: string): string { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)); }
function formatDateTime(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function formatTime(value: string): string { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
function formatNumber(value: number): string { return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value); }

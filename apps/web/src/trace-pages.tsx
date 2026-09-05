import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n } from "./i18n";
import {
  fetchTraceCall,
  fetchTraceEventPayload,
  fetchTraceRun,
  fetchTraceRuns,
  type TraceRunFilters,
  WebApiError,
} from "./api";
import {
  buildTraceLedger,
  diffContextParts,
  isWorldEffectEvent,
  latestContext,
  playerVisibleText,
  type ContextPartDiff,
  type TraceLedgerRow,
} from "./trace-model";
import type {
  TraceCallDetail,
  TraceContextSnapshotView,
  TraceRunDetailView,
} from "../../../src/trace/projection";
import type {
  TraceEvent,
  TraceRunKind,
  TraceRunManifest,
  TraceRunStatus,
} from "../../../src/trace/schema";
import type { PlaySessionSummary } from "../../../src/web/contracts";

export const traceRunsQueryKey = ["trace-runs"] as const;
export const traceRunKey = (runId: string) => ["trace-run", runId] as const;
export const traceCallKey = (runId: string, callId: string) => ["trace-call", runId, callId] as const;

type TraceListPageProps = {
  sessions: PlaySessionSummary[];
};

type TraceDetailPageProps = {
  runId: string;
  sessionId?: string;
  embedded?: boolean;
};

type TraceDrawerProps = {
  runId: string;
  sessionId: string;
  onClose: () => void;
};

type InspectorTab = "context" | "messages" | "tools" | "payload" | "response" | "usage" | "effects";

const inspectorTabs: Array<{ id: InspectorTab; label: string }> = [
  { id: "context", label: "Context Parts" },
  { id: "messages", label: "Messages" },
  { id: "tools", label: "Tools" },
  { id: "payload", label: "Provider Payload" },
  { id: "response", label: "Response" },
  { id: "usage", label: "Usage & Timing" },
  { id: "effects", label: "World Effects" },
];

export function TraceListPage({ sessions }: TraceListPageProps) {
  const { t } = useI18n();
  const [sessionId, setSessionId] = useState("");
  const [kind, setKind] = useState<TraceRunKind | "">("");
  const [status, setStatus] = useState<TraceRunStatus | "">("");
  const [modelId, setModelId] = useState("");
  const [stage, setStage] = useState("");
  const [date, setDate] = useState("");
  const filters = useMemo<TraceRunFilters>(() => ({
    ...(sessionId ? { sessionId } : {}),
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
    ...(modelId.trim() ? { modelId: modelId.trim() } : {}),
    ...(stage.trim() ? { stage: stage.trim() } : {}),
    ...(date ? dateBounds(date) : {}),
    limit: 500,
  }), [date, kind, modelId, sessionId, stage, status]);
  const query = useQuery({
    queryKey: [...traceRunsQueryKey, filters],
    queryFn: ({ signal }) => fetchTraceRuns(filters, signal),
    retry: false,
    refetchInterval: (result) => result.state.data?.some((run) => run.status === "running") ? 1_500 : false,
  });
  const sessionNames = new Map(sessions.map((session) => [session.id, session.title]));
  return (
    <>
      <header className="page-heading">
        <span className="eyebrow">{t("Local observability ledger")}</span>
        <h1>{t("Trace runs")}</h1>
        <p>{t("Inspect every Pi request, tool execution, context layer, world boundary, and player-visible response without treating observations as world truth.")}</p>
      </header>
      <section className="trace-filters" aria-label={t("Trace filters")}>
        <label><span>{t("Session")}</span><select value={sessionId} onChange={(event) => setSessionId(event.target.value)}><option value="">{t("All sessions")}</option>{sessions.map((session) => <option value={session.id} key={session.id}>{session.title}</option>)}</select></label>
        <label><span>{t("Kind")}</span><select value={kind} onChange={(event) => setKind(event.target.value as TraceRunKind | "")}><option value="">{t("All kinds")}</option><option value="player-move">{t("Player move")}</option><option value="scene-narration">{t("Scene narration")}</option><option value="narration-retry">{t("Narration retry")}</option><option value="prepare">{t("Prepare")}</option></select></label>
        <label><span>{t("Status")}</span><select value={status} onChange={(event) => setStatus(event.target.value as TraceRunStatus | "")}><option value="">{t("All statuses")}</option><option value="running">{t("Running")}</option><option value="succeeded">{t("Succeeded")}</option><option value="failed">{t("Failed")}</option><option value="cancelled">{t("Cancelled")}</option><option value="interrupted">{t("Interrupted")}</option></select></label>
        <label><span>{t("Date")}</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label><span>{t("LLM model ID")}</span><input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder={t("exact model ID")} /></label>
        <label><span>{t("Stage / invocation")}</span><input value={stage} onChange={(event) => setStage(event.target.value)} placeholder={t("exact stage name")} /></label>
        <button type="button" onClick={() => { setSessionId(""); setKind(""); setStatus(""); setModelId(""); setStage(""); setDate(""); }}>{t("Clear filters")}</button>
      </section>
      <section className="trace-run-panel">
        <header><div><span className="eyebrow">{t("Runs")}</span><strong>{t("{count} matches", { count: query.data?.length ?? 0 })}</strong></div><span className="panel-tag">{t("append-only")}</span></header>
        {query.isPending ? <TraceLoading label={t("Reading run index…")} /> : query.isError ? <TraceError error={query.error} retry={() => void query.refetch()} /> : query.data.length ? (
          <div className="trace-run-list">
            {query.data.map((run) => <TraceRunRow key={run.id} run={run} sessionName={run.playSessionId ? sessionNames.get(run.playSessionId) : undefined} />)}
          </div>
        ) : <TraceEmpty title={t("No trace runs match")} body={t("Clear one or more filters, or execute a play operation to create a new run.")} />}
      </section>
    </>
  );
}

function TraceRunRow({ run, sessionName }: { run: TraceRunManifest; sessionName?: string }) {
  const { t, localeTag } = useI18n();
  const duration = run.endedAt ? elapsed(run.startedAt, run.endedAt) : t("live");
  return (
    <Link
      to={run.playSessionId ? "/play/$sessionId/trace/$runId" : "/traces/$runId"}
      params={run.playSessionId ? { sessionId: run.playSessionId, runId: run.id } : { runId: run.id }}
      className="trace-run-row"
    >
      <span className={`trace-status trace-status-${run.status}`}>{t(run.status)}</span>
      <span className="trace-run-identity"><strong>{t(run.kind)}</strong><small>{sessionName ?? run.playSessionId ?? run.branchId ?? t("workspace run")}</small></span>
      <span><strong>{t("{count} LLM", { count: run.counts.llmRequests })}</strong><small>{t("{tools} tools · {retries} retries", { tools: run.counts.toolCalls, retries: run.counts.retries })}</small></span>
      <span><strong>{formatTokens(run.usage.totalTokens, localeTag)}</strong><small>{t("{input} in · {output} out", { input: run.usage.input, output: run.usage.output })}</small></span>
      <span><strong>{duration}</strong><small>{formatDateTime(run.startedAt, localeTag)}</small></span>
      <code>{shortId(run.id)}</code>
    </Link>
  );
}

export function TraceDrawer({ runId, sessionId, onClose }: TraceDrawerProps) {
  const { t } = useI18n();
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div className="trace-drawer-layer">
      <button className="trace-drawer-backdrop" type="button" aria-label={t("Close trace details")} onClick={onClose} />
      <aside className="trace-drawer" role="dialog" aria-modal="true" aria-labelledby="trace-drawer-title">
        <header>
          <div>
            <span className="eyebrow">{t("Trace details")}</span>
            <strong id="trace-drawer-title">{t("Message-linked execution trajectory")}</strong>
            <code>{runId}</code>
          </div>
          <div className="trace-drawer-actions">
            <Link to="/play/$sessionId/trace/$runId" params={{ sessionId, runId }}>{t("Open full trajectory")} ↗</Link>
            <button ref={closeButton} type="button" aria-label={t("Close trace details")} onClick={onClose}>×</button>
          </div>
        </header>
        <div className="trace-drawer-scroll">
          <TraceDetailPage runId={runId} sessionId={sessionId} embedded />
        </div>
      </aside>
    </div>
  );
}

export function TraceDetailPage({ runId, sessionId, embedded = false }: TraceDetailPageProps) {
  const { t, localeTag } = useI18n();
  const runQuery = useQuery({
    queryKey: traceRunKey(runId),
    queryFn: ({ signal }) => fetchTraceRun(runId, signal),
    retry: false,
    refetchInterval: (query) => query.state.data?.manifest.status === "running" ? 1_000 : false,
  });
  const [selectedCallId, setSelectedCallId] = useState<string>();
  const [selectedEventSeq, setSelectedEventSeq] = useState<number>();
  const [activeTab, setActiveTab] = useState<InspectorTab>("context");
  useEffect(() => {
    if (!selectedCallId && runQuery.data?.callIds[0]) setSelectedCallId(runQuery.data.callIds[0]);
  }, [runQuery.data?.callIds, selectedCallId]);
  const callQuery = useQuery({
    queryKey: traceCallKey(runId, selectedCallId ?? "none"),
    queryFn: ({ signal }) => fetchTraceCall(selectedCallId!, runId, signal),
    enabled: Boolean(selectedCallId),
    retry: false,
    refetchInterval: runQuery.data?.manifest.status === "running" ? 1_000 : false,
  });
  const presentationEvent = [...(runQuery.data?.events ?? [])].reverse().find((event) => event.type === "presentation.message.appended" && event.blobRef);
  const presentationQuery = useQuery({
    queryKey: ["trace-presentation", runId, presentationEvent?.seq ?? 0],
    queryFn: ({ signal }) => fetchTraceEventPayload(runId, presentationEvent!.seq, signal),
    enabled: Boolean(presentationEvent),
    retry: false,
  });

  if (runQuery.isPending) return <TraceLoading label={t("Replaying the trace ledger…")} />;
  if (runQuery.isError) return <TraceError error={runQuery.error} retry={() => void runQuery.refetch()} />;
  const run = runQuery.data;
  const manifest = run.manifest;
  const visibleResponse = playerVisibleText(presentationQuery.data?.content);
  const duration = manifest.endedAt ? elapsed(manifest.startedAt, manifest.endedAt) : t("live");
  const selectEvent = (event: TraceEvent) => {
    if (event.callId) {
      setSelectedCallId(event.callId);
      setSelectedEventSeq(undefined);
      if (event.type.startsWith("tool.")) setActiveTab("tools");
      else if (event.type.startsWith("llm.response.")) setActiveTab("response");
      else if (event.type.startsWith("llm.request.")) setActiveTab(event.type === "llm.request.payload" ? "payload" : "messages");
      else setActiveTab("context");
      return;
    }
    if (isWorldEffectEvent(event) || event.blobRef) {
      setSelectedEventSeq(event.seq);
      setActiveTab("effects");
    }
  };
  return (
    <div className={embedded ? "trace-detail trace-detail-embedded" : "trace-detail"}>
      <header className="trace-heading">
        <div>
          <span className="eyebrow">{t("Player Move → Run → Span → LLM Call")}</span>
          <h1>{t("{kind} trajectory", { kind: t(manifest.kind) })}</h1>
          <p><code>{manifest.id}</code></p>
        </div>
        <div className="trace-heading-actions">
          {!embedded && (sessionId ? <Link to="/play/$sessionId" params={{ sessionId }}>{t("Back to play")}</Link> : <Link to="/traces">{t("All traces")}</Link>)}
          <span className={`trace-status trace-status-${manifest.status}`}>{t(manifest.status)}</span>
        </div>
      </header>
      <div className="trace-metric-grid">
        <TraceMetric label={t("Wall duration")} value={duration} note={formatDateTime(manifest.startedAt, localeTag)} />
        <TraceMetric label={t("LLM requests")} value={manifest.counts.llmRequests} note={t("{count} provider retries", { count: manifest.counts.retries })} />
        <TraceMetric label={t("Tool calls")} value={manifest.counts.toolCalls} note={t("{count} ledger events", { count: run.events.length })} />
        <TraceMetric label={t("Tokens")} value={formatTokens(manifest.usage.totalTokens, localeTag)} note={t("{input} in · {output} out · {cached} cached", { input: manifest.usage.input, output: manifest.usage.output, cached: manifest.usage.cacheRead })} />
        <TraceMetric label={t("Cost")} value={formatCost(manifest.usage.cost, localeTag)} note={t("provider reported when available")} />
      </div>
      <section className="trace-truth-strip">
        <div><span>{t("World head")}</span><code>{shortId(manifest.previousHead ?? t("unknown"))} → {shortId(manifest.finalHead ?? t("not committed"))}</code></div>
        <div><span>{t("Story time")}</span><code>{storyTimeSummary(manifest.storyTimeBefore, t)} → {storyTimeSummary(manifest.storyTimeAfter, t)}</code></div>
        <div><span>{t("Links")}</span><code>{manifest.eventHash ? `${t("event")} ${shortId(manifest.eventHash)}` : t("no event")}{manifest.auditId ? ` · ${t("audit")} ${shortId(manifest.auditId)}` : ""}</code></div>
      </section>
      {manifest.error && <section className="trace-run-error"><span>{manifest.error.code}</span><strong>{manifest.error.message}</strong><small>{manifest.error.retryable ? t("Marked retryable") : t("Do not replay unchanged")}</small></section>}
      {presentationQuery.isError && <section className="trace-run-error"><span>TRACE_PAYLOAD</span><strong>{presentationQuery.error.message}</strong><small>{t("The run ledger remains available")}</small></section>}
      {visibleResponse && <section className="trace-final-response"><span className="eyebrow">{t("Final player-visible response")}</span><p>{visibleResponse}</p></section>}
      <div className="trace-workbench">
        <section className="trace-ledger-panel">
          <header><div><span className="eyebrow">{t("Trajectory ledger")}</span><strong>{t("{count} observations", { count: run.events.length })}</strong></div><span className="panel-tag">{t("story ≠ wall time")}</span></header>
          <TraceLedger run={run} selectedCallId={selectedCallId} selectedEventSeq={selectedEventSeq} onSelect={selectEvent} />
        </section>
        <section className="trace-inspector-panel">
          <header>
            <div><span className="eyebrow">{t("Request inspector")}</span><strong>{selectedCallId ? callLabel(run, selectedCallId, t) : t("Select an LLM request")}</strong></div>
            <div className="trace-call-picker">{run.callIds.map((callId, index) => <button type="button" key={callId} className={callId === selectedCallId ? "selected" : ""} onClick={() => { setSelectedCallId(callId); setSelectedEventSeq(undefined); }}>#{index + 1}</button>)}</div>
          </header>
          <div className="trace-tabs" role="tablist">{inspectorTabs.map((tab) => <button type="button" role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? "selected" : ""} key={tab.id} onClick={() => setActiveTab(tab.id)}>{t(tab.label)}</button>)}</div>
          <div className="trace-inspector-body">
            {selectedCallId && callQuery.isPending ? <TraceLoading label={t("Expanding content-addressed context…")} compact /> : callQuery.isError ? <TraceError error={callQuery.error} retry={() => void callQuery.refetch()} compact /> : (
              <TraceInspector
                run={run}
                call={callQuery.data}
                selectedCallId={selectedCallId}
                selectedEventSeq={selectedEventSeq}
                activeTab={activeTab}
                onSelectEffect={(seq) => { setSelectedEventSeq(seq); setActiveTab("effects"); }}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function TraceLedger({
  run,
  selectedCallId,
  selectedEventSeq,
  onSelect,
}: {
  run: TraceRunDetailView;
  selectedCallId?: string;
  selectedEventSeq?: number;
  onSelect: (event: TraceEvent) => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => buildTraceLedger(run.events, run.manifest.rootSpanId), [run.events, run.manifest.rootSpanId]);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => 52, overscan: 10 });
  return (
    <div ref={parent} className="trace-ledger-scroll">
      <div className="trace-virtual-space" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          const selected = selectedEventSeq === row.event.seq || Boolean(row.event.callId && row.event.callId === selectedCallId);
          return <TraceLedgerItem key={row.key} row={row} selected={selected} onSelect={onSelect} top={item.start} />;
        })}
      </div>
    </div>
  );
}

function TraceLedgerItem({ row, selected, onSelect, top }: { row: TraceLedgerRow; selected: boolean; onSelect: (event: TraceEvent) => void; top: number }) {
  const { t, localeTag } = useI18n();
  return (
    <button
      type="button"
      className={`trace-ledger-row trace-category-${row.category}${selected ? " selected" : ""}`}
      style={{ transform: `translateY(${top}px)`, paddingLeft: 12 + row.depth * 18 }}
      onClick={() => onSelect(row.event)}
    >
      <span className="trace-ledger-seq">{row.event.seq}</span>
      <i />
      <span><strong>{t(row.label)}</strong><small>{row.detail ?? row.event.spanId}</small></span>
      <time>{formatTime(row.event.observedAt, localeTag)}</time>
      {row.event.blobRef && <b title={t("Content payload available")}>◆</b>}
    </button>
  );
}

function TraceInspector({
  run,
  call,
  selectedCallId,
  selectedEventSeq,
  activeTab,
  onSelectEffect,
}: {
  run: TraceRunDetailView;
  call?: TraceCallDetail;
  selectedCallId?: string;
  selectedEventSeq?: number;
  activeTab: InspectorTab;
  onSelectEffect: (seq: number) => void;
}) {
  const { t } = useI18n();
  const callIndex = selectedCallId ? run.callIds.indexOf(selectedCallId) : -1;
  const adjacentIndex = callIndex >= 0 && callIndex < run.callIds.length - 1 ? callIndex + 1 : callIndex - 1;
  const adjacentId = adjacentIndex >= 0 ? run.callIds[adjacentIndex] : undefined;
  const adjacentQuery = useQuery({
    queryKey: traceCallKey(run.manifest.id, adjacentId ?? "none"),
    queryFn: ({ signal }) => fetchTraceCall(adjacentId!, run.manifest.id, signal),
    enabled: Boolean(adjacentId && activeTab === "context"),
    retry: false,
  });
  if (activeTab === "effects") return <WorldEffects run={run} selectedEventSeq={selectedEventSeq} onSelect={onSelectEffect} />;
  if (!call) return <TraceEmpty title={t("No LLM request selected")} body={t("Choose a request number or an LLM observation in the trajectory ledger.")} />;
  const context = latestContext(call.contexts);
  if (activeTab === "context") {
    const left = adjacentIndex < callIndex ? latestContext(adjacentQuery.data?.contexts ?? []) : context;
    const right = adjacentIndex < callIndex ? context : latestContext(adjacentQuery.data?.contexts ?? []);
    return <ContextComposition context={context} diff={adjacentQuery.data ? diffContextParts(left, right) : undefined} leftLabel={adjacentIndex >= 0 ? t("Request #{number}", { number: Math.min(callIndex, adjacentIndex) + 1 }) : undefined} rightLabel={adjacentIndex >= 0 ? t("Request #{number}", { number: Math.max(callIndex, adjacentIndex) + 1 }) : undefined} />;
  }
  if (activeTab === "messages") return <LogicalMessages value={context?.logicalMessages} />;
  if (activeTab === "tools") return <ToolsInspector context={context} call={call} />;
  if (activeTab === "payload") return <JsonInspector value={context?.providerPayload} filename={`${call.callId}-provider-payload.json`} searchable />;
  if (activeTab === "response") return <ResponseInspector call={call} />;
  return <UsageInspector call={call} context={context} />;
}

function ContextComposition({ context, diff, leftLabel, rightLabel }: { context?: TraceContextSnapshotView; diff?: ContextPartDiff[]; leftLabel?: string; rightLabel?: string }) {
  const { t } = useI18n();
  const parent = useRef<HTMLDivElement>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const parts = context?.parts ?? [];
  const virtual = useVirtualizer({ count: parts.length, getScrollElement: () => parent.current, estimateSize: () => 112, overscan: 6 });
  if (!context) return <TraceEmpty title={t("No finalized context")} body={t("This request ended before a semantic context snapshot was persisted.")} />;
  const visibleDiff = diff?.filter((entry) => showUnchanged || entry.status !== "unchanged");
  return (
    <div className="context-inspector">
      <div className="context-summary">
        <span><strong>{parts.length}</strong><small>{t("semantic parts")}</small></span>
        <span><strong>{context.snapshot.estimatedInputTokens ?? "—"}</strong><small>{t("estimated input tokens")}</small></span>
        <span><strong>{context.snapshot.providerId ?? "—"}</strong><small>{context.snapshot.modelId ?? t("model unknown")}</small></span>
        <span><strong>{context.requestAttempt ?? 1}</strong><small>{t("request attempt")}</small></span>
      </div>
      <div ref={parent} className="context-part-scroll">
        <div className="trace-virtual-space" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((item) => {
            const part = parts[item.index]!;
            return (
              <article ref={virtual.measureElement} data-index={item.index} className={`context-part context-part-${part.disposition}`} key={part.id} style={{ transform: `translateY(${item.start}px)` }}>
                <header><span className="context-kind">{part.kind}</span><strong>{part.label}</strong><span className={`authority authority-${part.authority}`}>{part.authority}</span></header>
                <div><code>{part.id}</code><span>{t("{chars} chars · ~{tokens} tokens · messages [{messages}]", { chars: part.charCount, tokens: part.estimatedTokens ?? "?", messages: part.logicalMessageIndexes.join(", ") || t("none") })}</span></div>
                {part.sourceRefs.length > 0 && <small>{part.sourceRefs.map((ref) => `${ref.sourceId}${ref.startByte !== undefined ? `:${ref.startByte}-${ref.endByte ?? "?"}` : ""}`).join(" · ")}</small>}
                {part.content !== undefined && <details><summary>{t("View captured content")}</summary><SafePre value={part.content} /></details>}
              </article>
            );
          })}
        </div>
      </div>
      {diff && <section className="context-diff">
        <header><div><span className="eyebrow">{t("Context diff")}</span><strong>{leftLabel} → {rightLabel}</strong></div><label><input type="checkbox" checked={showUnchanged} onChange={(event) => setShowUnchanged(event.target.checked)} />{t("Show unchanged")}</label></header>
        {visibleDiff?.length ? visibleDiff.map((entry) => <div key={entry.id} className={`context-diff-row diff-${entry.status}`}><span>{t(entry.status)}</span><strong>{entry.label}</strong><code>{entry.id}</code><small>{entry.changes.join(", ") || t("same ID, hash, authority, disposition, and indexes")}</small></div>) : <p>{t("No context-part changes between these adjacent requests.")}</p>}
      </section>}
    </div>
  );
}

function LogicalMessages({ value }: { value: unknown }) {
  const { t } = useI18n();
  if (!Array.isArray(value)) return <JsonInspector value={value} filename="logical-messages.json" />;
  return <VirtualJsonList values={value} label={t("logical messages")} />;
}

function VirtualJsonList({ values, label }: { values: unknown[]; label: string }) {
  const { t } = useI18n();
  const parent = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: values.length, getScrollElement: () => parent.current, estimateSize: () => 150, overscan: 5 });
  return <div><div className="inspector-note">{t("{count} {label} · captured after Pi context assembly", { count: values.length, label })}</div><div ref={parent} className="json-list-scroll"><div className="trace-virtual-space" style={{ height: virtual.getTotalSize() }}>{virtual.getVirtualItems().map((item) => <article ref={virtual.measureElement} data-index={item.index} className="json-message" key={item.key} style={{ transform: `translateY(${item.start}px)` }}><span>{t("Message {number}", { number: item.index + 1 })}</span><SafePre value={values[item.index]} /></article>)}</div></div></div>;
}

function ToolsInspector({ context, call }: { context?: TraceContextSnapshotView; call: TraceCallDetail }) {
  const { t } = useI18n();
  return (
    <div className="tools-inspector">
      <span className="inspector-section-title">{t("Available to this request · {count}", { count: context?.availableTools.length ?? 0 })}</span>
      {context?.availableTools.length ? context.availableTools.map((tool) => <details key={tool.name} className="tool-card"><summary><strong>{tool.name}</strong><small>{tool.description}</small></summary><SafePre value={tool.parameters} /></details>) : <TraceEmpty title={t("No active tools")} body={t("This Pi request had no tool schema in its finalized context.")} />}
      <span className="inspector-section-title">{t("Actually executed · {count}", { count: call.tools.length })}</span>
      {call.tools.map((tool) => <article className={`tool-execution tool-${tool.status}`} key={tool.toolCallId}><header><span>{t(tool.status)}</span><strong>{tool.name}</strong><code>{tool.toolCallId}</code></header><details><summary>{t("Input")}</summary><SafePre value={tool.input} /></details>{tool.progress.length > 0 && <details><summary>{t("{count} progress updates", { count: tool.progress.length })}</summary><SafePre value={tool.progress} /></details>}<details><summary>{t("Result")}</summary><SafePre value={tool.result} /></details></article>)}
    </div>
  );
}

function ResponseInspector({ call }: { call: TraceCallDetail }) {
  const { t } = useI18n();
  const deltas = call.responses.filter((response) => response.status === "delta").map((response) => playerVisibleText(response.content) ?? "").join("");
  const final = [...call.responses].reverse().find((response) => response.status === "completed" || response.status === "failed");
  const finalText = playerVisibleText(final?.content);
  return (
    <div className="response-inspector">
      {deltas && <section><span className="inspector-section-title">{t("Coalesced stream replay")}</span><p className="response-text">{deltas}</p></section>}
      <section><span className="inspector-section-title">{t("Authoritative completed message")}</span>{finalText && <p className="response-text">{finalText}</p>}<SafePre value={final?.content ?? t("No completed response payload was recorded.")} /></section>
      <section><span className="inspector-section-title">{t("Response observations")}</span><SafePre value={call.responses.map(({ content: _content, ...response }) => response)} /></section>
    </div>
  );
}

function UsageInspector({ call, context }: { call: TraceCallDetail; context?: TraceContextSnapshotView }) {
  const { t, localeTag } = useI18n();
  return (
    <div className="usage-inspector">
      <div className="context-summary">
        <span><strong>{call.usage.input}</strong><small>{t("provider input")}</small></span><span><strong>{call.usage.output}</strong><small>{t("provider output")}</small></span><span><strong>{call.usage.cacheRead}</strong><small>{t("cache read")}</small></span><span><strong>{call.usage.reasoning ?? "—"}</strong><small>{t("reasoning tokens")}</small></span>
      </div>
      <dl className="trace-detail-list">
        <DetailTerm label={t("Model")} value={`${context?.snapshot.providerId ?? t("unknown")}/${context?.snapshot.modelId ?? t("unknown")}`} />
        <DetailTerm label={t("Assembly")} value={context?.snapshot.assemblyVersion ?? t("unknown")} />
        <DetailTerm label={t("Started")} value={call.startedAt ? formatDateTime(call.startedAt, localeTag) : t("not observed")} />
        <DetailTerm label={t("First response")} value={call.firstResponseAt ? `${formatDateTime(call.firstResponseAt, localeTag)} · ${t("{milliseconds} ms locally measured", { milliseconds: call.timeToFirstResponseMs ?? "?" })}` : t("not observed")} />
        <DetailTerm label={t("Completed")} value={call.endedAt ? formatDateTime(call.endedAt, localeTag) : t("not observed")} />
        <DetailTerm label={t("Total duration")} value={call.durationMs !== undefined ? t("{milliseconds} ms locally measured", { milliseconds: call.durationMs }) : t("unknown")} />
        <DetailTerm label={t("Estimated input")} value={context?.snapshot.estimatedInputTokens !== undefined ? t("~{tokens} tokens — estimate, not billing", { tokens: context.snapshot.estimatedInputTokens }) : t("unknown")} />
        <DetailTerm label={t("Provider total")} value={t("{tokens} tokens", { tokens: call.usage.totalTokens })} />
        <DetailTerm label={t("Cost")} value={formatCost(call.usage.cost, localeTag)} />
      </dl>
    </div>
  );
}

function WorldEffects({ run, selectedEventSeq, onSelect }: { run: TraceRunDetailView; selectedEventSeq?: number; onSelect: (seq: number) => void }) {
  const { t } = useI18n();
  const effects = run.events.filter(isWorldEffectEvent);
  const selected = effects.find((event) => event.seq === selectedEventSeq) ?? effects.at(-1);
  const payload = useQuery({
    queryKey: ["trace-effect-payload", run.manifest.id, selected?.seq ?? 0],
    queryFn: ({ signal }) => fetchTraceEventPayload(run.manifest.id, selected!.seq, signal),
    enabled: Boolean(selected?.blobRef),
    retry: false,
  });
  return (
    <div className="effects-inspector">
      <section className="effect-links"><span className="inspector-section-title">{t("Authoritative links")}</span><dl className="trace-detail-list"><DetailTerm label={t("Previous head")} value={run.manifest.previousHead ?? t("unknown")} mono /><DetailTerm label={t("Final head")} value={run.manifest.finalHead ?? t("no commit")} mono /><DetailTerm label={t("Committed event")} value={run.manifest.eventHash ?? t("none")} mono /><DetailTerm label={t("Audit")} value={run.manifest.auditId ?? t("none")} mono /><DetailTerm label={t("Presentation")} value={run.manifest.presentationMessageIds.join(", ") || t("none")} mono /><DetailTerm label={t("Story time before")} value={compactJson(run.manifest.storyTimeBefore)} mono /><DetailTerm label={t("Story time after")} value={compactJson(run.manifest.storyTimeAfter)} mono /></dl></section>
      <span className="inspector-section-title">{t("Validation / commit / presentation ledger")}</span>
      <div className="effect-events">{effects.map((event) => <button type="button" key={event.seq} className={event.seq === selected?.seq ? "selected" : ""} onClick={() => onSelect(event.seq)}><span>{event.seq}</span><strong>{event.type}</strong><small>{compactJson(event.storyTime ?? event.data)}</small>{event.blobRef && <b>{t("payload")}</b>}</button>)}</div>
      {selected && <section className="effect-payload"><span className="inspector-section-title">{t("Selected observation #{number}", { number: selected.seq })}</span><SafePre value={selected.data} />{payload.isPending && selected.blobRef ? <TraceLoading label={t("Verifying payload hash…")} compact /> : payload.isError ? <TraceError error={payload.error} retry={() => void payload.refetch()} compact /> : payload.data ? <JsonInspector value={payload.data.content} filename={`${run.manifest.id}-${selected.seq}.json`} /> : null}</section>}
    </div>
  );
}

function JsonInspector({ value, filename, searchable = false }: { value: unknown; filename: string; searchable?: boolean }) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "unavailable">("idle");
  const serialized = safeStringify(value);
  const shown = search.trim() ? serialized.split("\n").filter((line) => line.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).join("\n") || t("No matching lines.") : serialized;
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(serialized);
      setCopyState("copied");
    } catch {
      setCopyState("unavailable");
    }
    window.setTimeout(() => setCopyState("idle"), 1_500);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([serialized], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return <div className="json-inspector">{(searchable || value !== undefined) && <div className="json-toolbar">{searchable && <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("Search redacted payload")} />}<button type="button" onClick={() => void copy()}>{copyState === "copied" ? t("Copied") : copyState === "unavailable" ? t("Clipboard blocked") : t("Copy")}</button><button type="button" onClick={download}>{t("Download")}</button></div>}<pre>{shown}</pre></div>;
}

function SafePre({ value }: { value: unknown }) { return <pre className="safe-pre">{safeStringify(value)}</pre>; }
function TraceMetric({ label, value, note }: { label: string; value: string | number; note: string }) { return <article><span>{label}</span><strong>{value}</strong><small>{note}</small></article>; }
function DetailTerm({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div><dt>{label}</dt><dd className={mono ? "mono" : undefined}>{value}</dd></div>; }
function TraceLoading({ label, compact = false }: { label: string; compact?: boolean }) { return <div className={`trace-loading${compact ? " compact" : ""}`}><span className="loading-orbit" /><p>{label}</p></div>; }
function TraceError({ error, retry, compact = false }: { error: Error; retry: () => void; compact?: boolean }) {
  const { t } = useI18n();
  const detail = error instanceof WebApiError ? error.detail : undefined;
  const canRetrySameRequest = !detail || detail.retry.kind === "same-request";
  return <div className={`trace-error${compact ? " compact" : ""}`}><span className="eyebrow">{detail?.code ?? t("Trace request failed")}</span><strong>{error.message}</strong>{detail?.retry.discoveryEndpoint && <small>{t("Discover at {endpoint}, then copy {field}. Correct at most once; do not guess.", { endpoint: detail.retry.discoveryEndpoint, field: detail.retry.copyField ?? t("the exact ID") })}</small>}{canRetrySameRequest && <button type="button" onClick={retry}>{t("Retry once")}</button>}{detail?.retry.kind === "after-refresh" && <Link to="/traces">{t("Open trace discovery")}</Link>}</div>;
}
function TraceEmpty({ title, body }: { title: string; body: string }) { return <div className="trace-empty"><span>◇</span><div><strong>{title}</strong><p>{body}</p></div></div>; }

function callLabel(run: TraceRunDetailView, callId: string, t: ReturnType<typeof useI18n>["t"]): string {
  const index = run.callIds.indexOf(callId);
  return index >= 0 ? t("LLM Request #{number}", { number: index + 1 }) : callId;
}

function dateBounds(value: string): Pick<TraceRunFilters, "startedAfter" | "startedBefore"> {
  const start = new Date(`${value}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { startedAfter: start.toISOString(), startedBefore: end.toISOString() };
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "Not captured.";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function compactJson(value: unknown): string {
  if (value === undefined) return "unknown";
  const serialized = safeStringify(value).replace(/\s+/g, " ");
  return serialized.length > 90 ? `${serialized.slice(0, 87)}…` : serialized;
}

function storyTimeSummary(value: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return compactJson(value);
  const record = value as Record<string, unknown>;
  const logicalTime = record.logicalTime && typeof record.logicalTime === "object" && !Array.isArray(record.logicalTime)
    ? record.logicalTime as Record<string, unknown>
    : record;
  const step = typeof logicalTime.step === "number"
    ? logicalTime.step
    : typeof record.logicalStep === "number" ? record.logicalStep : undefined;
  const storyTime = logicalTime.storyTime && typeof logicalTime.storyTime === "object" && !Array.isArray(logicalTime.storyTime)
    ? logicalTime.storyTime as Record<string, unknown>
    : undefined;
  const label = typeof storyTime?.label === "string" ? storyTime.label : undefined;
  const commitId = typeof record.commitId === "string" ? record.commitId : undefined;
  if (step === undefined && !label && !commitId) return compactJson(value);
  return [
    step === undefined ? undefined : `${t("step")} ${step}`,
    label,
    commitId ? `${t("commit")} ${shortId(commitId)}` : undefined,
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

function elapsed(startedAt: string, endedAt: string): string {
  const milliseconds = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}
function formatTokens(value: number, locale?: string): string { return new Intl.NumberFormat(locale, { notation: "compact" }).format(value); }
function formatCost(value: number, locale?: string): string { return value > 0 ? new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 5 }).format(value) : "—"; }
function formatDateTime(value: string, locale?: string): string { return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)); }
function formatTime(value: string, locale?: string): string { return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }).format(new Date(value)); }
function shortId(value: string): string { return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value; }

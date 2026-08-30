import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
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
        <span className="eyebrow">Local observability ledger</span>
        <h1>Trace runs</h1>
        <p>Inspect every Pi request, tool execution, context layer, world boundary, and player-visible response without treating observations as world truth.</p>
      </header>
      <section className="trace-filters" aria-label="Trace filters">
        <label><span>Session</span><select value={sessionId} onChange={(event) => setSessionId(event.target.value)}><option value="">All sessions</option>{sessions.map((session) => <option value={session.id} key={session.id}>{session.title}</option>)}</select></label>
        <label><span>Kind</span><select value={kind} onChange={(event) => setKind(event.target.value as TraceRunKind | "")}><option value="">All kinds</option><option value="player-move">Player move</option><option value="scene-narration">Scene narration</option><option value="narration-retry">Narration retry</option><option value="prepare">Prepare</option></select></label>
        <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as TraceRunStatus | "")}><option value="">All statuses</option><option value="running">Running</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option><option value="interrupted">Interrupted</option></select></label>
        <label><span>Date</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label><span>LLM model ID</span><input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="exact model ID" /></label>
        <label><span>Stage / invocation</span><input value={stage} onChange={(event) => setStage(event.target.value)} placeholder="exact stage name" /></label>
        <button type="button" onClick={() => { setSessionId(""); setKind(""); setStatus(""); setModelId(""); setStage(""); setDate(""); }}>Clear filters</button>
      </section>
      <section className="trace-run-panel">
        <header><div><span className="eyebrow">Runs</span><strong>{query.data?.length ?? 0} matches</strong></div><span className="panel-tag">append-only</span></header>
        {query.isPending ? <TraceLoading label="Reading run index…" /> : query.isError ? <TraceError error={query.error} retry={() => void query.refetch()} /> : query.data.length ? (
          <div className="trace-run-list">
            {query.data.map((run) => <TraceRunRow key={run.id} run={run} sessionName={run.playSessionId ? sessionNames.get(run.playSessionId) : undefined} />)}
          </div>
        ) : <TraceEmpty title="No trace runs match" body="Clear one or more filters, or execute a play operation to create a new run." />}
      </section>
    </>
  );
}

function TraceRunRow({ run, sessionName }: { run: TraceRunManifest; sessionName?: string }) {
  const duration = run.endedAt ? elapsed(run.startedAt, run.endedAt) : "live";
  return (
    <Link
      to={run.playSessionId ? "/play/$sessionId/trace/$runId" : "/traces/$runId"}
      params={run.playSessionId ? { sessionId: run.playSessionId, runId: run.id } : { runId: run.id }}
      className="trace-run-row"
    >
      <span className={`trace-status trace-status-${run.status}`}>{run.status}</span>
      <span className="trace-run-identity"><strong>{run.kind}</strong><small>{sessionName ?? run.playSessionId ?? run.branchId ?? "workspace run"}</small></span>
      <span><strong>{run.counts.llmRequests} LLM</strong><small>{run.counts.toolCalls} tools · {run.counts.retries} retries</small></span>
      <span><strong>{formatTokens(run.usage.totalTokens)}</strong><small>{run.usage.input} in · {run.usage.output} out</small></span>
      <span><strong>{duration}</strong><small>{formatDateTime(run.startedAt)}</small></span>
      <code>{shortId(run.id)}</code>
    </Link>
  );
}

export function TraceDetailPage({ runId, sessionId }: TraceDetailPageProps) {
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

  if (runQuery.isPending) return <TraceLoading label="Replaying the trace ledger…" />;
  if (runQuery.isError) return <TraceError error={runQuery.error} retry={() => void runQuery.refetch()} />;
  const run = runQuery.data;
  const manifest = run.manifest;
  const visibleResponse = playerVisibleText(presentationQuery.data?.content);
  const duration = manifest.endedAt ? elapsed(manifest.startedAt, manifest.endedAt) : "live";
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
    <>
      <header className="trace-heading">
        <div>
          <span className="eyebrow">Player Move → Run → Span → LLM Call</span>
          <h1>{manifest.kind} trajectory</h1>
          <p><code>{manifest.id}</code></p>
        </div>
        <div className="trace-heading-actions">
          {sessionId ? <Link to="/play/$sessionId" params={{ sessionId }}>Back to play</Link> : <Link to="/traces">All traces</Link>}
          <span className={`trace-status trace-status-${manifest.status}`}>{manifest.status}</span>
        </div>
      </header>
      <div className="trace-metric-grid">
        <TraceMetric label="Wall duration" value={duration} note={formatDateTime(manifest.startedAt)} />
        <TraceMetric label="LLM requests" value={manifest.counts.llmRequests} note={`${manifest.counts.retries} provider retries`} />
        <TraceMetric label="Tool calls" value={manifest.counts.toolCalls} note={`${run.events.length} ledger events`} />
        <TraceMetric label="Tokens" value={formatTokens(manifest.usage.totalTokens)} note={`${manifest.usage.input} in · ${manifest.usage.output} out · ${manifest.usage.cacheRead} cached`} />
        <TraceMetric label="Cost" value={formatCost(manifest.usage.cost)} note="provider reported when available" />
      </div>
      <section className="trace-truth-strip">
        <div><span>World head</span><code>{shortId(manifest.previousHead ?? "unknown")} → {shortId(manifest.finalHead ?? "not committed")}</code></div>
        <div><span>Story time</span><code>{storyTimeSummary(manifest.storyTimeBefore)} → {storyTimeSummary(manifest.storyTimeAfter)}</code></div>
        <div><span>Links</span><code>{manifest.eventHash ? `event ${shortId(manifest.eventHash)}` : "no event"}{manifest.auditId ? ` · audit ${shortId(manifest.auditId)}` : ""}</code></div>
      </section>
      {manifest.error && <section className="trace-run-error"><span>{manifest.error.code}</span><strong>{manifest.error.message}</strong><small>{manifest.error.retryable ? "Marked retryable" : "Do not replay unchanged"}</small></section>}
      {presentationQuery.isError && <section className="trace-run-error"><span>TRACE_PAYLOAD</span><strong>{presentationQuery.error.message}</strong><small>The run ledger remains available</small></section>}
      {visibleResponse && <section className="trace-final-response"><span className="eyebrow">Final player-visible response</span><p>{visibleResponse}</p></section>}
      <div className="trace-workbench">
        <section className="trace-ledger-panel">
          <header><div><span className="eyebrow">Trajectory ledger</span><strong>{run.events.length} observations</strong></div><span className="panel-tag">story ≠ wall time</span></header>
          <TraceLedger run={run} selectedCallId={selectedCallId} selectedEventSeq={selectedEventSeq} onSelect={selectEvent} />
        </section>
        <section className="trace-inspector-panel">
          <header>
            <div><span className="eyebrow">Request inspector</span><strong>{selectedCallId ? callLabel(run, selectedCallId) : "Select an LLM request"}</strong></div>
            <div className="trace-call-picker">{run.callIds.map((callId, index) => <button type="button" key={callId} className={callId === selectedCallId ? "selected" : ""} onClick={() => { setSelectedCallId(callId); setSelectedEventSeq(undefined); }}>#{index + 1}</button>)}</div>
          </header>
          <div className="trace-tabs" role="tablist">{inspectorTabs.map((tab) => <button type="button" role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? "selected" : ""} key={tab.id} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}</div>
          <div className="trace-inspector-body">
            {selectedCallId && callQuery.isPending ? <TraceLoading label="Expanding content-addressed context…" compact /> : callQuery.isError ? <TraceError error={callQuery.error} retry={() => void callQuery.refetch()} compact /> : (
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
    </>
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
  return (
    <button
      type="button"
      className={`trace-ledger-row trace-category-${row.category}${selected ? " selected" : ""}`}
      style={{ transform: `translateY(${top}px)`, paddingLeft: 12 + row.depth * 18 }}
      onClick={() => onSelect(row.event)}
    >
      <span className="trace-ledger-seq">{row.event.seq}</span>
      <i />
      <span><strong>{row.label}</strong><small>{row.detail ?? row.event.spanId}</small></span>
      <time>{formatTime(row.event.observedAt)}</time>
      {row.event.blobRef && <b title="Content payload available">◆</b>}
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
  if (!call) return <TraceEmpty title="No LLM request selected" body="Choose a request number or an LLM observation in the trajectory ledger." />;
  const context = latestContext(call.contexts);
  if (activeTab === "context") {
    const left = adjacentIndex < callIndex ? latestContext(adjacentQuery.data?.contexts ?? []) : context;
    const right = adjacentIndex < callIndex ? context : latestContext(adjacentQuery.data?.contexts ?? []);
    return <ContextComposition context={context} diff={adjacentQuery.data ? diffContextParts(left, right) : undefined} leftLabel={adjacentIndex >= 0 ? `Request #${Math.min(callIndex, adjacentIndex) + 1}` : undefined} rightLabel={adjacentIndex >= 0 ? `Request #${Math.max(callIndex, adjacentIndex) + 1}` : undefined} />;
  }
  if (activeTab === "messages") return <LogicalMessages value={context?.logicalMessages} />;
  if (activeTab === "tools") return <ToolsInspector context={context} call={call} />;
  if (activeTab === "payload") return <JsonInspector value={context?.providerPayload} filename={`${call.callId}-provider-payload.json`} searchable />;
  if (activeTab === "response") return <ResponseInspector call={call} />;
  return <UsageInspector call={call} context={context} />;
}

function ContextComposition({ context, diff, leftLabel, rightLabel }: { context?: TraceContextSnapshotView; diff?: ContextPartDiff[]; leftLabel?: string; rightLabel?: string }) {
  const parent = useRef<HTMLDivElement>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const parts = context?.parts ?? [];
  const virtual = useVirtualizer({ count: parts.length, getScrollElement: () => parent.current, estimateSize: () => 112, overscan: 6 });
  if (!context) return <TraceEmpty title="No finalized context" body="This request ended before a semantic context snapshot was persisted." />;
  const visibleDiff = diff?.filter((entry) => showUnchanged || entry.status !== "unchanged");
  return (
    <div className="context-inspector">
      <div className="context-summary">
        <span><strong>{parts.length}</strong><small>semantic parts</small></span>
        <span><strong>{context.snapshot.estimatedInputTokens ?? "—"}</strong><small>estimated input tokens</small></span>
        <span><strong>{context.snapshot.providerId ?? "—"}</strong><small>{context.snapshot.modelId ?? "model unknown"}</small></span>
        <span><strong>{context.requestAttempt ?? 1}</strong><small>request attempt</small></span>
      </div>
      <div ref={parent} className="context-part-scroll">
        <div className="trace-virtual-space" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((item) => {
            const part = parts[item.index]!;
            return (
              <article ref={virtual.measureElement} data-index={item.index} className={`context-part context-part-${part.disposition}`} key={part.id} style={{ transform: `translateY(${item.start}px)` }}>
                <header><span className="context-kind">{part.kind}</span><strong>{part.label}</strong><span className={`authority authority-${part.authority}`}>{part.authority}</span></header>
                <div><code>{part.id}</code><span>{part.charCount} chars · ~{part.estimatedTokens ?? "?"} tokens · messages [{part.logicalMessageIndexes.join(", ") || "none"}]</span></div>
                {part.sourceRefs.length > 0 && <small>{part.sourceRefs.map((ref) => `${ref.sourceId}${ref.startByte !== undefined ? `:${ref.startByte}-${ref.endByte ?? "?"}` : ""}`).join(" · ")}</small>}
                {part.content !== undefined && <details><summary>View captured content</summary><SafePre value={part.content} /></details>}
              </article>
            );
          })}
        </div>
      </div>
      {diff && <section className="context-diff">
        <header><div><span className="eyebrow">Context diff</span><strong>{leftLabel} → {rightLabel}</strong></div><label><input type="checkbox" checked={showUnchanged} onChange={(event) => setShowUnchanged(event.target.checked)} />Show unchanged</label></header>
        {visibleDiff?.length ? visibleDiff.map((entry) => <div key={entry.id} className={`context-diff-row diff-${entry.status}`}><span>{entry.status}</span><strong>{entry.label}</strong><code>{entry.id}</code><small>{entry.changes.join(", ") || "same ID, hash, authority, disposition, and indexes"}</small></div>) : <p>No context-part changes between these adjacent requests.</p>}
      </section>}
    </div>
  );
}

function LogicalMessages({ value }: { value: unknown }) {
  if (!Array.isArray(value)) return <JsonInspector value={value} filename="logical-messages.json" />;
  return <VirtualJsonList values={value} label="logical messages" />;
}

function VirtualJsonList({ values, label }: { values: unknown[]; label: string }) {
  const parent = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: values.length, getScrollElement: () => parent.current, estimateSize: () => 150, overscan: 5 });
  return <div><div className="inspector-note">{values.length} {label} · captured after Pi context assembly</div><div ref={parent} className="json-list-scroll"><div className="trace-virtual-space" style={{ height: virtual.getTotalSize() }}>{virtual.getVirtualItems().map((item) => <article ref={virtual.measureElement} data-index={item.index} className="json-message" key={item.key} style={{ transform: `translateY(${item.start}px)` }}><span>Message {item.index + 1}</span><SafePre value={values[item.index]} /></article>)}</div></div></div>;
}

function ToolsInspector({ context, call }: { context?: TraceContextSnapshotView; call: TraceCallDetail }) {
  return (
    <div className="tools-inspector">
      <span className="inspector-section-title">Available to this request · {context?.availableTools.length ?? 0}</span>
      {context?.availableTools.length ? context.availableTools.map((tool) => <details key={tool.name} className="tool-card"><summary><strong>{tool.name}</strong><small>{tool.description}</small></summary><SafePre value={tool.parameters} /></details>) : <TraceEmpty title="No active tools" body="This Pi request had no tool schema in its finalized context." />}
      <span className="inspector-section-title">Actually executed · {call.tools.length}</span>
      {call.tools.map((tool) => <article className={`tool-execution tool-${tool.status}`} key={tool.toolCallId}><header><span>{tool.status}</span><strong>{tool.name}</strong><code>{tool.toolCallId}</code></header><details><summary>Input</summary><SafePre value={tool.input} /></details>{tool.progress.length > 0 && <details><summary>{tool.progress.length} progress updates</summary><SafePre value={tool.progress} /></details>}<details><summary>Result</summary><SafePre value={tool.result} /></details></article>)}
    </div>
  );
}

function ResponseInspector({ call }: { call: TraceCallDetail }) {
  const deltas = call.responses.filter((response) => response.status === "delta").map((response) => playerVisibleText(response.content) ?? "").join("");
  const final = [...call.responses].reverse().find((response) => response.status === "completed" || response.status === "failed");
  const finalText = playerVisibleText(final?.content);
  return (
    <div className="response-inspector">
      {deltas && <section><span className="inspector-section-title">Coalesced stream replay</span><p className="response-text">{deltas}</p></section>}
      <section><span className="inspector-section-title">Authoritative completed message</span>{finalText && <p className="response-text">{finalText}</p>}<SafePre value={final?.content ?? "No completed response payload was recorded."} /></section>
      <section><span className="inspector-section-title">Response observations</span><SafePre value={call.responses.map(({ content: _content, ...response }) => response)} /></section>
    </div>
  );
}

function UsageInspector({ call, context }: { call: TraceCallDetail; context?: TraceContextSnapshotView }) {
  return (
    <div className="usage-inspector">
      <div className="context-summary">
        <span><strong>{call.usage.input}</strong><small>provider input</small></span><span><strong>{call.usage.output}</strong><small>provider output</small></span><span><strong>{call.usage.cacheRead}</strong><small>cache read</small></span><span><strong>{call.usage.reasoning ?? "—"}</strong><small>reasoning tokens</small></span>
      </div>
      <dl className="trace-detail-list">
        <DetailTerm label="Model" value={`${context?.snapshot.providerId ?? "unknown"}/${context?.snapshot.modelId ?? "unknown"}`} />
        <DetailTerm label="Assembly" value={context?.snapshot.assemblyVersion ?? "unknown"} />
        <DetailTerm label="Started" value={call.startedAt ? formatDateTime(call.startedAt) : "not observed"} />
        <DetailTerm label="First response" value={call.firstResponseAt ? `${formatDateTime(call.firstResponseAt)} · ${call.timeToFirstResponseMs ?? "?"} ms locally measured` : "not observed"} />
        <DetailTerm label="Completed" value={call.endedAt ? formatDateTime(call.endedAt) : "not observed"} />
        <DetailTerm label="Total duration" value={call.durationMs !== undefined ? `${call.durationMs} ms locally measured` : "unknown"} />
        <DetailTerm label="Estimated input" value={context?.snapshot.estimatedInputTokens !== undefined ? `~${context.snapshot.estimatedInputTokens} tokens — estimate, not billing` : "unknown"} />
        <DetailTerm label="Provider total" value={`${call.usage.totalTokens} tokens`} />
        <DetailTerm label="Cost" value={formatCost(call.usage.cost)} />
      </dl>
    </div>
  );
}

function WorldEffects({ run, selectedEventSeq, onSelect }: { run: TraceRunDetailView; selectedEventSeq?: number; onSelect: (seq: number) => void }) {
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
      <section className="effect-links"><span className="inspector-section-title">Authoritative links</span><dl className="trace-detail-list"><DetailTerm label="Previous head" value={run.manifest.previousHead ?? "unknown"} mono /><DetailTerm label="Final head" value={run.manifest.finalHead ?? "no commit"} mono /><DetailTerm label="Committed event" value={run.manifest.eventHash ?? "none"} mono /><DetailTerm label="Audit" value={run.manifest.auditId ?? "none"} mono /><DetailTerm label="Presentation" value={run.manifest.presentationMessageIds.join(", ") || "none"} mono /><DetailTerm label="Story time before" value={compactJson(run.manifest.storyTimeBefore)} mono /><DetailTerm label="Story time after" value={compactJson(run.manifest.storyTimeAfter)} mono /></dl></section>
      <span className="inspector-section-title">Validation / commit / presentation ledger</span>
      <div className="effect-events">{effects.map((event) => <button type="button" key={event.seq} className={event.seq === selected?.seq ? "selected" : ""} onClick={() => onSelect(event.seq)}><span>{event.seq}</span><strong>{event.type}</strong><small>{compactJson(event.storyTime ?? event.data)}</small>{event.blobRef && <b>payload</b>}</button>)}</div>
      {selected && <section className="effect-payload"><span className="inspector-section-title">Selected observation #{selected.seq}</span><SafePre value={selected.data} />{payload.isPending && selected.blobRef ? <TraceLoading label="Verifying payload hash…" compact /> : payload.isError ? <TraceError error={payload.error} retry={() => void payload.refetch()} compact /> : payload.data ? <JsonInspector value={payload.data.content} filename={`${run.manifest.id}-${selected.seq}.json`} /> : null}</section>}
    </div>
  );
}

function JsonInspector({ value, filename, searchable = false }: { value: unknown; filename: string; searchable?: boolean }) {
  const [search, setSearch] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "unavailable">("idle");
  const serialized = safeStringify(value);
  const shown = search.trim() ? serialized.split("\n").filter((line) => line.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).join("\n") || "No matching lines." : serialized;
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
  return <div className="json-inspector">{(searchable || value !== undefined) && <div className="json-toolbar">{searchable && <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search redacted payload" />}<button type="button" onClick={() => void copy()}>{copyState === "copied" ? "Copied" : copyState === "unavailable" ? "Clipboard blocked" : "Copy"}</button><button type="button" onClick={download}>Download</button></div>}<pre>{shown}</pre></div>;
}

function SafePre({ value }: { value: unknown }) { return <pre className="safe-pre">{safeStringify(value)}</pre>; }
function TraceMetric({ label, value, note }: { label: string; value: string | number; note: string }) { return <article><span>{label}</span><strong>{value}</strong><small>{note}</small></article>; }
function DetailTerm({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div><dt>{label}</dt><dd className={mono ? "mono" : undefined}>{value}</dd></div>; }
function TraceLoading({ label, compact = false }: { label: string; compact?: boolean }) { return <div className={`trace-loading${compact ? " compact" : ""}`}><span className="loading-orbit" /><p>{label}</p></div>; }
function TraceError({ error, retry, compact = false }: { error: Error; retry: () => void; compact?: boolean }) {
  const detail = error instanceof WebApiError ? error.detail : undefined;
  const canRetrySameRequest = !detail || detail.retry.kind === "same-request";
  return <div className={`trace-error${compact ? " compact" : ""}`}><span className="eyebrow">{detail?.code ?? "Trace request failed"}</span><strong>{error.message}</strong>{detail?.retry.discoveryEndpoint && <small>Discover at <code>{detail.retry.discoveryEndpoint}</code>, then copy <code>{detail.retry.copyField ?? "the exact ID"}</code>. Correct at most once; do not guess.</small>}{canRetrySameRequest && <button type="button" onClick={retry}>Retry once</button>}{detail?.retry.kind === "after-refresh" && <Link to="/traces">Open trace discovery</Link>}</div>;
}
function TraceEmpty({ title, body }: { title: string; body: string }) { return <div className="trace-empty"><span>◇</span><div><strong>{title}</strong><p>{body}</p></div></div>; }

function callLabel(run: TraceRunDetailView, callId: string): string {
  const index = run.callIds.indexOf(callId);
  return index >= 0 ? `LLM Request #${index + 1}` : callId;
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

function storyTimeSummary(value: unknown): string {
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
    step === undefined ? undefined : `step ${step}`,
    label,
    commitId ? `commit ${shortId(commitId)}` : undefined,
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

function elapsed(startedAt: string, endedAt: string): string {
  const milliseconds = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}
function formatTokens(value: number): string { return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value); }
function formatCost(value: number): string { return value > 0 ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 5 }).format(value) : "—"; }
function formatDateTime(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)); }
function formatTime(value: string): string { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }).format(new Date(value)); }
function shortId(value: string): string { return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value; }

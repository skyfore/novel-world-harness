import { useEffect, useMemo, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  acceptProposal,
  cancelOperation,
  convergeProposals,
  createInstance,
  fetchOperation,
  fetchOperations,
  fetchPreparation,
  fetchProposal,
  fetchProposals,
  registerSource,
  rejectProposal,
  startPreparation,
} from "./api";
import { canRetrySameRequest, recoveryInstruction, webErrorDetail } from "./recovery";
import {
  preparationSnapshotSchema,
  type ModelSummary,
  type OperationSnapshot,
  type PreparationSnapshot,
  type ProposalStatus,
  type SourceRegistrationResult,
} from "../../../src/web/contracts";

const bootstrapQueryKey = ["bootstrap"] as const;
export const preparationKey = (sourceId: string) => ["preparation", sourceId] as const;
export const proposalsKey = (sourceId: string, status: ProposalStatus) => ["proposals", sourceId, status] as const;
const proposalKey = (proposalId: string, status: ProposalStatus) => ["proposal", proposalId, status] as const;
const operationsKey = (scopeId: string) => ["operations", scopeId] as const;
const operationKey = (operationId: string) => ["operation", operationId] as const;

export function NewNovelPage({
  csrfToken,
  onRegistered,
}: {
  csrfToken: string;
  onRegistered: (result: SourceRegistrationResult) => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState<string>();
  const [fileError, setFileError] = useState<string>();
  const registerMutation = useMutation({
    mutationFn: (request: { title: string; content: string; clientRequestId: string }) => registerSource(request, csrfToken),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
      queryClient.setQueryData(preparationKey(result.source.id), result.preparation);
      onRegistered(result);
    },
  });

  const readFile = async (file: File) => {
    setFileError(undefined);
    if (file.size > 24 * 1024 * 1024) {
      setFileError("The selected file exceeds the 24 MB browser-ingest limit.");
      return;
    }
    try {
      const text = await file.text();
      if (!text.trim()) throw new Error("The selected file is empty.");
      if (text.includes("\0")) throw new Error("The selected file appears to be binary; use a UTF-8 text export.");
      setTitle(file.name);
      setContent(text);
      setFileName(file.name);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error));
    }
  };
  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void readFile(file);
  };
  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) void readFile(file);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !content.trim() || registerMutation.isPending) return;
    registerMutation.mutate({ title: title.trim(), content, clientRequestId: requestId("register-source") });
  };

  return (
    <>
      <header className="page-heading import-heading">
        <span className="eyebrow">Immutable source evidence</span>
        <h1>Register a novel</h1>
        <p>Choose a UTF-8 text file or paste the source. Browser content is archived by hash; its filename is only an ingest label, never inferred story truth.</p>
      </header>
      <form className="import-workbench" onSubmit={submit}>
        <section className="import-source-panel">
          <label className="file-drop" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
            <input type="file" accept=".txt,.text,.novel,.md,.markdown,text/plain,text/markdown" onChange={onFile} />
            <span className="file-drop-mark">＋</span>
            <strong>{fileName ?? "Drop a text novel here"}</strong>
            <small>or click to choose · UTF-8 · up to 24 MB</small>
          </label>
          <div className="trust-boundary-note">
            <span>Evidence boundary</span>
            <p>Novel content is untrusted model evidence. It cannot become harness instructions, world truth, or a branch event until typed validation commits it.</p>
          </div>
        </section>
        <section className="import-editor-panel">
          <label className="field-label">
            <span>Source label</span>
            <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="novel.txt" />
          </label>
          <label className="field-label import-text-field">
            <span>Source text <small>{formatCount(content.length)} characters</small></span>
            <textarea value={content} onChange={(event) => { setContent(event.target.value); setFileName(undefined); }} placeholder="Paste the complete novel text here…" />
          </label>
          {(fileError || registerMutation.error) && <InlineError error={fileError ?? registerMutation.error!} />}
          <div className="import-actions">
            <Link to="/" className="secondary-button">Cancel</Link>
            <button className="primary-button" type="submit" disabled={!title.trim() || !content.trim() || registerMutation.isPending}>
              {registerMutation.isPending ? "Archiving and indexing…" : "Register and inspect"}
            </button>
          </div>
        </section>
      </form>
    </>
  );
}

export function CompilerWorkbenchPage({
  sourceId,
  csrfToken,
  models,
  onInstanceCreated,
}: {
  sourceId: string;
  csrfToken: string;
  models: ModelSummary[];
  onInstanceCreated: (branchId: string) => void;
}) {
  const queryClient = useQueryClient();
  const preparation = useQuery({
    queryKey: preparationKey(sourceId),
    queryFn: ({ signal }) => fetchPreparation(sourceId, undefined, signal),
  });
  const [proposalStatus, setProposalStatus] = useState<ProposalStatus>("pending");
  const proposals = useQuery({
    queryKey: proposalsKey(sourceId, proposalStatus),
    queryFn: ({ signal }) => fetchProposals(sourceId, proposalStatus, undefined, signal),
  });
  const operations = useQuery({
    queryKey: operationsKey(sourceId),
    queryFn: ({ signal }) => fetchOperations(sourceId, signal),
    refetchInterval: 2_000,
  });
  const [selectedOperationId, setSelectedOperationId] = useState<string>();
  const effectiveOperationId = selectedOperationId
    ?? operations.data?.find((operation) => !isTerminal(operation.status))?.id
    ?? operations.data?.find((operation) => operation.kind === "prepare")?.id;
  const operation = useQuery({
    queryKey: operationKey(effectiveOperationId ?? "none"),
    queryFn: ({ signal }) => fetchOperation(effectiveOperationId!, signal),
    enabled: Boolean(effectiveOperationId),
    refetchInterval: (query) => isTerminal(query.state.data?.status) ? false : 750,
  });
  const [selectedProposalId, setSelectedProposalId] = useState<string>();
  const effectiveProposalId = proposals.data?.some((proposal) => proposal.id === selectedProposalId)
    ? selectedProposalId
    : proposals.data?.[0]?.id;
  const proposal = useQuery({
    queryKey: proposalKey(effectiveProposalId ?? "none", proposalStatus),
    queryFn: ({ signal }) => fetchProposal(effectiveProposalId!, proposalStatus, signal),
    enabled: Boolean(effectiveProposalId),
  });
  const [model, setModel] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [branchId, setBranchId] = useState("");

  useEffect(() => {
    if (!branchId && preparation.data?.branchId) setBranchId(preparation.data.branchId);
  }, [branchId, preparation.data?.branchId]);
  useEffect(() => {
    const current = operation.data;
    if (!current || !isTerminal(current.status)) return;
    void invalidateCompiler(queryClient, sourceId);
  }, [operation.data?.id, operation.data?.status, queryClient, sourceId]);

  const prepareMutation = useMutation({
    mutationFn: (mode: "next" | "all") => startPreparation(sourceId, {
      mode,
      ...(model ? { model } : {}),
      ...(branchId ? { branchId } : {}),
      clientRequestId: requestId(`prepare-${mode}`),
    }, csrfToken),
    onSuccess: (accepted) => {
      setSelectedOperationId(accepted.operation.id);
      queryClient.setQueryData(operationKey(accepted.operation.id), accepted.operation);
    },
  });
  const cancelMutation = useMutation({
    mutationFn: () => cancelOperation(operation.data!.id, csrfToken),
    onSuccess: (snapshot) => queryClient.setQueryData(operationKey(snapshot.id), snapshot),
  });
  const acceptMutation = useMutation({
    mutationFn: () => acceptProposal(effectiveProposalId!, { clientRequestId: requestId("accept-proposal") }, csrfToken),
    onSuccess: async () => {
      setSelectedProposalId(undefined);
      await invalidateCompiler(queryClient, sourceId);
    },
  });
  const rejectMutation = useMutation({
    mutationFn: () => rejectProposal(effectiveProposalId!, {
      reason: rejectionReason,
      clientRequestId: requestId("reject-proposal"),
    }, csrfToken),
    onSuccess: async () => {
      setRejectionReason("");
      setSelectedProposalId(undefined);
      await invalidateCompiler(queryClient, sourceId);
    },
  });
  const convergeMutation = useMutation({
    mutationFn: () => convergeProposals(sourceId, { clientRequestId: requestId("converge-proposals") }, csrfToken),
    onSuccess: async () => invalidateCompiler(queryClient, sourceId),
  });
  const instanceMutation = useMutation({
    mutationFn: () => createInstance({
      sourceId,
      branchId,
      clientRequestId: requestId("create-instance"),
    }, csrfToken),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
      onInstanceCreated(result.instance.branchId);
    },
  });

  if (preparation.isPending) return <LoadingState label="Inspecting compiler checkpoints…" />;
  if (preparation.isError) return <PageError error={preparation.error} retry={() => void preparation.refetch()} />;
  const snapshot = preparation.data;
  const current = operation.data;
  const busy = Boolean(current && !isTerminal(current.status));
  const logs = operationLogs(current);
  const operationResult = preparationSnapshotSchema.safeParse(current?.result);
  const decisionError = firstError(acceptMutation.error, rejectMutation.error, convergeMutation.error, prepareMutation.error, cancelMutation.error, instanceMutation.error);

  return (
    <>
      <header className="compile-heading">
        <div>
          <span className="eyebrow">Proposal → validate → commit</span>
          <h1>{snapshot.source.title}</h1>
          <p>Compiler work remains isolated from runtime truth. Review every proposal before publishing an immutable prepared revision.</p>
        </div>
        <div className="compile-heading-actions">
          <Link to="/novels/$sourceId" params={{ sourceId }} className="secondary-button">Novel overview</Link>
          <Link to="/traces" search={{ kind: "prepare" }} className="secondary-button">Prepare traces</Link>
        </div>
      </header>

      <PreparationHeader snapshot={snapshot} />

      <section className="compile-control-strip">
        <label>
          <span>Pi model override</span>
          <select value={model} onChange={(event) => setModel(event.target.value)} disabled={busy}>
            <option value="">Workspace routing default</option>
            {models.filter((candidate) => candidate.available).map((candidate) => (
              <option value={`${candidate.providerId}/${candidate.id}`} key={`${candidate.providerId}/${candidate.id}`}>{candidate.name} · {candidate.providerId}</option>
            ))}
          </select>
        </label>
        <div className="compile-primary-actions">
          {snapshot.stage === "compile" && <>
            <button className="secondary-button" disabled={busy || prepareMutation.isPending} onClick={() => prepareMutation.mutate("next")}>Compile next batch</button>
            <button className="primary-button" disabled={busy || prepareMutation.isPending} onClick={() => prepareMutation.mutate("all")}>Compile all remaining</button>
          </>}
          {snapshot.stage === "needs-initial-world" && <button className="primary-button" disabled={busy || prepareMutation.isPending} onClick={() => prepareMutation.mutate("next")}>Generate opening-world proposal</button>}
          {snapshot.stage === "review" && <button className="primary-button" disabled={!snapshot.proposalCounts.pending || convergeMutation.isPending} onClick={() => window.confirm("Accept every proposal that passes deterministic validation? Blocked proposals will remain pending for review.") && convergeMutation.mutate()}>Converge all valid</button>}
          {snapshot.stage === "create-branch" && <>
            <input className="branch-id-input" aria-label="New instance branch ID" value={branchId} onChange={(event) => setBranchId(event.target.value)} />
            <button className="primary-button" disabled={!branchId || instanceMutation.isPending} onClick={() => instanceMutation.mutate()}>Create world instance</button>
          </>}
          {snapshot.stage === "ready" && <Link className="primary-button" to="/instances/$branchId" params={{ branchId: snapshot.branchId }}>Open ready instance</Link>}
        </div>
      </section>

      {snapshot.stage === "repair" && <section className="repair-barrier"><span>Repair barrier</span><div><strong>Publication is blocked by deterministic checks</strong>{snapshot.repairReasons.map((reason) => <p key={reason}>{reason}</p>)}</div></section>}

      <div className="compile-layout">
        <section className="compiler-operation-panel">
          <header>
            <div><span className="eyebrow">Operation</span><strong>{current ? current.phase : "No active compiler run"}</strong></div>
            {current && <span className={`operation-status operation-${current.status}`}>{current.status}</span>}
          </header>
          {current ? <>
            <div className="compiler-operation-meta">
              <span><small>Operation</small><code>{current.id}</code></span>
              <span><small>Mutation boundary</small><strong>{current.commitBoundaryCrossed ? "crossed" : "not crossed"}</strong></span>
              <span><small>Model output</small><strong>{formatCount(numberProgress(current, "modelTextCharacters"))} chars</strong></span>
              {current.runId && <Link to="/traces/$runId" params={{ runId: current.runId }}>Inspect trace ↗</Link>}
            </div>
            <div className="compiler-log" aria-live="polite">
              {logs.length ? logs.map((line, index) => <p key={`${index}:${line}`}><span>{String(index + 1).padStart(2, "0")}</span>{line}</p>) : <p><span>—</span>Waiting for the first compiler checkpoint…</p>}
            </div>
            {busy && current.cancellable && <button className="stop-button" disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>{current.commitBoundaryCrossed ? "Stop after current mutation" : "Cancel preparation"}</button>}
            {current.error && <div className="inline-error"><strong>{current.error.code}</strong><span>{current.error.message}</span><small>{recoveryInstruction(current.error)}</small></div>}
            {operationResult.success && <div className="compiler-result"><strong>Checkpoint refreshed</strong><span>{operationResult.data.stage} · {operationResult.data.proposalCounts.pending} pending proposal(s)</span></div>}
          </> : <div className="empty-state compact"><span>◇</span><div><strong>Compiler idle</strong><p>Choose the next batch or compile all remaining evidence.</p></div></div>}
          {operations.data && operations.data.length > 1 && <div className="compiler-operation-history">{operations.data.filter((item) => item.kind === "prepare").slice(0, 8).map((item) => <button key={item.id} className={item.id === effectiveOperationId ? "selected" : ""} onClick={() => setSelectedOperationId(item.id)}><span>{item.status}</span><small>{formatTime(item.createdAt)}</small></button>)}</div>}
        </section>

        <section className="proposal-workbench">
          <header>
            <div><span className="eyebrow">Proposal inbox</span><strong>{proposals.data?.length ?? 0} {proposalStatus}</strong></div>
            <div className="proposal-status-tabs">{(["pending", "accepted", "rejected"] as const).map((status) => <button className={proposalStatus === status ? "selected" : ""} key={status} onClick={() => { setProposalStatus(status); setSelectedProposalId(undefined); }}>{status}</button>)}</div>
          </header>
          <div className="proposal-split">
            <div className="proposal-list">
              {proposals.isPending ? <LoadingState label="Reading proposal inbox…" compact /> : proposals.isError ? <InlineError error={proposals.error} /> : proposals.data.length ? proposals.data.map((item) => (
                <button key={item.id} className={item.id === effectiveProposalId ? "selected" : ""} onClick={() => setSelectedProposalId(item.id)}>
                  <span className={`proposal-kind proposal-kind-${item.kind}`}>{item.kind}</span>
                  <strong>{item.id}</strong>
                  <small>{item.worker} · {formatTime(item.createdAt)}</small>
                </button>
              )) : <div className="empty-state compact"><span>◇</span><div><strong>No {proposalStatus} proposals</strong><p>The inbox is clear for this status.</p></div></div>}
            </div>
            <div className="proposal-inspector">
              {proposal.isPending && effectiveProposalId ? <LoadingState label="Reading full proposal envelope…" compact /> : proposal.isError ? <InlineError error={proposal.error} /> : proposal.data ? <>
                <div className="proposal-inspector-heading">
                  <span><small>{proposal.data.summary.kind}</small><strong>{proposal.data.summary.id}</strong></span>
                  <span className={`operation-status operation-${proposal.data.summary.status === "accepted" ? "succeeded" : proposal.data.summary.status === "rejected" ? "failed" : "queued"}`}>{proposal.data.summary.status}</span>
                </div>
                <details open className="proposal-json"><summary>Complete typed envelope</summary><pre>{safeJson(proposal.data.envelope)}</pre></details>
                {proposal.data.rejection && <div className="proposal-validation-errors">{proposal.data.rejection.errors.map((issue) => <p key={`${issue.code}:${issue.path ?? ""}`}><strong>{issue.code}</strong>{issue.message}{issue.path && <code>{issue.path}</code>}</p>)}</div>}
                {proposalStatus === "pending" && <div className="proposal-decision">
                  <button className="primary-button" disabled={acceptMutation.isPending || rejectMutation.isPending} onClick={() => acceptMutation.mutate()}>Validate and accept</button>
                  <label><span>Rejection reason</span><textarea rows={2} value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} placeholder="Record why this proposal should not enter canonical history…" /></label>
                  <button className="danger-button" disabled={!rejectionReason.trim() || acceptMutation.isPending || rejectMutation.isPending} onClick={() => rejectMutation.mutate()}>Reject with diagnostic</button>
                </div>}
              </> : <div className="empty-state compact"><span>◇</span><div><strong>Select a proposal</strong><p>Inspect its full payload, evidence references, generation metadata, and rejection diagnostics.</p></div></div>}
            </div>
          </div>
        </section>
      </div>

      {convergeMutation.data && <section className="convergence-result">
        <strong>Convergence complete</strong>
        <span>{convergeMutation.data.accepted.length} accepted · {convergeMutation.data.blocked.length} blocked · {convergeMutation.data.staging.length} staging</span>
        {convergeMutation.data.blocked.slice(0, 8).map((item) => <p key={item.id}><code>{item.id}</code>{item.errors[0]?.message ?? "Blocked by deterministic validation."}</p>)}
      </section>}
      {decisionError && <div className="floating-error"><InlineError error={decisionError} /></div>}
    </>
  );
}

function PreparationHeader({ snapshot }: { snapshot: PreparationSnapshot }) {
  const audit = snapshot.audit;
  return (
    <section className="preparation-header">
      <div className="preparation-stage-card">
        <span className={`stage-glyph stage-${snapshot.stage}`}>{stageNumber(snapshot.stage)}</span>
        <div><small>Current barrier</small><strong>{stageLabel(snapshot.stage)}</strong><p>{nextActionCopy(snapshot)}</p></div>
      </div>
      <div className="preparation-progress-card">
        <span><small>Evidence batches</small><strong>{snapshot.progress.completedBatches}/{snapshot.progress.totalBatches}</strong></span>
        <div className="progress-track"><i style={{ width: `${Math.round(snapshot.progress.ratio * 100)}%` }} /></div>
        <small>{Math.round(snapshot.progress.ratio * 100)}% checkpointed</small>
      </div>
      <div className="preparation-metrics">
        <span><small>Pending</small><strong>{snapshot.proposalCounts.pending}</strong></span>
        <span><small>Entities</small><strong>{audit?.canonical.entities ?? "—"}</strong></span>
        <span><small>Events</small><strong>{audit?.canonical.events ?? "—"}</strong></span>
        <span><small>Rules</small><strong>{audit?.canonical.rules ?? "—"}</strong></span>
        <span><small>Publication</small><strong>{audit?.readiness.publication ?? "unknown"}</strong></span>
      </div>
    </section>
  );
}

async function invalidateCompiler(queryClient: ReturnType<typeof useQueryClient>, sourceId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: preparationKey(sourceId) }),
    queryClient.invalidateQueries({ queryKey: ["proposals", sourceId] }),
    queryClient.invalidateQueries({ queryKey: bootstrapQueryKey }),
  ]);
}

function stageNumber(stage: PreparationSnapshot["stage"]): string {
  return ({
    "needs-source": "0",
    "choose-source": "0",
    compile: "1",
    review: "2",
    repair: "!",
    "needs-initial-world": "3",
    "create-branch": "4",
    ready: "✓",
  })[stage];
}

function stageLabel(stage: PreparationSnapshot["stage"]): string {
  return ({
    "needs-source": "Source required",
    "choose-source": "Choose source",
    compile: "Compile evidence",
    review: "Review proposals",
    repair: "Repair required",
    "needs-initial-world": "Opening world required",
    "create-branch": "Ready to publish",
    ready: "Playable world ready",
  })[stage];
}

function nextActionCopy(snapshot: PreparationSnapshot): string {
  if (snapshot.stage === "compile") return `${snapshot.progress.remainingBatches} evidence batch(es) remain.`;
  if (snapshot.stage === "review") return "Inspect proposal payloads and commit only validated artifacts.";
  if (snapshot.stage === "needs-initial-world") return "Generate one evidence-backed playable checkpoint.";
  if (snapshot.stage === "create-branch") return `Publish a revision and create branch '${snapshot.branchId}'.`;
  if (snapshot.stage === "ready") return `Branch '${snapshot.branchId}' is pinned to committed history.`;
  if (snapshot.stage === "repair") return "Resolve the listed deterministic blockers before publication.";
  return `Next action: ${snapshot.nextAction}.`;
}

function operationLogs(operation?: OperationSnapshot): string[] {
  const value = operation?.progress.logs;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(-80) : [];
}

function numberProgress(operation: OperationSnapshot, key: string): number {
  const value = operation.progress[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isTerminal(status?: OperationSnapshot["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function requestId(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }
function formatCount(value: number): string { return new Intl.NumberFormat(undefined, { notation: value > 9_999 ? "compact" : "standard" }).format(value); }
function formatTime(value: string): string { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
function safeJson(value: unknown): string { return JSON.stringify(value, null, 2); }
function firstError(...errors: Array<Error | null | undefined>): Error | undefined { return errors.find((error): error is Error => error instanceof Error); }

function LoadingState({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div className={compact ? "inline-loading compiler-inline-loading" : "center-state"}><span className="loading-orbit" />{compact ? label : <><h1>{label}</h1><p>Reading local, authoritative workspace state…</p></>}</div>;
}

function PageError({ error, retry }: { error: Error; retry: () => void }) {
  const detail = webErrorDetail(error);
  return <div className="center-state center-error"><span className="eyebrow">{detail?.code ?? "Request failed"}</span><h1>Compiler state could not be read</h1><p>{error.message}</p>{detail && <small>{recoveryInstruction(detail)}</small>}{canRetrySameRequest(error) && <button onClick={retry}>Retry once</button>}</div>;
}

function InlineError({ error }: { error: Error | string }) {
  const message = typeof error === "string" ? error : error.message;
  const detail = typeof error === "string" ? undefined : webErrorDetail(error);
  return <div className="inline-error"><strong>{detail?.code ?? "Request failed"}</strong><span>{message}</span>{detail && <small>{recoveryInstruction(detail)}</small>}</div>;
}

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  acceptProposal,
  cancelOperation,
  convergeProposals,
  createInstance,
  fetchOperation,
  fetchOntology,
  fetchOntologyNode,
  fetchOperations,
  fetchPreparation,
  fetchProposal,
  fetchProposals,
  registerSource,
  rejectProposal,
  startPreparation,
} from "./api";
import { familyVisuals, nodeColor, nodeFamily, statusColors } from "./ontology-graph";
import { canRetrySameRequest, recoveryInstruction, webErrorDetail } from "./recovery";
import { useI18n } from "./i18n";
import {
  preparationSnapshotSchema,
  type ModelSummary,
  type OperationSnapshot,
  type OntologyNode,
  type PreparationSnapshot,
  type ProposalSummary,
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
  const { t, localeTag } = useI18n();
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
      setFileError(t("The selected file exceeds the 24 MB browser-ingest limit."));
      return;
    }
    try {
      const text = await file.text();
      if (!text.trim()) throw new Error(t("The selected file is empty."));
      if (text.includes("\0")) throw new Error(t("The selected file appears to be binary; use a UTF-8 text export."));
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
        <span className="eyebrow">{t("Immutable source evidence")}</span>
        <h1>{t("Register a novel")}</h1>
        <p>{t("Choose a UTF-8 text file or paste the source. Browser content is archived by hash; its filename is only an ingest label, never inferred story truth.")}</p>
      </header>
      <form className="import-workbench" onSubmit={submit}>
        <section className="import-source-panel">
          <label className="file-drop" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
            <input type="file" accept=".txt,.text,.novel,.md,.markdown,text/plain,text/markdown" onChange={onFile} />
            <span className="file-drop-mark">＋</span>
            <strong>{fileName ?? t("Drop a text novel here")}</strong>
            <small>{t("or click to choose · UTF-8 · up to 24 MB")}</small>
          </label>
          <div className="trust-boundary-note">
            <span>{t("Evidence boundary")}</span>
            <p>{t("Novel content is untrusted model evidence. It cannot become harness instructions, world truth, or a branch event until typed validation commits it.")}</p>
          </div>
        </section>
        <section className="import-editor-panel">
          <label className="field-label">
            <span>{t("Source label")}</span>
            <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="novel.txt" />
          </label>
          <label className="field-label import-text-field">
            <span>{t("Source text")} <small>{t("{count} characters", { count: formatCount(content.length, localeTag) })}</small></span>
            <textarea value={content} onChange={(event) => { setContent(event.target.value); setFileName(undefined); }} placeholder={t("Paste the complete novel text here…")} />
          </label>
          {(fileError || registerMutation.error) && <InlineError error={fileError ?? registerMutation.error!} />}
          <div className="import-actions">
            <Link to="/" className="secondary-button">{t("Cancel")}</Link>
            <button className="primary-button" type="submit" disabled={!title.trim() || !content.trim() || registerMutation.isPending}>
              {registerMutation.isPending ? t("Archiving and indexing…") : t("Register and inspect")}
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
  const { t, localeTag } = useI18n();
  const queryClient = useQueryClient();
  const preparation = useQuery({
    queryKey: preparationKey(sourceId),
    queryFn: ({ signal }) => fetchPreparation(sourceId, undefined, signal),
  });
  const [proposalStatus, setProposalStatus] = useState<ProposalStatus>("pending");
  const proposals = useInfiniteQuery({
    queryKey: proposalsKey(sourceId, proposalStatus),
    queryFn: ({ signal, pageParam }) => fetchProposals(
      sourceId,
      proposalStatus,
      undefined,
      { ...(pageParam ? { cursor: pageParam } : {}), limit: 75 },
      signal,
    ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
  });
  const proposalItems = useMemo(
    () => proposals.data?.pages.flatMap((page) => page.items) ?? [],
    [proposals.data?.pages],
  );
  const proposalTotal = proposals.data?.pages[0]?.page.total ?? preparation.data?.proposalCounts[proposalStatus] ?? 0;
  const [loadingAllProposals, setLoadingAllProposals] = useState(false);
  const stopProposalLoad = useRef(false);
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
  const effectiveProposalId = proposalItems.some((proposal) => proposal.id === selectedProposalId)
    ? selectedProposalId
    : proposalItems[0]?.id;
  const proposal = useQuery({
    queryKey: proposalKey(effectiveProposalId ?? "none", proposalStatus),
    queryFn: ({ signal }) => fetchProposal(effectiveProposalId!, proposalStatus, signal),
    enabled: Boolean(effectiveProposalId),
  });
  const [model, setModel] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [branchId, setBranchId] = useState("");
  const [readyView, setReadyView] = useState<"entities" | "history">("entities");

  useEffect(() => {
    if (!branchId && preparation.data?.branchId) setBranchId(preparation.data.branchId);
  }, [branchId, preparation.data?.branchId]);
  useEffect(() => {
    const current = operation.data;
    if (!current || !isTerminal(current.status)) return;
    stopProposalLoad.current = true;
    setLoadingAllProposals(false);
    void invalidateCompiler(queryClient, sourceId);
  }, [operation.data?.id, operation.data?.status, queryClient, sourceId]);
  useEffect(() => () => { stopProposalLoad.current = true; }, []);

  const loadAllProposals = async () => {
    stopProposalLoad.current = false;
    setLoadingAllProposals(true);
    try {
      let nextCursor = proposals.data?.pages.at(-1)?.page.nextCursor;
      while (nextCursor && !stopProposalLoad.current) {
        const result = await proposals.fetchNextPage();
        nextCursor = result.data?.pages.at(-1)?.page.nextCursor;
        await yieldToBrowser();
      }
    } finally {
      setLoadingAllProposals(false);
    }
  };

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
      stopProposalLoad.current = true;
      setLoadingAllProposals(false);
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
      stopProposalLoad.current = true;
      setLoadingAllProposals(false);
      setRejectionReason("");
      setSelectedProposalId(undefined);
      await invalidateCompiler(queryClient, sourceId);
    },
  });
  const convergeMutation = useMutation({
    mutationFn: () => convergeProposals(sourceId, { clientRequestId: requestId("converge-proposals") }, csrfToken),
    onSuccess: async () => {
      stopProposalLoad.current = true;
      setLoadingAllProposals(false);
      return invalidateCompiler(queryClient, sourceId);
    },
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

  if (preparation.isPending) return <LoadingState label={t("Inspecting compiler checkpoints…")} />;
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
          <span className="eyebrow">{t("Proposal → validate → commit")}</span>
          <h1>{snapshot.source.title}</h1>
          <p>{t("Compiler work remains isolated from runtime truth. Review every proposal before publishing an immutable prepared revision.")}</p>
        </div>
        <div className="compile-heading-actions">
          <Link to="/novels/$sourceId" params={{ sourceId }} className="secondary-button">{t("Novel overview")}</Link>
          <Link to="/traces" search={{ kind: "prepare" }} className="secondary-button">{t("Prepare traces")}</Link>
        </div>
      </header>

      <PreparationHeader snapshot={snapshot} />

      {snapshot.stage === "ready" ? <section className="compile-ready-strip">
        <div>
          <span className="eyebrow">{t("Compiled world dataset")}</span>
          <strong>{t("All {count} entities are available below.", { count: snapshot.audit?.canonical.entities ?? 0 })}</strong>
          <small>{t("Select any entity to inspect its canonical record and source evidence.")}</small>
        </div>
        <div>
          <Link className="secondary-button" to="/novels/$sourceId/ontology/$view" params={{ sourceId, view: "model" }}>{t("Explore relationships")}</Link>
          <Link className="primary-button" to="/instances/$branchId" params={{ branchId: snapshot.branchId }}>{t("Open ready instance")}</Link>
        </div>
      </section> : <section className="compile-control-strip">
        <label>
          <span>{t("Pi model override")}</span>
          <select value={model} onChange={(event) => setModel(event.target.value)} disabled={busy}>
            <option value="">{t("Workspace routing default")}</option>
            {models.filter((candidate) => candidate.available).map((candidate) => (
              <option value={`${candidate.providerId}/${candidate.id}`} key={`${candidate.providerId}/${candidate.id}`}>{candidate.name} · {candidate.providerId}</option>
            ))}
          </select>
        </label>
        <div className="compile-primary-actions">
          {snapshot.stage === "compile" && <>
            <button className="secondary-button" disabled={busy || prepareMutation.isPending} onClick={() => prepareMutation.mutate("next")}>{t("Compile next batch")}</button>
            <button className="primary-button" disabled={busy || prepareMutation.isPending} onClick={() => prepareMutation.mutate("all")}>{t("Compile all remaining")}</button>
          </>}
          {snapshot.stage === "needs-initial-world" && <button className="primary-button" disabled={busy || prepareMutation.isPending} onClick={() => prepareMutation.mutate("next")}>{t("Generate opening-world proposal")}</button>}
          {snapshot.stage === "review" && <button className="primary-button" disabled={!snapshot.proposalCounts.pending || convergeMutation.isPending} onClick={() => window.confirm(t("Accept every proposal that passes deterministic validation? Blocked proposals will remain pending for review.")) && convergeMutation.mutate()}>{t("Converge all valid")}</button>}
          {snapshot.stage === "create-branch" && <>
            <input className="branch-id-input" aria-label={t("New instance branch ID")} value={branchId} onChange={(event) => setBranchId(event.target.value)} />
            <button className="primary-button" disabled={!branchId || instanceMutation.isPending} onClick={() => instanceMutation.mutate()}>{t("Create world instance")}</button>
          </>}
        </div>
      </section>}

      {snapshot.stage === "repair" && <section className="repair-barrier"><span>{t("Repair barrier")}</span><div><strong>{t("Publication is blocked by deterministic checks")}</strong>{snapshot.repairReasons.map((reason) => <p key={reason}>{reason}</p>)}</div></section>}

      {snapshot.stage === "ready" && <nav className="compile-ready-tabs" aria-label={t("Compiled result views")}>
        <button type="button" className={readyView === "entities" ? "selected" : ""} aria-pressed={readyView === "entities"} onClick={() => setReadyView("entities")}>
          <span>{t("Compiled entities")}</span><small>{snapshot.audit?.canonical.entities ?? 0}</small>
        </button>
        <button type="button" className={readyView === "history" ? "selected" : ""} aria-pressed={readyView === "history"} onClick={() => setReadyView("history")}>
          <span>{t("Compiler history")}</span><small>{snapshot.proposalCounts.accepted + snapshot.proposalCounts.rejected}</small>
        </button>
      </nav>}

      {snapshot.stage === "ready" && readyView === "entities" ? <CompiledEntitiesWorkbench
        sourceId={sourceId}
        revisionKey={snapshot.updatedAt}
        expectedCount={snapshot.audit?.canonical.entities ?? 0}
      /> : <div className="compile-layout">
        <section className="compiler-operation-panel">
          <header>
            <div><span className="eyebrow">{t("Operation")}</span><strong>{current ? current.phase : t("No active compiler run")}</strong></div>
            {current && <span className={`operation-status operation-${current.status}`}>{t(current.status)}</span>}
          </header>
          {current ? <>
            <div className="compiler-operation-meta">
              <span><small>{t("Operation")}</small><code>{current.id}</code></span>
              <span><small>{t("Mutation boundary")}</small><strong>{current.commitBoundaryCrossed ? t("crossed") : t("not crossed")}</strong></span>
              <span><small>{t("Model output")}</small><strong>{formatCount(numberProgress(current, "modelTextCharacters"), localeTag)} {t("chars")}</strong></span>
              {current.runId && <Link to="/traces/$runId" params={{ runId: current.runId }}>{t("Inspect trace")} ↗</Link>}
            </div>
            <div className="compiler-log" aria-live="polite">
              {logs.length ? logs.map((line, index) => <p key={`${index}:${line}`}><span>{String(index + 1).padStart(2, "0")}</span>{line}</p>) : <p><span>—</span>{t("Waiting for the first compiler checkpoint…")}</p>}
            </div>
            {busy && current.cancellable && <button className="stop-button" disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>{current.commitBoundaryCrossed ? t("Stop after current mutation") : t("Cancel preparation")}</button>}
            {current.error && <div className="inline-error"><strong>{current.error.code}</strong><span>{current.error.message}</span><small>{recoveryInstruction(current.error, t)}</small></div>}
            {operationResult.success && <div className="compiler-result"><strong>{t("Checkpoint refreshed")}</strong><span>{t(operationResult.data.stage)} · {t("{count} pending proposal(s)", { count: operationResult.data.proposalCounts.pending })}</span></div>}
          </> : <div className="empty-state compact"><span>◇</span><div><strong>{t("Compiler idle")}</strong><p>{t("Choose the next batch or compile all remaining evidence.")}</p></div></div>}
          {operations.data && operations.data.length > 1 && <div className="compiler-operation-history">{operations.data.filter((item) => item.kind === "prepare").slice(0, 8).map((item) => <button key={item.id} className={item.id === effectiveOperationId ? "selected" : ""} onClick={() => setSelectedOperationId(item.id)}><span>{t(item.status)}</span><small>{formatTime(item.createdAt, localeTag)}</small></button>)}</div>}
        </section>

        <section className="proposal-workbench">
          <header>
            <div><span className="eyebrow">{t("Proposal inbox")}</span><strong>{t(`{count} ${proposalStatus}`, { count: proposalTotal })}</strong></div>
            <div className="proposal-status-tabs">{(["pending", "accepted", "rejected"] as const).map((status) => <button className={proposalStatus === status ? "selected" : ""} key={status} onClick={() => { stopProposalLoad.current = true; setLoadingAllProposals(false); setProposalStatus(status); setSelectedProposalId(undefined); }}>{t(status)}</button>)}</div>
          </header>
          <div className="proposal-split">
            <div className="proposal-list-column">
              {proposals.isPending ? <LoadingState label={t("Reading proposal inbox…")} compact /> : proposals.isError ? <InlineError error={proposals.error} /> : proposalItems.length ? <>
                <ProposalVirtualList
                  items={proposalItems}
                  selectedId={effectiveProposalId}
                  localeTag={localeTag}
                  onSelect={setSelectedProposalId}
                  onNearEnd={() => {
                    if (proposals.hasNextPage && !proposals.isFetchingNextPage && !loadingAllProposals) void proposals.fetchNextPage();
                  }}
                />
                <div className="paged-load-controls">
                  <div>
                    <strong>{t("{loaded} of {total} loaded", { loaded: proposalItems.length, total: proposalTotal })}</strong>
                    <div className="paged-load-track"><i style={{ width: `${percentage(proposalItems.length, proposalTotal)}%` }} /></div>
                  </div>
                  {proposals.hasNextPage && !loadingAllProposals && <>
                    <button type="button" onClick={() => void proposals.fetchNextPage()} disabled={proposals.isFetchingNextPage}>{proposals.isFetchingNextPage ? t("Loading next page…") : t("Load next page")}</button>
                    <button type="button" onClick={() => void loadAllProposals()} disabled={proposals.isFetchingNextPage}>{t("Load all")}</button>
                  </>}
                  {loadingAllProposals && <button type="button" onClick={() => { stopProposalLoad.current = true; }}>{t("Stop loading")}</button>}
                </div>
              </> : <div className="empty-state compact"><span>◇</span><div><strong>{t(`No ${proposalStatus} proposals`)}</strong><p>{t("The inbox is clear for this status.")}</p></div></div>}
            </div>
            <div className="proposal-inspector">
              {proposal.isPending && effectiveProposalId ? <LoadingState label={t("Reading full proposal envelope…")} compact /> : proposal.isError ? <InlineError error={proposal.error} /> : proposal.data ? <>
                <div className="proposal-inspector-heading">
                  <span><small>{proposal.data.summary.kind}</small><strong>{proposal.data.summary.id}</strong></span>
                  <span className={`operation-status operation-${proposal.data.summary.status === "accepted" ? "succeeded" : proposal.data.summary.status === "rejected" ? "failed" : "queued"}`}>{proposal.data.summary.status}</span>
                </div>
                <DeferredJsonDetails className="proposal-json" summary={t("Complete typed envelope")} value={proposal.data.envelope} />
                {proposal.data.rejection && <div className="proposal-validation-errors">{proposal.data.rejection.errors.map((issue) => <p key={`${issue.code}:${issue.path ?? ""}`}><strong>{issue.code}</strong>{issue.message}{issue.path && <code>{issue.path}</code>}</p>)}</div>}
                {proposalStatus === "pending" && <div className="proposal-decision">
                  <button className="primary-button" disabled={acceptMutation.isPending || rejectMutation.isPending} onClick={() => acceptMutation.mutate()}>{t("Validate and accept")}</button>
                  <label><span>{t("Rejection reason")}</span><textarea rows={2} value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} placeholder={t("Record why this proposal should not enter canonical history…")} /></label>
                  <button className="danger-button" disabled={!rejectionReason.trim() || acceptMutation.isPending || rejectMutation.isPending} onClick={() => rejectMutation.mutate()}>{t("Reject with diagnostic")}</button>
                </div>}
              </> : <div className="empty-state compact"><span>◇</span><div><strong>{t("Select a proposal")}</strong><p>{t("Inspect its full payload, evidence references, generation metadata, and rejection diagnostics.")}</p></div></div>}
            </div>
          </div>
        </section>
      </div>}

      {convergeMutation.data && <section className="convergence-result">
        <strong>{t("Convergence complete")}</strong>
        <span>{t("{accepted} accepted · {blocked} blocked · {staging} staging", convergeMutation.data.counts)}</span>
        {convergeMutation.data.blockedPreview.slice(0, 8).map((item) => <p key={item.id}><code>{item.id}</code>{item.errors[0]?.message ?? t("Blocked by deterministic validation.")}</p>)}
        {convergeMutation.data.truncated && <small>{t("Result details are bounded; use the paged accepted and rejected inboxes for the complete set.")}</small>}
      </section>}
      {decisionError && <div className="floating-error"><InlineError error={decisionError} /></div>}
    </>
  );
}

function CompiledEntitiesWorkbench({
  sourceId,
  revisionKey,
  expectedCount,
}: {
  sourceId: string;
  revisionKey: string;
  expectedCount: number;
}) {
  const { t, localeTag } = useI18n();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [selectedEntityId, setSelectedEntityId] = useState<string>();
  const listParent = useRef<HTMLDivElement>(null);
  const entities = useInfiniteQuery({
    queryKey: ["compiled-entities", sourceId, revisionKey],
    queryFn: ({ signal, pageParam }) => fetchOntology(sourceId, "model", {
      layers: ["canonical"],
      kind: "entity:*",
      limit: 500,
      ...(pageParam ? { cursor: pageParam } : {}),
    }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
  });
  const allEntities = useMemo(() => {
    const byId = new Map<string, OntologyNode>();
    for (const page of entities.data?.pages ?? []) {
      for (const node of page.nodes) byId.set(node.id, node);
    }
    return [...byId.values()].sort((left, right) => left.label.localeCompare(right.label, localeTag));
  }, [entities.data?.pages, localeTag]);
  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of allEntities) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    return [...counts.entries()].sort(([left], [right]) => entityKindLabel(left, t).localeCompare(entityKindLabel(right, t), localeTag));
  }, [allEntities, localeTag, t]);
  const filteredEntities = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return allEntities.filter((node) => {
      if (kind && node.kind !== kind) return false;
      if (!needle) return true;
      return `${node.label} ${node.artifactId} ${node.kind} ${entityAliases(node).join(" ")}`.toLocaleLowerCase().includes(needle);
    });
  }, [allEntities, kind, search]);
  const selectedEntity = allEntities.find((node) => node.id === selectedEntityId);
  const detail = useQuery({
    queryKey: ["compiled-entity-detail", sourceId, selectedEntityId, revisionKey],
    queryFn: ({ signal }) => fetchOntologyNode(sourceId, "model", selectedEntityId!, {
      layers: ["canonical"],
      relationLimit: 500,
    }, signal),
    enabled: Boolean(selectedEntityId),
  });
  const virtual = useVirtualizer({
    count: filteredEntities.length,
    getScrollElement: () => listParent.current,
    estimateSize: () => 64,
    overscan: 12,
  });
  const total = entities.data?.pages[0]?.totalNodes ?? expectedCount;
  const loadingCompleteSet = Boolean(entities.hasNextPage || entities.isFetchingNextPage);

  useEffect(() => {
    if (!entities.hasNextPage || entities.isFetchingNextPage || entities.isFetchNextPageError) return;
    void entities.fetchNextPage();
  }, [entities.fetchNextPage, entities.hasNextPage, entities.isFetchingNextPage, entities.isFetchNextPageError]);

  useEffect(() => {
    if (!selectedEntityId && allEntities[0]) setSelectedEntityId(allEntities[0].id);
  }, [allEntities, selectedEntityId]);

  return <section className="compiled-entities-workbench">
    <header>
      <div>
        <span className="eyebrow">{t("Canonical entity registry")}</span>
        <strong>{t("Compiled entities")}</strong>
        <small>{loadingCompleteSet
          ? t("Loading every entity · {loaded}/{total}", { loaded: allEntities.length, total })
          : t("All {count} entities loaded", { count: allEntities.length })}</small>
      </div>
      <div className="compiled-entity-filters">
        <label><span>{t("Find an entity")}</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("Name, alias, ID…")} /></label>
        <label><span>{t("Entity type")}</span><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">{t("All entity types")}</option>{kinds.map(([value, count]) => <option key={value} value={value}>{entityKindLabel(value, t)} · {count}</option>)}</select></label>
      </div>
    </header>
    {entities.isPending ? <LoadingState label={t("Reading every compiled entity…")} compact /> : entities.isError ? <div className="compiled-entity-error"><InlineError error={entities.error} /><button type="button" onClick={() => void entities.refetch()}>{t("Retry once")}</button></div> : <div className="compiled-entities-body">
      <div className="compiled-entity-list" role="table" aria-label={t("Compiled entities")}>
        <div className="compiled-entity-list-head" role="row"><span>{t("Entity")}</span><span>{t("Type")}</span><span>{t("Evidence")}</span></div>
        <div ref={listParent} className="compiled-entity-list-scroll" role="rowgroup">
          {filteredEntities.length ? <div className="compiled-entity-virtual-space" style={{ height: virtual.getTotalSize() }}>
            {virtual.getVirtualItems().map((row) => {
              const node = filteredEntities[row.index]!;
              const aliases = entityAliases(node);
              return <button
                ref={virtual.measureElement}
                data-index={row.index}
                type="button"
                role="row"
                aria-selected={node.id === selectedEntityId}
                key={node.id}
                className={node.id === selectedEntityId ? "selected" : ""}
                style={{ transform: `translateY(${row.start}px)` }}
                onClick={() => setSelectedEntityId(node.id)}
              >
                <span className="compiled-entity-name"><i style={{ background: nodeColor(node), borderColor: statusColors[node.status] }} /><span><strong>{node.label}</strong><small>{aliases.length ? aliases.join(" · ") : node.artifactId}</small></span></span>
                <span className="compiled-entity-kind">{entityKindLabel(node.kind, t)}</span>
                <span className="compiled-entity-evidence-count">{node.evidenceCount}</span>
              </button>;
            })}
          </div> : <div className="compiled-entity-empty"><span>◇</span><strong>{t("No entities match")}</strong><p>{t("Clear the name or type filter to restore the complete entity registry.")}</p></div>}
        </div>
        <footer><span>{t("Showing {shown} of {total} entities", { shown: filteredEntities.length, total: allEntities.length })}</span></footer>
      </div>
      <CompiledEntityInspector
        sourceId={sourceId}
        node={selectedEntity}
        detail={detail}
      />
    </div>}
  </section>;
}

function CompiledEntityInspector({
  sourceId,
  node,
  detail,
}: {
  sourceId: string;
  node?: OntologyNode;
  detail: ReturnType<typeof useQuery<Awaited<ReturnType<typeof fetchOntologyNode>>, Error>>;
}) {
  const { t } = useI18n();
  if (!node) return <aside className="compiled-entity-inspector compiled-entity-inspector-empty"><span>◇</span><strong>{t("Select an entity")}</strong><p>{t("Choose a row to inspect the complete canonical record and its source evidence.")}</p></aside>;
  const aliases = entityAliases(node);
  return <aside className="compiled-entity-inspector">
    <header>
      <span style={{ background: nodeColor(node), borderColor: statusColors[node.status] }} />
      <div><small>{entityKindLabel(node.kind, t)}</small><h2>{node.label}</h2><code>{node.artifactId}</code></div>
      <Link to="/novels/$sourceId/ontology/$view" params={{ sourceId, view: "model" }}>{t("View relationships")} ↗</Link>
    </header>
    <div className="compiled-entity-detail-scroll">
      <div className="compiled-entity-stats">
        <span><small>{t("Aliases")}</small><strong>{aliases.length}</strong></span>
        <span><small>{t("Evidence")}</small><strong>{node.evidenceCount}</strong></span>
        <span><small>{t("State")}</small><strong style={{ color: statusColors[node.status] }}>{t(node.status)}</strong></span>
      </div>
      <section className="compiled-entity-core">
        <h3>{t("Canonical identity")}</h3>
        <dl>
          <div><dt>{t("Canonical name")}</dt><dd>{node.label}</dd></div>
          <div><dt>{t("Entity type")}</dt><dd>{entityKindLabel(node.kind, t)}</dd></div>
          <div><dt>{t("Aliases")}</dt><dd>{aliases.length ? aliases.join(" · ") : t("None")}</dd></div>
          <div><dt>{t("Revision")}</dt><dd><code>{node.revisionHash ?? t("derived")}</code></dd></div>
        </dl>
      </section>
      {detail.isPending ? <LoadingState label={t("Reading complete entity record…")} compact /> : detail.isError ? <InlineError error={detail.error} /> : detail.data ? <>
        <section className="compiled-entity-relations">
          <h3>{t("Relationship coverage")}</h3>
          <div><span>{t("Incoming")}</span><strong>{detail.data.relationPage.incomingTotal}</strong><span>{t("Outgoing")}</span><strong>{detail.data.relationPage.outgoingTotal}</strong></div>
        </section>
        <section className="compiled-entity-evidence">
          <h3>{t("Source evidence · {count}", { count: detail.data.evidence.length })}</h3>
          {detail.data.evidence.length ? detail.data.evidence.map((evidence, index) => <article key={`${evidence.quoteHash}:${index}`}>
            <header><span>{t("lines {start}–{end}", { start: evidence.startLine, end: evidence.endLine })}</span><small>{t(evidence.strength)}</small></header>
            <blockquote>{evidence.excerpt ?? t("Exact byte excerpt is unavailable for this legacy reference.")}{evidence.excerptTruncated ? "…" : ""}</blockquote>
          </article>) : <p>{t("No source-local evidence span is attached.")}</p>}
        </section>
        <DeferredJsonDetails className="compiled-entity-json" summary={t("Complete entity record")} value={detail.data.payload} />
      </> : null}
    </div>
  </aside>;
}

function entityAliases(node: OntologyNode): string[] {
  const aliases = node.summary.aliases;
  return Array.isArray(aliases) ? aliases.filter((value): value is string => typeof value === "string") : [];
}

function entityKindLabel(kind: string, t: ReturnType<typeof useI18n>["t"]): string {
  const label = ({
    "entity:character": "Character",
    "entity:location": "Location",
    "entity:artifact": "Artifact",
    "entity:concept": "Concept",
    "entity:faction": "Faction",
    "entity:institution": "Institution",
    "entity:relationship": "Relationship",
    "entity:other": "Other",
  } as Record<string, string>)[kind] ?? kind.replace(/^entity:/, "").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return t(label);
}

function ProposalVirtualList({
  items,
  selectedId,
  localeTag,
  onSelect,
  onNearEnd,
}: {
  items: ProposalSummary[];
  selectedId?: string;
  localeTag?: string;
  onSelect: (id: string) => void;
  onNearEnd: () => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 72,
    overscan: 8,
  });
  return (
    <div
      ref={parent}
      className="proposal-list"
      onScroll={(event) => {
        const element = event.currentTarget;
        if (element.scrollHeight - element.scrollTop - element.clientHeight < 220) onNearEnd();
      }}
    >
      <div className="proposal-virtual-space" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map((row) => {
          const item = items[row.index]!;
          return (
            <button
              ref={virtual.measureElement}
              data-index={row.index}
              type="button"
              key={item.id}
              className={item.id === selectedId ? "selected" : ""}
              style={{ transform: `translateY(${row.start}px)` }}
              onClick={() => onSelect(item.id)}
            >
              <span className={`proposal-kind proposal-kind-${item.kind}`}>{item.kind}</span>
              <strong>{item.id}</strong>
              <small>{item.worker} · {formatTime(item.createdAt, localeTag)}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DeferredJsonDetails({ className, summary, value }: { className: string; summary: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  const formatted = useMemo(() => open ? safeJson(value) : "", [open, value]);
  return <details className={className} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{summary}</summary>{open && <pre>{formatted}</pre>}</details>;
}

function PreparationHeader({ snapshot }: { snapshot: PreparationSnapshot }) {
  const { t } = useI18n();
  const audit = snapshot.audit;
  return (
    <section className="preparation-header">
      <div className="preparation-stage-card">
        <span className={`stage-glyph stage-${snapshot.stage}`}>{stageNumber(snapshot.stage)}</span>
        <div><small>{t("Current barrier")}</small><strong>{stageLabel(snapshot.stage, t)}</strong><p>{nextActionCopy(snapshot, t)}</p></div>
      </div>
      <div className="preparation-progress-card">
        <span><small>{t("Evidence batches")}</small><strong>{snapshot.progress.completedBatches}/{snapshot.progress.totalBatches}</strong></span>
        <div className="progress-track"><i style={{ width: `${Math.round(snapshot.progress.ratio * 100)}%` }} /></div>
        <small>{t("{percent}% checkpointed", { percent: Math.round(snapshot.progress.ratio * 100) })}</small>
      </div>
      <div className="preparation-metrics">
        <span><small>{t("Pending")}</small><strong>{snapshot.proposalCounts.pending}</strong></span>
        <span><small>{t("Entities")}</small><strong>{audit?.canonical.entities ?? "—"}</strong></span>
        <span><small>{t("Events")}</small><strong>{audit?.canonical.events ?? "—"}</strong></span>
        <span><small>{t("Rules")}</small><strong>{audit?.canonical.rules ?? "—"}</strong></span>
        <span><small>{t("Publication")}</small><strong>{t(audit?.readiness.publication ?? "unknown")}</strong></span>
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

function stageLabel(stage: PreparationSnapshot["stage"], t: ReturnType<typeof useI18n>["t"]): string {
  return t(({
    "needs-source": "Source required",
    "choose-source": "Choose source",
    compile: "Compile evidence",
    review: "Review proposals",
    repair: "Repair required",
    "needs-initial-world": "Opening world required",
    "create-branch": "Ready to publish",
    ready: "Playable world ready",
  })[stage]);
}

function nextActionCopy(snapshot: PreparationSnapshot, t: ReturnType<typeof useI18n>["t"]): string {
  if (snapshot.stage === "compile") return t("{count} evidence batch(es) remain.", { count: snapshot.progress.remainingBatches });
  if (snapshot.stage === "review") return t("Inspect proposal payloads and commit only validated artifacts.");
  if (snapshot.stage === "needs-initial-world") return t("Generate one evidence-backed playable checkpoint.");
  if (snapshot.stage === "create-branch") return t("Publish a revision and create branch '{branch}'.", { branch: snapshot.branchId });
  if (snapshot.stage === "ready") return t("Branch '{branch}' is pinned to committed history.", { branch: snapshot.branchId });
  if (snapshot.stage === "repair") return t("Resolve the listed deterministic blockers before publication.");
  return t("Next action: {action}.", { action: snapshot.nextAction });
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
function formatCount(value: number, locale?: string): string { return new Intl.NumberFormat(locale, { notation: value > 9_999 ? "compact" : "standard" }).format(value); }
function formatTime(value: string, locale?: string): string { return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
function safeJson(value: unknown): string { return JSON.stringify(value, null, 2); }
function percentage(loaded: number, total: number): number { return total === 0 ? 100 : Math.min(100, Math.round(loaded / total * 100)); }
function yieldToBrowser(): Promise<void> { return new Promise((resolve) => requestAnimationFrame(() => resolve())); }
function firstError(...errors: Array<Error | null | undefined>): Error | undefined { return errors.find((error): error is Error => error instanceof Error); }

function LoadingState({ label, compact = false }: { label: string; compact?: boolean }) {
  const { t } = useI18n();
  return <div className={compact ? "inline-loading compiler-inline-loading" : "center-state"}><span className="loading-orbit" />{compact ? label : <><h1>{label}</h1><p>{t("Reading local, authoritative workspace state…")}</p></>}</div>;
}

function PageError({ error, retry }: { error: Error; retry: () => void }) {
  const { t } = useI18n();
  const detail = webErrorDetail(error);
  return <div className="center-state center-error"><span className="eyebrow">{detail?.code ?? t("Request failed")}</span><h1>{t("Compiler state could not be read")}</h1><p>{error.message}</p>{detail && <small>{recoveryInstruction(detail, t)}</small>}{canRetrySameRequest(error) && <button onClick={retry}>{t("Retry once")}</button>}</div>;
}

function InlineError({ error }: { error: Error | string }) {
  const { t } = useI18n();
  const message = typeof error === "string" ? error : error.message;
  const detail = typeof error === "string" ? undefined : webErrorDetail(error);
  return <div className="inline-error"><strong>{detail?.code ?? t("Request failed")}</strong><span>{message}</span>{detail && <small>{recoveryInstruction(detail, t)}</small>}</div>;
}

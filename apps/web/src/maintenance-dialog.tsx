import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  executeAnalysisReset,
  executeInstanceRemoval,
  executeNovelRemoval,
  fetchInstanceRemovalPreview,
  fetchNovelRemovalPreview,
} from "./api";
import { recoveryInstruction, webErrorDetail } from "./recovery";
import { useI18n } from "./i18n";
import type { MaintenanceAction, RemovalExecutionResult } from "../../../src/web/contracts";

export function MaintenanceControl({
  action,
  targetId,
  csrfToken,
  triggerLabel,
  onCompleted,
}: {
  action: MaintenanceAction;
  targetId: string;
  csrfToken: string;
  triggerLabel: string;
  onCompleted: (result: RemovalExecutionResult) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const preview = useQuery({
    queryKey: ["removal-preview", action, targetId],
    queryFn: ({ signal }) => action === "remove-instance"
      ? fetchInstanceRemovalPreview(targetId, signal)
      : fetchNovelRemovalPreview(targetId, action === "reset-analysis" ? "analysis" : "novel", signal),
    enabled: open,
    staleTime: 0,
  });
  const execute = useMutation({
    mutationFn: () => {
      const input = {
        effectHash: preview.data!.effectHash,
        confirmation,
        clientRequestId: `maintenance-${crypto.randomUUID()}`,
      };
      if (action === "remove-instance") return executeInstanceRemoval(targetId, input, csrfToken);
      if (action === "reset-analysis") return executeAnalysisReset(targetId, input, csrfToken);
      return executeNovelRemoval(targetId, input, csrfToken);
    },
    onSuccess: onCompleted,
  });
  const close = () => {
    if (execute.isPending) return;
    setOpen(false);
    setConfirmation("");
    execute.reset();
  };
  const executionError = execute.error ? webErrorDetail(execute.error) : undefined;

  return (
    <>
      <button className="danger-button" type="button" onClick={() => setOpen(true)}>{triggerLabel}</button>
      {open && <div className="maintenance-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
        <section className="maintenance-dialog" role="dialog" aria-modal="true" aria-labelledby={`maintenance-title-${action}`}>
          <header>
            <div><span className="eyebrow">{t("Exact effect manifest")}</span><h2 id={`maintenance-title-${action}`}>{actionLabel(action, t)}</h2></div>
            <button type="button" aria-label={t("Close effect manifest")} disabled={execute.isPending} onClick={close}>×</button>
          </header>
          {preview.isPending ? <DialogLoading /> : preview.isError ? <DialogError error={preview.error} retry={() => void preview.refetch()} /> : preview.data ? <>
            <div className="maintenance-target">
              <span><small>{t("Target")}</small><strong>{preview.data.target.label}</strong><code>{preview.data.target.id}</code></span>
              <span className={preview.data.executable ? "operation-status operation-succeeded" : "operation-status operation-failed"}>{preview.data.executable ? t("ready") : t("blocked")}</span>
            </div>
            {preview.data.blockers.length > 0 && <div className="maintenance-blockers"><strong>{t("Execution blockers")}</strong>{preview.data.blockers.map((blocker) => <p key={blocker}>{blocker}</p>)}</div>}
            <div className="maintenance-effects">
              {preview.data.effects.map((item) => <article key={item.id} className={`maintenance-effect maintenance-effect-${item.disposition}`}>
                <span className="maintenance-effect-mark">{item.disposition === "remove" ? "−" : item.disposition === "modify" ? "±" : "="}</span>
                <div><header><strong>{item.label}</strong><span>{t(item.disposition)} · {item.count}</span></header><p>{item.detail}</p>{item.itemIds.length > 0 && <details><summary>{t(item.itemIds.length === 1 ? "{count} exact identifier" : "{count} exact identifiers", { count: item.itemIds.length })}</summary><code>{item.itemIds.join("\n")}</code></details>}</div>
              </article>)}
            </div>
            <footer className="maintenance-confirmation">
              <div className="maintenance-hash"><small>{t("Effect hash")}</small><code>{preview.data.effectHash}</code></div>
              <label className="field-label"><span>{t("Type {confirmation} to confirm", { confirmation: preview.data.target.confirmation })}</span><input autoFocus value={confirmation} onChange={(event) => { setConfirmation(event.target.value); if (executionError?.retry.kind === "after-user-action") execute.reset(); }} /></label>
              {execute.error && <MaintenanceError error={execute.error} onRefresh={executionError?.retry.kind === "after-refresh" ? () => { setConfirmation(""); execute.reset(); void preview.refetch(); } : undefined} />}
              <div><button type="button" className="secondary-button" disabled={execute.isPending} onClick={close}>{t("Cancel")}</button><button type="button" className="danger-button" disabled={!preview.data.executable || confirmation !== preview.data.target.confirmation || execute.isPending || Boolean(execute.error)} onClick={() => execute.mutate()}>{execute.isPending ? t("Applying exact effect…") : actionButton(action, t)}</button></div>
            </footer>
          </> : null}
        </section>
      </div>}
    </>
  );
}

function actionLabel(action: MaintenanceAction, t: ReturnType<typeof useI18n>["t"]): string {
  if (action === "remove-instance") return t("Remove world instance");
  if (action === "reset-analysis") return t("Reset derived analysis");
  return t("Remove novel from workspace");
}

function actionButton(action: MaintenanceAction, t: ReturnType<typeof useI18n>["t"]): string {
  if (action === "remove-instance") return t("Remove exact instance");
  if (action === "reset-analysis") return t("Reset exact analysis");
  return t("Remove exact novel");
}

function DialogLoading() {
  const { t } = useI18n();
  return <div className="maintenance-dialog-state"><span className="loading-orbit" /><p>{t("Computing exact affected identities and blockers…")}</p></div>;
}

function DialogError({ error, retry }: { error: Error; retry: () => void }) {
  const { t } = useI18n();
  const detail = webErrorDetail(error);
  return <div className="maintenance-dialog-state maintenance-dialog-error"><strong>{detail?.code ?? error.name}</strong><p>{error.message}</p>{detail && <small>{recoveryInstruction(detail, t)}</small>}<button className="secondary-button" onClick={retry}>{t("Refresh preview")}</button></div>;
}

function MaintenanceError({ error, onRefresh }: { error: Error; onRefresh?: () => void }) {
  const { t } = useI18n();
  const detail = webErrorDetail(error);
  return <div className="inline-error"><strong>{detail?.code ?? error.name}</strong><span>{error.message}</span>{detail && <small>{recoveryInstruction(detail, t)}</small>}{onRefresh && <button type="button" className="secondary-button" onClick={onRefresh}>{t("Refresh effect manifest")}</button>}</div>;
}

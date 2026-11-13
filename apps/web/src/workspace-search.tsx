import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { BootstrapResponse } from "../../../src/web/contracts";
import { useI18n } from "./i18n";
import { Icon, type IconName } from "./workspace-ui";

export function WorkspaceSearch({ data }: { data?: BootstrapResponse }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listId = useId();
  const titleId = useId();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        // Leave an existing task dialog's focus and keyboard ownership intact.
        if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]') && !dialog.current?.open) return;
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      dialog.current?.showModal();
      input.current?.focus();
    } else if (dialog.current?.open) {
      dialog.current.close();
    }
  }, [open]);

  type Result = { id: string; title: string; detail: string; icon: IconName; go: () => void };
  const candidates: Result[] = [
    { id: "overview", title: t("Overview"), detail: t("Workspace"), icon: "grid", go: () => void navigate({ to: "/" }) },
    { id: "import", title: t("Register novel"), detail: t("Import source text"), icon: "upload", go: () => void navigate({ to: "/novels/new" }) },
    ...(data?.catalog.novels ?? []).map((novel): Result => ({ id: `novel-${novel.id}`, title: novel.title, detail: t("Novel overview"), icon: "book", go: () => void navigate({ to: "/novels/$sourceId", params: { sourceId: novel.id } }) })),
    ...(data?.catalog.playSessions ?? []).filter((session) => session.status !== "archived" && session.status !== "detached").map((session): Result => ({ id: `session-${session.id}`, title: session.actorName ?? session.actorId, detail: `${t("Play sessions")} · ${session.title}`, icon: "play", go: () => void navigate({ to: "/play/$sessionId", params: { sessionId: session.id } }) })),
    ...(data?.catalog.instances ?? []).map((instance): Result => ({ id: `world-${instance.branchId}`, title: instance.name, detail: `${t("Instances")} · ${instance.sourceTitle ?? instance.branchId}`, icon: "branch", go: () => void navigate({ to: "/instances/$branchId", params: { branchId: instance.branchId } }) })),
    { id: "traces", title: t("Trace ledger"), detail: t("Inspect operations"), icon: "activity", go: () => void navigate({ to: "/traces" }) },
    { id: "models", title: t("Model catalog"), detail: t("Models & credentials"), icon: "sliders", go: () => void navigate({ to: "/settings/models" }) },
  ];
  const results = candidates.filter((result) => `${result.title} ${result.detail}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const visibleResults = results.slice(0, 40);
  const selectedIndex = Math.min(selected, Math.max(0, visibleResults.length - 1));

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${selectedIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, listId, open, query]);

  const choose = (result: Result) => { setOpen(false); result.go(); };
  return <>
    <button ref={trigger} type="button" className="workspace-search-trigger" onClick={() => setOpen(true)} aria-label={t("Search workspace")} aria-haspopup="dialog">
      <Icon name="search" size={16} /><span>{t("Search workspace…")}</span><kbd>⌘ / Ctrl K</kbd>
    </button>
    <dialog ref={dialog} className="workspace-search-dialog" aria-labelledby={titleId} onCancel={() => setOpen(false)} onClose={() => { setOpen(false); trigger.current?.focus(); }} onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="workspace-search-content">
        <h2 id={titleId} className="sr-only">{t("Search workspace")}</h2>
        <div className="workspace-search-input">
          <Icon name="search" size={21} />
          <input ref={input} role="combobox" aria-expanded={open} aria-controls={listId} aria-activedescendant={visibleResults.length ? `${listId}-${selectedIndex}` : undefined} aria-autocomplete="list" aria-label={t("Search novels, worlds, and sessions")} placeholder={t("Search novels, worlds, and sessions")} value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const length = visibleResults.length;
              if (length) setSelected((selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + length) % length);
            }
            if (event.key === "Enter" && visibleResults[selectedIndex]) { event.preventDefault(); choose(visibleResults[selectedIndex]); }
          }} />
          <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label={t("Close search")}><Icon name="close" /></button>
        </div>
        <div className="workspace-search-results" id={listId} role="listbox" aria-label={t("Search results")}>
          {visibleResults.map((result, index) => <button key={result.id} id={`${listId}-${index}`} type="button" role="option" aria-selected={index === selectedIndex} tabIndex={-1} onClick={() => choose(result)} onMouseMove={() => setSelected(index)}>
            <span className="search-result-icon"><Icon name={result.icon} /></span><span><strong>{result.title}</strong><small>{result.detail}</small></span><Icon name="arrow" size={16} />
          </button>)}
        </div>
        {!results.length && <div className="search-empty" role="status"><strong>{t("No matches found")}</strong><p>{t("Try a novel title, character, or world name.")}</p></div>}
        <footer><span>{t("↑ ↓ to navigate · Enter to open · Esc to close")}</span><span>{t("{count} results", { count: results.length })}</span></footer>
      </div>
    </dialog>
  </>;
}

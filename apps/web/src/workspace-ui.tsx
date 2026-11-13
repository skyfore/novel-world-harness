import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useI18n } from "./i18n";

export type IconName = "book" | "grid" | "search" | "plus" | "arrow" | "branch" | "play" | "sliders" | "activity" | "upload" | "check" | "close" | "chevron" | "layers";

const paths: Record<IconName, ReactNode> = {
  book: <><path d="M12 5.5C8.5 3.5 5 4 3 5v14c3-1.5 6-1 9 1 3-2 6-2.5 9-1V5c-2-1-5.5-1.5-9 .5Z" /><path d="M12 5.5V20" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  branch: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M6 7v10m12-10v2a4 4 0 0 1-4 4h-4a4 4 0 0 0-4 4" /></>,
  play: <path d="m8 4 12 8-12 8V4Z" />,
  sliders: <><path d="M4 7h4m6 0h6M4 17h10m6 0h0" /><circle cx="11" cy="7" r="3" /><circle cx="17" cy="17" r="3" /></>,
  activity: <path d="M2 12h5l3-8 4 16 3-8h5" />,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  layers: <><path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5" /></>,
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

/** Navigation reflects the current surface, never compilation or certification status. */
export function NovelWorkspaceNav() {
  const { t } = useI18n();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const match = pathname.match(/^\/novels\/([^/]+)(?:\/(compile|ontology))?/);
  if (!match?.[1] || match[1] === "new") return null;
  let sourceId: string;
  try { sourceId = decodeURIComponent(match[1]); } catch { return null; }
  return <nav className="novel-workspace-nav" aria-label={t("Novel workspace")}>
    <Link to="/" className="workspace-back"><Icon name="chevron" size={14} />{t("All novels")}</Link>
    <div>
      <Link to="/novels/$sourceId" params={{ sourceId }} activeOptions={{ exact: true }}><Icon name="book" size={15} />{t("Novel overview")}</Link>
      <Link to="/novels/$sourceId/compile" params={{ sourceId }}><Icon name="layers" size={15} />{t("Compile & review")}</Link>
      <Link to="/novels/$sourceId/ontology/$view" params={{ sourceId, view: "model" }} search={(previous) => match[2] === "ontology" ? previous : {}} className={match[2] === "ontology" ? "active" : undefined}><Icon name="branch" size={15} />{t("World explorer")}</Link>
    </div>
  </nav>;
}

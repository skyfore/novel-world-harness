import path from "node:path";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { buildAdmissionManifest } from "../compiler/cut-admission.js";
import { measureWorldCompleteness, type WorldCompletenessReport } from "../compiler/world-completeness.js";
import { loadNovelCutsBundle } from "./novel-cuts.js";

export type NovelCompletenessOptions = {
  root: string;
  sourceId?: string;
  revision?: string;
  /** Compute per-cut admission (with probes) when the bundle carries none, to measure agency. */
  admission?: boolean;
  /** Print the measure table instead of the full JSON report. */
  brief?: boolean;
};

export type NovelCompletenessReport = WorldCompletenessReport & {
  bundle: { origin: "candidate" | "revision"; bundleHash?: string; baselineIssues: number };
};

/** Read-only: load the candidate (or an exact revision) and measure it against the end-state content contract. */
export async function inspectNovelCompleteness(options: NovelCompletenessOptions): Promise<NovelCompletenessReport> {
  const root = path.resolve(options.root);
  const loaded = await loadNovelCutsBundle({ root, ...(options.sourceId ? { sourceId: options.sourceId } : {}), ...(options.revision ? { revision: options.revision } : {}) });
  const source = await readSourceMaterial(root, loaded.source);
  const admission = !loaded.bundle.admission && options.admission
    ? await buildAdmissionManifest(loaded.bundle, { inputIssues: loaded.baselineIssues, probe: true })
    : null;
  return {
    ...measureWorldCompleteness(loaded.bundle, source, { admission }),
    bundle: { origin: loaded.origin, ...(loaded.bundleHash ? { bundleHash: loaded.bundleHash } : {}), baselineIssues: loaded.baselineIssues.length },
  };
}

export function formatCompletenessTable(report: WorldCompletenessReport): string {
  const percent = (ratio: number | null) => ratio === null ? "" : `${(ratio * 100).toFixed(1)}%`;
  const rows = report.measures.map((item) => [item.status, item.layer, item.id, `${item.numerator}/${item.total}`, percent(item.ratio),
    item.target === undefined ? "" : `target ${item.ratio === null ? `≤${item.target}` : percent(item.target)}`, item.denominator]);
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  const lines = rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd());
  const { satisfied, gap, unknown } = report.summary;
  return [`${report.sourceId}  ${report.version}  ${report.policy}  satisfied ${satisfied}  gap ${gap}  unknown ${unknown}`, ...lines].join("\n");
}

export async function novelCompletenessCommand(options: NovelCompletenessOptions): Promise<void> {
  const report = await inspectNovelCompleteness(options);
  console.log(options.brief ? formatCompletenessTable(report) : JSON.stringify(report, null, 2));
}

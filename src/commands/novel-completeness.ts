import path from "node:path";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { buildAdmissionManifest } from "../compiler/cut-admission.js";
import { measureWorldCompleteness, type ByteRange, type WorldCompletenessReport } from "../compiler/world-completeness.js";
import { summarizeCompileUsage } from "../compiler/compile-usage.js";
import { loadNovelCutsBundle } from "./novel-cuts.js";

export type NovelCompletenessOptions = {
  root: string;
  sourceId?: string;
  revision?: string;
  /** Compute per-cut admission (with probes) when the bundle carries none, to measure agency. */
  admission?: boolean;
  /** Print the measure table instead of the full JSON report. */
  brief?: boolean;
  /** Limit every measure to one byte range (`start-end`), as a stage gate or slice acceptance does. */
  range?: string;
  /** Skip the trace-derived usage summary. */
  usage?: boolean;
};

export function parseByteRange(value: string): ByteRange {
  const match = /^(\d+)-(\d+)$/u.exec(value.trim());
  if (!match || Number(match[2]) <= Number(match[1])) throw new Error(`Invalid byte range '${value}': use <start>-<end> with end > start.`);
  return { startByte: Number(match[1]), endByte: Number(match[2]) };
}

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
  const usage = options.usage === false ? null : await summarizeCompileUsage(root, loaded.source.id);
  return {
    ...measureWorldCompleteness(loaded.bundle, source, { admission, usage, ...(options.range ? { scope: parseByteRange(options.range) } : {}) }),
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
  const scope = report.scope ? `  bytes ${report.scope.startByte}-${report.scope.endByte}` : "";
  return [`${report.sourceId}  ${report.version}  ${report.policy}${scope}  satisfied ${satisfied}  gap ${gap}  unknown ${unknown}  roster ${report.roster.reviewed ? "reviewed" : "provisional"} (${report.roster.actorIds.length})`, ...lines].join("\n");
}

export async function novelCompletenessCommand(options: NovelCompletenessOptions): Promise<void> {
  const report = await inspectNovelCompleteness(options);
  console.log(options.brief ? formatCompletenessTable(report) : JSON.stringify(report, null, 2));
}

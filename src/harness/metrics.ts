import type { Db } from "../db/client.js";
import type { BuildMetrics } from "./types.js";

const METRICS: Array<keyof BuildMetrics> = [
  "source",
  "evidence",
  "entityResolution",
  "majorEvents",
  "temporalConsistency",
  "stateDelta",
  "epistemic",
  "causality",
];

export async function readMetrics(db: Db, projectId: string): Promise<BuildMetrics> {
  const result = await db.query(
    `SELECT metric, value FROM harness_metrics WHERE project_id = $1`,
    [projectId],
  );
  const values = Object.fromEntries(result.rows.map((row) => [row.metric, Number(row.value)]));
  return Object.fromEntries(METRICS.map((key) => [key, values[key] ?? 0])) as BuildMetrics;
}

export async function writeMetric(
  db: Db,
  projectId: string,
  metric: keyof BuildMetrics,
  value: number,
  details: unknown = {},
): Promise<void> {
  await db.query(
    `INSERT INTO harness_metrics(project_id, metric, value, details, measured_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (project_id, metric)
     DO UPDATE SET value = EXCLUDED.value, details = EXCLUDED.details, measured_at = now()`,
    [projectId, metric, value, JSON.stringify(details)],
  );
}

import { loadConfig } from "../config/load.js";
import { withDb } from "../db/client.js";
import { slugify } from "../db/projects.js";
import { readMetrics } from "../harness/metrics.js";
import { readinessGaps } from "../harness/readiness.js";

export async function statusCommand(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  await withDb(config, async (db) => {
    const project = await db.query(`SELECT * FROM projects WHERE slug = $1`, [slugify(config.project.name)]);
    if (!project.rowCount) {
      console.log("Project not initialized in the database. Run ingest first.");
      return;
    }
    const projectId = project.rows[0].id;
    const metrics = await readMetrics(db, projectId);
    const jobs = await db.query(
      `SELECT status, count(*)::int AS count FROM harness_jobs WHERE project_id = $1 GROUP BY status ORDER BY status`,
      [projectId],
    );
    console.log(`Project: ${project.rows[0].name} (${project.rows[0].status})`);
    console.table(Object.entries(metrics).map(([metric, value]) => ({ metric, value })));
    console.table(jobs.rows);

    const gaps = readinessGaps(config, metrics);
    if (!gaps.length) console.log("Runtime readiness targets satisfied.");
    else console.log(`Highest gap: ${gaps[0].key} ${gaps[0].value.toFixed(3)} / ${gaps[0].target.toFixed(3)}`);
  });
}

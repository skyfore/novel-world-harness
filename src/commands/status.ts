import path from "node:path";
import { loadConfig } from "../config/load.js";
import { readinessGaps } from "../harness/readiness.js";
import { WorkspaceStore } from "../storage/workspace-store.js";

export async function statusCommand(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  const store = await WorkspaceStore.create(path.dirname(path.resolve(configPath)));
  const project = await store.readProject();
  if (!project) {
    console.log("Project has no local harness state. Run ingest first.");
    return;
  }

  const [metrics, jobs, sources] = await Promise.all([
    store.readMetrics(),
    store.listJobs(),
    store.listSources(),
  ]);
  const jobCounts = Object.entries(
    jobs.reduce<Record<string, number>>((counts, job) => {
      counts[job.status] = (counts[job.status] ?? 0) + 1;
      return counts;
    }, {}),
  ).map(([status, count]) => ({ status, count }));

  console.log(`Project: ${project.name} (${project.status})`);
  console.log(`Local sources: ${sources.length}`);
  console.table(Object.entries(metrics).map(([metric, value]) => ({ metric, value })));
  console.table(jobCounts);

  const gaps = readinessGaps(config, metrics);
  if (!gaps.length) console.log("Runtime readiness targets satisfied.");
  else console.log(`Highest gap: ${gaps[0].key} ${gaps[0].value.toFixed(3)} / ${gaps[0].target.toFixed(3)}`);
}

import { loadConfig } from "../config/load.js";
import { withDb } from "../db/client.js";
import { ensureProject, ingestSourceDocument } from "../db/projects.js";
import { bootstrapCompilerJobs } from "../harness/bootstrap.js";
import { CompilerLoop } from "../harness/compiler-loop.js";
import { initialWorkers } from "../harness/workers.js";
import { createPiSessionFactory } from "../llm/pi-session.js";

export async function ingestCommand(filePath: string, configPath: string, runLoop: boolean): Promise<void> {
  const config = await loadConfig(configPath);
  const pi = await createPiSessionFactory(config);
  await withDb(config, async (db) => {
    const project = await ensureProject(db, config.project.name, config.project.language);
    const { document } = await ingestSourceDocument(db, project.id, filePath);
    await bootstrapCompilerJobs(db, project.id, document.id);
    console.log(`Registered source ${document.title} for project ${project.slug}.`);

    if (runLoop) {
      const loop = new CompilerLoop(initialWorkers());
      const result = await loop.run({ config, db, projectId: project.id, pi });
      console.log(`Compiler loop stopped after ${result.loops} iteration(s); ready=${result.ready}.`);
    } else {
      console.log("Compiler jobs queued. Use ingest without --no-loop or a future worker command to continue.");
    }
  });
}

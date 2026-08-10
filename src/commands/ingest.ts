import path from "node:path";
import { loadConfig } from "../config/load.js";
import { bootstrapCompilerJobs } from "../harness/bootstrap.js";
import { CompilerLoop } from "../harness/compiler-loop.js";
import { initialWorkers } from "../harness/workers.js";
import { WorkspaceStore } from "../storage/workspace-store.js";

export async function ingestCommand(filePath: string, configPath: string, runLoop: boolean): Promise<void> {
  const config = await loadConfig(configPath);
  const store = await WorkspaceStore.create(path.dirname(path.resolve(configPath)));
  const project = await store.ensureProject(config.project);
  const document = await store.registerSource(filePath);
  await bootstrapCompilerJobs(store, document.id);
  console.log(`Registered source ${document.title} for project ${project.id}.`);

  if (runLoop) {
    const loop = new CompilerLoop(initialWorkers());
    const result = await loop.run({ config, store });
    console.log(`Compiler loop stopped after ${result.loops} iteration(s); ready=${result.ready}.`);
  } else {
    console.log("Compiler jobs queued in .novel-harness/jobs.");
  }
}

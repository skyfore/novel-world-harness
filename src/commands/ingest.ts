import path from "node:path";
import { SegmentStore, segmentSource } from "../compiler/segments.js";
import { loadConfig } from "../config/load.js";
import { WorkspaceStore } from "../storage/workspace-store.js";

export async function ingestCommand(filePath: string, configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  const store = await WorkspaceStore.create(path.dirname(path.resolve(configPath)));
  const project = await store.ensureProject(config.project);
  const document = await store.registerSource(filePath);
  const manifest = await segmentSource(store.root, document);
  await new SegmentStore(store.root).write(manifest);
  console.log(`Registered source ${document.title} for project ${project.id}.`);
  console.log(`Indexed ${manifest.segments.length} evidence segment(s); run nwh compile-source to create pending proposals.`);
}

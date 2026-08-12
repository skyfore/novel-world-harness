import path from "node:path";
import { SegmentStore, segmentSource } from "../compiler/segments.js";
import { loadOptionalConfig } from "../config/load.js";
import type { HarnessConfig } from "../config/schema.js";
import { WorkspaceStore } from "../storage/workspace-store.js";

export async function ingestWorkspaceSource(
  root: string,
  filePath: string,
  project?: HarnessConfig["project"],
) {
  const store = await WorkspaceStore.create(root);
  const storedProject = await store.ensureProject(project);
  const document = await store.registerSource(filePath);
  const manifest = await segmentSource(store.root, document);
  await new SegmentStore(store.root).write(manifest);
  return { project: storedProject, document, manifest };
}

export async function ingestCommand(filePath: string, configPath: string): Promise<void> {
  const config = await loadOptionalConfig(configPath);
  const { project, document, manifest } = await ingestWorkspaceSource(
    path.dirname(path.resolve(configPath)),
    filePath,
    config?.project,
  );
  console.log(`Registered source ${document.title} for project ${project.id}.`);
  console.log(`Indexed ${manifest.segments.length} evidence segment(s); run nwh compile-source to create pending proposals.`);
}

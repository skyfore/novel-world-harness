import path from "node:path";
import { SegmentStore, segmentSource } from "../compiler/segments.js";
import { loadOptionalConfig } from "../config/load.js";
import type { HarnessConfig } from "../config/schema.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { assertSourceIsNotProjectInstruction } from "../workspace/instruction-trust.js";

export async function ingestWorkspaceSource(
  root: string,
  filePath: string,
  project?: HarnessConfig["project"],
) {
  await assertSourceIsNotProjectInstruction(root, filePath, project?.instructions);
  const store = await WorkspaceStore.create(root);
  const storedProject = await store.ensureProject(project);
  const document = await store.registerSource(filePath);
  const manifest = await segmentSource(store.root, document);
  await new SegmentStore(store.root).write(manifest);
  return { project: storedProject, document, manifest };
}

export async function ingestWorkspaceContent(
  root: string,
  title: string,
  content: string | Uint8Array,
  project?: HarnessConfig["project"],
) {
  const store = await WorkspaceStore.create(root);
  const storedProject = await store.ensureProject(project);
  const document = await store.registerSourceContent(title, content);
  const manifest = await segmentSource(store.root, document);
  await new SegmentStore(store.root).write(manifest);
  return { project: storedProject, document, manifest };
}

export async function ingestCommand(filePath: string, configPath: string, cacheRoot?: string): Promise<void> {
  const config = await loadOptionalConfig(configPath);
  const { project, document, manifest } = await ingestWorkspaceSource(
    path.dirname(path.resolve(configPath)),
    filePath,
    config?.project,
  );
  console.log(`Registered source ${document.title} for project ${project.id}.`);
  const restored = await new PreparedNovelCache(path.dirname(path.resolve(configPath)), cacheRoot).restore(document);
  if (restored.status === "restored") {
    console.log(`Restored active prepared revision ${restored.bundleHash} for ${restored.contentMd5}; model compilation is not required.`);
  } else {
    console.log(`Indexed ${manifest.segments.length} evidence segment(s); run nwh compile-source to create pending proposals.`);
  }
}

export async function ingestContentCommand(
  content: string | Uint8Array,
  title: string,
  configPath: string,
  cacheRoot?: string,
): Promise<void> {
  const config = await loadOptionalConfig(configPath);
  const root = path.dirname(path.resolve(configPath));
  const { project, document, manifest } = await ingestWorkspaceContent(root, title, content, config?.project);
  console.log(`Registered content source ${document.title} for project ${project.id}.`);
  const restored = await new PreparedNovelCache(root, cacheRoot).restore(document);
  if (restored.status === "restored") {
    console.log(`Restored active prepared revision ${restored.bundleHash} for ${restored.contentMd5}; model compilation is not required.`);
  } else {
    console.log(`Archived ${document.bytes} source byte(s) and indexed ${manifest.segments.length} evidence segment(s); run nwh compile-source to create pending proposals.`);
  }
}

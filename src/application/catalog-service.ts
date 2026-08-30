import path from "node:path";
import { inspectPlayExperience } from "../world/play-experience.js";
import { playSessionIdForBranch } from "../world/play-session.js";
import {
  catalogSnapshotSchema,
  type CatalogSnapshot,
  type PlaySessionSummary,
} from "../web/contracts.js";

export class CatalogService {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async read(): Promise<CatalogSnapshot> {
    const catalog = await inspectPlayExperience(this.root);
    const instancesByBranch = new Map(catalog.instances.map((instance) => [instance.branchId, instance]));
    const playSessions: PlaySessionSummary[] = catalog.savedSessions.map((session) => {
      const instance = instancesByBranch.get(session.branchId);
      return {
        id: session.id,
        storageVersion: session.version,
        branchId: session.branchId,
        ...(session.sourceId ? { sourceId: session.sourceId } : {}),
        actorId: session.actorId,
        ...(instance?.actorName ? { actorName: instance.actorName } : {}),
        lastCommitId: session.lastCommitId,
        active: catalog.activeSession?.branchId === session.branchId,
        atHead: instance?.headCommitId === session.lastCommitId,
        status: session.status,
        updatedAt: session.updatedAt,
      };
    });

    return catalogSnapshotSchema.parse({
      project: catalog.project ? {
        id: catalog.project.id,
        name: catalog.project.name,
        language: catalog.project.language,
        createdAt: catalog.project.createdAt,
        updatedAt: catalog.project.updatedAt,
      } : null,
      novels: catalog.novels.map((novel) => ({
        id: novel.id,
        title: novel.title,
        sourcePath: novel.sourcePath,
        bytes: novel.bytes,
        contentSha256: novel.contentSha256,
        registeredAt: novel.registeredAt,
        updatedAt: novel.updatedAt,
        instanceCount: catalog.instances.filter((instance) => instance.sourceId === novel.id).length,
      })),
      instances: catalog.instances,
      playSessions,
      activeSessionId: catalog.activeSession?.id ?? null,
    });
  }
}

export function legacyPlaySessionId(branchId: string): string {
  return playSessionIdForBranch(branchId);
}

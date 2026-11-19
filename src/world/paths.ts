import path from "node:path";
import { workspaceStateDir } from "../agent/runtime-paths.js";

/**
 * The MVP intentionally starts a clean executable-world namespace. Source
 * archives remain outside this directory and can be recompiled; no older-world
 * branch, prepared artifact, or runtime cache is migrated implicitly.
 */
/** v4: the slim-pipeline namespace (iteration 02, decision D5); v3 and older are never read. */
export const WORLD_STORAGE_VERSION = "v4" as const;

export function worldStorageRoot(workspaceRoot: string): string {
  return path.join(workspaceStateDir(workspaceRoot), "world", WORLD_STORAGE_VERSION);
}

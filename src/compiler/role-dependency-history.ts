import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { retainRoleDependencyFiles, type RoleDependencyReview } from "./role-dependency-review.js";
import type { RoleReviewPlan } from "./role-review-work.js";

type Files = RoleDependencyReview["retainedFiles"];
const journalPath = (sourceId: string, batchId: string) => path.join("compiler", "proposal-obligations",
  createHash("sha256").update(JSON.stringify([sourceId, batchId])).digest("hex"));
const sameFiles = (a: Files, b: Files) => a.length === b.length && new Set(a.map(f => f.path)).size === a.length
  && new Set(b.map(f => f.path)).size === b.length && b.every(f => a.some(c => c.path === f.path && c.hash === f.hash));

/** Read both known producer layouts without migrating or repinning history.
 * Legacy records bound the entire role-work tree and the original plan journal;
 * new records bind this source's plans, budgets and journals only. */
export async function captureRoleDependencyHistory(root: string, sourceId: string, plans: RoleReviewPlan[], retained?: RoleDependencyReview) {
  if (retained && retained.scope.sourceId !== sourceId) throw prerequisiteStop("Retained role history belongs to another source; inspect the original scope, no retry");
  const storage = worldStorageRoot(root);
  async function scan(roots: string[]) {
    const files: Files = [];
    async function capture(file: string) {
      const stat = await fs.lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
      if (!stat) return;
      if (stat.isSymbolicLink() || file.endsWith(".tmp") || file.endsWith(".pending")) throw prerequisiteStop("Unsettled or redirected original role work; inspect the same source/task history, no repinning or retry");
      if (stat.isDirectory()) { for (const name of (await fs.readdir(file)).sort()) await capture(path.join(file, name)); return; }
      files.push({ path: path.relative(storage, file), hash: createHash("sha256").update(await fs.readFile(file)).digest("hex") });
    }
    for (const directory of roots) await capture(path.join(storage, directory));
    return files;
  }
  const currentRoots = [path.join("compiler", "role-review-work", "v1", contentHash(sourceId)),
    ...plans.flatMap(plan => [path.join("compiler", "role-review-work", "budgets", contentHash(plan)), journalPath(sourceId, plan.batchId)])];
  const current = await scan(currentRoots);
  if (!retained || sameFiles(current, retained.retainedFiles)) return retainRoleDependencyFiles(current, retained?.retainedFiles);
  // Select the producer layout from the retained inventory, never from a
  // changed budget. A source-local mismatch must not inspect other novels.
  if (retained.retainedFiles.every(file => currentRoots.some(directory => file.path.startsWith(`${directory}${path.sep}`))))
    return retainRoleDependencyFiles(current, retained.retainedFiles);
  const legacy = await scan([path.join("compiler", "role-review-work"), journalPath(sourceId, retained.priorPlan.batchId)]);
  // A producer-layout match requires EVERY original file, hash and absence.
  // Neither missing evidence nor a changed budget can select a weaker layout.
  return retainRoleDependencyFiles(legacy, retained.retainedFiles);
}

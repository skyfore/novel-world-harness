import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { workspaceStateDir } from "../agent/runtime-paths.js";
import { SourceMaterialStore } from "../storage/source-material-store.js";
import { contentHash } from "../world/canonical.js";
import { idSchema } from "../world/model.js";
import { worldStorageRoot } from "../world/paths.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const coverageDependencySchema = z.object({
  store: z.enum(["world", "annotation", "accounting"]), proposalId: idSchema, contentHash: hash,
}).strict();
export type CoverageDependency = z.infer<typeof coverageDependencySchema>;
export const accountingCoverageProofSchema = z.object({
  version: z.literal(1), sourceId: idSchema, sourceSha256: hash, batchId: idSchema, proposalId: idSchema,
  failedInputHashes: z.array(hash).min(1),
  units: z.array(z.object({
    unitId: idSchema, unitHash: hash, dependency: coverageDependencySchema,
    kind: z.enum(["evidence", "annotation", "decision"]), coverageId: idSchema,
  }).strict()).min(1).refine((units) => new Set(units.map((unit) => unit.unitId)).size === units.length, "coverage units must be unique"),
  originalPageTokens: z.array(z.string()),
  auditRefs: z.array(z.string().trim().min(1)),
  verifiedAt: z.string().datetime(),
}).strict();
export type AccountingCoverageProof = z.infer<typeof accountingCoverageProofSchema>;

export function accountingDependencyDirectory(root: string, sourceId: string, store: CoverageDependency["store"]) {
  const world = worldStorageRoot(root);
  if (store === "world") return path.join(world, "proposals");
  if (store === "accounting") return path.join(world, "compiler", "observations", "v1", "accounting", "proposals", sourceId);
  return path.join(world, "compiler", "observations", "v1", "annotations", sourceId, "proposals");
}

/** Recheck only recorded dependencies; any withdrawal/change makes the old proof non-authoritative. */
export function accountingCoverageProofFailure(root: string, proof: AccountingCoverageProof): string | undefined {
  try {
    accountingCoverageProofSchema.parse(proof);
    const source = readJson(path.join(workspaceStateDir(root), "sources", `${proof.sourceId}.json`));
    if (source?.contentSha256 !== proof.sourceSha256) return "source registration changed";
    const bytes = fs.readFileSync(path.join(new SourceMaterialStore().root, proof.sourceSha256, "source.utf8"));
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== proof.sourceSha256) return "source bytes changed";
    const structure = readJson(path.join(worldStorageRoot(root), "compiler", "observations", "v1", "structure", `${proof.sourceId}.json`));
    if (structure?.sourceSha256 !== proof.sourceSha256 || !Array.isArray(structure.units)) return "source structure changed";
    for (const unit of proof.units) {
      const current = structure.units.find((value: { id?: string }) => value.id === unit.unitId);
      if (!current || contentHash(current) !== unit.unitHash) return `source unit ${unit.unitId} changed`;
    }
    const dependencies = new Map(proof.units.map((unit) => [`${unit.dependency.store}:${unit.dependency.proposalId}`, unit.dependency]));
    for (const dependency of dependencies.values()) {
      const directory = accountingDependencyDirectory(root, proof.sourceId, dependency.store);
      const pending = readJson(path.join(directory, "pending", `${dependency.proposalId}.json`));
      const value = pending ?? readJson(path.join(directory, "accepted", `${dependency.proposalId}.json`));
      if (!value || contentHash(value) !== dependency.contentHash) return `coverage dependency ${dependency.store}:${dependency.proposalId} was withdrawn or changed`;
      const batchId = dependency.store === "accounting" ? value.compilerBatchId : value.generatedBy?.compilerBatchId;
      if (batchId !== proof.batchId) return `coverage dependency ${dependency.proposalId} changed scope`;
      if (dependency.store === "annotation" && !pending) {
        const ref = readJson(path.join(directory, "..", "refs", `${value.payload.id}.json`));
        if (ref?.hash !== contentHash(value.payload)) return `annotation ${value.payload.id} is no longer current`;
      }
      // Do not keep certifying an older semantic identity after a competing
      // pending revision appears. Accounting identities are immutable pages.
      if (dependency.store !== "accounting") {
        for (const name of names(path.join(directory, "pending"))) {
          if (name === `${dependency.proposalId}.json`) continue;
          const other = readJson(path.join(directory, "pending", name));
          if (other?.kind === value.kind && other?.annotationType === value.annotationType
            && other?.payload?.id === value.payload?.id && value.payload?.id) return `ambiguous coverage identity ${value.payload.id}`;
        }
      }
    }
    return undefined;
  } catch (error) { return `coverage proof cannot be verified: ${error instanceof Error ? error.message : String(error)}`; }
}

// These reads never initialize, migrate, repair, or accept stored state.
function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function names(directory: string): string[] {
  try { return fs.readdirSync(directory).filter((name) => name.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

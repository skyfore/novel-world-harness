import path from "node:path";
import { stdout } from "node:process";
import { loadOptionalConfig } from "../config/load.js";
import { inspectPreparation, resolvePreparationBranchId, type PreparationInspection } from "../workflow/prepare.js";
import { compileSourceCommand } from "./compile-source.js";
import { ingestWorkspaceSource } from "./ingest.js";
import { worldCreateCommand } from "./world.js";

export type PrepareCommandOptions = {
  root: string;
  configPath?: string;
  novelPath?: string;
  sourceId?: string;
  branchId?: string;
  model?: string;
  maxBatches?: number;
};

export async function prepareCommand(options: PrepareCommandOptions): Promise<PreparationInspection> {
  const root = path.resolve(options.root);
  const configPath = options.configPath ?? path.join(root, "novel-harness.yaml");
  let sourceId = options.sourceId;
  if (options.novelPath) {
    const config = await loadOptionalConfig(configPath);
    const ingested = await ingestWorkspaceSource(root, options.novelPath, config?.project);
    sourceId = ingested.document.id;
    stdout.write(`Registered ${ingested.document.sourcePath} as ${sourceId}; indexed ${ingested.manifest.segments.length} segment(s).\n`);
  }

  let branchId = options.branchId;
  let inspection = await inspectPreparation(root, { sourceId, branchId });
  if (!branchId && inspection.source) {
    branchId = await resolvePreparationBranchId(root, inspection.source);
    if (branchId !== inspection.branchId) inspection = await inspectPreparation(root, { sourceId: inspection.source.id, branchId });
  }
  if (inspection.stage === "compile" && (options.maxBatches ?? 1) > 0) {
    await compileSourceCommand({
      root,
      configPath,
      allowMissingConfig: true,
      sourceId: inspection.source!.id,
      ...(options.model ? { model: options.model } : {}),
      maxBatches: options.maxBatches ?? 1,
      resume: true,
    });
    inspection = await inspectPreparation(root, {
      sourceId: inspection.source!.id,
      branchId,
    });
  }
  if (inspection.stage === "create-branch") {
    await worldCreateCommand(root, inspection.branchId, undefined, inspection.source!.id);
    inspection = await inspectPreparation(root, {
      sourceId: inspection.source!.id,
      branchId,
    });
  }

  printInspection(inspection);
  return inspection;
}

function printInspection(inspection: PreparationInspection): void {
  stdout.write(`Preparation: ${inspection.stage}\n`);
  if (inspection.source) {
    stdout.write(`Source: ${inspection.source.id} (${inspection.completedBatches}/${inspection.totalBatches} compiler batches)\n`);
  }
  if (inspection.pending.length) {
    const byKind = new Map<string, number>();
    for (const proposal of inspection.pending) byKind.set(proposal.kind, (byKind.get(proposal.kind) ?? 0) + 1);
    stdout.write(`Pending review: ${[...byKind.entries()].sort().map(([kind, count]) => `${kind}=${count}`).join(", ")}\n`);
    stdout.write("Nothing was accepted automatically. Inspect each proposal before accepting or rejecting it.\n");
  }
  for (const reason of inspection.repairReasons ?? []) stdout.write(`Repair: ${reason}\n`);
  stdout.write(`Next: ${inspection.next}\n`);
}

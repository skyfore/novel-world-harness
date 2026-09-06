import fs from "node:fs/promises";
import path from "node:path";
import { stdout, stderr } from "node:process";
import { PreparedNovelCache } from "../compiler/prepared-cache.js";
import { loadOptionalConfig, profileForRole } from "../config/load.js";
import { NovelEvaluationPlanStore } from "../eval/novel-evaluation-plan.js";
import { evaluateNovelPlay, novelQualityIntervals } from "../eval/novel-play-evaluator.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";

export async function freezeNovelEvaluationCommand(root: string, planFile: string, sourceId?: string): Promise<void> {
  await withWorkspaceOperationLock(root, "compiler", async () => {
    const sources = await (await WorkspaceStore.create(root)).listSources();
    const source = sourceId ? sources.find((source) => source.id === sourceId) : sources.length === 1 ? sources[0] : undefined;
    if (!source) throw new Error("Select one registered source with --source before freezing evaluation");
    const bundle = await new PreparedNovelCache(root).candidateSnapshot(source);
    const result = await new NovelEvaluationPlanStore(root).freeze(JSON.parse(await fs.readFile(path.resolve(planFile), "utf8")), bundle);
    stdout.write(`${JSON.stringify({ planHash: result.hash, subjectSnapshotHash: result.plan.subjectSnapshotHash, frozenAt: result.plan.frozenAt })}\n`);
  });
}

export async function evaluateNovelCommand(root: string, planHash: string, configPath?: string, model?: string): Promise<void> {
  await withWorkspaceOperationLock(root, "compiler", async () => {
    const config = await loadOptionalConfig(configPath ?? path.join(root, "novel-harness.yaml"));
    const profile = config ? profileForRole(config, "player").profile : undefined;
    const report = await evaluateNovelPlay({ root, planHash, ...(profile ? { profile } : {}), ...(model ? { model } : {}), onStatus: (message) => stderr.write(`${message}\n`) });
    stdout.write(`${JSON.stringify({ report, intervals95: novelQualityIntervals(report) }, null, 2)}\n`);
    if (report.issues.length) process.exitCode = 1;
  });
}

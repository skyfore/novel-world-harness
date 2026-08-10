import { claimNextJob, failJob, finishJob } from "./jobs.js";
import { readMetrics } from "./metrics.js";
import { isRuntimeReady, readinessGaps } from "./readiness.js";
import type { HarnessContext, HarnessWorker } from "./types.js";

export class CompilerLoop {
  private readonly workers = new Map<string, HarnessWorker>();

  constructor(workers: HarnessWorker[]) {
    for (const worker of workers) this.workers.set(worker.type, worker);
  }

  async run(ctx: HarnessContext): Promise<{ loops: number; ready: boolean }> {
    for (let loop = 1; loop <= ctx.config.harness.maxLoops; loop += 1) {
      const metrics = await readMetrics(ctx.store);
      if (isRuntimeReady(ctx.config, metrics)) return { loops: loop - 1, ready: true };

      const job = await claimNextJob(ctx.store);
      if (!job) {
        const gaps = readinessGaps(ctx.config, metrics);
        console.log("No pending harness jobs. Highest readiness gaps:");
        for (const gap of gaps.slice(0, 5)) {
          console.log(`  - ${gap.key}: ${gap.value.toFixed(3)} / ${gap.target.toFixed(3)}`);
        }
        return { loops: loop - 1, ready: false };
      }

      const worker = this.workers.get(job.jobType);
      if (!worker) {
        await failJob(ctx.store, job.id, new Error(`No worker registered for ${job.jobType}`));
        continue;
      }

      try {
        const output = await worker.execute(ctx, job);
        await finishJob(ctx.store, job.id, output);
      } catch (error) {
        await failJob(ctx.store, job.id, error);
        console.error(`[harness] ${job.jobType} failed:`, error);
      }

      if (loop % ctx.config.harness.checkpointEvery === 0) {
        console.log(`[harness] checkpoint loop=${loop}`);
      }
    }

    return { loops: ctx.config.harness.maxLoops, ready: false };
  }
}

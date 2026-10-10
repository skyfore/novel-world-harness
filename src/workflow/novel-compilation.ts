import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { worldStorageRoot } from "../world/paths.js";

export const NOVEL_COMPILATION_PHASES = [
  "source", "recover", "batches", "converge", "opening", "roles", "repair", "requirements",
  "archive", "evaluation-plan", "evaluate", "certify", "activate", "branch",
] as const;
export type NovelCompilationPhase = typeof NOVEL_COMPILATION_PHASES[number];
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const receiptSchema = z.object({
  phase: z.enum(NOVEL_COMPILATION_PHASES), startedAt: z.string(), finishedAt: z.string().optional(),
  status: z.enum(["running", "completed", "blocked"]), error: z.string().optional(),
}).strict();
const runSchema = z.object({
  version: z.literal(1), id: safeId, sourceId: safeId, sourceSha256: digest,
  mode: z.enum(["resume", "rebuild"]), rebuildInitialized: z.boolean(),
  baselineBundleHash: digest.optional(), activeAtStart: digest.nullable().optional(),
  rebuildBatchIds: z.array(z.string()).optional(),
  subjectHash: digest.optional(), planHash: digest.optional(), bundleHash: digest.optional(),
  activatedBundleHash: digest.optional(),
  branchId: safeId.optional(), completed: z.boolean(),
  history: z.array(receiptSchema),
}).strict();
export type NovelCompilationRun = z.infer<typeof runSchema>;

/** Scheduling receipts only. Semantic truth, failures and certification remain in their existing stores. */
export class NovelCompilationRunStore {
  constructor(readonly root: string) {}
  private file(sourceId: string) {
    return path.join(worldStorageRoot(this.root), "compiler", "novel-compilation", `${safeId.parse(sourceId)}.json`);
  }
  async read(sourceId: string): Promise<NovelCompilationRun | null> {
    try { return runSchema.parse(JSON.parse(await fs.readFile(this.file(sourceId), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async write(run: NovelCompilationRun): Promise<void> {
    const parsed = runSchema.parse(run), file = this.file(run.sourceId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Retain previous orchestration generations too; never use them as completion certificates.
    const historyFile = path.join(path.dirname(file), `${parsed.id}.json`);
    await atomicWrite(historyFile, parsed);
    await atomicWrite(file, parsed);
  }
}

async function atomicWrite(file: string, value: unknown) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export function newNovelCompilationRun(source: { id: string; contentSha256: string }, rebuild = false): NovelCompilationRun {
  return { version: 1, id: `novel-${crypto.randomUUID()}`, sourceId: source.id, sourceSha256: source.contentSha256,
    mode: rebuild ? "rebuild" : "resume", rebuildInitialized: false, completed: false, history: [] };
}

export async function runNovelCompilation(input: {
  run: NovelCompilationRun;
  phase?: NovelCompilationPhase;
  save: (run: NovelCompilationRun) => Promise<void>;
  execute: (phase: NovelCompilationPhase, run: NovelCompilationRun) => Promise<void>;
  signal?: AbortSignal;
  report?: (message: string) => void;
}): Promise<NovelCompilationRun> {
  const { run } = input;
  run.completed = false;
  // Re-enter idempotent phases to validate their current evidence. A saved "completed"
  // receipt alone must never skip a changed roster, requirement set or stale certificate.
  for (const phase of input.phase ? [input.phase] : NOVEL_COMPILATION_PHASES) {
    input.signal?.throwIfAborted();
    const receipt: z.infer<typeof receiptSchema> = { phase, status: "running", startedAt: new Date().toISOString() };
    run.history.push(receipt);
    await input.save(run);
    input.report?.(`Novel compilation: ${phase}`);
    try {
      await input.execute(phase, run);
      input.signal?.throwIfAborted();
      receipt.status = "completed";
      receipt.finishedAt = new Date().toISOString();
      await input.save(run);
    } catch (error) {
      receipt.status = "blocked";
      receipt.error = error instanceof Error ? error.message : String(error);
      receipt.finishedAt = new Date().toISOString();
      await input.save(run);
      throw new Error(`NOVEL_COMPILATION_BLOCKED [${phase}]: ${receipt.error}\n`
        + `Progress retained. Inspect nwh compile-novel status --source ${run.sourceId}; `
        + `repair this stage with nwh compile-novel ${phase} --source ${run.sourceId}, then resume nwh compile-novel --source ${run.sourceId}. `
        + "Host-review, scope, single-use and circuit-breaker stops require their stated recovery first; do not retry unchanged or use --rebuild to reset attempts.", { cause: error });
    }
  }
  run.completed = !input.phase;
  await input.save(run);
  return run;
}

import { z } from "zod";

export const workerResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), delivery: z.object({
    runId: z.string().min(1), candidateBundleHash: z.string().regex(/^[a-f0-9]{64}$/),
    branchId: z.string().min(1), completed: z.literal(true),
  }).strict() }).strict(),
  z.object({ status: z.literal("failed"), error: z.string().optional() }).strict(),
]);
export const deliveryVerificationSchema = z.object({ verified: z.boolean(), reason: z.string().min(1) }).strict();
export type WorkerResult = z.infer<typeof workerResultSchema>;

export type NovelDelivery = { runId: string; candidateBundleHash?: string; branchId?: string; completed: boolean };
export async function verifyNovelDelivery(root: string, sourceId: string, delivery: NovelDelivery) {
  const { NovelCompilationRunStore, NOVEL_COMPILATION_PHASES } = await import("../../workflow/novel-compilation.js");
  const { WorkspaceStore } = await import("../../storage/workspace-store.js");
  const { PreparedNovelCache } = await import("../../compiler/prepared-cache.js");
  const { assertPreparedReadiness, preparedSubjectHash } = await import("../../compiler/certification.js");
  const { BranchStore } = await import("../../world/store.js");
  try {
    if (!delivery.completed || !delivery.candidateBundleHash || !delivery.branchId) throw new Error("Incomplete worker delivery");
    const run = await new NovelCompilationRunStore(root).read(sourceId);
    if (!run?.completed || run.id !== delivery.runId || run.bundleHash !== delivery.candidateBundleHash || run.branchId !== delivery.branchId) throw new Error("Original full compilation run differs from worker delivery");
    const latest = run.history.slice(-NOVEL_COMPILATION_PHASES.length);
    if (latest.length !== NOVEL_COMPILATION_PHASES.length || latest.some((r, i) => r.phase !== NOVEL_COMPILATION_PHASES[i] || r.status !== "completed")) throw new Error("Full phase sequence has not completed");
    const source = await WorkspaceStore.openReadOnly(root).getSource(sourceId);
    if (!source || source.contentSha256 !== run.sourceSha256) throw new Error("Source identity changed");
    const cache = new PreparedNovelCache(root), active = await cache.loadFreshActive(source);
    if (!active || active.bundleHash !== delivery.candidateBundleHash) throw new Error("No current active delivery revision");
    assertPreparedReadiness(active.bundle);
    if (preparedSubjectHash(active.bundle) !== preparedSubjectHash(await cache.candidateSnapshot(source))) throw new Error("Certified inputs are stale");
    const branch = await new BranchStore(root).read(delivery.branchId!);
    if (branch.sourceId !== sourceId || branch.preparedRevisionHash !== delivery.candidateBundleHash) throw new Error("Branch is pinned to a different source/revision");
    return { verified: true, reason: "Full phases, current certificate, active revision and branch binding verified" };
  } catch (error) { return { verified: false, reason: String(error) }; }
}

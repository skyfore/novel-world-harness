import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { worldStorageRoot } from "../world/paths.js";
import { idSchema } from "../world/model.js";
import { CompilerFinishReceipts } from "./finish-receipts.js";

const decisionSchema = z.object({
  sourceId: idSchema, batchId: idSchema, finishFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  reviewedAt: z.string().datetime(),
  reviews: z.array(z.object({ target: z.string().min(1), reason: z.string().min(1), auditRef: z.string().min(1) }).strict()),
}).strict();
function decisionPath(root: string, sourceId: string, fingerprint: string) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Invalid finish fingerprint; stop for host review.");
  return path.join(worldStorageRoot(root), "compiler", "reconciliation-review-decisions", idSchema.parse(sourceId), `${fingerprint}.json`);
}
/** Host-only, under the compiler lock. Records source review, never certifies world truth. */
export async function reviewReconciliationDeferrals(root: string, input: z.infer<typeof decisionSchema>): Promise<void> {
  const decision = decisionSchema.parse(input);
  const receipts = new CompilerFinishReceipts(root, decision.sourceId, decision.batchId);
  const receipt = await receipts.read();
  if (!receipt || receipt.state !== "completed" || receipt.fingerprint !== decision.finishFingerprint) throw new Error("Host review must name the exact completed finish fingerprint.");
  await receipts.verify(receipt);
  const expected = receipt.identity.input.target_reviews?.filter(review => review.disposition !== "proposed").map(review => review.target).sort() ?? [];
  const actual = decision.reviews.map(review => review.target).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Host review must cover every deferred target exactly once.");
  const file = decisionPath(root, decision.sourceId, decision.finishFingerprint);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Preserve the first host decision; corrections need a separate audited workflow.
  await fs.writeFile(file, JSON.stringify(decision, null, 2), { flag: "wx" });
}

/** Scan immutable receipts, so a restart, clean audit, or changed plan cannot forget a deferral. */
export async function assertReconciliationDeferralsReviewed(root: string, sourceId: string): Promise<void> {
  const directory = path.join(worldStorageRoot(root), "compiler", "finish-receipts", idSchema.parse(sourceId));
  let files: string[];
  try { files = await fs.readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const file of files.filter(file => file.endsWith(".json")).sort()) {
    const saved = JSON.parse(await fs.readFile(path.join(directory, file), "utf8"));
    const receipts = new CompilerFinishReceipts(root, sourceId, saved.identity.batchId);
    const receipt = await receipts.read();
    const targets = receipt?.identity.input.target_reviews?.filter(review => review.disposition !== "proposed").map(review => review.target).sort() ?? [];
    if (!receipt || !targets.length) continue;
    let decision;
    try { decision = decisionSchema.parse(JSON.parse(await fs.readFile(decisionPath(root, sourceId, receipt.fingerprint), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(`Reconciliation deferrals require host source review before publication: ${receipt.identity.batchId}: ${targets.join(", ")}. Inspect the original target_reviews in the finish receipt and immutable source; record an audited host review with reviewReconciliationDeferrals under the compiler lock. Do not retry unchanged or rotate the namespace; model unsupported reports never clear this gate.`);
    }
    if (decision.sourceId !== sourceId || decision.batchId !== receipt.identity.batchId || decision.finishFingerprint !== receipt.fingerprint
      || JSON.stringify(decision.reviews.map(review => review.target).sort()) !== JSON.stringify(targets)) throw new Error("Reconciliation host review scope mismatch; stop for host review.");
  }
}

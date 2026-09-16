import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { worldStorageRoot } from "../world/paths.js";
import { idSchema } from "../world/model.js";
import { CompilerFinishReceipts, compilerFinishReceiptSchema, isPureRoleReviewFinish } from "./finish-receipts.js";
import { reconciliationDeferredRequirementIds } from "./reconciliation-review.js";
import { contentHash } from "../world/canonical.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { SourceMaterialStore } from "../storage/source-material-store.js";
import crypto from "node:crypto";

export const reconciliationReviewDecisionSchema = z.object({
  sourceId: idSchema, batchId: idSchema, finishFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  reviewedAt: z.string().datetime(),
  reviews: z.array(z.object({ target: z.string().min(1), reason: z.string().min(1), auditRef: z.string().min(1) }).strict()),
}).strict();
const decisionSchema = reconciliationReviewDecisionSchema;
export const reconciliationObligationSnapshotSchema = z.array(z.object({
  receipt: compilerFinishReceiptSchema,
  resumeRoleReview: z.literal(true).optional(),
  decision: decisionSchema.optional(),
}).strict()).superRefine((items, ctx) => {
  for (const item of items) if (item.resumeRoleReview && (item.receipt.state !== "prepared" || !isPureRoleReviewFinish(item.receipt))) ctx.addIssue({ code: "custom", message: "Only an active pure prepared role-review finish may be resumed" });
  if (new Set(items.map(item => item.receipt.fingerprint)).size !== items.length) ctx.addIssue({ code: "custom", message: "Duplicate reconciliation obligation fingerprint" });
});
export type ReconciliationObligationSnapshot = z.infer<typeof reconciliationObligationSnapshotSchema>;
function decisionPath(root: string, sourceId: string, fingerprint: string) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Invalid finish fingerprint; stop for host review.");
  return path.join(worldStorageRoot(root), "compiler", "reconciliation-review-decisions", idSchema.parse(sourceId), `${fingerprint}.json`);
}
/** Host-only, under the compiler lock. Records source review, never certifies world truth. */
export async function reviewReconciliationDeferrals(root: string, input: z.infer<typeof decisionSchema>): Promise<void> {
  const decision = decisionSchema.parse(input);
  const receipts = new CompilerFinishReceipts(root, decision.sourceId, decision.batchId);
  const retained = (await CompilerFinishReceipts.listRetained(root, decision.sourceId)).find(item => item.receipt.fingerprint === decision.finishFingerprint);
  const receipt = retained?.receipt;
  if (!receipt || receipt.identity.batchId !== decision.batchId || (!retained.archived && receipt.state !== "completed")) throw new Error("Host review must name the exact completed finish fingerprint or an explicitly retired attempt.");
  if (!retained.archived) await receipts.verify(receipt);
  else {
    // A historical review cannot replay proposals or require superseded active
    // dependencies. It still verifies the immutable source actually reviewed.
    const source = await WorkspaceStore.openReadOnly(root).getSource(decision.sourceId);
    if (!source || source.contentSha256 !== receipt.identity.sourceSha256) throw new Error("Archived review source mismatch; stop for host source review.");
    const bytes = await new SourceMaterialStore().read(source);
    if (!bytes || crypto.createHash("sha256").update(bytes).digest("hex") !== receipt.identity.sourceSha256) throw new Error("Archived review source bytes unavailable; stop for host storage repair.");
  }
  const expected = reconciliationDeferredRequirementIds(receipt.identity.input.target_reviews ?? []);
  const actual = decision.reviews.map(review => review.target).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Host review must cover every deferred target exactly once.");
  const file = decisionPath(root, decision.sourceId, decision.finishFingerprint);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Preserve the first host decision; corrections need a separate audited workflow.
  await fs.writeFile(file, JSON.stringify(decision, null, 2), { flag: "wx" });
}

/** Capture active AND retired work. Archiving is not a settlement operation. */
export async function captureReconciliationObligations(root: string, sourceId: string): Promise<ReconciliationObligationSnapshot> {
  const snapshot: ReconciliationObligationSnapshot = [];
  for (const { receipt, archived } of await CompilerFinishReceipts.listRetained(root, sourceId)) {
    if (!receipt.identity.input.target_reviews?.length && !receipt.identity.metadata.roleReview) continue;
    let decision;
    try { decision = decisionSchema.parse(JSON.parse(await fs.readFile(decisionPath(root, sourceId, receipt.fingerprint), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    snapshot.push({ receipt, ...(!archived && receipt.state === "prepared" && isPureRoleReviewFinish(receipt) ? { resumeRoleReview: true as const } : {}), ...(decision ? { decision } : {}) });
  }
  return reconciliationObligationSnapshotSchema.parse(snapshot);
}

export function reconciliationObligationIssues(snapshotInput: ReconciliationObligationSnapshot, sourceId: string, sourceSha256?: string): string[] {
  const issues: string[] = [];
  for (const { receipt, decision } of reconciliationObligationSnapshotSchema.parse(snapshotInput)) {
    const targets = reconciliationDeferredRequirementIds(receipt.identity.input.target_reviews ?? []);
    if (receipt.identity.sourceId !== sourceId || (sourceSha256 && receipt.identity.sourceSha256 !== sourceSha256)) issues.push(`Reconciliation obligation source mismatch: ${receipt.fingerprint}`);
    if (!targets.length && !decision) continue;
    if (!decision) { issues.push(`Reconciliation deferrals require host source review before publication: ${receipt.identity.batchId}: ${targets.join(", ")}`); continue; }
    if (decision.sourceId !== sourceId || decision.batchId !== receipt.identity.batchId || decision.finishFingerprint !== receipt.fingerprint
      || JSON.stringify(decision.reviews.map(review => review.target).sort()) !== JSON.stringify(targets)) issues.push(`Reconciliation host review scope mismatch: ${receipt.fingerprint}`);
  }
  return issues;
}

export async function assertReconciliationDeferralsReviewed(root: string, sourceId: string): Promise<void> {
  const issues = reconciliationObligationIssues(await captureReconciliationObligations(root, sourceId), sourceId);
  if (issues.length) throw new Error(`${issues.join("; ")}. Inspect the original target_reviews in the retained finish receipt and immutable source; record an audited host review with reviewReconciliationDeferrals under the compiler lock. Do not retry unchanged, archive to clear obligations, or rotate the namespace; model unsupported reports never clear this gate.`);
}

export async function assertReconciliationObligationsRestorable(root: string, sourceId: string, snapshotInput: ReconciliationObligationSnapshot): Promise<void> {
  const snapshot = reconciliationObligationSnapshotSchema.parse(snapshotInput);
  if (snapshot.some(item => item.receipt.identity.sourceId !== sourceId)) throw new Error("Reconciliation snapshot source mismatch; stop for host review.");
  for (const item of snapshot) if (item.decision && reconciliationObligationIssues([item], sourceId).length) throw new Error("Imported reconciliation review scope mismatch; stop for host review.");
  for (const current of await captureReconciliationObligations(root, sourceId)) {
    const incoming = snapshot.find(item => item.receipt.fingerprint === current.receipt.fingerprint);
    if (!incoming || contentHash(incoming.receipt) !== contentHash(current.receipt) || (current.resumeRoleReview && !incoming.resumeRoleReview) || (current.decision && (!incoming.decision || contentHash(current.decision) !== contentHash(incoming.decision)))) throw new Error("Reconciliation restore would forget or alter retained obligations; use an isolated workspace. Do not reset receipts or retry unchanged.");
  }
}

export async function restoreReconciliationObligations(root: string, sourceId: string, snapshot: ReconciliationObligationSnapshot): Promise<void> {
  await assertReconciliationObligationsRestorable(root, sourceId, snapshot);
  for (const { receipt, decision, resumeRoleReview } of snapshot) {
    await CompilerFinishReceipts.retainSnapshot(root, sourceId, receipt);
    if (resumeRoleReview) await CompilerFinishReceipts.restoreActiveRoleReview(root, sourceId, receipt);
    if (!decision) continue;
    // Review data was frozen with the source. Importing it never replays writes
    // or changes an existing review. Validate scope even for unresolved imports.
    if (reconciliationObligationIssues([{ receipt, decision }], sourceId).length) throw new Error("Imported reconciliation review scope mismatch; stop for host review.");
    const file = decisionPath(root, sourceId, receipt.fingerprint);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, JSON.stringify(decision, null, 2), { flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (contentHash(JSON.parse(await fs.readFile(file, "utf8"))) !== contentHash(decision)) throw new Error("Imported reconciliation decision conflicts with existing review; stop for host review.");
    }
  }
}

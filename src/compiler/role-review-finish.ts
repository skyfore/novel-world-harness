import { contentHash } from "../world/canonical.js";
import { isPureRoleReviewFinish } from "./finish-receipts.js";
import { validateRosterReview, type RoleRoster } from "./role-roster.js";
import type { ReconciliationObligationSnapshot } from "./reconciliation-review-ledger.js";

/** Historical receipts are audit data. Only explicitly frozen active pure intents may resume. */
export function roleReviewResumeIssues(snapshot: ReconciliationObligationSnapshot, roster: RoleRoster | null, sourceId: string): string[] {
  const issues: string[] = [];
  for (const item of snapshot) {
    if (!item.resumeRoleReview) continue;
    const receipt = item.receipt, review = receipt.identity.metadata.roleReview;
    if (!roster || !review || !isPureRoleReviewFinish(receipt) || receipt.state !== "prepared"
      || receipt.identity.sourceId !== sourceId || receipt.identity.sourceSha256 !== roster.sourceSha256
      || review.subjectHash !== roster.subjectHash || review.reviewRevisionId !== roster.reviewRevisionId) {
      issues.push(`ROLE_REVIEW_RESUME_SCOPE_MISMATCH: ${receipt.fingerprint}`); continue;
    }
    const saved = roster.reviews.find(item => item.runId === review.runId);
    if (saved ? contentHash(saved) !== contentHash(review) : validateRosterReview(roster, review).length > 0) issues.push(`ROLE_REVIEW_RESUME_INPUT_MISMATCH: ${receipt.fingerprint}`);
  }
  return [...new Set(issues)];
}

/** A saved model review is not a completed finish, even if a roster already contains it. */
export function roleReviewFinishIssues(snapshot: ReconciliationObligationSnapshot, roster: RoleRoster | null, sourceId: string): string[] {
  const issues = roleReviewResumeIssues(snapshot, roster, sourceId);
  for (const item of snapshot) if (item.resumeRoleReview && item.receipt.state === "prepared") issues.push(`ROLE_REVIEW_FINISH_INCOMPLETE: ${item.receipt.identity.batchId}`);
  for (const review of roster?.reviews ?? []) {
    const found = snapshot.filter(item => item.receipt.identity.metadata.roleReview?.runId === review.runId);
    // Older human/source-review imports do not claim the dedicated model finish protocol.
    if (!found.length && !review.runId.startsWith(`role-roster-${sourceId}-`)) continue;
    if (found.length !== 1) { issues.push(`ROLE_REVIEW_FINISH_MISSING: ${review.runId}`); continue; }
    const receipt = found[0]!.receipt;
    if (receipt.identity.sourceId !== sourceId || receipt.identity.sourceSha256 !== roster!.sourceSha256
      || contentHash(receipt.identity.metadata.roleReview) !== contentHash(review)) issues.push(`ROLE_REVIEW_FINISH_MISMATCH: ${review.runId}`);
    if (receipt.state !== "completed") issues.push(`ROLE_REVIEW_FINISH_INCOMPLETE: ${review.runId}`);
  }
  return [...new Set(issues)];
}

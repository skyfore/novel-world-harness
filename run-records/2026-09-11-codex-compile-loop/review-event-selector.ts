import fs from "node:fs/promises";
import { CompilerProposalObligations } from "../../src/compiler/proposal-obligations.js";
import { CompilerProposalService } from "../../src/compiler/proposals.js";
import { SegmentStore } from "../../src/compiler/segments.js";
import { resolveTextSelectorAnchor } from "../../src/compiler/text-anchors.js";
import { withWorkspaceOperationLock } from "../../src/util/workspace-lock.js";
const root = process.cwd(), sourceId = "a28585b1cf867f3e3a16", batchId = `reconcile-${sourceId}-bounded-v3-4`;
const proposalId = "event-bronze-city-self-destruction-reconcile-33dd4567e83b";
await withWorkspaceOperationLock(root, "compiler", async () => {
  const journal = new CompilerProposalObligations(root, sourceId, batchId);
  const failed = journal.history("propose_canonical_event", proposalId).filter(a => a.status === "failed");
  const expected = ["b473b14b8846f29cbfbd10c165983ac24c7f0ff0b9e3ececb53c6c38124f60df", "9ea3ac02f97e9f0680e62379efd71ab41d50672e20f59b52b535bade729a93de"];
  if (JSON.stringify(failed.map(a => a.inputHash)) !== JSON.stringify(expected)) throw new Error("Incident changed; fresh review required.");
  const store = new CompilerProposalService(root).store;
  for (const status of ["pending", "accepted", "rejected"] as const) {
    if ((await store.list(status)).some(p => p.id === proposalId)) throw new Error("Proposal was staged; fresh review required.");
  }
  const segments = await new SegmentStore(root).list(sourceId);
  const replay = [];
  for (const attempt of failed) {
    const input = attempt.input as { evidence_selectors: Array<{segment_id: string; exact: string; target_path: string}> };
    const selector = input.evidence_selectors[1]!;
    if (selector.target_path !== "/participants" || selector.exact !== "路明非和诺诺正在潜流中挣扎着") throw new Error("Failed selector changed.");
    const segment = segments.find(s => s.id === selector.segment_id);
    if (!segment) throw new Error("Original evidence segment missing.");
    let diagnostic = "";
    try { await resolveTextSelectorAnchor(root, segment, { segment_id: segment.id, exact: selector.exact }); }
    catch (error) { diagnostic = String(error); }
    if (!diagnostic.includes("Exact evidence quote was not found")) throw new Error("Original quote failure no longer reproduces.");
    const corrected = { segment_id: segment.id, exact: "路明非和诺诺正在潜流中挣扎。" };
    const anchor = await resolveTextSelectorAnchor(root, segment, corrected);
    replay.push({ inputHash: attempt.inputHash, diagnostic, corrected, anchor });
  }
  const reason = "Both original submissions contain the same non-verbatim participants selector: an extra 着 absent from the immutable source. Replaying both selectors through the production source-anchor resolver reproduces the failure, and the corrected exact sentence resolves uniquely. The second attempt changed unrelated title/summary selectors and removed an outcome operation while retaining the failing quote. Neither submission staged an artifact. Preserve all failed inputs and four successful pending drafts. Authorize one evidence-grounded correction under the original proposal ID through the normal complete validation and finish gates; this host review certifies only the corrected text anchor, not event semantics or the removed outcome.";
  await fs.writeFile(new URL("host-review-event-selector.json", import.meta.url), JSON.stringify({ reviewedAt: new Date().toISOString(), sourceId, batchId, proposalId, reason, replay, failed }, null, 2));
  journal.reviewUnsupported("propose_canonical_event", proposalId, reason, "run-records/2026-09-11-codex-compile-loop/host-review-event-selector.json");
  journal.assertModelRecoveryAllowed();
  console.log("Both failed quotes reproduced; corrected immutable-source anchor verified. Host review recorded without committing world changes.");
});

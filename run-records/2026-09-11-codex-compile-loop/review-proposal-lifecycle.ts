import fs from "node:fs/promises";
import { CompilerProposalObligations } from "../../src/compiler/proposal-obligations.js";
import { ProposalStore } from "../../src/world/canonical-model.js";
import { canonicalEventSchema } from "../../src/world/model.js";
import { contentHash } from "../../src/world/canonical.js";
import { CompilerCommitService } from "../../src/compiler/validator.js";
import { compilerFailureFingerprint } from "../../src/runtime/codex-compile-loop.js";
import { withWorkspaceOperationLock } from "../../src/util/workspace-lock.js";
const root = process.cwd(), sourceId = "a28585b1cf867f3e3a16", namespace = "codex-target-review-v1-20260912";
const batchId = `reconcile-${sourceId}-bounded-${namespace}-4`, suffix = "-reconcile-c58c444b74e5-codex-target-review-v1-20260912";
const expected: Record<string, string> = {
  "event-angier-invites-caesar-00019": "e6e062d972bf336597c56fdd94c295fe0eee6daaefe8c3262945465d13497406",
  "event-norton-nmr-scan-00017": "cff4d294f7e363130f04486db4dcf66d2d1041515d4b7d0e12631e5eab208efc",
  "event-zero-launches-torpedo-00022": "d5ab1259aadd440f7a7b6fb879485ead32c80222f64799d13271caecdeeb78e2",
  "event-norton-fuses-sampson-00021": "2e4395da9bfc9309c7ab23b800e5a5a8c6679ed75bd43f34d3505f41c94f5cf7",
};
await withWorkspaceOperationLock(root, "compiler", async () => {
  const file = new URL("state.json", import.meta.url), state = JSON.parse(await fs.readFile(file, "utf8"));
  if (state.attempt !== 7 || state.status !== "needs-review" || state.semanticRunId !== namespace) throw new Error("Incident state changed.");
  const journal = new CompilerProposalObligations(root, sourceId, batchId), store = new ProposalStore(root);
  if (journal.unresolved().length !== 4) throw new Error("Unexpected obligation inventory.");
  const pending = (await store.list("pending", sourceId));
  if (pending.length !== 4) throw new Error("Pending inventory changed.");
  const pendingHashes = Object.fromEntries(await Promise.all(pending.map(async p => [p.id, contentHash(await store.readEnvelope("pending", p.id))])));
  const findings = [];
  for (const [logicalId, hash] of Object.entries(expected)) {
    const id = logicalId + suffix, history = journal.history("propose_canonical_event", id), last = history.at(-1)!;
    if (last.status !== "failed" || last.inputHash !== hash) throw new Error(`Incident changed for ${id}`);
    const status = logicalId.startsWith("event-angier") ? "pending" : "rejected";
    const original = await store.readEnvelope(status, id);
    const payload = original.payload as Record<string, unknown>;
    if (payload.id !== logicalId || (original.generatedBy as {compilerBatchId:string}).compilerBatchId !== batchId) throw new Error("Original proposal scope mismatch.");
    const activeId = status === "pending" ? id : logicalId + "-scene-backlink" + suffix;
    const active = await store.readEnvelope("pending", activeId);
    if ((active.payload as {id:string}).id !== logicalId || (active.generatedBy as {compilerBatchId:string}).compilerBatchId !== batchId) throw new Error("Successor scope mismatch.");
    if (status === "rejected") {
      const rejection = await store.readRejection(id);
      if (!rejection?.errors.some(error => error.code === "WITHDRAWN_COMPILER_PROPOSAL")) throw new Error("Not an explicitly withdrawn successful draft.");
      const before = { ...payload }, after = { ...(active.payload as Record<string, unknown>) };
      delete before.sceneOccurrenceIds; delete after.sceneOccurrenceIds;
      if (contentHash(before) !== contentHash(after)) throw new Error("Successor changed more than the reviewed scene backlink.");
    }
    const input = last.input as {payload:Record<string,unknown>};
    // Replay only storage identity constraints using original host-injected evidence.
    // This neither certifies the attempted semantics nor stages a replacement.
    const replay = { ...original, payload: { ...input.payload, evidence: payload.evidence } };
    let diagnostic = "";
    try { await store.writePending(replay as never, canonicalEventSchema); }
    catch (error) { diagnostic = error instanceof Error ? error.message : String(error); }
    if (!diagnostic.includes("already exists")) throw new Error(`Storage collision did not reproduce: ${diagnostic}`);
    findings.push({ logicalId, proposalId: id, activeId, originalStatus: status, originalHash: contentHash(original), activeHash: contentHash(active), diagnostic, history });
  }
  const preview = await new CompilerCommitService(root).validatePendingStructure(sourceId);
  if (preview.length !== 1 || preview[0]!.id !== "event-norton-fuses-sampson-00021-scene-backlink" + suffix || preview[0]!.errors.length !== 2 || preview[0]!.errors.some(error => error.code !== "INACTIONABLE_CHARACTER_ENTRY")) throw new Error("Pending structural diagnostic changed.");
  const reason = "Failed calls attempted to mutate immutable successful drafts or revive explicitly withdrawn IDs after valid same-logical-identity scene-backlink replacements were already staged. Production storage checks reproduce the collision. These attempted mutations are invalid as lifecycle operations; retain the original failed inputs and do not retry them. Preserve all four pending drafts. No changed narrative, time, action or world semantics from these failed calls is certified. Independently reproduced current commit preview identifies only the active Norton/Sampson successor's two empty entry deltas; the model must repair that active successor against source evidence using the normal validated replacement/withdrawal workflow. No draft, checkpoint, target report or publication gate is removed.";
  const auditRef = "run-records/2026-09-11-codex-compile-loop/host-review-proposal-lifecycle.json";
  const audit = { reviewedAt: new Date().toISOString(), sourceId, batchId, reason, findings, pendingHashes, preview, tests: "Tool recovery, reconciliation, proposal tools and obligations regressions; full type check and worker/reviewer script type checks." };
  await fs.writeFile(new URL("host-review-proposal-lifecycle.json", import.meta.url), JSON.stringify(audit, null, 2));
  for (const finding of findings) journal.reviewUnsupported("propose_canonical_event", finding.proposalId, reason, auditRef);
  journal.assertFinishable();
  for (const [id, hash] of Object.entries(pendingHashes)) if (contentHash(await store.readEnvelope("pending", id)) !== hash) throw new Error("Review changed a pending draft.");
  state.appliedRepair = { repairId: "immutable-proposal-lifecycle-sop-v1", failureFingerprint: compilerFailureFingerprint(state.error), reviewPath: auditRef, appliedAt: audit.reviewedAt };
  state.lifecycleRecovery = { batchId, pending: true, auditRef };
  await fs.writeFile(new URL("state.tmp.json", import.meta.url), JSON.stringify(state, null, 2));
  await fs.rename(new URL("state.tmp.json", import.meta.url), file);
  console.log(JSON.stringify({ reviewedObligations: findings.length, preservedDrafts: pending.length, remainingStructuralRepair: preview, namespaceUnchanged: namespace }));
});

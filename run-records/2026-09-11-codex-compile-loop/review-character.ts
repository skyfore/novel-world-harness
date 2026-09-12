import fs from "node:fs/promises";
import { CompilerProposalObligations } from "../../src/compiler/proposal-obligations.js";
import { CompilerProposalService } from "../../src/compiler/proposals.js";
import { characterModelSchema } from "../../src/world/actors.js";
import { CanonicalModelStore } from "../../src/world/canonical-model.js";
import { withWorkspaceOperationLock } from "../../src/util/workspace-lock.js";
const root = process.cwd(), sourceId = "a28585b1cf867f3e3a16", batchId = `reconcile-${sourceId}-bounded-v3-2`;
const proposalId = "char-lumingfei-model-reconcile-f79769c4862c";
await withWorkspaceOperationLock(root, "compiler", async () => {
  const journal = new CompilerProposalObligations(root, sourceId, batchId);
  const failed = journal.history("propose_character_model", proposalId).filter(a => a.status === "failed");
  const expected = ["72ff8875ca7d9963107ba7f15f478a9c750eca49626676fd8dace6642ef24f67", "f7a2a4f0b6016cf088d0dca75a2bc9c54a27a6acb5653efa8f32c03213ead31d"];
  if (JSON.stringify(failed.map(a => a.inputHash)) !== JSON.stringify(expected)) throw new Error("Incident changed; fresh host review required.");
  const proposals = new CompilerProposalService(root).store;
  for (const status of ["pending", "accepted", "rejected"] as const) {
    if ((await proposals.list(status)).some(p => p.id === proposalId)) throw new Error("Proposal was staged; re-review required.");
  }
  const evidence = (await new CanonicalModelStore(root).getEntity("char-lumingfei")).evidence;
  const diagnoses = failed.map(a => {
    // Shape-only replay: use an existing evidence carrier to reproduce post-injection
    // schema constraints. This does not validate or certify the proposed semantics.
    const payload = structuredClone((a.input as {payload: Record<string, any>}).payload);
    for (const field of ["developmentPhases", "dispositions"]) {
      if (Array.isArray(payload[field])) payload[field] = payload[field].map((item: object) => ({ ...item, evidence }));
    }
    const parsed = characterModelSchema.safeParse({ ...payload, evidence });
    if (parsed.success) throw new Error("Original schema failure no longer reproduces.");
    return { inputHash: a.inputHash, issues: parsed.error.issues };
  });
  if (diagnoses.some(d => !d.issues.some(i => i.message.includes("legacy:")))) { console.log(JSON.stringify(diagnoses, null, 2)); throw new Error("Different schema defect; re-review required."); }
  const reason = "Both original inputs are unsupported as submitted: a structured character ontology was combined with unnamespaced legacy numeric modifiers. The corrected attempt moved the same new persistence key between legacy fields instead of using the structured ontology. Neither input staged a proposal. Preserve all historical failures and other pending drafts. The reconciliation prompt now names the cross-field constraint; authorize one model correction under the original proposal ID through normal evidence/schema/finish validation. No replacement character fact is host-certified.";
  await fs.writeFile(new URL("host-review.json", import.meta.url), JSON.stringify({ sourceId, batchId, proposalId, reviewedAt: new Date().toISOString(), diagnoses, reason }, null, 2));
  journal.reviewUnsupported("propose_character_model", proposalId, reason, "run-records/2026-09-11-codex-compile-loop/host-review.json");
  journal.assertModelRecoveryAllowed();
  console.log("Host review recorded; original failed history and all unrelated drafts preserved.");
});

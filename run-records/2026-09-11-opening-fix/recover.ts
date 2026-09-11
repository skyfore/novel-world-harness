import fs from "node:fs/promises";
import crypto from "node:crypto";
import { CompilerProposalObligations } from "../../src/compiler/proposal-obligations.js";
import { initialWorldInputIssues } from "../../src/compiler/initial-world-preflight.js";
import { createCompilerProposalToolset } from "../../src/compiler/proposal-tools.js";
import { CompilerProposalService } from "../../src/compiler/proposals.js";
import { InitialWorldStore } from "../../src/world/initial.js";
import { withWorkspaceOperationLock } from "../../src/util/workspace-lock.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
const root = process.cwd();
const snapshot = JSON.parse(await fs.readFile(new URL("../2026-09-11-opening-block-review/opening-obligations.json", import.meta.url), "utf8"));
const sourceId = "a28585b1cf867f3e3a16";
const batchId = "opening-batch-a28585b1cf867f3e3a16-00002-executable-684389ad80a1";
const initialId = "p-initial-opening-world";
await withWorkspaceOperationLock(root, "compiler", async () => {
  // Refuse any intervening write; this review applies only to the audited incident.
  for (const item of snapshot) {
    const hash = crypto.createHash("sha256").update(await fs.readFile(item.file)).digest("hex");
    if (hash !== item.sha256) throw new Error(`Incident ledger changed: ${item.file}`);
  }
  if (await new InitialWorldStore(root).get()) throw new Error("An initial world now exists; re-review required");
  const proposals = new CompilerProposalService(root).store;
  for (const status of ["pending", "accepted", "rejected"] as const) {
    if ((await proposals.list(status)).some(p => p.id === initialId)) throw new Error("Initial input was staged; re-review required");
  }
  const journal = new CompilerProposalObligations(root, sourceId, batchId);
  const failed = journal.history("propose_initial_world", initialId).filter(a => a.status === "failed");
  if (failed.length !== 2) throw new Error("Expected exactly the two audited failed initial inputs");
  const diagnoses = failed.map(a => ({ inputHash: a.inputHash, issues: initialWorldInputIssues(a.input as never) }));
  if (diagnoses.some(d => !d.issues.some(s => s.includes("holderEntityId")) || !d.issues.some(s => s.includes("causal-premise")))) throw new Error("The verified structural defect no longer reproduces");
  const correction = structuredClone(snapshot.find((x: any) => x.ledger.attempts[0].proposalId === "p-mention-opening-man-v2").ledger.attempts.at(-1).input);
  correction.proposal_id = "p-mention-opening-man";
  const tools = createCompilerProposalToolset(root);
  await tools.beginBatch([correction.selector.segment_id], batchId, sourceId);
  const audit = { sourceId, batchId, reviewedAt: new Date().toISOString(), diagnoses,
    decision: "The two exact initial inputs are unsupported as submitted: deterministic required context fields are absent, and neither input staged an artifact. Preserve failed history; authorize a freshly validated correction, without asserting that any replacement world is valid.",
    mentionCorrection: correction, rejectedDraftPolicy: "Retain all five rejected drafts and their history. Reuse only evidence revalidated through normal proposal and finish gates." };
  const auditFile = new URL("host-review.json", import.meta.url);
  await fs.writeFile(auditFile, JSON.stringify(audit, null, 2) + "\n");
  journal.reviewUnsupported("propose_initial_world", initialId, audit.decision, "run-records/2026-09-11-opening-fix/host-review.json");
  // Re-submit the exact source-validated selector under the original failed ID.
  const mentionTool = tools.tools.find(t => t.name === "propose_entity_mention")!;
  await mentionTool.execute("host-correct-original-mention", correction, undefined, undefined, {} as ExtensionContext);
  journal.assertFinishable();
  await fs.writeFile(new URL("recovery-result.json", import.meta.url), JSON.stringify({ unresolved: journal.unresolved(),
    initialHistory: journal.history("propose_initial_world", initialId), mentionHistory: journal.history("propose_entity_mention", correction.proposal_id) }, null, 2) + "\n");
  console.log("Audited invalid initial inputs; repaired original mention identity. All prior failures and rejected drafts retained. No world committed.");
});

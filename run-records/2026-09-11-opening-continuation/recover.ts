import fs from "node:fs/promises";
import { CompilerProposalObligations } from "../../src/compiler/proposal-obligations.js";
import { createCompilerProposalToolset } from "../../src/compiler/proposal-tools.js";
import { withWorkspaceOperationLock } from "../../src/util/workspace-lock.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
const root = process.cwd(), sourceId = "a28585b1cf867f3e3a16", batchId = "opening-batch-a28585b1cf867f3e3a16-00002-executable-684389ad80a1";
await withWorkspaceOperationLock(root, "compiler", async () => {
  const journal = new CompilerProposalObligations(root, sourceId, batchId);
  const id = "p-resolve-opening-man-fix0911";
  const history = journal.history("propose_entity_resolution", id);
  if (history.at(-1)?.status !== "failed" || history.at(-1)?.inputHash !== "85bf72103010ea759c8bbd73cb0b8b26e860b0f6c993f201bb175f4777f043fb") throw new Error("Incident changed; review required");
  const original = history.find(a => a.status === "succeeded")!;
  if (original.inputHash !== "85bf72103010ea759c8bbd73cb0b8b26e860b0f6c993f201bb175f4777f043fb") throw new Error("Original draft changed");
  const set = createCompilerProposalToolset(root, { model: "openai-codex/gpt-5.6-terra" });
  await set.beginBatch(["a28585b1cf867f3e3a16-00002-16e2c6da87f3"], batchId, sourceId);
  await fs.writeFile(new URL("host-review.json", import.meta.url), JSON.stringify({ reviewedAt: new Date().toISOString(), sourceId, batchId,
    history, decision: "Retain the original successful pending identity draft. Reject the attempted in-place rewrite; replay the exact original envelope through normal validation under the original ID. This is no final identity certification.",
    previewReview: "Reviewed all four previews and their trace results. The relief sentence is explicitly narrated and may support presentation under source-narrator-established; focal-knowledge instead requires a real seeded claim. Do not invent a claim. A health string is not a numeric health value. Re-review field types and exact evidence before submission. Authorize one fresh host-started attempt with the corrected published preview schema and stop on two preview failures." }, null, 2));
  journal.reviewUnsupported("propose_entity_resolution", id, "The changed-content replay and host replay without original model provenance cannot replace the existing successful immutable draft. Preserve that draft and all failure history; authorize its exact replay including original model provenance through normal validation.", "run-records/2026-09-11-opening-continuation/host-review.json");
  await set.tools.find(t => t.name === "propose_entity_resolution")!.execute("host-replay-existing-resolution", original.input as never, undefined, undefined, {} as ExtensionContext);
  journal.assertFinishable();
  console.log("Original pending identity draft revalidated; prior failed rewrite retained in history.");
});

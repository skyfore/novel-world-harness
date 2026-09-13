import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../../src/world/canonical.js";
import { worldStorageRoot } from "../../src/world/paths.js";
import { CanonicalModelStore } from "../../src/world/canonical-model.js";
import { WorkspaceStore } from "../../src/storage/workspace-store.js";
import { SourceMaterialStore } from "../../src/storage/source-material-store.js";
import { SourceAnnotationStore } from "../../src/compiler/annotations.js";
import { EntityResolutionStore } from "../../src/compiler/entity-resolution.js";
import { inspectCompilerStatus } from "../../src/compiler/status.js";
import { auditCompiler } from "../../src/compiler/audit.js";
import { CompilerFinishReceipts } from "../../src/compiler/finish-receipts.js";
import { assertReconciliationDeferralsReviewed } from "../../src/compiler/reconciliation-review-ledger.js";
import { writeKnowledgeRepairPlan, buildKnowledgeRepairPrompt } from "../../src/compiler/knowledge-repair.js";
import { compilerFailureFingerprint } from "../../src/runtime/codex-compile-loop.js";
import { withWorkspaceOperationLock } from "../../src/util/workspace-lock.js";
const root = process.cwd(), dir = new URL("./", import.meta.url);
await withWorkspaceOperationLock(root, "compiler", async () => {
  const state = JSON.parse(await fs.readFile(new URL("state.json", dir), "utf8"));
  if (state.attempt !== 9 || state.status !== "needs-review" || state.semanticRunId !== "codex-opening-driver-v1-20260912" || state.knowledgeRepair) throw Error("Incident changed; stop for review.");
  const status = await inspectCompilerStatus(root, state.sourceId), source = status.sources.find(s => s.sourceId === state.sourceId)!;
  if (source.sourceIntegrity !== "verified" || source.hasUnresolvedObligations || source.worldProposalInventory.pending) throw Error("Unreviewed source or proposal state.");
  const audit = await auditCompiler(root, { sourceId: state.sourceId });
  if (audit.coverage.autonomousDriverCoverage !== 1) throw Error("Prior opening repair has not succeeded.");
  const canon = new CanonicalModelStore(root), event = (await canon.listEvents()).find(e => e.id === "event-rescue-briefing-001");
  if (!event || event.observedKnowledge?.operations.length || event.observedOutcome.operations.length) throw Error("Reviewed knowledge gap changed.");
  const sourceDoc = await WorkspaceStore.openReadOnly(root).getSource(state.sourceId);
  if (!sourceDoc) throw Error("Missing original source.");
  const bytes = await new SourceMaterialStore().read(sourceDoc);
  if (!bytes) throw Error("Missing source bytes.");
  const sourceLines = bytes.toString("utf8").split("\n");
  const excerpts = sourceLines.slice(1997, 2002);
  if (!excerpts.join("\n").includes("两名执行部成员陷在一处龙族遗迹中") || !excerpts.join("\n").includes("路明非举手")) throw Error("Source evidence changed.");
  const quotation = (await new SourceAnnotationStore(root).list(state.sourceId, "quotation")).find(q => q.id === "q-schneider-001");
  if (!quotation || quotation.annotationType !== "quotation") throw Error("Missing quotation trace.");
  const quotationText = bytes.subarray(quotation.anchor.startByte, quotation.anchor.endByte).toString("utf8");
  if (quotationText !== "各位，我们需要你们的帮助，就是现在。") throw Error(`Unexpected reviewed quotation boundary: ${JSON.stringify(quotationText)}`);
  const resolutions = (await new EntityResolutionStore(root).list(state.sourceId)).filter(r => r.mentionId === quotation.speakerMentionId || quotation.addresseeMentionIds.includes(r.mentionId));
  if (!resolutions.some(r => r.mentionId === quotation.speakerMentionId && r.entityId === "char-schneider") || !resolutions.some(r => quotation.addresseeMentionIds.includes(r.mentionId) && r.entityId === "char-lumingfei")) throw Error("Reviewed speaker/addressee trace changed.");
  const catalogs = { claims: await canon.listClaims(), propositions: await canon.listPropositions(), attributions: await canon.listAttributions() };
  if (catalogs.claims.length !== 4 || catalogs.propositions.length !== 6 || catalogs.attributions.length !== 5) throw Error("Dependency inventory changed; re-review content.");
  const originalNamespace = "codex-target-review-v1-20260912";
  const predecessorBatchId = `reconcile-${state.sourceId}-bounded-${originalNamespace}-3`;
  const originals = []; let retainedDeferrals = 0;
  for (let i = 1; i <= 4; i++) {
    const batchId = `reconcile-${state.sourceId}-bounded-${originalNamespace}-${i}`;
    const receipts = new CompilerFinishReceipts(root, state.sourceId, batchId), receipt = await receipts.read();
    if (receipt?.state !== "completed") throw Error("Original scope unfinished.");
    await receipts.verify(receipt);
    retainedDeferrals += (receipt.identity.input.target_reviews ?? []).filter(r => r.disposition !== "proposed").length;
    originals.push({ batchId, fingerprint: receipt.fingerprint, reports: receipt.identity.input.target_reviews });
  }
  const predecessor = originals.find(r => r.batchId === predecessorBatchId)!;
  const originalReport = predecessor.reports?.find(r => r.target === `event:${event.id}`);
  const expectedReport = "Schneider explicitly reports that Ye Sheng and Yaji are trapped and oxygen is decreasing, but no compatible claim/proposition exists for a knowledge operation, and requesting help does not establish a represented state-field outcome.";
  if (originalReport?.disposition !== "capability-gap" || originalReport.summary !== expectedReport) throw Error("Original report changed.");
  const reviewPath = "run-records/2026-09-11-codex-compile-loop/host-review-knowledge-dependencies.json";
  const batchId = `reconcile-${state.sourceId}-knowledge-effects-${state.semanticRunId}-1`;
  const planDir = path.join(worldStorageRoot(root), "compiler", "reconciliation");
  const oldPlans = await Promise.all((await fs.readdir(planDir)).filter(f => f.endsWith(".json")).map(async file => ({ file, bytes: await fs.readFile(path.join(planDir, file), "utf8") })));
  const review = {
    reviewedAt: new Date().toISOString(), sourceId: state.sourceId, originalReport, excerpts, quotation, quotationText, resolutions,
    finding: "The original report correctly identifies absent semantic dependencies, but not a source absence: the text explicitly supplies a speech act and an addressed listener response. The old bounded prompt forbids mutation outside its event/model/initial targets while supplying no dependency-creation path. Existing typed claim/proposition/attribution tools and validators can express acquisition. The existing quotation covers ONLY the request for immediate help; it does not cover the subsequent trapped/oxygen report or name both trapped people. A model must independently justify the acquired content and status within exact trace boundaries, or report the remaining gap. Host review authorizes proposals, not semantic acceptance.",
    repair: "New immutable supplementary scope permits only observedKnowledge acquisition on this exact event plus new typed semantic dependencies transitively used by it. All original payload fields and existing dependencies are read-only. Original proposal IDs, drafts, obligations, checkpoints, plans, finish receipts and all deferral publication gates remain. No namespace rotation and no source-wide review decisions are applied.",
    batchId, unchangedSemanticRunId: state.semanticRunId, baselineEventHash: contentHash(event), dependencyCatalogs: catalogs,
    originals, retainedDeferrals, priorAppliedRepair: state.appliedRepair,
    previousFailureFingerprint: state.failureFingerprint,
    validation: "99 relevant tests and repository type checks passed; worker/review script type checks passed before application.",
  };
  await fs.writeFile(new URL("host-review-knowledge-dependencies.json", dir), JSON.stringify(review, null, 2), { flag: "wx" });
  await writeKnowledgeRepairPlan(root, { version: 1, sourceId: state.sourceId, batchId, predecessorBatchId, predecessorFingerprint: predecessor.fingerprint, reviewRef: reviewPath, events: [event] });
  const prompt = await buildKnowledgeRepairPrompt(root, state.sourceId, batchId);
  if (!prompt.includes(quotation.id) || !prompt.includes("transitively")) throw Error("Knowledge prompt missing reviewed dependencies.");
  for (const old of oldPlans) if (await fs.readFile(path.join(planDir, old.file), "utf8") !== old.bytes) throw Error("Original plan changed.");
  let gateRetained = false;
  try { await assertReconciliationDeferralsReviewed(root, state.sourceId); } catch (error) { if (String(error).includes("host source review")) gateRetained = true; else throw error; }
  if (!gateRetained) throw Error("Original publication gate unexpectedly cleared.");
  const repeatDiagnostic = `Knowledge acquisition remains unresolved for ${event.id}; predecessor=${predecessor.fingerprint}. Host source review required; do not retry unchanged.`;
  state.appliedRepair = { repairId: "scoped-knowledge-dependencies-v1", failureFingerprint: compilerFailureFingerprint(repeatDiagnostic), reviewPath, appliedAt: review.reviewedAt,
    fingerprintBasis: "Exact source-reviewed event knowledge gap and original receipt; not aggregate coverage", previousFailureFingerprint: state.failureFingerprint };
  state.knowledgeRepair = { batchId, pending: true, reviewPath };
  await fs.writeFile(new URL("audit-before-knowledge-dependencies.json", dir), JSON.stringify(audit, null, 2));
  await fs.writeFile(new URL("state.tmp.json", dir), JSON.stringify(state, null, 2));
  await fs.rename(new URL("state.tmp.json", dir), new URL("state.json", dir));
  console.log(JSON.stringify({ ready: true, batchId, retainedDeferrals, namespaceUnchanged: true, gateRetained }));
});

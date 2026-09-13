import fs from "node:fs/promises";
import { WorkspaceStore } from "../../src/storage/workspace-store.js";
import { SourceMaterialStore } from "../../src/storage/source-material-store.js";
import { SourceAnnotationStore, quotationSchema } from "../../src/compiler/annotations.js";
import { SegmentStore } from "../../src/compiler/segments.js";
import { EvidenceVerifier } from "../../src/compiler/evidence.js";
import { EvidenceAssertionStore } from "../../src/compiler/evidence-assertions.js";
import { CanonicalModelStore } from "../../src/world/canonical-model.js";
import { contentHash } from "../../src/world/canonical.js";
import { inspectCompilerStatus } from "../../src/compiler/status.js";
import { auditCompiler } from "../../src/compiler/audit.js";
import { CompilerFinishReceipts } from "../../src/compiler/finish-receipts.js";
import { createCompilerProposalToolset } from "../../src/compiler/proposal-tools.js";
import { validateCommittedAttributionTrace } from "../../src/compiler/attribution-trace.js";
import { assertReconciliationDeferralsReviewed } from "../../src/compiler/reconciliation-review-ledger.js";
import { compilerFailureFingerprint } from "../../src/runtime/codex-compile-loop.js";
import { withWorkspaceOperationLock } from "../../src/util/workspace-lock.js";

const root = process.cwd(), dir = new URL("./", import.meta.url);
await withWorkspaceOperationLock(root, "compiler", async () => {
  const state = JSON.parse(await fs.readFile(new URL("state.json", dir), "utf8"));
  if (state.attempt !== 10 || state.status !== "needs-review" || state.traceRepair) throw Error("Incident changed; stop for review.");
  const status = await inspectCompilerStatus(root, state.sourceId), source = status.sources.find(s => s.sourceId === state.sourceId)!;
  if (source.sourceIntegrity !== "verified" || source.hasUnresolvedObligations || source.worldProposalInventory.pending) throw Error("Source or obligations need review.");
  const sourceDoc = await WorkspaceStore.openReadOnly(root).getSource(state.sourceId);
  if (!sourceDoc) throw Error("Missing immutable source.");
  const bytes = await new SourceMaterialStore().read(sourceDoc);
  if (!bytes) throw Error("Missing source bytes.");
  const store = new SourceAnnotationStore(root), canon = new CanonicalModelStore(root);
  const attributions = await canon.listAttributions();
  const semanticBefore = { events: await canon.listEvents(), claims: await canon.listClaims(), propositions: await canon.listPropositions(), attributions };
  const annotationBefore = await store.list(state.sourceId);
  const segments = await new SegmentStore(root).list(state.sourceId);
  const definitions = [
    { quotationId: "q-schneider-001", attributionId: "attr-schneider-rescue-members-trapped-001", line: 1999, prefix: "各位，我们需要你们的帮助，就是现在。", suffix: "我们必须为他们尽快找到出路。", proposalId: "q-schneider-full-utterance-host-v1" },
    { quotationId: "quote-eva-plan", attributionId: "attr-eva-guigu-00008", line: 1530, prefix: "执行部增派了四个小组，分别向西藏、新疆、格陵兰和墨西哥", suffix: "校长亲自制定。", proposalId: "quote-eva-full-utterance-host-v1" },
  ];
  const reviews = [];
  for (const definition of definitions) {
    const quotation = quotationSchema.parse(await store.read(state.sourceId, definition.quotationId));
    const verification = await new EvidenceVerifier(root).inspectAnchor(quotation.anchor);
    if (verification.excerpt !== definition.prefix) throw Error("Original quotation anchor changed.");
    const line = bytes.toString("utf8").split("\n")[definition.line - 1]!;
    const match = /“([^”]+)”/u.exec(line);
    if (!match || !match[1]!.startsWith(definition.prefix) || !match[1]!.endsWith(definition.suffix)) throw Error("Contiguous same-speaker source utterance changed.");
    const exact = match[1]!;
    const segment = segments.find(s => s.startLine <= definition.line && s.endLine >= definition.line);
    if (!segment) throw Error("Missing exact source segment.");
    const attribution = attributions.find(a => a.id === definition.attributionId);
    if (!attribution) throw Error("Missing original attribution.");
    const issues = await validateCommittedAttributionTrace(root, state.sourceId, attribution);
    if (issues.length !== 1 || !issues[0]!.includes("object evidence is outside")) throw Error("Unexpected trace diagnosis.");
    const assertions = await new EvidenceAssertionStore(root).listForArtifact("proposition", attribution.propositionId);
    const originalProposals = [];
    for (const proposal of await store.listProposals(state.sourceId, "accepted")) {
      if (proposal.annotationId !== quotation.id) continue;
      originalProposals.push(await store.readProposal(state.sourceId, "accepted", proposal.id));
    }
    if (!originalProposals.length) throw Error("Missing original quotation proposal history.");
    reviews.push({ ...definition, quotation, exact, segmentId: segment.id, attribution, assertions, issues, originalProposals,
      reason: "Host read the original immutable source line and confirmed one continuous utterance by the same speaker. The original annotation retained only its prefix. Extend that same logical quotation to the complete utterance, retaining speaker/addressees/scene/confidence. This covers the existing exact proposition-content assertion without changing its content, removing evidence, inventing a speaker, or modifying world effects." });
  }
  const originalReceipts = [];
  for (const batch of [state.knowledgeRepair.batchId, ...[1, 2, 3, 4].map(i => `reconcile-${state.sourceId}-bounded-codex-target-review-v1-20260912-${i}`)]) {
    const receipts = new CompilerFinishReceipts(root, state.sourceId, batch), receipt = await receipts.read();
    if (receipt?.state !== "completed") throw Error("Original finish incomplete.");
    await receipts.verify(receipt); originalReceipts.push({ batch, fingerprint: receipt.fingerprint, input: receipt.identity.input });
  }
  const batchId = `host-quotation-content-${state.sourceId}-v1`, reviewPath = "run-records/2026-09-11-codex-compile-loop/host-review-quotation-content.json";
  const record = { reviewedAt: new Date().toISOString(), sourceId: state.sourceId, batchId, reviews, originalReceipts,
    previousAppliedRepair: state.appliedRepair, previousFailureFingerprint: state.failureFingerprint,
    validation: "Quotation content regression and existing proposal/audit/finish recovery tests passed; repository and worker/review type checks passed before application.",
    status: "reviewed-before-proposals", semanticHashBefore: contentHash(semanticBefore), namespace: state.semanticRunId };
  await fs.writeFile(new URL("host-review-quotation-content.json", dir), JSON.stringify(record, null, 2), { flag: "wx" });
  const toolset = createCompilerProposalToolset(root); await toolset.beginBatch([], batchId, state.sourceId);
  const call = (name: string, input: unknown) => toolset.tools.find(t => t.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
  for (const review of reviews) {
    const q = review.quotation;
    await call("propose_quotation", { proposal_id: review.proposalId, annotation_id: q.id, selector: { segment_id: review.segmentId, exact: review.exact }, mode: q.mode,
      speaker_mention_id: q.speakerMentionId, addressee_mention_ids: q.addresseeMentionIds, scene_id: q.sceneId, attribution_confidence: q.attributionConfidence });
  }
  await call("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Host reviewed two original same-speaker source utterances and corrected truncated quotation boundaries. Preserve all semantic payloads, original accepted proposal history, obligations, checkpoints and deferral publication gates." });
  const receipts = new CompilerFinishReceipts(root, state.sourceId, batchId), receipt = await receipts.read();
  if (receipt?.state !== "completed") throw Error("Correction finish did not complete.");
  await receipts.verify(receipt);
  for (const review of reviews) {
    if ((await validateCommittedAttributionTrace(root, state.sourceId, review.attribution)).length) throw Error("Reviewed trace remains invalid.");
    for (const original of review.originalProposals) if (contentHash(await store.readProposal(state.sourceId, "accepted", original.id)) !== contentHash(original)) throw Error("Original proposal changed.");
  }
  const semanticAfter = { events: await canon.listEvents(), claims: await canon.listClaims(), propositions: await canon.listPropositions(), attributions: await canon.listAttributions() };
  if (contentHash(semanticBefore) !== contentHash(semanticAfter)) throw Error("Semantic payload changed during quotation repair.");
  for (const annotation of annotationBefore.filter(a => !definitions.some(d => d.quotationId === a.id))) if (contentHash(await store.read(state.sourceId, annotation.id)) !== contentHash(annotation)) throw Error("Unrelated annotation changed.");
  let gateRetained = false;
  try { await assertReconciliationDeferralsReviewed(root, state.sourceId); } catch (error) { if (String(error).includes("host source review")) gateRetained = true; else throw error; }
  if (!gateRetained) throw Error("Original deferral gate disappeared.");
  const audit = await auditCompiler(root, { sourceId: state.sourceId });
  await fs.writeFile(new URL("audit-after-quotation-content.json", dir), JSON.stringify(audit, null, 2));
  const failureDiagnostic = `Reviewed quotation content trace failed again: ${definitions.map(d => d.attributionId).sort().join(",")}. Preserve originals and stop for host review.`;
  state.appliedRepair = { repairId: "quotation-object-anchor-containment-v1", failureFingerprint: compilerFailureFingerprint(failureDiagnostic), reviewPath, appliedAt: new Date().toISOString(), fingerprintBasis: "The exact two original source-reviewed quotation-content mismatches, not overall coverage" };
  state.traceRepair = { attributionIds: definitions.map(d => d.attributionId), failureDiagnostic, reviewPath, batchId, receiptFingerprint: receipt.fingerprint };
  await fs.writeFile(new URL("host-review-quotation-content-result.json", dir), JSON.stringify({ reviewedAt: new Date().toISOString(), receiptFingerprint: receipt.fingerprint, semanticPayloadsUnchanged: true, originalProposalsPreserved: true, gateRetained, namespaceUnchanged: state.semanticRunId === record.namespace }, null, 2));
  await fs.writeFile(new URL("state.tmp.json", dir), JSON.stringify(state, null, 2)); await fs.rename(new URL("state.tmp.json", dir), new URL("state.json", dir));
  console.log(JSON.stringify({ ready: true, corrected: definitions.map(d => d.quotationId), gateRetained, originalSemanticPayloadsUnchanged: true }));
});

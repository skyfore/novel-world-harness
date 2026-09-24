import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { SourceMaterialStore } from "../storage/source-material-store.js";
import { TraceStore } from "../trace/store.js";
import { contentHash } from "../world/canonical.js";
import { ProposalStore } from "../world/canonical-model.js";
import { evidenceAssertionSchema, idSchema, type TextAnchor } from "../world/model.js";
import { withWorkspaceOperationLock } from "../util/workspace-lock.js";
import { CompilerAccountingPages, type AccountingPage } from "./accounting-pages.js";
import { accountingCoverageProofSchema, accountingCoverageProofFailure, type AccountingCoverageProof } from "./accounting-coverage-proof.js";
import { CompilerProposalObligations, type ProposalAttempt } from "./proposal-obligations.js";
import { SourceAnnotationStore, annotationAnchors } from "./annotations.js";
import { SourceAccountingStore, sourceUnitReviewRange } from "./source-accounting.js";
import { baseStructuralUnits, SourceStructureStore } from "./structure.js";
import { SegmentStore, type SourceSegment } from "./segments.js";
import { textAnchorForByteRange } from "./text-anchors.js";
import { COMPILER_MAX_SEGMENTS_PER_BATCH } from "./limits.js";

export type AccountingReviewOptions = {
  sourceId: string; batchId: string; proposalId: string; reason: string; auditRef: string;
  /** Legacy page tokens require an exact, hash-verified discovery/call/result trace chain. */
  fromRun?: string;
};

/** Read-only by default. --apply uses the same proof builder under the compiler lock. */
export async function reviewAccountingObligation(root: string, options: AccountingReviewOptions, apply = false): Promise<AccountingCoverageProof> {
  if (apply) return withWorkspaceOperationLock(root, "compiler", async () => {
    const { proof, recoveredPages } = await buildAccountingCoverageProof(root, options);
    const pages = new CompilerAccountingPages(root, options.sourceId, options.batchId);
    for (const page of recoveredPages) pages.restoreFromAudit(page);
    new CompilerProposalObligations(root, options.sourceId, options.batchId).recordCoverageSettlement(proof, options.reason, options.auditRef);
    return proof;
  });
  return (await buildAccountingCoverageProof(root, options)).proof;
}

async function buildAccountingCoverageProof(root: string, options: AccountingReviewOptions): Promise<{ proof: AccountingCoverageProof; recoveredPages: AccountingPage[] }> {
  const { sourceId, batchId, proposalId } = options;
  [sourceId, batchId, proposalId].forEach((id) => idSchema.parse(id));
  if (!options.reason.trim() || !options.auditRef.trim()) throw new Error("Host accounting review requires a reason and audit reference.");
  const journal = new CompilerProposalObligations(root, sourceId, batchId);
  const history = journal.history("account_source_units", proposalId);
  const previous = history.at(-1);
  if (previous?.status === "superseded-by-coverage" && previous.coverageProof && !accountingCoverageProofFailure(root, previous.coverageProof)) {
    if (previous.hostReview?.reason !== options.reason || previous.hostReview.auditRef !== options.auditRef) throw new Error("This accounting obligation already has a valid host coverage review; retain its original review identity.");
    return { proof: previous.coverageProof, recoveredPages: [] };
  }
  const unresolved = journal.unresolved().find((item) => item.tool === "account_source_units" && item.proposalId === proposalId);
  if (!unresolved || unresolved.status === "running") throw new Error("No failed accounting obligation in this exact scope; interrupted calls require separate host inspection.");
  const lastResolution = history.findLastIndex((item) => item.status === "succeeded" || item.status === "unsupported");
  const failed = [...new Map(history.slice(lastResolution + 1).filter((item) => item.status === "failed").map((item) => [item.inputHash, item])).values()];
  const source = await WorkspaceStore.openReadOnly(root).getSource(sourceId);
  if (!source) throw new Error(`Unknown source ${sourceId}; inspect registered sources before host review.`);
  const bytes = await new SourceMaterialStore().read(source);
  if (!bytes) throw new Error("Archived source bytes are missing; host review cannot migrate or reconstruct them.");
  const structure = await new SourceStructureStore(root).read(sourceId);
  if (!structure || structure.sourceSha256 !== source.contentSha256) throw new Error("Missing or incompatible source structure; host repair is required.");
  const segments = await readAccountingBatchSegments(root, sourceId, batchId);
  const byId = new Map(baseStructuralUnits(structure).map((unit) => [unit.id, unit]));
  const originalIds = new Set<string>();
  const originalPageTokens = new Set<string>();
  const auditRefs = new Set([options.auditRef]);
  const recoveredPages: AccountingPage[] = [];
  for (const attempt of failed) {
    const input = z.record(z.string(), z.unknown()).parse(attempt.input);
    if (typeof input.page_token === "string") {
      if (Array.isArray(input.decisions) && input.decisions.length) throw new Error("Ambiguous failed accounting input mixes page and decision modes; host review cannot guess its scope.");
      const page = new CompilerAccountingPages(root, sourceId, batchId).read(input.page_token);
      if (page) {
        if (page.sourceSha256 !== source.contentSha256 || page.segmentIds.some((id) => !segments.some((segment) => segment.id === id))) throw new Error("Original accounting page source/batch changed.");
        page.unitIds.forEach((id) => originalIds.add(id));
      } else {
        if (!options.fromRun) throw new Error(`Page ${input.page_token} has no durable receipt; supply --from-run with the exact original audit run. Do not guess unit IDs.`);
        const audited = await readAuditedPage(root, options.fromRun, sourceId, batchId, attempt);
        for (const unit of audited.units) {
          const current = byId.get(unit.unitId);
          if (!current || unit.bytes[0] !== current.anchor.startByte || unit.bytes[1] !== current.anchor.endByte
            || unit.text !== bytes.subarray(current.anchor.startByte, current.anchor.endByte).toString("utf8")) {
            throw new Error(`Audited unit ${unit.unitId} does not match immutable source structure.`);
          }
          originalIds.add(unit.unitId);
        }
        auditRefs.add(audited.auditRef);
        recoveredPages.push({ version: 1, sourceId, sourceSha256: source.contentSha256, compilerBatchId: batchId,
          segmentIds: segments.map((segment) => segment.id), token: input.page_token, unitIds: audited.units.map((unit) => unit.unitId),
          issuedAt: audited.issuedAt, auditRef: audited.auditRef });
      }
      originalPageTokens.add(input.page_token);
    } else if (Array.isArray(input.decisions)) {
      // An empty-array preflight failure contributes its failed hash but no
      // invented work. Every nonempty original input must still be accounted.
      for (const decision of input.decisions) originalIds.add(z.object({ unit_id: idSchema }).passthrough().parse(decision).unit_id);
    } else throw new Error("A failed accounting input has no recoverable unit identity; explicit host inspection is required.");
  }
  if (!originalIds.size) throw new Error("No original source units can be proven; an empty input is not a coverage proof.");
  const requested = [...originalIds].map((id) => {
    const unit = byId.get(id);
    if (!unit || unit.kind === "non-scene") throw new Error(`Original source unit ${id} is missing or not model-accountable.`);
    const range = sourceUnitReviewRange(bytes, unit);
    if (!rangeCovered(range, segments)) throw new Error(`Original source unit ${id} is outside this batch.`);
    return unit;
  });
  const coverage = new Map<string, AccountingCoverageProof["units"][number]>();
  const activeFailures = new Set(journal.unresolved().map((item) => item.proposalId));
  const addAnchors = (anchors: TextAnchor[], dependency: AccountingCoverageProof["units"][number]["dependency"], kind: "evidence" | "annotation", coverageId: string) => {
    for (const anchor of anchors) {
      if (anchor.sourceId !== sourceId || !rangeCovered(anchor, segments)
        || !isDeepStrictEqual(anchor, textAnchorForByteRange(sourceId, bytes, anchor.startByte, anchor.endByte))) {
        throw new Error(`Coverage ${coverageId} has an invalid or out-of-scope exact anchor.`);
      }
      for (const unit of requested) {
        if (!coverage.has(unit.id) && unit.anchor.startByte < anchor.endByte && anchor.startByte < unit.anchor.endByte) {
          coverage.set(unit.id, { unitId: unit.id, unitHash: contentHash(unit), dependency, kind, coverageId });
        }
      }
    }
  };
  const world = new ProposalStore(root);
  for (const summary of await world.list("pending", sourceId)) {
    if (activeFailures.has(summary.id)) continue;
    const envelope = await world.readEnvelope("pending", summary.id);
    const origin = envelope.generatedBy as { compilerBatchId?: string } | undefined;
    if (origin?.compilerBatchId !== batchId) continue;
    const dependency = { store: "world" as const, proposalId: summary.id, contentHash: contentHash(envelope) };
    for (const assertion of evidenceAssertionSchema.array().parse(envelope.evidenceAssertions ?? [])) addAnchors(assertion.anchors, dependency, "evidence", assertion.id);
  }
  const annotations = new SourceAnnotationStore(root);
  for (const summary of await annotations.listBatchProposals(sourceId, batchId)) {
    if (activeFailures.has(summary.id)) continue;
    const proposal = await annotations.readProposal(sourceId, "pending", summary.id).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return annotations.readProposal(sourceId, "accepted", summary.id);
    });
    addAnchors(annotationAnchors(proposal.payload), { store: "annotation", proposalId: summary.id, contentHash: contentHash(proposal) }, "annotation", proposal.payload.id);
  }
  const accounting = new SourceAccountingStore(root);
  for (const summary of await accounting.listBatchProposals(sourceId, batchId)) {
    if (activeFailures.has(summary.id)) continue;
    const proposal = await accounting.readProposal(sourceId, summary.status, summary.id);
    for (const decision of proposal.decisions) {
      if (!originalIds.has(decision.unitId) || coverage.has(decision.unitId)
        || decision.status === "unresolved" || decision.status === "intentionally-deferred") continue;
      coverage.set(decision.unitId, { unitId: decision.unitId, unitHash: contentHash(byId.get(decision.unitId)),
        dependency: { store: "accounting", proposalId: proposal.id, contentHash: contentHash(proposal) }, kind: "decision", coverageId: decision.unitId });
    }
  }
  const missing = requested.filter((unit) => !coverage.has(unit.id));
  if (missing.length) throw new Error(`Host coverage review incomplete: ${missing.map((unit) => unit.id).join(", ")} lack valid current-batch coverage. Unrelated successful proposals cannot settle them.`);
  const proof = accountingCoverageProofSchema.parse({ version: 1, sourceId, sourceSha256: source.contentSha256, batchId, proposalId,
    failedInputHashes: failed.map((item) => item.inputHash).sort(), units: requested.map((unit) => coverage.get(unit.id)),
    originalPageTokens: [...originalPageTokens], auditRefs: [...auditRefs], verifiedAt: new Date().toISOString() });
  const failure = accountingCoverageProofFailure(root, proof);
  if (failure) throw new Error(`Host coverage review failed: ${failure}`);
  return { proof, recoveredPages };
}

/** Match the stored hash of ordered host-issued segments; never infer scope from a guessed ID. */
export async function readAccountingBatchSegments(root: string, sourceId: string, batchId: string): Promise<SourceSegment[]> {
  const prefix = `batch-${sourceId}-`;
  const suffix = batchId.startsWith(prefix) ? batchId.slice(prefix.length).match(/^\d{5}-executable-([a-f0-9]{12})$/)?.[1] : undefined;
  if (!suffix) throw new Error("Host accounting review requires an ordinary executable batch ID.");
  const manifest = await new SegmentStore(root).readManifest(sourceId);
  if (!manifest) throw new Error("Missing source segment manifest; host repair is required.");
  for (let start = 0; start < manifest.segments.length; start++) {
    for (let end = start + 1; end <= Math.min(start + COMPILER_MAX_SEGMENTS_PER_BATCH, manifest.segments.length); end++) {
      const segments = manifest.segments.slice(start, end);
      const digest = crypto.createHash("sha256").update(segments.map((segment) => segment.id).join("\n")).digest("hex").slice(0, 12);
      if (digest === suffix) return segments;
    }
  }
  throw new Error("No current segment group matches the exact batch scope hash; host repair is required.");
}

function rangeCovered(range: { startByte: number; endByte: number }, segments: readonly SourceSegment[]) {
  let cursor = range.startByte;
  for (const segment of [...segments].sort((a, b) => a.startByte - b.startByte)) {
    if (segment.endByte <= cursor) continue;
    if (segment.startByte > cursor) return false;
    cursor = Math.max(cursor, segment.endByte);
    if (cursor >= range.endByte) return true;
  }
  return false;
}

const auditedPageSchema = z.object({ type: z.literal("source-accounting-units"), sourceId: idSchema, compilerBatchId: idSchema,
  pageToken: z.string(), units: z.array(z.object({ unitId: idSchema, status: z.literal("unresolved"),
    bytes: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]), text: z.string() }).passthrough()).min(1).max(512) }).passthrough();
async function readAuditedPage(root: string, runId: string, sourceId: string, batchId: string, attempt: ProposalAttempt) {
  const traces = new TraceStore(root);
  const run = await traces.peekRun(runId);
  if (run.sourceId !== sourceId) throw new Error("Audit run belongs to another source.");
  const events = await traces.peekEvents(runId);
  for (const call of events.filter((event) => event.type === "tool.call.started" && event.data?.toolName === "account_source_units" && event.blobRef)) {
    const input = await traces.peekBlob(call.blobRef!);
    if (contentHash(input) !== contentHash(attempt.input)) continue;
    if (!events.some((event) => event.seq > call.seq && event.type === "tool.call.failed" && event.toolCallId === call.toolCallId && event.parentSpanId === call.parentSpanId)) continue;
    for (const discovery of events.filter((event) => event.seq < call.seq && event.parentSpanId === call.parentSpanId
      && event.type === "tool.call.completed" && event.data?.toolName === "find_source_accounting_units" && event.data.isError === false && event.blobRef).reverse()) {
      const result = z.object({ content: z.array(z.unknown()) }).passthrough().parse(await traces.peekBlob(discovery.blobRef!));
      for (const item of result.content) {
        const text = z.object({ type: z.literal("text"), text: z.string() }).safeParse(item);
        if (!text.success) continue;
        let raw: unknown; try { raw = JSON.parse(text.data.text); } catch { continue; }
        const page = auditedPageSchema.safeParse(raw);
        if (page.success && page.data.sourceId === sourceId && page.data.compilerBatchId === batchId
          && page.data.pageToken === (attempt.input as { page_token?: string }).page_token) {
          return { ...page.data, issuedAt: discovery.observedAt, auditRef: `${runId}:discovery=${discovery.seq}:failed-call=${call.seq}:blob=${discovery.blobRef!.sha256}` };
        }
      }
    }
  }
  throw new Error("No verified same-session discovery -> exact failed input -> failed result audit chain for this page token.");
}

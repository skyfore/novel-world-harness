import { toolDiagnosticContextSchema, type ToolDiagnosticContext } from "../agent/tool-diagnostic.js";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { worldStorageRoot } from "../world/paths.js";
import { accountingCoverageProofSchema, accountingCoverageProofFailure, type AccountingCoverageProof } from "./accounting-coverage-proof.js";
import { CompilerAccountingPages } from "./accounting-pages.js";
import { contentHash } from "../world/canonical.js";
import { idSchema } from "../world/model.js";
import { modelTextSelectorSchema, type ModelTextSelector } from "./text-anchors.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const sourcePatternProposalToolSchema = z.enum([
  "propose_action_schema",
  "propose_action_constraint",
  "propose_norm_template",
  "propose_process_template",
]);
export const sourcePatternUpstreamAuthoritySchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  batchId: idSchema,
  tool: sourcePatternProposalToolSchema,
  proposalId: idSchema,
  attemptCount: z.number().int().positive(),
  historyHash: sha256Schema,
  failedInputHashes: z.array(sha256Schema).min(2).refine(values => new Set(values).size === values.length, "Duplicate failed input hash"),
  originalInputHash: sha256Schema,
  originalSupportingEventIds: z.array(idSchema).min(1).refine(values => new Set(values).size === values.length, "Duplicate original supporting event"),
  originalEvidenceSegmentIds: z.array(idSchema).min(1).refine(values => new Set(values).size === values.length, "Duplicate original evidence segment"),
}).strict();
export type SourcePatternUpstreamAuthority = z.infer<typeof sourcePatternUpstreamAuthoritySchema>;
export function sourcePatternObligationRequirementId(authorityInput: Pick<SourcePatternUpstreamAuthority, "sourceId" | "batchId" | "tool" | "proposalId">): string {
  const authority = sourcePatternUpstreamAuthoritySchema.pick({ sourceId: true, batchId: true, tool: true, proposalId: true }).parse({
    sourceId: authorityInput.sourceId,
    batchId: authorityInput.batchId,
    tool: authorityInput.tool,
    proposalId: authorityInput.proposalId,
  });
  return `compiler-proposal-obligation-${contentHash(authority).slice(0, 32)}`;
}
export function sourcePatternObligationRequirementSetHash(authorityInput: SourcePatternUpstreamAuthority): string {
  return contentHash(sourcePatternUpstreamAuthoritySchema.parse(authorityInput));
}
export const sourcePatternDependencyCorrectionSchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  batchId: idSchema,
  tool: sourcePatternProposalToolSchema,
  proposalId: idSchema,
  inputHash: sha256Schema,
  failedInputHashes: z.array(sha256Schema).min(2),
  upstreamPlanHash: sha256Schema,
  upstreamAuthorizationRef: z.string().trim().min(1),
  receiptFingerprint: sha256Schema,
  convergenceRef: sha256Schema,
  originalSupportingEventIds: z.array(idSchema).min(1),
  correctedSupportingEventIds: z.array(idSchema).min(1),
  addedDependencies: z.array(z.object({
    kind: z.literal("canonical-event"),
    id: idSchema,
    revisionHash: sha256Schema,
  }).strict()).min(1),
}).strict();
export type SourcePatternDependencyCorrection = z.infer<typeof sourcePatternDependencyCorrectionSchema>;
export const accountingRefinementCorrectionSchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  batchId: idSchema,
  proposalId: idSchema,
  inputHash: sha256Schema,
  failedInputHashes: z.array(sha256Schema).min(2)
    .refine(values => new Set(values).size === values.length, "Duplicate failed accounting input hash"),
  historyHash: sha256Schema,
  authorityHash: sha256Schema,
  sourceSha256: sha256Schema,
  structureHash: sha256Schema,
  batchSegmentIds: z.array(idSchema).min(1),
  activeAccountingGraphHash: sha256Schema,
  semanticBaselineHash: sha256Schema,
  batchProgressHash: sha256Schema,
  pageReceipts: z.array(z.object({ token: z.string().regex(/^acctpg-[a-f0-9]{16}$/), hash: sha256Schema }).strict()).min(2),
  unitIds: z.array(idSchema).min(1).max(512),
  predecessorDecisions: z.array(z.object({
    unitId: idSchema,
    proposalId: idSchema,
    proposalHash: sha256Schema,
    status: z.enum(["unresolved", "intentionally-deferred"]),
  }).strict()).min(1),
  proposalIdentityHash: sha256Schema,
  settlementObligations: z.array(z.object({
    proposalId: idSchema,
    historyHash: sha256Schema,
    unitIds: z.array(idSchema).min(1)
      .refine(values => new Set(values).size === values.length, "Duplicate settlement unit ID"),
  }).strict()).refine(values => new Set(values.map(value => value.proposalId)).size === values.length,
    "Duplicate accounting settlement proposal ID"),
  duplicateSupportDependencies: z.array(z.object({
    proposalId: idSchema,
    proposalHash: sha256Schema,
    artifactKind: idSchema,
    artifactId: idSchema,
    artifactRevisionHash: sha256Schema,
    unitIds: z.array(idSchema).min(1)
      .refine(values => new Set(values).size === values.length, "Duplicate supported unit ID"),
    evidenceAssertionIds: z.array(idSchema).min(1)
      .refine(values => new Set(values).size === values.length, "Duplicate support evidence assertion ID"),
  }).strict()).refine(values => new Set(values.map(value => value.proposalId)).size === values.length,
    "Duplicate semantic support proposal ID"),
}).strict();
export type AccountingRefinementCorrection = z.infer<typeof accountingRefinementCorrectionSchema>;
export const sourceAnnotationProposalToolSchema = z.enum([
  "propose_entity_mention",
  "propose_event_mention",
  "propose_quotation",
  "propose_discourse_segment",
]);
const annotationSelectorBindingSchema = z.object({
  path: z.string().regex(/^\/(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])*)*$/),
  segmentId: idSchema,
  exactHash: sha256Schema,
  selectorHash: sha256Schema,
}).strict();
export const annotationSelectorCorrectionSchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  batchId: idSchema,
  tool: sourceAnnotationProposalToolSchema,
  proposalId: idSchema,
  inputHash: sha256Schema,
  failedInputHashes: z.array(sha256Schema).min(2)
    .refine(values => new Set(values).size === values.length, "Duplicate failed annotation input hash"),
  historyHash: sha256Schema,
  selectorBindings: z.array(annotationSelectorBindingSchema).min(1)
    .refine(values => new Set(values.map(value => value.path)).size === values.length,
      "Duplicate annotation selector path"),
}).strict();
export type AnnotationSelectorCorrection = z.infer<typeof annotationSelectorCorrectionSchema>;
export const roleRosterCorrectionSchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  batchId: idSchema,
  tool: z.literal("propose_role_roster_review"),
  proposalId: z.literal("role-roster-review"),
  inputHash: sha256Schema,
  failedInputHashes: z.array(sha256Schema).min(2)
    .refine(values => new Set(values).size === values.length, "Duplicate failed role-review input hash"),
  historyHash: sha256Schema,
  sourceSha256: sha256Schema,
  rosterHash: sha256Schema,
  subjectHash: sha256Schema,
  reviewRevisionId: idSchema.nullable(),
  sourcePageCount: z.number().int().positive(),
  sourcePagesHash: sha256Schema,
  rosterPageCount: z.number().int().positive(),
  rosterPagesHash: sha256Schema,
  candidateCount: z.number().int().positive(),
  reviewHash: sha256Schema,
  finishInputHash: sha256Schema,
}).strict();
export type RoleRosterCorrection = z.infer<typeof roleRosterCorrectionSchema>;
const hostReviewSchema = z.object({
  reason: z.string().min(1),
  auditRef: z.string().min(1),
  sourcePatternDependencyCorrection: sourcePatternDependencyCorrectionSchema.optional(),
  accountingRefinementCorrection: accountingRefinementCorrectionSchema.optional(),
  annotationSelectorCorrection: annotationSelectorCorrectionSchema.optional(),
  roleRosterCorrection: roleRosterCorrectionSchema.optional(),
}).strict();
const attemptSchema = z.object({
  tool: z.string(), proposalId: z.string(), inputHash: z.string(), input: z.unknown(),
  status: z.enum(["running", "failed", "succeeded", "unsupported", "superseded-by-coverage"]),
  diagnostic: z.string(), updatedAt: z.string(),
  diagnosticContext: toolDiagnosticContextSchema.optional(),
  hostReview: hostReviewSchema.optional(),
  coverageProof: accountingCoverageProofSchema.optional(),
}).strict();
const ledgerSchema = z.object({
  version: z.literal(1), sourceId: z.string(), batchId: z.string(),
  attempts: z.array(attemptSchema),
}).strict();
const sourcePatternCorrectionInputSchema = z.object({
  proposal_id: idSchema,
  payload: z.object({
    id: idSchema,
    induction: z.object({
      kind: z.literal("source-pattern"),
      supportingEventIds: z.array(idSchema).min(1).max(64),
    }).strict(),
  }).passthrough(),
  evidence_segment_ids: z.array(idSchema).min(1).max(16),
}).passthrough();
export type ProposalAttempt = z.infer<typeof attemptSchema>;

export type SourceAnnotationSelectorEntry = {
  path: string;
  selector: ModelTextSelector;
};

export function sourceAnnotationInputSelectors(
  toolInput: string,
  input: unknown,
): SourceAnnotationSelectorEntry[] {
  const tool = sourceAnnotationProposalToolSchema.parse(toolInput);
  const record = z.record(z.string(), z.unknown()).parse(input);
  const selector = (value: unknown, path: string): SourceAnnotationSelectorEntry => ({
    path,
    selector: modelTextSelectorSchema.parse(value),
  });
  const selectors = (value: unknown, path: string): SourceAnnotationSelectorEntry[] => {
    if (!Array.isArray(value) || !value.length) throw new Error(`${path} must contain at least one source selector.`);
    return value.map((item, index) => selector(item, `${path}/${index}`));
  };
  if (tool === "propose_entity_mention") return [selector(record.selector, "/selector")];
  if (tool === "propose_event_mention") {
    return [
      selector(record.trigger_selector, "/trigger_selector"),
      ...selectors(record.extent_selectors, "/extent_selectors"),
    ];
  }
  if (tool === "propose_quotation") {
    return [
      selector(record.selector, "/selector"),
      ...(record.cue_selector === undefined ? [] : [selector(record.cue_selector, "/cue_selector")]),
    ];
  }
  return selectors(record.selectors, "/selectors");
}

function annotationSelectorProjection(tool: z.infer<typeof sourceAnnotationProposalToolSchema>, input: unknown) {
  const record = structuredClone(z.record(z.string(), z.unknown()).parse(input));
  const placeholder = (selector: ModelTextSelector) => ({ segment_id: selector.segment_id });
  const entries = sourceAnnotationInputSelectors(tool, record);
  if (tool === "propose_entity_mention") record.selector = placeholder(entries[0]!.selector);
  else if (tool === "propose_event_mention") {
    record.trigger_selector = placeholder(entries[0]!.selector);
    record.extent_selectors = entries.slice(1).map(entry => placeholder(entry.selector));
  } else if (tool === "propose_quotation") {
    record.selector = placeholder(entries[0]!.selector);
    if (entries[1]) record.cue_selector = placeholder(entries[1].selector);
  } else record.selectors = entries.map(entry => placeholder(entry.selector));
  return { record, entries };
}

export class CompilerHostReviewRequiredError extends Error {
  constructor(detail: string) {
    super(`Compiler proposal obligation requires host review: ${detail}. Do not retry in this or a fresh session; preserve drafts and request host adjudication.`);
    this.name = "CompilerHostReviewRequiredError";
  }
}

// Host-only, in-process authorization. Never persisted as a retry permit or exposed as a model tool.
const hostProposalCorrection = new AsyncLocalStorage<{
  root: string; sourceId: string; batchId: string; tool: string; proposalId: string;
  inputHash: string; priorHash: string; used: boolean; hostReview: z.infer<typeof hostReviewSchema>;
}>();

/** Compiler-lock-owned journal. Synchronous writes also cover synchronous Pi argument preflight. */
export class CompilerProposalObligations {
  constructor(private readonly root: string, readonly sourceId: string, readonly batchId: string) {}
  /** Discover actual persisted scopes, including opening/reconciliation, without initializing storage. */
  static listBatchIds(root: string, sourceId: string): string[] {
    const directory = path.join(worldStorageRoot(root), "compiler", "proposal-obligations");
    let scopes: string[];
    try { scopes = fs.readdirSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const ids = new Set<string>();
    for (const scope of scopes.filter(name => /^[a-f0-9]{64}$/.test(name))) {
      for (const file of fs.readdirSync(path.join(directory, scope)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const ledger = ledgerSchema.parse(JSON.parse(fs.readFileSync(path.join(directory, scope, file), "utf8")));
        if (ledger.sourceId !== sourceId) continue;
        const expected = crypto.createHash("sha256").update(JSON.stringify([ledger.sourceId, ledger.batchId])).digest("hex");
        if (expected !== scope) throw new Error("Compiler obligation scope mismatch; stop for host repair.");
        ids.add(ledger.batchId);
      }
    }
    return [...ids].sort();
  }
  private directory() {
    const key = crypto.createHash("sha256").update(JSON.stringify([this.sourceId, this.batchId])).digest("hex");
    return path.join(worldStorageRoot(this.root), "compiler", "proposal-obligations", key);
  }
  private file(identity: { tool: string; proposalId: string }) {
    const key = crypto.createHash("sha256").update(JSON.stringify([identity.tool, identity.proposalId])).digest("hex");
    return path.join(this.directory(), `${key}.json`);
  }
  private read(identity?: { tool: string; proposalId: string }) {
    const empty = () => ledgerSchema.parse({ version: 1, sourceId: this.sourceId, batchId: this.batchId, attempts: [] });
    if (!identity) {
      let files: string[];
      try { files = fs.readdirSync(this.directory()).filter((file) => file.endsWith(".json")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw error; }
      const combined = empty();
      for (const file of files) combined.attempts.push(...this.parse(fs.readFileSync(path.join(this.directory(), file), "utf8")).attempts);
      return combined;
    }
    try { return this.parse(fs.readFileSync(this.file(identity), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw error; }
  }
  private parse(raw: string) {
    const ledger = ledgerSchema.parse(JSON.parse(raw));
    if (ledger.sourceId !== this.sourceId || ledger.batchId !== this.batchId) throw new Error("Compiler obligation scope mismatch; stop for host repair.");
    return ledger;
  }
  private write(ledger: z.infer<typeof ledgerSchema>) {
    const identity = ledger.attempts[0];
    if (!identity || ledger.attempts.some((item) => item.tool !== identity.tool || item.proposalId !== identity.proposalId)) throw new Error("Compiler obligation identity mismatch; stop for host repair.");
    const file = this.file(identity);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(ledgerSchema.parse(ledger), null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  static identity(tool: string, input: unknown) {
    const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const inputHash = crypto.createHash("sha256").update(JSON.stringify(input) ?? "undefined").digest("hex");
    const entry = args.entry && typeof args.entry === "object" ? args.entry as Record<string, unknown> : {};
    // Host-derived identity: changing evidence or user-supplied IDs cannot reset a candidate's allowance.
    const roleEntryId = tool === "propose_role_roster_entry"
      ? `role-entry-${typeof entry.candidateId === "string" ? entry.candidateId : "invalid"}` : undefined;
    return { tool, proposalId: roleEntryId ?? (typeof args.proposal_id === "string" ? args.proposal_id : tool === "propose_role_roster_review" ? "role-roster-review" : `unidentified-${inputHash}`), inputHash };
  }
  private histories(): ProposalAttempt[][] {
    const histories = new Map<string, ProposalAttempt[]>();
    for (const attempt of this.read().attempts) {
      const key = JSON.stringify([attempt.tool, attempt.proposalId]);
      const history = histories.get(key) ?? [];
      history.push(attempt);
      histories.set(key, history);
    }
    return [...histories.values()];
  }
  unresolved(): ProposalAttempt[] {
    return this.histories().flatMap((history) => {
      const latest = history.at(-1)!;
      if (latest.status === "superseded-by-coverage") {
        const failure = latest.coverageProof ? accountingCoverageProofFailure(this.root, latest.coverageProof) : "missing coverage proof";
        return failure ? [{ ...latest, status: "failed" as const, diagnostic: `Coverage proof invalidated: ${failure}; host review is required.` }] : [];
      }
      const lastResolution = history.findLastIndex((attempt) => attempt.status === "succeeded" || attempt.status === "unsupported");
      const unresolved = history.slice(lastResolution + 1).filter((attempt) => attempt.status === "failed" || attempt.status === "running");
      const item = unresolved.at(-1);
      if (!item) return [];
      return [item];
    });
  }
  history(tool: string, proposalId: string): ProposalAttempt[] { return this.read({ tool, proposalId }).attempts; }
  latestAttempts(tool: string): ProposalAttempt[] { return this.histories().map(history => history.at(-1)!).filter(attempt => attempt.tool === tool); }
  inspectSourcePatternUpstreamAuthority(toolInput: string, proposalIdInput: string) {
    const tool = sourcePatternProposalToolSchema.parse(toolInput);
    const proposalId = idSchema.parse(proposalIdInput);
    const history = this.history(tool, proposalId);
    const authority = this.sourcePatternAuthorityFromHistory(tool, proposalId, history);
    return {
      proposalObligation: authority,
      requirementSetHash: sourcePatternObligationRequirementSetHash(authority),
      requirementIds: [sourcePatternObligationRequirementId(authority)],
    };
  }
  verifySourcePatternUpstreamAuthority(
    authorityInput: SourcePatternUpstreamAuthority,
    expected?: { upstreamPlanHash: string; addedCanonicalEventIds: readonly string[] },
  ) {
    const authority = sourcePatternUpstreamAuthoritySchema.parse(authorityInput);
    if (authority.sourceId !== this.sourceId || authority.batchId !== this.batchId) {
      throw new Error("Source-pattern upstream authority differs from its exact durable source or batch.");
    }
    const history = this.history(authority.tool, authority.proposalId);
    if (history.length < authority.attemptCount) throw new Error("Source-pattern upstream authority history was truncated.");
    const prefix = history.slice(0, authority.attemptCount);
    const actual = this.sourcePatternAuthorityFromHistory(authority.tool, authority.proposalId, prefix);
    if (contentHash(actual) !== contentHash(authority)) throw new Error("Source-pattern upstream authority history or failed inputs changed.");
    const suffix = history.slice(authority.attemptCount);
    if (!suffix.length) return { authority, correction: null };
    const [running, succeeded] = suffix;
    if (suffix.length !== 2 || running?.status !== "running" || succeeded?.status !== "succeeded"
      || running.tool !== authority.tool || succeeded.tool !== authority.tool
      || running.proposalId !== authority.proposalId || succeeded.proposalId !== authority.proposalId
      || running.inputHash !== succeeded.inputHash || authority.failedInputHashes.includes(running.inputHash)
      || !running.hostReview?.sourcePatternDependencyCorrection || !succeeded.hostReview?.sourcePatternDependencyCorrection
      || contentHash(running.hostReview) !== contentHash(succeeded.hostReview)) {
      throw new Error("Source-pattern upstream authority has a changed, failed, or incomplete host correction; preserve it for host review.");
    }
    const correction = sourcePatternDependencyCorrectionSchema.parse(succeeded.hostReview.sourcePatternDependencyCorrection);
    if (correction.sourceId !== authority.sourceId || correction.batchId !== authority.batchId
      || correction.tool !== authority.tool || correction.proposalId !== authority.proposalId
      || correction.inputHash !== succeeded.inputHash
      || contentHash([...correction.failedInputHashes].sort()) !== contentHash([...authority.failedInputHashes].sort())
      || contentHash([...correction.originalSupportingEventIds].sort()) !== contentHash([...authority.originalSupportingEventIds].sort())) {
      throw new Error("Source-pattern host correction does not match its frozen upstream authority.");
    }
    if (expected && (correction.upstreamPlanHash !== expected.upstreamPlanHash
      || contentHash(correction.addedDependencies.map(item => item.id).sort()) !== contentHash([...expected.addedCanonicalEventIds].sort()))) {
      throw new Error("Source-pattern host correction does not match the selected upstream plan outputs.");
    }
    return { authority, correction };
  }
  private sourcePatternAuthorityFromHistory(
    tool: z.infer<typeof sourcePatternProposalToolSchema>,
    proposalId: string,
    history: ProposalAttempt[],
  ): SourcePatternUpstreamAuthority {
    if (!history.length || history.at(-1)?.status !== "failed"
      || history.some(attempt => attempt.tool !== tool || attempt.proposalId !== proposalId
        || attempt.hostReview || attempt.coverageProof
        || ["succeeded", "unsupported", "superseded-by-coverage"].includes(attempt.status))) {
      throw new Error("Source-pattern upstream planning requires one exact unreviewed failed proposal identity.");
    }
    const failed = [...new Map(history.filter(attempt => attempt.status === "failed").map(attempt => [attempt.inputHash, attempt])).values()];
    if (failed.length < 2) throw new Error("Source-pattern upstream planning requires the exhausted original and corrected inputs.");
    const attempt = failed[0]!;
    const parsed = sourcePatternCorrectionInputSchema.safeParse(attempt.input);
    if (!parsed.success) throw new Error("Source-pattern upstream planning requires a valid original source-pattern input.");
    const original = { attempt, parsed };
    const originalSupportingEventIds = [...new Set(original.parsed.data.payload.induction.supportingEventIds)].sort();
    const originalEvidenceSegmentIds = [...new Set(original.parsed.data.evidence_segment_ids)].sort();
    if (originalSupportingEventIds.length !== original.parsed.data.payload.induction.supportingEventIds.length
      || originalEvidenceSegmentIds.length !== original.parsed.data.evidence_segment_ids.length) {
      throw new Error("Source-pattern upstream planning cannot bind duplicate original support or citation scope.");
    }
    return sourcePatternUpstreamAuthoritySchema.parse({
      version: 1,
      sourceId: this.sourceId,
      batchId: this.batchId,
      tool,
      proposalId,
      attemptCount: history.length,
      historyHash: contentHash(history),
      failedInputHashes: failed.map(attempt => attempt.inputHash).sort(),
      originalInputHash: original.attempt.inputHash,
      originalSupportingEventIds,
      originalEvidenceSegmentIds,
    });
  }
  requiringHostReview(): ProposalAttempt[] {
    return this.unresolved().filter((item) => {
      if (item.status === "running" || item.coverageProof) return true;
      const history = this.read(item).attempts;
      const lastResolution = history.findLastIndex((attempt) => attempt.status === "succeeded" || attempt.status === "unsupported");
      return new Set(history.slice(lastResolution + 1).filter((attempt) => attempt.status === "failed").map((attempt) => attempt.inputHash)).size >= 2;
    });
  }
  /** Consult durable state before creating a model session, including after timeouts. */
  assertModelRecoveryAllowed() {
    const blocked = this.requiringHostReview();
    if (blocked.length) throw new CompilerHostReviewRequiredError(blocked.map((item) =>
      `${item.tool} proposal_id=${item.proposalId}: ${item.status === "running" ? "interrupted tool result" : "the original and corrected inputs both failed"}: ${item.diagnostic}`).join("\n"));
  }
  /** Under the compiler lock, run one exact source-reviewed selector correction through normal tools.
   * Failures remain unresolved until the tool actually succeeds; no restart receives this authority.
   */
  async withHostSelectorCorrection<T>(tool: string, input: unknown, failedInputHashes: string[], reason: string, auditRef: string, action: () => Promise<T>): Promise<T> {
    if (!reason.trim() || !auditRef.trim() || hostProposalCorrection.getStore()) throw new Error("A separate host review and audit reference are required.");
    const identity = CompilerProposalObligations.identity(tool, input);
    const history = this.history(tool, identity.proposalId), last = history.at(-1);
    if (last?.status !== "failed" || history.some(a => a.hostReview)) throw new Error("Host correction requires an unreviewed failed identity; a reviewed failure must stop.");
    const hashes = [...new Set(history.filter(a => a.status === "failed").map(a => a.inputHash))].sort();
    if (contentHash(hashes) !== contentHash([...new Set(failedInputHashes)].sort()) || hashes.includes(identity.inputHash)) throw new Error("Host review must bind every failed input and a changed correction.");
    const previous = last.input as Record<string, unknown>, corrected = input as Record<string, unknown>;
    const { evidence_selectors: oldSelectors, ...oldRest } = previous;
    const { evidence_selectors: newSelectors, ...newRest } = corrected;
    if (contentHash(oldRest) !== contentHash(newRest) || !Array.isArray(oldSelectors) || !Array.isArray(newSelectors) || oldSelectors.length !== newSelectors.length) throw new Error("Host selector correction cannot change payload, scope, proposal ID, or assertion count.");
    const binding = (s: Record<string, unknown>) => { const { exact, prefix, suffix, occurrence, ...rest } = s; return rest; };
    if (oldSelectors.some((s, i) => contentHash(binding(s)) !== contentHash(binding(newSelectors[i])))) throw new Error("Host selector correction must preserve assertion targets and strengths.");
    return hostProposalCorrection.run({ root: this.root, sourceId: this.sourceId, batchId: this.batchId, ...identity,
      priorHash: contentHash(last), used: false, hostReview: { reason, auditRef } }, action);
  }
  /** Derive one immutable, source-annotation selector correction from exhausted model inputs.
   * The host may only reuse exact spans already attempted at the same selector paths; all
   * non-selector semantics and segment bindings must remain identical.
   */
  inspectAnnotationSelectorCorrection(toolInput: string, input: unknown): AnnotationSelectorCorrection {
    const tool = sourceAnnotationProposalToolSchema.parse(toolInput);
    const identity = CompilerProposalObligations.identity(tool, input);
    const history = this.history(tool, identity.proposalId);
    const last = history.at(-1);
    if (last?.status !== "failed" || history.some(attempt => attempt.hostReview)
      || history.some(attempt => !["running", "failed"].includes(attempt.status))) {
      throw new Error("Annotation selector correction requires one unresolved, unreviewed failed identity.");
    }
    const failed = [...new Map(history.filter(attempt => attempt.status === "failed")
      .map(attempt => [attempt.inputHash, attempt])).values()];
    if (failed.length < 2) throw new Error("Annotation selector correction requires the exhausted original and corrected inputs.");
    if (failed.some(attempt => attempt.tool !== tool || attempt.proposalId !== identity.proposalId)) {
      throw new Error("Annotation selector correction history changed tool or proposal identity.");
    }
    const failedProjections = failed.map(attempt => annotationSelectorProjection(tool, attempt.input));
    const correctedProjection = annotationSelectorProjection(tool, input);
    const semanticHash = contentHash(failedProjections[0]!.record);
    if (failedProjections.some(projection => contentHash(projection.record) !== semanticHash)
      || contentHash(correctedProjection.record) !== semanticHash) {
      throw new Error("Annotation selector correction cannot change non-selector semantics, selector slots, or segment scope.");
    }
    const paths = correctedProjection.entries.map(entry => entry.path);
    for (const projection of failedProjections) {
      if (contentHash(projection.entries.map(entry => entry.path)) !== contentHash(paths)) {
        throw new Error("Annotation selector correction cannot add, remove, or reorder selector slots.");
      }
    }
    for (const [index, corrected] of correctedProjection.entries.entries()) {
      const prior = failedProjections.map(projection => projection.entries[index]!);
      if (prior.some(entry => entry.selector.segment_id !== corrected.selector.segment_id)) {
        throw new Error(`Annotation selector correction cannot change segment scope at ${corrected.path}.`);
      }
      if (!prior.some(entry => entry.selector.exact === corrected.selector.exact)) {
        throw new Error(`Annotation selector correction at ${corrected.path} must reuse an exact span from the failed history.`);
      }
    }
    const failedInputHashes = failed.map(attempt => attempt.inputHash).sort();
    if (failedInputHashes.includes(identity.inputHash)) {
      throw new Error("Annotation selector correction must differ from every failed input.");
    }
    return annotationSelectorCorrectionSchema.parse({
      version: 1,
      sourceId: this.sourceId,
      batchId: this.batchId,
      tool,
      proposalId: identity.proposalId,
      inputHash: identity.inputHash,
      failedInputHashes,
      historyHash: contentHash(history),
      selectorBindings: correctedProjection.entries.map(entry => ({
        path: entry.path,
        segmentId: entry.selector.segment_id,
        exactHash: contentHash(entry.selector.exact),
        selectorHash: contentHash(entry.selector),
      })),
    });
  }
  /** Freeze one complete replacement role review against its exact exhausted history
   * and the host-observed immutable source/roster page inventory.
   */
  inspectRoleRosterCorrection(
    input: unknown,
    context: Omit<RoleRosterCorrection,
      "version" | "sourceId" | "batchId" | "tool" | "proposalId" | "inputHash" | "failedInputHashes" | "historyHash">,
  ): RoleRosterCorrection {
    if (!this.batchId.startsWith(`role-roster-${this.sourceId}-`)) {
      throw new Error("Role-review correction requires the original dedicated role-roster batch.");
    }
    const tool = "propose_role_roster_review";
    const identity = CompilerProposalObligations.identity(tool, input);
    const history = this.history(tool, identity.proposalId);
    const last = history.at(-1);
    if (identity.proposalId !== "role-roster-review"
      || history.some(attempt => attempt.tool !== tool || attempt.proposalId !== identity.proposalId || attempt.coverageProof)) {
      throw new Error("Role-review correction requires one unresolved, unreviewed exhausted identity whose latest attempt failed.");
    }
    const firstReviewed = history.findIndex(attempt => attempt.hostReview?.roleRosterCorrection !== undefined);
    if (firstReviewed >= 0) {
      const prefix = history.slice(0, firstReviewed);
      const suffix = history.slice(firstReviewed);
      const retained = roleRosterCorrectionSchema.parse(suffix[0]!.hostReview!.roleRosterCorrection);
      const expectedReview = suffix[0]!.hostReview;
      const failedInputHashes = [...new Set(prefix.filter(attempt => attempt.status === "failed")
        .map(attempt => attempt.inputHash))].sort();
      if (suffix.length !== 2 || suffix[0]?.status !== "running" || suffix[1]?.status !== "succeeded"
        || suffix.some(attempt => attempt.inputHash !== identity.inputHash
          || contentHash(attempt.hostReview) !== contentHash(expectedReview))
        || retained.sourceId !== this.sourceId || retained.batchId !== this.batchId
        || retained.tool !== tool || retained.proposalId !== identity.proposalId
        || retained.inputHash !== identity.inputHash
        || retained.historyHash !== contentHash(prefix)
        || contentHash(retained.failedInputHashes) !== contentHash(failedInputHashes)) {
        throw new Error("Role-review host correction was interrupted, failed, changed, or already replayed; stop instead of granting another attempt.");
      }
      const {
        version: _version, sourceId: _sourceId, batchId: _batchId, tool: _tool,
        proposalId: _proposalId, inputHash: _inputHash, failedInputHashes: _failedInputHashes,
        historyHash: _historyHash, ...retainedContext
      } = retained;
      if (contentHash(retainedContext) !== contentHash(context)) {
        throw new Error("Role-review correction no longer matches its source pages, roster subject, or reviewed input.");
      }
      return retained;
    }
    if (last?.status !== "failed"
      || history.some(attempt => attempt.hostReview
        || ["succeeded", "unsupported", "superseded-by-coverage"].includes(attempt.status))) {
      throw new Error("Role-review correction requires one unresolved, unreviewed exhausted identity whose latest attempt failed.");
    }
    const failedInputHashes = [...new Set(history.filter(attempt => attempt.status === "failed")
      .map(attempt => attempt.inputHash))].sort();
    if (failedInputHashes.length < 2) {
      throw new Error("Role-review correction requires the exhausted original and corrected inputs.");
    }
    if (failedInputHashes.includes(identity.inputHash)) {
      throw new Error("Role-review correction must be complete and materially different from every failed input.");
    }
    return roleRosterCorrectionSchema.parse({
      version: 1,
      sourceId: this.sourceId,
      batchId: this.batchId,
      tool,
      proposalId: identity.proposalId,
      inputHash: identity.inputHash,
      failedInputHashes,
      historyHash: contentHash(history),
      ...context,
    });
  }
  /** Under the compiler lock, grant exactly one reviewed role proposal invocation.
   * The caller must use the normal role proposal and finish tools in this same scope.
   */
  async withHostRoleRosterCorrection<T>(
    input: unknown,
    bindingInput: RoleRosterCorrection,
    reason: string,
    auditRef: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!reason.trim() || !auditRef.trim() || hostProposalCorrection.getStore()) {
      throw new Error("A separate host role-review decision and audit reference are required.");
    }
    const binding = roleRosterCorrectionSchema.parse(bindingInput);
    const {
      version: _version, sourceId: _sourceId, batchId: _batchId, tool: _tool,
      proposalId: _proposalId, inputHash: _inputHash, failedInputHashes: _failedInputHashes,
      historyHash: _historyHash, ...context
    } = binding;
    const expected = this.inspectRoleRosterCorrection(input, context);
    if (contentHash(binding) !== contentHash(expected)) {
      throw new Error("Role-review correction differs from its exact failed history, source pages, roster subject, or reviewed input.");
    }
    const identity = CompilerProposalObligations.identity("propose_role_roster_review", input);
    const history = this.history("propose_role_roster_review", identity.proposalId);
    const last = history.at(-1)!;
    const reviewed = history.filter(attempt => attempt.hostReview?.roleRosterCorrection);
    if (reviewed.length) {
      const expectedReview = { reason, auditRef, roleRosterCorrection: binding };
      if (reviewed.length !== 2 || last.status !== "succeeded"
        || reviewed.some(attempt => contentHash(attempt.hostReview) !== contentHash(expectedReview))) {
        throw new Error("Role-review host correction is consumed, failed, or differs from its retained reviewed intent.");
      }
    }
    return hostProposalCorrection.run({
      root: this.root,
      sourceId: this.sourceId,
      batchId: this.batchId,
      ...identity,
      priorHash: contentHash(last),
      used: false,
      hostReview: { reason, auditRef, roleRosterCorrection: binding },
    }, action);
  }
  /** Under the compiler lock, execute one reviewed annotation selector correction through
   * the normal proposal schema, immutable-source anchor resolver, and proposal lifecycle.
   */
  async withHostAnnotationSelectorCorrection<T>(
    tool: string,
    input: unknown,
    bindingInput: AnnotationSelectorCorrection,
    reason: string,
    auditRef: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!reason.trim() || !auditRef.trim() || hostProposalCorrection.getStore()) {
      throw new Error("A separate host review and audit reference are required.");
    }
    const binding = annotationSelectorCorrectionSchema.parse(bindingInput);
    const expected = this.inspectAnnotationSelectorCorrection(tool, input);
    if (contentHash(binding) !== contentHash(expected)) {
      throw new Error("Annotation selector correction differs from its exact failed history or reviewed input.");
    }
    const identity = CompilerProposalObligations.identity(tool, input);
    const last = this.history(tool, identity.proposalId).at(-1)!;
    return hostProposalCorrection.run({
      root: this.root,
      sourceId: this.sourceId,
      batchId: this.batchId,
      ...identity,
      priorHash: contentHash(last),
      used: false,
      hostReview: { reason, auditRef, annotationSelectorCorrection: binding },
    }, action);
  }
  /** Exact host-only recovery of a failed upstream slot; the upstream ledger owns its bounded grant. */
  async withHostUpstreamCorrection<T>(tool: string, input: unknown, planHash: string, attemptRef: string, action: () => Promise<T>): Promise<T> {
    if (hostProposalCorrection.getStore()) throw new Error("Nested host correction is forbidden.");
    const { UpstreamRepairLedger } = await import("./upstream-repair-ledger.js");
    const state = await new UpstreamRepairLedger(this.root, this.sourceId).inspect();
    const plan = state.plans.find(item => item.plan.planHash === planHash);
    const attempt = state.attempts.find(item => item.attemptRef === attemptRef);
    const identity = CompilerProposalObligations.identity(tool, input);
    const grant = plan?.hostCorrections?.find(item => item.inputHash === contentHash(input));
    const failed = state.attempts.find(item => item.attemptRef === grant?.failedAttemptRef);
    if (!plan || plan.plan.batchId !== this.batchId || plan.state !== "staging" || !grant || !failed?.failed
      || !attempt || attempt.failed || attempt.staged || attempt.started.modelSessionRef || attempt.started.planHash !== planHash
      || attempt.started.inputHash !== contentHash(input) || attempt.started.proposalId !== identity.proposalId
      || tool !== `propose_${attempt.started.artifactKind.replaceAll("-", "_")}`) throw new Error("No exact active upstream host correction authority.");
    const history = this.history(tool, identity.proposalId), last = history.at(-1);
    if (!last) return action(); // A transport/schema rejection may have occurred before the domain journal.
    if (last.status !== "failed" || history.some(item => item.hostReview || item.inputHash === identity.inputHash)) throw new Error("Upstream host correction is consumed or unchanged.");
    return hostProposalCorrection.run({ root: this.root, sourceId: this.sourceId, batchId: this.batchId, ...identity,
      priorHash: contentHash(last), used: false, hostReview: { reason: grant.reason, auditRef: grant.auditRef } }, action);
  }
  /** Resume one durable pre-receipt finish-revision input after a post-validation interruption. */
  async withHostUpstreamFinishRevision<T>(tool: string, input: unknown, planHash: string, attemptRef: string, action: () => Promise<T>): Promise<T> {
    if (hostProposalCorrection.getStore()) throw new Error("Nested host correction is forbidden.");
    const { UpstreamRepairLedger } = await import("./upstream-repair-ledger.js");
    const state = await new UpstreamRepairLedger(this.root, this.sourceId).inspect();
    const plan = state.plans.find(item => item.plan.planHash === planHash), attempt = state.attempts.find(item => item.attemptRef === attemptRef);
    const identity = CompilerProposalObligations.identity(tool, input);
    const revision = plan?.finishRevision;
    const correction = revision?.intent.corrections.find(item => item.replacementProposalId === identity.proposalId);
    const authorityIssues = [
      !plan && "plan-missing",
      plan?.plan.batchId !== this.batchId && "batch-mismatch",
      plan?.state !== "finish-revising" && `state-${plan?.state ?? "missing"}`,
      !correction && "correction-missing",
      !attempt && "attempt-missing",
      attempt?.failed && "attempt-failed",
      attempt?.staged && "attempt-staged",
      attempt?.started.modelSessionRef && "model-owned",
      attempt?.started.planHash !== planHash && "attempt-plan-mismatch",
      attempt && correction && attempt.started.inputHash !== correction.inputHash && "grant-input-mismatch",
      attempt && attempt.started.inputHash !== contentHash(input) && "retained-input-mismatch",
      attempt && correction && attempt.started.artifactKind !== correction.artifactKind && "kind-mismatch",
      attempt && correction && attempt.started.artifactId !== correction.artifactId && "slot-mismatch",
      attempt && tool !== `propose_${attempt.started.artifactKind.replaceAll("-", "_")}` && "tool-mismatch",
    ].filter((item): item is string => Boolean(item));
    if (authorityIssues.length || !plan || !revision || !correction || !attempt) throw new Error(`No exact active upstream finish-revision authority: ${authorityIssues.join(", ")}.`);
    const history = this.history(tool, identity.proposalId), last = history.at(-1);
    if (!last) return action();
    if (last.status !== "running" || last.inputHash !== identity.inputHash || !attempt.validatedHash || history.some(item => item.hostReview)) {
      throw new Error("Upstream finish-revision input is consumed, failed, unchanged without a durable write intent, or already reviewed.");
    }
    return hostProposalCorrection.run({ root: this.root, sourceId: this.sourceId, batchId: this.batchId, ...identity,
      priorHash: contentHash(last), used: false, hostReview: { reason: revision.intent.reason, auditRef: revision.intent.auditRef } }, action);
  }
  async withHostSourcePatternDependencyCorrection<T>(
    tool: string,
    input: unknown,
    bindingInput: SourcePatternDependencyCorrection,
    reason: string,
    auditRef: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!reason.trim() || !auditRef.trim() || hostProposalCorrection.getStore()) throw new Error("A separate host review and audit reference are required.");
    const binding = sourcePatternDependencyCorrectionSchema.parse(bindingInput);
    const identity = CompilerProposalObligations.identity(tool, input);
    if (binding.sourceId !== this.sourceId || binding.batchId !== this.batchId || binding.tool !== tool
      || binding.proposalId !== identity.proposalId || binding.inputHash !== identity.inputHash) {
      throw new Error("Host dependency correction differs from its exact source, batch, tool, proposal, or input hash.");
    }
    const history = this.history(tool, identity.proposalId), last = history.at(-1);
    if (last?.status !== "failed" || history.some(attempt => attempt.hostReview)) throw new Error("Host correction requires an unreviewed failed identity; a reviewed failure must stop.");
    const failed = [...new Map(history.filter(attempt => attempt.status === "failed").map(attempt => [attempt.inputHash, attempt])).values()];
    const failedHashes = failed.map(attempt => attempt.inputHash).sort();
    if (new Set(binding.failedInputHashes).size !== binding.failedInputHashes.length
      || contentHash(failedHashes) !== contentHash([...binding.failedInputHashes].sort())
      || failedHashes.includes(identity.inputHash)) {
      throw new Error("Host dependency review must bind every distinct failed input and one changed correction.");
    }
    const original = failed.map(attempt => sourcePatternCorrectionInputSchema.safeParse(attempt.input))
      .find(result => result.success);
    const corrected = sourcePatternCorrectionInputSchema.parse(input);
    if (!original?.success || original.data.proposal_id !== corrected.proposal_id
      || original.data.payload.id !== corrected.payload.id || corrected.payload.id !== identity.proposalId) {
      throw new Error("Host dependency correction requires the original source-pattern identity and cannot change its logical ID.");
    }
    const uniqueSorted = (values: readonly string[]) => [...new Set(values)].sort();
    const originalEvents = uniqueSorted(original.data.payload.induction.supportingEventIds);
    const correctedEvents = uniqueSorted(corrected.payload.induction.supportingEventIds);
    const addedEvents = correctedEvents.filter(id => !originalEvents.includes(id));
    if (originalEvents.length !== original.data.payload.induction.supportingEventIds.length
      || correctedEvents.length !== corrected.payload.induction.supportingEventIds.length
      || originalEvents.some(id => !correctedEvents.includes(id)) || !addedEvents.length
      || contentHash(originalEvents) !== contentHash(uniqueSorted(binding.originalSupportingEventIds))
      || contentHash(correctedEvents) !== contentHash(uniqueSorted(binding.correctedSupportingEventIds))
      || contentHash(addedEvents) !== contentHash(uniqueSorted(binding.addedDependencies.map(item => item.id)))
      || contentHash(uniqueSorted(original.data.evidence_segment_ids)) !== contentHash(uniqueSorted(corrected.evidence_segment_ids))) {
      throw new Error("Host dependency correction must retain the original supporting events and citation scope while adding only reviewed canonical-event dependencies.");
    }
    const { UpstreamRepairLedger } = await import("./upstream-repair-ledger.js");
    const { verifyUpstreamRepairConvergence } = await import("./upstream-repair-convergence.js");
    const { CanonicalModelStore } = await import("../world/canonical-model.js");
    const state = await new UpstreamRepairLedger(this.root, this.sourceId).inspect();
    const current = state.plans.find(item => item.plan.planHash === binding.upstreamPlanHash);
    const convergence = state.records.find(record => record.hash === binding.convergenceRef);
    if (!current || !["converged", "evaluated"].includes(current.state)
      || current.plan.authorizationRef !== binding.upstreamAuthorizationRef
      || current.finishedReceipt !== binding.receiptFingerprint
      || convergence?.payload.kind !== "converged" || convergence.payload.planHash !== binding.upstreamPlanHash
      || convergence.payload.receiptFingerprint !== binding.receiptFingerprint) {
      throw new Error("Host dependency correction requires the exact completed and converged upstream plan, authorization, and finish receipt.");
    }
    const verified = await verifyUpstreamRepairConvergence(this.root, this.sourceId, binding.upstreamPlanHash);
    if (verified.receiptFingerprint !== binding.receiptFingerprint
      || contentHash(verified.activeRevisions) !== contentHash(convergence.payload.activeRevisions)) {
      throw new Error("Host dependency correction upstream convergence is no longer current.");
    }
    const canonical = new CanonicalModelStore(this.root);
    for (const dependency of binding.addedDependencies) {
      const semantic = current.plan.semanticEventCreations?.find(item => item.canonicalEventId === dependency.id);
      const active = convergence.payload.activeRevisions.find(item => item.kind === "canonical-event" && item.id === dependency.id);
      const event = await canonical.getEvent(dependency.id);
      if (!semantic || active?.revisionHash !== dependency.revisionHash || !event || contentHash(event) !== dependency.revisionHash) {
        throw new Error(`Host dependency correction cannot prove the active reviewed canonical event ${dependency.id}.`);
      }
    }
    return hostProposalCorrection.run({
      root: this.root,
      sourceId: this.sourceId,
      batchId: this.batchId,
      ...identity,
      priorHash: contentHash(last),
      used: false,
      hostReview: { reason, auditRef, sourcePatternDependencyCorrection: binding },
    }, action);
  }
  async withHostAccountingRefinement<T>(
    input: unknown,
    bindingInput: AccountingRefinementCorrection,
    reason: string,
    auditRef: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!reason.trim() || !auditRef.trim() || hostProposalCorrection.getStore()) {
      throw new Error("A separate host accounting-refinement review and audit reference are required.");
    }
    const binding = accountingRefinementCorrectionSchema.parse(bindingInput);
    const identity = CompilerProposalObligations.identity("account_source_units", input);
    if (binding.sourceId !== this.sourceId || binding.batchId !== this.batchId
      || binding.proposalId !== identity.proposalId || binding.inputHash !== identity.inputHash) {
      throw new Error("Host accounting refinement differs from its exact source, batch, proposal, or failed input hash.");
    }
    const history = this.history("account_source_units", identity.proposalId);
    const last = history.at(-1);
    if (last?.status !== "failed" || history.some(attempt => attempt.hostReview || attempt.coverageProof)) {
      throw new Error("Host accounting refinement requires one unreviewed exhausted identity; a reviewed or settled attempt must stop.");
    }
    const failedHashes = [...new Set(history.filter(attempt => attempt.status === "failed").map(attempt => attempt.inputHash))].sort();
    if (failedHashes.length < 2 || contentHash(failedHashes) !== contentHash([...binding.failedInputHashes].sort())
      || contentHash(history) !== binding.historyHash) {
      throw new Error("Host accounting refinement must bind the complete unchanged failure history and one exact-scope reviewed input.");
    }
    return hostProposalCorrection.run({
      root: this.root,
      sourceId: this.sourceId,
      batchId: this.batchId,
      tool: "account_source_units",
      proposalId: identity.proposalId,
      inputHash: identity.inputHash,
      priorHash: contentHash(last),
      used: false,
      hostReview: { reason, auditRef, accountingRefinementCorrection: binding },
    }, action);
  }
  completeInterruptedHostAccountingRefinement(
    input: unknown,
    bindingInput: AccountingRefinementCorrection,
    reason: string,
    auditRef: string,
  ): void {
    if (hostProposalCorrection.getStore()) throw new Error("Nested host correction is forbidden.");
    const binding = accountingRefinementCorrectionSchema.parse(bindingInput);
    const identity = CompilerProposalObligations.identity("account_source_units", input);
    const history = this.history("account_source_units", identity.proposalId);
    const last = history.at(-1);
    const expectedReview = { reason, auditRef, accountingRefinementCorrection: binding };
    if (binding.sourceId !== this.sourceId || binding.batchId !== this.batchId
      || binding.proposalId !== identity.proposalId || binding.inputHash !== identity.inputHash
      || last?.status !== "running" || last.inputHash !== identity.inputHash
      || contentHash(last.hostReview) !== contentHash(expectedReview)) {
      throw new Error("Interrupted host accounting refinement does not match the exact retained running intent.");
    }
    hostProposalCorrection.run({
      root: this.root,
      sourceId: this.sourceId,
      batchId: this.batchId,
      tool: "account_source_units",
      proposalId: identity.proposalId,
      inputHash: identity.inputHash,
      priorHash: contentHash(last),
      used: true,
      hostReview: expectedReview,
    }, () => this.record("account_source_units", input, "succeeded"));
  }
  assertRetryAllowed(tool: string, input: unknown) {
    const identity = CompilerProposalObligations.identity(tool, input);
    const history = this.read(identity).attempts;
    if (history.at(-1)?.status === "superseded-by-coverage") {
      throw new CompilerHostReviewRequiredError("this accounting identity has a host coverage settlement; do not reuse it, even after dependency withdrawal");
    }
    if (history.at(-1)?.status === "running") {
      throw new CompilerHostReviewRequiredError("interrupted tool result; the host must inspect durable drafts before resolving this attempt");
    }
    const lastResolution = history.findLastIndex((item) => item.status === "succeeded" || item.status === "unsupported");
    const failedInputs = new Set(history.slice(lastResolution + 1).filter((item) => item.status === "failed").map((item) => item.inputHash));
    const host = hostProposalCorrection.getStore();
    if (host && !host.used && host.root === this.root && host.sourceId === this.sourceId && host.batchId === this.batchId
      && host.tool === tool && host.proposalId === identity.proposalId && host.inputHash === identity.inputHash
      && contentHash(history.at(-1)) === host.priorHash) return;
    if (failedInputs.size >= 2) {
      throw new CompilerHostReviewRequiredError("the original and corrected inputs both failed");
    }
  }
  record(tool: string, input: unknown, status: ProposalAttempt["status"], diagnostic = "", diagnosticContext?: ToolDiagnosticContext) {
    const identity = CompilerProposalObligations.identity(tool, input);
    const ledger = this.read(identity);
    // Idempotent successful replays need only the latest receipt. Keep every
    // failed/adjudicated attempt; full invocation history remains in the audit.
    const prior = ledger.attempts.at(-1);
    const started = ledger.attempts.at(-2);
    if (status === "running" && prior?.status === "succeeded" && started?.status === "running"
      && !prior.hostReview?.roleRosterCorrection && !started.hostReview?.roleRosterCorrection
      && prior.inputHash === identity.inputHash && started.inputHash === identity.inputHash) ledger.attempts.splice(-2);
    const host = hostProposalCorrection.getStore();
    const reviewed = host && host.root === this.root && host.sourceId === this.sourceId && host.batchId === this.batchId
      && host.tool === tool && host.proposalId === identity.proposalId && host.inputHash === identity.inputHash;
    if (reviewed && status === "running") host.used = true;
    ledger.attempts.push({ ...identity, input, status, diagnostic, ...(diagnosticContext ? { diagnosticContext } : {}), updatedAt: new Date().toISOString(),
      ...(reviewed ? { hostReview: host.hostReview } : {}) });
    const latest = ledger.attempts.at(-1)!;
    if (status === "failed" && latest.diagnosticContext) {
      const lastResolution = ledger.attempts.findLastIndex(item => item.status === "succeeded" || item.status === "unsupported");
      const failures = new Set(ledger.attempts.slice(lastResolution + 1).filter(item => item.status === "failed").map(item => item.inputHash));
      latest.diagnosticContext = { ...latest.diagnosticContext, retry: {
        sourceId: this.sourceId, batchId: this.batchId, proposalId: identity.proposalId,
        correctedRetryAvailable: failures.size < 2,
      } };
    }
    this.write(ledger);
  }
  assertFinishable() {
    this.assertModelRecoveryAllowed();
    const pending = this.unresolved();
    if (!pending.length) return;
    throw new Error("Unresolved compiler proposal obligations (persisted across sessions):\n"
      + pending.map((item) => `${item.tool} proposal_id=${item.proposalId}: ${item.status}: ${item.diagnostic}`).join("\n")
      + "\nRepair each named proposal with the same exact proposal_id and tool, after checking every selector against the supplied citable segment. Retry once with concrete corrections; never guess IDs, widen evidence scope, add unrelated proposals, withdraw valid accounting, or restart to clear failures. If evidence is absent or the corrected attempt fails, stop for a host review; do not retry finish unchanged.");
  }
  /** Host-only adjudication. This preserves history and does not certify any executable mechanism. */
  reviewUnsupported(tool: string, proposalId: string, reason: string, auditRef: string) {
    if (!reason.trim() || !auditRef.trim()) throw new Error("Host review requires a reason and audit reference.");
    const previous = this.unresolved().find((item) => item.tool === tool && item.proposalId === proposalId);
    if (!previous) throw new Error("No unresolved obligation with that exact tool/proposal ID in this source/batch.");
    const ledger = this.read({ tool, proposalId });
    ledger.attempts.push({ ...previous, status: "unsupported", updatedAt: new Date().toISOString(), hostReview: { reason, auditRef } });
    this.write(ledger);
  }
  /** Called only by the host coverage reviewer after reconstructing all failed inputs. */
  recordCoverageSettlement(proofInput: AccountingCoverageProof, reason: string, auditRef: string) {
    const proof = accountingCoverageProofSchema.parse(proofInput);
    if (!reason.trim() || !auditRef.trim() || proof.sourceId !== this.sourceId || proof.batchId !== this.batchId) {
      throw new Error("Host coverage review requires the exact source/batch, reason and audit reference.");
    }
    const current = this.history("account_source_units", proof.proposalId).at(-1);
    if (current?.status === "superseded-by-coverage" && current.coverageProof
      && contentHash(current.coverageProof) === contentHash(proof) && current.hostReview?.reason === reason && current.hostReview.auditRef === auditRef
      && !accountingCoverageProofFailure(this.root, proof)) return;
    const previous = this.unresolved().find((item) => item.tool === "account_source_units" && item.proposalId === proof.proposalId);
    if (!previous) throw new Error("No unresolved accounting obligation with that exact source/batch/proposal ID.");
    const failure = accountingCoverageProofFailure(this.root, proof);
    if (failure) throw new Error(`Host coverage review failed: ${failure}`);
    const ledger = this.read(previous);
    const lastResolution = ledger.attempts.findLastIndex((item) => item.status === "succeeded" || item.status === "unsupported");
    const failed = ledger.attempts.slice(lastResolution + 1).filter((item) => item.status === "failed");
    const hashes = [...new Set(failed.map((item) => item.inputHash))].sort();
    if (JSON.stringify(hashes) !== JSON.stringify([...proof.failedInputHashes].sort())) throw new Error("Coverage proof omits or changes failed inputs.");
    const units = new Set<string>();
    for (const item of failed) {
      const input = item.input as { page_token?: string; decisions?: Array<{ unit_id: string }> };
      if (input.page_token) {
        const page = new CompilerAccountingPages(this.root, this.sourceId, this.batchId).read(input.page_token);
        if (!page || page.sourceSha256 !== proof.sourceSha256) throw new Error("Original accounting page lacks verified provenance.");
        page.unitIds.forEach((id) => units.add(id));
      } else input.decisions?.forEach((decision) => units.add(decision.unit_id));
    }
    if (JSON.stringify([...units].sort()) !== JSON.stringify(proof.units.map((unit) => unit.unitId).sort())) throw new Error("Coverage proof must include every original unit and no unrelated units.");
    ledger.attempts.push({ ...previous, status: "superseded-by-coverage", diagnostic: "Every original unit has verified current-batch coverage; this does not certify executable world semantics.",
      updatedAt: new Date().toISOString(), hostReview: { reason, auditRef }, coverageProof: proof });
    this.write(ledger);
  }
}

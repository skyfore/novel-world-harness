import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { worldStorageRoot } from "../world/paths.js";
import { accountingCoverageProofSchema, accountingCoverageProofFailure, type AccountingCoverageProof } from "./accounting-coverage-proof.js";
import { CompilerAccountingPages } from "./accounting-pages.js";
import { contentHash } from "../world/canonical.js";

const attemptSchema = z.object({
  tool: z.string(), proposalId: z.string(), inputHash: z.string(), input: z.unknown(),
  status: z.enum(["running", "failed", "succeeded", "unsupported", "superseded-by-coverage"]),
  diagnostic: z.string(), updatedAt: z.string(),
  hostReview: z.object({ reason: z.string().min(1), auditRef: z.string().min(1) }).optional(),
  coverageProof: accountingCoverageProofSchema.optional(),
}).strict();
const ledgerSchema = z.object({
  version: z.literal(1), sourceId: z.string(), batchId: z.string(),
  attempts: z.array(attemptSchema),
}).strict();
export type ProposalAttempt = z.infer<typeof attemptSchema>;

export class CompilerHostReviewRequiredError extends Error {
  constructor(detail: string) {
    super(`Compiler proposal obligation requires host review: ${detail}. Do not retry in this or a fresh session; preserve drafts and request host adjudication.`);
    this.name = "CompilerHostReviewRequiredError";
  }
}

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
    return { tool, proposalId: typeof args.proposal_id === "string" ? args.proposal_id : tool === "propose_role_roster_review" ? "role-roster-review" : `unidentified-${inputHash}`, inputHash };
  }
  unresolved(): ProposalAttempt[] {
    const latest = new Map<string, ProposalAttempt>();
    for (const attempt of this.read().attempts) latest.set(JSON.stringify([attempt.tool, attempt.proposalId]), attempt);
    return [...latest.values()].flatMap((item) => {
      if (item.status === "superseded-by-coverage") {
        const failure = item.coverageProof ? accountingCoverageProofFailure(this.root, item.coverageProof) : "missing coverage proof";
        return failure ? [{ ...item, status: "failed" as const, diagnostic: `Coverage proof invalidated: ${failure}; host review is required.` }] : [];
      }
      return item.status === "failed" || item.status === "running" ? [item] : [];
    });
  }
  history(tool: string, proposalId: string): ProposalAttempt[] { return this.read({ tool, proposalId }).attempts; }
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
    if (failedInputs.size >= 2) {
      throw new CompilerHostReviewRequiredError("the original and corrected inputs both failed");
    }
  }
  record(tool: string, input: unknown, status: ProposalAttempt["status"], diagnostic = "") {
    const identity = CompilerProposalObligations.identity(tool, input);
    const ledger = this.read(identity);
    // Idempotent successful replays need only the latest receipt. Keep every
    // failed/adjudicated attempt; full invocation history remains in the audit.
    const prior = ledger.attempts.at(-1);
    const started = ledger.attempts.at(-2);
    if (status === "running" && prior?.status === "succeeded" && started?.status === "running"
      && prior.inputHash === identity.inputHash && started.inputHash === identity.inputHash) ledger.attempts.splice(-2);
    ledger.attempts.push({ ...identity, input, status, diagnostic, updatedAt: new Date().toISOString() });
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

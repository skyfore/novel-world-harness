import crypto from "node:crypto";
import { contentHash } from "./canonical.js";

export type ConstraintTokenBinding =
  | { kind: "state"; entityId: string; field: string }
  | { kind: "active-rule"; ruleName: string }
  | { kind: "deterministic-issue"; issueCode: string };

export type OpaqueConstraint = ConstraintTokenBinding & { token: string };

/**
 * Turn-local capability ledger. Tokens are bound to one parent commit and one
 * exact candidate hash, are unguessable without the per-ledger nonce, and may
 * be consumed by at most one transformed resolution.
 */
export class ConstraintTokenLedger<TCandidate> {
  readonly parentCommitId: string;
  readonly candidateHash: string;
  readonly constraints: readonly OpaqueConstraint[];
  private readonly bindings = new Map<string, ConstraintTokenBinding>();
  private consumed = false;

  constructor(parentCommitId: string, candidate: TCandidate, bindings: readonly ConstraintTokenBinding[]) {
    this.parentCommitId = parentCommitId;
    this.candidateHash = contentHash(candidate);
    const nonce = crypto.randomBytes(32).toString("hex");
    this.constraints = bindings.map((binding, index) => {
      const token = `ct1-${contentHash({ nonce, parentCommitId, candidateHash: this.candidateHash, index, binding }).slice(0, 48)}`;
      this.bindings.set(token, structuredClone(binding));
      return { token, ...structuredClone(binding) };
    });
  }

  consume(tokens: readonly string[], parentCommitId: string, candidate: TCandidate): ConstraintTokenBinding[] {
    if (this.consumed) throw new Error("CONSTRAINT_TOKEN_REUSED: this turn-local constraint capability was already consumed");
    if (parentCommitId !== this.parentCommitId || contentHash(candidate) !== this.candidateHash) {
      throw new Error("CONSTRAINT_TOKEN_SCOPE_MISMATCH: token is not bound to this parent commit and candidate");
    }
    if (!tokens.length) throw new Error("CONSTRAINT_TOKEN_REQUIRED: transformed resolution must cite a supplied token");
    if (new Set(tokens).size !== tokens.length) throw new Error("CONSTRAINT_TOKEN_DUPLICATE: one token cannot be cited twice");
    const resolved = tokens.map((token) => {
      const binding = this.bindings.get(token);
      if (!binding) throw new Error("CONSTRAINT_TOKEN_INVALID: token was not issued in this turn");
      return structuredClone(binding);
    });
    this.consumed = true;
    return resolved;
  }
}

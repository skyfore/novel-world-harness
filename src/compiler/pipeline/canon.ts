import crypto from "node:crypto";
import { CompilerProposalService, type CompilerProposalKind } from "../proposals.js";
import { convergeWorldProposals, quarantineUncommittableProposals } from "../converge.js";
import type { StageContext } from "./runner.js";

/**
 * Canonical writes from pipeline tools: every artifact is a pending proposal
 * through the existing service, then convergence validates and commits it.
 * The pipeline never writes canon directly.
 */
export async function submitCanonical(ctx: StageContext, scopeId: string, kind: CompilerProposalKind, payload: unknown, worker = `pipeline-${kind}`): Promise<string> {
  const base = `pl-${kind}-${crypto.createHash("sha256").update(`${scopeId}\u0000${JSON.stringify(payload)}`).digest("hex").slice(0, 20)}`;
  const generatedBy = { worker, compilerBatchId: scopeId, ...(ctx.generatedBy.provider ? { provider: ctx.generatedBy.provider } : {}), ...(ctx.generatedBy.model ? { model: ctx.generatedBy.model } : {}) };
  const service = new CompilerProposalService(ctx.root);
  try {
    await service.submit(kind, { proposalId: base, payload, generatedBy });
    return base;
  } catch (error) {
    // The same payload was proposed (and decided) before, e.g. on a retry: re-propose it under a fresh envelope ID.
    if (!(error instanceof Error) || !/already exists in (?:accepted|rejected) history/u.test(error.message)) throw error;
    const proposalId = `${base}-r${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;
    await service.submit(kind, { proposalId, payload, generatedBy });
    return proposalId;
  }
}

/** Commit every valid pending proposal of this source; blocked ones are quarantined and returned as issues. */
export async function convergeCanonical(ctx: StageContext): Promise<string[]> {
  const converged = await convergeWorldProposals(ctx.root, ctx.sourceId);
  await quarantineUncommittableProposals(ctx.root, converged);
  return [
    ...converged.canonical.blocked.map((item) => `${item.kind} ${item.id}: ${item.errors.slice(0, 3).map((issue) => `${issue.code} ${issue.message}`).join("; ")}`),
    ...converged.possibilities.blocked.map((item) => `possibility ${item.id}: ${item.errors.slice(0, 3).map((issue) => issue.message).join("; ")}`),
  ];
}

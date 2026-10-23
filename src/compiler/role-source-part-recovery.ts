import fs from 'node:fs/promises';
import path from 'node:path';
import { contentHash } from '../world/canonical.js';
import { worldStorageRoot } from '../world/paths.js';
import { withWorkspaceOperationLock } from '../util/workspace-lock.js';
import { RoleReviewWorkStore, roleSourceWorkSchema, roleWorkStop } from './role-review-work.js';
import { CompilerProposalObligations } from './proposal-obligations.js';
import { loadCurrentRoleRoster } from './role-roster-tools.js';
import { readSourceMaterial } from '../storage/source-material-store.js';
import { baseStructuralUnits } from './structure.js';
import { reassembleRoleContext } from './role-review-context.js';
import { roleSourceParts } from './role-source-parts.js';
import { inspectRoleReviewBudget, remainingRoleProgressCalls } from './role-review-budget.js';

type Review = { sourceId: string; batchId: string; workId: string; proposalId: string;
  failedInputHash: string; auditRef: string; expectedAuthorityHash?: string };
const legacyMessage = 'Part notes must fit 1800 UTF-8 JSON bytes. Preserve concise findings and questions; if impossible stop for host review.';

/** Narrow host migration for the retired 1800-byte part validator. No prose is
 * changed, no model allowance is added and no source receipt is fabricated. */
export async function reviewLegacySourcePart(root: string, input: Review, apply = false): Promise<ReturnType<typeof result>> {
  if (apply) return withWorkspaceOperationLock(root, 'compiler', async () => {
    const preview = await reviewLegacySourcePart(root, input);
    if (input.expectedAuthorityHash !== preview.authorityHash) throw roleWorkStop('source-part review authority changed; inspect a fresh preview, do not retry unchanged');
    new CompilerProposalObligations(root, input.sourceId, input.batchId).recordSourcePartRevalidation(
      input.proposalId, preview.authority.historyHash, preview.authorityHash, input.auditRef);
    return { ...preview, applied: true };
  });
  if (!input.auditRef.trim()) throw roleWorkStop('source-part revalidation requires a host audit reference');
  const plan = (await RoleReviewWorkStore.plans(root, input.sourceId)).find(p => p.batchId === input.batchId);
  if (!plan) throw roleWorkStop('original source-part plan missing');
  const store = new RoleReviewWorkStore(root, plan), current = await loadCurrentRoleRoster(root, input.sourceId);
  const bytes = await readSourceMaterial(root, current.source);
  store.assertScope(current.roster, contentHash(current.structure), bytes.length);
  const page = plan.spans.findIndex((_, i) => store.workId('source', i) === input.workId);
  if (page < 0 || store.read('source', page) || store.journal.history('propose_role_source_review', input.workId).length) throw roleWorkStop('parent is foreign, already submitted or complete');
  const history = store.journal.history('propose_role_source_part', input.proposalId), last = history.at(-1);
  if (last?.status !== 'failed' || last.inputHash !== input.failedInputHash || store.journal.unresolved().length !== 1
    || history.some(a => a.hostReview || !['running', 'failed'].includes(a.status)
      || CompilerProposalObligations.identity(a.tool, a.input).inputHash !== a.inputHash)) throw roleWorkStop('requires the exact sole unreviewed part failure');
  for (const a of history.filter(a => a.status === 'failed')) {
    let issues;
    try { issues = JSON.parse(a.diagnostic); } catch { throw roleWorkStop('failure is not the retired size validator'); }
    if (!Array.isArray(issues) || issues.length !== 1 || issues[0].code !== 'custom' || issues[0].message !== legacyMessage
      || JSON.stringify(issues[0].path) !== '[]') throw roleWorkStop('failure is not solely the retired size validator');
  }
  const dir = path.join(worldStorageRoot(root), 'compiler', 'role-review-work');
  const attemptsDir = path.join(dir, 'v1', contentHash(input.sourceId), 'attempts', contentHash(input.batchId), contentHash(input.workId));
  for (const ordinal of [1, 2]) {
    const attempt = JSON.parse(await fs.readFile(path.join(attemptsDir, `${ordinal}.json`), 'utf8'));
    if (attempt.planHash !== store.planHash || attempt.workId !== input.workId) throw roleWorkStop('original parent invocation markers changed');
  }
  const checkpointPath = path.join(dir, 'context', store.planHash, `${contentHash(input.workId)}.json`);
  try { await fs.access(`${checkpointPath}.pending`); throw roleWorkStop('uncertain context publication'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
  if (checkpoint.hash !== contentHash(checkpoint.state) || checkpoint.state.planHash !== store.planHash
    || checkpoint.state.workId !== input.workId) throw roleWorkStop('original context integrity changed');
  const units = baseStructuralUnits(current.structure).sort((a,b) => a.anchor.startByte-b.anchor.startByte);
  const evidence = reassembleRoleContext(bytes, units, [plan.spans[page]!], checkpoint.state.accesses,
    {page, spans: plan.spans}, Number.MAX_SAFE_INTEGER);
  const parts = roleSourceParts(bytes, units, evidence.packet.ranges);
  const bundleHash = contentHash({planHash: store.planHash, workId: input.workId, packets: parts.map(p=>p.packetHash)});
  const part = parts.find(p=>input.proposalId === `${input.workId}:part:${p.index}`);
  if (!part) throw roleWorkStop('part identity does not belong to original packets');
  for (const a of history) {
    const envelope = a.input as {planHash:string; bundleHash:string; packetHash:string; payload:unknown};
    const value = roleSourceWorkSchema.parse(envelope.payload), allowed = new Set(part.packet.fragments.map(f=>f.unitId));
    if (envelope.planHash !== store.planHash || envelope.bundleHash !== bundleHash || envelope.packetHash !== part.packetHash
      || Buffer.byteLength(JSON.stringify(value)) <= 1800 || value.findings.some(f=>f.unitIds.some(id=>!allowed.has(id)))) throw roleWorkStop('part packet, size or citation validation failed');
  }
  const budget = inspectRoleReviewBudget(root, store.planHash, input.workId);
  if (budget.state.blocked || remainingRoleProgressCalls(budget) === 0
   ) throw roleWorkStop('parent budget exhausted; revalidation grants no budget');
  const authority = {planHash:store.planHash, workId:input.workId, proposalId:input.proposalId, inputHash:last.inputHash,
    historyHash:contentHash(history), bundleHash, packetHash:part.packetHash, contextHash:checkpoint.hash,
    budgetHash:budget.hash, validator:'shared-source-notes-8000-v1', auditRef:input.auditRef};
  return result(authority, part.packet, (last.input as {payload:unknown}).payload);
}
function result(authority: {historyHash:string; [key:string]:string}, packet: unknown, retainedNotes: unknown) {
  return {applied:false, authority, authorityHash:contentHash(authority), packet, retainedNotes, semanticSupport:'not-verified', parentCompleted:false};
}

/** Claim once before resuming the interrupted partition invocation. Budgets and
 * both original invocation markers remain unchanged, including on a new failure. */
export async function claimSourcePartContinuation(store: RoleReviewWorkStore, workId: string, authorityHash: string, bundleHash: string) {
  const records = store.journal.latestAttempts('propose_role_source_part').filter(a=>a.proposalId.startsWith(`${workId}:part:`)
    && a.hostReview?.sourcePartRevalidation?.authorityHash === authorityHash);
  if (records.length !== 1 || records[0]!.status !== 'succeeded'
    || (records[0]!.input as {bundleHash:string}).bundleHash !== bundleHash) throw roleWorkStop('no matching source-part revalidation');
  const budget = inspectRoleReviewBudget(store.root, store.planHash, workId);
  if (budget.state.blocked || remainingRoleProgressCalls(budget) === 0) throw roleWorkStop('retained parent budget exhausted');
  const dir = path.join(worldStorageRoot(store.root),'compiler','role-review-work','part-continuations',store.planHash);
  await fs.mkdir(dir,{recursive:true});
  try { await fs.writeFile(path.join(dir,`${contentHash(workId)}.json`),JSON.stringify({workId,authorityHash,bundleHash,budgetHash:budget.hash}),{flag:'wx',mode:0o600}); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw roleWorkStop('part continuation already consumed; do not retry'); throw e; }
}

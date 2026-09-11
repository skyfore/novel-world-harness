// Incident-specific host operation. Default is read-only; --apply requires the
// reviewed preview and rechecks it under the existing compiler lock.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { TraceStore } from '../../../src/trace/store.js';
import { CompilerProposalObligations } from '../../../src/compiler/proposal-obligations.js';
import { CompilerAccountingPages } from '../../../src/compiler/accounting-pages.js';
import { SourceAccountingStore } from '../../../src/compiler/source-accounting.js';
import { SourceStructureStore, baseStructuralUnits } from '../../../src/compiler/structure.js';
import { accountingCoverageProofSchema, accountingCoverageProofFailure } from '../../../src/compiler/accounting-coverage-proof.js';
import { readAccountingBatchSegments } from '../../../src/compiler/accounting-review.js';
import { contentHash } from '../../../src/world/canonical.js';
import { withWorkspaceOperationLock } from '../../../src/util/workspace-lock.js';
import { inspectCompilerStatus } from '../../../src/compiler/status.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = path.dirname(fileURLToPath(import.meta.url));
const sourceId = 'a28585b1cf867f3e3a16';
const batchId = 'batch-a28585b1cf867f3e3a16-00008-executable-5f11f49f932b';
const proposalId = 'acct-00008-p01';
const runId = 'run-mtsy5p5e-a40498d2-2f9c-406c-8834-c49c6e81b652';
const auditRef = 'run-records/2026-09-07-longzu1-full-rebuild/incident-2026-09-09-batch54/recovery-proof.json';
const reason = 'Host verified both failed inputs (24 distinct units): 20 covered by successful p12, and 4 by the complete immutable p01 version successfully recorded before the conflicting calls. Exact successful audit inputs/results, consumed pages, full stored decisions and dependency hashes verified. No failed payload is accepted and no executable semantics are certified.';

async function build() {
  const status = await inspectCompilerStatus(root, sourceId);
  const source = status.sources[0]!;
  assert.equal(source.sourceIntegrity, 'verified');
  assert.equal(source.completedBatches, 53);
  assert.equal(source.nextUncheckpointedBatch, batchId);
  assert.deepEqual(source.obligations.map(x => [x.batchId, x.proposalId]), [[batchId, proposalId]]);
  const journal = new CompilerProposalObligations(root, sourceId, batchId);
  const history = journal.history('account_source_units', proposalId);
  assert.deepEqual(history.map(a => a.status), ['running', 'succeeded', 'running', 'failed', 'running', 'failed']);
  const failures = history.filter(a => a.status === 'failed');
  assert.deepEqual(failures.map(a => a.inputHash), [
    '861f0ea9cf8cb99ebc8f4437e90bcd753d682ba8d30c3a10287d1392a48822f8',
    '7b6b94aa0e62da483bfce9df2ac1ba1ed3732e8082f2f704e00ca842307f959d',
  ]);
  const pages = new CompilerAccountingPages(root, sourceId, batchId);
  const segments = await readAccountingBatchSegments(root, sourceId, batchId);
  const segmentIds = segments.map(s => s.id);
  const structure = await new SourceStructureStore(root).read(sourceId);
  assert(structure);
  const byId = new Map(baseStructuralUnits(structure).map(u => [u.id, u]));
  const requested = new Set<string>();
  const tokens: string[] = [];
  const traces = new TraceStore(root);
  assert.equal((await traces.peekRun(runId)).sourceId, sourceId);
  const events = await traces.peekEvents(runId);
  for (const [index, attempt] of failures.entries()) {
    const call = events.find(e => e.seq === [404, 809][index])!;
    const result = events.find(e => e.seq === call.seq + 1)!;
    assert.equal(contentHash(await traces.peekBlob(call.blobRef!)), contentHash(attempt.input));
    assert.equal(result.type, 'tool.call.failed');
    assert.equal(result.toolCallId, call.toolCallId);
    const failedResult = await traces.peekBlob(result.blobRef!);
    assert(JSON.stringify(failedResult).includes(attempt.diagnostic));
    const input = attempt.input as { page_token?: string; decisions?: Array<{ unit_id: string }> };
    if (input.page_token) {
      const page = pages.read(input.page_token)!;
      assert.equal(page.sourceSha256, source.sourceSha256);
      assert.deepEqual(page.segmentIds, segmentIds);
      page.unitIds.forEach(id => requested.add(id));
      tokens.push(page.token);
    } else input.decisions!.forEach(d => requested.add(d.unit_id));
  }
  assert.equal(requested.size, 24);
  const dependencies = [];
  const covered = new Map();
  for (const [id, seq] of [[proposalId, 182], ['acct-00008-p12', 431]] as const) {
    const call = events.find(e => e.seq === seq)!;
    const result = events.find(e => e.seq === seq + 1)!;
    assert.equal(call.type, 'tool.call.started');
    assert.equal(call.data?.toolName, 'account_source_units');
    assert.equal(result.type, 'tool.call.completed');
    assert.equal(result.data?.isError, false);
    assert.equal(result.toolCallId, call.toolCallId);
    assert.equal(result.parentSpanId, call.parentSpanId);
    const input = await traces.peekBlob(call.blobRef!) as {
      proposal_id: string; page_token: string; page_default: { status: string; reason: string }; page_overrides?: unknown;
    };
    assert.equal(input.proposal_id, id);
    assert.equal(input.page_overrides, undefined);
    const page = pages.read(input.page_token)!;
    assert.equal(page.consumedBy, id);
    assert.equal(page.sourceSha256, source.sourceSha256);
    assert.deepEqual(page.segmentIds, segmentIds);
    const output = await traces.peekBlob(result.blobRef!) as { details: { proposalId: string; unitIds: string[] } };
    assert.equal(output.details.proposalId, id);
    assert.deepEqual(output.details.unitIds, page.unitIds);
    const success = journal.history('account_source_units', id).find(a => a.status === 'succeeded' && contentHash(a.input) === contentHash(input));
    assert(success);
    if (id === proposalId) assert(success.updatedAt < failures[0]!.updatedAt);
    else assert.equal(journal.history('account_source_units', id).at(-1)?.status, 'succeeded');
    const proposal = await new SourceAccountingStore(root).readProposal(sourceId, 'pending', id);
    assert.equal(proposal.compilerBatchId, batchId);
    assert.equal(proposal.sourceId, sourceId);
    assert(proposal.createdAt >= call.observedAt && proposal.createdAt <= result.observedAt);
    assert.deepEqual(proposal.decisions, page.unitIds.map(unitId => ({ unitId, ...input.page_default })));
    assert.equal(input.page_default.status, 'background-only');
    const dependency = { store: 'accounting' as const, proposalId: id, contentHash: contentHash(proposal) };
    dependencies.push({ dependency, successfulInputHash: call.blobRef!.sha256, successfulResultHash: result.blobRef!.sha256, pageToken: page.token });
    for (const decision of proposal.decisions) {
      if (!requested.has(decision.unitId)) continue;
      assert(!covered.has(decision.unitId));
      const unit = byId.get(decision.unitId)!;
      assert(unit && unit.kind !== 'non-scene');
      assert(segments.some(s => unit.anchor.startByte >= s.startByte && unit.anchor.endByte <= s.endByte));
      covered.set(unit.id, { unitId: unit.id, unitHash: contentHash(unit), dependency, kind: 'decision', coverageId: unit.id });
    }
  }
  assert.equal(covered.size, 24);
  const proof = accountingCoverageProofSchema.parse({
    version: 1, sourceId, sourceSha256: source.sourceSha256, batchId, proposalId,
    failedInputHashes: failures.map(a => a.inputHash).sort(),
    units: [...covered.values()].sort((a, b) => a.unitId.localeCompare(b.unitId)),
    originalPageTokens: tokens, auditRefs: [auditRef, `${runId}:success=182,431:failure=404,809`],
    verifiedAt: new Date().toISOString(),
  });
  assert.equal(accountingCoverageProofFailure(root, proof), undefined);
  return { proof, dependencies, historyHash: contentHash(history), checkpointIds: source.completedBatchIds };
}

if (process.argv.includes('--apply')) {
  const reviewed = JSON.parse(await fs.readFile(path.join(directory, 'recovery-proof.json'), 'utf8'));
  await withWorkspaceOperationLock(root, 'compiler', async () => {
    const current = await build();
    assert.deepEqual({ ...current, proof: { ...current.proof, verifiedAt: reviewed.proof.verifiedAt } }, reviewed);
    const journal = new CompilerProposalObligations(root, sourceId, batchId);
    const before = journal.history('account_source_units', proposalId);
    journal.recordCoverageSettlement(current.proof, reason, auditRef);
    assert.deepEqual(journal.history('account_source_units', proposalId).slice(0, -1), before);
    assert.deepEqual(journal.unresolved(), []);
    const status = await inspectCompilerStatus(root, sourceId);
    assert.deepEqual(status.sources[0]!.completedBatchIds, current.checkpointIds);
    await fs.writeFile(path.join(directory, 'recovery-applied.json'), JSON.stringify({ appliedAt: new Date().toISOString(), reason, proof: current.proof }, null, 2) + '\n');
    console.log('Applied exact 24-unit coverage settlement; failure history retained; checkpoints unchanged.');
  });
} else {
  const result = await build();
  await fs.writeFile(path.join(directory, 'recovery-proof.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('Verified preview: 24 units; 4 covered by original successful p01, 20 by p12. No compiler state changed.');
}

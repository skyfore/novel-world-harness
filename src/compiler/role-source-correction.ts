import { contentHash } from '../world/canonical.js';
import { CompilerProposalObligations, type ProposalAttempt } from './proposal-obligations.js';
import { ROLE_SOURCE_WORK_TOOL, ROLE_SOURCE_NOTES_MAX_BYTES, roleSourceNotesSchema, roleWorkStop, type RoleSourceWork } from './role-review-work.js';

/** A host-selected correction consumes the ordinary remaining attempt. It grants
 * no extra proposal retries, context handoffs or model budget. */
export function sourceNotesCorrection(attempts: ProposalAttempt[], binding: { workId: string; failedInputHash: string }, planHash: string): RoleSourceWork {
  const failure = attempts[0];
  if (attempts.length !== 1 || !failure || failure.status !== 'failed' || failure.tool !== ROLE_SOURCE_WORK_TOOL
    || failure.proposalId !== binding.workId || failure.inputHash !== binding.failedInputHash
    || CompilerProposalObligations.identity(failure.tool, failure.input).inputHash !== failure.inputHash) {
    throw roleWorkStop('source note correction requires the exact sole unresolved failed input');
  }
  const input = failure.input as { planHash?: string; payload?: unknown };
  const parsed = roleSourceNotesSchema.safeParse(input.payload);
  if (input.planHash !== planHash || !parsed.success
    || Buffer.byteLength(JSON.stringify(parsed.data)) <= ROLE_SOURCE_NOTES_MAX_BYTES) {
    throw roleWorkStop('source note correction only handles total output size, not semantic or scope failures');
  }
  return parsed.data;
}

/** Text may be rewritten by Pi, but no finding, evidence binding or question slot
 * may disappear during a size correction. Evidence is delivered separately. */
export function assertSourceNotesCorrection(original: RoleSourceWork, corrected: RoleSourceWork) {
  const bindings = (value: RoleSourceWork) => value.findings.map(f => ({ name: f.name, unitIds: f.unitIds }));
  if (contentHash(bindings(original)) !== contentHash(bindings(corrected)) || original.openQuestions.length !== corrected.openQuestions.length) {
    throw new Error('Source note size correction must preserve every finding in order, its exact name and unitIds, and every open-question slot in order. Only shorten wording without changing meaning; correct once within the original allowance, otherwise stop.');
  }
}

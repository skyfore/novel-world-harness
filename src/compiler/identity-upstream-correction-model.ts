import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import type { IdentitySessionContract } from "./identity-session-integrity.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const usage = z.object({ modelCalls: z.number().int().nonnegative(), totalPayloadBytes: z.number().int().nonnegative() }).strict();
export const IDENTITY_CORRECTION_STAGE = "singleton-correction";
export const IDENTITY_CORRECTION_LIMITS = Object.freeze({ maxModelCalls: 4, maxRequestBytes: 512_000, maxTotalPayloadBytes: 2_048_000 });
export const identityCorrectionContract: IdentitySessionContract = { terminalTool: "submit_identity_upstream_correction",
  readTools: ["read_identity_upstream_correction"], receipt: "retained" };
export const identityCorrectionIntentSchema = z.object({
  version: z.literal(1), policy: z.literal("initial-world-field-evidence-correction/v1"), planHash: hash, taskId: hash,
  target: z.object({ kind: z.literal("initial-world"), id: z.literal("singleton") }).strict(),
  failedAttemptRef: hash, failedSessionRef: hash, proposalId: z.string().min(1), authorizationRef: z.string().trim().min(1),
  originalBudgetHash: hash, originHash: hash, priorUsage: usage, limits: z.object({ maxModelCalls: z.literal(4),
    maxRequestBytes: z.literal(512_000), maxTotalPayloadBytes: z.literal(2_048_000) }).strict(),
  failureRecordHash: hash, originalInputHash: hash, contextHash: hash, toolContractHash: hash, traceHash: hash,
  ledgerPrefix: z.object({ length: z.number().int().positive(), head: hash }).strict(),
  retainedFiles: z.array(z.object({ path: z.string().min(1), hash }).strict()).min(1),
}).strict();
export type IdentityCorrectionIntent = z.infer<typeof identityCorrectionIntentSchema>;
export async function readIdentityCorrectionIntent(directory: string) {
  try { return identityCorrectionIntentSchema.parse(JSON.parse(await fs.readFile(path.join(directory, "correction.intent.json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
/** The original slots keep their budgets. The one explicit correction is an
 * additional charged stage before acceptance, never a replacement allowance. */
export async function identityUpstreamBudgetStages(directory: string, order: { id: string }[]) {
  const intent = await readIdentityCorrectionIntent(directory), stages = order.map(t => t.id);
  if (intent) {
    if (stages.at(-1) !== intent.target.id) throw prerequisiteStop("Correction lost its original final slot; no reordered budgets or retry");
    stages.push(IDENTITY_CORRECTION_STAGE);
  }
  return [...stages, "acceptance"];
}
/** The host does not author selectors. Pi may correct only the failed evidence
 * bindings, preserving its original payload, source scope and proposal ID. */
export function validateIdentityEvidenceCorrection(original: unknown, corrected: unknown) {
  const shape = z.object({ proposal_id: z.string().min(1), payload: z.unknown(), evidence_segment_ids: z.array(z.string()),
    evidence_selectors: z.array(z.unknown()).min(1) }).strict();
  const before = shape.parse(original), after = shape.parse(corrected);
  const { evidence_selectors: oldEvidence, ...oldFields } = before, { evidence_selectors: newEvidence, ...newFields } = after;
  if (contentHash(oldFields) !== contentHash(newFields) || contentHash(oldEvidence) === contentHash(newEvidence))
    throw prerequisiteStop("Correction must change only evidence_selectors of the exact failed proposal; preserve payload, source and ID, no unchanged or expanded retry");
  return after;
}

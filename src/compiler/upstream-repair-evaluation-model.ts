import { z } from "zod";
import { requirementResultSchema } from "./requirement-result.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const UPSTREAM_REPAIR_EVALUATOR_VERSION = "upstream-repair-v1";
export const upstreamRepairEvaluationSchema = z.object({
  version: z.literal(1), evaluatorVersion: z.literal(UPSTREAM_REPAIR_EVALUATOR_VERSION),
  planHash: hash, requirementSetHash: hash, receiptFingerprint: hash, convergenceRef: hash,
  subjectSnapshotHash: hash, result: requirementResultSchema,
}).strict();
export type UpstreamRepairEvaluation = z.infer<typeof upstreamRepairEvaluationSchema>;

/** Keep authority/budget inputs, excluding derived events and their chain hashes. */
export function upstreamRepairSnapshotInputs<T extends { upstreamRepairJournal?: readonly { payload: { kind: string } }[] }>(snapshot: T) {
  const { upstreamRepairJournal, ...inputs } = snapshot;
  return { ...inputs, ...(upstreamRepairJournal?.length ? { upstreamRepairInputVersion: 1,
    upstreamRepairInputs: upstreamRepairJournal.filter(record => !["evaluated", "evaluation-invalidated"].includes(record.payload.kind)).map(record => record.payload),
  } : {}) };
}

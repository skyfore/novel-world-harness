import fs from "node:fs/promises";
import path from "node:path";
import { contentHash } from "../world/canonical.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { identityRequirementDirectory } from "./identity-requirements.js";
import type { ConsumerRevalidationRecord, ConsumerRevalidationScope } from "./identity-consumer-revalidation-model.js";
import { readConsumerWorkRecordEvidence, readConsumerWorkRecordPlan } from "./consumer-work-evidence.js";
import { CONSUMER_EVIDENCE_COVERAGE, consumerEvidenceCoverage, consumerEvidenceSubjects, consumerEvidenceStop, additionalConsumerEvidenceSubjects } from "./consumer-evidence-coverage.js";

const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));

/** Discovery is a snapshot, never a grant. New correction preparation first
 * verifies both actual original records, then binds this exact omitted-read
 * proof and both remaining budgets through the existing correction lineage. */
export async function inspectConsumerEvidenceGap(root: string, scope: ConsumerRevalidationScope, records: ConsumerRevalidationRecord[]) {
  const [proposal, check] = records;
  if (records.length !== 2 || scope.compilerCorrection || !scope.executionPolicy
    || proposal?.output.phase !== "consumer-revalidation" || proposal.output.disposition !== "blocked"
    || check?.output.phase !== "consumer-revalidation-check" || check.output.verdict !== "supported") return undefined;
  const source = await (await WorkspaceStore.create(root)).getSource(scope.sourceId);
  if (!source || source.contentSha256 !== scope.sourceHash) throw consumerEvidenceStop("Original review source is missing or changed");
  const bytes = await readSourceMaterial(root, source);
  const context = await read(path.join(identityRequirementDirectory(root, scope.sourceId, scope.taskId), "context.json"));
  const stages = [];
  for (const record of records) {
    const stage = record.output.phase, { plan } = await readConsumerWorkRecordPlan(root, record);
    // A resumed execution already owns its original remaining allowance. It is
    // still inspectable, but cannot also mint a separate evidence correction.
    if (plan.evidenceCoverage || record.bindingRecoveryHash || record.providerResumptionHash) return undefined;
    const { raw, reads } = await readConsumerWorkRecordEvidence(root, record);
    const delivered = new Set([...plan.sources.map(s => s.id), ...reads.sourceIds]);
    const coverage = consumerEvidenceCoverage(scope.sourceId, bytes, context.manifest.segments,
      [...consumerEvidenceSubjects(plan.baseInput, plan.artifacts), ...additionalConsumerEvidenceSubjects(reads.artifacts)]);
    const missingSegmentIds = coverage.segmentIds.filter(id => !delivered.has(id));
    // A check that actually read the cited original text cannot be relabelled
    // as a delivery failure simply because its semantic verdict was negative.
    if (!missingSegmentIds.length) return undefined;
    stages.push({ stage, planHash: contentHash(plan), messagesHash: contentHash(raw), coverage, missingSegmentIds });
  }
  return { policy: CONSUMER_EVIDENCE_COVERAGE, sourceId: scope.sourceId, sourceHash: scope.sourceHash,
    scopeHash: contentHash(scope), stages };
}

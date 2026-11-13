import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeContext, type Tool } from "@earendil-works/pi-ai";
import { losslessContextInstructions, losslessJsonContext } from "../agent/lossless-json-context.js";
import { contentHash } from "../world/canonical.js";
import type { ModelRequestBudgetState, ModelRequestLimits } from "../runtime/model-request-budget.js";
import type { ConsumerArtifact } from "./identity-consumer-artifacts.js";
import { artifactRef } from "./identity-consumer-artifacts.js";
import type { consumerRevalidationInput } from "./identity-consumer-revalidation.js";
import type { ConsumerRevalidationScope } from "./identity-consumer-revalidation-model.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { CONSUMER_REVIEW_CORRECTION } from "./consumer-review-contract.js";
import type { CONSUMER_REVIEW_BINDING } from "./consumer-review-binding.js";
import { CONSUMER_EVIDENCE_COVERAGE, consumerEvidenceCoverage, consumerEvidenceSubjects, type ConsumerEvidenceCoverage } from "./consumer-evidence-coverage.js";

export const CONSUMER_WORK_POLICY = "consumer-work/v1" as const;
export const CONSUMER_WORK_PREFLIGHT = "pi-message-context/v1" as const;
export const consumerWorkDirectory = (directory: string) => path.join(directory, "execution-v1");
export const consumerWorkProviderDirectory = (directory: string, stage: string) => path.join(directory, `${stage}.provider-resumption`);
export const consumerWorkContract = { terminalTool: "submit_consumer_revalidation",
  readTools: ["read_consumer_revalidation", "preview_consumer_revalidation"], receipt: "retained" as const, allowCorrectedSubmission: true };
export const consumerWorkBudgetPolicy = { modelCallsMode: "progress", requestBytesMode: "enforce", totalBytesMode: "observe" } as const;
export const consumerReviewRecoveryBudgetPolicy = { modelCallsMode: "enforce", requestBytesMode: "enforce", totalBytesMode: "enforce" } as const;
export const workBudgetPolicy = (plan: ConsumerWorkPlan) => plan.budgetPolicy ?? consumerWorkBudgetPolicy;
export const CONSUMER_WORK_LIMITS: ModelRequestLimits = Object.freeze({ maxModelCalls: 12, maxRequestBytes: 512_000, maxTotalPayloadBytes: 12_288_000 });
export type ConsumerWorkBaseInput = ReturnType<typeof consumerRevalidationInput> & { capability?: unknown };
export type RetainedWorkFile = { path: string; hash: string };
export type WorkSegment = { id: string; startByte: number; endByte: number };
export type ConsumerWorkPlan = {
  version: 1; policy: typeof CONSUMER_WORK_POLICY; scopeHash: string; stage: "consumer-revalidation" | "consumer-revalidation-check";
  workKey: string; scenario: "local-consumer" | "cross-segment" | "shared-dependencies";
  limits: ModelRequestLimits; priorUsage: { modelCalls: number; totalPayloadBytes: number };
  budgetPolicy?: typeof consumerReviewRecoveryBudgetPolicy;
  retainedFiles: RetainedWorkFile[]; authorizationRef: string;
  priorReadFailures: string[];
  reviewBinding?: typeof CONSUMER_REVIEW_BINDING;
  bindingRecoveryHash?: string;
  providerResumptionHash?: string;
  providerResumption?: { originalSessionId: string; cause?: "owner-exited"; draft?: unknown; requiredSourceSegmentIds: string[]; requiredArtifactRefs: string[];
    requiredArtifactRevisions?: Array<{ ref: string; revisionHash: string }> };
  evidenceCoverage?: ConsumerEvidenceCoverage;
  baseInput: ConsumerWorkBaseInput; artifacts: ConsumerArtifact[];
  sources: Array<WorkSegment & { text: string; textHash: string }>;
};

/** These fields are mechanical inventories. Their full ordered values stay in
 * the frozen plan; every semantic field (including all candidates) stays visible. */
export const inventoryManifest = (values: readonly unknown[]) => ({ policy: "ordered-inventory/v1", count: values.length, hash: contentHash(values) });
export function consumerArtifactView(artifact: ConsumerArtifact) {
  if (contentHash(artifact.payload) !== artifact.revisionHash) throw prerequisiteStop("Work dependency payload changed; inspect its exact revision, no dispatch or retry");
  if (artifact.evidenceRole !== "retained-role-roster") return { payload: artifact.payload };
  if (!artifact.payload || typeof artifact.payload !== "object" || Array.isArray(artifact.payload))
    throw prerequisiteStop("Retained roster has no exact object payload; no work projection or retry");
  const payload = { ...artifact.payload } as Record<string, unknown>, inventories: Record<string, ReturnType<typeof inventoryManifest>> = {};
  for (const field of ["unitIds", "extractionRunIds"]) {
    const value = payload[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every(v => typeof v === "string")) throw prerequisiteStop("Roster inventory is not an ordered ID list; no projection or retry");
    inventories[field] = inventoryManifest(value); delete payload[field];
  }
  return { payload, inventories, viewPolicy: "roster-semantic-view/v1" };
}

export function consumerWorkInput(plan: ConsumerWorkPlan) {
  const { denominator, ...base } = plan.baseInput;
  return { ...base, denominator: { total: denominator.total, refs: inventoryManifest(denominator.refs),
    candidateIds: inventoryManifest(denominator.candidateIds), sourcePages: inventoryManifest(denominator.sourcePages),
    originalQuestionIds: denominator.originalQuestionIds },
    ...(plan.evidenceCoverage ? { requiredSourceSegmentIds: plan.sources.map(s => s.id), evidenceCoverage: plan.evidenceCoverage } : {}),
    ...(plan.providerResumptionHash ? { providerResumption: { ...plan.providerResumption, hash: plan.providerResumptionHash,
      instructions: (plan.providerResumption?.cause === "owner-exited" ? "The original host exited before any response or tool execution. The sent request remains charged; provider usage is unknown. " : "The original read-only stage ended in a provider quota refusal. ")
        + "Re-read any listed evidence not in this packet. If a draft is supplied, independently confirm and preview that exact draft, then submit it unchanged in a separate response; stop if it cannot be confirmed. Historical draft/read receipts do not grant semantic support. No progress renewal or second continuation." } } : {}),
    artifactReadRefs: plan.artifacts.map(artifact => ({ ref: artifactRef(artifact), revisionHash: artifact.revisionHash,
      current: artifact.current, aliases: artifact.aliases ?? [], delivery: "initial-evidence-packet",
      ...(artifact.evidenceRole ? { evidenceRole: artifact.evidenceRole } : {}) })),
    execution: { policy: plan.policy, workKey: plan.workKey, scenario: plan.scenario, limits: plan.limits,
      ...(plan.reviewBinding ? { reviewBinding: plan.reviewBinding, contractHashField: "input.reviewContractHash", previewCorrectionsRemaining: plan.bindingRecoveryHash ? 0 : 1 } : {}),
      ...(plan.bindingRecoveryHash ? { bindingRecoveryHash: plan.bindingRecoveryHash, originalFailureRetained: true, progressRenewal: false } : {}),
      budgetPolicy: workBudgetPolicy(plan), priorUsage: plan.priorUsage,
      readCorrectionAvailable: plan.priorReadFailures.length === 0,
      instructions: "The complete sources and dependencies below are already delivered in this session. Do not reread them for bookkeeping. Inspect originals for meaning; inventory hashes prove coverage, not semantic support. Preview a grounded draft, then submit it in a separate sole-tool turn. Reads and repeated previews never renew the progress window. Keep one response for submission. Unknown original requirements remain blocked." },
    evidencePacket: { sources: plan.sources, artifacts: plan.artifacts.map(artifact => ({ ref: artifactRef(artifact),
      revisionHash: artifact.revisionHash, current: artifact.current, ...consumerArtifactView(artifact) })) } };
}

export function createConsumerWorkPlan(args: {
  limits?: ModelRequestLimits;
  scope: ConsumerRevalidationScope; stage: ConsumerWorkPlan["stage"]; input: ConsumerWorkBaseInput; catalog: ConsumerArtifact[];
  bytes: Uint8Array; segments: WorkSegment[]; priorUsage: ConsumerWorkPlan["priorUsage"];
  retainedFiles?: RetainedWorkFile[]; authorizationRef?: string; extraSources?: string[]; extraArtifacts?: string[];
  priorReadFailures?: string[];
  reviewBinding?: typeof CONSUMER_REVIEW_BINDING;
  evidencePolicy?: typeof CONSUMER_EVIDENCE_COVERAGE;
}): ConsumerWorkPlan {
  const boundedCorrection = args.scope.compilerCorrection?.policy === CONSUMER_REVIEW_CORRECTION || args.scope.compilerCorrection?.policy === CONSUMER_EVIDENCE_COVERAGE;
  if (boundedCorrection && !args.limits)
    throw prerequisiteStop("Review-scope recovery needs the predecessor's exact remaining allowance; no default budget or retry");
  if (!boundedCorrection && args.limits && contentHash(args.limits) !== contentHash(CONSUMER_WORK_LIMITS))
    throw prerequisiteStop("Consumer work cannot change its original execution allowance; no new window or retry");
  if (createHash("sha256").update(args.bytes).digest("hex") !== args.scope.sourceHash || args.input.scopeHash !== contentHash(args.scope))
    throw prerequisiteStop("Work plan source or scope changed; inspect the original source/task/ref, no dispatch or retry");
  const sourceIds = new Set([...args.input.requiredSourceSegmentIds, ...args.extraSources ?? []]);
  const refs = new Set([...args.input.artifactReadRefs.map(r => r.ref), ...args.extraArtifacts ?? []]);
  const proposal = args.input.proposal;
  if (proposal?.phase === "consumer-revalidation") {
    proposal.evidence.forEach(e => sourceIds.add(e.segment_id));
    for (const repair of [proposal.initialWorldRepair, proposal.entityRepair]) if (repair) {
      repair.segmentIds.forEach(id => sourceIds.add(id)); repair.readableRefs.forEach(r => refs.add(`${r.kind}:${r.id}`));
    }
  }
  const artifacts = new Map<string, ConsumerArtifact>();
  for (const ref of refs) {
    const artifact = args.catalog.find(c => ref === artifactRef(c) || ref === `${c.kind}/${c.id}` || c.aliases?.includes(ref));
    if (!artifact) throw prerequisiteStop(`Missing planned dependency ${ref}. Inspect the same source/task/ref artifactReadRefs[].ref; correct once from exact discovery, never guess or dispatch an incomplete packet`);
    consumerArtifactView(artifact); artifacts.set(artifactRef(artifact), artifact);
  }
  const coverage = args.evidencePolicy ? consumerEvidenceCoverage(args.scope.sourceId, args.bytes, args.segments,
    consumerEvidenceSubjects(args.input, [...artifacts.values()])) : undefined;
  coverage?.segmentIds.forEach(id => sourceIds.add(id));
  const sources = [...sourceIds].sort().map(id => {
    const segment = args.segments.find(s => s.id === id);
    if (!segment || !Number.isSafeInteger(segment.startByte) || !Number.isSafeInteger(segment.endByte)
      || segment.startByte < 0 || segment.endByte <= segment.startByte || segment.endByte > args.bytes.byteLength)
      throw prerequisiteStop(`Invalid complete source range ${id}; inspect the same source manifest, no guessed range or retry`);
    const text = Buffer.from(args.bytes).subarray(segment.startByte, segment.endByte).toString("utf8");
    return { id, startByte: segment.startByte, endByte: segment.endByte, text, textHash: contentHash(text) };
  });
  return { version: 1, policy: CONSUMER_WORK_POLICY, scopeHash: contentHash(args.scope), stage: args.stage,
    ...(args.reviewBinding ? { reviewBinding: args.reviewBinding } : {}),
    workKey: contentHash({ scopeHash: contentHash(args.scope), stage: args.stage, policy: CONSUMER_WORK_POLICY }),
    scenario: [...artifacts.values()].some(c => c.evidenceRole === "retained-role-roster") ? "shared-dependencies" : sources.length > 1 ? "cross-segment" : "local-consumer",
    limits: { ...(args.limits ?? CONSUMER_WORK_LIMITS) },
    ...(boundedCorrection ? { budgetPolicy: consumerReviewRecoveryBudgetPolicy } : {}),
    ...(coverage ? { evidenceCoverage: coverage } : {}),
    priorUsage: { ...args.priorUsage }, retainedFiles: args.retainedFiles ?? [],
    priorReadFailures: args.priorReadFailures ?? [],
    authorizationRef: args.authorizationRef ?? args.scope.authorizationRef, baseInput: structuredClone(args.input),
    artifacts: structuredClone([...artifacts.values()].sort((a, b) => artifactRef(a).localeCompare(artifactRef(b)))), sources };
}

/** Reserve room for tools, provider framing and a bounded draft before paying
 * for generation. This is admission, not a guarantee that reasoning will fit. */
export function consumerWorkPreflight(plan: ConsumerWorkPlan, prompt: string, toolSchemas: Tool[]) {
  const input = JSON.stringify(consumerWorkInput(plan)), inputBytes = Buffer.byteLength(input);
  // Size the same complete JSON envelope and system/tool context that Pi sends.
  // Raw input size can falsely reject exact repeated evidence, while ignoring
  // JSON escaping can undercount it. Runtime context and payload gates remain.
  const transport = losslessJsonContext(normalizeContext({ messages: [
    { role: "system", content: losslessContextInstructions + prompt, toolsAdded: toolSchemas, timestamp: 0 },
    { role: "user", content: input, timestamp: 0 },
  ] }), consumerWorkContract.readTools, "message/v1").receipt;
  const overheadBytes = 16_384; // provider framing beyond the measured context
  const draftReserveBytes = 32_768, requiredBytes = transport.encodedBytes + overheadBytes + draftReserveBytes;
  const ready = requiredBytes <= plan.limits.maxRequestBytes && plan.limits.maxModelCalls >= 2;
  return { policy: plan.policy, measurementPolicy: CONSUMER_WORK_PREFLIGHT, planHash: contentHash(plan), scenario: plan.scenario,
    inputBytes, transport: { ...transport, dictionaryProfile: "message/v1" as const }, overheadBytes, draftReserveBytes,
    ...(plan.evidenceCoverage ? { evidenceCoverage: { policy: plan.evidenceCoverage.policy,
      sourceSegmentIds: plan.sources.map(s => s.id), subjectCount: plan.evidenceCoverage.subjects.length }, limits: plan.limits, budgetPolicy: workBudgetPolicy(plan) } : {}),
    requiredBytes, maxRequestBytes: plan.limits.maxRequestBytes, minimumModelCalls: 2,
    status: ready ? "ready" : "context-blocked", modelDispatchAllowed: ready, independentCheckRequired: true,
    reason: ready ? "Complete evidence fits with a draft/submission reserve; additional exploration remains bounded."
      : "Complete evidence and submission reserve do not fit. Inspect this same work plan's sources and artifacts; preserve its full coverage and split through a new host-validated plan. Do not dispatch, truncate evidence or retry unchanged." };
}

/** Reconstruct the finite progress window from sealed live messages, not from
 * model self-reports or the mutable latest draft file. */
export function verifyConsumerWorkProgress(plan: ConsumerWorkPlan, state: ModelRequestBudgetState, messages: Array<{ role: string; content?: unknown; toolName?: string; isError?: boolean }>) {
  if (plan.budgetPolicy) {
    const calls = messages.filter(m => m.role === "assistant").length;
    if (calls !== state.usage.modelCalls || calls > plan.limits.maxModelCalls || state.progress)
      throw prerequisiteStop("Review-scope recovery exceeded or reset its remaining call allowance; no renewed progress window or retry");
    return;
  }
  let calls = 0, lastProgressCall = 0;
  const milestones: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      if (calls - lastProgressCall >= plan.limits.maxModelCalls) throw prerequisiteStop("Work transcript exceeded its verified no-progress window; no registration or retry");
      calls++;
    }
    if (message.role === "toolResult" && !message.isError && message.toolName === "preview_consumer_revalidation") {
      const content = message.content as Array<{ type: string; text?: string }>;
      const preview = content.find(c => c.type === "text")?.text;
      if (preview && JSON.parse(preview).valid === true && !milestones.length) {
        milestones.push(`draft:${plan.workKey}`); lastProgressCall = calls;
      }
    }
  }
  if (state.usage.modelCalls !== calls || contentHash(state.progress) !== contentHash({ lastProgressCall, milestones }))
    throw prerequisiteStop("Work progress differs from its original validated draft and actual calls; preserve the budget, no reset or retry");
}

export function consumerWorkFailure(reason: string, budgetCode?: string) {
  const kind = /usage limit has been reached|quota|rate.?limit|429/i.test(reason) ? "external-wait"
    : budgetCode === "no-progress" ? "no-progress"
    : budgetCode === "request-size" || /context.*(length|limit|large)/i.test(reason) ? "context-blocked"
    : /without a revalidation submission/.test(reason) ? "unsubmitted" : "host-review";
  return { kind, retryable: false, semanticVerdict: "not-established", preservedUsage: true,
    recovery: kind === "external-wait" ? "Wait for the original provider to become available. Inspect requirements inspect-identity-repairs in this same source/task/ref; copy execution.providerResumptionCandidate scopeHash, stage and failedTraceRunId for a later-authorized --provider-resumption JSON, then --resume-unsubmitted inspect before run. Correct an ID once from discovery only. Submitted, unsettled, changed, hard-stopped or already resumed stages cannot restart. No automatic polling, provider fallback or budget reset."
      : "Inspect the same source/task/ref retained plan, draft, failure and stage receipts. Recover sealed registration without generation; otherwise stop for a bounded host plan. Never rename a consumed stage or discard prior charges." };
}

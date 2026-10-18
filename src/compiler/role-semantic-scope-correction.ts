import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { contentHash } from "../world/canonical.js";
import { TraceStore } from "../trace/store.js";
import { ModelRequestBudget } from "../runtime/model-request-budget.js";
import { WorkspaceOperationLock } from "../util/workspace-lock.js";
import { RequirementLedger } from "./requirement-ledger.js";
import { prepareCoreRoleDependencyReview, type RoleDependencyReviewInput } from "./role-dependency-review-service.js";
import type { RoleDependencyReview } from "./role-dependency-review.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { SegmentStore } from "./segments.js";
import { resolveTextSelectorAnchor } from "./text-anchors.js";
import { roleSemanticScopeDirectory, semanticScopePlanSchema, semanticScopeSelectors, inspectSemanticScopePlan,
  semanticScopeCorrectionSchema, SEMANTIC_SCOPE_LIMITS, semanticScopeView, type SemanticScopeCorrection } from "./role-semantic-scope.js";

const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const exists = async (file: string) => fs.lstat(file).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return false; throw e; });
function stop(reason: string): never { throw prerequisiteStop(`Semantic scope correction: ${reason}`); }
export const semanticScopeCorrectionDirectory = (root: string, review: RoleDependencyReview) => path.join(roleSemanticScopeDirectory(root, review.taskId, review.scope.sourceId), "correction");
export const semanticScopeCorrectionStage = "semantic-scope-correction";

/** A host-only, explicitly authorized envelope correction, never a new semantic task/grant.
 * The failed trace and every consumed file remain immutable. No normalized proposal is produced. */
export async function prepareSemanticScopeCorrection(root: string, input: RoleDependencyReviewInput, authorizationRef: string, forDispatch = true) {
  if (!authorizationRef.trim()) stop("explicit user authorization is required");
  const prepared = await prepareCoreRoleDependencyReview(root, input), { review } = prepared;
  const directory = roleSemanticScopeDirectory(root, review.taskId, review.scope.sourceId);
  const owner = (await WorkspaceOperationLock.inspect(root)).owner;
  if (owner && owner.pid !== process.pid) stop("another compiler owner exists; inspect on its owning host, do not retry");
  const parent = await read(path.resolve(directory, "../../..", "state.json"));
  if (parent.phase !== "BREAK" || parent.childPid !== null || sha(Buffer.from(JSON.stringify(parent))) !== review.scope.parentStateHash) stop("original parent BREAK changed");
  const state = await read(path.join(directory, "state.json"));
  if (state.phase !== "BREAK" || state.childPid !== null || state.stage !== "semantic-scope-plan" || state.taskId !== review.taskId
    || state.revisionHash !== review.revisionHash || state.parentStateHash !== review.scope.parentStateHash
    || state.sourceId !== review.scope.sourceId || state.sourceHash !== review.scope.sourceHash) stop("original failed scope is not settled");
  const names = await fs.readdir(directory);
  const failureNames = names.filter(n => n.startsWith("semantic-scope-plan.failure-"));
  if (failureNames.length !== 1 || !/^semantic-scope-plan\.failure-submission-[a-f0-9]{64}\.json$/.test(failureNames[0]!)
    || names.includes("semantic-scope-plan.proposal.json") || names.includes("semantic-scope-plan.record.json")) stop("one rejected original submission is required; an accepted/ambiguous stage cannot be corrected");
  if (forDispatch && (await exists(path.join(semanticScopeCorrectionDirectory(root, review), "start.json")) || names.some(n => n.startsWith("semantic-scope-check.")))) stop("correction or original independent check already consumed");
  const failure = await read(path.join(directory, failureNames[0]!)), original = semanticScopePlanSchema.parse(failure.raw);
  if (contentHash(original) !== contentHash(failure.raw) || !String(failure.error).includes("ROLE_PREREQUISITE_HOST_REVIEW")) stop("failed input was transformed or lacks its original host stop");
  const originalInput = await read(path.join(directory, "semantic-scope-plan.input.json"));
  const invocation = await read(path.join(directory, "semantic-scope-plan.invocation.json")), budget = await read(path.join(directory, "semantic-scope-plan.budget.json"));
  if (contentHash(originalInput.review) !== contentHash(semanticScopeView(review)) || original.revisionHash !== review.revisionHash
    || invocation.taskId !== review.taskId || invocation.revisionHash !== review.revisionHash || invocation.phase !== "semantic-scope-plan"
    || budget.taskId !== review.taskId || budget.phase !== "semantic-scope-plan" || budget.originalBudgetHash !== review.scope.originalBudgetHash
    || contentHash(budget.limits) !== contentHash(SEMANTIC_SCOPE_LIMITS) || budget.state.blocked) stop("original input, invocation or cumulative budget changed");
  // Construction validates persisted usage without writing or increasing its ceiling.
  new ModelRequestBudget(SEMANTIC_SCOPE_LIMITS, { initial: budget.state, save: () => {} });
  if (budget.state.usage.modelCalls >= SEMANTIC_SCOPE_LIMITS.maxModelCalls || budget.state.usage.totalPayloadBytes >= SEMANTIC_SCOPE_LIMITS.maxTotalPayloadBytes) stop("no remaining original budget");
  const traces = new TraceStore(root), run = await traces.peekRun(state.traceRunId), events = await traces.peekEvents(state.traceRunId);
  if (forDispatch && (await traces.peekRuns({ status: "running", limit: 100 })).length) stop("another trace is unsettled");
  const requests = events.filter(e => e.type === "llm.request.started"), payloads = events.filter(e => e.type === "llm.request.payload");
  const starts = events.filter(e => e.type === "tool.call.started" && e.data?.toolName === "submit_role_semantic_scope");
  const failures = events.filter(e => e.type === "tool.call.failed"), provenance = events.filter(e => e.type === "stage.started" && e.data?.phase === "role-semantic-scope-session");
  if (run.status !== "failed" || !run.endedAt || run.sourceId !== review.scope.sourceId || run.counts.retries
    || run.operationId !== `role-semantic-scope-${review.taskId}-semantic-scope-plan`
    || !requests.length || requests.length !== run.counts.llmRequests || requests.length !== budget.state.usage.modelCalls
    || payloads.length !== budget.state.usage.payloads || payloads.some(e => !e.blobRef)
    || payloads.reduce((n, e) => n + e.blobRef!.byteLength, 0) !== budget.state.usage.totalPayloadBytes
    || requests.some(e => e.data?.providerId !== "openai-codex" || e.data?.modelId !== "gpt-6.1-sol")
    || starts.length !== 1 || failures.length !== 1 || failures[0]!.toolCallId !== starts[0]!.toolCallId
    || provenance.length !== 1 || provenance[0]!.data?.inputHash !== contentHash(originalInput) || provenance[0]!.data?.revisionHash !== review.revisionHash
    || provenance[0]!.data?.subscription !== true || typeof provenance[0]!.data?.sessionId !== "string"
    || events.some(e => e.type === "llm.response.failed" || e.type.startsWith("world.commit."))) stop("failed trace or its charged Pi subscription provenance differs");
  if (!starts[0]!.blobRef || contentHash(await traces.peekBlob(starts[0]!.blobRef)) !== contentHash(original)) stop("retained failure is not the original Pi tool input");
  for (const request of requests) if (!request.callId || events.filter(e => e.type === "llm.response.completed" && e.callId === request.callId && e.seq > request.seq).length !== 1) stop("original provider request is not settled exactly once");
  const delivered = new Set<string>(), references = new Set<string>();
  for (const start of events.filter(e => e.type === "tool.call.started")) {
    const end = events.find(e => ["tool.call.completed", "tool.call.failed"].includes(e.type) && e.toolCallId === start.toolCallId && e.seq > start.seq);
    if (!end || !["read_semantic_source", "read_semantic_dependencies", "submit_role_semantic_scope"].includes(String(start.data?.toolName))) stop("original tool invocation is unsettled or outside read-only scope");
    if (end.type === "tool.call.completed" && end.seq < starts[0]!.seq) {
      if (!start.blobRef) stop("original read input missing");
      const args = await traces.peekBlob(start.blobRef) as { segmentIds?: string[]; refs?: string[] };
      if (start.data?.toolName === "read_semantic_source") args.segmentIds?.forEach(id => delivered.add(id));
      if (start.data?.toolName === "read_semantic_dependencies") args.refs?.forEach(id => references.add(id));
    }
  }
  if (contentHash(originalInput.specification) !== contentHash(prepared.prerequisites[0]!.output)
    || contentHash(originalInput.representation) !== contentHash(prepared.representations[0]!.output)
    || contentHash(originalInput.requiredSourceSegmentIds) !== contentHash(prepared.upstreamPlan.sourceScope.segmentIds)
    || prepared.upstreamPlan.sourceScope.segmentIds.some(id => !delivered.has(id))) stop("original required source/specification reads are incomplete");
  for (const op of original.operations) for (const ref of [...op.readableRefs, ...(op.baseline ? [op.baseline] : [])]) if (!references.has(`${ref.kind}:${ref.id}`)) stop("original dependency was not read");
  const manifest = await new SegmentStore(root).readManifest(review.scope.sourceId);
  for (const selector of semanticScopeSelectors(original)) {
    const segment = manifest?.segments.find(s => s.id === selector.segment_id);
    if (!segment || !delivered.has(segment.id)) stop("original evidence was not fully read");
    await resolveTextSelectorAnchor(root, segment, selector);
  }
  const issues = inspectSemanticScopePlan(original, review, prepared.prerequisites, prepared.representations, prepared.catalog, prepared.discovery.findings.map(f => f.findingId));
  const allowedPaths = issues.map(i => i.path);
  if (issues.length !== 4 || new Set(allowedPaths).size !== 4 || issues.some(i => i.category !== "scope")
    || allowedPaths.filter(p => p.endsWith("/pointers")).length !== 3 || allowedPaths.filter(p => p.endsWith("/baseline")).length !== 1) stop("exactly the three creation pointers and one predecessor baseline must be the only defects");
  for (const location of allowedPaths) {
    const match = /^\/operations\/(\d+)\/(pointers|baseline)$/.exec(location), operation = match ? original.operations[Number(match[1])] : undefined;
    if (!match || !operation || operation.mode !== "create" || operation.kind !== "entity-resolution") stop("correction escapes the original creation envelope");
    if (match[2] === "pointers" && contentHash(operation.pointers) !== contentHash(["/"])) stop("correction is not the retained root-pointer error");
    if (match[2] === "baseline" && (!operation.baseline || !operation.readableRefs.some(r => contentHash(r) === contentHash(operation.baseline))
      || JSON.parse(operation.payloadJson).supersedesResolutionId !== operation.baseline.id)) stop("predecessor is not already preserved by the unchanged payload and readableRefs");
  }
  const history = await new RequirementLedger(root, review.scope.sourceId).history();
  const pending = history.findIndex(r => r.payload.kind === "role-dependency-review" && r.payload.review.taskId === review.taskId);
  if (pending < 0 || history.slice(pending + 1).some(r => r.payload.kind !== "role-semantic-scope" || r.payload.record.taskId !== review.taskId)
    || (forDispatch && history.length !== pending + 1)) stop("original pending requirement prefix has changed or correction is consumed");
  const retainedNames = ["start.json", "state.json", "provider.json", "hooks.jsonl", "revision.json", "catalog.json", "discovery.json",
    "semantic-scope-plan.input.json", "semantic-scope-plan.invocation.json", "semantic-scope-plan.budget.json", failureNames[0]!].sort();
  const retainedFiles = [];
  for (const name of retainedNames) {
    const file = path.join(directory, name), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) stop("retained original file is redirected or not a regular file");
    retainedFiles.push({ name, sha256: sha(await fs.readFile(file)) });
  }
  const authority = semanticScopeCorrectionSchema.parse({ version: 1, policy: "role-semantic-creation-scope-correction/v1",
    taskId: review.taskId, revisionHash: review.revisionHash, authorizationRef,
    failedTraceRunId: run.id, failedSessionId: provenance[0]!.data!.sessionId, failedTraceHash: contentHash(run), failedEventsHash: contentHash(events),
    failedSubmissionHash: contentHash(original), originalInputHash: contentHash(originalInput), originalInvocationHash: contentHash(invocation), originalBudgetHash: contentHash(budget),
    originalUsage: budget.state.usage, allowedPaths, requirementPrefix: { length: pending + 1, head: history[pending]!.hash }, retainedFiles });
  return { prepared, authority, original, originalBudget: budget };
}

/** Compares the entire Pi proposal, including exact payloadJson strings. No host rewrite. */
export function validateSemanticScopeCorrection(original: ReturnType<typeof semanticScopePlanSchema.parse>, corrected: ReturnType<typeof semanticScopePlanSchema.parse>, authority: SemanticScopeCorrection) {
  if (contentHash(original) !== authority.failedSubmissionHash || original.revisionHash !== authority.revisionHash) stop("original submission changed");
  const maskedOriginal = structuredClone(original), maskedCorrected = structuredClone(corrected);
  for (const location of authority.allowedPaths) {
    const match = /^\/operations\/(\d+)\/(pointers|baseline)$/.exec(location)!;
    const index = Number(match[1]), field = match[2] as "pointers" | "baseline", op = corrected.operations[index];
    if (!op || (field === "pointers" ? op.pointers.length !== 0 : op.baseline !== null)) stop(`uncorrected exact field ${location}`);
    // Mask only the allowed fields for equality; neither original nor output is changed.
    delete (maskedOriginal.operations[index] as unknown as Record<string, unknown>)[field];
    delete (maskedCorrected.operations[index] as unknown as Record<string, unknown>)[field];
  }
  if (contentHash(maskedOriginal) !== contentHash(maskedCorrected)) stop("Pi changed a payload, criterion, dependency, evidence or consumer field outside the four authorized paths");
}

export async function verifySemanticScopeCorrection(root: string, review: RoleDependencyReview, authority: SemanticScopeCorrection) {
  const current = await prepareSemanticScopeCorrection(root, { scope: review.scope, upstreamPlanHash: review.upstream.planHash, authorizationRef: review.authorizationRef }, authority.authorizationRef, false);
  const saved = await read(path.join(semanticScopeCorrectionDirectory(root, review), "intent.json"));
  if (contentHash(current.authority) !== contentHash(authority) || contentHash(saved) !== contentHash(authority)) stop("frozen correction intent, prior budget or failure history changed");
  return current;
}

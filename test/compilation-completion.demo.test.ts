import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { workspaceStateDir } from "../src/agent/runtime-paths.js";
import { compileNovelCommand, inspectNovelCompilation } from "../src/commands/compile-novel.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { compilationHandoff } from "../src/compiler/compilation-handoff.js";
import { compilationClosureReport, assertCompilationClosure } from "../src/compiler/compilation-closure.js";
import { identityReviewStatus } from "../src/compiler/identity-review-status.js";
import { inspectCompilerStatus } from "../src/compiler/status.js";
import * as compilerStatus from "../src/compiler/status.js";
import { reviewNovelRoles } from "../src/workflow/role-review.js";
import { auditCompiler } from "../src/compiler/audit.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { NovelCompilationRunStore } from "../src/workflow/novel-compilation.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { contentHash } from "../src/world/canonical.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { identityFixture } from "./helpers/identity-fixture.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-completion-demo-")); roots.push(root);
  const evidence = await createEvidenceFixture(root, "Ada waits in the hall.\nA visitor remains unidentified.\n");
  const batches = await prepareCompilerBatches(root, evidence.source);
  await new CompilerBatchStore(root).replaceCompleted(evidence.source.id, batches.map(b => b.id));
  return { root, ...evidence };
}
const emptyUpstream = { records: [], plans: [], attempts: [], modelSessions: [] };
async function snapshot(root: string) {
  const entries = await fs.readdir(root, { withFileTypes: true, recursive: true });
  return Promise.all(entries.filter(e => e.isFile()).map(async e => {
    const file = path.join(e.parentPath, e.name);
    return [file, contentHash((await fs.readFile(file)).toString("base64"))];
  }));
}
const roleWork = (planHash: string, current = true) => ({ planHash, current, batchId: "role-work", sourceWorks: 137, reviewedSources: 137,
  auditedSources: 0, stagedCandidates: 76, verifiedClaims: 76, blockedAudits: 137, openQuestions: 683,
  pendingClaimVerifications: 0, unauditedClaims: 0, claimFindings: [], auditContractRevisions: [], judgmentRevisions: [], verificationVersion: 2,
  staleSourceAudits: 0, staleClaimAudits: 0, sourceAuditRepairs: [{ page: 0, revisionId: "single-use-repair", predecessorWorkId: "original-audit",
    proposed: true, blockedProposal: true, verificationVerdict: null }] });

it("isolated completion demo retains false 100% checkpoints, saves every gate and never invokes a model or activates an archive", async () => {
  const { root, source, evidence } = await fixture();
  const model = vi.spyOn(PiAgentSession, "create");
  const before = await inspectNovelCompilation(root, source.id);
  expect(before.sources[0]!.batchReviewComplete).toBe(true);
  expect(before.sources[0]!.obligations).toEqual([]);
  await expect(compileNovelCommand({ root, sourceId: source.id, phase: "closure", onProgress() {} })).rejects.toThrow("COMPILATION_CLOSURE_BLOCKED");
  const run = (await new NovelCompilationRunStore(root).read(source.id))!;
  expect(run.completed).toBe(false);
  expect(run.closure).toMatchObject({ complete: false, certificationGranted: false });
  expect(run.closure!.gates.find(g => g.dimension === "batch-execution")!.refs.length).toBe(before.sources[0]!.totalBatches);
  expect(run.history.at(-1)).toMatchObject({ phase: "closure", status: "blocked" });
  const stored = await snapshot(workspaceStateDir(root));
  const after = await inspectNovelCompilation(root, source.id);
  expect(await snapshot(workspaceStateDir(root))).toEqual(stored);
  expect(after.sources[0]!.completedBatchIds).toEqual(before.sources[0]!.completedBatchIds);
  expect(after.compilation[0]!.handoff).toHaveProperty("closure.auditHash", run.closure!.auditHash);
  await new CanonicalModelStore(root).putEntity({ id: "ada", kind: "character", canonicalName: "Ada", aliases: [], evidence: evidence("Ada") });
  await new InitialWorldStore(root).put({ version: 1, evidence: evidence("Ada waits in the hall."), delta: { version: 1,
    operations: [{ op: "set", entityId: "ada", field: "character.alive", value: true }] } });
  await compileNovelCommand({ root, sourceId: source.id, phase: "archive", onProgress() {} });
  expect((await new NovelCompilationRunStore(root).read(source.id))!.bundleHash).toBeTruthy();
  expect(await new PreparedNovelCache(root).loadActive(source)).toBeNull();
  expect(model).not.toHaveBeenCalled();
});

it("handoff preserves a partial consumer denominator and blocks the exact consumed audit without counting a retired plan", async () => {
  const { root, source: document } = await fixture(), { records, intent } = identityFixture();
  const source = (await inspectCompilerStatus(root, document.id)).sources[0]!;
  source.roleReviewWork = [roleWork(contentHash("retired"), false), roleWork(intent.originalPlanHash)];
  source.identityReviews.tasks = [identityReviewStatus(records.slice(0, 4))];
  const original = contentHash({ source, records });
  const plan = compilationHandoff(source, null, emptyUpstream);
  expect(plan.currentRolePlanHashes).toEqual([intent.originalPlanHash]);
  expect(plan.retiredRolePlanHashes).toEqual([contentHash("retired")]);
  expect(plan.tasks.filter(t => t.kind === "identity-consumers")).toHaveLength(1);
  expect(plan.tasks.find(t => t.kind === "identity-consumers")).toMatchObject({ state: "blocked", execution: "inspect-only" });
  expect(plan.tasks.find(t => t.kind === "identity-consumers")!.reason).toContain("1/2 shards");
  expect(plan.tasks.find(t => t.id === "phase:roles")!.dependsOn).toContain(`identity:${intent.taskId}`);
  expect(plan.tasks.find(t => t.id === "phase:roles")!.state).toBe("blocked");
  expect(plan.tasks.find(t => t.kind === "source-audit")!.resumeCondition).toContain("single-use");
  expect(contentHash({ source, records })).toBe(original);
  source.roleReviewWork[1]!.current = false;
  expect(compilationHandoff(source, null, emptyUpstream).tasks.filter(t => t.kind === "identity-consumers")).toEqual([]);
});

it("100% accounting and zero execution obligations cannot close missing resolutions, deferrals or unknown dimensions", async () => {
  const { root, source: document } = await fixture();
  const status = await inspectCompilerStatus(root, document.id), source = status.sources[0]!, audit = await auditCompiler(root, { sourceId: document.id });
  const input = { source, audit, fingerprint: status.compilerFingerprint, unverifiedBatchIds: [], receiptErrors: [], requirementIssues: [],
    requirementHead: null, roleIssues: [], blockedUnitIds: ["critical-deferred-unit"], handoffBlockers: [] };
  // Independent fixture observations, not an override of production validators.
  audit.observations.accountedUnits = audit.observations.baseUnits;
  audit.observations.blockingUnits = 1;
  audit.readiness.accounting = "not-ready";
  audit.readiness.resolution = "not-ready";
  audit.resolutions.missingMentionIds = ["unresolved-mention"];
  audit.readiness.evidence = "unknown";
  const result = compilationClosureReport(input);
  expect(result.gates.find(g => g.dimension === "accounting")).toMatchObject({ state: "blocked", refs: ["critical-deferred-unit"] });
  expect(result.gates.find(g => g.dimension === "resolution")).toMatchObject({ state: "blocked", refs: ["unresolved-mention"] });
  expect(result.gates.find(g => g.dimension === "evidence")!.state).toBe("unknown");
  expect(() => assertCompilationClosure(result)).toThrow("COMPILATION_CLOSURE_BLOCKED");
  const previousHash = result.auditHash;
  audit.resolutions.missingMentionIds.push("changed-consumer");
  expect(compilationClosureReport(input).auditHash).not.toBe(previousHash);
});

it("an unavailable identity/role inspection remains a host prerequisite instead of permission for another model call", async () => {
  const { root, source: document } = await fixture();
  const source = (await inspectCompilerStatus(root, document.id)).sources[0]!;
  source.roleReviewInspection = "unknown";
  source.diagnostics.push("Original role journal unreadable");
  const plan = compilationHandoff(source, null, emptyUpstream);
  expect(plan.blockers).toContain("inspection:role-dependencies");
  expect(plan.tasks.find(t => t.id === "phase:roles")!.state).toBe("blocked");
});

it("the formal role workflow stops before model dispatch on a retained negative audit", async () => {
  const { root, source: document } = await fixture();
  const status = await inspectCompilerStatus(root, document.id);
  status.sources[0]!.roleReviewWork = [roleWork(contentHash("current-role-plan"))];
  vi.spyOn(compilerStatus, "inspectCompilerStatus").mockResolvedValue(status);
  const review = vi.fn(async () => {}), before = await snapshot(workspaceStateDir(root));
  await expect(reviewNovelRoles({ root, sourceId: document.id }, review)).rejects.toThrow("COMPILATION_PREREQUISITES_BLOCKED");
  expect(review).not.toHaveBeenCalled();
  expect(await snapshot(workspaceStateDir(root))).toEqual(before);
});

it("a converged repair is routed to the existing requirement revalidation phase, never staged again", async () => {
  const { root, source: document } = await fixture();
  const source = (await inspectCompilerStatus(root, document.id)).sources[0]!;
  const upstream = { ...emptyUpstream, plans: [{ state: "converged", plan: { planHash: contentHash("plan"), requirementIds: ["requirement"] } }] };
  const plan = compilationHandoff(source, null, upstream as never);
  expect(plan.tasks.find(t => t.kind === "upstream-repair")).toMatchObject({ state: "pending", execution: "existing-phase",
    command: { args: ["compile-novel", "requirements", "--source", document.id] }, dependsOn: ["phase:repair"] });
  expect(plan.tasks.find(t => t.id === "phase:recover")!.dependsOn).toEqual(["phase:source"]);
  expect(plan.blockers).toEqual([]);
});

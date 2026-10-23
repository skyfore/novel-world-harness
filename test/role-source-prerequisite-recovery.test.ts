import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { runRoleSourcePrerequisites, rolePrerequisiteDirectory } from "../src/workflow/role-source-prerequisites.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { prerequisitePhases, prerequisiteTaskId, type PrerequisiteScope } from "../src/compiler/role-source-prerequisites.js";
import { verifyPrerequisiteTrace } from "../src/compiler/role-source-prerequisite-trace.js";
import { contentHash as h } from "../src/world/canonical.js";
import { withWorkspaceOperationLock } from "../src/util/workspace-lock.js";
import { TraceStore } from "../src/trace/store.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { mockPiProvider } from "./helpers/pi-provider.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture(sameResponsePhase?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prerequisite-recovery-")); roots.push(root);
  const source = await createEvidenceFixture(root, "Ada waits.\n" + "Rain falls on the empty road. ".repeat(20));
  const scope: PrerequisiteScope = { version: 1, policy: "role-source-prerequisites/v1", sourceId: source.source.id, sourceHash: source.source.contentSha256,
    planHash: h("plan"), auditRevisionId: h("original"), negativeProposalHash: h("negative"), retainedIssuesHash: h("retained"),
    originalBudgetHash: h("budget"), parentStateHash: h("BREAK"), authorizationRef: "Authorized test prerequisites",
    questions: [1, 2, 3].map(n => ({ questionId: h(n), planHash: h("plan"), page: 0, text: `Source boundary ${n}`, sourceUnitIds: [], impact: "critical" })) };
  const ledger = new RequirementLedger(root, scope.sourceId);
  await ledger.registerRoleQuestions(scope.questions);
  for (const q of scope.questions) await ledger.recordRoleQuestionDisposition(scope.planHash, h("audit"), { questionId: q.questionId, status: "blocked", rationale: "Original negative", basisUnitIds: ["unit"] });
  const directory = rolePrerequisiteDirectory(root, scope);
  let authenticated = true;
  const runtimeCreate = ModelRuntime.create.bind(ModelRuntime);
  vi.spyOn(ModelRuntime, "create").mockImplementation(async options => options?.authPath === getAgentDir() + "/auth.json"
    ? { checkAuth: async () => authenticated ? { type: "oauth" } : undefined,
      getProvider: () => ({ auth: { oauth: { isSubscription: true } } }), getModel: () => ({}) } as any
    : runtimeCreate(options));
  const create = PiAgentSession.create.bind(PiAgentSession);
  const transports: Awaited<ReturnType<typeof mockPiProvider>>[] = [];
  const createSpy = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
    const session = await create({ ...options, model: undefined, piAgentDir: path.join(root, `pi-${transports.length}`) });
    transports.push(await mockPiProvider(session, { provider: "openai-codex", modelId: "gpt-6.1-sol", response: (context, index) => {
      const user = context.messages.find(m => m.role === "user")!;
      const input = JSON.parse(typeof user.content === "string" ? user.content : (user.content[0] as { text: string }).text);
      const same = input.phase === sameResponsePhase;
      if (index === 0) return fauxAssistantMessage([fauxToolCall("read_prerequisite_source", { query: "Ada", offset: 0 }, { id: "discover-source" })], { stopReason: "toolUse" });
      if (index === (same ? 2 : 3)) return fauxAssistantMessage([fauxText("Submission complete.")]);
      if (index > 3) throw new Error("Unexpected additional request");
      const discovery = context.messages.find(m => m.role === "toolResult" && m.toolName === "read_prerequisite_source")!;
      const found = JSON.parse((discovery.content[0] as { text: string }).text).segments[0];
      const q = (questionId: string) => ({ questionId, impact: "critical", evidence: [{ segment_id: found.id, exact: "Ada waits." }] });
      const base = { phase: input.phase, scopeHash: input.scopeHash };
      const output = input.phase === "specification" ? { ...base, requirements: scope.questions.map(item => ({ ...q(item.questionId), kind: "identity",
        requirement: "Preserve uncertain identity", acceptanceCriteria: ["Do not guess"], evidenceBoundaries: ["Uncertainty remains"] })) }
        : input.phase === "binding" ? { ...base, specificationHash: input.specificationHash, discoveryHash: input.discoveryHash,
          bindings: scope.questions.map(item => ({ ...q(item.questionId), route: "missing-source-representation", findingIds: [], candidateIds: [], rationale: "No annotation", missingCondition: "Precise annotation" })) }
        : { ...base, proposalHash: input.proposalHash, judgments: scope.questions.map(item => ({ ...q(item.questionId), verdict: "supported", rationale: "Independent source verification" })) };
      const reads = [fauxToolCall("read_prerequisite_source", { segmentId: found.id, offset: 0 }, { id: "read" }),
        ...(input.phase.startsWith("binding") ? [fauxToolCall("discover_prerequisite_dependencies", { query: "Ada", offset: 0 }, { id: "dependencies" })] : [])];
      return fauxAssistantMessage(index === 1 ? [...reads, ...(same ? [fauxToolCall("submit_source_prerequisite", output, { id: "submit" })] : [])]
        : [fauxToolCall("submit_source_prerequisite", output, { id: "submit" })], { stopReason: "toolUse" });
    } }));
    return session;
  });
  return { root, scope, ledger, directory, transports, createSpy, auth: (value: boolean) => { authenticated = value; },
    run: () => runRoleSourcePrerequisites({ root, scope, directory, assertOriginal: async () => {} }),
    records: () => ledger.sourcePrerequisites(prerequisiteTaskId(scope)) };
}

it.each(prerequisitePhases)("rejects source reads and submission in one provider response during %s", async phase => {
  const f = await fixture(phase);
  await expect(f.run()).rejects.toThrow("no typed prerequisite result");
  expect(await f.records()).toHaveLength(prerequisitePhases.indexOf(phase));
  const last = f.transports.at(-1)!;
  expect(last.contexts[2]!.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "submit_source_prerequisite", isError: true }));
  const attempts = f.createSpy.mock.calls.length;
  await expect(f.run()).rejects.toThrow("consumed without a recoverable completed record");
  expect(f.createSpy).toHaveBeenCalledTimes(attempts);
}, 30_000);

it("does not consume a task on failed auth or lock admission; completed stages replay offline", async () => {
  const f = await fixture();
  await withWorkspaceOperationLock(f.root, "compiler", async () => {
    await expect(f.run()).rejects.toThrow("already active");
    await expect(fs.stat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  f.auth(false);
  await expect(f.run()).rejects.toThrow("provider unavailable");
  expect(f.createSpy).not.toHaveBeenCalled();
  await expect(fs.stat(path.join(f.directory, "start.json"))).rejects.toMatchObject({ code: "ENOENT" });
  f.auth(true);
  await f.run();
  const records = await f.records(), start = await fs.readFile(path.join(f.directory, "start.json"), "utf8");
  expect(records).toHaveLength(4);
  for (const record of records) await verifyPrerequisiteTrace(f.root, record);
  f.auth(false);
  await f.run();
  expect(await f.records()).toEqual(records);
  expect(await fs.readFile(path.join(f.directory, "start.json"), "utf8")).toBe(start);
  expect(f.transports).toHaveLength(4);
}, 30_000);

it.each([false, true])("recovers a ledger publication failure without rerunning the completed phase (already appended=%s)", async appended => {
  const f = await fixture();
  const publish = RequirementLedger.prototype.recordSourcePrerequisite;
  vi.spyOn(RequirementLedger.prototype, "recordSourcePrerequisite").mockImplementationOnce(async function (this: RequirementLedger, record, bytes) {
    if (appended) await publish.call(this, record, bytes);
    throw new Error("Injected publication failure");
  });
  await expect(f.run()).rejects.toThrow("Injected publication failure");
  expect(f.transports).toHaveLength(1);
  const saved = JSON.parse(await fs.readFile(path.join(f.directory, "specification.record.json"), "utf8"));
  expect((await new TraceStore(f.root).peekRun(saved.traceRunId)).status).toBe("succeeded");
  expect(await f.records()).toHaveLength(appended ? 1 : 0);
  await f.run();
  expect(await f.records()).toHaveLength(4);
  expect((await f.records())[0]).toEqual(saved);
  expect(f.transports).toHaveLength(4);
}, 30_000);

it("preserves consumed dispatch failures and refuses a new session", async () => {
  const f = await fixture();
  f.createSpy.mockRejectedValueOnce(new Error("Injected session setup failure"));
  await expect(f.run()).rejects.toThrow("Injected session setup failure");
  const marker = await fs.readFile(path.join(f.directory, "specification.invocation.json"), "utf8");
  await expect(f.run()).rejects.toThrow("consumed without a recoverable completed record");
  expect(f.createSpy).toHaveBeenCalledOnce();
  expect(await fs.readFile(path.join(f.directory, "specification.invocation.json"), "utf8")).toBe(marker);
});

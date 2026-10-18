import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { runRoleSourcePrerequisites, rolePrerequisiteDirectory } from "../src/workflow/role-source-prerequisites.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { prerequisiteTaskId, type PrerequisiteScope } from "../src/compiler/role-source-prerequisites.js";
import { contentHash } from "../src/world/canonical.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it.each([false, true])("runs isolated source-first stages, retaining blocks without retry (negative=%s)", async negative => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prerequisite-flow-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Ada waits."), h = contentHash;
  const scope: PrerequisiteScope = { version: 1, policy: "role-source-prerequisites/v1", sourceId: fixture.source.id, sourceHash: fixture.source.contentSha256,
    planHash: h("plan"), auditRevisionId: h("original"), negativeProposalHash: h("negative"), retainedIssuesHash: h("retained"),
    originalBudgetHash: h("used-budget"), parentStateHash: h("BREAK"), authorizationRef: "User authorizes source prerequisites",
    questions: [1, 2, 3].map(n => ({ questionId: h(n), planHash: h("plan"), page: 0, text: `Source boundary ${n}`, sourceUnitIds: [], impact: "critical" })) };
  const ledger = new RequirementLedger(root, scope.sourceId);
  await ledger.registerRoleQuestions(scope.questions);
  for (const q of scope.questions) await ledger.recordRoleQuestionDisposition(scope.planHash, h("audit"), { questionId: q.questionId, status: "blocked", rationale: "Original negative", basisUnitIds: ["unit"] });
  const originalHistory = await ledger.history();
  vi.spyOn(ModelRuntime, "create").mockResolvedValue({ checkAuth: async () => ({ type: "oauth" }),
    getProvider: () => ({ auth: { oauth: { isSubscription: true } } }), getModel: () => ({}) } as any);
  let sessions = 0;
  vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
    const id = `independent-${++sessions}`, trace = options.trace!.parent!.recorder, tools = options.additionalTools!;
    expect(options.includeLocalTools).toBe(false);
    expect(options.includeProjectInstructions).toBe(false);
    expect(options.autoCompaction).toBe(false);
    return { id, model: "openai-codex/gpt-6.1-sol", abort: async () => {}, dispose: async () => {}, async promptWithReport(raw: string) {
      const input = JSON.parse(raw), calls = { count: 0 };
      const invoke = async (name: string, args: unknown) => {
        // Provider tool arguments arrive as parsed JSON, without shared object references.
        const toolCallId = `call-${++calls.count}`, blobRef = await trace.putBlob(JSON.parse(JSON.stringify(args)));
        await trace.record("tool.call.started", { toolName: name }, undefined, { toolCallId, blobRef });
        const value = await tools.find(t => t.name === name)!.execute(toolCallId, args as any, undefined as any, undefined as any, undefined as any);
        await trace.record("tool.call.completed", { toolName: name }, undefined, { toolCallId });
        return value;
      };
      (options.requestBudget as any).beginCall({});
      (options.requestBudget as any).admitPayload(input);
      await trace.record("llm.request.started", { providerId: "openai-codex", modelId: "gpt-6.1-sol" }, undefined, { callId: "request" });
      await trace.record("llm.response.completed", {}, undefined, { callId: "request" });
      if (input.phase === "specification") {
        expect(input).not.toHaveProperty("proposal"); expect(input).not.toHaveProperty("discoveryHash");
        expect(tools.some(t => t.name === "discover_prerequisite_dependencies")).toBe(false);
      }
      await invoke("read_prerequisite_source", { segmentId: fixture.segmentId });
      if (input.phase.startsWith("binding")) await invoke("discover_prerequisite_dependencies", { query: "Ada" });
      const base = { phase: input.phase, scopeHash: input.scopeHash };
      const evidence = [{ segment_id: fixture.segmentId, exact: "Ada waits." }];
      const q = (questionId: string) => ({ questionId, impact: "critical", evidence });
      const output = input.phase === "specification" ? { ...base, requirements: scope.questions.map(item => ({ ...q(item.questionId), kind: "identity",
        requirement: "Preserve uncertain identity", acceptanceCriteria: ["Do not guess"], evidenceBoundaries: ["Uncertainty remains"] })) }
        : input.phase === "binding" ? { ...base, specificationHash: input.specificationHash, discoveryHash: input.discoveryHash,
          bindings: scope.questions.map(item => ({ ...q(item.questionId), route: "missing-source-representation", findingIds: [], candidateIds: [], rationale: "No matching annotation", missingCondition: "Precise annotation" })) }
        : { ...base, proposalHash: input.proposalHash, judgments: scope.questions.map(item => ({ ...q(item.questionId), verdict: negative ? "blocked" : "supported", rationale: "Independent source verification" })) };
      await invoke("submit_source_prerequisite", output);
      return { text: "" };
    } } as any;
  });
  const directory = rolePrerequisiteDirectory(root, scope), guard = vi.fn(async () => {});
  await runRoleSourcePrerequisites({ root, directory, scope, assertOriginal: guard });
  const state = JSON.parse(await fs.readFile(path.join(directory, "state.json"), "utf8"));
  expect(state.phase).toBe(negative ? "BREAK" : "DONE");
  expect(state.parentCompileResumeAllowed).toBe(false);
  expect(state.certificationGranted).toBe(false);
  expect(sessions).toBe(negative ? 2 : 4);
  const records = await ledger.sourcePrerequisites(prerequisiteTaskId(scope));
  expect(records).toHaveLength(sessions);
  expect(new Set(records.map(r => r.sessionId)).size).toBe(sessions);
  expect((await ledger.history()).slice(0, originalHistory.length)).toEqual(originalHistory);
  await expect(runRoleSourcePrerequisites({ root, directory, scope, assertOriginal: guard })).rejects.toThrow(/EEXIST/);
  await expect(runRoleSourcePrerequisites({ root, directory: path.join(root, "another"), scope, assertOriginal: guard })).rejects.toThrow(/attempt directory/);
  expect(sessions).toBe(negative ? 2 : 4);
});

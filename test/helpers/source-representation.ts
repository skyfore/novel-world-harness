import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiAgentSession } from "../../src/agent/pi-session.js";
import { runRoleSourcePrerequisites, rolePrerequisiteDirectory } from "../../src/workflow/role-source-prerequisites.js";
import { runSourceRepresentationReview, sourceRepresentationDirectory } from "../../src/workflow/source-representation.js";
import { RequirementLedger } from "../../src/compiler/requirement-ledger.js";
import { prerequisiteTaskId, type PrerequisiteScope } from "../../src/compiler/role-source-prerequisites.js";
import type { RepresentationScope } from "../../src/compiler/source-representation.js";
import { contentHash } from "../../src/world/canonical.js";
import { createEvidenceFixture } from "./evidence.js";

const roots: string[] = [], h = contentHash;
export async function cleanupRepresentationFixtures() { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); }
export async function representationFixture(options: { negative?: boolean; gap?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-representation-")); roots.push(root);
  const f = await createEvidenceFixture(root, "Ada waits."), selector = { segment_id: f.segmentId, exact: "Ada waits." };
  const original: PrerequisiteScope = { version: 1, policy: "role-source-prerequisites/v1", sourceId: f.source.id, sourceHash: f.source.contentSha256,
    planHash: h("plan"), auditRevisionId: h("original"), negativeProposalHash: h("negative"), retainedIssuesHash: h("issues"),
    originalBudgetHash: h("spent"), parentStateHash: h("BREAK"), authorizationRef: "Original user authorization",
    questions: [1, 2, 3].map(n => ({ questionId: h(n), planHash: h("plan"), page: 0, text: `Source boundary ${n}`, sourceUnitIds: [], impact: "critical" })) };
  const ledger = new RequirementLedger(root, original.sourceId);
  await ledger.registerRoleQuestions(original.questions);
  for (const q of original.questions) await ledger.recordRoleQuestionDisposition(original.planHash, h("audit"), { questionId: q.questionId, status: "blocked", rationale: "Original negative", basisUnitIds: ["unit"] });
  vi.spyOn(ModelRuntime, "create").mockResolvedValue({ checkAuth: async () => ({ type: "oauth" }), getProvider: () => ({ auth: { oauth: { isSubscription: true } } }), getModel: () => ({}) } as any);
  let sessions = 0;
  vi.spyOn(PiAgentSession, "create").mockImplementation(async opts => {
    const id = `independent-${++sessions}`, trace = opts.trace!.parent!.recorder, tools = opts.additionalTools!;
    expect(opts.includeProjectInstructions).toBe(false); expect(opts.includeLocalTools).toBe(false); expect(opts.autoCompaction).toBe(false);
    return { id, model: "openai-codex/gpt-6.1-sol", abort: async () => {}, dispose: async () => {}, async promptWithReport(raw: string) {
      const input = JSON.parse(raw); let call = 0;
      const invoke = async (name: string, args: unknown) => {
        const toolCallId = `call-${++call}`, blobRef = await trace.putBlob(JSON.parse(JSON.stringify(args)));
        await trace.record("tool.call.started", { toolName: name }, undefined, { toolCallId, blobRef });
        const value = await tools.find(t => t.name === name)!.execute(toolCallId, args as any, undefined as any, undefined as any, undefined as any);
        await trace.record("tool.call.completed", { toolName: name }, undefined, { toolCallId });
        return JSON.parse((value.content[0] as { text: string }).text);
      };
      (opts.requestBudget as any).beginCall({}); (opts.requestBudget as any).admitPayload(input);
      await trace.record("llm.request.started", { providerId: "openai-codex", modelId: "gpt-6.1-sol" }, undefined, { callId: "request" });
      await trace.record("llm.response.completed", {}, undefined, { callId: "request" });
      const base = { phase: input.phase, scopeHash: input.scopeHash }, evidence = [selector];
      const q = (questionId: string) => ({ questionId, impact: "critical", evidence });
      if (!input.phase.startsWith("representation")) {
        await invoke("read_prerequisite_source", { segmentId: f.segmentId });
        if (input.phase.startsWith("binding")) await invoke("discover_prerequisite_dependencies", { query: "Ada" });
        await opts.beforeModelRequest?.();
        await trace.record("llm.request.started", { providerId: "openai-codex", modelId: "gpt-6.1-sol" }, undefined, { callId: "submission-request" });
        await trace.record("llm.response.completed", {}, undefined, { callId: "submission-request" });
        const output = input.phase === "specification" ? { ...base, requirements: original.questions.map(item => ({ ...q(item.questionId), kind: "identity", requirement: "Preserve unknown attribution", acceptanceCriteria: ["Do not guess"], evidenceBoundaries: ["Unknown remains"] })) }
          : input.phase === "binding" ? { ...base, specificationHash: input.specificationHash, discoveryHash: input.discoveryHash, bindings: original.questions.map(item => ({ ...q(item.questionId), route: "missing-source-representation", findingIds: [], candidateIds: [], rationale: "Absent source frame", missingCondition: "Unknown voice observation" })) }
          : { ...base, proposalHash: input.proposalHash, judgments: original.questions.map(item => ({ ...q(item.questionId), verdict: "supported", rationale: "Independent source check" })) };
        await invoke("submit_source_prerequisite", output);
      } else {
        await invoke("read_representation_source", { segmentIds: [f.segmentId] });
        const { anchors } = await invoke("read_representation_source", { selectors: evidence });
        await invoke("read_representation_annotations", { offset: 0 });
        const annotationId = input.allocatedSlots[0].id;
        const output = input.phase === "representation-plan" ? { ...base, catalogHash: input.catalogHash,
          annotations: [{ slot: 1, payload: { version: 1, id: annotationId, sourceId: f.source.id, derivation: input.derivation,
            annotationType: "discourse-segment", kind: "unclassified", anchors: [anchors[0].anchor], confidence: 0, interpretation: "Voice remains unknown" } }],
          readableAnnotationIds: [], boundaries: original.questions.map(item => ({ questionId: item.questionId, kind: "voice-attribution", status: "unresolved", fromAnnotationIds: [annotationId], toAnnotationIds: [], rationale: "No speaker inferred", evidence })),
          coverage: original.questions.map((item, index) => ({ ...q(item.questionId), originalStatus: "blocked", criteria: [{ index: 0, status: options.gap ? "gap" : "represented", annotationIds: [annotationId], boundaryIndexes: [index], rationale: "Unknown preserved" }] })) }
          : { ...base, proposalHash: input.proposalHash, judgments: original.questions.map(item => ({ questionId: item.questionId, verdict: options.negative ? "blocked" : "supported", rationale: "Independent exact source check", evidence })) };
        await invoke("submit_source_representation", output);
      }
      return { text: "" };
    } } as any;
  });
  await runRoleSourcePrerequisites({ root, directory: rolePrerequisiteDirectory(root, original), scope: original, assertOriginal: async () => {} });
  const prerequisites = await ledger.sourcePrerequisites(prerequisiteTaskId(original)), before = await ledger.history();
  const scope: RepresentationScope = { version: 1, taskId: prerequisiteTaskId(original), prerequisiteScope: original,
    prerequisiteRecordHashes: prerequisites.map(h), authorizationRef: "User authorizes filling exact source repair scopes" };
  const directory = sourceRepresentationDirectory(root, scope), args = { root, directory, scope, assertOriginal: async () => {} };
  await runSourceRepresentationReview(args);
  return { root, f, ledger, prerequisites, before, scope, directory, args, sessions: () => sessions,
    records: await ledger.sourceRepresentations(scope.taskId), state: JSON.parse(await fs.readFile(path.join(directory, "state.json"), "utf8")) };
}

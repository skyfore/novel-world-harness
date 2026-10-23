import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { contentHash } from "../src/world/canonical.js";
import { checkPrerequisiteOutput, prerequisiteNextStep, prerequisiteTaskId, validatePrerequisiteHistory,
  type PrerequisiteScope, type PrerequisiteRecord, type PrerequisiteOutput } from "../src/compiler/role-source-prerequisites.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { TraceRecorder } from "../src/trace/recorder.js";
import { TraceStore } from "../src/trace/store.js";
import { withWorkspaceOperationLock } from "../src/util/workspace-lock.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const h = (value: unknown) => contentHash(value);
const scope: PrerequisiteScope = { version: 1, policy: "role-source-prerequisites/v1", sourceId: "source", sourceHash: h("bytes"),
  planHash: h("plan"), auditRevisionId: h("original-audit"), negativeProposalHash: h("negative"), retainedIssuesHash: h("issues"),
  parentStateHash: h("BREAK"), originalBudgetHash: h("consumed"), authorizationRef: "new prerequisite work only",
  questions: [1, 2, 3].map(i => ({ questionId: h(i), planHash: h("plan"), page: 0, text: `Source boundary ${i}`, sourceUnitIds: [], impact: "critical" })) };
const selector = { segment_id: "segment", exact: "Ada waits." };
const anchor = textAnchorForByteRange("source", Buffer.from(selector.exact), 0, Buffer.byteLength(selector.exact));
function specification(s = scope): PrerequisiteOutput {
  return { phase: "specification", scopeHash: h(s), requirements: s.questions.map(q => ({ questionId: q.questionId, impact: "critical",
    kind: "identity", requirement: "Preserve the source identity boundary", acceptanceCriteria: ["Do not infer a named identity from adjacency"],
    evidenceBoundaries: ["Unknown remains explicit"], evidence: [selector] })) };
}
function record(output: PrerequisiteOutput, previous: PrerequisiteRecord[] = [], s = scope): PrerequisiteRecord {
  const items = "requirements" in output ? output.requirements : "judgments" in output ? output.judgments : output.bindings;
  return { taskId: prerequisiteTaskId(s), scope: s, phase: output.phase, inputHash: h(output.phase), output,
    evidence: items.flatMap(item => item.evidence.map(sel => ({ selector: sel, anchor: { ...anchor, sourceId: s.sourceId } }))),
    traceRunId: `run-${output.phase}`, sessionId: `session-${output.phase}`, provider: "openai-codex", model: "gpt-6.1-sol", subscription: true,
    predecessorRecordHash: previous.length ? h(previous.at(-1)) : null };
}
function check(previous: PrerequisiteRecord[], verdict: "supported" | "blocked" = "supported"): PrerequisiteRecord {
  return record({ phase: previous.length === 1 ? "specification-check" : "binding-check", scopeHash: h(scope), proposalHash: h(previous.at(-1)!.output),
    judgments: scope.questions.map(q => ({ questionId: q.questionId, impact: "critical", verdict, rationale: "Independent source check", evidence: [selector] })) }, previous);
}

it("does not mint a new attempt when authorization wording or budget metadata changes", () => {
  expect(prerequisiteTaskId({ ...scope, authorizationRef: "another label", originalBudgetHash: h("different") })).toBe(prerequisiteTaskId(scope));
  expect(prerequisiteTaskId({ ...scope, questions: scope.questions.slice(0, 1) })).toBe(prerequisiteTaskId(scope));
  const first = record(specification());
  expect(() => validatePrerequisiteHistory([first, first])).toThrow(/identity/);
});
it("rejects omitted questions, scope drift and synthetic findings", () => {
  const spec = specification();
  expect(() => checkPrerequisiteOutput({ ...spec, requirements: [] }, scope, "specification", [])).toThrow();
  expect(() => checkPrerequisiteOutput({ ...spec, scopeHash: h("other") }, scope, "specification", [])).toThrow(/scope/);
  const original = record(spec), previous = [original, check([original])], discovery = { findings: [], candidateRefs: [] };
  const binding = { phase: "binding", scopeHash: h(scope), specificationHash: h(spec), discoveryHash: h(discovery),
    bindings: scope.questions.map(q => ({ questionId: q.questionId, impact: "critical", route: "existing-typed-finding", findingIds: [h("invented")],
      candidateIds: [], rationale: "unsupported", missingCondition: "", evidence: [selector] })) };
  expect(() => checkPrerequisiteOutput(binding, scope, "binding", previous, discovery)).toThrow(/Unknown/);
});
it("requires a fresh independent session and halts on a negative specification review", () => {
  const first = record(specification()), rejected = check([first], "blocked");
  expect(prerequisiteNextStep([first, rejected])).toBe("blocked");
  expect(() => validatePrerequisiteHistory([first, { ...rejected, sessionId: first.sessionId }])).toThrow(/reused/);
  const binding = record({ phase: "binding", scopeHash: h(scope), specificationHash: h(first.output), discoveryHash: h({}), bindings: [] }, [first, rejected]);
  expect(() => validatePrerequisiteHistory([first, rejected, binding])).toThrow();
});
it("supported missing-condition mapping remains host review, never repair authorization", () => {
  const first = record(specification()), accepted = check([first]);
  const binding = record({ phase: "binding", scopeHash: h(scope), specificationHash: h(first.output), discoveryHash: h({}),
    bindings: scope.questions.map(q => ({ questionId: q.questionId, impact: "critical", route: "missing-source-representation",
      findingIds: [], candidateIds: [], rationale: "Typed boundary is absent", missingCondition: "Source annotation required", evidence: [selector] })) }, [first, accepted]);
  const all = [first, accepted, binding]; all.push(check(all));
  expect(prerequisiteNextStep(all)).toBe("host-authorization-review");
  expect(() => validatePrerequisiteHistory([...all, all[3]!])).toThrow();
  expect(() => validatePrerequisiteHistory([{ ...first, evidence: [] }])).toThrow();
});

async function persistedFixture(deliverReads = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-prerequisite-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, selector.exact), ledger = new RequirementLedger(root, fixture.source.id);
  const bound = { ...scope, sourceId: fixture.source.id, sourceHash: fixture.source.contentSha256 };
  await ledger.registerRoleQuestions(bound.questions);
  for (const q of bound.questions) await ledger.recordRoleQuestionDisposition(bound.planHash, h("original-audit"), { questionId: q.questionId, status: "blocked", rationale: "Retained negative", basisUnitIds: ["unit"] });
  const output = specification(bound);
  if (output.phase !== "specification") throw Error("fixture");
  output.requirements.forEach(r => { r.evidence = [{ segment_id: fixture.segmentId, exact: selector.exact }]; });
  const r = record(output, [], bound), trace = await TraceRecorder.start(new TraceStore(root), { kind: "prepare", sourceId: bound.sourceId,
    operationId: `prerequisite-${r.taskId}-${r.phase}` });
  r.traceRunId = trace.manifest.id;
  await trace.record("stage.started", { phase: "source-prerequisite-session", sessionId: r.sessionId, scopeHash: h(bound), inputHash: r.inputHash, subscription: true });
  await trace.record("llm.request.started", { providerId: "openai-codex", modelId: "gpt-6.1-sol" }, undefined, { callId: "request" });
  await trace.record("llm.response.completed", {}, undefined, { callId: "request" });
  const readRef = await trace.putBlob({ segmentId: fixture.segmentId });
  await trace.record("tool.call.started", { toolName: "read_prerequisite_source" }, undefined, { toolCallId: "read", blobRef: readRef });
  await trace.record("tool.call.completed", { toolName: "read_prerequisite_source" }, undefined, { toolCallId: "read" });
  if (deliverReads) {
    await trace.record("llm.request.started", { providerId: "openai-codex", modelId: "gpt-6.1-sol" }, undefined, { callId: "submission-request" });
    await trace.record("llm.response.completed", {}, undefined, { callId: "submission-request" });
  }
  const blobRef = await trace.putBlob(output);
  await trace.record("tool.call.started", { toolName: "submit_source_prerequisite" }, undefined, { toolCallId: "submit", blobRef });
  await trace.record("tool.call.completed", { toolName: "submit_source_prerequisite" }, undefined, { toolCallId: "submit" });
  await trace.finish("succeeded");
  return { root, ledger, r, bytes: Buffer.from(selector.exact) };
}
it("persists review evidence without satisfying original questions or changing old records", async () => {
  const f = await persistedFixture(), before = await f.ledger.history();
  await withWorkspaceOperationLock(f.root, "compiler", () => f.ledger.recordSourcePrerequisite(f.r, f.bytes));
  const after = await new RequirementLedger(f.root, f.r.scope.sourceId).history();
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.at(-1)!.payload.kind).toBe("role-source-prerequisite");
  expect(await f.ledger.definitions()).toEqual([]);
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => f.ledger.recordSourcePrerequisite(f.r, f.bytes))).rejects.toThrow(/consumed/);
  await expect(f.ledger.assertJournalRestorable(after, Buffer.from("different"))).rejects.toThrow(/evidence/);
});
it("rejects forged model output or missing owning-host lock before publication", async () => {
  const f = await persistedFixture();
  await expect(f.ledger.recordSourcePrerequisite(f.r, f.bytes)).rejects.toThrow(/owning compiler lock/);
  const forged = structuredClone(f.r);
  if (forged.output.phase === "specification") forged.output.requirements[0]!.requirement = "Fabricated requirement";
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => f.ledger.recordSourcePrerequisite(forged, f.bytes))).rejects.toThrow(/actual Pi tool submission/);
  expect(await f.ledger.sourcePrerequisites(f.r.taskId)).toEqual([]);
});

it("rejects a historical submission whose sibling reads never reached the provider", async () => {
  const f = await persistedFixture(false);
  const before = await f.ledger.history();
  await expect(withWorkspaceOperationLock(f.root, "compiler", () => f.ledger.recordSourcePrerequisite(f.r, f.bytes)))
    .rejects.toThrow("not delivered to a model request");
  expect(await f.ledger.history()).toEqual(before);
});

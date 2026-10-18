import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { contentHash } from "../src/world/canonical.js";
import { SourceAnnotationStore } from "../src/compiler/annotations.js";
import { UpstreamRepairLedger } from "../src/compiler/upstream-repair-ledger.js";
import { prepareUpstreamRepairFinish } from "../src/compiler/upstream-repair-finish.js";
import { sourceUpstreamDirectory, verifySourceUpstreamAcceptance } from "../src/compiler/source-representation-acceptance.js";
import { runSourceRepresentationUpstream } from "../src/workflow/source-representation-upstream.js";
import { representationFixture, cleanupRepresentationFixtures } from "./helpers/source-representation.js";

afterEach(cleanupRepresentationFixtures);
it.each([false, true])("requires real isolated typed staging and acceptance before source-only finish (negative=%s)", async negative => {
  const f = await representationFixture(), plan = JSON.parse(await fs.readFile(path.join(f.directory, "upstream-plan.preview.json"), "utf8"));
  const before = await f.ledger.history(), sourceId = f.f.source.id;
  let sessions = 0;
  vi.mocked(PiAgentSession.create).mockImplementation(async opts => {
    const id = `upstream-${++sessions}`, trace = opts.trace!.parent!.recorder, tools = opts.additionalTools!;
    expect(opts.model).toBe("openai-codex/gpt-6.1-sol"); expect(opts.autoCompaction).toBe(false); expect(opts.requestBudget).toBeDefined();
    return { id, model: "openai-codex/gpt-6.1-sol", dispose: async () => {}, abort: async () => {}, async promptWithReport(raw: string) {
      const input = JSON.parse(raw); let n = 0;
      const invoke = async (name: string, args: unknown) => {
        const toolCallId = `call-${++n}`, blobRef = await trace.putBlob(JSON.parse(JSON.stringify(args)));
        await trace.record("tool.call.started", { toolName: name }, undefined, { toolCallId, blobRef });
        const value = await tools.find(t => t.name === name)!.execute(toolCallId, args as any, undefined as any, undefined as any, undefined as any);
        await trace.record("tool.call.completed", { toolName: name }, undefined, { toolCallId }); return value;
      };
      opts.requestBudget!.beginCall({}); opts.requestBudget!.admitPayload(input);
      await trace.record("llm.request.started", { providerId: "openai-codex", modelId: "gpt-6.1-sol" }, undefined, { callId: "request" });
      await trace.record("llm.response.completed", {}, undefined, { callId: "request" });
      if (input.phase === "upstream-acceptance") {
        const upstream = new UpstreamRepairLedger(f.root, sourceId);
        expect((await upstream.inspect()).plans[0]!.state).toBe("staging");
        expect(await new SourceAnnotationStore(f.root).list(sourceId)).toEqual([]);
        // There is no way to finish based on the prior representation-check alone.
        await expect(prepareUpstreamRepairFinish(f.root, sourceId, plan.planHash, { outcome: "complete",
          reviewed_segments: [{ segment_id: f.f.segmentId, disposition: "proposed", summary: "Missing acceptance must stop" }], summary: "No acceptance" })).rejects.toThrow(/acceptance.record/);
        await invoke("read_source_upstream_acceptance", { segmentIds: input.sourceSegmentIds });
        await invoke("submit_source_upstream_acceptance", { phase: input.phase, planHash: input.planHash, graphHash: input.graphHash,
          judgments: input.originalQuestions.map((q: any) => ({ questionId: q.questionId, verdict: negative ? "blocked" : "supported", rationale: "Source-only independent acceptance; original question remains blocked",
            evidence: [{ segment_id: f.f.segmentId, exact: "Ada waits." }] })) });
      } else {
        const reviewed = input.context.reviewedSourceAnnotation, payload = reviewed.payload;
        await invoke("propose_discourse_segment", { proposal_json: JSON.stringify({ proposal_id: input.proposalId, annotation_id: payload.id,
          kind: payload.kind, selectors: reviewed.selectors.map((s: any) => s.selector), confidence: payload.confidence, interpretation: payload.interpretation }) });
      }
      return { text: "" };
    } } as any;
  });
  const directory = sourceUpstreamDirectory(f.root, plan), args = { root: f.root, directory, plan, assertOriginal: async () => {} };
  if (negative) await expect(runSourceRepresentationUpstream(args)).rejects.toThrow(/negative/);
  else await runSourceRepresentationUpstream(args);
  expect(sessions).toBe(2);
  const state = JSON.parse(await fs.readFile(path.join(directory, "state.json"), "utf8"));
  expect(state.phase).toBe(negative ? "BREAK" : "DONE"); expect(state.parentCompileResumeAllowed).toBe(false); expect(state.certificationGranted).toBe(false);
  const store = new SourceAnnotationStore(f.root), upstream = await new UpstreamRepairLedger(f.root, sourceId).inspect();
  expect(upstream.plans[0]!.state).toBe(negative ? "staging" : "converged");
  expect(upstream.modelSessions).toHaveLength(1); expect(upstream.modelSessions[0]!.closed).toBe(true);
  expect((await store.list(sourceId))).toHaveLength(negative ? 0 : 1);
  expect((await store.listProposals(sourceId, "pending"))).toHaveLength(negative ? 1 : 0);
  expect((await f.ledger.history()).slice(0, before.length)).toEqual(before);
  expect((await f.ledger.history()).filter(r => r.payload.kind === "role-review-question-disposition").every(r => r.payload.kind === "role-review-question-disposition" && r.payload.disposition.status === "blocked")).toBe(true);
  await expect(runSourceRepresentationUpstream(args)).rejects.toThrow(/already reserved/); expect(sessions).toBe(2);
  if (!negative) {
    const accepted = await verifySourceUpstreamAcceptance(f.root, plan);
    expect(accepted.output.judgments.every(j => j.verdict === "supported")).toBe(true);
    const file = path.join(directory, "acceptance.record.json"), forged = structuredClone(accepted);
    forged.output.judgments[0]!.rationale = "Rewritten model judgment";
    await fs.writeFile(file, JSON.stringify(forged));
    await expect(verifySourceUpstreamAcceptance(f.root, plan)).rejects.toThrow(/input or proposal changed/);
    await fs.writeFile(file, JSON.stringify(accepted));
    const budgetFile = path.join(directory, "acceptance.budget.json"), budget = JSON.parse(await fs.readFile(budgetFile, "utf8"));
    budget.state.usage.modelCalls = 0;
    await fs.writeFile(budgetFile, JSON.stringify(budget));
    await expect(verifySourceUpstreamAcceptance(f.root, plan)).rejects.toThrow(/retained request budget changed/);
    expect(contentHash((await store.list(sourceId))[0])).toBe(contentHash((await store.readProposal(sourceId, "accepted", upstream.attempts[0]!.started.proposalId)).payload));
  }
});

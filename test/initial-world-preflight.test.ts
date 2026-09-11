import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initialWorldInputIssues } from "../src/compiler/initial-world-preflight.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { CompilerProposalObligations } from "../src/compiler/proposal-obligations.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
function payload() {
  return { version: 1, delta: { version: 1, operations: [] }, readerContext: {
    version: 1, focalActorId: "hero",
    facts: ["focal-identity", "time-place", "causal-premise", "actor-stance", "immediate-pressure"].map((kind, i) => ({
      id: `fact-${i}`, kind, summary: "Hero waits.", temporalClass: "at-checkpoint", basis: "source-narrator-established", entityIds: ["hero"],
      ...(kind === "actor-stance" ? { holderEntityId: "hero", stance: "negative" } : {}),
    })), entityGlosses: [], immediateSituation: { summary: "Hero waits.", causalFactIds: ["fact-2"], pressureFactIds: ["fact-4"], unresolvedFactIds: ["fact-4"], outcomePolicy: "withhold-post-checkpoint-outcomes" },
  } };
}
it("accepts omitted default arrays and aggregates the incident's independent shape failures", () => {
  const good = payload();
  expect(initialWorldInputIssues({ payload: good })).toEqual([]);
  const bad = payload();
  delete bad.readerContext.facts[3]!.holderEntityId;
  delete bad.readerContext.facts[3]!.stance;
  bad.readerContext.facts[2]!.kind = "completed-prior-beat";
  const issues = initialWorldInputIssues({ payload: bad, evidence_selectors: [{ relation: "explicit" }] }).join("\n");
  expect(issues).toContain("holderEntityId");
  expect(issues).toContain("stance");
  expect(issues).toContain("causal-premise");
  expect(issues).toContain("evidence_selectors");
});
it("exposes defaults and conditional requirements in the model input schema", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-opening-schema-")); roots.push(root);
  const toolset = createCompilerProposalToolset(root);
  const tool = toolset.tools.find(t => t.name === "propose_initial_world")!;
  const input = { proposal_id: "opening", payload: payload(), evidence_segment_ids: ["segment"] };
  expect(() => validateToolArguments(tool, { id: "call", name: tool.name, arguments: input })).not.toThrow();
  delete input.payload.readerContext.facts[3]!.stance;
  expect(() => validateToolArguments(tool, { id: "call", name: tool.name, arguments: input })).toThrow();
});
it("previews without staging or settling obligations and rejects unchanged retry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-opening-preview-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero waits.\n");
  const batchId = `opening-batch-${fixture.source.id}`;
  const toolset = createCompilerProposalToolset(root);
  await toolset.beginBatch([fixture.segmentId], batchId, fixture.source.id);
  const tool = toolset.tools.find(t => t.name === "preview_initial_world")!;
  const run = (input: unknown) => tool.execute("preview", input as never, undefined, undefined, {} as ExtensionContext);
  const bad = { proposal_id: "opening", payload: {}, evidence_segment_ids: [fixture.segmentId] };
  await expect(run(bad)).rejects.toThrow("preview validation failed");
  const good = { ...bad, payload: { version: 1, delta: { version: 1, operations: [] } } };
  await expect(run(good)).resolves.toMatchObject({ details: { readOnly: true, proposalStaged: false } });
  expect(new CompilerProposalObligations(root, fixture.source.id, batchId).unresolved()).toEqual([]);
  await expect(new CompilerProposalService(root).store.list("pending")).resolves.toEqual([]);
  await expect(run(good)).rejects.toThrow("requires host review");
});

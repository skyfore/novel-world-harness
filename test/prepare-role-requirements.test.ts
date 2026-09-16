import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareAllCommand } from "../src/commands/prepare-all.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { RequirementLedger } from "../src/compiler/requirement-ledger.js";
import { coreRoleAttemptScope } from "../src/compiler/requirement-attempts.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it("finishes two real independent reviews before the first semantic repair plan is opened", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-review-before-repair-")); roots.push(root);
  const source = await createEvidenceFixture(root, "Hero waits. A bell rings.");
  const canon = new CanonicalModelStore(root), evidence = source.evidence("Hero waits.");
  await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence });
  await new InitialWorldStore(root).put({ version: 1, delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] }, evidence });
  for (let index = 1; index <= 9; index++) await canon.putEvent({ id: `event-${index}`, title: `Event ${index}`, participants: [], storyTime: { kind: "ordinal", label: `beat ${index}`, orderHint: index }, preconditions: [], observedOutcome: { version: 1, operations: [] }, evidence, causalParents: [], confidence: 1 });
  const batches = await prepareCompilerBatches(root, source.source);
  await new CompilerBatchStore(root).replaceCompleted(source.source.id, batches.map(batch => batch.id));
  const calls: string[] = [];
  await expect(prepareAllCommand({ root, sourceId: source.source.id, yes: true, restoreCache: false, cacheRoot: path.join(root, "cache"), createBranch: false, onProgress() {} }, {
    compileInitialWorld: async options => {
      if (options.compilerBatchId?.startsWith("role-roster-")) {
        calls.push("review");
        const tools = createCompilerProposalToolset(root);
        await tools.beginBatch([], options.compilerBatchId, source.source.id);
        const call = (name: string, input: unknown) => tools.tools.find(tool => tool.name === name)!.execute(name, input as never, undefined, undefined, {} as never);
        const roster = JSON.parse(((await call("read_role_roster", { offset: 0 })).content[0] as { text: string }).text);
        const page = JSON.parse(((await call("read_roster_source_page", { page: 0 })).content[0] as { text: string }).text);
        await call("propose_role_roster_review", { subjectHash: roster.subjectHash, entries: [{ candidateId: roster.candidates[0].id, importance: "major", rationale: "Central source actor", basisUnitIds: page.unitIds, developmentExpectation: { kind: "unknown", rationale: "Short source does not establish development", basisUnitIds: page.unitIds } }] });
        await call("finish_compiler_batch", { outcome: "complete", reviewed_segments: [], summary: "Independent original-source review" });
        return;
      }
      calls.push("repair");
      expect(calls).toEqual(["review", "review", "repair"]);
      const definition = (await new RequirementLedger(root, source.source.id).coreRoleDefinitionHistory()).at(-1)!;
      expect(definition.roster.reviews).toHaveLength(2);
      expect(new Set(definition.roster.reviews.map(review => review.runId)).size).toBe(2);
      const context = JSON.parse(options.prompt!.match(/<reconciliation-context>\n([\s\S]+)\n<\/reconciliation-context>/u)![1]!);
      expect(context.repairPlan.coreRoleScope).toEqual(coreRoleAttemptScope(definition));
      throw new Error("Stop fixture before any repair writes");
    },
  })).rejects.toThrow("Stop fixture before any repair writes");
  expect(calls).toEqual(["review", "review", "repair"]);
  expect((await canon.listEvents()).every(event => event.preconditions.length === 0)).toBe(true);
});

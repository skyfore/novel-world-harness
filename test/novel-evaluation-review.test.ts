import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PiAgentSession } from "../src/agent/pi-session.js";
import { reviewNovelEvaluation, inspectEvaluationReview } from "../src/workflow/novel-evaluation-review.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { buildRoleRoster, RoleRosterStore, roleRosterReviewSchema } from "../src/compiler/role-roster.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { NovelEvaluationPlanStore } from "../src/eval/novel-evaluation-plan.js";
import { deriveCharacterEntrySeed } from "../src/world/entry-context.js";
import { preparedSubjectHash } from "../src/compiler/certification.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function candidate() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-independent-review-")); roots.push(root);
  const fixture = await createEvidenceFixture(root, "Hero waits.\n");
  const canonical = new CanonicalModelStore(root);
  await canonical.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: fixture.evidence("Hero") });
  await new InitialWorldStore(root).put({ version: 1, evidence: fixture.evidence("Hero waits."), delta: { version: 1,
    operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] } });
  const batches = await prepareCompilerBatches(root, fixture.source);
  await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, batches.map(batch => batch.id));
  const cache = new PreparedNovelCache(root);
  let bundle = await cache.candidateSnapshot(fixture.source);
  const roster = buildRoleRoster({ sourceId: fixture.source.id, sourceSha256: fixture.source.contentSha256,
    unitIds: bundle.compilerSnapshot.structure.baseUnitIds, entities: bundle.canonical.entities, annotations: [], resolutions: [] });
  roster.reviews = ["source-review-a", "source-review-b"].map(runId => roleRosterReviewSchema.parse({ runId, subjectHash: roster.subjectHash,
    reviewedUnitIds: roster.unitIds, entries: roster.candidates.map(role => ({ candidateId: role.id, importance: "major", rationale: "Independent fixture review", basisUnitIds: roster.unitIds })) }));
  await new RoleRosterStore(root).write(roster);
  bundle = await cache.candidateSnapshot(fixture.source);
  return { root, fixture, cache, bundle, roster };
}

it("independent review requires source coverage before freezing, binds real trace IDs and reuses the frozen plan", async () => {
  const { root, fixture, cache, bundle, roster } = await candidate();
  const create = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => {
    expect(options.includeLocalTools).toBe(false);
    expect(options.includeProjectInstructions).toBe(false);
    const tools = options.additionalTools!;
    expect(tools.map(tool => tool.name)).not.toContain("propose_entity");
    const call = async (name: string, input: unknown) => tools.find(tool => tool.name === name)!.execute("fixture-call", input as never, undefined, undefined, {} as never);
    return {
      abort: async () => {}, dispose: async () => {},
      promptWithReport: async () => {
        await expect(call("finish_evaluation_plan", {})).rejects.toThrow("Source review incomplete");
        const index = await call("read_evaluation_input", { section: "schema" });
        expect(JSON.stringify(index)).toContain("gold.semantic.mentions");
        await call("read_source_evidence", { ref: `source-segment:${fixture.segmentId}`, offset: 0 });
        await call("propose_evaluation_item", { section: "criticalChecks", key: "identity",
          json: JSON.stringify({ id: "identity", jsonPointer: "/canonical/entities/0/id", expected: "hero" }) });
        await call("propose_evaluation_item", { section: "roles", key: roster.candidates[0]!.id,
          json: JSON.stringify({ candidateId: roster.candidates[0]!.id, actorId: "hero", entryCutHash: deriveCharacterEntrySeed(bundle, "hero").cut.hash,
            utterances: ["Wait"], maxTurns: 1, tasks: [{ id: "task", description: "Wait", conditions: [{ op: "elapsed-days-gte", days: 1 }] }],
            knowledgeChecks: [{ actorId: "hero", claimId: "secret", when: [{ op: "elapsed-days-gte", days: 1 }] }],
            rejectedProbes: [{ id: "unbound", candidate: { title: "Invent wealth", participants: [], preconditions: [], requiresKnowledge: [], forbidsKnowledge: [],
              proposedDelta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.wealth", value: 100 }] } } }],
          }) });
        await call("finish_evaluation_plan", {});
        return {} as never;
      },
    } as unknown as PiAgentSession;
  });
  const planHash = await reviewNovelEvaluation({ root, bundle });
  const state = await inspectEvaluationReview(root, preparedSubjectHash(bundle));
  const plan = await new NovelEvaluationPlanStore(root).read(planHash);
  expect(plan.reviewerRunIds).toEqual(state?.traceRunIds);
  expect(plan.reviewerRunIds).toHaveLength(1);
  expect(state?.failures.finish).toBe(1);
  expect(await reviewNovelEvaluation({ root, bundle })).toBe(planHash);
  expect(create).toHaveBeenCalledOnce();
  // A frozen specification with empty semantic gold is not a certificate.
  await expect(cache.certifyCandidate(fixture.source)).rejects.toThrow();
  expect(await cache.loadActive(fixture.source)).toBeNull();
});

it("retains an exhausted correction across independent-review invocations", async () => {
  const { root, bundle } = await candidate();
  const create = vi.spyOn(PiAgentSession, "create").mockImplementation(async options => ({
    abort: async () => {}, dispose: async () => {},
    promptWithReport: async () => {
      const finish = options.additionalTools!.find(tool => tool.name === "finish_evaluation_plan")!;
      await expect(finish.execute("one", {}, undefined, undefined, {} as never)).rejects.toThrow("Source review incomplete");
      await finish.execute("two", {}, undefined, undefined, {} as never);
      return {} as never;
    },
  }) as unknown as PiAgentSession);
  await expect(reviewNovelEvaluation({ root, bundle })).rejects.toThrow("EVALUATION_REVIEW_HOST_REQUIRED");
  const prior = await inspectEvaluationReview(root, preparedSubjectHash(bundle));
  await expect(reviewNovelEvaluation({ root, bundle })).rejects.toThrow("EVALUATION_REVIEW_HOST_REQUIRED");
  expect(create).toHaveBeenCalledOnce();
  const after = await inspectEvaluationReview(root, preparedSubjectHash(bundle));
  expect(after?.runId).toBe(prior?.runId);
  expect(after?.failures.finish).toBe(2);
});

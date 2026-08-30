import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMPILER_PIPELINE_VERSION, CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { convergeWorldProposals } from "../src/compiler/converge.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { CompilerProposalService } from "../src/compiler/proposals.js";
import { RepairRunStore } from "../src/compiler/repair-run.js";
import { repairExistingCommand } from "../src/commands/repair-existing.js";
import { CanonicalModelStore, ProposalStore } from "../src/world/canonical-model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("historical prepared-revision repair", () => {
  it("checks staging conflicts, then forks a legacy revision without discarding its canonical artifacts", async () => {
    const root = await temporaryRoot("nwh-repair-existing-");
    const cacheRoot = await temporaryRoot("nwh-repair-existing-cache-");
    const fixture = await createEvidenceFixture(root, "# Opening\nHero waits.\n");
    const batches = await prepareCompilerBatches(root, fixture.source);
    const batch = batches.find((candidate) => candidate.purpose === "source-review")!;
    const proposals = new CompilerProposalService(root);
    await proposals.submit("entity", {
      proposalId: "hero-v24",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: batch.evidence },
      generatedBy: { worker: "test", compilerBatchId: batch.id },
    });
    await proposals.submit("initial-world", {
      proposalId: "opening-v24",
      payload: {
        version: 1,
        delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] },
        evidence: batch.evidence,
      },
      generatedBy: { worker: "test", compilerBatchId: `opening-${batch.id}` },
    });
    await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, batches.map((candidate) => candidate.id));
    await convergeWorldProposals(root, fixture.source.id);
    const cache = new PreparedNovelCache(root, cacheRoot);
    const baseline = await cache.publishLegacyRollbackBaseline(fixture.source, {
      version: 1,
      pipelineVersion: COMPILER_PIPELINE_VERSION - 1,
      sourceId: fixture.source.id,
      completedBatchIds: batches.map((candidate) => candidate.id),
      updatedAt: new Date(0).toISOString(),
    });
    if (!baseline.bundleHash) throw new Error("missing baseline hash");

    await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, []);
    await proposals.submit("entity", {
      proposalId: "hero-v25-interrupted",
      payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: ["bad-v25"], evidence: batch.evidence },
      generatedBy: { worker: "test", compilerBatchId: batch.id },
    });

    await expect(repairExistingCommand({
      root,
      configPath: path.join(root, "missing.yaml"),
      sourceId: fixture.source.id,
      fromRevision: baseline.bundleHash,
      cacheRoot,
    })).rejects.toThrow("No state was replaced");
    await expect(new ProposalStore(root).list("pending", fixture.source.id)).resolves.toContainEqual(
      expect.objectContaining({ id: "hero-v25-interrupted" }),
    );

    let observedRunId = "";
    const result = await repairExistingCommand({
      root,
      configPath: path.join(root, "missing.yaml"),
      sourceId: fixture.source.id,
      fromRevision: baseline.bundleHash,
      replaceStaging: true,
      cacheRoot,
    }, {
      async compileSource(options) {
        await expect(new CanonicalModelStore(root).getEntity("hero")).resolves.toMatchObject({ aliases: [] });
        const transformed = options.promptTransform?.("base prompt", batch) ?? "";
        observedRunId = transformed.match(/repair-\d{14}-[a-f0-9]{8}/)?.[0] ?? "";
        expect(observedRunId).toMatch(/^repair-/);
        expect(transformed).toContain("Preserve correct existing artifacts");
        await proposals.submit("entity", {
          proposalId: `hero-fixed-${observedRunId}`,
          payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: ["Hero"], evidence: batch.evidence },
          generatedBy: { worker: "test", compilerBatchId: batch.id },
        });
        await new CompilerBatchStore(root).markComplete(fixture.source.id, batch.id);
      },
      async finishPreparation(options) {
        if (!options.reparseBaselineBundleHash || !options.reparseRunId) {
          throw new Error("repair lineage was not forwarded to preparation");
        }
        await new PreparedNovelCache(root, options.cacheRoot).publish(fixture.source, {
          allowSemanticDebtForRollback: true,
          lineage: {
            operation: "repair",
            parentBundleHash: options.reparseBaselineBundleHash,
            runId: options.reparseRunId,
          },
        });
        return {} as Awaited<ReturnType<typeof import("../src/commands/prepare-all.js").prepareAllCommand>>;
      },
    });

    expect(result.parentBundleHash).toBe(baseline.bundleHash);
    expect(result.activeBundleHash).not.toBe(baseline.bundleHash);
    expect(result.replacedProposalIds).toContain("hero-v25-interrupted");
    expect(result.runId).toBe(observedRunId);
    await expect(new CanonicalModelStore(root).getEntity("hero")).resolves.toMatchObject({ aliases: ["Hero"] });
    await expect(new RepairRunStore(root).read(fixture.source.id)).resolves.toBeNull();
    const revisions = await cache.listRevisions(fixture.source);
    expect(revisions).toHaveLength(2);
    expect(revisions.find((revision) => revision.bundleHash === baseline.bundleHash)?.active).toBe(false);
    expect(revisions.find((revision) => revision.bundleHash === result.activeBundleHash)).toMatchObject({
      active: true,
      lineage: {
        operation: "repair",
        parentBundleHash: baseline.bundleHash,
        runId: result.runId,
      },
    });
    await expect(new ProposalStore(root).readRejection("hero-v25-interrupted")).resolves.toMatchObject({
      errors: [expect.objectContaining({ code: "SOURCE_REPAIR_FORK_REPLACEMENT" })],
    });
  });

  it("resumes a partially completed repair from its durable journal", async () => {
    const root = await temporaryRoot("nwh-repair-resume-");
    const cacheRoot = await temporaryRoot("nwh-repair-resume-cache-");
    const fixture = await createEvidenceFixture(root, "# One\nHero waits.\n# Two\nVillain waits.\n");
    const batches = (await prepareCompilerBatches(root, fixture.source))
      .filter((candidate) => candidate.purpose === "source-review");
    expect(batches).toHaveLength(2);
    const proposals = new CompilerProposalService(root);
    for (const [index, entity] of ["hero", "villain"].entries()) {
      await proposals.submit("entity", {
        proposalId: `${entity}-v24`,
        payload: { id: entity, kind: "character", canonicalName: entity === "hero" ? "Hero" : "Villain", aliases: [], evidence: batches[index]!.evidence },
        generatedBy: { worker: "test", compilerBatchId: batches[index]!.id },
      });
    }
    await proposals.submit("initial-world", {
      proposalId: "opening-resume-v24",
      payload: {
        version: 1,
        participantPresence: [{ entityId: "hero", mode: "physical" }],
        delta: {
          version: 1,
          operations: [
            { op: "set", entityId: "hero", field: "character.alive", value: true },
            { op: "set", entityId: "hero", field: "character.plan", value: "wait" },
          ],
        },
        evidence: batches[0]!.evidence,
      },
      generatedBy: { worker: "test", compilerBatchId: `opening-${batches[0]!.id}` },
    });
    const allBatches = await prepareCompilerBatches(root, fixture.source);
    await new CompilerBatchStore(root).replaceCompleted(fixture.source.id, allBatches.map((candidate) => candidate.id));
    const baselineConvergence = await convergeWorldProposals(root, fixture.source.id);
    expect(baselineConvergence.canonical.blocked).toEqual([]);
    const cache = new PreparedNovelCache(root, cacheRoot);
    const baseline = await cache.publishLegacyRollbackBaseline(fixture.source, {
      version: 1,
      pipelineVersion: COMPILER_PIPELINE_VERSION - 1,
      sourceId: fixture.source.id,
      completedBatchIds: allBatches.map((candidate) => candidate.id),
      updatedAt: new Date(0).toISOString(),
    });
    if (!baseline.bundleHash) throw new Error("missing baseline hash");

    let runId = "";
    await expect(repairExistingCommand({
      root,
      configPath: path.join(root, "missing.yaml"),
      sourceId: fixture.source.id,
      fromRevision: baseline.bundleHash,
      replaceStaging: true,
      cacheRoot,
    }, {
      async compileSource(options) {
        runId = options.promptTransform?.("base", batches[0]!)
          .match(/repair-\d{14}-[a-f0-9]{8}/)?.[0] ?? "";
        await proposals.submit("entity", {
          proposalId: `hero-resume-${runId}`,
          payload: { id: "hero", kind: "character", canonicalName: "Hero", aliases: ["Hero"], evidence: batches[0]!.evidence },
          generatedBy: { worker: "test", compilerBatchId: batches[0]!.id },
        });
        await new CompilerBatchStore(root).markComplete(fixture.source.id, batches[0]!.id);
        throw new Error("simulated interruption");
      },
    })).rejects.toThrow("paused without discarding completed work");

    await expect(new RepairRunStore(root).read(fixture.source.id)).resolves.toMatchObject({
      runId,
      phase: "compiling",
    });
    await expect(new CompilerBatchStore(root).read(fixture.source.id)).resolves.toMatchObject({
      completedBatchIds: [batches[0]!.id],
    });

    const result = await repairExistingCommand({
      root,
      configPath: path.join(root, "missing.yaml"),
      sourceId: fixture.source.id,
      fromRevision: baseline.bundleHash,
      cacheRoot,
    }, {
      async compileSource() {
        await expect(new ProposalStore(root).list("pending", fixture.source.id)).resolves.toContainEqual(
          expect.objectContaining({ id: `hero-resume-${runId}` }),
        );
        await expect(new CompilerBatchStore(root).read(fixture.source.id)).resolves.toMatchObject({
          completedBatchIds: [batches[0]!.id],
        });
        await new CompilerBatchStore(root).markComplete(fixture.source.id, batches[1]!.id);
      },
      async finishPreparation(options) {
        if (!options.reparseBaselineBundleHash || !options.reparseRunId) {
          throw new Error("repair lineage was not forwarded to preparation");
        }
        await new PreparedNovelCache(root, options.cacheRoot).publish(fixture.source, {
          allowSemanticDebtForRollback: true,
          lineage: {
            operation: "repair",
            parentBundleHash: options.reparseBaselineBundleHash,
            runId: options.reparseRunId,
          },
        });
        return {} as Awaited<ReturnType<typeof import("../src/commands/prepare-all.js").prepareAllCommand>>;
      },
    });

    expect(result.resumed).toBe(true);
    expect(result.runId).toBe(runId);
    await expect(new CanonicalModelStore(root).getEntity("hero")).resolves.toMatchObject({ aliases: ["Hero"] });
    await expect(new RepairRunStore(root).read(fixture.source.id)).resolves.toBeNull();
    await expect(cache.loadRevision(fixture.source, result.activeBundleHash)).resolves.toMatchObject({
      bundle: {
        lineage: {
          operation: "repair",
          parentBundleHash: baseline.bundleHash,
          runId,
        },
      },
    });
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCompilerBatches } from "../src/compiler/batches.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { SourceAccountingStore } from "../src/compiler/source-accounting.js";
import { ensureSourceStructure } from "../src/compiler/structure.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("source-unit accounting tools", () => {
  it("blocks a novel-scale proposal-bearing finish until every unrepresented unit is dispositioned", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-accounting-tool-"));
    roots.push(root);
    const content = Array.from(
      { length: 420 },
      (_value, index) => `Sentence ${String(index + 1).padStart(3, "0")} describes ordinary background texture without a world transition.`,
    ).join("\n");
    const fixture = await createEvidenceFixture(root, content);
    const batch = (await prepareCompilerBatches(root, fixture.source))
      .find((candidate) => candidate.purpose === "source-review");
    if (!batch) throw new Error("Missing ordinary source batch");
    const toolset = createCompilerProposalToolset(root, { provider: "test", model: "accounting-model" });
    await toolset.beginBatch(batch.segmentIds, batch.id, fixture.source.id);
    const tool = (name: string) => toolset.tools.find((candidate) => candidate.name === name)!;
    const readPage = async (offset: number) => {
      const result = await tool("find_source_accounting_units").execute(`find-${offset}`, {
        status: "all",
        offset,
        max_results: 200,
      } as never, undefined, undefined, {} as never);
      const text = (result.content[0] as { text: string }).text;
      return JSON.parse(text) as {
        nextOffset: number | null;
        units: Array<{ unitId: string; kind: string; status: string }>;
      };
    };
    const units: Array<{ unitId: string; kind: string; status: string }> = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await readPage(offset);
      units.push(...page.units);
      offset = page.nextOffset;
    }
    const semanticUnits = units.filter((unit) => unit.kind !== "non-scene" && unit.status !== "represented");
    expect(semanticUnits.length).toBeGreaterThan(300);

    await tool("account_source_units").execute("account-partial", {
      proposal_id: "account-partial",
      decisions: [{
        unit_id: semanticUnits[0]!.unitId,
        status: "background-only",
        reason: "Reviewed as non-material descriptive texture.",
      }],
    } as never, undefined, undefined, {} as never);
    const reviewedSegments = batch.segmentIds.map((segmentId) => ({
      segment_id: segmentId,
      disposition: "proposed" as const,
      summary: "Explicit unit dispositions record the semantic review.",
    }));
    await expect(tool("finish_compiler_batch").execute("finish-incomplete", {
      outcome: "complete",
      reviewed_segments: reviewedSegments,
      summary: "Unit review attempted.",
    } as never, undefined, undefined, {} as never)).rejects.toThrow("account_source_units disposition");

    await tool("account_source_units").execute("account-remainder", {
      proposal_id: "account-remainder",
      decisions: semanticUnits.slice(1).map((unit) => ({
        unit_id: unit.unitId,
        status: "background-only",
        reason: "Reviewed as non-material descriptive texture.",
      })),
    } as never, undefined, undefined, {} as never);
    await expect(tool("finish_compiler_batch").execute("finish-complete", {
      outcome: "complete",
      reviewed_segments: reviewedSegments,
      summary: "Every deterministic semantic unit was reviewed.",
    } as never, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { compilerBatchFinished: true },
    });

    const accounting = new SourceAccountingStore(root);
    const summary = await accounting.summarize(
      await ensureSourceStructure(root, fixture.source),
    );
    expect(summary.unaccountedUnits).toBe(0);
    expect(summary.blockingUnits).toBe(0);
    expect(summary.statusCounts["background-only"]).toBe(summary.totalUnits);

    expect((await accounting.listProposals(fixture.source.id, "accepted")).map((proposal) => proposal.id).sort())
      .toEqual(["account-partial", "account-remainder"]);
    await expect(accounting.rejectBatchProposals(fixture.source.id, batch.id))
      .resolves.toEqual(["account-partial", "account-remainder"]);
    await expect(accounting.listProposals(fixture.source.id, "accepted")).resolves.toEqual([]);
    expect((await accounting.listProposals(fixture.source.id, "rejected")).map((proposal) => proposal.id).sort())
      .toEqual(["account-partial", "account-remainder"]);
  });
});

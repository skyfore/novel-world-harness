import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCompilerBatches } from "../src/compiler/batches.js";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { SegmentStore } from "../src/compiler/segments.js";
import { SourceAccountingStore, sourceUnitReviewRange } from "../src/compiler/source-accounting.js";
import { baseStructuralUnits, ensureSourceStructure } from "../src/compiler/structure.js";
import { readSourceMaterial } from "../src/storage/source-material-store.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("source-unit accounting tools", () => {
  it("expands a fresh unresolved-page token into exact per-unit decisions without copying unit IDs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-accounting-page-tool-"));
    roots.push(root);
    const content = Array.from(
      { length: 24 },
      (_value, index) => `Sentence ${String(index + 1).padStart(2, "0")} describes reviewed narrative texture.`,
    ).join("\n");
    const fixture = await createEvidenceFixture(root, content);
    const batch = (await prepareCompilerBatches(root, fixture.source))
      .find((candidate) => candidate.purpose === "source-review" && candidate.semanticStage === "executable");
    if (!batch) throw new Error("Missing ordinary source batch");
    const structure = await ensureSourceStructure(root, fixture.source);
    const segmentIds = new Set(batch.segmentIds);
    const segments = (await new SegmentStore(root).list(fixture.source.id))
      .filter((segment) => segmentIds.has(segment.id));
    const priorUnits = baseStructuralUnits(structure).filter((unit) =>
      unit.kind !== "non-scene"
      && segments.some((segment) => unit.anchor.startByte >= segment.startByte && unit.anchor.endByte <= segment.endByte));
    await new SourceAccountingStore(root).recordBatchReview({
      source: fixture.source,
      structure,
      batchId: "prior-materialized-review",
      reviews: segments.map((segment) => ({
        segment,
        disposition: "proposed" as const,
        summary: "Prior materialized review must remain context rather than active-batch coverage.",
      })),
      unitDecisions: priorUnits.map((unit) => ({
        unitId: unit.id,
        status: "background-only" as const,
        reason: "Prior revision disposition retained only as review context.",
      })),
    });
    const toolset = createCompilerProposalToolset(root, { provider: "test", model: "accounting-page-model" });
    await toolset.beginBatch(batch.segmentIds, batch.id, fixture.source.id);
    const tool = (name: string) => toolset.tools.find((candidate) => candidate.name === name)!;

    const allResult = await tool("find_source_accounting_units").execute("find-all", {
      status: "all",
      offset: 0,
      max_results: 5,
    } as never, undefined, undefined, {} as never);
    const allPage = JSON.parse((allResult.content[0] as { text: string }).text) as { pageToken?: string };
    expect(allPage.pageToken).toBeUndefined();

    const result = await tool("find_source_accounting_units").execute("find-unresolved", {
      status: "unresolved",
      offset: 0,
      max_results: 5,
    } as never, undefined, undefined, {} as never);
    const page = JSON.parse((result.content[0] as { text: string }).text) as {
      pageToken: string;
      indexBase: number;
      units: Array<{
        unitIndex: number;
        unitId: string;
        status: string;
        prior?: { status: string; reason?: string };
      }>;
    };
    expect(page.pageToken).toMatch(/^acctpg-[a-f0-9]{16}$/u);
    expect(page.indexBase).toBe(1);
    expect(page.units).toHaveLength(5);
    expect(page.units.map((unit) => unit.unitIndex)).toEqual([1, 2, 3, 4, 5]);
    expect(page.units.every((unit) => unit.status === "unresolved")).toBe(true);
    expect(page.units.every((unit) => unit.prior?.status === "background-only")).toBe(true);

    await tool("account_source_units").execute("account-page", {
      proposal_id: "account-page",
      page_token: page.pageToken,
      page_default: {
        status: "background-only",
        reason: "Reviewed individually as non-material narrative texture.",
      },
      page_overrides: [{
        unit_index: 2,
        status: "paratext",
        reason: "Reviewed individually as edition apparatus for this fixture.",
      }],
    } as never, undefined, undefined, {} as never);

    const proposal = await new SourceAccountingStore(root).readProposal(
      fixture.source.id,
      "pending",
      "account-page",
    );
    expect(proposal.decisions.map((decision) => decision.unitId)).toEqual(page.units.map((unit) => unit.unitId));
    expect(proposal.decisions.map((decision) => decision.status)).toEqual([
      "background-only",
      "paratext",
      "background-only",
      "background-only",
      "background-only",
    ]);

    await expect(tool("account_source_units").execute("reuse-page", {
      proposal_id: "reuse-page",
      page_token: page.pageToken,
      page_default: { status: "background-only", reason: "A consumed page cannot be reused." },
    } as never, undefined, undefined, {} as never)).rejects.toThrow("Unknown or stale accounting page token");
    await expect(tool("account_source_units").execute("unknown-page", {
      proposal_id: "unknown-page",
      page_token: "acctpg-0000000000000000",
      page_default: { status: "background-only", reason: "An invented token must be rejected." },
    } as never, undefined, undefined, {} as never)).rejects.toThrow("copy the exact returned pageToken");
    await expect(tool("account_source_units").execute("mixed-mode", {
      proposal_id: "mixed-mode",
      decisions: [{
        unit_id: page.units[0]!.unitId,
        status: "background-only",
        reason: "Exact mode input.",
      }],
      page_token: "acctpg-0000000000000000",
      page_default: { status: "background-only", reason: "Page mode input." },
    } as never, undefined, undefined, {} as never)).rejects.toThrow("exactly one input mode");
    await expect(tool("account_source_units").execute("missing-mode", {
      proposal_id: "missing-mode",
    } as never, undefined, undefined, {} as never)).rejects.toThrow("exactly one input mode");
  });

  it("blocks a novel-scale proposal-bearing finish until every unrepresented unit is dispositioned", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-accounting-tool-"));
    roots.push(root);
    const content = Array.from(
      { length: 420 },
      (_value, index) => `Sentence ${String(index + 1).padStart(3, "0")} describes ordinary background texture without a world transition.`,
    ).join("\n");
    const fixture = await createEvidenceFixture(root, content);
    const batch = (await prepareCompilerBatches(root, fixture.source))
      .find((candidate) => candidate.purpose === "source-review" && candidate.semanticStage === "executable");
    if (!batch) throw new Error("Missing ordinary source batch");
    const toolset = createCompilerProposalToolset(root, { provider: "test", model: "accounting-model" });
    await toolset.beginBatch(batch.segmentIds, batch.id, fixture.source.id);
    const tool = (name: string) => toolset.tools.find((candidate) => candidate.name === name)!;
    const readPage = async (offset: number) => {
      const result = await tool("find_source_accounting_units").execute(`find-${offset}`, {
        status: "all",
        offset,
        max_results: 20,
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
      terminate: true,
    });

    const accounting = new SourceAccountingStore(root);
    // Simulate a process failure after proposal acceptance but before the
    // final accounting manifest write. A fresh session must hydrate accepted
    // decisions and recreate the marker without asking for duplicate drafts.
    await accounting.remove(fixture.source.id);
    const retry = createCompilerProposalToolset(root, { provider: "test", model: "accounting-model" });
    await retry.beginBatch(batch.segmentIds, batch.id, fixture.source.id);
    await expect(retry.tools.find((candidate) => candidate.name === "finish_compiler_batch")!.execute(
      "finish-after-marker-loss",
      {
        outcome: "complete",
        reviewed_segments: reviewedSegments,
        summary: "Recovered the final marker from already accepted accounting decisions.",
      } as never,
      undefined,
      undefined,
      {} as never,
    )).resolves.toMatchObject({
      details: { compilerBatchFinished: true },
      terminate: true,
    });

    const summary = await accounting.summarize(
      await ensureSourceStructure(root, fixture.source),
    );
    expect(summary.unaccountedUnits).toBe(0);
    expect(summary.blockingUnits).toBe(0);
    expect(summary.statusCounts["background-only"]).toBe(summary.totalUnits);

    // A later recovery may add exact semantics that overlap decisions which
    // were valid when the accounting proposals were first accepted. The host
    // must project those units as represented without mutating or replaying a
    // conflicting model disposition.
    await accounting.remove(fixture.source.id);
    const semanticRetry = createCompilerProposalToolset(root, {
      provider: "test",
      model: "accounting-semantic-recovery-model",
    });
    await semanticRetry.beginBatch(batch.segmentIds, batch.id, fixture.source.id);
    const exactRuleText = "Sentence 001 describes ordinary background texture without a world transition.";
    await semanticRetry.tools.find((candidate) => candidate.name === "propose_world_rule")!.execute(
      "recovery-rule",
      {
        proposal_id: "rule-accounting-recovery-representation",
        payload: {
          ontologyVersion: "world-rule-v2",
          id: "accounting-recovery-representation",
          name: exactRuleText,
          kind: "social",
          scope: "global",
          visibility: "public",
          priority: 1,
          defeasible: true,
          clauses: [{
            id: "accounting-recovery-clause",
            modality: "forbid",
            predicate: { op: "elapsed-days-gte", days: 0 },
            basis: "explicit",
            status: "supported",
            confidence: 1,
          }],
          exceptions: [],
          basis: "explicit",
          status: "supported",
          confidence: 1,
        },
        evidence_segment_ids: [fixture.segmentId],
        evidence_selectors: [{
          segment_id: fixture.segmentId,
          exact: exactRuleText,
          target_path: "/name",
          relation: "supports",
          strength: "explicit",
        }, {
          segment_id: fixture.segmentId,
          exact: exactRuleText,
          target_path: "/clauses/0/predicate",
          relation: "supports",
          strength: "explicit",
        }],
      } as never,
      undefined,
      undefined,
      {} as never,
    );
    await expect(semanticRetry.tools.find((candidate) => candidate.name === "finish_compiler_batch")!.execute(
      "finish-after-new-exact-semantics",
      {
        outcome: "complete",
        reviewed_segments: reviewedSegments,
        summary: "Recovered accepted accounting while exact semantics upgraded one unit to represented.",
      } as never,
      undefined,
      undefined,
      {} as never,
    )).resolves.toMatchObject({
      details: { compilerBatchFinished: true },
      terminate: true,
    });
    await expect(accounting.summarize(await ensureSourceStructure(root, fixture.source))).resolves.toMatchObject({
      unaccountedUnits: 0,
      blockingUnits: 0,
      statusCounts: { represented: 1 },
    });

    expect((await accounting.listProposals(fixture.source.id, "accepted")).map((proposal) => proposal.id).sort())
      .toEqual(["account-partial", "account-remainder"]);
    await expect(accounting.rejectBatchProposals(fixture.source.id, batch.id))
      .resolves.toEqual(["account-partial", "account-remainder"]);
    await expect(accounting.listProposals(fixture.source.id, "accepted")).resolves.toEqual([]);
    expect((await accounting.listProposals(fixture.source.id, "rejected")).map((proposal) => proposal.id).sort())
      .toEqual(["account-partial", "account-remainder"]);
  });

  it("accounts CRLF sentence units whose trailing indentation crosses a segment boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-accounting-cross-segment-"));
    roots.push(root);
    const content = Array.from(
      { length: 720 },
      (_value, index) => `\tSentence ${String(index + 1).padStart(3, "0")} describes ordinary background texture in the setting.`,
    ).join("\r\n") + "\r\n";
    const fixture = await createEvidenceFixture(root, content);
    const [structure, sourceBytes, segments, batches] = await Promise.all([
      ensureSourceStructure(root, fixture.source),
      readSourceMaterial(root, fixture.source),
      new SegmentStore(root).list(fixture.source.id),
      prepareCompilerBatches(root, fixture.source),
    ]);
    const executableBatches = batches.filter((candidate) =>
      candidate.purpose === "source-review" && candidate.semanticStage === "executable");
    expect(executableBatches.length).toBeGreaterThan(1);

    const crossingUnit = baseStructuralUnits(structure).find((unit) =>
      segments.some((segment) =>
        unit.anchor.startByte < segment.endByte && unit.anchor.endByte > segment.endByte));
    expect(crossingUnit).toBeDefined();
    const reviewRange = sourceUnitReviewRange(sourceBytes, crossingUnit!);
    expect(segments.some((segment) =>
      reviewRange.startByte >= segment.startByte && reviewRange.endByte <= segment.endByte)).toBe(true);

    const toolset = createCompilerProposalToolset(root, { provider: "test", model: "cross-segment-model" });
    const tool = (name: string) => toolset.tools.find((candidate) => candidate.name === name)!;
    for (const [batchIndex, batch] of executableBatches.entries()) {
      await toolset.beginBatch(batch.segmentIds, batch.id, fixture.source.id);
      let proposalIndex = 0;
      while (true) {
        const result = await tool("find_source_accounting_units").execute(`find-${batchIndex}-${proposalIndex}`, {
          status: "unresolved",
          offset: 0,
          max_results: 20,
        } as never, undefined, undefined, {} as never);
        const page = JSON.parse((result.content[0] as { text: string }).text) as {
          pageToken?: string;
          units: Array<{ unitId: string }>;
        };
        if (!page.units.length) break;
        expect(page.pageToken).toBeDefined();
        proposalIndex += 1;
        await tool("account_source_units").execute(`account-${batchIndex}-${proposalIndex}`, {
          proposal_id: `account-boundary-${batchIndex + 1}-${proposalIndex}`,
          page_token: page.pageToken,
          page_default: {
            status: "background-only",
            reason: "Reviewed as ordinary descriptive texture without a material world transition.",
          },
        } as never, undefined, undefined, {} as never);
      }
      await expect(tool("finish_compiler_batch").execute(`finish-${batchIndex}`, {
        outcome: "complete",
        reviewed_segments: batch.segmentIds.map((segmentId) => ({
          segment_id: segmentId,
          disposition: "proposed",
          summary: "Every semantic unit in this bounded slice received an explicit disposition.",
        })),
        summary: "The bounded source-accounting slice is complete.",
      } as never, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { compilerBatchFinished: true },
        terminate: true,
      });
    }

    await expect(new SourceAccountingStore(root).summarize(structure)).resolves.toMatchObject({
      unaccountedUnits: 0,
      blockingUnits: 0,
    });
  });
});

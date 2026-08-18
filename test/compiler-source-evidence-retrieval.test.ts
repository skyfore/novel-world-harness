import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { segmentSource, SegmentStore } from "../src/compiler/segments.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function resultText(result: unknown): string {
  return (result as { content: Array<{ type: string; text?: string }> }).content
    .flatMap((item) => item.type === "text" && item.text ? [item.text] : [])
    .join("\n");
}

describe("compiler source evidence retrieval", () => {
  it("searches and reads exact segments only from the active novel source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-source-evidence-retrieval-"));
    roots.push(root);
    const first = await createEvidenceFixture(root, "第一章\nHero enters the Hall.\n", "first.txt");
    const second = await createEvidenceFixture(root, "第一章\nVillain enters the Lair.\n", "second.txt");
    for (const fixture of [first, second]) {
      await new SegmentStore(root).write(await segmentSource(root, fixture.source));
    }
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([], "reconcile-first", first.source.id);
    const find = toolset.tools.find((tool) => tool.name === "find_source_evidence")!;
    const read = toolset.tools.find((tool) => tool.name === "read_source_evidence")!;

    const found = JSON.parse(resultText(await find.execute(
      "find",
      { query: "Hero", max_results: 10 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ))) as { sourceId: string; totalMatches: number; results: Array<{ ref: string; preview: string }> };
    expect(found).toMatchObject({ sourceId: first.source.id, totalMatches: 1 });
    expect(found.results[0]?.preview).toContain("Hero enters the Hall");
    expect(JSON.stringify(found)).not.toContain("Villain");

    const exact = JSON.parse(resultText(await read.execute(
      "read",
      { ref: found.results[0]!.ref, offset: 0, max_chars: 1_000 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ))) as { sourceId: string; evidence: { span: { sourceId: string } }; chunk: string };
    expect(exact.sourceId).toBe(first.source.id);
    expect(exact.evidence.span.sourceId).toBe(first.source.id);
    expect(exact.chunk).toContain("Hero enters the Hall");
    expect(exact.chunk).not.toContain("Villain");

    await expect(read.execute(
      "cross-source",
      { ref: `source-segment:${(await new SegmentStore(root).list(second.source.id))[0]!.id}` } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).rejects.toThrow(`active source '${first.source.id}'`);
  });

  it("counts retrieval calls in the compiler circuit-breaker budget", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-source-evidence-budget-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Hero enters.\n");
    await new SegmentStore(root).write(await segmentSource(root, fixture.source));
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([], "reconcile-budget", fixture.source.id);
    const find = toolset.tools.find((tool) => tool.name === "find_source_evidence")!;
    for (let index = 0; index < 40; index += 1) {
      await expect(find.execute(
        `find-${index}`,
        { query: "missing" } as never,
        undefined,
        undefined,
        {} as ExtensionContext,
      )).resolves.toMatchObject({ details: { compilerSourceEvidenceRetrieval: true } });
    }
    await expect(find.execute(
      "find-over-budget",
      { query: "missing" } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).resolves.toMatchObject({
      terminate: true,
      details: { compilerBatchBlocked: true, toolCallCount: 41 },
    });
  });

  it("rejects schema-valid segment metadata that was not derived from the immutable source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-source-evidence-tampered-index-"));
    roots.push(root);
    const fixture = await createEvidenceFixture(root, "Chapter 1\nHero enters.\n");
    const store = new SegmentStore(root);
    const manifest = await segmentSource(root, fixture.source);
    await store.write({
      ...manifest,
      segments: manifest.segments.map((segment, index) => index === 0
        ? { ...segment, title: "Injected index instruction" }
        : segment),
    });
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([], "reconcile-tampered-index", fixture.source.id);
    const find = toolset.tools.find((tool) => tool.name === "find_source_evidence")!;

    await expect(find.execute(
      "find",
      { query: "Hero" } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).rejects.toThrow("missing or stale");
  });
});

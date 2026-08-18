import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createCompilerProposalToolset } from "../src/compiler/proposal-tools.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function resultText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.flatMap((item) => item.type === "text" && item.text ? [item.text] : []).join("\n");
}

describe("compiler artifact retrieval", () => {
  it("finds and losslessly pages exact artifacts only within the active source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-artifact-retrieval-"));
    roots.push(root);
    const first = await createEvidenceFixture(root, "Hero enters the Hall.\n", "first.txt");
    const second = await createEvidenceFixture(root, "Villain enters the Lair.\n", "second.txt");
    const canon = new CanonicalModelStore(root);
    await canon.putEntity({
      id: "hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: first.evidence("Hero"),
    });
    await canon.putEntity({
      id: "villain",
      kind: "character",
      canonicalName: "Villain",
      aliases: [],
      evidence: second.evidence("Villain"),
    });
    await canon.putClaim({
      id: "long-note",
      subject: "hero",
      predicate: "carries-note",
      object: `${"x".repeat(1_500)}😀${"x".repeat(33_500)}`,
      epistemicType: "explicit-fact",
      evidence: first.evidence("Hero"),
    });

    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([], "batch-first", first.source.id);
    const find = toolset.tools.find((tool) => tool.name === "find_compiler_artifacts")!;
    const read = toolset.tools.find((tool) => tool.name === "read_compiler_artifact")!;
    const found = resultText(await find.execute(
      "find",
      { query: "*", max_results: 50 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ));
    expect(found).toContain("canonical:entity:hero");
    expect(found).not.toContain("villain");

    const firstIndexPage = JSON.parse(resultText(await find.execute(
      "find-page",
      { query: "*", offset: 0, max_results: 1 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ))) as { returned: number; totalMatches: number; nextOffset?: number };
    expect(firstIndexPage).toMatchObject({ returned: 1, totalMatches: 2, nextOffset: 1 });

    const firstChunk = resultText(await read.execute(
      "read",
      { ref: "canonical:entity:hero", offset: 0, max_chars: 1_000 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ));
    const firstEnvelope = JSON.parse(firstChunk) as { ref: string; chunk: string };
    expect(firstEnvelope.ref).toBe("canonical:entity:hero");
    expect(firstEnvelope.chunk).toContain('"canonicalName":"Hero"');
    expect(firstEnvelope.chunk).not.toContain("Villain");

    const paged = resultText(await read.execute(
      "read-long",
      { ref: "canonical:claim:long-note", offset: 0, max_chars: 1_000 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ));
    expect(JSON.parse(paged)).toMatchObject({ nextOffset: 1_000, offset: 0, end: 1_000 });
    expect(paged.length).toBeLessThan(1_500);

    const probe = JSON.parse(resultText(await read.execute(
      "probe-unicode",
      { ref: "canonical:claim:long-note", offset: 0, max_chars: 30_000 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ))) as { chunk: string };
    const emojiOffset = probe.chunk.indexOf("😀");
    expect(emojiOffset).toBeGreaterThan(1_000);
    const unicodePage = JSON.parse(resultText(await read.execute(
      "page-unicode",
      { ref: "canonical:claim:long-note", offset: 0, max_chars: emojiOffset + 1 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    ))) as { end: number; nextOffset: number; chunk: string };
    expect(unicodePage.end).toBe(emojiOffset);
    expect(unicodePage.nextOffset).toBe(emojiOffset);
    expect(unicodePage.chunk.endsWith("\uD83D")).toBe(false);
    await expect(read.execute(
      "split-unicode",
      { ref: "canonical:claim:long-note", offset: emojiOffset + 1, max_chars: 1_000 } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).rejects.toThrow("splits a Unicode surrogate pair");
  });

  it("refuses retrieval before a source-scoped batch is bound", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-artifact-unbound-"));
    roots.push(root);
    const toolset = createCompilerProposalToolset(root);
    const find = toolset.tools.find((tool) => tool.name === "find_compiler_artifacts")!;
    await expect(find.execute(
      "find",
      { query: "*" } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).rejects.toThrow("active source-scoped batch");
  });

  it("fails closed instead of exposing a legacy artifact with mixed-source evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-artifact-mixed-source-"));
    roots.push(root);
    const first = await createEvidenceFixture(root, "Hero enters.\n", "first.txt");
    const second = await createEvidenceFixture(root, "Other hero enters.\n", "second.txt");
    await new CanonicalModelStore(root).putEntity({
      id: "legacy-mixed-hero",
      kind: "character",
      canonicalName: "Hero",
      aliases: [],
      evidence: [...first.evidence("Hero"), ...second.evidence("Other hero")],
    });
    const toolset = createCompilerProposalToolset(root);
    await toolset.beginBatch([], "batch-first", first.source.id);
    const find = toolset.tools.find((tool) => tool.name === "find_compiler_artifacts")!;

    await expect(find.execute(
      "find",
      { query: "*" } as never,
      undefined,
      undefined,
      {} as ExtensionContext,
    )).rejects.toThrow("mixes evidence from multiple novel sources");
  });
});

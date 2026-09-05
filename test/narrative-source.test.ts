import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildNarrativeSourceReferences } from "../src/world/narrative-source.js";
import { createEvidenceFixture } from "./helpers/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("narrator-safe source prose", () => {
  it("admits verified exact prose only as bounded style evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-narrative-source-"));
    roots.push(root);
    const quote = "风从河滩那边过来，吹得福贵的衣角一下又一下贴住膝头。";
    const fixture = await createEvidenceFixture(root, `${quote}\n`, "style.txt");

    const references = await buildNarrativeSourceReferences({
      workspaceRoot: root,
      sourceId: fixture.source.id,
      candidates: [{
        evidence: fixture.evidence(quote),
        relevance: ["actor-visible committed event"],
        anchors: ["福贵"],
      }],
    });

    expect(references).toEqual([expect.objectContaining({
      text: quote,
      sourceId: fixture.source.id,
      authority: "style-only",
      safety: "actor-visible-committed-evidence",
      relevance: ["actor-visible committed event"],
    })]);
    expect(references[0]?.ref).toMatch(/^source-style-[a-f0-9]{24}$/);
  });

  it("fails closed on forged hashes, unavailable names, and unanchored oversized spans", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-narrative-source-closed-"));
    roots.push(root);
    const forbiddenQuote = "福贵抬头时，尚未登场的秘密人正站在门后。";
    const oversized = `${"远处的雨声。".repeat(400)}福贵${"近处的风声。".repeat(400)}`;
    const fixture = await createEvidenceFixture(
      root,
      `${forbiddenQuote}\n${oversized}\n`,
      "closed.txt",
    );
    const forged = structuredClone(fixture.evidence(forbiddenQuote));
    forged[0]!.span.quoteHash = "0".repeat(64);

    await expect(buildNarrativeSourceReferences({
      workspaceRoot: root,
      sourceId: fixture.source.id,
      forbiddenNames: ["秘密人"],
      candidates: [
        { evidence: forged, relevance: ["forged"], anchors: ["福贵"] },
        { evidence: fixture.evidence(forbiddenQuote), relevance: ["future leak"], anchors: ["福贵"] },
        { evidence: fixture.evidence(oversized), relevance: ["unanchored"], anchors: ["并不存在的锚点"] },
      ],
    })).resolves.toEqual([]);
  });

  it("crops an oversized verified span around a literal actor-safe anchor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-narrative-source-anchor-"));
    roots.push(root);
    const oversized = `${"远处的雨声。".repeat(400)}福贵按住门闩${"近处的风声。".repeat(400)}`;
    const fixture = await createEvidenceFixture(root, oversized, "anchor.txt");

    const references = await buildNarrativeSourceReferences({
      workspaceRoot: root,
      sourceId: fixture.source.id,
      candidates: [{
        evidence: fixture.evidence(oversized),
        relevance: ["current committed scene"],
        anchors: ["福贵按住门闩"],
      }],
    });

    expect(references).toHaveLength(1);
    expect(references[0]?.text).toContain("福贵按住门闩");
    expect(Array.from(references[0]!.text).length).toBeLessThanOrEqual(1_800);
    expect(references[0]?.startByte).toBeGreaterThan(0);
    expect(references[0]?.endByte).toBeLessThan(Buffer.byteLength(oversized, "utf8"));
  });
});

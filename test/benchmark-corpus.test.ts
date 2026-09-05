import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BENCHMARK_SEMANTIC_LAYERS,
  inspectBenchmarkCorpus,
} from "../src/eval/benchmark-corpus.js";

const CORPUS = path.resolve(new URL("../fixtures/corpus/representative", import.meta.url).pathname);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("representative executable-world benchmark corpus", () => {
  it("pins every original work and validates closed gold denominators on exact UTF-8 spans", async () => {
    const inspection = await inspectBenchmarkCorpus(CORPUS);

    expect(inspection.manifest.license).toBe("CC0-1.0");
    expect(inspection.manifest.annotationPolicy).toBe("selected-explicit-denominators");
    expect(inspection.works.map((work) => work.sourceId)).toEqual([
      "glass-ledger-zh",
      "ash-court-zh",
      "tide-alliance-zh",
    ]);
    expect(inspection.works.every((work) => work.validatedSpanCount > 0)).toBe(true);
    expect(inspection.validatedSpanCount).toBeGreaterThan(inspection.gold.semantic.mentions.length);
    for (const layer of BENCHMARK_SEMANTIC_LAYERS) {
      expect(inspection.annotatedLayerCounts[layer], layer).toBeGreaterThan(0);
    }
    expect(inspection.gold.semantic.executablePolicies.map((item) => item.kind).sort()).toEqual([
      "action-constraint",
      "norm-template",
      "process-template",
      "world-rule",
    ]);
    expect(inspection.gold.semantic.characterAssertions.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["goal", "appraisal", "development", "relationship", "obligation"]),
    );
  });

  it("fails closed when checked-in evidence bytes no longer match the manifest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-benchmark-corrupt-"));
    roots.push(root);
    await fs.cp(CORPUS, root, { recursive: true });
    await fs.appendFile(path.join(root, "glass-ledger.zh-CN.txt"), "tampered", "utf8");

    await expect(inspectBenchmarkCorpus(root)).rejects.toThrow("has 571 bytes, expected 563");
  });

  it("rejects gold selectors that split a multibyte source character", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-benchmark-span-"));
    roots.push(root);
    await fs.cp(CORPUS, root, { recursive: true });
    const goldPath = path.join(root, "gold.v2.json");
    const gold = JSON.parse(await fs.readFile(goldPath, "utf8")) as {
      semantic: { mentions: Array<{ span: { startByte: number } }> };
    };
    gold.semantic.mentions[0]!.span.startByte += 1;
    await fs.writeFile(goldPath, `${JSON.stringify(gold, null, 2)}\n`, "utf8");

    await expect(inspectBenchmarkCorpus(root)).rejects.toThrow("splits a UTF-8 code point");
  });
});

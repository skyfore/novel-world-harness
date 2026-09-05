import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  compilerSemanticGoldSchema,
  type CompilerSemanticGold,
  type SemanticLayerName,
} from "./compiler-eval.js";

export const BENCHMARK_SEMANTIC_LAYERS = [
  "mentions",
  "entityResolution",
  "eventResolution",
  "quotations",
  "eventParticipants",
  "eventRelations",
  "propositions",
  "knowledge",
  "stateEffects",
  "scenes",
  "actionSchemas",
  "executablePolicies",
  "characterAssertions",
] as const satisfies readonly SemanticLayerName[];

const semanticLayerNameSchema = z.enum(BENCHMARK_SEMANTIC_LAYERS);
const fixtureFileSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  "Benchmark files must be direct child filenames",
);

export const benchmarkCorpusWorkSchema = z.object({
  sourceId: z.string().min(1),
  file: fixtureFileSchema,
  title: z.string().min(1),
  language: z.string().min(1),
  genreTags: z.array(z.string().min(1)).min(1),
  scenarioTags: z.array(z.string().min(1)).min(1),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const benchmarkCorpusManifestSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  license: z.string().min(1),
  annotationPolicy: z.literal("selected-explicit-denominators"),
  goldFile: fixtureFileSchema,
  works: z.array(benchmarkCorpusWorkSchema).min(2),
  requiredSemanticLayers: z.array(semanticLayerNameSchema).min(1),
}).strict().superRefine((manifest, ctx) => {
  for (const [field, values] of [
    ["sourceId", manifest.works.map((work) => work.sourceId)],
    ["file", manifest.works.map((work) => work.file)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: "custom", path: ["works"], message: `Benchmark work ${field}s must be unique` });
    }
  }
  if (new Set(manifest.requiredSemanticLayers).size !== manifest.requiredSemanticLayers.length) {
    ctx.addIssue({ code: "custom", path: ["requiredSemanticLayers"], message: "Required semantic layers must be unique" });
  }
});

export type BenchmarkCorpusManifest = z.infer<typeof benchmarkCorpusManifestSchema>;
export type BenchmarkCorpusWork = z.infer<typeof benchmarkCorpusWorkSchema>;

export type BenchmarkCorpusInspection = {
  version: 1;
  directory: string;
  manifest: BenchmarkCorpusManifest;
  manifestHash: string;
  gold: CompilerSemanticGold;
  goldHash: string;
  works: Array<BenchmarkCorpusWork & { validatedSpanCount: number }>;
  annotatedLayerCounts: Record<SemanticLayerName, number>;
  validatedSpanCount: number;
};

type GoldByteSpan = { sourceId: string; startByte: number; endByte: number };

/**
 * Validate a checked-in benchmark as evidence, not as an accuracy claim.
 * Source hashes, UTF-8 byte boundaries, gold reference closure, denominators,
 * and source ownership are all checked before a suite can be evaluated.
 */
export async function inspectBenchmarkCorpus(directoryInput: string): Promise<BenchmarkCorpusInspection> {
  const directory = path.resolve(directoryInput);
  const manifestBytes = await fs.readFile(path.join(directory, "manifest.json"));
  const manifest = benchmarkCorpusManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  const goldBytes = await fs.readFile(path.join(directory, manifest.goldFile));
  const gold = compilerSemanticGoldSchema.parse(JSON.parse(goldBytes.toString("utf8")));
  const annotatedLayerCounts = semanticLayerCounts(gold);

  for (const layer of manifest.requiredSemanticLayers) {
    if (annotatedLayerCounts[layer] === 0) {
      throw new Error(`Benchmark requires semantic layer ${layer}, but its gold denominator is empty`);
    }
  }

  const spans = semanticGoldSpans(gold);
  const workBySource = new Map(manifest.works.map((work) => [work.sourceId, work]));
  const unknownSourceIds = [...new Set(spans.map((span) => span.sourceId))]
    .filter((sourceId) => !workBySource.has(sourceId));
  if (unknownSourceIds.length) {
    throw new Error(`Gold spans reference sources outside the benchmark manifest: ${unknownSourceIds.sort().join(", ")}`);
  }

  const works: BenchmarkCorpusInspection["works"] = [];
  for (const work of manifest.works) {
    const sourceBytes = await fs.readFile(path.join(directory, work.file));
    if (sourceBytes.byteLength !== work.bytes) {
      throw new Error(`Benchmark source ${work.sourceId} has ${sourceBytes.byteLength} bytes, expected ${work.bytes}`);
    }
    const actualHash = sha256(sourceBytes);
    if (actualHash !== work.sha256) {
      throw new Error(`Benchmark source ${work.sourceId} hash ${actualHash} does not match manifest ${work.sha256}`);
    }
    const decoded = sourceBytes.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(sourceBytes)) {
      throw new Error(`Benchmark source ${work.sourceId} is not valid canonical UTF-8`);
    }
    const sourceSpans = spans.filter((span) => span.sourceId === work.sourceId);
    if (!sourceSpans.length) throw new Error(`Benchmark source ${work.sourceId} has no gold evidence span`);
    for (const span of sourceSpans) validateSpan(sourceBytes, span);
    works.push({ ...work, validatedSpanCount: sourceSpans.length });
  }

  return {
    version: 1,
    directory,
    manifest,
    manifestHash: sha256(manifestBytes),
    gold,
    goldHash: sha256(goldBytes),
    works,
    annotatedLayerCounts,
    validatedSpanCount: spans.length,
  };
}

function semanticLayerCounts(gold: CompilerSemanticGold): Record<SemanticLayerName, number> {
  return {
    mentions: gold.semantic.mentions.length,
    entityResolution: gold.semantic.entityClusters.length,
    eventResolution: gold.semantic.eventClusters.length,
    quotations: gold.semantic.quotations.length,
    eventParticipants: gold.semantic.eventParticipants.length,
    eventRelations: gold.semantic.eventRelations.length,
    propositions: gold.semantic.propositions.length,
    knowledge: gold.semantic.knowledge.length,
    stateEffects: gold.semantic.stateEffects.length,
    scenes: gold.semantic.scenes.length,
    actionSchemas: gold.semantic.actionSchemas.length,
    executablePolicies: gold.semantic.executablePolicies.length,
    characterAssertions: gold.semantic.characterAssertions.length,
  };
}

function semanticGoldSpans(gold: CompilerSemanticGold): GoldByteSpan[] {
  return [
    ...gold.semantic.mentions.map((item) => item.span),
    ...gold.semantic.quotations.map((item) => item.span),
    ...gold.semantic.eventRelations.flatMap((item) => item.evidenceSpans),
    ...gold.semantic.propositions.flatMap((item) => item.evidenceSpans),
    ...gold.semantic.scenes.flatMap((item) => item.evidenceSpans),
    ...gold.semantic.actionSchemas.flatMap((item) => item.evidenceSpans),
    ...gold.semantic.executablePolicies.flatMap((item) => item.evidenceSpans),
    ...gold.semantic.characterAssertions.flatMap((item) => item.evidenceSpans),
  ];
}

function validateSpan(source: Buffer, span: GoldByteSpan): void {
  if (span.endByte > source.byteLength) {
    throw new Error(`Gold span ${span.sourceId}:${span.startByte}-${span.endByte} exceeds its source bytes`);
  }
  const selected = source.subarray(span.startByte, span.endByte);
  const text = selected.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(selected)) {
    throw new Error(`Gold span ${span.sourceId}:${span.startByte}-${span.endByte} splits a UTF-8 code point`);
  }
  if (!text.trim()) throw new Error(`Gold span ${span.sourceId}:${span.startByte}-${span.endByte} selects no semantic text`);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

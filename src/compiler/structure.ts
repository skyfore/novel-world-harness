import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { worldStorageRoot } from "../world/paths.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import type { SourceDocument } from "../storage/workspace-store.js";
import { canonicalJson } from "../world/canonical.js";
import { idSchema, textAnchorSchema } from "../world/model.js";
import { textAnchorForByteRange } from "./text-anchors.js";

export const STRUCTURE_VERSION = 1 as const;

export const structuralUnitKindSchema = z.enum([
  "work",
  "paratext",
  "volume",
  "part",
  "chapter",
  "scene",
  "beat",
  "paragraph",
  "sentence",
  "clause",
  "non-scene",
]);
export type StructuralUnitKind = z.infer<typeof structuralUnitKindSchema>;

export const structuralUnitSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  sourceId: idSchema,
  kind: structuralUnitKindSchema,
  parentId: idSchema.optional(),
  anchor: textAnchorSchema,
  ordinal: z.number().int().nonnegative(),
  proposedBy: z.enum(["deterministic", "model", "human"]),
  confidence: z.number().min(0).max(1),
  evidenceAssertionIds: z.array(idSchema),
}).strict();
export type StructuralUnit = z.infer<typeof structuralUnitSchema>;

export const discourseSegmentSchema = z.object({
  version: z.literal(1),
  id: idSchema,
  sourceId: idSchema,
  kind: z.enum([
    "scene",
    "summary",
    "flashback",
    "flashforward",
    "frame",
    "recollection",
    "hypothetical",
    "dream",
    "embedded-document",
    "narrator-commentary",
  ]),
  anchors: z.array(textAnchorSchema).min(1).max(32),
  viewpointActorId: idSchema.optional(),
  evidenceAssertionIds: z.array(idSchema),
  proposedBy: z.enum(["model", "human"]),
  confidence: z.number().min(0).max(1),
}).strict().superRefine((value, ctx) => {
  if (value.anchors.some((anchor) => anchor.sourceId !== value.sourceId)) {
    ctx.addIssue({ code: "custom", path: ["anchors"], message: "Discourse anchors must belong to the segment source" });
  }
});
export type DiscourseSegment = z.infer<typeof discourseSegmentSchema>;

export const sourceStructureManifestSchema = z.object({
  version: z.literal(1),
  structureVersion: z.literal(STRUCTURE_VERSION),
  sourceId: idSchema,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceBytes: z.number().int().positive(),
  units: z.array(structuralUnitSchema).min(2),
  baseUnitIds: z.array(idSchema).min(1),
  discourseSegments: z.array(discourseSegmentSchema),
  generatedAt: z.string().min(1),
}).strict();
export type SourceStructureManifest = z.infer<typeof sourceStructureManifestSchema>;

type ByteSpan = { startByte: number; endByte: number; blank: boolean };

/**
 * Deterministic source-observation structure. Sentence/non-scene leaves form
 * an exact byte partition; paragraphs/work are containment nodes only.
 */
export async function materializeSourceStructure(
  workspaceRoot: string,
  source: SourceDocument,
): Promise<SourceStructureManifest> {
  const bytes = await readSourceMaterial(workspaceRoot, source);
  const rootId = unitId(source.id, "work", 0, bytes.byteLength);
  const units: StructuralUnit[] = [{
    version: 1,
    id: rootId,
    sourceId: source.id,
    kind: "work",
    anchor: textAnchorForByteRange(source.id, bytes, 0, bytes.byteLength),
    ordinal: 0,
    proposedBy: "deterministic",
    confidence: 1,
    evidenceAssertionIds: [],
  }];
  const baseUnitIds: string[] = [];
  let ordinal = 1;
  for (const span of paragraphSpans(bytes)) {
    if (span.blank) {
      const id = unitId(source.id, "non-scene", span.startByte, span.endByte);
      units.push({
        version: 1,
        id,
        sourceId: source.id,
        kind: "non-scene",
        parentId: rootId,
        anchor: textAnchorForByteRange(source.id, bytes, span.startByte, span.endByte),
        ordinal: ordinal++,
        proposedBy: "deterministic",
        confidence: 1,
        evidenceAssertionIds: [],
      });
      baseUnitIds.push(id);
      continue;
    }
    const paragraphId = unitId(source.id, "paragraph", span.startByte, span.endByte);
    units.push({
      version: 1,
      id: paragraphId,
      sourceId: source.id,
      kind: "paragraph",
      parentId: rootId,
      anchor: textAnchorForByteRange(source.id, bytes, span.startByte, span.endByte),
      ordinal: ordinal++,
      proposedBy: "deterministic",
      confidence: 1,
      evidenceAssertionIds: [],
    });
    for (const sentence of sentenceSpans(bytes.subarray(span.startByte, span.endByte), span.startByte)) {
      const id = unitId(source.id, "sentence", sentence.startByte, sentence.endByte);
      units.push({
        version: 1,
        id,
        sourceId: source.id,
        kind: "sentence",
        parentId: paragraphId,
        anchor: textAnchorForByteRange(source.id, bytes, sentence.startByte, sentence.endByte),
        ordinal: ordinal++,
        proposedBy: "deterministic",
        confidence: 1,
        evidenceAssertionIds: [],
      });
      baseUnitIds.push(id);
    }
  }
  return validateSourceStructure({
    version: 1,
    structureVersion: STRUCTURE_VERSION,
    sourceId: source.id,
    sourceSha256: source.contentSha256,
    sourceBytes: bytes.byteLength,
    units,
    baseUnitIds,
    discourseSegments: [],
    generatedAt: new Date().toISOString(),
  });
}

export class SourceStructureStore {
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(worldStorageRoot(workspaceRoot), "compiler", "observations", "v1", "structure");
  }

  async read(sourceId: string): Promise<SourceStructureManifest | null> {
    idSchema.parse(sourceId);
    try {
      return validateSourceStructure(JSON.parse(await fs.readFile(this.filePath(sourceId), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(manifestInput: SourceStructureManifest): Promise<void> {
    const manifest = validateSourceStructure(manifestInput);
    await atomicJson(this.filePath(manifest.sourceId), manifest);
  }

  async remove(sourceId: string): Promise<void> {
    idSchema.parse(sourceId);
    await fs.rm(this.filePath(sourceId), { force: true });
  }

  private filePath(sourceId: string): string {
    return path.join(this.root, `${sourceId}.json`);
  }
}

export async function ensureSourceStructure(
  workspaceRoot: string,
  source: SourceDocument,
): Promise<SourceStructureManifest> {
  const store = new SourceStructureStore(workspaceRoot);
  const current = await store.read(source.id);
  if (current?.sourceSha256 === source.contentSha256 && current.sourceBytes === source.bytes) return current;
  const materialized = await materializeSourceStructure(workspaceRoot, source);
  await store.write(materialized);
  return materialized;
}

export function baseStructuralUnits(manifest: SourceStructureManifest): StructuralUnit[] {
  const byId = new Map(manifest.units.map((unit) => [unit.id, unit]));
  return manifest.baseUnitIds.map((id) => byId.get(id)!);
}

export function validateSourceStructure(value: unknown): SourceStructureManifest {
  const manifest = sourceStructureManifestSchema.parse(value);
  const byId = new Map<string, StructuralUnit>();
  const ordinals = new Set<number>();
  for (const unit of manifest.units) {
    if (byId.has(unit.id)) throw new Error(`Duplicate structural unit ${unit.id}.`);
    if (unit.sourceId !== manifest.sourceId || unit.anchor.sourceId !== manifest.sourceId) {
      throw new Error(`Structural unit ${unit.id} escapes source ${manifest.sourceId}.`);
    }
    if (ordinals.has(unit.ordinal)) throw new Error(`Duplicate structural ordinal ${unit.ordinal}.`);
    ordinals.add(unit.ordinal);
    byId.set(unit.id, unit);
  }
  for (const unit of manifest.units) {
    if (!unit.parentId) continue;
    const parent = byId.get(unit.parentId);
    if (!parent) throw new Error(`Structural unit ${unit.id} has unknown parent ${unit.parentId}.`);
    if (unit.anchor.startByte < parent.anchor.startByte || unit.anchor.endByte > parent.anchor.endByte) {
      throw new Error(`Structural unit ${unit.id} falls outside parent ${parent.id}.`);
    }
  }
  const baseIds = new Set<string>();
  const base = manifest.baseUnitIds.map((id) => {
    if (baseIds.has(id)) throw new Error(`Duplicate base structural unit ${id}.`);
    baseIds.add(id);
    const unit = byId.get(id);
    if (!unit) throw new Error(`Unknown base structural unit ${id}.`);
    if (unit.kind !== "sentence" && unit.kind !== "non-scene") {
      throw new Error(`Base structural unit ${id} has non-base kind ${unit.kind}.`);
    }
    return unit;
  }).sort((left, right) => left.anchor.startByte - right.anchor.startByte);
  for (const id of baseIds) {
    if (manifest.units.some((unit) => unit.parentId === id)) {
      throw new Error(`Base structural unit ${id} cannot have structural children.`);
    }
  }
  let cursor = 0;
  for (const unit of base) {
    if (unit.anchor.startByte !== cursor) {
      throw new Error(`Structural base partition has a gap or overlap at byte ${cursor} before ${unit.id}.`);
    }
    cursor = unit.anchor.endByte;
  }
  if (cursor !== manifest.sourceBytes) {
    throw new Error(`Structural base partition ends at byte ${cursor}, expected ${manifest.sourceBytes}.`);
  }
  const roots = manifest.units.filter((unit) => !unit.parentId);
  if (roots.length !== 1 || roots[0]?.kind !== "work"
    || roots[0].anchor.startByte !== 0 || roots[0].anchor.endByte !== manifest.sourceBytes) {
    throw new Error("Source structure must have one work root covering all source bytes.");
  }
  const rootId = roots[0].id;
  for (const unit of manifest.units) {
    const seen = new Set<string>();
    let current = unit;
    while (current.parentId) {
      if (seen.has(current.id)) throw new Error(`Structural parent cycle includes ${current.id}.`);
      seen.add(current.id);
      current = byId.get(current.parentId)!;
    }
    if (current.id !== rootId) throw new Error(`Structural unit ${unit.id} does not descend from work root ${rootId}.`);
  }
  const discourseIds = new Set<string>();
  for (const discourse of manifest.discourseSegments) {
    if (discourseIds.has(discourse.id)) throw new Error(`Duplicate discourse segment ${discourse.id}.`);
    discourseIds.add(discourse.id);
  }
  return manifest;
}

function paragraphSpans(bytes: Buffer): ByteSpan[] {
  const lines: ByteSpan[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index]!;
    if (byte !== 0x0a && byte !== 0x0d) continue;
    const end = byte === 0x0d && bytes[index + 1] === 0x0a ? index + 2 : index + 1;
    lines.push({ startByte: start, endByte: end, blank: isBlank(bytes.subarray(start, end)) });
    start = end;
    index = end - 1;
  }
  if (start < bytes.byteLength) {
    lines.push({ startByte: start, endByte: bytes.byteLength, blank: isBlank(bytes.subarray(start)) });
  }
  const spans: ByteSpan[] = [];
  for (const line of lines) {
    const prior = spans.at(-1);
    if (prior && prior.blank === line.blank) prior.endByte = line.endByte;
    else spans.push({ ...line });
  }
  return spans;
}

function sentenceSpans(paragraph: Buffer, globalStartByte: number): Array<{ startByte: number; endByte: number }> {
  const text = paragraph.toString("utf8");
  const spans: Array<{ startByte: number; endByte: number }> = [];
  const terminators = new Set([".", "?", "!", "。", "？", "！", "…"]);
  const closers = new Set(["\"", "'", "”", "’", "」", "』", "》", "】", "）", ")", "]"]);
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    const width = character.length;
    const decimalPoint = character === "." && /\d/.test(text[index - 1] ?? "") && /\d/.test(text[index + 1] ?? "");
    index += width;
    if (!terminators.has(character) || decimalPoint) continue;
    while (index < text.length) {
      const next = String.fromCodePoint(text.codePointAt(index)!);
      if (!terminators.has(next) && !closers.has(next)) break;
      index += next.length;
    }
    while (index < text.length) {
      const next = String.fromCodePoint(text.codePointAt(index)!);
      if (!/\s/u.test(next)) break;
      index += next.length;
    }
    spans.push(characterSpan(text, start, index, globalStartByte));
    start = index;
  }
  if (start < text.length) spans.push(characterSpan(text, start, text.length, globalStartByte));
  return spans;
}

function characterSpan(text: string, start: number, end: number, globalStartByte: number) {
  const localStart = Buffer.byteLength(text.slice(0, start), "utf8");
  const localEnd = localStart + Buffer.byteLength(text.slice(start, end), "utf8");
  return { startByte: globalStartByte + localStart, endByte: globalStartByte + localEnd };
}

function isBlank(bytes: Buffer): boolean {
  return bytes.toString("utf8").trim().length === 0;
}

function unitId(sourceId: string, kind: StructuralUnitKind, startByte: number, endByte: number): string {
  const suffix = crypto.createHash("sha256")
    .update(`${STRUCTURE_VERSION}\u0000${sourceId}\u0000${kind}\u0000${startByte}\u0000${endByte}`)
    .digest("hex")
    .slice(0, 24);
  return `unit-${kind}-${suffix}`;
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

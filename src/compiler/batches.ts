import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SegmentStore, readSegmentText, segmentSource, type SourceSegment } from "./segments.js";
import type { SourceDocument } from "../storage/workspace-store.js";

export type CompilerBatch = {
  id: string;
  sourceId: string;
  ordinal: number;
  segmentIds: string[];
  startLine: number;
  endLine: number;
  characters: number;
  prompt: string;
};

export type BatchProgress = {
  version: 1;
  sourceId: string;
  completedBatchIds: string[];
  updatedAt: string;
};

export type BatchRunner = (batch: CompilerBatch) => Promise<void>;

const MAX_BATCH_CHARS = 28_000;
const MAX_SEGMENTS_PER_BATCH = 6;

export class CompilerBatchStore {
  readonly root: string;
  constructor(workspaceRoot: string) {
    this.root = path.join(workspaceRoot, ".novel-harness", "world", "v1", "compiler", "batches");
  }

  async read(sourceId: string): Promise<BatchProgress> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath(sourceId), "utf8")) as BatchProgress;
      if (parsed.version !== 1 || parsed.sourceId !== sourceId || !Array.isArray(parsed.completedBatchIds)) {
        throw new Error(`Invalid compiler batch progress for ${sourceId}`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, sourceId, completedBatchIds: [], updatedAt: new Date(0).toISOString() };
      }
      throw error;
    }
  }

  async markComplete(sourceId: string, batchId: string): Promise<void> {
    const current = await this.read(sourceId);
    const completed = new Set(current.completedBatchIds);
    completed.add(batchId);
    await atomicJson(this.filePath(sourceId), {
      version: 1,
      sourceId,
      completedBatchIds: [...completed].sort(),
      updatedAt: new Date().toISOString(),
    } satisfies BatchProgress);
  }

  async reset(sourceId: string): Promise<void> {
    await fs.rm(this.filePath(sourceId), { force: true });
  }

  private filePath(sourceId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sourceId)) throw new Error(`Unsafe source id: ${sourceId}`);
    return path.join(this.root, `${sourceId}.json`);
  }
}

export async function prepareCompilerBatches(workspaceRoot: string, source: SourceDocument): Promise<CompilerBatch[]> {
  const segmentStore = new SegmentStore(workspaceRoot);
  let manifest = await segmentStore.readManifest(source.id);
  if (!manifest || manifest.sourceSha256 !== source.contentSha256) {
    manifest = await segmentSource(workspaceRoot, source);
    await segmentStore.write(manifest);
  }

  const groups: SourceSegment[][] = [];
  let current: SourceSegment[] = [];
  let chars = 0;
  for (const segment of manifest.segments) {
    const estimated = Math.max(segment.bytes, 1);
    if (current.length && (current.length >= MAX_SEGMENTS_PER_BATCH || chars + estimated > MAX_BATCH_CHARS)) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(segment);
    chars += estimated;
  }
  if (current.length) groups.push(current);

  const batches: CompilerBatch[] = [];
  for (let ordinal = 0; ordinal < groups.length; ordinal += 1) {
    const segments = groups[ordinal]!;
    const pieces: string[] = [];
    let characterCount = 0;
    for (const segment of segments) {
      const text = await readSegmentText(workspaceRoot, segment);
      characterCount += text.length;
      const evidence = {
        span: {
          sourceId: segment.sourceId,
          startByte: segment.startByte,
          endByte: segment.endByte,
          startLine: segment.startLine,
          endLine: segment.endLine,
          quoteHash: segment.textSha256,
        },
        strength: "explicit",
      };
      pieces.push(
        `### SEGMENT ${segment.id}\n` +
          `EvidenceRef to copy into evidence-backed proposals when the whole segment supports the artifact:\n` +
          `${JSON.stringify(evidence)}\n` +
          `Source path: ${segment.sourcePath}\n` +
          `Lines: ${segment.startLine}-${segment.endLine}\n\n` +
          `<source-segment id="${segment.id}">\n${text}\n</source-segment>`,
      );
    }
    const segmentIds = segments.map((segment) => segment.id);
    const id = `batch-${source.id}-${String(ordinal + 1).padStart(5, "0")}-${hash(segmentIds.join("\n")).slice(0, 12)}`;
    batches.push({
      id,
      sourceId: source.id,
      ordinal,
      segmentIds,
      startLine: Math.min(...segments.map((segment) => segment.startLine)),
      endLine: Math.max(...segments.map((segment) => segment.endLine)),
      characters: characterCount,
      prompt: buildBatchPrompt(source, id, pieces),
    });
  }
  return batches;
}

export async function runCompilerBatches(options: {
  workspaceRoot: string;
  source: SourceDocument;
  runner: BatchRunner;
  maxBatches?: number;
  resume?: boolean;
  onProgress?: (message: string) => void;
}): Promise<{ total: number; completed: number; skipped: number; remaining: number }> {
  const batches = await prepareCompilerBatches(options.workspaceRoot, options.source);
  const store = new CompilerBatchStore(options.workspaceRoot);
  if (options.resume === false) await store.reset(options.source.id);
  const progress = await store.read(options.source.id);
  const completedIds = new Set(progress.completedBatchIds);
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  if (!(maxBatches === Number.POSITIVE_INFINITY || (Number.isInteger(maxBatches) && maxBatches >= 0))) {
    throw new Error("maxBatches must be a non-negative integer");
  }

  let completed = 0;
  let skipped = 0;
  for (const batch of batches) {
    if (completedIds.has(batch.id)) {
      skipped += 1;
      continue;
    }
    if (completed >= maxBatches) break;
    options.onProgress?.(`compiler batch ${batch.ordinal + 1}/${batches.length}: ${batch.startLine}-${batch.endLine}`);
    await options.runner(batch);
    await store.markComplete(options.source.id, batch.id);
    completedIds.add(batch.id);
    completed += 1;
  }
  const remaining = batches.filter((batch) => !completedIds.has(batch.id)).length;
  return { total: batches.length, completed, skipped, remaining };
}

function buildBatchPrompt(source: SourceDocument, batchId: string, pieces: string[]): string {
  return `You are processing compiler batch ${batchId} for source ${source.sourcePath} (${source.id}).\n\n` +
    `Analyze only the supplied evidence slices. Produce small typed pending proposals with the available propose_* tools. ` +
    `Do not commit truth. Reuse stable entity IDs when the evidence clearly refers to the same identity. ` +
    `Every logical ID must use only ASCII letters, digits, dot, underscore, and hyphen, and must start with a letter or digit. ` +
    `Every canonical proposal must contain at least one EvidenceRef. Copy a supplied whole-segment EvidenceRef exactly, including its byte range, line range, and full quoteHash; never edit one range while retaining another range's hash. ` +
    `Prefer entity and claim proposals before events that reference them. Canonical events must describe observed transitions, not summaries. ` +
    `Character goals/models are policy inputs and must be evidence-backed. The initial-world proposal should only be made when this batch contains genuine opening-state evidence; put explicitly supported opening character knowledge in its optional knowledge delta so actor views begin with only what those characters know. ` +
    `State operations may use only these registered fields: character.alive, character.location, character.faction, character.title, character.inventory, artifact.owner, and faction.leader. ` +
    `Do not infer future runtime truth from later canon. If evidence is insufficient, make fewer proposals rather than inventing facts. ` +
    `After every proposal call has succeeded, call finish_compiler_batch exactly once with all successful proposal IDs. Use no-artifacts only when this slice supports no proposal. Without that explicit finish, the batch remains retryable.\n\n` +
    pieces.join("\n\n");
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

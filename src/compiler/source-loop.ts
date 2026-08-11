import fs from "node:fs/promises";
import path from "node:path";
import { CompilerBatchStore, prepareCompilerBatches, type CompilerBatch } from "./batches.js";
import type { SourceDocument } from "../storage/workspace-store.js";
import { WorkspaceStore } from "../storage/workspace-store.js";
import { LocalFileWorkspace } from "../workspace/local-files.js";

const AUTO_SOURCE_EXTENSIONS = new Set([".txt", ".text", ".novel", ".md", ".markdown"]);

export type SourceLoopTurn = {
  status: "ready";
  source: SourceDocument;
  batch: CompilerBatch;
  totalBatches: number;
  completedBatches: number;
  remainingAfterBatch: number;
  prompt: string;
};

export type SourceLoopComplete = {
  status: "complete";
  source: SourceDocument;
  totalBatches: number;
};

export type SourceLoopPreparation = SourceLoopTurn | SourceLoopComplete;

export function parseStandaloneSourcePath(input: string): string | undefined {
  let value = input.trim();
  if (!value || value.includes("\n")) return undefined;
  if (value.startsWith("@")) value = value.slice(1).trim();

  const quote = value[0];
  const quoted = (quote === "\"" || quote === "'") && value.at(-1) === quote;
  if (quoted) value = value.slice(1, -1);
  else if (/\s/u.test(value)) return undefined;

  return value.trim() || undefined;
}

export async function prepareSourceLoopFromInput(
  workspaceRoot: string,
  input: string,
): Promise<SourceLoopPreparation | null> {
  const candidate = parseStandaloneSourcePath(input);
  if (!candidate) return null;
  if (!AUTO_SOURCE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) return null;
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(workspaceRoot, candidate);

  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const workspace = await LocalFileWorkspace.create(workspaceRoot);
  await workspace.readFile({ path: absolute, startLine: 1, endLine: 1 });
  const store = await WorkspaceStore.create(workspaceRoot);
  const source = await store.registerSource(absolute);
  return prepareSourceLoopForSource(workspaceRoot, source);
}

export async function prepareNextSourceLoopTurn(
  workspaceRoot: string,
  sourceId?: string,
): Promise<SourceLoopPreparation | null> {
  const store = await WorkspaceStore.create(workspaceRoot);
  const source = sourceId
    ? await store.getSource(sourceId)
    : (await store.listSources()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  return source ? prepareSourceLoopForSource(workspaceRoot, source) : null;
}

export async function markSourceLoopBatchComplete(
  workspaceRoot: string,
  sourceId: string,
  batchId: string,
): Promise<void> {
  await new CompilerBatchStore(workspaceRoot).markComplete(sourceId, batchId);
}

async function prepareSourceLoopForSource(
  workspaceRoot: string,
  source: SourceDocument,
): Promise<SourceLoopPreparation> {
  const batches = await prepareCompilerBatches(workspaceRoot, source);
  const progress = await new CompilerBatchStore(workspaceRoot).read(source.id);
  const completed = new Set(progress.completedBatchIds);
  const batch = batches.find((candidate) => !completed.has(candidate.id));
  if (!batch) return { status: "complete", source, totalBatches: batches.length };

  const completedBatches = batches.filter((candidate) => completed.has(candidate.id)).length;
  return {
    status: "ready",
    source,
    batch,
    totalBatches: batches.length,
    completedBatches,
    remainingAfterBatch: Math.max(0, batches.length - completedBatches - 1),
    prompt: buildSourceLoopPrompt(source, batch, completedBatches, batches.length),
  };
}

function buildSourceLoopPrompt(
  source: SourceDocument,
  batch: CompilerBatch,
  completedBatches: number,
  totalBatches: number,
): string {
  return `The user supplied the novel source ${source.sourcePath}. NWH has registered it as ${source.id}, split it into evidence segments, and selected compiler batch ${completedBatches + 1}/${totalBatches}.

Execute the novel-world compiler loop now. Do not stop at identifying the book, explaining NWH, or suggesting commands. Treat the novel and its emerging world model as the primary subject. Repository source and documentation remain available as secondary context when the user explicitly asks about the harness or when compiler behavior genuinely requires inspection.

For this bounded batch, analyze the supplied evidence, use the typed propose_* tools to record small pending candidates, and finish with a concise progress report covering created proposals, unresolved identities or contradictions, and the next evidence frontier. Proposals are not committed world truth.

${batch.prompt}`;
}

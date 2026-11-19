import path from "node:path";
import { workspaceArchiveDir } from "../agent/runtime-paths.js";
import { PIPELINE_VERSION as COMPILER_PIPELINE_VERSION } from "../compiler/pipeline/compile.js";
import { COMPILER_PROMPT_VERSION } from "../compiler/prepared-cache.js";
import { summarizeCompileUsage } from "../compiler/compile-usage.js";
import { buildReferencePack, compareWithReference, loadReferencePack, verifyReferencePack, writeReferencePack } from "../compiler/reference-pack.js";
import { measureWorldCompleteness } from "../compiler/world-completeness.js";
import { readSourceMaterial } from "../storage/source-material-store.js";
import { loadNovelCutsBundle } from "./novel-cuts.js";
import { parseByteRange } from "./novel-completeness.js";

/** Default pack location: `$NWH_HOME/archives/<workspace>/legacy-reference/<source>-<YYYYMMDD>`. */
export function defaultReferencePackDir(root: string, sourceId: string, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10).replaceAll("-", "");
  return path.join(workspaceArchiveDir(root), "legacy-reference", `${sourceId}-${stamp}`);
}

/**
 * Export the current candidate as a read-only reference pack. Reads the
 * workspace and source; writes only the new archive directory.
 */
export async function novelReferenceExportCommand(options: { root: string; sourceId?: string; revision?: string; out?: string }): Promise<void> {
  const root = path.resolve(options.root);
  const loaded = await loadNovelCutsBundle({ root, ...(options.sourceId ? { sourceId: options.sourceId } : {}), ...(options.revision ? { revision: options.revision } : {}) });
  const source = await readSourceMaterial(root, loaded.source);
  const usage = await summarizeCompileUsage(root, loaded.source.id);
  const completeness = measureWorldCompleteness(loaded.bundle, source, { usage });
  const content = buildReferencePack(loaded.bundle, source, { completeness, usage });
  const directory = path.resolve(options.out ?? defaultReferencePackDir(root, loaded.source.id));
  const fingerprint = loaded.bundle.compilerFingerprint;
  const manifest = await writeReferencePack(directory, content, {
    source: { id: loaded.source.id, sha256: loaded.source.contentSha256, bytes: source.byteLength },
    compiler: {
      pipelineVersion: fingerprint?.pipelineVersion ?? COMPILER_PIPELINE_VERSION,
      promptVersion: fingerprint?.promptVersion ?? COMPILER_PROMPT_VERSION,
      engineVersion: fingerprint?.engineVersion ?? null,
      segmenterVersion: loaded.bundle.segmenterVersion,
    },
    bundle: { origin: loaded.origin, ...(loaded.bundleHash ? { bundleHash: loaded.bundleHash } : {}), baselineIssues: loaded.baselineIssues.length },
  });
  const verification = await verifyReferencePack(directory, manifest.counts);
  console.log(JSON.stringify({ directory, verified: verification.ok, issues: verification.issues, counts: manifest.counts,
    files: manifest.files.map((file) => ({ name: file.name, records: file.records, bytes: file.bytes })) }, null, 2));
  if (!verification.ok) process.exitCode = 1;
}

export async function novelReferenceVerifyCommand(options: { directory: string; expect?: string }): Promise<void> {
  const expected = options.expect ? Object.fromEntries(options.expect.split(",").map((pair) => {
    const [key, value] = pair.split("=");
    if (!key || value === undefined || !/^\d+$/u.test(value)) throw new Error(`Invalid --expect entry '${pair}': use key=count.`);
    return [key.trim(), Number(value)];
  })) : undefined;
  const verification = await verifyReferencePack(path.resolve(options.directory), expected);
  console.log(JSON.stringify({ directory: verification.directory, ok: verification.ok, issues: verification.issues, counts: verification.manifest?.counts ?? null }, null, 2));
  if (!verification.ok) process.exitCode = 1;
}

/** Review list: legacy artifacts in range that the current candidate does not reproduce. Read-only. */
export async function novelReferenceCompareCommand(options: { root: string; sourceId?: string; revision?: string; reference: string; range?: string }): Promise<void> {
  const root = path.resolve(options.root);
  const pack = await loadReferencePack(path.resolve(options.reference));
  const loaded = await loadNovelCutsBundle({ root, sourceId: options.sourceId ?? pack.manifest.source.id, ...(options.revision ? { revision: options.revision } : {}) });
  console.log(JSON.stringify(compareWithReference(loaded.bundle, pack, options.range ? parseByteRange(options.range) : undefined), null, 2));
}

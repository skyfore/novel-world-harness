import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import * as sourceCompiler from "../src/commands/compile-source.js";
import * as roleReview from "../src/workflow/role-review.js";
import { compileNovelCommand, inspectNovelCompilation } from "../src/commands/compile-novel.js";
import { newNovelCompilationRun, NovelCompilationRunStore } from "../src/workflow/novel-compilation.js";
import { CompilerBatchStore, prepareCompilerBatches } from "../src/compiler/batches.js";
import { PreparedNovelCache } from "../src/compiler/prepared-cache.js";
import { InitialWorldStore } from "../src/world/initial.js";
import { CanonicalModelStore } from "../src/world/canonical-model.js";
import { createEvidenceFixture } from "./helpers/evidence.js";
import { workspaceStateDir } from "../src/agent/runtime-paths.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-compile-novel-")); roots.push(root);
  return { root, ...(await createEvidenceFixture(root, "Hero waits in the hall.\n")) };
}

it("default invocation resumes rather than resetting completed batches", async () => {
  const { root, source } = await fixture();
  const batches = await prepareCompilerBatches(root, source), store = new CompilerBatchStore(root);
  await store.markComplete(source.id, batches[0]!.id);
  vi.spyOn(sourceCompiler, "compileSourceCommand").mockImplementation(async options => {
    expect(options.resume).toBe(true);
    expect(options.promptTransform).toBeUndefined();
    expect((await store.read(source.id)).completedBatchIds).toContain(batches[0]!.id);
    throw new Error("stop before any model call");
  });
  await expect(compileNovelCommand({ root, sourceId: source.id, onProgress() {} })).rejects.toThrow("stop before any model call");
  expect((await new NovelCompilationRunStore(root).read(source.id))?.mode).toBe("resume");
});

it("a repeated rebuild resumes the same generation and preserves newly completed checkpoints", async () => {
  const { root, source } = await fixture();
  const batches = await prepareCompilerBatches(root, source), store = new CompilerBatchStore(root);
  await store.replaceCompleted(source.id, batches.map(batch => batch.id));
  let firstRunId: string | undefined, call = 0;
  vi.spyOn(sourceCompiler, "compileSourceCommand").mockImplementation(async options => {
    const run = (await new NovelCompilationRunStore(root).read(source.id))!;
    expect(run.rebuildInitialized).toBe(true);
    expect(options.resume).toBe(true);
    if (call++ === 0) {
      firstRunId = run.id;
      expect((await store.read(source.id)).completedBatchIds).toEqual([]);
      await store.markComplete(source.id, batches[0]!.id);
    } else {
      expect(run.id).toBe(firstRunId);
      expect((await store.read(source.id)).completedBatchIds).toContain(batches[0]!.id);
    }
    throw new Error("intentional model interruption");
  });
  for (let index = 0; index < 2; index++) await expect(compileNovelCommand({ root, sourceId: source.id, rebuild: true, onProgress() {} })).rejects.toThrow("intentional model interruption");
  const run = (await new NovelCompilationRunStore(root).read(source.id))!;
  expect(run.history.filter(item => item.status === "blocked")).toHaveLength(2);
});

it("runs a requested role phase in isolation", async () => {
  const { root, source } = await fixture();
  const compile = vi.spyOn(sourceCompiler, "compileSourceCommand").mockRejectedValue(new Error("unexpected batch execution"));
  const review = vi.spyOn(roleReview, "reviewNovelRoles").mockResolvedValue(undefined);
  const result = await compileNovelCommand({ root, sourceId: source.id, phase: "roles", onProgress() {} });
  expect(review).toHaveBeenCalledOnce();
  expect(compile).not.toHaveBeenCalled();
  expect(result?.completed).toBe(false);
});

it("can fully rebuild an incomplete materialization while retaining its immutable artifact history", async () => {
  const { root, source, evidence } = await fixture();
  const canon = new CanonicalModelStore(root);
  await canon.putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: evidence("Hero") });
  await new InitialWorldStore(root).put({ version: 1, evidence: evidence("Hero waits in the hall."),
    delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] } });
  const initialHash = (await new InitialWorldStore(root).currentRevision())!.hash;
  const prior = await canon.currentRevision("entities", "hero");
  vi.spyOn(sourceCompiler, "compileSourceCommand").mockRejectedValue(new Error("stop new compilation"));
  await expect(compileNovelCommand({ root, sourceId: source.id, rebuild: true, onProgress() {} })).rejects.toThrow("stop new compilation");
  expect(await canon.currentRevision("entities", "hero")).toBeNull();
  expect(await canon.listRevisions("entities", "hero")).toContainEqual(prior);
  expect(await new InitialWorldStore(root).getRevision(initialHash)).toBeTruthy();
  expect((await new NovelCompilationRunStore(root).read(source.id))?.rebuildInitialized).toBe(true);
});

it("blocks a semantic subcommand until its observation prerequisites are checkpointed", async () => {
  const { root, source } = await fixture();
  const compiler = vi.spyOn(sourceCompiler, "compileSourceCommand");
  await expect(compileNovelCommand({ root, sourceId: source.id, phase: "batches", batchStage: "semantic", onProgress() {} })).rejects.toThrow("COMPILATION_STAGE_DEPENDENCIES");
  expect(compiler).not.toHaveBeenCalled();
});

it("does not treat all completed batch markers as verified finish receipts", async () => {
  const { root, source } = await fixture();
  const batches = await prepareCompilerBatches(root, source);
  await new CompilerBatchStore(root).replaceCompleted(source.id, batches.map(batch => batch.id));
  vi.spyOn(sourceCompiler, "compileSourceCommand").mockResolvedValue(undefined);
  await expect(compileNovelCommand({ root, sourceId: source.id, onProgress() {} })).rejects.toThrow("COMPILER_FINISH_UNVERIFIED");
  const run = (await new NovelCompilationRunStore(root).read(source.id))!;
  expect(run.completed).toBe(false);
  expect(run.history.map(receipt => receipt.phase)).not.toContain("activate");
});

it("recognizes its own interrupted activation after the working candidate ref changes, but rejects foreign publication", async () => {
  const { root, source } = await fixture();
  const store = new NovelCompilationRunStore(root), run = newNovelCompilationRun(source, true);
  run.rebuildInitialized = true;
  run.activeAtStart = null;
  run.bundleHash = "a".repeat(64);
  await store.write(run);
  const lookup = vi.spyOn(PreparedNovelCache.prototype, "lookup").mockResolvedValue({ status: "already-cached", contentMd5: source.contentMd5, bundleHash: run.bundleHash });
  await compileNovelCommand({ root, sourceId: source.id, phase: "source", onProgress() {} });
  const resumed = (await store.read(source.id))!;
  expect(resumed.activatedBundleHash).toBe(run.bundleHash);
  resumed.bundleHash = "b".repeat(64); // Subsequent archive has a different uncertified bundle hash.
  await store.write(resumed);
  await expect(compileNovelCommand({ root, sourceId: source.id, phase: "source", onProgress() {} })).resolves.toBeTruthy();
  lookup.mockResolvedValue({ status: "already-cached", contentMd5: source.contentMd5, bundleHash: "c".repeat(64) });
  await expect(compileNovelCommand({ root, sourceId: source.id, phase: "source", onProgress() {} })).rejects.toThrow("NOVEL_REBUILD_ACTIVE_CHANGED");
});

it("certification of an uncertified archive fails without activation", async () => {
  const { root, source, evidence } = await fixture();
  const batches = await prepareCompilerBatches(root, source);
  await new CompilerBatchStore(root).replaceCompleted(source.id, batches.map(batch => batch.id));
  await new CanonicalModelStore(root).putEntity({ id: "hero", kind: "character", canonicalName: "Hero", aliases: [], evidence: evidence("Hero waits in the hall.") });
  await new InitialWorldStore(root).put({ version: 1, delta: { version: 1, operations: [{ op: "set", entityId: "hero", field: "character.alive", value: true }] }, evidence: evidence("Hero waits in the hall.") });
  const cache = new PreparedNovelCache(root);
  const archived = await compileNovelCommand({ root, sourceId: source.id, phase: "archive", onProgress() {} });
  expect(archived?.bundleHash).toBeTruthy();
  await expect(cache.certifyCandidate(source)).rejects.toThrow();
  await expect(compileNovelCommand({ root, sourceId: source.id, phase: "activate", onProgress() {} })).rejects.toThrow();
  expect(await cache.loadActive(source)).toBeNull();
});

it("status is read-only even in a workspace without an initialized state directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-read-only-status-")); roots.push(root);
  const status = await inspectNovelCompilation(root);
  expect(status.sources).toEqual([]);
  await expect(fs.stat(workspaceStateDir(root))).rejects.toMatchObject({ code: "ENOENT" });
});

it("exposes full-run options and individual stage subcommands in the CLI", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-cli-help-")); roots.push(root);
  const output = await fs.open(path.join(root, "help.txt"), "w+");
  // Commander exits synchronously for --help; a regular file preserves its output even when a pipe has not flushed.
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "compile-novel", "--help"], { cwd: process.cwd(), stdio: ["ignore", output.fd, output.fd] });
    expect(child.status).toBe(0);
  } finally { await output.close(); }
  const stdout = await fs.readFile(path.join(root, "help.txt"), "utf8");
  expect(stdout).toContain("--rebuild");
  expect(stdout).toContain("resume by default");
  for (const stage of ["source", "batches", "observation", "semantic", "executable", "boundary", "roles", "repair", "evaluation-plan", "evaluate", "certify", "activate", "branch", "status"]) expect(stdout).toContain(stage);
});

it.each(["global", "group", "stage"])("honors a %s --root when dispatching the read-only status subcommand", async placement => {
  const { root, source } = await fixture();
  const args = placement === "global" ? ["--root", root, "compile-novel", "status"]
    : placement === "group" ? ["compile-novel", "--root", root, "status"] : ["compile-novel", "status", "--root", root];
  const file = path.join(root, "cli-status.json"), output = await fs.open(file, "w");
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: process.cwd(), stdio: ["ignore", output.fd, output.fd] });
    expect(child.status).toBe(0);
  } finally { await output.close(); }
  const status = JSON.parse(await fs.readFile(file, "utf8"));
  expect(status.workspace).toBe(root);
  expect(status.sources.map((item: { sourceId: string }) => item.sourceId)).toContain(source.id);
  expect(await new NovelCompilationRunStore(root).read(source.id)).toBeNull();
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NOVEL_COMPILATION_PHASES, newNovelCompilationRun, NovelCompilationRunStore, runNovelCompilation } from "../src/workflow/novel-compilation.js";
import { contentHash } from "../src/world/canonical.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const source = { id: "fixture", contentSha256: contentHash("immutable novel") };

it("runs certification and activation before declaring full completion, and revalidates phases on resume", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nwh-lifecycle-")); roots.push(root);
  const store = new NovelCompilationRunStore(root), run = newNovelCompilationRun(source);
  const stages: string[] = [];
  await runNovelCompilation({ run, save: run => store.write(run), execute: async phase => { stages.push(phase); } });
  expect(stages).toEqual(NOVEL_COMPILATION_PHASES);
  expect((await store.read(source.id))?.completed).toBe(true);
  const saved = (await store.read(source.id))!;
  const execute = vi.fn(async () => {});
  await runNovelCompilation({ run: saved, save: run => store.write(run), execute });
  expect(execute.mock.calls).toHaveLength(NOVEL_COMPILATION_PHASES.length);
  expect(saved.id).toBe(run.id);
});

it.each(["repair", "evaluation-plan", "evaluate", "certify"] as const)("retains the exact failure and stops before publication at %s", async failing => {
  const run = newNovelCompilationRun(source), stages: string[] = [], snapshots: unknown[] = [];
  await expect(runNovelCompilation({ run, save: async value => { snapshots.push(structuredClone(value)); },
    execute: async phase => { stages.push(phase); if (phase === failing) throw new Error("Original host-review stop: requirement q-17"); },
  })).rejects.toThrow(`NOVEL_COMPILATION_BLOCKED [${failing}]`);
  expect(stages).not.toContain("activate");
  expect(run.completed).toBe(false);
  expect(run.history.at(-1)).toMatchObject({ phase: failing, status: "blocked", error: "Original host-review stop: requirement q-17" });
  expect(snapshots.length).toBeGreaterThan(0);
});

it("a single requested phase does not run other phases or claim whole-book completion", async () => {
  const run = newNovelCompilationRun(source), execute = vi.fn(async () => {});
  await runNovelCompilation({ run, phase: "roles", save: async () => {}, execute });
  expect(execute.mock.calls.map(call => call[0])).toEqual(["roles"]);
  expect(run.completed).toBe(false);
});

it("an interruption retains the running stage and never advances to certification", async () => {
  const run = newNovelCompilationRun(source), controller = new AbortController(), stages: string[] = [];
  await expect(runNovelCompilation({ run, signal: controller.signal, save: async () => {}, execute: async phase => {
    stages.push(phase);
    if (phase === "batches") controller.abort(new Error("user interrupted"));
  } })).rejects.toThrow("user interrupted");
  expect(stages).toEqual(["source", "recover", "batches"]);
  expect(run.history.at(-1)?.status).toBe("blocked");
});
